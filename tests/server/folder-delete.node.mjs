import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createKnowledgeServer } from '../../server/index.mjs';

test('folder deletion removes one complete subtree atomically and preserves document ownership and shared assets', async t => {
  // All data and accounts belong to this temporary server, never the live library.
  const dataDir = await mkdtemp(path.join(tmpdir(), 'zhiyu-folder-deletion-'));
  const { server } = await createKnowledgeServer({ dataDir });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  });
  function actor() {
    let cookie = '';
    return async (route, method = 'GET', body, headers = {}) => {
      const response = await fetch(`${base}${route}`, { method,
        headers: { Origin: base, ...(cookie ? { Cookie: cookie } : {}),
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
      const text = await response.text();
      return { status: response.status, headers: response.headers, cookie, body: text ? JSON.parse(text) : null };
    };
  }
  const alice = actor(), bob = actor(), admin = actor(), guest = actor();
  const password = 'Isolated-folder-deletion-2026!';
  const aliceAccount = await alice('/api/auth/register', 'POST', { name: 'Folder Alice', email: 'folder-alice@isolated.test', password });
  const bobAccount = await bob('/api/auth/register', 'POST', { name: 'Folder Bob', email: 'folder-bob@isolated.test', password });
  assert.equal(aliceAccount.status, 201);
  assert.equal(bobAccount.status, 201);
  const setup = JSON.parse(await readFile(path.join(dataDir, 'admin-setup.json'), 'utf8'));
  assert.equal((await admin('/api/auth/activate-admin', 'POST', { token: setup.token, password })).status, 200);
  const folder = async (parent, name, client = alice) => {
    const created = await client('/api/folders', 'POST', { parent, name });
    assert.equal(created.status, 201);
    return created.body.folder;
  };
  const note = async (id, notePath, client = alice, fields = {}) => {
    const created = await client('/api/notes', 'POST', { note: { id, title: id, path: notePath, content: `# ${id}`, ...fields } });
    assert.equal(created.status, 201);
    return created.body.note;
  };
  const remove = (source, client = alice) => client('/api/folders', 'DELETE', { path: source });
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
        users: db.prepare('SELECT id,name,email,role FROM users ORDER BY id').all(),
      };
    } finally { db.close(); }
  }
  async function upload(id) {
    const response = await fetch(`${base}/api/assets/${id}`, { method: 'POST', headers: {
      Cookie: aliceAccount.cookie, Origin: base, 'Content-Type': 'text/plain', 'X-Asset-Path': encodeURIComponent(`${id}.txt`),
    }, body: `isolated attachment ${id}` });
    assert.equal(response.status, 201);
  }

  await t.test('deletes empty descendants and returns a revalidated lightweight index without touching siblings', async () => {
    await folder('', 'Empty');
    await folder('Empty', 'Nested');
    await folder('Empty/Nested', 'Leaf');
    const sibling = await folder('', 'EmptyExtra');
    assert.equal((await guest('/api/folders', 'DELETE', { path: 'Empty' })).status, 401);
    const before = await alice('/api/notes/index');
    const users = stored().users;
    const deleted = await remove('Empty');
    assert.equal(deleted.status, 200);
    assert.deepEqual(deleted.body.notes, []);
    assert.deepEqual(deleted.body.folders, [sibling]);
    assert.deepEqual(deleted.body, await index());
    assert.deepEqual(stored().users, users);
    const refreshed = await alice('/api/notes/index', 'GET', undefined, { 'If-None-Match': before.headers.get('etag') });
    assert.equal(refreshed.status, 200);
    assert.notEqual(refreshed.headers.get('etag'), before.headers.get('etag'));
    assert.equal((await remove('Empty')).status, 404);
  });

  await t.test('invalid paths, root deletion, missing folders and incorrect HTTP methods never change data', async () => {
    await folder('', 'Validation');
    const document = await note('validation-document', 'Validation/one.md');
    const before = stored();
    for (const value of ['', '/', '.', '..', '/Validation', 'Validation/', 'Validation//Child', 'Validation/../Escape', 'Validation\\Child', 'Validation\nChild', null, 3, {}, 'x'.repeat(3001)]) {
      assert.equal((await remove(value)).status, 400, `invalid folder path ${JSON.stringify(value)}`);
    }
    assert.equal((await alice('/api/folders', 'DELETE', {})).status, 400);
    assert.equal((await alice('/api/folders?path=Validation', 'DELETE')).status, 415);
    assert.equal((await alice('/api/folders?path=Validation', 'DELETE', undefined, { 'Content-Type': 'application/json' })).status, 400);
    assert.equal((await remove('Missing')).status, 404);
    assert.equal((await remove(document.path)).status, 404);
    assert.equal((await alice('/api/folders')).status, 404);
    assert.equal((await alice('/api/folders', 'PUT', { path: 'Validation' })).status, 404);
    assert.deepEqual(stored(), before);
  });

  await t.test('removes nested notes and exclusive files immediately, retaining shared and unrelated attachments', async () => {
    for (const id of ['delete-exclusive', 'delete-shared', 'delete-unpublished']) await upload(id);
    await folder('', 'DeleteTree');
    await folder('DeleteTree', 'Empty');
    await folder('DeleteTree', 'Nested');
    const attachmentFields = { content: '[exclusive](asset:delete-exclusive)\n[shared](asset:delete-shared)', attachments: {
      'exclusive.txt': 'asset:delete-exclusive', 'shared.txt': 'asset:delete-shared',
    } };
    const first = await note('delete-first', 'DeleteTree/first.md', alice, attachmentFields);
    const second = await note('delete-nested', 'DeleteTree/Nested/Deep/second.md', alice, attachmentFields);
    const outside = await note('delete-outside', 'DeleteTreeExtra/keep.md', bob, { content: '[shared](asset:delete-shared)' });
    const outsideEmpty = await folder('DeleteTreeExtra', 'Keep empty', bob);
    const beforeOutside = await getNote(outside.id);
    const deleted = await remove('DeleteTree');
    assert.equal(deleted.status, 200);
    assert.equal(deleted.body.notes.some(value => [first.id, second.id].includes(value.id)), false);
    assert.equal(deleted.body.notes.some(value => Object.hasOwn(value, 'content') || Object.hasOwn(value, 'attachments')), false);
    assert.equal(deleted.body.folders.some(value => value.path === 'DeleteTree' || value.path.startsWith('DeleteTree/')), false);
    assert.equal(deleted.body.folders.some(value => value.path === outsideEmpty.path), true);
    assert.deepEqual(await getNote(outside.id), beforeOutside);
    for (const removed of [first, second]) assert.equal((await alice(`/api/notes/${removed.id}`)).status, 404);
    assert.equal((await fetch(`${base}/api/assets/delete-exclusive`)).status, 404);
    await assert.rejects(stat(path.join(dataDir, 'assets', 'delete-exclusive')), { code: 'ENOENT' });
    for (const id of ['delete-shared', 'delete-unpublished']) {
      assert.equal((await fetch(`${base}/api/assets/${id}`, { headers: { Cookie: aliceAccount.cookie } })).status, 200);
      assert.equal((await stat(path.join(dataDir, 'assets', id))).isFile(), true);
    }
    const rows = stored();
    assert.deepEqual(rows.references.filter(reference => reference.asset_id === 'delete-shared').map(reference => reference.note_id), [outside.id]);
    assert.equal(rows.assets.some(asset => asset.id === 'delete-exclusive'), false);
  });

  await t.test('foreign notes block the whole deletion even with shared editing or administrator status', async () => {
    await folder('', 'Mixed');
    await folder('Mixed', 'Empty');
    const own = await note('mixed-own', 'Mixed/own.md');
    const foreign = await note('mixed-foreign', 'Mixed/Nested/foreign.md', bob);
    const privateState = stored();
    for (const client of [alice, bob, admin]) {
      const denied = await remove('Mixed', client);
      assert.equal(denied.status, 403);
      assert.equal(denied.body.code, 'OWNER_REQUIRED');
      assert.deepEqual(stored(), privateState);
    }
    assert.equal((await admin(`/api/notes/${foreign.id}/sharing`, 'PATCH', { collaborative: true })).status, 200);
    const collaborativeState = stored();
    assert.equal((await remove('Mixed')).status, 403);
    assert.equal((await remove('Mixed', admin)).status, 403);
    assert.deepEqual(stored(), collaborativeState);
    assert.equal((await bob(`/api/notes/${foreign.id}`, 'DELETE')).status, 204);
    assert.equal((await remove('Mixed')).status, 200);
    assert.equal((await alice(`/api/notes/${own.id}`)).status, 404);
  });

  await t.test('foreign empty folders enforce creator rights and permit administrator metadata cleanup', async () => {
    await folder('', 'ForeignEmpty');
    await folder('ForeignEmpty', 'Bob empty', bob);
    const before = stored();
    assert.equal((await remove('ForeignEmpty')).status, 403);
    assert.equal((await remove('ForeignEmpty', bob)).status, 403);
    assert.deepEqual(stored(), before);
    assert.equal((await remove('ForeignEmpty', admin)).status, 200);
    assert.equal((await index()).folders.some(value => value.path === 'ForeignEmpty' || value.path.startsWith('ForeignEmpty/')), false);
  });

  await t.test('implicit folders, Unicode-equivalent names and case-equivalent branches delete together at exact path boundaries', async () => {
    const upper = await note('case-delete-upper', 'Café/Upper/one.md');
    const lower = await note('case-delete-lower', 'cafe\u0301/Lower/two.md');
    const sibling = await note('case-delete-sibling', 'CaféExtra/three.md');
    const foreign = await note('case-delete-foreign', 'CAFÉ/Foreign/four.md', bob);
    const before = stored();
    assert.equal((await remove('cAfE\u0301')).status, 403);
    assert.deepEqual(stored(), before);
    assert.equal((await bob(`/api/notes/${foreign.id}`, 'DELETE')).status, 204);
    assert.equal((await remove('cAfE\u0301')).status, 200);
    for (const removed of [upper, lower]) assert.equal((await alice(`/api/notes/${removed.id}`)).status, 404);
    assert.deepEqual(await getNote(sibling.id), sibling);
    assert.equal((await index()).notes.some(value => /^(café|cafe\u0301)\//i.test(value.path || '')), false);
  });

  await t.test('postcommit file cleanup failures do not misreport a successful folder deletion', async () => {
    await upload('delete-cleanup-failure');
    const document = await note('delete-cleanup-note', 'CleanupFailure/item.md', alice, { content: '[file](asset:delete-cleanup-failure)' });
    // Simulate an unexpected filesystem entry without adding production test
    // hooks: rm(file) must reject a directory at the expected attachment path.
    const filename = path.join(dataDir, 'assets', 'delete-cleanup-failure');
    await rm(filename);
    await mkdir(filename);
    await writeFile(path.join(filename, 'unexpected-entry'), 'isolated fixture');
    assert.equal((await remove('CleanupFailure')).status, 200);
    assert.equal((await alice(`/api/notes/${document.id}`)).status, 404);
    assert.equal((await remove('CleanupFailure')).status, 404);
    assert.equal(stored().assets.some(value => value.id === 'delete-cleanup-failure'), false);
    assert.equal((await stat(filename)).isDirectory(), true);
  });
});
