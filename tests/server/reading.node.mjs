import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createKnowledgeServer } from '../../server/index.mjs';

test('private reading accounting qualifies visits, bounds durations and survives lifecycle changes', async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'zhiyu-reading-'));
  let server, base, clock = Date.UTC(2026, 9, 26);
  const advance = ms => { clock += ms; };
  const startServer = async () => {
    ({ server } = await createKnowledgeServer({ dataDir, readingClock: () => clock }));
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
  };
  const stopServer = () => new Promise(resolve => server.close(resolve));
  t.after(async () => { if (server?.listening) await stopServer(); await rm(dataDir, { recursive: true, force: true }); });
  await startServer();
  const actor = () => {
    let cookie = '';
    return async (route, method = 'GET', body) => {
      const response = await fetch(`${base}${route}`, { method, headers: { Origin: base,
        ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body) });
      if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
      return { status: response.status, headers: response.headers, body: [204, 304].includes(response.status) ? null : await response.json() };
    };
  };
  const alice = actor(), bob = actor(), admin = actor(), guest = actor();
  const password = 'Isolated-reading-fixture-2026!';
  const aliceUser = (await alice('/api/auth/register', 'POST', { name: 'Reader Alice', email: 'reading-alice@isolated.test', password })).body.user;
  const bobUser = (await bob('/api/auth/register', 'POST', { name: 'Reader Bob', email: 'reading-bob@isolated.test', password })).body.user;
  const setup = JSON.parse(await readFile(path.join(dataDir, 'admin-setup.json'), 'utf8'));
  const adminUser = (await admin('/api/auth/activate-admin', 'POST', { token: setup.token, password })).body.user;
  const notes = ['threshold', 'switch', 'never-read', 'server-bound', 'stale', 'restart', 'removable'].map(id => `reading-${id}`);
  for (const id of notes) assert.equal((await alice('/api/notes', 'POST', { note: { id, title: `Fixture ${id}`, path: `Reading/${id}.md`, content: '# Isolated fixture' } })).status, 201);
  const begin = (client, sessionId, noteId) => client('/api/reading/start', 'POST', { sessionId, noteId });
  const beat = (client, sessionId, elapsedMs) => client('/api/reading/heartbeat', 'POST', { sessionId, elapsedMs });
  const stop = (client, sessionId, elapsedMs) => client('/api/reading/stop', 'POST', { sessionId, elapsedMs });
  const stats = async query => {
    const result = await admin(`/api/admin/reading${query || ''}`);
    assert.equal(result.status, 200); assert.equal(result.headers.get('cache-control'), 'private, no-store');
    return result.body;
  };
  const total = async (userId, noteId) => (await stats(`?userId=${userId}&noteId=${noteId}`)).records.reduce((sum, row) => sum + row.totalMs, 0);

  await t.test('only administrators can read statistics and write identity always comes from the session cookie', async () => {
    assert.equal((await guest('/api/admin/reading')).status, 401);
    assert.equal((await alice('/api/admin/reading')).status, 403);
    assert.equal((await alice('/api/admin/reading?userId=../bad&page=-1')).status, 403);
    assert.equal((await guest('/api/reading/start', 'POST', { sessionId: 'anonymous', noteId: notes[0] })).status, 401);
    assert.equal((await begin(alice, 'invalid-note', 'missing-note')).status, 404);
    assert.equal((await alice('/api/reading/start', 'POST', { sessionId: 'target-user', noteId: notes[0], userId: bobUser.id })).status, 400);
    assert.equal((await alice(`/api/reading/start?userId=${bobUser.id}`, 'POST', { sessionId: 'target-query', noteId: notes[0] })).status, 400);
    assert.equal((await beat(alice, 'invalid-duration', -1)).status, 400);
    assert.equal((await beat(alice, 'invalid-duration', 1.5)).status, 400);
    assert.equal((await alice('/api/reading/heartbeat', 'POST', { sessionId: 'invalid-duration', elapsedMs: 20_000, userId: bobUser.id })).status, 400);
    for (const route of ['/api/members', '/api/notes/index', `/api/notes/${notes[0]}`, '/api/session']) {
      const result = await alice(route);
      assert.equal(JSON.stringify(result.body).includes('totalMs'), false, route);
      assert.equal(JSON.stringify(result.body).includes('lastReadAt'), false, route);
    }
    const empty = await stats();
    assert.deepEqual(empty.summary, { totalMs: 0, readerCount: 0, noteCount: 0, pairCount: 0 });
    assert.equal(empty.users.length, 3); assert.equal(empty.notes.length, notes.length);
    assert.ok(empty.users.every(user => user.totalMs === 0 && user.lastReadAt === null));
    assert.ok(empty.notes.every(note => note.totalMs === 0 && note.lastReadAt === null));
  });

  await t.test('ten seconds are excluded, retries and out-of-order samples cannot add time', async () => {
    assert.equal((await begin(alice, 'threshold-visit', notes[0])).status, 201);
    advance(5000); assert.equal((await beat(alice, 'threshold-visit', 5000)).body.recordedMs, 0);
    advance(5000); assert.equal((await beat(alice, 'threshold-visit', 10_000)).body.recordedMs, 0);
    advance(1); assert.equal((await beat(alice, 'threshold-visit', 10_001)).body.recordedMs, 1);
    advance(4999); assert.equal((await beat(alice, 'threshold-visit', 15_000)).body.recordedMs, 5000);
    advance(1000); assert.equal((await beat(alice, 'threshold-visit', 15_000)).body.recordedMs, 5000);
    assert.equal((await beat(alice, 'threshold-visit', 11_000)).body.recordedMs, 5000);
    advance(1000); assert.deepEqual((await stop(alice, 'threshold-visit', 17_000)).body, { sessionId: 'threshold-visit', recordedMs: 7000, active: false });
    advance(50_000); assert.equal((await stop(alice, 'threshold-visit', 999_999)).body.recordedMs, 7000);
    assert.equal((await beat(alice, 'threshold-visit', 999_999)).status, 410);
    assert.equal((await begin(alice, 'threshold-visit', notes[0])).status, 410);
    assert.equal(await total(aliceUser.id, notes[0]), 7000);
    assert.equal((await beat(bob, 'threshold-visit', 999_999)).status, 410);
    assert.equal(await total(bobUser.id, notes[0]), 0);
  });

  await t.test('short visits reset qualification and switching replaces the sole active visit for that user', async () => {
    for (const id of ['short-visit-one', 'short-visit-two']) {
      await begin(alice, id, notes[1]); advance(9000);
      assert.equal((await stop(alice, id, 9000)).body.recordedMs, 0);
    }
    assert.equal(await total(aliceUser.id, notes[1]), 0);
    await begin(alice, 'previous-tab', notes[0]); advance(15_000);
    assert.equal((await beat(alice, 'previous-tab', 15_000)).body.recordedMs, 5000);
    assert.equal((await begin(alice, 'shown-tab', notes[1])).status, 201);
    const replaced = await beat(alice, 'previous-tab', 20_000);
    assert.equal(replaced.status, 409); assert.equal(replaced.body.code, 'READING_SESSION_REPLACED');
    const retryReplaced = await begin(alice, 'previous-tab', notes[0]);
    assert.equal(retryReplaced.status, 409); assert.equal(retryReplaced.body.code, 'READING_SESSION_REPLACED');
    assert.equal((await stop(alice, 'previous-tab', 99_000)).body.active, false);
    advance(5000); assert.equal((await beat(alice, 'shown-tab', 5000)).body.recordedMs, 0);
    assert.equal((await begin(alice, 'shown-tab', notes[1])).status, 200);
    advance(10_000); assert.equal((await stop(alice, 'shown-tab', 15_000)).body.recordedMs, 5000);
    assert.equal(await total(aliceUser.id, notes[0]), 12_000);
    assert.equal(await total(aliceUser.id, notes[1]), 5000);
    assert.equal((await begin(alice, 'shown-tab', notes[0])).status, 409);
  });

  await t.test('server time bounds forged duration and expired heartbeat gaps cannot be billed or revived', async () => {
    await begin(alice, 'forged-immediate', notes[3]);
    assert.equal((await beat(alice, 'forged-immediate', Number.MAX_SAFE_INTEGER)).body.recordedMs, 0);
    advance(15_000);
    assert.equal((await beat(alice, 'forged-immediate', Number.MAX_SAFE_INTEGER)).body.recordedMs, 0);
    assert.equal((await stop(alice, 'forged-immediate', Number.MAX_SAFE_INTEGER)).body.recordedMs, 0);
    await begin(alice, 'bounded-visit', notes[3]); advance(15_000);
    assert.equal((await stop(alice, 'bounded-visit', 100_000_000)).body.recordedMs, 5000);
    assert.equal(await total(aliceUser.id, notes[3]), 5000);
    await begin(alice, 'stale-visit', notes[4]); advance(15_000);
    assert.equal((await beat(alice, 'stale-visit', 15_000)).body.recordedMs, 5000);
    advance(20_001);
    const expired = await beat(alice, 'stale-visit', 35_001);
    assert.equal(expired.status, 410); assert.equal(expired.body.code, 'READING_SESSION_EXPIRED');
    assert.equal((await beat(alice, 'stale-visit', 35_001)).status, 410);
    assert.equal((await stop(alice, 'stale-visit', 35_001)).body.recordedMs, 5000);
    await begin(alice, 'stale-fresh-visit', notes[4]); advance(9000);
    assert.equal((await stop(alice, 'stale-fresh-visit', 9000)).body.recordedMs, 0);
    assert.equal(await total(aliceUser.id, notes[4]), 5000);
    await begin(alice, 'start-cannot-revive', notes[4]); advance(20_001);
    assert.equal((await begin(alice, 'start-cannot-revive', notes[4])).status, 410);
    assert.equal((await stop(alice, 'start-cannot-revive', 999_999)).body.recordedMs, 0);
  });

  await t.test('per-user and per-note aggregates use live metadata, pagination and private record-only filters', async () => {
    await begin(bob, 'bob-reading', notes[0]); advance(18_000);
    await stop(bob, 'bob-reading', 18_000);
    await bob('/api/profile', 'PATCH', { name: 'Renamed Bob' });
    const note = (await alice(`/api/notes/${notes[0]}`)).body.note;
    assert.equal((await alice(`/api/notes/${notes[0]}`, 'PATCH', { note: { ...note, title: 'Renamed shared fixture', path: 'Reading/renamed.md' } })).status, 200);
    const all = await stats();
    assert.equal(all.summary.totalMs, 35_000); assert.equal(all.summary.readerCount, 2);
    assert.equal(all.summary.noteCount, 4); assert.equal(all.summary.pairCount, 5);
    const aliceStats = all.users.find(user => user.userId === aliceUser.id);
    assert.equal(aliceStats.totalMs, 27_000); assert.equal(aliceStats.noteCount, 4);
    const bobStats = all.users.find(user => user.userId === bobUser.id);
    assert.equal(bobStats.name, 'Renamed Bob'); assert.equal(bobStats.totalMs, 8000);
    assert.equal(all.users.find(user => user.userId === adminUser.id).totalMs, 0);
    assert.equal(all.notes.find(note => note.noteId === notes[0]).title, 'Renamed shared fixture');
    assert.equal(all.notes.find(note => note.noteId === notes[0]).totalMs, 20_000);
    assert.equal(all.notes.find(note => note.noteId === notes[0]).readerCount, 2);
    assert.equal(all.notes.find(note => note.noteId === notes[2]).totalMs, 0);
    const filtered = await stats(`?userId=${bobUser.id}&noteId=${notes[0]}&q=Renamed&pageSize=1`);
    assert.deepEqual(filtered.summary, all.summary); assert.deepEqual(filtered.users, all.users); assert.deepEqual(filtered.notes, all.notes);
    assert.equal(filtered.pagination.total, 1); assert.equal(filtered.records.length, 1);
    assert.equal(filtered.records[0].userName, 'Renamed Bob'); assert.equal(filtered.records[0].noteTitle, 'Renamed shared fixture');
    assert.equal(filtered.records[0].notePath, 'Reading/renamed.md'); assert.equal(filtered.records[0].totalMs, 8000);
    assert.match(filtered.records[0].lastReadAt, /^2026-10-26T/);
    assert.equal((await stats('?q=%')).pagination.total, 0);
    assert.equal((await stats('?q=_')).pagination.total, 0);
    const pageOne = await stats('?page=1&pageSize=2'), pageTwo = await stats('?page=2&pageSize=2');
    assert.equal(pageOne.records.length, 2); assert.equal(pageTwo.records.length, 2);
    assert.equal(new Set([...pageOne.records, ...pageTwo.records].map(row => `${row.userId}/${row.noteId}`)).size, 4);
    for (const query of ['?page=0', '?pageSize=101', '?page=NaN', '?userId=../bad', `?q=${'x'.repeat(201)}`]) assert.equal((await admin(`/api/admin/reading${query}`)).status, 400);
  });

  await t.test('active and accumulated reading records persist across server restart without rerecording old samples', async () => {
    await begin(alice, 'restart-visit', notes[5]); advance(15_000);
    await beat(alice, 'restart-visit', 15_000);
    const before = await stats();
    await stopServer(); advance(2000); await startServer();
    assert.deepEqual((await stats()).summary, before.summary);
    assert.equal((await beat(alice, 'restart-visit', 15_000)).body.recordedMs, 5000);
    advance(3000); assert.equal((await stop(alice, 'restart-visit', 20_000)).body.recordedMs, 10_000);
    assert.equal(await total(aliceUser.id, notes[5]), 10_000);
  });

  await t.test('reading-only writes preserve note representations and note deletion cascades private records', async () => {
    const before = await alice('/api/notes/index');
    await begin(alice, 'removable-visit', notes[6]); advance(15_000);
    await stop(alice, 'removable-visit', 15_000);
    const after = await alice('/api/notes/index');
    assert.equal(after.headers.get('etag'), before.headers.get('etag'));
    assert.deepEqual(after.body, before.body);
    assert.equal(await total(aliceUser.id, notes[6]), 5000);
    assert.equal((await alice(`/api/notes/${notes[6]}`, 'DELETE')).status, 204);
    const all = await stats();
    assert.equal(all.notes.some(note => note.noteId === notes[6]), false);
    assert.equal(all.records.some(row => row.noteId === notes[6]), false);
    assert.equal((await beat(alice, 'removable-visit', 999_999)).status, 410);
    const external = new DatabaseSync(path.join(dataDir, 'knowledge.sqlite'));
    external.exec('PRAGMA foreign_keys = ON');
    const doomed = 'reading-deleted-user';
    external.prepare('INSERT INTO users(id,name,email,role,created_at) VALUES(?,?,?,?,?)').run(doomed, 'Deleted Reader', 'deleted-reader@isolated.test', 'member', new Date(clock).toISOString());
    external.prepare('INSERT INTO reading_totals(user_id,note_id,total_ms,last_read_at) VALUES(?,?,?,?)').run(doomed, notes[0], 1234, clock);
    external.prepare('INSERT INTO reading_sessions(user_id,session_id,note_id,started_at,last_event_at) VALUES(?,?,?,?,?)').run(doomed, 'deleted-user-session', notes[0], clock, clock);
    external.prepare('DELETE FROM users WHERE id = ?').run(doomed);
    assert.equal(external.prepare('SELECT COUNT(*) AS count FROM reading_totals WHERE user_id = ?').get(doomed).count, 0);
    assert.equal(external.prepare('SELECT COUNT(*) AS count FROM reading_sessions WHERE user_id = ?').get(doomed).count, 0);
    external.close();
    assert.equal((await stats()).users.some(user => user.userId === doomed), false);
  });
});
