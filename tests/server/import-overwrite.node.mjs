import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createKnowledgeServer } from '../../server/index.mjs';

test('imports atomically overwrite only editable full paths and retain stable document relationships', async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'zhiyu-import-overwrite-'));
  let clock = Date.UTC(2026, 9, 26);
  const { server } = await createKnowledgeServer({ dataDir, readingClock: () => clock });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(dataDir, { recursive: true, force: true }); });
  const actor = () => {
    let cookie = '';
    const request = async (route, method = 'GET', body) => {
      const response = await fetch(`${base}${route}`, { method, headers: { Origin: base,
        ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body) });
      if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
      return { status: response.status, body: [204, 304].includes(response.status) ? null : await response.json() };
    };
    request.upload = async id => {
      const response = await fetch(`${base}/api/assets/${id}`, { method: 'POST', headers: {
        Cookie: cookie, Origin: base, 'Content-Type': 'text/plain', 'X-Asset-Path': `${id}.txt` }, body: `Isolated asset ${id}` });
      assert.equal(response.status, 201, await response.text());
    };
    return request;
  };
  const alice = actor(), bob = actor(), admin = actor();
  const password = 'Isolated-overwrite-test-2026!';
  const aliceUser = (await alice('/api/auth/register', 'POST', { name: 'Import Alice', email: 'overwrite-alice@isolated.test', password })).body.user;
  const bobUser = (await bob('/api/auth/register', 'POST', { name: 'Import Bob', email: 'overwrite-bob@isolated.test', password })).body.user;
  const setup = JSON.parse(await readFile(path.join(dataDir, 'admin-setup.json'), 'utf8'));
  await admin('/api/auth/activate-admin', 'POST', { token: setup.token, password });
  const create = async (client, id, filePath, content = '# Original fixture', extra = {}) => {
    const result = await client('/api/notes', 'POST', { note: { id, title: path.posix.basename(filePath).replace(/\.(md|markdown)$/i, ''), path: filePath, content, ...extra } });
    assert.equal(result.status, 201, JSON.stringify(result.body));
    return result.body.note;
  };
  const importNotes = (client, notes, mode) => client('/api/notes/import', 'POST', { notes, ...(mode ? { mode } : {}) });
  const getNote = async id => (await alice(`/api/notes/${id}`)).body.note;
  const database = fn => {
    const connection = new DatabaseSync(path.join(dataDir, 'knowledge.sqlite'));
    try { connection.exec('PRAGMA foreign_keys = ON'); return fn(connection); }
    finally { connection.close(); }
  };
  const snapshot = () => database(db => ({
    notes: db.prepare('SELECT * FROM notes ORDER BY id').all(),
    references: db.prepare('SELECT * FROM note_assets ORDER BY note_id,asset_id').all(),
    totals: db.prepare('SELECT * FROM reading_totals ORDER BY user_id,note_id').all(),
    visits: db.prepare('SELECT * FROM reading_sessions ORDER BY user_id,session_id').all(),
  }));
  await alice.upload('overwrite-old-asset'); await alice.upload('overwrite-shared-asset'); await alice.upload('overwrite-new-asset');
  await bob.upload('overwrite-unpublished-asset');
  const originalA = await create(alice, 'stable-a', 'Research/01.A.md', '[Old](asset:overwrite-old-asset)\n[Shared](asset:overwrite-shared-asset)', {
    attachments: { 'old.txt': 'asset:overwrite-old-asset', 'shared.txt': 'asset:overwrite-shared-asset' },
  });
  await create(alice, 'stable-b', 'Research/02.B.md');
  await create(alice, 'external-link', 'Other/inbound.md', '[Keep](#note/stable-a)\n[Shared](asset:overwrite-shared-asset)');
  await create(bob, 'private-bob', 'Private/Only Bob.md');
  assert.equal((await admin('/api/notes/stable-a/sharing', 'PATCH', { collaborative: true })).status, 200);

  await t.test('path replacement retains original ID, ownership, sharing, creation time and active reading visit', async () => {
    assert.equal((await alice('/api/reading/start', 'POST', { sessionId: 'survives-import', noteId: originalA.id })).status, 201);
    clock += 15_000;
    assert.equal((await alice('/api/reading/heartbeat', 'POST', { sessionId: 'survives-import', elapsedMs: 15_000 })).body.recordedMs, 5000);
    const before = snapshot();
    const oldA = before.notes.find(row => row.id === originalA.id);
    const result = await importNotes(alice, [{ ...originalA, id: 'temporary-a', title: 'Updated from disk', path: 'Research/01.A.md',
      content: '# New body\n[New](asset:overwrite-new-asset)', attachments: { 'new.txt': 'asset:overwrite-new-asset' },
      ownerId: bobUser.id, author: 'Forged', collaborative: false, createdAt: '2099-01-01', revision: 1 }]);
    assert.equal(result.status, 201, JSON.stringify(result.body));
    assert.equal(result.body.createdCount, 0); assert.equal(result.body.updatedCount, 1);
    const saved = result.body.notes[0];
    assert.equal(saved.id, originalA.id); assert.equal(saved.title, 'Updated from disk');
    assert.equal(saved.ownerId, aliceUser.id); assert.equal(saved.author, aliceUser.name);
    assert.equal(saved.collaborative, true); assert.equal(saved.revision, oldA.revision + 1);
    assert.equal(Object.hasOwn(saved, 'createdAt'), false);
    assert.equal((await alice('/api/notes/temporary-a')).status, 404);
    const after = snapshot(), row = after.notes.find(row => row.id === originalA.id);
    assert.equal(row.created_at, oldA.created_at); assert.equal(row.owner_id, oldA.owner_id);
    assert.deepEqual(after.totals, before.totals); assert.deepEqual(after.visits, before.visits);
    assert.deepEqual(after.references.filter(reference => reference.note_id === originalA.id).map(reference => reference.asset_id), ['overwrite-new-asset']);
    assert.equal((await fetch(`${base}/api/assets/overwrite-shared-asset`)).status, 200, 'shared attachment must remain published');
    assert.equal((await stat(path.join(dataDir, 'assets', 'overwrite-old-asset'))).isFile(), true, 'orphan grace protects other in-flight imports');
    assert.equal((await getNote('external-link')).content, '[Keep](#note/stable-a)\n[Shared](asset:overwrite-shared-asset)');
    clock += 5000;
    assert.equal((await alice('/api/reading/stop', 'POST', { sessionId: 'survives-import', elapsedMs: 20_000 })).body.recordedMs, 10_000);
    const stats = (await admin('/api/admin/reading?noteId=stable-a')).body;
    assert.equal(stats.records[0].noteId, originalA.id); assert.equal(stats.records[0].noteTitle, 'Updated from disk');
    assert.equal(stats.records[0].totalMs, 10_000);
  });

  await t.test('canonical IDs are rewritten across cycles, reference links, escaped/encoded URLs while other source bytes remain exact', async () => {
    const aBody = [
      '# Keep CRLF', '[Direct](#note/temporary-b "untouched title")', '[Encoded](<#note/%74emporary-b>)',
      '[Escaped](#note\\/temporary-b)', '[Entity](&#35;note/temporary-b)', '[Reference][target]',
      '[`API ]`](#note/temporary-b)', '![Embed](#note/temporary-b)', '[Self](#note/temporary-a)', '[New](#note/new-cycle)',
      '', '[target]: <#note/temporary-b> \'reference title\'', '',
      'Plain #note/temporary-b and [label #note/temporary-b](https://example.invalid/#note/temporary-b)',
      '`[Inline example](#note/temporary-b)`', '```md', '[Fenced](#note/temporary-b)', '```', '',
      '    [Indented](#note/temporary-b)', '', '<!-- [HTML comment](#note/temporary-b) -->',
      '%% [Obsidian comment](#note/temporary-b) %%', '\\[Escaped example](#note/temporary-b)',
      '[unused]: #note/temporary-b', '[Malformed encoded](#note/%ZZ)', '',
      '```text', '%%', '```', '', '[After fenced percent](#note/temporary-b)',
      '`%%` [After inline percent](#note/temporary-b)', '<!-- %% -->', '[After HTML percent](#note/temporary-b)',
    ].join('\r\n');
    const expected = aBody
      .replace('[Direct](#note/temporary-b', '[Direct](#note/stable-b')
      .replace('[Encoded](<#note/%74emporary-b>)', '[Encoded](<#note/stable-b>)')
      .replace('[Escaped](#note\\/temporary-b)', '[Escaped](#note/stable-b)')
      .replace('[Entity](&#35;note/temporary-b)', '[Entity](#note/stable-b)')
      .replace('[`API ]`](#note/temporary-b)', '[`API ]`](#note/stable-b)')
      .replace('![Embed](#note/temporary-b)', '![Embed](#note/stable-b)')
      .replace('[Self](#note/temporary-a)', '[Self](#note/stable-a)')
      .replace('[target]: <#note/temporary-b>', '[target]: <#note/stable-b>')
      .replace('[After fenced percent](#note/temporary-b)', '[After fenced percent](#note/stable-b)')
      .replace('[After inline percent](#note/temporary-b)', '[After inline percent](#note/stable-b)')
      .replace('[After HTML percent](#note/temporary-b)', '[After HTML percent](#note/stable-b)');
    const result = await importNotes(alice, [
      { id: 'temporary-a', title: 'A import', path: 'Research/01.A.md', content: aBody },
      { id: 'temporary-b', title: 'B import', path: 'Research/02.B.md', content: '[Cycle](#note/temporary-a)\n[New](#note/new-cycle)' },
      { id: 'new-cycle', title: 'New', path: 'Research/03.New.md', content: '[A](#note/temporary-a)\n[B](#note/temporary-b)' },
    ]);
    assert.equal(result.status, 201, JSON.stringify(result.body));
    assert.equal(result.body.createdCount, 1); assert.equal(result.body.updatedCount, 2);
    assert.deepEqual(result.body.notes.map(note => note.id), ['stable-a', 'stable-b', 'new-cycle']);
    assert.equal(result.body.notes[0].content, expected);
    assert.equal(result.body.notes[1].content, '[Cycle](#note/stable-a)\n[New](#note/new-cycle)');
    assert.equal(result.body.notes[2].content, '[A](#note/stable-a)\n[B](#note/stable-b)');
    const repeat = await importNotes(alice, [{ id: 'stable-a', title: 'Repeat A', path: 'Research/01.A.md', content: '# Repeated body' }]);
    assert.equal(repeat.status, 201); assert.equal(repeat.body.notes[0].content, '# Repeated body');
    assert.equal(repeat.body.notes[0].revision, result.body.notes[0].revision + 1);
    assert.equal((await admin('/api/admin/reading?noteId=stable-a')).body.records[0].totalMs, 10_000);
    const encodedPrefix = await importNotes(alice, [
      { id: 'encoded-owner', title: 'Encoded', path: 'Encoded/Owner.md', content: '[B](&#35;n&#111;te/encoded-target)' },
      { id: 'encoded-target', title: 'B', path: 'Research/02.B.md', content: '# Encoded target' },
    ]);
    assert.equal(encodedPrefix.status, 201);
    assert.equal(encodedPrefix.body.notes[0].content, '[B](#note/stable-b)');
  });

  await t.test('normalization matches complete file paths while other directories and extensions stay distinct', async () => {
    const original = await create(alice, 'normalized-file', '资料/Café/文件.md');
    const normalized = await importNotes(alice, [{ id: 'temporary-normalized', title: 'Updated normalized', path: '资料\\Café/./子目录/../文件.MD', content: '# New normalized' }]);
    assert.equal(normalized.status, 201, JSON.stringify(normalized.body));
    assert.equal(normalized.body.notes[0].id, original.id);
    assert.equal(normalized.body.notes[0].path, '资料/Café/文件.md');
    const distinct = await importNotes(alice, [
      { id: 'other-directory', title: 'A', path: 'Other/01.A.md', content: '# Other folder' },
      { id: 'other-extension', title: 'A', path: 'Research/01.A.markdown', content: '# Other extension' },
    ]);
    assert.equal(distinct.status, 201); assert.equal(distinct.body.createdCount, 2); assert.equal(distinct.body.updatedCount, 0);
    const createCollision = await alice('/api/notes', 'POST', { note: { id: 'ordinary-create', title: 'A', path: 'Research/01.A.md', content: 'Must not overwrite by creating' } });
    assert.equal(createCollision.status, 409); assert.equal(createCollision.body.code, 'NOTE_PATH_EXISTS');
  });

  await t.test('ownership rules and attachment checks reject entire batches; collaborative editing keeps the owner', async () => {
    for (const client of [bob, admin]) {
      const before = snapshot();
      const denied = await importNotes(client, [
        { id: 'atomic-permission-new', title: 'New', path: 'Atomic/New.md', content: 'Not committed' },
        { id: 'foreign-temporary', title: 'B', path: 'Research/02.B.md', content: 'Must not overwrite another author' },
      ]);
      assert.equal(denied.status, 403); assert.equal(denied.body.code, 'NOTE_READ_ONLY');
      assert.deepEqual(snapshot(), before);
    }
    const shared = await importNotes(bob, [{ id: 'bob-shared-temporary', title: 'Shared A', path: 'Research/01.A.md', content: '# Bob collaboration', ownerId: bobUser.id, collaborative: false }]);
    assert.equal(shared.status, 201, JSON.stringify(shared.body));
    assert.equal(shared.body.notes[0].id, 'stable-a'); assert.equal(shared.body.notes[0].ownerId, aliceUser.id);
    assert.equal(shared.body.notes[0].author, aliceUser.name); assert.equal(shared.body.notes[0].collaborative, true);
    for (const assetId of ['does-not-exist', 'overwrite-unpublished-asset']) {
      const before = snapshot();
      const denied = await importNotes(alice, [
        { id: 'atomic-valid-change', title: 'Changed A', path: 'Research/01.A.md', content: '# Must roll back' },
        { id: 'atomic-invalid-asset', title: 'Invalid', path: 'Atomic/Invalid.md', content: `[Missing](asset:${assetId})` },
      ]);
      assert.equal(denied.status, assetId === 'does-not-exist' ? 400 : 403);
      assert.deepEqual(snapshot(), before);
    }
  });

  await t.test('duplicate paths, ambiguous history and conflicting IDs reject atomically instead of choosing or moving documents', async () => {
    const scenarios = [
      { code: 'DUPLICATE_NOTE_PATH', notes: [
        { id: 'duplicate-path-one', title: 'A', path: 'Research/01.A.md', content: 'one' },
        { id: 'duplicate-path-two', title: 'A', path: 'research/01.a.MD', content: 'two' },
      ] },
      { code: 'DUPLICATE_NOTE', notes: [
        { id: 'duplicate-source-id', title: 'One', path: 'Atomic/One.md', content: 'one' },
        { id: 'duplicate-source-id', title: 'Two', path: 'Atomic/Two.md', content: 'two' },
      ] },
      { code: 'NOTE_ID_CONFLICT', notes: [{ id: 'stable-a', title: 'Move', path: 'Moved/A.md', content: 'Must not move' }] },
      { code: 'NOTE_ID_CONFLICT', notes: [{ id: 'stable-a', title: 'B', path: 'Research/02.B.md', content: 'Must not replace B by A ID' }] },
      { code: 'NOTE_PATH_EXISTS', notes: [
        { id: 'file-at-parent', title: 'Parent', path: 'Atomic/Parent.md', content: 'one' },
        { id: 'file-in-file', title: 'Child', path: 'Atomic/Parent.md/Child.md', content: 'two' },
      ] },
    ];
    for (const scenario of scenarios) {
      const before = snapshot();
      const result = await importNotes(alice, scenario.notes);
      assert.equal(result.status, 409, JSON.stringify(result.body)); assert.equal(result.body.code, scenario.code);
      assert.deepEqual(snapshot(), before);
    }
    await create(alice, 'historical-one', 'History/Duplicate.md');
    database(db => {
      const existing = db.prepare('SELECT * FROM notes WHERE id = ?').get('historical-one');
      const data = { ...JSON.parse(existing.data), id: 'historical-two' };
      db.prepare('INSERT INTO notes(id,owner_id,data,created_at,updated_at) VALUES(?,?,?,?,?)').run(data.id, existing.owner_id, JSON.stringify(data), existing.created_at, existing.updated_at);
    });
    const before = snapshot();
    const ambiguous = await importNotes(alice, [
      { id: 'atomic-before-ambiguity', title: 'A', path: 'Research/01.A.md', content: '# Must stay unchanged' },
      { id: 'incoming-ambiguous', title: 'Duplicate', path: 'History/Duplicate.md', content: '# Which one?' },
    ]);
    assert.equal(ambiguous.status, 409); assert.equal(ambiguous.body.code, 'NOTE_PATH_AMBIGUOUS');
    assert.deepEqual(snapshot(), before);
  });

  await t.test('a commit-time SQLite failure rolls back earlier note and attachment reference updates', async () => {
    const before = snapshot();
    database(db => db.exec(`CREATE TRIGGER isolated_import_failure BEFORE INSERT ON notes WHEN NEW.id = 'atomic-failing-insert'
      BEGIN SELECT RAISE(ABORT, 'isolated import rollback fixture'); END`));
    try {
      const result = await importNotes(alice, [
        { id: 'atomic-existing-change', title: 'Must roll back', path: 'Research/01.A.md', content: '[Asset](asset:overwrite-new-asset)', attachments: { 'new.txt': 'asset:overwrite-new-asset' } },
        { id: 'atomic-failing-insert', title: 'Fail', path: 'Atomic/Failure.md', content: '# Must fail' },
      ]);
      assert.equal(result.status, 500);
      assert.deepEqual(snapshot(), before);
    } finally { database(db => db.exec('DROP TRIGGER isolated_import_failure')); }
  });

  await t.test('administrator legacy migration preserves current server copies while remapping links in genuinely new notes', async () => {
    const before = snapshot();
    for (const client of [alice, bob]) {
      const denied = await importNotes(client, [{ id: 'legacy-admin-only', title: 'New', path: 'Legacy/New.md', content: '# New' }], 'legacy-migration');
      assert.equal(denied.status, 403); assert.equal(denied.body.code, 'ADMIN_REQUIRED');
    }
    assert.equal((await importNotes(admin, [{ id: 'unknown-mode', title: 'New', path: 'Legacy/New.md', content: '# New' }], 'overwrite-whatever')).status, 400);
    const migrated = await importNotes(admin, [
      { id: 'legacy-old-a', title: 'Old A', path: 'Research/01.A.md', content: '', migrationAlias: true },
      { id: 'legacy-old-b', title: 'Old B', path: 'Private/Only Bob.md', content: '', migrationAlias: true },
      { id: 'legacy-new', title: 'Legacy new', path: 'Legacy/New.md', content: '[A](#note/legacy-old-a)\n[Bob](#note/legacy-old-b)' },
    ], 'legacy-migration');
    assert.equal(migrated.status, 201, JSON.stringify(migrated.body));
    assert.equal(migrated.body.createdCount, 1); assert.equal(migrated.body.updatedCount, 0); assert.equal(migrated.body.skippedCount, 2);
    assert.deepEqual(migrated.body.notes.map(note => note.id), ['stable-a', 'private-bob', 'legacy-new']);
    assert.equal(migrated.body.notes[2].content, '[A](#note/stable-a)\n[Bob](#note/private-bob)');
    const after = snapshot();
    for (const row of before.notes) assert.deepEqual(after.notes.find(note => note.id === row.id), row);
    assert.deepEqual(after.totals, before.totals); assert.deepEqual(after.visits, before.visits);
    assert.equal(after.notes.length, before.notes.length + 1);
    const beforeChanged = snapshot();
    const changed = await importNotes(admin, [
      { id: 'legacy-deleted-alias', title: 'Deleted', path: 'Legacy/Deleted.md', content: '', migrationAlias: true },
      { id: 'legacy-invalid-new', title: 'Would be empty', path: 'Legacy/Not committed.md', content: '[Deleted](#note/legacy-deleted-alias)' },
    ], 'legacy-migration');
    assert.equal(changed.status, 409); assert.equal(changed.body.code, 'MIGRATION_TARGET_CHANGED');
    assert.deepEqual(snapshot(), beforeChanged);
    const ordinaryAlias = await importNotes(alice, [{ id: 'ordinary-alias', title: 'No', path: 'Legacy/Ordinary.md', content: '', migrationAlias: true }]);
    assert.equal(ordinaryAlias.status, 400); assert.equal(ordinaryAlias.body.code, 'INVALID_IMPORT_MODE');
    assert.deepEqual(snapshot(), beforeChanged);
  });
});
