import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { createKnowledgeServer } from '../../server/index.mjs';

const moduleUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const transpile = source => ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;

test('clipboard image uploads retain original bytes, follow note permissions, and clean up abandoned drafts safely', async t => {
  // Run the actual browser helper against an isolated API. No production account
  // or attachment participates in this lifecycle test.
  const dataDir = await mkdtemp(path.join(tmpdir(), 'zhiyu-editor-images-'));
  const { server } = await createKnowledgeServer({ dataDir });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const nativeFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  globalThis.window = new EventTarget();
  let clientCookie = '';
  let cancelAfterCommit;
  let uploadedCount = 0;
  globalThis.fetch = async (input, init = {}) => {
    assert.equal(typeof input, 'string');
    assert.ok(input.startsWith('/api/'));
    const response = await nativeFetch(`${base}${input}`, {
      ...init, headers: { ...Object.fromEntries(new Headers(init.headers)), ...(clientCookie ? { Cookie: clientCookie } : {}) },
    });
    if (init.method === 'POST') {
      uploadedCount++;
      if (cancelAfterCommit) {
        assert.equal(init.signal, undefined, 'the server acknowledgement must arrive before a cancelled draft deletes its upload');
        cancelAfterCommit.abort();
      }
    }
    return response;
  };
  t.after(async () => {
    globalThis.fetch = nativeFetch;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    await new Promise(resolve => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  });

  const apiSource = transpile(await readFile(new URL('../../src/lib/api.ts', import.meta.url), 'utf8'));
  const imageSource = transpile(await readFile(new URL('../../src/lib/editorImages.ts', import.meta.url), 'utf8'))
    .replace(/(['"])\.\/api\1/g, JSON.stringify(moduleUrl(apiSource)));
  const { uploadEditorImage, deleteEditorImages } = await import(moduleUrl(imageSource));
  const register = async name => {
    const response = await nativeFetch(`${base}/api/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email: `${name}@isolated.test`, password: 'Editor-image-isolated-test-2026!' }),
    });
    assert.equal(response.status, 201);
    return response.headers.get('set-cookie').split(';')[0];
  };
  const alice = await register('editor-image-alice');
  const bob = await register('editor-image-bob');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==', 'base64');
  const image = new Blob([png], { type: 'image/png' });
  clientCookie = alice;

  await t.test('an uploaded image stays private until saved, and metadata is attached to the original note', async () => {
    const asset = await uploadEditorImage(image);
    assert.match(asset.id, /^editor-image-[a-f0-9-]+$/);
    assert.match(asset.path, /^附件\/粘贴图片-\d{8}-\d{6}-[a-f0-9-]+\.png$/);
    assert.equal(asset.reference, `asset:${asset.id}`);
    assert.equal(asset.size, png.length);
    assert.equal(asset.markdown, `![粘贴图片](asset:${asset.id})`);
    assert.equal((await nativeFetch(`${base}/api/assets/${asset.id}`)).status, 404);
    const preview = await nativeFetch(`${base}/api/assets/${asset.id}`, { headers: { Cookie: alice } });
    assert.equal(preview.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await preview.arrayBuffer()), png);

    const created = await nativeFetch(`${base}/api/notes`, {
      method: 'POST', headers: { Cookie: alice, 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: {
        title: '粘贴图片测试', path: '编辑器/粘贴图片测试.md', content: `# 原笔记\n\n${asset.markdown}`,
        attachments: { [asset.path]: asset.reference }, attachmentSizes: { [asset.reference]: 1 },
      } }),
    });
    assert.equal(created.status, 201, await created.clone().text());
    const { note } = await created.json();
    assert.equal(note.attachmentSizes[asset.reference], png.length, 'server metadata uses the actual upload size');
    assert.equal(note.attachments[asset.path], asset.reference);
    assert.equal((await nativeFetch(`${base}/api/assets/${asset.id}`)).status, 200);
    await assert.rejects(deleteEditorImages([asset]), error => error.status === 409 && error.code === 'ASSET_IN_USE');

    clientCookie = bob;
    await assert.rejects(deleteEditorImages([asset]), error => error.status === 403 && error.code === 'OWNER_REQUIRED');
    clientCookie = alice;
    const saved = await nativeFetch(`${base}/api/notes/${note.id}`);
    assert.equal((await saved.json()).note.content, note.content);
    assert.equal((await nativeFetch(`${base}/api/assets/${asset.id}`)).status, 200);
  });

  await t.test('cancelling after upload acknowledgement removes only the newly uploaded image', async () => {
    const before = (await readdir(path.join(dataDir, 'assets'))).sort();
    cancelAfterCommit = new AbortController();
    await assert.rejects(uploadEditorImage(image, { signal: cancelAfterCommit.signal }), { name: 'AbortError' });
    cancelAfterCommit = undefined;
    assert.deepEqual((await readdir(path.join(dataDir, 'assets'))).sort(), before);
    const unused = await uploadEditorImage(image);
    await deleteEditorImages([unused, unused]);
    assert.equal((await nativeFetch(`${base}/api/assets/${unused.id}`, { headers: { Cookie: alice } })).status, 404);
    assert.deepEqual((await readdir(path.join(dataDir, 'assets'))).sort(), before);
  });

  await t.test('empty, unsupported, disguised and previously cancelled images do not create uploads', async () => {
    const before = uploadedCount;
    await assert.rejects(uploadEditorImage(new Blob([], { type: 'image/png' })), /空文件/);
    await assert.rejects(uploadEditorImage(new Blob(['<svg/>'], { type: 'image/svg+xml' })), /PNG/);
    await assert.rejects(uploadEditorImage(new Blob(['<script>unsafe</script>'], { type: 'image/png' })), /损坏/);
    await assert.rejects(uploadEditorImage(new Blob([png], { type: 'image/jpeg' })), /损坏/);
    const cancelled = new AbortController();
    cancelled.abort();
    await assert.rejects(uploadEditorImage(image, { signal: cancelled.signal }), { name: 'AbortError' });
    assert.equal(uploadedCount, before);
  });

  await t.test('an expired session cannot upload and prompts the app to sign in', async () => {
    const before = (await readdir(path.join(dataDir, 'assets'))).sort();
    let expired = 0;
    window.addEventListener('session-expired', () => expired++);
    clientCookie = '';
    await assert.rejects(uploadEditorImage(image), error => error.status === 401);
    assert.ok(expired > 0);
    assert.deepEqual((await readdir(path.join(dataDir, 'assets'))).sort(), before);
  });
});
