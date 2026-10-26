import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createKnowledgeServer } from '../../server/index.mjs';

test('moving documents preserves stable links and assets while enforcing paths, revisions, and editing rights', async t => {
  // All accounts, files, and requests belong to this temporary local server.
  const dataDir = await mkdtemp(path.join(tmpdir(), 'zhiyu-document-moves-'));
  const { server } = await createKnowledgeServer({ dataDir });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const password = 'Isolated-document-moves-2026!';
  function actor() {
    let cookie = '';
    return async (route, method = 'GET', body) => {
      const response = await fetch(`${base}${route}`, {
        method,
        headers: { Origin: base, ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
      return { status: response.status, body: response.status === 204 ? null : await response.json(), cookie };
    };
  }
  const alice = actor();
  const bob = actor();
  const admin = actor();
  const aliceRegistration = await alice('/api/auth/register', 'POST', { name: 'Move Alice', email: 'move-alice@isolated.test', password });
  assert.equal(aliceRegistration.status, 201);
  assert.equal((await bob('/api/auth/register', 'POST', { name: 'Move Bob', email: 'move-bob@isolated.test', password })).status, 201);
  const setup = JSON.parse(await readFile(path.join(dataDir, 'admin-setup.json'), 'utf8'));
  assert.equal((await admin('/api/auth/activate-admin', 'POST', { token: setup.token, password })).status, 200);

  const picture = '<svg xmlns="http://www.w3.org/2000/svg"><text>move fixture</text></svg>';
  const upload = await fetch(`${base}/api/assets/move-picture`, {
    method: 'POST', headers: { Cookie: aliceRegistration.cookie, 'Content-Type': 'image/svg+xml', 'X-Asset-Path': encodeURIComponent('附件/图片.svg') }, body: picture,
  });
  assert.equal(upload.status, 201);
  const target = await bob('/api/notes', 'POST', { note: { id: 'move-link-target', title: '关联目标', content: '关联目标正文', path: '关联/目标.md', category: '关联' } });
  assert.equal(target.status, 201);
  const created = await alice('/api/notes', 'POST', { note: {
    id: 'move-source-note', title: '移动测试', content: '# 移动测试\n\n[关联笔记](#note/move-link-target)\n\n![图片](asset:move-picture)',
    path: '原位置/移动测试.md', category: '原位置', tags: ['稳定链接'],
    attachments: { '附件/图片.svg': 'asset:move-picture' },
  } });
  assert.equal(created.status, 201);
  let note = created.body.note;
  const inbound = await bob('/api/notes', 'POST', { note: {
    id: 'move-inbound-note', title: '反向链接', content: '[移动的笔记](#note/move-source-note)', path: '关联/反向链接.md', category: '关联',
  } });
  assert.equal(inbound.status, 201);

  await t.test('owner moves preserve identity, content, authorship, attachments, and incoming links', async () => {
    const original = note;
    const moved = await alice(`/api/notes/${note.id}`, 'PATCH', { note: { path: '新位置/多级目录/移动测试.md', category: '新位置' }, revision: note.revision });
    assert.equal(moved.status, 200);
    note = moved.body.note;
    assert.equal(note.path, '新位置/多级目录/移动测试.md');
    assert.equal(note.category, '新位置');
    for (const field of ['id', 'title', 'content', 'ownerId', 'ownerEmail', 'author', 'collaborative', 'tags', 'attachments', 'attachmentSizes']) {
      assert.deepEqual(note[field], original[field], `moving preserves ${field}`);
    }
    assert.equal(note.revision, original.revision + 1);
    assert.equal((await bob(`/api/notes/${inbound.body.note.id}`)).body.note.content, inbound.body.note.content);
    const asset = await fetch(`${base}/api/assets/move-picture`);
    assert.equal(asset.status, 200);
    assert.equal(await asset.text(), picture);
    assert.equal((await alice(`/api/notes/${note.id}`, 'PATCH', { note: { path: '过时/移动测试.md' }, revision: original.revision })).status, 409);
  });

  await t.test('duplicate normalized destination paths are rejected without changing any document', async () => {
    const collision = await bob('/api/notes', 'POST', { note: { id: 'move-existing-destination', title: '同名目标', content: '目标内容保持不变', category: '目标', path: '目标/Café.md' } });
    assert.equal(collision.status, 201);
    const original = note;
    const denied = await alice(`/api/notes/${note.id}`, 'PATCH', { note: { path: '目标\\.\\CAFE\u0301.md', category: '目标' }, revision: note.revision });
    assert.equal(denied.status, 409);
    assert.equal(denied.body.code, 'NOTE_PATH_EXISTS');
    const sourceAfter = (await alice(`/api/notes/${note.id}`)).body.note;
    assert.deepEqual(sourceAfter, original);
    assert.deepEqual((await bob('/api/notes/move-existing-destination')).body.note, collision.body.note);
  });

  await t.test('moving follows author and collaboration permissions, including revocation', async () => {
    const route = `/api/notes/${note.id}`;
    assert.equal((await bob(route, 'PATCH', { note: { path: '其他成员/移动测试.md', category: '其他成员' }, revision: note.revision })).status, 403);
    assert.equal((await admin(route, 'PATCH', { note: { path: '管理员/移动测试.md', category: '管理员' }, revision: note.revision })).status, 403);
    const shared = await admin(`${route}/sharing`, 'PATCH', { collaborative: true });
    assert.equal(shared.status, 200);
    const moved = await bob(route, 'PATCH', { note: { path: '移动测试.md', category: '未分类' }, revision: shared.body.note.revision });
    assert.equal(moved.status, 200);
    assert.equal(moved.body.note.path, '移动测试.md');
    assert.equal(moved.body.note.category, '未分类');
    assert.equal(moved.body.note.ownerId, aliceRegistration.body.user.id);
    assert.equal(moved.body.note.content, note.content);
    const revoked = await admin(`${route}/sharing`, 'PATCH', { collaborative: false });
    assert.equal(revoked.status, 200);
    assert.equal((await bob(route, 'PATCH', { note: { path: '撤销后/移动测试.md' }, revision: revoked.body.note.revision })).status, 403);
    assert.equal((await alice(route)).body.note.path, '移动测试.md');
  });
});
