import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createKnowledgeServer } from '../../server/index.mjs';

test('display names can be changed only by their own account without changing identity or document permissions', async t => {
  // This temporary local database never uses the deployed service or real users.
  const dataDir = await mkdtemp(path.join(tmpdir(), 'zhiyu-self-profile-'));
  let server;
  let base;
  const start = async () => {
    ({ server } = await createKnowledgeServer({ dataDir }));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
  };
  const stop = () => new Promise(resolve => server.close(resolve));
  t.after(async () => {
    if (server?.listening) await stop();
    await rm(dataDir, { recursive: true, force: true });
  });
  await start();
  const password = 'Isolated-self-profile-2026!';
  const actor = () => {
    let cookie = '';
    return async (route, method = 'GET', body) => {
      const response = await fetch(`${base}${route}`, {
        method,
        headers: { Origin: base, ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
      return { status: response.status, body: response.status === 204 ? null : await response.json() };
    };
  };
  const guest = actor();
  const alice = actor();
  const bob = actor();
  const admin = actor();
  const aliceUser = (await alice('/api/auth/register', 'POST', { name: 'example_member', email: 'self-alice@isolated.test', password })).body.user;
  const bobUser = (await bob('/api/auth/register', 'POST', { name: 'Profile Bob', email: 'self-bob@isolated.test', password })).body.user;
  const setup = JSON.parse(await readFile(path.join(dataDir, 'admin-setup.json'), 'utf8'));
  const adminUser = (await admin('/api/auth/activate-admin', 'POST', { token: setup.token, password })).body.user;
  const original = (await alice('/api/notes', 'POST', { note: { id: 'self-profile-note', title: '改名前创建的文档', content: '# 原有正文\n\n保持文档内容及访问权限。', path: '测试/改名前创建的文档.md', category: '测试' } })).body.note;

  await t.test('the authenticated user updates only their own name and all existing author displays follow it', async () => {
    assert.equal((await guest('/api/profile', 'PATCH', { name: 'Guest attempt' })).status, 401);
    const updated = await alice('/api/profile', 'PATCH', { name: '  测试成员  ' });
    assert.equal(updated.status, 200);
    assert.deepEqual(updated.body.user, { ...aliceUser, name: '测试成员' });
    assert.deepEqual((await alice('/api/session')).body.user, updated.body.user);
    const members = (await guest('/api/members')).body.members;
    const member = members.find(value => value.id === aliceUser.id);
    assert.equal(member.name, '测试成员');
    assert.equal(member.initial, '员');
    assert.equal(members.find(value => value.id === bobUser.id).name, bobUser.name);
    const note = (await guest(`/api/notes/${original.id}`)).body.note;
    assert.deepEqual(note, { ...original, author: '测试成员', avatar: '员' });
    assert.deepEqual((await guest('/api/notes')).body.notes.find(value => value.id === note.id), note);
    assert.equal((await bob(`/api/notes/${note.id}`, 'PATCH', { note: { content: 'Forbidden' }, revision: note.revision })).status, 403);
    assert.equal((await admin(`/api/notes/${note.id}`, 'PATCH', { note: { content: 'Forbidden' }, revision: note.revision })).status, 403);
    assert.equal((await bob(`/api/notes/${note.id}`, 'DELETE')).status, 403);
  });

  await t.test('identity, email, role, and another account cannot be supplied even by an administrator', async () => {
    for (const account of [alice, bob, admin]) {
      for (const field of ['id', 'userId', 'email', 'role', 'ownerId', 'user']) {
        const result = await account('/api/profile', 'PATCH', { name: 'Blocked rename', [field]: field === 'role' ? 'admin' : aliceUser.id });
        assert.equal(result.status, 400, `reject profile field ${field}`);
        assert.equal(result.body.code, 'INVALID_PROFILE');
      }
      assert.equal((await account(`/api/profile/${aliceUser.id}`, 'PATCH', { name: 'Blocked target' })).status, 404);
      assert.equal((await account(`/api/users/${aliceUser.id}`, 'PATCH', { name: 'Blocked target' })).status, 404);
    }
    assert.deepEqual((await alice('/api/session')).body.user, { ...aliceUser, name: '测试成员' });
    assert.deepEqual((await bob('/api/session')).body.user, bobUser);
    assert.deepEqual((await admin('/api/session')).body.user, adminUser);
    const adminUpdated = await admin('/api/profile', 'PATCH', { name: '管理员本人新名称' });
    assert.deepEqual(adminUpdated.body.user, { ...adminUser, name: '管理员本人新名称' });
    assert.equal((await alice('/api/session')).body.user.name, '测试成员');
  });

  await t.test('name validation rejects empty, overlong, controls and unexpected values and normalizes NFC', async () => {
    for (const name of ['', '   ', '名'.repeat(31), 'Name\nBreak', '\nName', 'Name\tBreak', 'Name\u0000Break', 'Name\u007fBreak', 'Name\u2028Break', 'Name\u200eBreak', null, 123, {}, []]) {
      const rejected = await alice('/api/profile', 'PATCH', { name });
      assert.equal(rejected.status, 400, `reject invalid name ${JSON.stringify(name)}`);
      assert.equal(rejected.body.code, 'INVALID_PROFILE');
    }
    for (const body of [{}, { nickname: 'Missing name' }, { name: 'Valid', extra: true }]) {
      assert.equal((await alice('/api/profile', 'PATCH', body)).status, 400);
    }
    const maximum = await alice('/api/profile', 'PATCH', { name: '名'.repeat(30) });
    assert.equal(maximum.status, 200);
    const normalized = await alice('/api/profile', 'PATCH', { name: ' Cafe\u0301 ' });
    assert.equal(normalized.status, 200);
    assert.equal(normalized.body.user.name, 'Café');
    assert.equal((await alice('/api/profile', 'PATCH', { name: '测试成员' })).status, 200);
  });

  await t.test('name survives logout, login and server restart while ownership and password stay stable', async () => {
    assert.equal((await alice('/api/auth/logout', 'POST')).status, 204);
    assert.equal((await alice('/api/profile', 'PATCH', { name: 'Logged out attempt' })).status, 401);
    const login = await alice('/api/auth/login', 'POST', { email: aliceUser.email, password });
    assert.deepEqual(login.body.user, { ...aliceUser, name: '测试成员' });
    await stop();
    await start();
    const durable = (await alice('/api/session')).body.user;
    assert.deepEqual(durable, login.body.user);
    const reconnected = actor();
    assert.deepEqual((await reconnected('/api/auth/login', 'POST', { email: aliceUser.email, password })).body.user, durable);
    const note = (await reconnected(`/api/notes/${original.id}`)).body.note;
    assert.deepEqual(note, { ...original, author: '测试成员', avatar: '员' });
    const edited = await reconnected(`/api/notes/${note.id}`, 'PATCH', { note: { content: '# 持久化身份仍有作者编辑权限' }, revision: note.revision });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.note.ownerId, aliceUser.id);
    assert.equal(edited.body.note.ownerEmail, aliceUser.email);
    assert.equal(edited.body.note.author, '测试成员');
    assert.equal(edited.body.note.collaborative, false);
    const stillBob = (await bob('/api/session')).body.user;
    assert.deepEqual(stillBob, bobUser);
    assert.equal((await bob(`/api/notes/${note.id}`, 'DELETE')).status, 403);
  });
});
