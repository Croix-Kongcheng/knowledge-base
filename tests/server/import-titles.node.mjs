import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import test from 'node:test';
import { createKnowledgeServer } from '../../server/index.mjs';
import { restoreImportedNumberedTitles } from '../../scripts/restore-imported-numbered-titles.mjs';

test('numbered import title restoration is scoped, private, durable, idempotent, and preserves concurrent changes', async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'zhiyu-import-title-repair-'));
  const { server, databasePath } = await createKnowledgeServer({ dataDir });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const password = 'Isolated-import-title-password-2026!';
  const ownerEmail = 'import-title-owner@isolated.test';
  const actor = () => {
    let cookie = '';
    const request = async (route, method = 'GET', body) => {
      const response = await fetch(`${base}${route}`, {
        method, headers: { Origin: base, ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
      return { status: response.status, body: response.status === 204 ? null : await response.json() };
    };
    request.cookie = () => cookie;
    return request;
  };
  const owner = actor(), other = actor(), admin = actor();
  assert.equal((await owner('/api/auth/register', 'POST', { name: 'Import owner', email: ownerEmail, password })).status, 201);
  assert.equal((await other('/api/auth/register', 'POST', { name: 'Other owner', email: 'other-import-owner@isolated.test', password })).status, 201);
  const setup = JSON.parse(await readFile(path.join(dataDir, 'admin-setup.json'), 'utf8'));
  assert.equal((await admin('/api/auth/activate-admin', 'POST', { token: setup.token, password })).status, 200);
  const upload = await fetch(`${base}/api/assets/title-repair-picture`, {
    method: 'POST', headers: { Cookie: owner.cookie(), 'Content-Type': 'image/svg+xml' }, body: '<svg xmlns="http://www.w3.org/2000/svg"/>',
  });
  assert.equal(upload.status, 201);
  const create = async (values = {}, account = owner) => {
    const input = { id: randomUUID(), title: 'Original heading marker', content: '# Original heading marker\n\nPRIVATE-BODY-MARKER\n\n[稳定链接](#note/stable-note-id)\n\n![附件](asset:title-repair-picture)',
      path: '资料/02.Original heading marker.md', color: 'purple', tags: ['保持原标签'], attachments: { '附件.svg': 'asset:title-repair-picture' }, ...values };
    const result = await account('/api/notes/import', 'POST', { notes: [input] });
    assert.equal(result.status, 201, JSON.stringify(result.body));
    return result.body.notes[0];
  };
  const regular = await create();
  let shared = await create({ path: '资料/03.Sharing only.markdown', color: 'blue' });
  const sharing = await admin(`/api/notes/${shared.id}/sharing`, 'PATCH', { collaborative: true });
  assert.equal(sharing.status, 200);
  shared = sharing.body.note;
  const unchanged = [];
  unchanged.push(await create({ path: '资料/04.Already correct.md', title: '04.Already correct' }));
  unchanged.push(await create({ path: '资料/05.Manual title.md', title: 'Manually chosen title' }));
  let edited = await create({ path: '资料/06.Edited content.md' });
  edited = (await owner(`/api/notes/${edited.id}`, 'PATCH', { note: { content: `${edited.content}\n\nA later manual content change.` }, revision: edited.revision })).body.note;
  unchanged.push(edited);
  let moved = await create({ path: '资料/07.Moved note.md' });
  moved = (await owner(`/api/notes/${moved.id}`, 'PATCH', { note: { path: 'Moved/07.Moved note.md' }, revision: moved.revision })).body.note;
  unchanged.push(moved);
  unchanged.push(await create({ path: '资料/Unnumbered.md' }));
  unchanged.push(await create({ id: 'ordinary-ui-note', path: '资料/08.Ordinary note.md' }));
  unchanged.push(await create({ path: '资料/09.Non-importer color.md', color: '#8b7cf8' }));
  unchanged.push(await create({ path: '资料/10.No heading.md', content: 'No leading Markdown heading.' }));
  unchanged.push(await create({ path: '资料/11.Not markdown.txt' }));
  unchanged.push(await create({ path: undefined }));
  // The other author owns their own simple content; no private asset reference.
  unchanged.push(await create({ path: '资料/12.Other owner.md', content: '# Original heading marker', attachments: {} }, other));
  const readRows = () => {
    const db = new DatabaseSync(databasePath, { readOnly: true });
    try { return db.prepare('SELECT * FROM notes ORDER BY id').all(); } finally { db.close(); }
  };
  const before = readRows();
  let applied;

  await t.test('dry run requires an explicit owner and emits only counts without creating backup files', async () => {
    await assert.rejects(restoreImportedNumberedTitles({ dataDir }), /owner-email/);
    await assert.rejects(restoreImportedNumberedTitles({ dataDir, ownerEmail: 'absent@isolated.test' }), /not found/);
    const preview = await restoreImportedNumberedTitles({ dataDir, ownerEmail });
    assert.equal(preview.mode, 'dry-run');
    assert.equal(preview.candidates, 2);
    assert.equal(preview.sharingOnlyCandidates, 1);
    assert.equal(preview.excludedOtherOwners, 1);
    assert.equal(preview.exclusions.modifiedAfterImport, 2);
    assert.equal(preview.exclusions.titleDoesNotMatchFirstHeading, 2);
    assert.equal(preview.exclusions.nonImporterId, 1);
    assert.equal(preview.exclusions.nonImporterColor, 1);
    assert.deepEqual(readRows(), before);
    assert.ok(!(await readdir(dataDir)).includes('backups'));
    const { stdout } = await promisify(execFile)(process.execPath, [path.resolve('scripts/restore-imported-numbered-titles.mjs'), '--data-dir', dataDir, '--owner-email', ownerEmail]);
    assert.equal(JSON.parse(stdout).candidates, 2);
    for (const marker of [ownerEmail, 'Original heading marker', 'PRIVATE-BODY-MARKER', password, regular.id]) assert.ok(!stdout.includes(marker));
  });

  await t.test('apply restores both untouched and sharing-only imports and preserves all other fields and old revision protection', async () => {
    applied = await restoreImportedNumberedTitles({ dataDir, ownerEmail, apply: true });
    assert.equal(applied.applied, 2);
    assert.equal(applied.skippedConcurrentChanges, 0);
    assert.equal((await stat(path.join(dataDir, 'backups'))).mode & 0o777, 0o700);
    for (const artifact of [applied.backupPath, applied.manifestPath]) assert.equal((await stat(artifact)).mode & 0o777, 0o600);
    const snapshot = new DatabaseSync(applied.backupPath, { readOnly: true });
    try {
      assert.equal(snapshot.prepare('PRAGMA quick_check').get().quick_check, 'ok');
      assert.deepEqual(snapshot.prepare('SELECT * FROM notes ORDER BY id').all(), before);
    } finally { snapshot.close(); }
    const manifestText = await readFile(applied.manifestPath, 'utf8');
    const manifest = JSON.parse(manifestText);
    assert.equal(manifest.state, 'committed');
    assert.equal(manifest.notes.length, 2);
    for (const secret of ['password_hash', 'password_salt', password, ownerEmail, 'PRIVATE-BODY-MARKER', 'asset:title-repair-picture']) assert.ok(!manifestText.includes(secret));
    const after = readRows();
    for (const old of before) {
      const next = after.find(row => row.id === old.id);
      if (![regular.id, shared.id].includes(old.id)) { assert.deepEqual(next, old); continue; }
      const oldData = JSON.parse(old.data), newData = JSON.parse(next.data);
      assert.equal(newData.title, oldData.path.split('/').pop().replace(/\.(md|markdown)$/i, ''));
      assert.deepEqual({ ...newData, title: oldData.title }, oldData);
      assert.deepEqual({ ...next, data: old.data, revision: old.revision }, { ...old });
      assert.equal(next.revision, old.revision + 1);
      assert.equal(next.collaborative, old.collaborative);
      const stale = await owner(`/api/notes/${old.id}`, 'PATCH', { note: { content: 'Stale overwrite attempt' }, revision: old.revision });
      assert.equal(stale.status, 409);
      assert.equal(stale.body.code, 'REVISION_CONFLICT');
    }
    assert.equal((await other(`/api/notes/${regular.id}`, 'PATCH', { note: { content: 'Unauthorized' } })).status, 403);
    assert.equal((await other(`/api/notes/${shared.id}`)).body.note.collaborative, true);
    assert.equal((await other(`/api/notes/${shared.id}`, 'DELETE')).status, 403);
    const asset = await fetch(`${base}/api/assets/title-repair-picture`);
    assert.equal(asset.status, 200);
    assert.equal(await asset.text(), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  });

  await t.test('running again is idempotent and creates no extra recovery artifacts', async () => {
    const files = await readdir(path.join(dataDir, 'backups'));
    const rows = readRows();
    const repeat = await restoreImportedNumberedTitles({ dataDir, ownerEmail, apply: true });
    assert.equal(repeat.candidates, 0);
    assert.equal(repeat.applied, 0);
    assert.deepEqual(readRows(), rows);
    assert.deepEqual(await readdir(path.join(dataDir, 'backups')), files);
  });

  await t.test('live writes between planning and the transaction are retained and changed candidates are skipped', async () => {
    const concurrent = await create({ path: '资料/13.Concurrent document.md' });
    let changed, newlyCreated;
    const result = await restoreImportedNumberedTitles({ dataDir, ownerEmail, apply: true, beforeApply: async () => {
      const response = await owner(`/api/notes/${concurrent.id}`, 'PATCH', { note: { title: 'Concurrent manually chosen title', content: `${concurrent.content}\n\nConcurrent user edit survives.` }, revision: concurrent.revision });
      assert.equal(response.status, 200);
      changed = response.body.note;
      newlyCreated = await create({ path: '资料/14.Created during maintenance.md' });
    } });
    assert.equal(result.candidates, 1);
    assert.equal(result.applied, 0);
    assert.equal(result.skippedConcurrentChanges, 1);
    assert.deepEqual((await owner(`/api/notes/${concurrent.id}`)).body.note, changed);
    assert.deepEqual((await owner(`/api/notes/${newlyCreated.id}`)).body.note, newlyCreated);
    const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8'));
    assert.equal(manifest.notes[0].status, 'skipped-concurrent-change');
  });
});
