import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import test from 'node:test';
import { createKnowledgeServer } from '../../server/index.mjs';

test('lightweight directory loading, conditional reads, compression, search and backlinks preserve existing note semantics', { timeout: 90_000 }, async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'zhiyu-lightweight-loading-'));
  const distDir = path.join(dataDir, 'ui');
  await mkdir(path.join(distDir, 'assets'), { recursive: true });
  const html = `<html><body>${'initial application shell '.repeat(180)}</body></html>`;
  const script = `export const app = ${JSON.stringify('fixture JavaScript '.repeat(3000))};`;
  await writeFile(path.join(distDir, 'index.html'), html);
  await writeFile(path.join(distDir, 'assets', 'app-A1b2C3d4.js'), script);
  await writeFile(path.join(distDir, 'assets', 'editor.css'), '.reader {color: purple}\n'.repeat(100));
  const { server, databasePath } = await createKnowledgeServer({ dataDir, distDir });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const password = 'Isolated-directory-loading-password-2026!';
  let cookie = '';
  const request = async (route, method = 'GET', body, headers = {}) => {
    const response = await fetch(`${base}${route}`, { method,
      headers: { Origin: base, ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body) });
    if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    return response;
  };
  const raw = (route, headers = {}, method = 'GET') => new Promise((resolve, reject) => {
    const outgoing = http.request(`${base}${route}`, { method, headers }, incoming => {
      const chunks = [];
      incoming.on('data', chunk => chunks.push(chunk));
      incoming.on('end', () => resolve({ status: incoming.statusCode, headers: incoming.headers, body: Buffer.concat(chunks) }));
      incoming.on('error', reject);
    });
    outgoing.on('error', reject); outgoing.end();
  });
  const registered = await request('/api/auth/register', 'POST', { name: 'Loading Owner', email: 'loading-owner@isolated.test', password });
  assert.equal(registered.status, 201);
  const user = (await registered.json()).user;
  const picture = '<svg xmlns="http://www.w3.org/2000/svg"><text>shared picture fixture</text></svg>';
  assert.equal((await fetch(`${base}/api/assets/loading-picture`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'image/svg+xml' }, body: picture })).status, 201);
  const ids = Array.from({ length: 40 }, () => randomUUID());
  const fixtures = ids.map((id, index) => ({ id, title: `编号文档 ${index}`, path: `目录/${index}.md`, category: '目录',
    content: `# 编号文档 ${index}\n\n${'正文与排版 fixture paragraph '.repeat(1600)}\n\nFULL-BODY-ONLY-MARKER-${index}\n\n![共享图](asset:loading-picture)`,
    tags: index === 20 ? ['tag-special'] : ['普通标签'], color: 'purple',
    attachments: { '图片.svg': 'asset:loading-picture', '图片别名.svg': 'asset:loading-picture' } }));
  fixtures[0].content += `\n\n[自己](#note/${ids[0]}) [[编号文档 0]]`;
  fixtures[1].content += `\n\n[目标](#note/${ids[0]})`;
  fixtures[2].content += '\n\n[[编号文档 0|标题别名]]';
  fixtures[3].content += '\n\n[[目录/0.md#节标题|路径别名]]';
  fixtures[4].content += '\n\n[[目录/0#节标题]]';
  const imported = await request('/api/notes/import', 'POST', { notes: fixtures });
  assert.equal(imported.status, 201);
  const full = (await request('/api/notes')).clone();
  const fullBuffer = Buffer.from(await full.arrayBuffer());
  const fullNotes = JSON.parse(fullBuffer).notes;
  let initialIndex, initialDetail;

  await t.test('directory excludes full bodies and attachment maps while reporting real deduplicated counts and byte sizes', async () => {
    initialIndex = await raw('/api/notes/index');
    assert.equal(initialIndex.status, 200);
    const index = JSON.parse(initialIndex.body);
    assert.equal(index.notes.length, 40);
    assert.ok(initialIndex.body.length < fullBuffer.length / 10);
    assert.ok(!initialIndex.body.includes(Buffer.from('FULL-BODY-ONLY-MARKER')));
    assert.deepEqual(index.totals, { notes: 40, attachments: 1, contentBytes: fixtures.reduce((sum, note) => sum + Buffer.byteLength(note.content), 0), attachmentBytes: Buffer.byteLength(picture) });
    for (const note of index.notes) {
      assert.ok(!Object.hasOwn(note, 'content'));
      assert.ok(!Object.hasOwn(note, 'attachments'));
      assert.ok(!Object.hasOwn(note, 'attachmentSizes'));
      assert.equal(note.ownerId, user.id);
      assert.equal(note.revision, 1);
      assert.equal(note.attachmentCount, 1);
      assert.equal(note.attachmentBytes, Buffer.byteLength(picture));
      assert.ok(note.excerpt.length <= 120);
      const original = fullNotes.find(value => value.id === note.id);
      for (const field of ['id', 'title', 'category', 'path', 'author', 'avatar', 'color', 'ownerId', 'ownerEmail', 'collaborative', 'revision', 'updatedAt', 'tags']) assert.deepEqual(note[field], original[field]);
      assert.equal(note.contentBytes, Buffer.byteLength(original.content));
    }
    initialDetail = await raw(`/api/notes/${ids[0]}`);
    assert.deepEqual(JSON.parse(initialDetail.body).note, fullNotes.find(note => note.id === ids[0]));
  });

  await t.test('index and detail use private ETags while sessions and the legacy full-library route remain no-store', async () => {
    for (const [route, prior] of [['/api/notes/index', initialIndex], [`/api/notes/${ids[0]}`, initialDetail]]) {
      assert.equal(prior.headers['cache-control'], 'private, no-cache');
      assert.match(prior.headers.etag, /^W\/"/);
      const unchanged = await raw(route, { 'If-None-Match': prior.headers.etag, 'Accept-Encoding': 'br, gzip' });
      assert.equal(unchanged.status, 304);
      assert.equal(unchanged.body.length, 0);
      assert.equal(unchanged.headers.etag, prior.headers.etag);
      assert.match(unchanged.headers.vary, /Accept-Encoding/);
    }
    for (const route of ['/api/session', '/api/notes']) {
      const response = await raw(route, { 'If-None-Match': '*' });
      assert.equal(response.status, 200);
      assert.equal(response.headers['cache-control'], 'no-store');
      assert.equal(response.headers.etag, undefined);
    }
    assert.equal((await raw('/api/notes/missing-document')).status, 404);
  });

  await t.test('JSON negotiates gzip and Brotli correctly, including q=0, exact payloads, and HEAD lengths', async () => {
    const gzip = await raw('/api/notes/index', { 'Accept-Encoding': 'gzip' });
    const br = await raw('/api/notes/index', { 'Accept-Encoding': 'br' });
    assert.equal(gzip.headers['content-encoding'], 'gzip');
    assert.equal(br.headers['content-encoding'], 'br');
    assert.deepEqual(gunzipSync(gzip.body), initialIndex.body);
    assert.deepEqual(brotliDecompressSync(br.body), initialIndex.body);
    assert.ok(gzip.body.length < initialIndex.body.length / 2);
    assert.ok(br.body.length < initialIndex.body.length / 2);
    assert.equal(Number(gzip.headers['content-length']), gzip.body.length);
    const noEncoding = await raw('/api/notes/index', { 'Accept-Encoding': 'gzip;q=0, br;q=0' });
    assert.equal(noEncoding.headers['content-encoding'], undefined);
    assert.deepEqual(noEncoding.body, initialIndex.body);
    assert.equal((await raw('/api/notes/index', { 'Accept-Encoding': 'gzip;q=0.9, br;q=0.2' })).headers['content-encoding'], 'gzip');
    const head = await raw('/api/notes/index', { 'Accept-Encoding': 'gzip' }, 'HEAD');
    assert.equal(head.status, 200);
    assert.equal(head.body.length, 0);
    assert.equal(Number(head.headers['content-length']), gzip.body.length);
    const legacy = await raw('/api/notes', { 'Accept-Encoding': 'gzip' });
    assert.equal(legacy.headers['content-encoding'], 'gzip');
    assert.deepEqual(gunzipSync(legacy.body), fullBuffer);
  });

  await t.test('server-side substring searches and backlinks match previous client semantics without returning source bodies', async () => {
    for (const query of ['', 'FULL-body-only-marker-20', 'TAG-SPECIAL', 'loading owner', '编号文档 7', 'nonexistent phrase']) {
      const response = await raw(`/api/notes/search?q=${encodeURIComponent(query)}`);
      const expected = fullNotes.filter(note => `${note.title} ${note.content} ${note.tags.join(' ')} ${note.author}`.toLowerCase().includes(query.toLowerCase())).map(note => note.id);
      assert.deepEqual(JSON.parse(response.body), { ids: expected });
      assert.equal((await raw(`/api/notes/search?q=${encodeURIComponent(query)}`, { 'If-None-Match': response.headers.etag })).status, 304);
    }
    const backlinks = await raw(`/api/notes/${ids[0]}/backlinks`);
    assert.deepEqual(new Set(JSON.parse(backlinks.body).ids), new Set(ids.slice(1, 5)));
    assert.deepEqual(Object.keys(JSON.parse(backlinks.body)), ['ids']);
    assert.equal((await raw(`/api/notes/${ids[0]}/backlinks`, { 'If-None-Match': backlinks.headers.etag })).status, 304);
    assert.equal((await raw('/api/notes/missing-document/backlinks')).status, 404);
  });

  await t.test('profile, content, collaboration and external SQLite writes invalidate cached representations', async () => {
    assert.equal((await request('/api/profile', 'PATCH', { name: 'Renamed Loading Owner' })).status, 200);
    const renamed = await raw('/api/notes/index', { 'If-None-Match': initialIndex.headers.etag });
    assert.equal(renamed.status, 200);
    assert.notEqual(renamed.headers.etag, initialIndex.headers.etag);
    assert.ok(JSON.parse(renamed.body).notes.every(note => note.author === 'Renamed Loading Owner'));
    const renamedDetail = await raw(`/api/notes/${ids[0]}`, { 'If-None-Match': initialDetail.headers.etag });
    assert.equal(renamedDetail.status, 200);
    assert.equal(JSON.parse(renamedDetail.body).note.author, 'Renamed Loading Owner');
    assert.equal(JSON.parse((await raw('/api/notes/search?q=renamed')).body).ids.length, 40);
    const note = JSON.parse(renamedDetail.body).note;
    const edited = await request(`/api/notes/${note.id}`, 'PATCH', { note: { content: '# Updated content\n\nNEW-BODY-SEARCH-TERM' }, revision: note.revision });
    assert.equal(edited.status, 200);
    assert.equal((await raw(`/api/notes/${note.id}`, { 'If-None-Match': renamedDetail.headers.etag })).status, 200);
    assert.deepEqual(JSON.parse((await raw('/api/notes/search?q=new-body-search-term')).body).ids, [note.id]);
    const setup = JSON.parse(await readFile(path.join(dataDir, 'admin-setup.json'), 'utf8'));
    const activation = await request('/api/auth/activate-admin', 'POST', { token: setup.token, password });
    assert.equal(activation.status, 200);
    const beforeSharing = await raw('/api/notes/index');
    const beforeSharingDetail = await raw(`/api/notes/${note.id}`);
    assert.equal((await request(`/api/notes/${note.id}/sharing`, 'PATCH', { collaborative: true })).status, 200);
    const afterSharing = await raw('/api/notes/index', { 'If-None-Match': beforeSharing.headers.etag });
    assert.equal(afterSharing.status, 200);
    assert.equal(JSON.parse(afterSharing.body).notes.find(value => value.id === note.id).collaborative, true);
    assert.equal((await raw(`/api/notes/${note.id}`, { 'If-None-Match': beforeSharingDetail.headers.etag })).status, 200);
    const external = new DatabaseSync(databasePath);
    external.prepare("UPDATE notes SET data=json_set(data,'$.title',?),revision=revision+1 WHERE id=?").run('Externally restored numbered title', note.id);
    external.close();
    const externalChange = await raw('/api/notes/index', { 'If-None-Match': afterSharing.headers.etag });
    assert.equal(externalChange.status, 200);
    assert.equal(JSON.parse(externalChange.body).notes.find(value => value.id === note.id).title, 'Externally restored numbered title');
    assert.deepEqual(JSON.parse((await raw('/api/notes/search?q=externally%20restored')).body).ids, [note.id]);
    const latest = JSON.parse((await raw(`/api/notes/${note.id}`)).body).note;
    assert.equal((await request(`/api/notes/${note.id}`, 'PATCH', { note: { content: 'Stale overwrite' }, revision: latest.revision - 1 })).status, 409);
  });

  await t.test('static hashed files cache immutably, HTML revalidates, and compression preserves binary ranges and asset isolation', async () => {
    const compressed = await raw('/assets/app-A1b2C3d4.js', { 'Accept-Encoding': 'br, gzip' });
    assert.equal(compressed.headers['cache-control'], 'public, max-age=31536000, immutable');
    assert.equal(compressed.headers['content-encoding'], 'br');
    assert.equal(brotliDecompressSync(compressed.body).toString(), script);
    assert.equal((await raw('/assets/app-A1b2C3d4.js', { 'If-None-Match': compressed.headers.etag })).status, 304);
    const range = await raw('/assets/app-A1b2C3d4.js', { Range: 'bytes=0-9', 'Accept-Encoding': 'gzip' });
    assert.equal(range.status, 206);
    assert.equal(range.headers['content-encoding'], undefined);
    assert.equal(range.body.toString(), script.slice(0, 10));
    const initialHtml = await raw('/', { 'Accept-Encoding': 'gzip' });
    assert.equal(initialHtml.headers['cache-control'], 'no-cache');
    assert.equal(gunzipSync(initialHtml.body).toString(), html);
    assert.equal((await raw('/', { 'If-None-Match': initialHtml.headers.etag })).status, 304);
    await writeFile(path.join(distDir, 'index.html'), `${html}\n<!-- new release -->`);
    assert.equal((await raw('/', { 'If-None-Match': initialHtml.headers.etag })).status, 200);
    assert.equal((await raw('/assets/editor.css')).headers['cache-control'], 'no-cache');
    const asset = await raw('/api/assets/loading-picture', { 'Accept-Encoding': 'gzip' });
    assert.equal(asset.headers['cache-control'], 'private, no-cache');
    assert.equal(asset.headers['content-encoding'], undefined);
    assert.match(asset.headers['content-security-policy'], /sandbox/);
    assert.equal(asset.body.toString(), picture);
    const assetRange = await raw('/api/assets/loading-picture', { Range: 'bytes=0-3' });
    assert.equal(assetRange.status, 206);
    assert.equal(assetRange.body.toString(), picture.slice(0, 4));
  });
});
