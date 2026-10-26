import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createKnowledgeServer } from '../../server/index.mjs';

test('explorer actions persist empty folders and atomically rename folders and files without changing content or rights', async t => {
  // Every account, document, upload and request uses this disposable database.
  const dataDir = await mkdtemp(path.join(tmpdir(), 'zhiyu-explorer-directories-'));
  let server, base;
  async function start() {
    ({ server } = await createKnowledgeServer({ dataDir }));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
  }
  await start();
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  });
  function actor() {
    let cookie = '';
    return async (route, method = 'GET', body, headers = {}) => {
      const response = await fetch(`${base}${route}`, {
        method, headers: { Origin: base, ...(cookie ? { Cookie: cookie } : {}),
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
      return { status: response.status, headers: response.headers, cookie,
        body: [204, 304].includes(response.status) ? null : await response.json() };
    };
  }
  const alice = actor(), bob = actor(), admin = actor(), anonymous = actor();
  const password = 'Isolated-explorer-tests-2026!';
  const aliceAccount = await alice('/api/auth/register', 'POST', { name: 'Directory Alice', email: 'directory-alice@isolated.test', password });
  const bobAccount = await bob('/api/auth/register', 'POST', { name: 'Directory Bob', email: 'directory-bob@isolated.test', password });
  assert.equal(aliceAccount.status, 201);
  assert.equal(bobAccount.status, 201);
  const setup = JSON.parse(await readFile(path.join(dataDir, 'admin-setup.json'), 'utf8'));
  assert.equal((await admin('/api/auth/activate-admin', 'POST', { token: setup.token, password })).status, 200);
  const createFolder = (parent, name, client = alice) => client('/api/folders', 'POST', { parent, name });
  const renameFolder = (source, name, client = alice) => client('/api/folders', 'PATCH', { path: source, name });
  const createNote = async (id, notePath, client = alice, values = {}) => {
    const created = await client('/api/notes', 'POST', { note: { id, title: id, path: notePath,
      category: notePath.includes('/') ? notePath.split('/')[0] : '未分类', content: `# Unchanged heading\n\nFixture ${id}.`, ...values } });
    assert.equal(created.status, 201);
    return created.body.note;
  };
  const index = async () => (await alice('/api/notes/index')).body;
  const getNote = async id => (await alice(`/api/notes/${id}`)).body.note;
  function stored() {
    const db = new DatabaseSync(path.join(dataDir, 'knowledge.sqlite'), { readOnly: true });
    try {
      return {
        notes: db.prepare('SELECT * FROM notes ORDER BY id').all(),
        folders: db.prepare('SELECT * FROM folders ORDER BY path').all(),
        references: db.prepare('SELECT * FROM note_assets ORDER BY note_id,asset_id').all(),
        assets: db.prepare('SELECT * FROM assets ORDER BY id').all(),
      };
    } finally { db.close(); }
  }

  await t.test('empty folders survive a restart and participate in private conditional index caching', async () => {
    assert.equal((await anonymous('/api/folders', 'POST', { parent: '', name: 'Forbidden' })).status, 401);
    const before = await alice('/api/notes/index');
    assert.deepEqual(before.body.folders, []);
    const created = await createFolder('', 'Café');
    assert.equal(created.status, 201);
    assert.deepEqual(created.body.folder, { path: 'Café', ownerId: aliceAccount.body.user.id });
    assert.equal((await createFolder('Café', 'Empty')).status, 201);
    const after = await alice('/api/notes/index', 'GET', undefined, { 'If-None-Match': before.headers.get('etag') });
    assert.equal(after.status, 200);
    assert.notEqual(after.headers.get('etag'), before.headers.get('etag'));
    assert.match(after.headers.get('cache-control'), /private/);
    assert.equal((await alice('/api/notes/index', 'GET', undefined, { 'If-None-Match': after.headers.get('etag') })).status, 304);
    await new Promise(resolve => server.close(resolve));
    await start();
    assert.deepEqual((await index()).folders, after.body.folders);
    assert.equal((await alice('/api/session')).body.user.id, aliceAccount.body.user.id);
    assert.equal((await renameFolder('Café/Empty', 'Denied', bob)).status, 403);
    assert.equal((await renameFolder('Café/Empty', 'Administrator renamed', admin)).status, 200);
  });

  await t.test('invalid names, traversal, Unicode/case collisions and file-folder collisions never create partial entries', async () => {
    const before = stored();
    for (const name of ['', ' ', '.', '..', '../escape', 'a/b', 'a\\b', 'line\nbreak', 'invisible\u200b', 'bad:name', 'ending.', 'x'.repeat(256)]) {
      assert.equal((await createFolder('', name)).status, 400, `reject invalid name ${JSON.stringify(name)}`);
    }
    for (const parent of ['../escape', 'Café/../escape', '/Café', 'Café/', 'Café\\Empty']) {
      assert.equal((await createFolder(parent, 'New')).status, 400);
    }
    assert.equal((await createFolder('Missing', 'New')).status, 404);
    assert.equal((await createFolder('', 'CAFE\u0301')).status, 409);
    assert.deepEqual(stored(), before);
    const canonicalParent = await createFolder('CAFE\u0301', 'Canonical parent');
    assert.equal(canonicalParent.status, 201);
    assert.equal(canonicalParent.body.folder.path, 'Café/Canonical parent');
    assert.equal((await createFolder('', 'reserved.md')).status, 201);
    assert.equal((await alice('/api/notes', 'POST', { note: { id: 'folder-file-collision', title: 'reserved', content: '', path: 'RESERVED.md' } })).status, 409);
    await createNote('implicit-folder-note', 'Derived/Sub/item.md');
    assert.equal((await createFolder('', 'derived')).status, 409);
    assert.equal((await createFolder('Derived', 'SUB')).status, 409);
    assert.equal((await createFolder('Derived/Sub', 'ITEM.MD')).status, 409);
    const movable = await createNote('namespace-movable', 'Other/source.md');
    assert.equal((await alice(`/api/notes/${movable.id}`, 'PATCH', { note: { path: 'reserved.md' }, revision: movable.revision })).status, 409);
    assert.equal((await alice(`/api/notes/${movable.id}/rename`, 'PATCH', { name: '../escape', revision: movable.revision })).status, 400);
    assert.equal((await alice('/api/notes', 'POST', { note: { id: 'file-as-parent', title: 'bad child', content: '', path: 'Derived/Sub/item.md/child.md' } })).status, 409);
    assert.deepEqual(await getNote(movable.id), movable);
  });

  let renameFixture;
  const picture = '<svg xmlns="http://www.w3.org/2000/svg"><text>directory fixture</text></svg>';
  await t.test('file rename changes its label and filename, preserving exact Markdown, assets, identity and collaboration permissions', async () => {
    const uploaded = await fetch(`${base}/api/assets/directory-picture`, { method: 'POST', headers: {
      Cookie: aliceAccount.cookie, 'Content-Type': 'image/svg+xml', 'X-Asset-Path': encodeURIComponent('附件/示例.svg'),
    }, body: picture });
    assert.equal(uploaded.status, 201);
    const content = '# Body heading must remain exact\r\n\r\n[Canonical link](#note/implicit-folder-note)\n\n![Picture](asset:directory-picture)\n[[Other document]]\n';
    renameFixture = await createNote('file-rename-fixture', 'FileRename/Old filename.markdown', alice, {
      title: 'A title different from the filename', content, tags: ['preserved'], attachments: { '附件/示例.svg': 'asset:directory-picture' },
    });
    const incoming = await createNote('file-rename-incoming', 'Incoming/link.md', bob, { content: '[Keep this stable](#note/file-rename-fixture)' });
    const route = `/api/notes/${renameFixture.id}/rename`;
    assert.equal((await bob(route, 'PATCH', { name: 'Forbidden', revision: renameFixture.revision })).status, 403);
    assert.equal((await admin(route, 'PATCH', { name: 'Forbidden', revision: renameFixture.revision })).status, 403);
    const beforeStorage = stored();
    const renamed = await alice(route, 'PATCH', { name: ' New filename.markdown ', revision: renameFixture.revision });
    assert.equal(renamed.status, 200);
    const original = renameFixture;
    renameFixture = renamed.body.note;
    assert.equal(renameFixture.title, 'New filename');
    assert.equal(renameFixture.path, 'FileRename/New filename.md');
    assert.equal(renameFixture.revision, original.revision + 1);
    assert.notEqual(renameFixture.updatedAt, original.updatedAt);
    for (const field of ['id', 'content', 'category', 'tags', 'attachments', 'attachmentSizes', 'ownerId', 'ownerEmail', 'author', 'avatar', 'collaborative', 'color']) {
      assert.deepEqual(renameFixture[field], original[field], `rename preserves ${field}`);
    }
    assert.deepEqual(stored().references, beforeStorage.references);
    assert.deepEqual(stored().assets, beforeStorage.assets);
    assert.equal((await getNote(incoming.id)).content, incoming.content);
    const asset = await fetch(`${base}/api/assets/directory-picture`);
    assert.equal(asset.status, 200);
    assert.equal(await asset.text(), picture);
    assert.equal((await alice(route, 'PATCH', { name: 'Stale name', revision: original.revision })).status, 409);
    assert.equal((await alice(route, 'PATCH', { name: 'New filename.md', revision: renameFixture.revision })).body.note.revision, renameFixture.revision);
    await createNote('rename-unicode-neighbor', 'FileRename/Café.md', bob);
    assert.equal((await alice(route, 'PATCH', { name: 'CAFE\u0301.md', revision: renameFixture.revision })).status, 409);
    const shared = (await admin(`/api/notes/${renameFixture.id}/sharing`, 'PATCH', { collaborative: true })).body.note;
    const collaborativeRename = await bob(route, 'PATCH', { name: 'Collaborative name', revision: shared.revision });
    assert.equal(collaborativeRename.status, 200);
    renameFixture = collaborativeRename.body.note;
    assert.equal(renameFixture.ownerId, original.ownerId);
    assert.equal(renameFixture.content, content);
    assert.equal(renameFixture.collaborative, true);
    assert.equal((await bob(`/api/notes/${renameFixture.id}`, 'DELETE')).status, 403);
    const revoked = (await admin(`/api/notes/${renameFixture.id}/sharing`, 'PATCH', { collaborative: false })).body.note;
    assert.equal((await bob(route, 'PATCH', { name: 'After revocation', revision: revoked.revision })).status, 403);
    renameFixture = revoked;
  });

  let treeNotes, outside;
  await t.test('folder rename moves all descendants once, keeps sibling prefixes and commits one lightweight refreshed index', async () => {
    assert.equal((await createFolder('', 'MoveTree')).status, 201);
    assert.equal((await createFolder('MoveTree', 'Empty child')).status, 201);
    assert.equal((await createFolder('MoveTree', 'Nested')).status, 201);
    treeNotes = [await createNote('tree-first', 'MoveTree/first.md', alice, {
      title: 'Distinct first title', content: renameFixture.content, attachments: renameFixture.attachments,
    }), await createNote('tree-deep', 'MoveTree/Nested/Deeper/deep.markdown')];
    outside = await createNote('tree-prefix-neighbor', 'MoveTreeExtra/untouched.md');
    assert.equal((await createFolder('MoveTreeExtra', 'Untouched empty')).status, 201);
    assert.equal((await createFolder('', 'Occupied')).status, 201);
    const beforeCollision = stored();
    assert.equal((await renameFolder('MoveTree', 'OCCUPIED')).status, 409);
    assert.deepEqual(stored(), beforeCollision);
    const renamed = await renameFolder('MoveTree', 'MovedTree');
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.notes.length, (await index()).notes.length);
    assert.equal(renamed.body.notes.some(note => Object.hasOwn(note, 'content') || Object.hasOwn(note, 'attachments')), false);
    assert.equal(renamed.body.folders.some(folder => folder.path === 'MovedTree/Empty child'), true);
    assert.equal(renamed.body.folders.some(folder => folder.path.startsWith('MoveTree/')), false);
    for (const original of treeNotes) {
      const changed = await getNote(original.id);
      assert.equal(changed.path, original.path.replace(/^MoveTree\//, 'MovedTree/'));
      assert.equal(changed.category, 'MovedTree');
      assert.equal(changed.revision, original.revision + 1);
      for (const field of ['id', 'title', 'content', 'tags', 'attachments', 'attachmentSizes', 'ownerId', 'ownerEmail', 'author', 'collaborative']) {
        assert.deepEqual(changed[field], original[field], `folder rename preserves ${field}`);
      }
      assert.equal((await alice(`/api/notes/${original.id}`, 'PATCH', { note: { content: 'Stale draft' }, revision: original.revision })).status, 409);
    }
    assert.deepEqual(await getNote(outside.id), outside);
    assert.deepEqual(stored().references, beforeCollision.references);
    assert.deepEqual(stored().assets, beforeCollision.assets);
    assert.equal((await renameFolder('MovedTree', 'MOVEDTREE')).status, 200);
    treeNotes = await Promise.all(treeNotes.map(note => getNote(note.id)));
    assert.equal((await renameFolder('MoveTree', 'Stale source')).status, 404);
  });

  await t.test('mixed ownership and nested explicit folders enforce author control with all-or-nothing changes', async () => {
    const foreign = await createNote('tree-foreign-private', 'MOVEDTREE/Nested/foreign.md', bob);
    const privateSnapshot = stored();
    assert.equal((await renameFolder('MOVEDTREE', 'Must not move')).status, 403);
    assert.equal((await renameFolder('MOVEDTREE', 'Admin must not move', admin)).status, 403);
    assert.deepEqual(stored(), privateSnapshot);
    assert.equal((await admin(`/api/notes/${foreign.id}/sharing`, 'PATCH', { collaborative: true })).status, 200);
    assert.equal((await createFolder('MOVEDTREE/Nested', 'Bob empty', bob)).status, 201);
    const protectedSnapshot = stored();
    const protectedRename = await renameFolder('MOVEDTREE', 'Still forbidden');
    assert.equal(protectedRename.status, 403);
    assert.equal(protectedRename.body.code, 'FOLDER_OWNER_REQUIRED');
    assert.deepEqual(stored(), protectedSnapshot);
    const accepted = await renameFolder('MOVEDTREE', 'SharedTree', admin);
    // Alice's ordinary notes still need her edit permission, even for an admin.
    assert.equal(accepted.status, 403);
    for (const note of treeNotes) assert.equal((await admin(`/api/notes/${note.id}/sharing`, 'PATCH', { collaborative: true })).status, 200);
    const before = stored();
    assert.equal((await renameFolder('MOVEDTREE', 'SharedTree', admin)).status, 200);
    const foreignAfter = await getNote(foreign.id);
    assert.equal(foreignAfter.path, 'SharedTree/Nested/foreign.md');
    assert.equal(foreignAfter.ownerId, bobAccount.body.user.id);
    assert.equal(foreignAfter.collaborative, true);
    assert.equal(foreignAfter.content, foreign.content);
    assert.equal((await index()).folders.find(folder => folder.path === 'SharedTree/Nested/Bob empty').ownerId, bobAccount.body.user.id);
    assert.deepEqual(stored().references, before.references);
    assert.deepEqual(stored().assets, before.assets);
    assert.deepEqual(await getNote(outside.id), outside);
  });

  await t.test('case-equivalent folder branches share permission checks and move together without touching sibling prefixes', async () => {
    assert.equal((await createFolder('', 'CaseTree')).status, 201);
    const upper = await createNote('case-tree-upper', 'CaseTree/Upper/first.md');
    const lower = await createNote('case-tree-lower', 'casetree/Lower/second.md');
    const foreign = await createNote('case-tree-foreign', 'CASETREE/Foreign/third.md', bob);
    const sibling = await createNote('case-tree-sibling', 'CaseTreeExtra/sibling.md');
    const before = stored();
    const denied = await renameFolder('cAsEtReE', 'CaseMoved');
    assert.equal(denied.status, 403);
    assert.equal(denied.body.code, 'NOTE_READ_ONLY');
    assert.deepEqual(stored(), before);
    assert.equal((await admin(`/api/notes/${foreign.id}/sharing`, 'PATCH', { collaborative: true })).status, 200);
    const renamed = await renameFolder('cAsEtReE', 'CaseMoved');
    assert.equal(renamed.status, 200);
    for (const original of [upper, lower, foreign]) {
      const changed = await getNote(original.id);
      assert.equal(changed.path, ['CaseMoved', ...original.path.split('/').slice(1)].join('/'));
      assert.equal(changed.content, original.content);
      assert.equal(changed.ownerId, original.ownerId);
    }
    assert.deepEqual(await getNote(sibling.id), sibling);
    assert.equal(renamed.body.folders.some(folder => folder.path === 'CaseMoved'), true);
  });
});
