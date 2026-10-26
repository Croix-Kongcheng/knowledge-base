import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';
import { deflateSync } from 'node:zlib';
import test from 'node:test';
import { createKnowledgeServer } from '../../server/index.mjs';

function pngChunk(type, data = Buffer.alloc(0)) {
  const bytes = Buffer.concat([Buffer.from(type), data]);
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length);
  bytes.copy(result, 4);
  result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4);
  return result;
}

function png(width = 16, height = 16, options = {}) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = options.depth ?? 8; header[9] = options.color ?? 6;
  header[10] = options.compression ?? 0;
  const pixels = Buffer.alloc((width * 4 + 1) * height, options.shade ?? 80);
  for (let row = 0; row < height; row++) pixels[row * (width * 4 + 1)] = options.filter ?? 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', header),
    ...(options.extra ? [options.extra] : []), pngChunk('IDAT', options.data ?? deflateSync(pixels)), pngChunk('IEND')]);
}

test('self-service avatars validate PNG uploads, persist independently and invalidate author/member representations', async t => {
  // All accounts, uploads and requests use this temporary local database.
  const dataDir = await mkdtemp(path.join(tmpdir(), 'zhiyu-self-avatars-'));
  let server, base;
  const start = async () => {
    ({ server } = await createKnowledgeServer({ dataDir }));
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
  };
  const stop = () => new Promise(resolve => server.close(resolve));
  t.after(async () => { if (server?.listening) await stop(); await rm(dataDir, { recursive: true, force: true }); });
  await start();
  const actor = () => {
    let cookie = '';
    return async (route, method = 'GET', body, headers = {}) => {
      const binary = Buffer.isBuffer(body) || body instanceof Readable;
      const response = await fetch(`${base}${route}`, { method,
        headers: { Origin: base, ...(cookie ? { Cookie: cookie } : {}),
          ...(body === undefined ? {} : { 'Content-Type': binary ? 'image/png' : 'application/json' }), ...headers },
        body: body === undefined ? undefined : binary ? body : JSON.stringify(body),
        ...(body instanceof Readable ? { duplex: 'half' } : {}),
      });
      if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
      return { status: response.status, headers: response.headers, cookie,
        body: [204, 304].includes(response.status) ? null : await response.json() };
    };
  };
  const alice = actor(), bob = actor(), admin = actor(), guest = actor();
  const password = 'Isolated-avatar-password-2026!';
  const aliceRegistration = await alice('/api/auth/register', 'POST', { name: 'Avatar Alice', email: 'avatar-alice@isolated.test', password });
  const aliceUser = aliceRegistration.body.user;
  const bobUser = (await bob('/api/auth/register', 'POST', { name: 'Avatar Bob', email: 'avatar-bob@isolated.test', password })).body.user;
  const setup = JSON.parse(await readFile(path.join(dataDir, 'admin-setup.json'), 'utf8'));
  const adminUser = (await admin('/api/auth/activate-admin', 'POST', { token: setup.token, password })).body.user;
  assert.equal(Object.hasOwn(aliceUser, 'avatarUrl'), false);
  const asset = '<svg xmlns="http://www.w3.org/2000/svg"><text>Avatar-independent note asset</text></svg>';
  assert.equal((await fetch(`${base}/api/assets/avatar-independent-asset`, { method: 'POST', headers: {
    Cookie: aliceRegistration.cookie, 'Content-Type': 'image/svg+xml', 'X-Asset-Path': 'fixture.svg',
  }, body: asset })).status, 201);
  const original = (await alice('/api/notes', 'POST', { note: { id: 'avatar-owner-note', title: 'Avatar-independent note',
    path: 'Avatar fixtures/note.md', content: '# Original body\n\n![Fixture](asset:avatar-independent-asset)',
    attachments: { 'fixture.svg': 'asset:avatar-independent-asset' }, ownerAvatarUrl: 'https://forged.invalid/avatar.png' } })).body.note;
  assert.equal(Object.hasOwn(original, 'ownerAvatarUrl'), false);
  function storedDocuments() {
    const db = new DatabaseSync(path.join(dataDir, 'knowledge.sqlite'), { readOnly: true });
    try { return { notes: db.prepare('SELECT * FROM notes ORDER BY id').all(), assets: db.prepare('SELECT * FROM assets ORDER BY id').all(),
      references: db.prepare('SELECT * FROM note_assets ORDER BY note_id,asset_id').all() }; }
    finally { db.close(); }
  }
  const documentSnapshot = storedDocuments();
  let firstUrl, currentUrl, bobUrl;

  await t.test('only the authenticated account can upload or remove its avatar, including administrators', async () => {
    const image = png();
    assert.equal((await guest('/api/profile/avatar', 'POST', image)).status, 401);
    assert.equal((await guest('/api/profile/avatar', 'DELETE')).status, 401);
    for (const client of [bob, admin]) {
      assert.equal((await client(`/api/profile/${aliceUser.id}/avatar`, 'POST', image)).status, 404);
      assert.equal((await client(`/api/users/${aliceUser.id}/avatar`, 'POST', image)).status, 404);
      assert.equal((await client(`/api/profile/avatar?userId=${aliceUser.id}`, 'POST', image)).status, 400);
      assert.equal((await client('/api/profile/avatar', 'DELETE', { userId: aliceUser.id })).status, 400);
    }
    const uploaded = await bob('/api/profile/avatar', 'POST', image);
    assert.equal(uploaded.status, 200);
    bobUrl = uploaded.body.user.avatarUrl;
    assert.match(bobUrl, new RegExp(`^/api/avatars/${bobUser.id}/[a-f0-9]{32}\\.png$`));
    const adminUpload = await admin('/api/profile/avatar', 'POST', image);
    assert.equal(adminUpload.status, 200);
    assert.match(adminUpload.body.user.avatarUrl, new RegExp(`^/api/avatars/${adminUser.id}/`));
    assert.deepEqual((await alice('/api/session')).body.user, aliceUser);
    assert.deepEqual(storedDocuments(), documentSnapshot);
  });

  await t.test('format, CRC, dimensions, chunk structure, scanlines and declared or streamed size are validated', async () => {
    assert.equal((await alice('/api/profile/avatar', 'POST', png(), { 'Content-Type': 'image/jpeg' })).status, 415);
    const badCrc = png(); badCrc[badCrc.length - 1] ^= 1;
    for (const image of [Buffer.from('<svg/>'), Buffer.from('not a png'), png().subarray(0, 40), badCrc,
      png(0, 1), png(1, 0), png(513, 1), png(1, 513), png(1, 1, { color: 9 }),
      png(1, 1, { depth: 3 }), png(1, 1, { compression: 1 }), png(1, 1, { filter: 5 }),
      png(1, 1, { data: Buffer.from('invalid compressed pixels') }),
      png(1, 1, { data: deflateSync(Buffer.alloc(3 * 1024 ** 2)) }),
      png(1, 1, { extra: pngChunk('ABCD') }), png(1, 1, { extra: pngChunk('acTL', Buffer.alloc(8)) }),
      Buffer.concat([png(), Buffer.from('trailing bytes')])]) {
      const result = await alice('/api/profile/avatar', 'POST', image);
      assert.equal(result.status, 400);
      assert.equal(result.body.code, 'INVALID_AVATAR');
    }
    const oversized = await alice('/api/profile/avatar', 'POST', Buffer.alloc(2 * 1024 ** 2 + 1));
    assert.equal(oversized.status, 413);
    assert.equal(oversized.body.code, 'AVATAR_TOO_LARGE');
    const streamed = await alice('/api/profile/avatar', 'POST', Readable.from(Array.from({ length: 5 }, () => Buffer.alloc(512 * 1024))));
    assert.equal(streamed.status, 413);
    assert.equal((await alice('/api/session')).body.user.avatarUrl, undefined);
    assert.deepEqual(storedDocuments(), documentSnapshot);
  });

  await t.test('avatar URLs propagate to session, auth, members and note reads while bodies and attachment totals stay unchanged', async () => {
    const indexBefore = await alice('/api/notes/index');
    const detailBefore = await alice(`/api/notes/${original.id}`);
    const image = png(512, 512);
    const uploaded = await alice('/api/profile/avatar', 'POST', image);
    assert.equal(uploaded.status, 200);
    firstUrl = currentUrl = uploaded.body.user.avatarUrl;
    assert.match(firstUrl, new RegExp(`^/api/avatars/${aliceUser.id}/[a-f0-9]{32}\\.png$`));
    assert.deepEqual(uploaded.body.user, { ...aliceUser, avatarUrl: firstUrl });
    assert.deepEqual((await alice('/api/session')).body.user, uploaded.body.user);
    const index = await alice('/api/notes/index', 'GET', undefined, { 'If-None-Match': indexBefore.headers.get('etag') });
    assert.equal(index.status, 200);
    assert.notEqual(index.headers.get('etag'), indexBefore.headers.get('etag'));
    assert.equal(index.body.notes.find(note => note.id === original.id).ownerAvatarUrl, firstUrl);
    assert.equal(Object.hasOwn(index.body.notes[0], 'content'), false);
    assert.deepEqual(index.body.totals, indexBefore.body.totals);
    const detail = await guest(`/api/notes/${original.id}`, 'GET', undefined, { 'If-None-Match': detailBefore.headers.get('etag') });
    assert.equal(detail.status, 200);
    assert.notEqual(detail.headers.get('etag'), detailBefore.headers.get('etag'));
    assert.deepEqual(detail.body.note, { ...original, ownerAvatarUrl: firstUrl });
    assert.equal((await guest('/api/notes')).body.notes[0].ownerAvatarUrl, firstUrl);
    const members = (await guest('/api/members')).body.members;
    assert.equal(members.find(member => member.id === aliceUser.id).avatarUrl, firstUrl);
    assert.equal(members.find(member => member.id === bobUser.id).avatarUrl, bobUrl);
    assert.equal((await alice('/api/auth/login', 'POST', { email: aliceUser.email, password })).body.user.avatarUrl, firstUrl);
    const renamed = await alice('/api/profile', 'PATCH', { name: 'Avatar Alice Renamed' });
    assert.equal(renamed.body.user.avatarUrl, firstUrl);
    assert.equal((await bob(`/api/notes/${original.id}`, 'PATCH', { note: { content: 'Forbidden' }, revision: original.revision })).status, 403);
    assert.equal((await bob(`/api/notes/${original.id}`, 'DELETE')).status, 403);
    assert.deepEqual(storedDocuments(), documentSnapshot);
    const assetRead = await fetch(`${base}/api/assets/avatar-independent-asset`);
    assert.equal(await assetRead.text(), asset);
  });

  await t.test('versioned public PNG reads support HEAD and 304, and replacements change the URL and cache representations', async () => {
    const originalImage = await fetch(`${base}${firstUrl}`);
    assert.equal(originalImage.status, 200);
    assert.equal(originalImage.headers.get('content-type'), 'image/png');
    assert.equal(originalImage.headers.get('x-content-type-options'), 'nosniff');
    assert.match(originalImage.headers.get('cache-control'), /immutable/);
    const bytes = Buffer.from(await originalImage.arrayBuffer());
    assert.deepEqual(bytes, png(512, 512));
    const etag = originalImage.headers.get('etag');
    const head = await fetch(`${base}${firstUrl}`, { method: 'HEAD' });
    assert.equal(head.status, 200); assert.equal(Number(head.headers.get('content-length')), bytes.length);
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    const conditional = await fetch(`${base}${firstUrl}`, { headers: { 'If-None-Match': etag } });
    assert.equal(conditional.status, 304); assert.equal((await conditional.arrayBuffer()).byteLength, 0);
    const indexBefore = await alice('/api/notes/index');
    const replacement = await alice('/api/profile/avatar', 'POST', png(32, 16, { shade: 144 }));
    assert.equal(replacement.status, 200);
    currentUrl = replacement.body.user.avatarUrl;
    assert.notEqual(currentUrl, firstUrl);
    assert.equal((await fetch(`${base}${firstUrl}`)).status, 404);
    const updatedImage = await fetch(`${base}${currentUrl}`, { headers: { 'If-None-Match': etag } });
    assert.equal(updatedImage.status, 200); assert.notEqual(updatedImage.headers.get('etag'), etag);
    assert.deepEqual(Buffer.from(await updatedImage.arrayBuffer()), png(32, 16, { shade: 144 }));
    const newIndex = await guest('/api/notes/index', 'GET', undefined, { 'If-None-Match': indexBefore.headers.get('etag') });
    assert.equal(newIndex.status, 200);
    assert.equal(newIndex.body.notes[0].ownerAvatarUrl, currentUrl);
    assert.deepEqual(storedDocuments(), documentSnapshot);
  });

  await t.test('avatars persist after restart; deletion restores initials and leaves other accounts and all documents intact', async () => {
    await stop(); await start();
    assert.equal((await alice('/api/session')).body.user.avatarUrl, currentUrl);
    assert.equal((await alice('/api/auth/login', 'POST', { email: aliceUser.email, password })).body.user.avatarUrl, currentUrl);
    assert.equal((await fetch(`${base}${currentUrl}`)).status, 200);
    assert.equal((await guest('/api/members')).body.members.find(member => member.id === aliceUser.id).avatarUrl, currentUrl);
    const before = await guest('/api/notes/index');
    const removed = await alice('/api/profile/avatar', 'DELETE');
    assert.equal(removed.status, 200);
    assert.equal(Object.hasOwn(removed.body.user, 'avatarUrl'), false);
    assert.equal(Object.hasOwn((await alice('/api/session')).body.user, 'avatarUrl'), false);
    assert.equal((await fetch(`${base}${currentUrl}`)).status, 404);
    const after = await guest('/api/notes/index', 'GET', undefined, { 'If-None-Match': before.headers.get('etag') });
    assert.equal(after.status, 200);
    assert.equal(Object.hasOwn(after.body.notes[0], 'ownerAvatarUrl'), false);
    const member = (await guest('/api/members')).body.members.find(member => member.id === aliceUser.id);
    assert.equal(Object.hasOwn(member, 'avatarUrl'), false); assert.equal(member.initial, 'AA');
    assert.equal((await bob('/api/session')).body.user.avatarUrl, bobUrl);
    assert.equal((await fetch(`${base}${bobUrl}`)).status, 200);
    assert.equal((await alice('/api/profile/avatar', 'DELETE')).status, 200);
    assert.deepEqual(storedDocuments(), documentSnapshot);
    const db = new DatabaseSync(path.join(dataDir, 'knowledge.sqlite'), { readOnly: true });
    try { assert.equal(db.prepare('SELECT COUNT(*) AS count FROM user_avatars WHERE user_id = ?').get(aliceUser.id).count, 0); }
    finally { db.close(); }
  });
});
