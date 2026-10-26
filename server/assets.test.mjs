import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createKnowledgeServer } from './index.mjs';

test('a 221 MB attachment streams to disk, enforces references, and is removed with its last note', { timeout: 120_000 }, async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'zhiyu-asset-stream-'));
  const { server } = await createKnowledgeServer({ dataDir });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const registration = await fetch(`${base}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Attachment Owner', email: 'asset-owner@isolated.test', password: 'Valid-asset-test-password' }),
  });
  assert.equal(registration.status, 201);
  const cookie = registration.headers.get('set-cookie').split(';')[0];
  const assetId = 'streamed-large-fixture';
  const size = 221 * 1024 ** 2;
  const chunk = Buffer.alloc(1024 ** 2, 0x41);
  const response = await fetch(`${base}/api/assets/${assetId}`, {
    method: 'POST', duplex: 'half',
    headers: { Cookie: cookie, 'Content-Type': 'application/pdf', 'Content-Length': String(size), 'X-Asset-Path': encodeURIComponent('资料/大附件.pdf') },
    body: Readable.from((function* () { for (let i = 0; i < 221; i++) yield chunk; })()),
  });
  assert.equal(response.status, 201, await response.text());
  assert.equal((await stat(path.join(dataDir, 'assets', assetId))).size, size);
  assert.equal((await fetch(`${base}/api/assets/${assetId}`)).status, 404, 'unpublished attachments are private to their uploader');
  const note = {
    id: 'large-asset-note', title: 'Large asset test', content: `[查看附件](asset:${assetId})`,
    category: '工程', path: '工程/Large asset test.md', attachments: { '大附件.pdf': `asset:${assetId}` }, tags: [],
  };
  const create = await fetch(`${base}/api/notes/import`, {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ notes: [note] }),
  });
  assert.equal(create.status, 201, await create.text());
  const head = await fetch(`${base}/api/assets/${assetId}`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(Number(head.headers.get('content-length')), size);
  assert.match(head.headers.get('content-disposition'), /filename\*=UTF-8''/);
  const range = await fetch(`${base}/api/assets/${assetId}`, { headers: { Range: 'bytes=0-2' } });
  assert.equal(range.status, 206);
  assert.equal(await range.text(), 'AAA');
  const blocked = await fetch(`${base}/api/assets/${assetId}`, { method: 'DELETE', headers: { Cookie: cookie } });
  assert.equal(blocked.status, 409);
  const repeat = await fetch(`${base}/api/notes/import`, {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ notes: [{ ...note, title: 'Attempted import overwrite' }] }),
  });
  assert.equal(repeat.status, 201);
  const repeated = await repeat.json();
  assert.equal(repeated.notes[0].title, 'Attempted import overwrite', 'reimporting the same full path updates the document');
  assert.equal(repeated.notes[0].id, note.id, 'reimport preserves the stable ID');
  assert.equal(repeated.updatedCount, 1);
  assert.equal((await fetch(`${base}/api/assets/${assetId}`, { method: 'HEAD' })).status, 200);
  const deleted = await fetch(`${base}/api/notes/${note.id}`, { method: 'DELETE', headers: { Cookie: cookie } });
  assert.equal(deleted.status, 204);
  assert.equal((await fetch(`${base}/api/assets/${assetId}`)).status, 404);
  await assert.rejects(stat(path.join(dataDir, 'assets', assetId)), { code: 'ENOENT' });
});

test('Markdown examples are plain text while real links cannot reference another member’s unpublished asset', async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'zhiyu-asset-markdown-'));
  const { server } = await createKnowledgeServer({ dataDir });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const register = async (name) => {
    const response = await fetch(`${base}/api/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email: `${name}@isolated.test`, password: 'Valid-markdown-test-password' }),
    });
    assert.equal(response.status, 201);
    return response.headers.get('set-cookie').split(';')[0];
  };
  const alice = await register('markdown-alice');
  const bob = await register('markdown-bob');
  const uploaded = await fetch(`${base}/api/assets/private-asset`, {
    method: 'POST', headers: { Cookie: alice, 'Content-Type': 'image/svg+xml' }, body: '<svg xmlns="http://www.w3.org/2000/svg"/>',
  });
  assert.equal(uploaded.status, 201);
  let noteNumber = 0;
  const create = (content, cookie = bob, attachments) => fetch(`${base}/api/notes`, {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ note: { title: 'Markdown attachment boundaries', path: `Markdown fixtures/boundary-${++noteNumber}.md`, content, attachments } }),
  });
  const examples = await create('直接记录 asset:example。\n\n`![示例](asset:private-asset)`\n\n```md\n[代码](asset:private-asset)\n```\n\n    [缩进代码](asset:private-asset)\n\n[unused]: asset:private-asset');
  assert.equal(examples.status, 201, await examples.text());
  for (const content of [
    '![图片](asset:private-asset)',
    '[文件](<asset:private-asset>)',
    '[图片][private]\n\n[private]: asset:private-asset',
    '<asset:private-asset>',
    '[编码](a&#115;set:private-asset)',
  ]) {
    const response = await create(content);
    assert.equal(response.status, 403, `${content}: ${await response.text()}`);
  }
  const metadataAttempt = await create('没有正文引用', bob, { picture: 'asset:private-asset' });
  assert.equal(metadataAttempt.status, 403);
  const published = await create('![作者图片](asset:private-asset)', alice);
  assert.equal(published.status, 201);
  assert.equal((await create('![公开图片](asset:private-asset)')).status, 201);
});
