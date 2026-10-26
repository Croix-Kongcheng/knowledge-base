import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../../', import.meta.url));
const password = 'Isolated-permissions-test-2026!';

async function availablePort() {
  const listener = createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const address = listener.address();
  await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  return address.port;
}

async function startServer(dataDir, port) {
  let output = '';
  const process = spawn(globalThis.process.execPath, ['server/index.mjs'], {
    cwd: root,
    env: { ...globalThis.process.env, HOST: '127.0.0.1', PORT: String(port), DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [process.stdout, process.stderr]) stream.on('data', value => { output += value.toString(); });
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 150; attempt++) {
    if (process.exitCode !== null) throw new Error(`Isolated server exited (${process.exitCode}): ${output}`);
    try {
      if ((await fetch(`${base}/api/session`)).ok) return { process, base };
    } catch { /* Wait for this isolated process to start listening. */ }
    await delay(200);
  }
  process.kill('SIGTERM');
  throw new Error(`Isolated server did not start: ${output}`);
}

async function stopServer(server) {
  if (!server || server.process.exitCode !== null) return;
  const exited = once(server.process, 'exit');
  server.process.kill('SIGTERM');
  await exited;
}

function client(base) {
  let cookie = '';
  return {
    async request(route, { method = 'GET', body, headers = {} } = {}) {
      const response = await fetch(`${base}${route}`, {
        method,
        headers: {
          Origin: base,
          ...(cookie ? { Cookie: cookie } : {}),
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...headers,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const nextCookie = response.headers.get('set-cookie');
      if (nextCookie) cookie = nextCookie.split(';')[0];
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers };
    },
  };
}

test('server enforces ownership, administrator sharing, and durable CRUD across separate accounts', { timeout: 120_000 }, async t => {
  // Every account and document created here lives under an automatically removed
  // temporary DATA_DIR. This test never contacts the deployed service or real DB.
  const dataDir = await mkdtemp(path.join(tmpdir(), 'zhiyu-permissions-'));
  const port = await availablePort();
  let server;
  t.after(async () => { await stopServer(server); await rm(dataDir, { recursive: true, force: true }); });
  server = await startServer(dataDir, port);
  const guest = client(server.base);
  const alice = client(server.base);
  const bob = client(server.base);
  const admin = client(server.base);
  let aliceUser;
  let bobUser;
  let note;

  await t.test('anonymous visitors can read but cannot create, and administrator registration is reserved', async () => {
    assert.equal((await guest.request('/api/session')).body.user, null);
    assert.deepEqual((await guest.request('/api/notes')).body.notes, []);
    assert.equal((await guest.request('/api/notes', { method: 'POST', body: { note: { title: 'Guest injection', content: 'forbidden' } } })).status, 401);
    const reserved = await guest.request('/api/auth/register', { method: 'POST', body: { name: 'Impostor', email: 'admin@example.com', password } });
    assert.equal(reserved.status, 409);
    assert.equal((await guest.request('/api/session')).body.user, null);
  });

  await t.test('password authentication creates separate ordinary members and activates the administrator once', async () => {
    for (const [actor, name, email] of [[alice, 'Alice', 'alice@isolated.test'], [bob, 'Bob', 'bob@isolated.test']]) {
      const response = await actor.request('/api/auth/register', { method: 'POST', body: { name, email, password, role: 'admin' } });
      assert.ok([200, 201].includes(response.status), JSON.stringify(response.body));
      assert.equal(response.body.user.role, 'member');
      if (name === 'Alice') aliceUser = response.body.user;
      else bobUser = response.body.user;
    }
    const setup = JSON.parse(await readFile(path.join(dataDir, 'admin-setup.json'), 'utf8'));
    assert.ok(setup.token);
    const activated = await admin.request('/api/auth/activate-admin', { method: 'POST', body: { token: setup.token, password } });
    assert.ok([200, 201].includes(activated.status), JSON.stringify(activated.body));
    assert.equal(activated.body.user.role, 'admin');
    assert.equal(activated.body.user.email, 'admin@example.com');
    const reused = await guest.request('/api/auth/activate-admin', { method: 'POST', body: { token: setup.token, password } });
    assert.ok(reused.status >= 400);
    assert.equal((await guest.request('/api/auth/login', { method: 'POST', body: { email: aliceUser.email, password: 'incorrect-password' } })).status, 401);
  });

  await t.test('new notes belong to their authenticated author and default to owner editing only', async () => {
    const created = await alice.request('/api/notes', { method: 'POST', body: { note: {
      id: 'permission-owned-note', title: 'Alice 项目知识', content: '# Alice 项目知识\n\n检索关键词：杏树实验。',
      category: '工程/项目', path: '工程/项目/Alice 项目知识.md', tags: ['权限', '正式功能'],
      ownerId: bobUser.id, ownerEmail: bobUser.email, author: 'Spoofed author', collaborative: true,
    } } });
    assert.ok([200, 201].includes(created.status), JSON.stringify(created.body));
    note = created.body.note;
    assert.equal(note.ownerId, aliceUser.id);
    assert.equal(note.ownerEmail, aliceUser.email);
    assert.equal(note.author, aliceUser.name);
    assert.equal(note.collaborative, false);
    assert.equal((await bob.request('/api/notes')).body.notes.find(value => value.id === note.id).content, note.content);
    const edited = await alice.request(`/api/notes/${note.id}`, { method: 'PATCH', body: { note: { title: 'Alice 更新知识', content: '# Alice 更新知识\n\n杏树实验已更新。', category: '工程/已整理', path: '工程/已整理/Alice 更新知识.md' }, revision: note.revision } });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    note = edited.body.note;
    assert.equal(note.category, '工程/已整理');
    assert.equal(note.path, '工程/已整理/Alice 更新知识.md');
    assert.equal(note.author, 'Alice');
  });

  await t.test('other members and the administrator cannot alter or delete a private-editing note', async () => {
    for (const actor of [guest, bob, admin]) {
      const expected = actor === guest ? 401 : 403;
      assert.equal((await actor.request(`/api/notes/${note.id}`, { method: 'PATCH', body: { note: { title: 'Blocked title', content: 'Blocked content', category: 'Blocked category', path: 'Blocked/path.md', ownerId: bobUser.id }, revision: note.revision } })).status, expected);
      assert.equal((await actor.request(`/api/notes/${note.id}`, { method: 'DELETE' })).status, expected);
    }
    assert.equal((await bob.request(`/api/notes/${note.id}/sharing`, { method: 'PATCH', body: { collaborative: true } })).status, 403);
    assert.equal((await alice.request(`/api/notes/${note.id}/sharing`, { method: 'PATCH', body: { collaborative: true } })).status, 403);
    const persisted = (await guest.request('/api/notes')).body.notes.find(value => value.id === note.id);
    assert.equal(persisted.title, note.title);
    assert.equal(persisted.category, note.category);
    assert.equal(persisted.ownerId, aliceUser.id);
  });

  await t.test('bulk import cannot overwrite another author or forge ownership and collaboration', async () => {
    const collision = await bob.request('/api/notes/import', { method: 'POST', body: { notes: [{ ...note, content: 'Import overwrite attempt' }] } });
    assert.equal(collision.status, 403, JSON.stringify(collision.body));
    assert.equal(collision.body.code, 'NOTE_READ_ONLY');
    assert.equal((await guest.request('/api/notes')).body.notes.find(value => value.id === note.id).content, note.content);
    const imported = await bob.request('/api/notes/import', { method: 'POST', body: { notes: [{
      id: 'bob-import-permission-test', title: 'Bob 导入知识', content: '# Bob 导入知识',
      category: '导入', path: '导入/Bob 导入知识.md', tags: [],
      ownerId: aliceUser.id, ownerEmail: aliceUser.email, author: 'Alice', collaborative: true,
    }] } });
    assert.ok([200, 201].includes(imported.status), JSON.stringify(imported.body));
    assert.equal(imported.body.notes.length, 1);
    assert.equal(imported.body.notes[0].ownerId, bobUser.id);
    assert.equal(imported.body.notes[0].ownerEmail, bobUser.email);
    assert.equal(imported.body.notes[0].author, 'Bob');
    assert.equal(imported.body.notes[0].collaborative, false);
    assert.equal((await bob.request('/api/notes/bob-import-permission-test', { method: 'DELETE' })).status, 204);
  });

  await t.test('administrator collaboration enables member edits while preserving ownership and protecting deletion', async () => {
    const shared = await admin.request(`/api/notes/${note.id}/sharing`, { method: 'PATCH', body: { collaborative: true } });
    assert.equal(shared.status, 200, JSON.stringify(shared.body));
    note = shared.body.note;
    assert.equal(note.collaborative, true);
    const previousRevision = note.revision;
    const edited = await bob.request(`/api/notes/${note.id}`, { method: 'PATCH', body: { note: { content: '# Alice 更新知识\n\nBob 补充了可共同编辑的杏树实验。' }, revision: note.revision } });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    note = edited.body.note;
    assert.match(note.content, /Bob 补充/);
    assert.equal(note.ownerId, aliceUser.id);
    assert.equal(note.ownerEmail, aliceUser.email);
    assert.equal(note.author, 'Alice');
    assert.equal(note.collaborative, true);
    assert.equal((await bob.request(`/api/notes/${note.id}`, { method: 'DELETE' })).status, 403);
    assert.equal((await bob.request(`/api/notes/${note.id}`, { method: 'PATCH', body: { note: { content: 'Stale overwrite' }, revision: previousRevision } })).status, 409);
  });

  await t.test('revoking collaboration rejects an already authenticated editor immediately', async () => {
    const revoked = await admin.request(`/api/notes/${note.id}/sharing`, { method: 'PATCH', body: { collaborative: false } });
    assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
    note = revoked.body.note;
    assert.equal(note.collaborative, false);
    assert.equal((await bob.request(`/api/notes/${note.id}`, { method: 'PATCH', body: { note: { content: 'Revoked overwrite' }, revision: note.revision } })).status, 403);
    assert.equal((await guest.request('/api/notes')).body.notes.find(value => value.id === note.id).content, note.content);
  });

  await t.test('notes and account passwords survive process restart and only the owner can delete', async () => {
    await stopServer(server);
    server = await startServer(dataDir, port);
    const reader = client(server.base);
    const durable = (await reader.request('/api/notes')).body.notes.find(value => value.id === note.id);
    assert.equal(durable.content, note.content);
    assert.equal(durable.ownerEmail, aliceUser.email);
    assert.equal(durable.collaborative, false);
    assert.equal((await reader.request('/api/auth/login', { method: 'POST', body: { email: aliceUser.email, password } })).status, 200);
    const deleted = await reader.request(`/api/notes/${note.id}`, { method: 'DELETE', body: { revision: durable.revision } });
    assert.equal(deleted.status, 204, JSON.stringify(deleted.body));
    assert.ok(!(await reader.request('/api/notes')).body.notes.some(value => value.id === note.id));
    await stopServer(server);
    server = await startServer(dataDir, port);
    assert.ok(!(await client(server.base).request('/api/notes')).body.notes.some(value => value.id === note.id));
  });
});
