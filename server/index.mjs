import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, mkdir, readFile, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { brotliCompress, constants as zlibConstants, createBrotliCompress, createGzip, gzip, inflateSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { createReadingService } from './reading.mjs';
import { remapImportedNoteLinks } from './import-links.mjs';

const scrypt = promisify(scryptCallback);
const gzipAsync = promisify(gzip);
const brotliAsync = promisify(brotliCompress);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ADMIN_ID = 'workspace-administrator';
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_NAME = 'Project Admin';
const SESSION_LIFETIME = 30 * 24 * 60 * 60 * 1000;
const MAX_ASSET_BYTES = 500 * 1024 ** 2;
const MAX_NOTE_BYTES = 10 * 1024 ** 2;
const MAX_IMPORT_BYTES = 550 * 1024 ** 2;
const MAX_IMPORT_NOTES = 20_000;
const MAX_AVATAR_BYTES = 2 * 1024 ** 2;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.map': 'application/json',
  '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8', '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.ogg': 'audio/ogg',
};

class ApiError extends Error {
  constructor(status, message, code = 'REQUEST_FAILED') {
    super(message); this.status = status; this.code = code;
  }
}

const digest = (value) => createHash('sha256').update(value).digest('hex');
const token = () => randomBytes(32).toString('base64url');
const initial = (name) => name.includes(' ') ? name.split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase() : name.slice(-1);
const avatarUrl = (id, version) => `/api/avatars/${encodeURIComponent(id)}/${version}.png`;
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const pngCrcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function pngCrc(bytes) {
  let crc = 0xffffffff;
  for (const value of bytes) crc = pngCrcTable[(crc ^ value) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function validateAvatarPng(image) {
  const invalid = () => { throw new ApiError(400, '头像需为有效的 PNG 图片，宽高均不能超过 512 像素。', 'INVALID_AVATAR'); };
  if (image.length < 57 || !image.subarray(0, 8).equals(pngSignature)) invalid();
  let offset = 8, header, palette = false, imageStarted = false, imageEnded = false, ended = false;
  const compressed = [];
  while (offset < image.length) {
    if (offset + 12 > image.length) invalid();
    const size = image.readUInt32BE(offset);
    const end = offset + size + 12;
    if (end > image.length) invalid();
    const type = image.toString('ascii', offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(type) || type.charCodeAt(2) & 32
      || pngCrc(image.subarray(offset + 4, end - 4)) !== image.readUInt32BE(end - 4)) invalid();
    const data = image.subarray(offset + 8, end - 4);
    if (!header && type !== 'IHDR') invalid();
    if (type === 'IHDR') {
      if (header || size !== 13) invalid();
      const width = data.readUInt32BE(0), height = data.readUInt32BE(4), depth = data[8], color = data[9];
      const depths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (!width || !height || width > 512 || height > 512 || !depths[color]?.includes(depth)
        || data[10] !== 0 || data[11] !== 0 || data[12] > 1) invalid();
      header = { width, height, depth, color, interlace: data[12] };
    } else if (type === 'PLTE') {
      if (palette || imageStarted || !size || size % 3 || size > 768 || [0, 4].includes(header.color)
        || (header.color === 3 && size / 3 > 2 ** header.depth)) invalid();
      palette = true;
    } else if (type === 'IDAT') {
      if (imageEnded || (header.color === 3 && !palette)) invalid();
      imageStarted = true;
      compressed.push(data);
    } else if (type === 'IEND') {
      if (size || !imageStarted || end !== image.length) invalid();
      ended = true;
    } else {
      // PNG critical chunks are fully understood above. Keep avatars static;
      // animation extensions are unnecessary for the canvas-generated upload.
      if (!(type.charCodeAt(0) & 32) || ['acTL', 'fcTL', 'fdAT'].includes(type)) invalid();
      if (imageStarted) imageEnded = true;
    }
    offset = end;
  }
  if (!ended || !header) invalid();
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[header.color];
  const passes = header.interlace ? [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] : [[0, 0, 1, 1]];
  const rows = [];
  let expected = 0;
  for (const [x, y, stepX, stepY] of passes) {
    const width = Math.max(0, Math.ceil((header.width - x) / stepX));
    const height = Math.max(0, Math.ceil((header.height - y) / stepY));
    if (!width || !height) continue;
    const bytes = Math.ceil(width * channels * header.depth / 8);
    rows.push({ height, bytes });
    expected += height * (bytes + 1);
  }
  let inflated;
  try { inflated = inflateSync(Buffer.concat(compressed), { maxOutputLength: expected + 1 }); }
  catch { invalid(); }
  if (inflated.length !== expected) invalid();
  offset = 0;
  for (const { height, bytes } of rows) for (let row = 0; row < height; row++) {
    if (inflated[offset] > 4) invalid();
    offset += bytes + 1;
  }
}

async function readAvatar(request) {
  if (String(request.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'image/png') {
    throw new ApiError(415, '头像需使用 PNG 图片格式。', 'PNG_REQUIRED');
  }
  if (Number(request.headers['content-length']) > MAX_AVATAR_BYTES) throw new ApiError(413, '头像不能超过 2 MB。', 'AVATAR_TOO_LARGE');
  const image = await new Promise((resolve, reject) => {
    let size = 0, finished = false;
    const chunks = [];
    // Returning from an IncomingMessage async iterator destroys its socket.
    // Drain an over-limit chunked body without retaining it, allowing a clean
    // 413 response and subsequent requests on the connection to complete.
    request.on('data', chunk => {
      if (finished) return;
      size += chunk.length;
      if (size > MAX_AVATAR_BYTES) {
        finished = true;
        chunks.length = 0;
        reject(new ApiError(413, '头像不能超过 2 MB。', 'AVATAR_TOO_LARGE'));
      } else chunks.push(chunk);
    });
    request.once('end', () => {
      if (!finished) { finished = true; resolve(Buffer.concat(chunks)); }
    });
    request.once('aborted', () => reject(new ApiError(400, '头像上传已中断，请重试。', 'INVALID_AVATAR')));
    request.once('error', reject);
  });
  validateAvatarPng(image);
  return image;
}

function acceptedEncoding(request) {
  const weights = new Map(String(request.headers['accept-encoding'] || '').toLowerCase().split(',').map(part => {
    const [name, ...parameters] = part.trim().split(';');
    const quality = parameters.find(parameter => parameter.trim().startsWith('q='));
    const value = quality ? Number(quality.trim().slice(2)) : 1;
    return [name, Number.isFinite(value) && value >= 0 && value <= 1 ? value : 0];
  }));
  const weight = name => weights.get(name) ?? weights.get('*') ?? 0;
  if (weight('br') > 0 && weight('br') >= weight('gzip')) return 'br';
  return weight('gzip') > 0 ? 'gzip' : null;
}

const brotliOptions = { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 } };
function representation(raw) {
  return { raw, etag: `W/"${digest(raw)}"`, compressed: new Map() };
}

function jsonRepresentation(value) {
  return representation(Buffer.from(JSON.stringify(value)));
}

function matchesEtag(request, etag) {
  return String(request.headers['if-none-match'] || '').split(',').some(value => value.trim() === '*' || value.trim().replace(/^W\//, '') === etag.replace(/^W\//, ''));
}

async function encodedRepresentation(value, encoding) {
  if (!encoding || value.raw.length < 1024) return { body: value.raw, encoding: null };
  if (!value.compressed.has(encoding)) value.compressed.set(encoding,
    encoding === 'br' ? brotliAsync(value.raw, brotliOptions) : gzipAsync(value.raw, { level: 4 }));
  return { body: await value.compressed.get(encoding), encoding };
}

async function json(response, status, value, options = {}) {
  const request = response.req;
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': options.revalidate ? 'private, no-cache' : options.private ? 'private, no-store' : 'no-store', Vary: 'Accept-Encoding' };
  const body = options.representation || jsonRepresentation(value);
  if (options.revalidate) {
    headers.ETag = body.etag;
    if (status === 200 && ['GET', 'HEAD'].includes(request.method) && matchesEtag(request, body.etag)) {
      response.writeHead(304, headers); response.end(); return;
    }
  }
  const encoded = await encodedRepresentation(body, acceptedEncoding(request));
  if (response.destroyed) return;
  if (encoded.encoding) headers['Content-Encoding'] = encoded.encoding;
  headers['Content-Length'] = encoded.body.length;
  response.writeHead(status, headers);
  response.end(request.method === 'HEAD' ? undefined : encoded.body);
}

function assertId(value) {
  if (!ID_PATTERN.test(value || '')) throw new ApiError(400, '无效的资源编号。', 'INVALID_ID');
  return value;
}

async function readJson(request, limit = 12 * 1024 ** 2) {
  if (!String(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
    throw new ApiError(415, '请求需要使用 JSON 格式。', 'JSON_REQUIRED');
  }
  const declared = Number(request.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) throw new ApiError(413, '提交内容过大。', 'BODY_TOO_LARGE');
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new ApiError(413, '提交内容过大。', 'BODY_TOO_LARGE');
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ApiError(400, 'JSON 内容无效。', 'INVALID_JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400, '请求内容无效。', 'INVALID_JSON');
  return value;
}

async function hashPassword(password) {
  validatePassword(password);
  const salt = randomBytes(16).toString('hex');
  return { salt, hash: (await scrypt(password, salt, 64)).toString('hex') };
}

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 8 || password.length > 128) {
    throw new ApiError(400, '密码需为 8—128 个字符。', 'INVALID_PASSWORD');
  }
}

async function verifyPassword(password, row) {
  if (typeof password !== 'string' || password.length > 128) return false;
  const expected = row?.password_hash || '0'.repeat(128);
  const computed = await scrypt(password, row?.password_salt || 'unavailable-account', 64);
  return !!row?.password_hash && timingSafeEqual(computed, Buffer.from(expected, 'hex'));
}

function assetIds(note) {
  const result = new Set();
  const addTarget = (target) => {
    const match = /^asset:([A-Za-z0-9][A-Za-z0-9._-]{0,159})$/.exec(target || '');
    if (match) result.add(match[1]);
  };
  // Parse actual Markdown links instead of treating text and code examples as
  // attachment references. This also handles escaped targets and reference links.
  if (/[<\[]/.test(note.content)) {
    const stack = [fromMarkdown(note.content)];
    const definitions = new Map();
    const referenceLinks = [];
    while (stack.length) {
      const node = stack.pop();
      if (node.type === 'link' || node.type === 'image') addTarget(node.url);
      if (node.type === 'definition' && !definitions.has(node.identifier)) definitions.set(node.identifier, node.url);
      if (node.type === 'linkReference' || node.type === 'imageReference') referenceLinks.push(node.identifier);
      if (node.children) for (let index = node.children.length - 1; index >= 0; index--) stack.push(node.children[index]);
    }
    for (const identifier of referenceLinks) addTarget(definitions.get(identifier));
  }
  for (const value of Object.values(note.attachments || {})) {
    addTarget(value);
  }
  return result;
}

function safeString(value, max, label, fallback = '') {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || value.length > max) throw new ApiError(400, `${label}格式无效或过长。`, 'INVALID_NOTE');
  return value;
}

const foldedPath = value => value.normalize('NFC').toLocaleLowerCase();

function notePath(note) {
  const value = note.path || `${note.category || '未分类'}/${note.title.replace(/[\\/]/g, '／')}.md`;
  const segments = [];
  for (const segment of value.replace(/\\/g, '/').split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') segments.pop();
    else segments.push(segment);
  }
  return segments.join('/').normalize('NFC');
}

function normalizedNotePath(note) {
  return foldedPath(notePath(note));
}

function directoryName(value, document = false) {
  if (typeof value !== 'string') throw new ApiError(400, '请填写有效的名称。', 'INVALID_NAME');
  let name = value.normalize('NFC').trim();
  if (document) name = name.replace(/\.(md|markdown)$/i, '');
  if (!name || name === '.' || name === '..' || Array.from(name).length > (document ? 252 : 255)
    || /[\\/<>:"|?*\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(name) || /[. ]$/.test(name)) {
    throw new ApiError(400, '名称不能为空，不能包含路径分隔符、控制字符或无效文件名字符。', 'INVALID_NAME');
  }
  return name;
}

function folderPath(value, rootAllowed = false) {
  if (typeof value !== 'string' || value.length > 3000 || /[\\\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)) {
    throw new ApiError(400, '文件夹路径无效。', 'INVALID_FOLDER');
  }
  const normalized = value.normalize('NFC');
  if (rootAllowed && normalized === '') return normalized;
  if (normalized.split('/').some(segment => !segment || segment === '.' || segment === '..')) {
    throw new ApiError(400, '文件夹路径无效。', 'INVALID_FOLDER');
  }
  return normalized;
}

function cleanNote(input, owner, existing = null) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ApiError(400, '笔记内容无效。', 'INVALID_NOTE');
  const original = existing ? JSON.parse(existing.data) : {};
  const merged = { ...original, ...input };
  const title = safeString(merged.title, 500, '标题').trim();
  if (!title) throw new ApiError(400, '请填写笔记标题。', 'INVALID_NOTE');
  const content = safeString(merged.content, MAX_NOTE_BYTES, '正文');
  if (Buffer.byteLength(content, 'utf8') > MAX_NOTE_BYTES) throw new ApiError(413, '单篇笔记正文不能超过 10 MB。', 'NOTE_TOO_LARGE');
  const tags = merged.tags ?? [];
  if (!Array.isArray(tags) || tags.length > 200 || tags.some((tag) => typeof tag !== 'string' || tag.length > 200)) {
    throw new ApiError(400, '标签格式无效。', 'INVALID_NOTE');
  }
  const attachments = merged.attachments ?? {};
  if (!attachments || typeof attachments !== 'object' || Array.isArray(attachments) || Object.keys(attachments).length > 20_000) {
    throw new ApiError(400, '附件列表无效。', 'INVALID_NOTE');
  }
  for (const [key, value] of Object.entries(attachments)) {
    if (key.length > 3000 || typeof value !== 'string' || value.length > 14 * 1024 ** 2 || !/^(asset:[A-Za-z0-9._-]{1,160}|data:[\s\S]*)$/.test(value)) {
      throw new ApiError(400, '附件引用无效。', 'INVALID_ASSET');
    }
  }
  const attachmentSizes = {};
  for (const [key, value] of Object.entries(merged.attachmentSizes || {})) {
    if (/^asset:[A-Za-z0-9._-]{1,160}$/.test(key) && Number.isSafeInteger(value) && value >= 0 && value <= MAX_ASSET_BYTES) attachmentSizes[key] = value;
  }
  return {
    id: existing?.id || assertId(input.id || randomUUID()), title, content,
    category: safeString(merged.category, 500, '分类', '未分类').trim() || '未分类',
    tags: [...new Set(tags)], updatedAt: new Date().toISOString(),
    author: owner.name, avatar: initial(owner.name),
    color: safeString(merged.color, 100, '颜色', '#8b7cf8'),
    ...(merged.path !== undefined ? { path: safeString(merged.path, 3000, '路径') } : {}),
    attachments, attachmentSizes,
  };
}

/** The database is separate from the built UI and never imports browser data automatically. */
export async function createKnowledgeServer(options = {}) {
  const dataDir = path.resolve(options.dataDir || process.env.DATA_DIR || path.join(ROOT, 'data'));
  const distDir = path.resolve(options.distDir || process.env.DIST_DIR || path.join(ROOT, 'dist'));
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await chmod(dataDir, 0o700);
  const assetDir = path.join(dataDir, 'assets');
  await mkdir(assetDir, { recursive: true, mode: 0o700 });
  const databasePath = path.join(dataDir, 'knowledge.sqlite');
  const db = new DatabaseSync(databasePath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL CHECK(role IN ('admin', 'member')),
      password_hash TEXT, password_salt TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS user_avatars (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      version TEXT NOT NULL, image BLOB NOT NULL
    );
    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), data TEXT NOT NULL,
      collaborative INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS assets (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), path TEXT NOT NULL,
      mime TEXT NOT NULL, size INTEGER NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS note_assets (
      note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      asset_id TEXT NOT NULL REFERENCES assets(id), PRIMARY KEY(note_id, asset_id)
    );
    CREATE INDEX IF NOT EXISTS note_assets_asset ON note_assets(asset_id);
    CREATE TABLE IF NOT EXISTS folders (
      path TEXT PRIMARY KEY, path_key TEXT NOT NULL UNIQUE,
      owner_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  await chmod(databasePath, 0o600);
  db.prepare('INSERT OR IGNORE INTO users(id,name,email,role,created_at) VALUES(?,?,?,?,?)')
    .run(ADMIN_ID, ADMIN_NAME, ADMIN_EMAIL, 'admin', new Date().toISOString());
  const setupFile = path.join(dataDir, 'admin-setup.json');
  const administrator = () => db.prepare('SELECT * FROM users WHERE id = ?').get(ADMIN_ID);
  if (!administrator().password_hash) {
    let setup;
    try { setup = JSON.parse(await readFile(setupFile, 'utf8')); } catch { /* Create a fresh secret if its private file is missing. */ }
    const savedHash = db.prepare('SELECT value FROM settings WHERE key = ?').get('admin_setup_hash')?.value;
    if (!setup?.token || digest(setup.token) !== savedHash) {
      setup = { token: token(), email: ADMIN_EMAIL };
      db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run('admin_setup_hash', digest(setup.token));
      await writeFile(setupFile, `${JSON.stringify(setup, null, 2)}\n`, { mode: 0o600 });
    }
    await chmod(setupFile, 0o600);
  } else await rm(setupFile, { force: true });

  const queryAvatarVersion = db.prepare('SELECT version FROM user_avatars WHERE user_id = ?');
  const queryAvatar = db.prepare('SELECT image FROM user_avatars WHERE user_id = ? AND version = ?');
  const queryNote = db.prepare('SELECT notes.*, users.name AS owner_name, users.email AS owner_email, user_avatars.version AS owner_avatar_version FROM notes JOIN users ON users.id = notes.owner_id LEFT JOIN user_avatars ON user_avatars.user_id = notes.owner_id WHERE notes.id = ?');
  const queryNotePaths = db.prepare("SELECT id, owner_id, collaborative, revision, json_extract(data, '$.path') AS path, json_extract(data, '$.category') AS category, json_extract(data, '$.title') AS title FROM notes");
  const queryFolders = db.prepare('SELECT * FROM folders ORDER BY path');
  const queryAsset = db.prepare('SELECT * FROM assets WHERE id = ?');
  const assetReferences = db.prepare('SELECT 1 FROM note_assets WHERE asset_id = ? LIMIT 1');
  const insertReference = db.prepare('INSERT OR IGNORE INTO note_assets(note_id,asset_id) VALUES(?,?)');
  const activeUploads = new Set();
  const authAttempts = new Map();

  function publicUser(row) {
    if (!row) return null;
    const version = queryAvatarVersion.get(row.id)?.version;
    return { id: row.id, name: row.name, email: row.email, role: row.role,
      ...(version ? { avatarUrl: avatarUrl(row.id, version) } : {}) };
  }

  function noteOutput(row) {
    const data = JSON.parse(row.data);
    delete data.ownerAvatarUrl;
    return { ...data, author: row.owner_name, avatar: initial(row.owner_name), ownerId: row.owner_id, ownerEmail: row.owner_email,
      ...(row.owner_avatar_version ? { ownerAvatarUrl: avatarUrl(row.owner_id, row.owner_avatar_version) } : {}),
      collaborative: !!row.collaborative, revision: row.revision };
  }

  const readDataVersion = db.prepare('PRAGMA data_version');
  const readTotalChanges = db.prepare('SELECT total_changes() AS changes');
  let readingChanges = 0;
  const reading = createReadingService(db, { ApiError, avatarUrl, now: options.readingClock || Date.now,
    onChanges: count => { readingChanges += count; } });
  let libraryCache;
  function librarySnapshot() {
    // data_version detects other SQLite connections; total_changes detects this
    // server's own writes, including profile names and sharing-only changes.
    const version = `${readDataVersion.get().data_version}:${readTotalChanges.get().changes - readingChanges}`;
    if (libraryCache?.version === version) return libraryCache;
    let rows, references, folders;
    db.exec('BEGIN');
    try {
      rows = db.prepare('SELECT notes.*, users.name AS owner_name, users.email AS owner_email, user_avatars.version AS owner_avatar_version FROM notes JOIN users ON users.id = notes.owner_id LEFT JOIN user_avatars ON user_avatars.user_id = notes.owner_id ORDER BY notes.updated_at DESC, notes.id').all();
      references = db.prepare('SELECT note_assets.note_id, assets.id, assets.size FROM note_assets JOIN assets ON assets.id = note_assets.asset_id').all();
      folders = queryFolders.all().map(folder => ({ path: folder.path, ownerId: folder.owner_id }));
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    const notes = rows.map(noteOutput);
    const assetsByNote = new Map();
    const allAssets = new Map();
    for (const reference of references) {
      if (!assetsByNote.has(reference.note_id)) assetsByNote.set(reference.note_id, new Map());
      assetsByNote.get(reference.note_id).set(`asset:${reference.id}`, reference.size);
      allAssets.set(`asset:${reference.id}`, reference.size);
    }
    let contentBytes = 0;
    const summaries = notes.map(note => {
      const { content, attachments, attachmentSizes, ...metadata } = note;
      const assets = new Map(assetsByNote.get(note.id) || []);
      for (const reference of Object.values(attachments || {})) {
        if (!assets.has(reference)) assets.set(reference, 0);
        if (!allAssets.has(reference)) allAssets.set(reference, 0);
      }
      const bytes = Buffer.byteLength(content);
      contentBytes += bytes;
      return { ...metadata, contentBytes: bytes, attachmentCount: assets.size,
        attachmentBytes: [...assets.values()].reduce((sum, size) => sum + size, 0),
        excerpt: content.slice(0, 1000).replace(/[#*`>\[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120) };
    });
    const totals = { notes: notes.length, attachments: allAssets.size, contentBytes,
      attachmentBytes: [...allAssets.values()].reduce((sum, size) => sum + size, 0) };
    libraryCache = { version, notes, notesById: new Map(notes.map(note => [note.id, note])), summaries, totals, folders, index: jsonRepresentation({ notes: summaries, totals, folders }),
      details: new Map(), searches: new Map(), backlinkResults: new Map() };
    return libraryCache;
  }

  function searchRepresentation(snapshot, query) {
    const term = query.toLowerCase();
    if (snapshot.searches.has(term)) return snapshot.searches.get(term);
    if (!snapshot.searchText) snapshot.searchText = snapshot.notes.map(note =>
      ({ id: note.id, text: `${note.title} ${note.content} ${note.tags.join(' ')} ${note.author}`.toLowerCase() }));
    const result = jsonRepresentation({ ids: snapshot.searchText.filter(note => note.text.includes(term)).map(note => note.id) });
    if (snapshot.searches.size >= 32) snapshot.searches.delete(snapshot.searches.keys().next().value);
    snapshot.searches.set(term, result);
    return result;
  }

  function backlinksRepresentation(snapshot, id) {
    if (snapshot.backlinkResults.has(id)) return snapshot.backlinkResults.get(id);
    if (!snapshot.backlinks) {
      const names = new Map();
      const incoming = new Map(snapshot.notes.map(note => [note.id, new Set()]));
      for (const note of snapshot.notes) {
        const notePath = (note.path || `${note.category || '未分类'}/${note.title.replace(/[\\/]/g, '／')}.md`)
          .replace(/\\/g, '/').split('/').filter(part => part && part !== '.').join('/');
        for (const name of [note.title, notePath, notePath.replace(/\.(md|markdown)$/i, '')]) {
          if (!names.has(name)) names.set(name, new Set());
          names.get(name).add(note.id);
        }
      }
      for (const source of snapshot.notes) {
        for (const match of source.content.matchAll(/#note\/([A-Za-z0-9][A-Za-z0-9._-]{0,159})\)/g)) {
          if (match[1] !== source.id) incoming.get(match[1])?.add(source.id);
        }
        for (const match of source.content.matchAll(/\[\[([^\]|#]+)(?:[^\]]*)\]\]/g)) {
          for (const target of names.get(match[1].trim()) || []) if (target !== source.id) incoming.get(target)?.add(source.id);
        }
      }
      snapshot.backlinks = incoming;
    }
    const incoming = snapshot.backlinks.get(id) || new Set();
    const result = jsonRepresentation({ ids: snapshot.notes.filter(note => incoming.has(note.id)).map(note => note.id) });
    snapshot.backlinkResults.set(id, result);
    return result;
  }

  function currentUser(request) {
    const cookie = String(request.headers.cookie || '').split(';').map((part) => part.trim()).find((part) => part.startsWith('zhiyu_session='));
    if (!cookie) return null;
    const value = cookie.slice('zhiyu_session='.length);
    if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return null;
    return db.prepare('SELECT users.* FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.token_hash = ? AND sessions.expires_at > ?')
      .get(digest(value), Date.now()) || null;
  }

  function requireUser(request) {
    const user = currentUser(request);
    if (!user) throw new ApiError(401, '请先登录，再操作笔记。', 'AUTH_REQUIRED');
    return user;
  }

  function createSession(response, user, request) {
    const secret = token();
    db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
    db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(digest(secret), user.id, Date.now() + SESSION_LIFETIME);
    // FRPC currently serves HTTP; Secure is enabled when the reverse proxy reports HTTPS.
    const secure = request.socket.encrypted || process.env.COOKIE_SECURE === '1';
    response.setHeader('Set-Cookie', `zhiyu_session=${secret}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_LIFETIME / 1000}${secure ? '; Secure' : ''}`);
  }

  function checkOrigin(request) {
    if (!request.headers.origin) return;
    let origin, host;
    try { origin = new URL(request.headers.origin); host = new URL(`http://${request.headers.host}`); }
    catch { throw new ApiError(403, '请求来源无效。', 'INVALID_ORIGIN'); }
    const configured = (process.env.ALLOWED_ORIGINS || '').split(',').map((value) => value.trim()).filter(Boolean);
    const localHostnames = new Set(['localhost', '127.0.0.1', '[::1]']);
    const localDevelopment = localHostnames.has(origin.hostname) && localHostnames.has(host.hostname);
    if (origin.host !== host.host && !localDevelopment && !configured.includes(origin.origin)) {
      throw new ApiError(403, '请从知识库页面提交请求。', 'INVALID_ORIGIN');
    }
  }

  function limitAuth(request, email) {
    const key = `${request.socket.remoteAddress}:${email}`;
    const now = Date.now();
    const previous = authAttempts.get(key);
    const attempts = !previous || previous.after < now ? { count: 0, after: now + 10 * 60 * 1000 } : previous;
    attempts.count++;
    authAttempts.set(key, attempts);
    if (authAttempts.size > 10_000) for (const [entry, value] of authAttempts) if (value.after < now) authAttempts.delete(entry);
    if (attempts.count > 30) throw new ApiError(429, '尝试次数过多，请稍后再试。', 'AUTH_RATE_LIMIT');
  }

  function validateReferences(note, user) {
    const ids = assetIds(note);
    for (const id of ids) {
      const asset = queryAsset.get(id);
      if (!asset) throw new ApiError(400, '笔记引用的附件尚未上传。', 'ASSET_NOT_AVAILABLE');
      if (asset.owner_id !== user.id && !assetReferences.get(id)) throw new ApiError(403, '无权使用其他成员尚未发布的附件。', 'ASSET_ACCESS_DENIED');
      // Use server sizes, rather than allowing a client to misreport its storage usage.
      note.attachmentSizes[`asset:${id}`] = asset.size;
    }
    return ids;
  }

  function updateReferences(id, references) {
    db.prepare('DELETE FROM note_assets WHERE note_id = ?').run(id);
    for (const assetId of references) insertReference.run(id, assetId);
  }

  function transaction(callback) {
    db.exec('BEGIN IMMEDIATE');
    try { const result = callback(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }

  function directoryState() {
    const notes = queryNotePaths.all().map(note => ({ ...note, path: notePath(note) }));
    const explicit = queryFolders.all();
    const paths = new Set();
    const addParents = value => {
      const parts = value.split('/');
      for (let length = 1; length <= parts.length; length++) paths.add(parts.slice(0, length).join('/'));
    };
    for (const note of notes) {
      const parent = path.posix.dirname(note.path);
      if (parent !== '.') addParents(parent);
    }
    for (const folder of explicit) addParents(folder.path);
    return { notes, explicit, paths };
  }

  function assertNoteDestination(note, state, currentId) {
    const destination = normalizedNotePath(note);
    const filePaths = new Set(state.notes.filter(other => other.id !== currentId).map(other => foldedPath(other.path)));
    const parents = notePath(note).split('/');
    parents.pop();
    const fileInParents = parents.some((_, index) => filePaths.has(foldedPath(parents.slice(0, index + 1).join('/'))));
    if (filePaths.has(destination) || fileInParents || [...state.paths].some(folder => foldedPath(folder) === destination)) {
      throw new ApiError(409, '目标位置已有同名文档或文件夹，请选择其他名称。', 'NOTE_PATH_EXISTS');
    }
  }

  function renameFolder(source, name, user) {
    return transaction(() => {
      const state = directoryState();
      const sourceKey = foldedPath(source);
      const canonicalSource = state.explicit.find(folder => foldedPath(folder.path) === sourceKey)?.path
        || [...state.paths].find(value => foldedPath(value) === sourceKey);
      if (!canonicalSource) throw new ApiError(404, '文件夹不存在或已被移动。', 'FOLDER_NOT_FOUND');
      // The explorer combines Unicode/case-equivalent directories. Include all
      // of those descendants in both permission checks and the atomic move.
      const inside = value => foldedPath(value) === sourceKey || foldedPath(value).startsWith(`${sourceKey}/`);
      const notes = state.notes.filter(note => inside(path.posix.dirname(note.path)));
      const explicit = state.explicit.filter(folder => inside(folder.path));
      if (notes.some(note => note.owner_id !== user.id && !note.collaborative)) {
        throw new ApiError(403, '文件夹中有仅作者可修改的文档，无法重命名。', 'NOTE_READ_ONLY');
      }
      if (explicit.some(folder => folder.owner_id !== user.id && user.role !== 'admin')) {
        throw new ApiError(403, '只能重命名自己创建的文件夹。', 'FOLDER_OWNER_REQUIRED');
      }
      const parent = path.posix.dirname(canonicalSource);
      const destination = parent === '.' ? name : `${parent}/${name}`;
      if (canonicalSource === destination && [...state.paths].filter(inside).every(value => value === canonicalSource || value.startsWith(`${canonicalSource}/`))) return;
      const sourceDepth = source.split('/').length;
      const moved = value => [destination, ...value.split('/').slice(sourceDepth)].join('/');
      const affectedPaths = [...state.paths].filter(inside);
      const outsideFolders = new Set([...state.paths].filter(value => !inside(value)).map(foldedPath));
      const affectedIds = new Set(notes.map(note => note.id));
      const outsideFiles = new Set(state.notes.filter(note => !affectedIds.has(note.id)).map(note => foldedPath(note.path)));
      const movedFolders = new Set(affectedPaths.map(value => foldedPath(moved(value))));
      for (const folder of affectedPaths) {
        const target = moved(folder);
        if (target.length > 3000) throw new ApiError(400, '重命名后的路径过长。', 'INVALID_FOLDER');
        if (outsideFolders.has(foldedPath(target)) || outsideFiles.has(foldedPath(target))) {
          throw new ApiError(409, '目标位置已有同名文件夹或文档，不能合并目录。', 'FOLDER_EXISTS');
        }
      }
      for (const note of notes) {
        const target = moved(note.path);
        if (target.length > 3000) throw new ApiError(400, '重命名后的路径过长。', 'INVALID_FOLDER');
        if (outsideFiles.has(foldedPath(target)) || outsideFolders.has(foldedPath(target)) || movedFolders.has(foldedPath(target))) {
          throw new ApiError(409, '目标位置已有同名文档或文件夹，不能合并目录。', 'NOTE_PATH_EXISTS');
        }
      }
      const now = new Date().toISOString();
      const update = db.prepare("UPDATE notes SET data = json_set(data, '$.path', ?, '$.category', ?, '$.updatedAt', ?), revision = revision + 1, updated_at = ? WHERE id = ?");
      for (const note of notes) {
        const target = moved(note.path);
        update.run(target, target.includes('/') ? target.split('/')[0] : '未分类', now, now, note.id);
      }
      // Reinsert within the same transaction so case-only changes and nested
      // paths never hit each other's old UNIQUE keys or expose a partial tree.
      const remove = db.prepare('DELETE FROM folders WHERE path = ?');
      const insert = db.prepare('INSERT INTO folders(path,path_key,owner_id,created_at,updated_at) VALUES(?,?,?,?,?)');
      for (const folder of explicit) remove.run(folder.path);
      for (const folder of explicit) {
        const target = moved(folder.path);
        insert.run(target, foldedPath(target), folder.owner_id, folder.created_at, now);
      }
    });
  }

  function deleteFolder(source, user) {
    return transaction(() => {
      const state = directoryState();
      const sourceKey = foldedPath(source);
      if (![...state.paths].some(value => foldedPath(value) === sourceKey)) {
        throw new ApiError(404, '文件夹不存在或已被删除。', 'FOLDER_NOT_FOUND');
      }
      // Match the explorer's case/Unicode-equivalent branches, with a segment
      // boundary so deleting "Project" never includes "Project archive".
      const inside = value => foldedPath(value) === sourceKey || foldedPath(value).startsWith(`${sourceKey}/`);
      const notes = state.notes.filter(note => inside(path.posix.dirname(note.path)));
      const explicit = state.explicit.filter(folder => inside(folder.path));
      // Deleting a folder must not bypass individual document deletion rights:
      // shared editing and administrator status do not transfer authorship.
      if (notes.some(note => note.owner_id !== user.id)) {
        throw new ApiError(403, '文件夹中有其他成员的文档，不能删除整个文件夹。', 'OWNER_REQUIRED');
      }
      if (explicit.some(folder => folder.owner_id !== user.id && user.role !== 'admin')) {
        throw new ApiError(403, '文件夹中有其他成员创建的文件夹，不能删除整个文件夹。', 'FOLDER_OWNER_REQUIRED');
      }
      const references = new Set();
      const queryReferences = db.prepare('SELECT asset_id FROM note_assets WHERE note_id = ?');
      for (const note of notes) for (const reference of queryReferences.all(note.id)) references.add(reference.asset_id);
      const removeNote = db.prepare('DELETE FROM notes WHERE id = ?');
      const removeFolder = db.prepare('DELETE FROM folders WHERE path = ?');
      for (const note of notes) removeNote.run(note.id);
      for (const folder of explicit) removeFolder.run(folder.path);
      const orphaned = [];
      const removeAsset = db.prepare('DELETE FROM assets WHERE id = ? AND NOT EXISTS (SELECT 1 FROM note_assets WHERE asset_id = ?)');
      for (const assetId of references) {
        // Reclaim only attachments detached by this deletion. Shared assets and
        // unrelated uploads being prepared in another tab remain available.
        if (activeUploads.has(assetId)) continue;
        if (removeAsset.run(assetId, assetId).changes) orphaned.push(assetId);
      }
      return orphaned;
    });
  }

  async function removeOrphanedAssets() {
    // A grace period keeps uploads from another tab safe while its import is being prepared.
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const rows = db.prepare('SELECT assets.id FROM assets LEFT JOIN note_assets ON note_assets.asset_id = assets.id WHERE note_assets.asset_id IS NULL AND assets.created_at < ?').all(cutoff);
    for (const row of rows) {
      if (activeUploads.has(row.id)) continue;
      db.prepare('DELETE FROM assets WHERE id = ? AND NOT EXISTS (SELECT 1 FROM note_assets WHERE asset_id = ?)').run(row.id, row.id);
      if (!queryAsset.get(row.id)) await rm(path.join(assetDir, row.id), { force: true });
    }
  }
  await removeOrphanedAssets();

  async function api(request, response, url) {
    const method = request.method || 'GET';
    if (method !== 'GET' && method !== 'HEAD') checkOrigin(request);
    const pathname = url.pathname;
    if (method === 'GET' && pathname === '/api/health') return json(response, 200, { ok: true });
    if (method === 'GET' && pathname === '/api/session') {
      return json(response, 200, { user: publicUser(currentUser(request)), needsAdminSetup: !administrator().password_hash });
    }
    if (method === 'POST' && ['/api/reading/start', '/api/reading/heartbeat', '/api/reading/stop'].includes(pathname)) {
      const user = requireUser(request);
      if (url.search) throw new ApiError(400, '阅读记录不能指定其他账号。', 'INVALID_READING_EVENT');
      const body = await readJson(request, 2048);
      const operation = pathname.slice('/api/reading/'.length);
      if (operation === 'start') {
        const result = reading.start(user.id, body);
        return json(response, result.status, result.body, { private: true });
      }
      return json(response, 200, reading[operation](user.id, body), { private: true });
    }
    if (method === 'GET' && pathname === '/api/admin/reading') {
      const user = requireUser(request);
      if (user.role !== 'admin') throw new ApiError(403, '只有管理员可以查看阅读统计。', 'ADMIN_REQUIRED');
      return json(response, 200, reading.stats(url.searchParams), { private: true });
    }
    if (['POST', 'DELETE'].includes(method) && pathname === '/api/profile/avatar') {
      const user = requireUser(request);
      // The authenticated account is the only target. Query/body account IDs
      // cannot turn this self-service endpoint into an administrator override.
      if (url.search || (method === 'DELETE' && (Number(request.headers['content-length']) > 0 || request.headers['transfer-encoding']))) {
        throw new ApiError(400, '头像仅支持修改本人，不能指定其他账号。', 'INVALID_PROFILE');
      }
      if (method === 'POST') {
        const image = await readAvatar(request);
        db.prepare('INSERT INTO user_avatars(user_id,version,image) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET version = excluded.version, image = excluded.image')
          .run(user.id, randomBytes(16).toString('hex'), image);
      } else db.prepare('DELETE FROM user_avatars WHERE user_id = ?').run(user.id);
      return json(response, 200, { user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(user.id)) });
    }
    const avatarMatch = /^\/api\/avatars\/([^/]+)\/([a-f0-9]{32})\.png$/.exec(pathname);
    if (['GET', 'HEAD'].includes(method) && avatarMatch) {
      const row = queryAvatar.get(assertId(decodeURIComponent(avatarMatch[1])), avatarMatch[2]);
      if (!row) throw new ApiError(404, '头像不存在。', 'AVATAR_NOT_FOUND');
      const image = Buffer.from(row.image);
      const etag = `"${digest(image)}"`;
      const headers = { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=31536000, immutable', ETag: etag };
      if (matchesEtag(request, etag)) { response.writeHead(304, headers); response.end(); return; }
      response.writeHead(200, { ...headers, 'Content-Length': image.length });
      response.end(method === 'HEAD' ? undefined : image);
      return;
    }
    if (method === 'PATCH' && pathname === '/api/profile') {
      const user = requireUser(request);
      const body = await readJson(request, 1024);
      if (Object.keys(body).length !== 1 || !Object.hasOwn(body, 'name') || typeof body.name !== 'string') {
        throw new ApiError(400, '个人资料仅支持修改自己的显示名称。', 'INVALID_PROFILE');
      }
      const name = body.name.normalize('NFC').trim();
      if (!name || Array.from(name).length > 30 || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(body.name)) {
        throw new ApiError(400, '显示名称需为 1—30 个字符，不能包含控制字符或换行。', 'INVALID_PROFILE');
      }
      // Identity and permissions are tied to the authenticated, stable user ID.
      // No account target can be supplied, including by an administrator.
      db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, user.id);
      return json(response, 200, { user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(user.id)) });
    }
    if (method === 'POST' && pathname === '/api/auth/activate-admin') {
      const body = await readJson(request, 16_384);
      limitAuth(request, 'administrator-activation');
      const expected = db.prepare('SELECT value FROM settings WHERE key = ?').get('admin_setup_hash')?.value;
      if (administrator().password_hash || typeof body.token !== 'string' || !expected || digest(body.token) !== expected) {
        throw new ApiError(403, '管理员初始化链接无效或已使用。', 'INVALID_SETUP_TOKEN');
      }
      const password = await hashPassword(body.password);
      transaction(() => {
        if (administrator().password_hash) throw new ApiError(409, '管理员已完成初始化。', 'ADMIN_ALREADY_CONFIGURED');
        db.prepare('UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?').run(password.hash, password.salt, ADMIN_ID);
        db.prepare('DELETE FROM settings WHERE key = ?').run('admin_setup_hash');
      });
      await rm(setupFile, { force: true });
      const user = administrator();
      createSession(response, user, request);
      return json(response, 200, { user: publicUser(user) });
    }
    if (method === 'POST' && pathname === '/api/auth/register') {
      const body = await readJson(request, 16_384);
      const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || !name || name.length > 80) {
        throw new ApiError(400, '请填写有效的姓名和邮箱。', 'INVALID_PROFILE');
      }
      limitAuth(request, email);
      if (db.prepare('SELECT id FROM users WHERE email = ?').get(email)) throw new ApiError(409, '此邮箱已存在，请登录；管理员账号请使用专属初始化链接。', 'EMAIL_EXISTS');
      const password = await hashPassword(body.password);
      const id = randomUUID();
      try {
        db.prepare('INSERT INTO users(id,name,email,role,password_hash,password_salt,created_at) VALUES(?,?,?,?,?,?,?)')
          .run(id, name, email, 'member', password.hash, password.salt, new Date().toISOString());
      } catch (error) {
        if (db.prepare('SELECT id FROM users WHERE email = ?').get(email)) throw new ApiError(409, '此邮箱已注册，请登录。', 'EMAIL_EXISTS');
        throw error;
      }
      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
      createSession(response, user, request);
      return json(response, 201, { user: publicUser(user) });
    }
    if (method === 'POST' && pathname === '/api/auth/login') {
      const body = await readJson(request, 16_384);
      const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
      limitAuth(request, email);
      const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
      if (!(await verifyPassword(body.password, user))) throw new ApiError(401, '邮箱或密码不正确。', 'INVALID_CREDENTIALS');
      createSession(response, user, request);
      return json(response, 200, { user: publicUser(user) });
    }
    if (method === 'POST' && pathname === '/api/auth/logout') {
      const cookie = String(request.headers.cookie || '').match(/(?:^|;\s*)zhiyu_session=([^;]+)/)?.[1];
      if (cookie) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(digest(cookie));
      response.setHeader('Set-Cookie', 'zhiyu_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
      response.writeHead(204); response.end(); return;
    }
    if (method === 'GET' && pathname === '/api/members') {
      const members = db.prepare('SELECT users.id,name,email,role,created_at,user_avatars.version AS avatar_version FROM users LEFT JOIN user_avatars ON user_avatars.user_id = users.id ORDER BY role,created_at').all().map((member) => ({
        id: member.id, name: member.name, email: member.email, role: member.role,
        ...(member.avatar_version ? { avatarUrl: avatarUrl(member.id, member.avatar_version) } : {}),
        initial: initial(member.name), joined: member.created_at.slice(0, 10).replaceAll('-', '.'), color: '#eae3f8',
      }));
      return json(response, 200, { members });
    }
    if (method === 'GET' && pathname === '/api/storage') {
      requireUser(request);
      const filesystem = await statfs(dataDir);
      return json(response, 200, { availableBytes: Math.max(0, filesystem.bavail * filesystem.bsize - 16 * 1024 ** 2) });
    }
    if (method === 'POST' && pathname === '/api/folders') {
      const user = requireUser(request);
      const body = await readJson(request, 8192);
      const parent = folderPath(body.parent, true);
      const name = directoryName(body.name);
      const folder = transaction(() => {
        const state = directoryState();
        const parentKey = foldedPath(parent);
        const canonicalParent = parent ? state.explicit.find(folder => foldedPath(folder.path) === parentKey)?.path
          || [...state.paths].find(value => foldedPath(value) === parentKey) : '';
        if (parent && !canonicalParent) throw new ApiError(404, '上级文件夹不存在或已被移动。', 'FOLDER_NOT_FOUND');
        const destination = canonicalParent ? `${canonicalParent}/${name}` : name;
        if (destination.length > 3000) throw new ApiError(400, '文件夹路径过长。', 'INVALID_FOLDER');
        const key = foldedPath(destination);
        if ([...state.paths].some(value => foldedPath(value) === key) || state.notes.some(note => foldedPath(note.path) === key)) {
          throw new ApiError(409, '目标位置已有同名文件夹或文档。', 'FOLDER_EXISTS');
        }
        const now = new Date().toISOString();
        db.prepare('INSERT INTO folders(path,path_key,owner_id,created_at,updated_at) VALUES(?,?,?,?,?)')
          .run(destination, key, user.id, now, now);
        return { path: destination, ownerId: user.id };
      });
      return json(response, 201, { folder });
    }
    if (method === 'PATCH' && pathname === '/api/folders') {
      const user = requireUser(request);
      const body = await readJson(request, 8192);
      renameFolder(folderPath(body.path), directoryName(body.name), user);
      return json(response, 200, null, { representation: librarySnapshot().index });
    }
    if (method === 'DELETE' && pathname === '/api/folders') {
      const user = requireUser(request);
      const body = await readJson(request, 8192);
      const orphaned = deleteFolder(folderPath(body.path), user);
      // Prevent reuse of a reclaimed asset ID until its old file is removed.
      for (const assetId of orphaned) activeUploads.add(assetId);
      try {
        const cleanup = await Promise.allSettled(orphaned.map(assetId => rm(path.join(assetDir, assetId), { force: true })));
        // The folder transaction has committed. A filesystem cleanup failure
        // must not report that the document deletion itself failed.
        if (cleanup.some(result => result.status === 'rejected')) console.error('Could not reclaim one or more deleted-folder attachment files.');
      }
      finally { for (const assetId of orphaned) activeUploads.delete(assetId); }
      return json(response, 200, null, { representation: librarySnapshot().index });
    }
    if (['GET', 'HEAD'].includes(method) && pathname === '/api/notes/index') {
      return json(response, 200, null, { revalidate: true, representation: librarySnapshot().index });
    }
    if (['GET', 'HEAD'].includes(method) && pathname === '/api/notes/search') {
      const query = url.searchParams.get('q') || '';
      if (query.length > 16_384) throw new ApiError(400, '搜索关键词过长。', 'INVALID_SEARCH');
      return json(response, 200, null, { revalidate: true, representation: searchRepresentation(librarySnapshot(), query) });
    }
    if (['GET', 'HEAD'].includes(method) && pathname === '/api/notes') {
      const snapshot = librarySnapshot();
      snapshot.full ||= jsonRepresentation({ notes: snapshot.notes });
      return json(response, 200, null, { representation: snapshot.full });
    }
    if (method === 'POST' && (pathname === '/api/notes' || pathname === '/api/notes/import')) {
      const user = requireUser(request);
      const importing = pathname.endsWith('/import');
      const body = await readJson(request, importing ? MAX_IMPORT_BYTES : 14 * 1024 ** 2);
      if (importing && body.mode !== undefined && body.mode !== 'legacy-migration') throw new ApiError(400, '导入模式无效。', 'INVALID_IMPORT_MODE');
      const preserveExisting = importing && body.mode === 'legacy-migration';
      if (preserveExisting && user.role !== 'admin') throw new ApiError(403, '只有管理员可以迁移旧版浏览器知识库。', 'ADMIN_REQUIRED');
      const input = importing ? body.notes : [body.note ?? body];
      if (!Array.isArray(input) || input.length > MAX_IMPORT_NOTES || input.length === 0) throw new ApiError(400, '导入笔记数量需为 1—20,000 篇。', 'INVALID_IMPORT');
      const prepared = [];
      const duplicateIds = new Set();
      let totalContent = 0;
      for (const item of input) {
        if (Object.hasOwn(item || {}, 'migrationAlias') && (!preserveExisting || item.migrationAlias !== true)) {
          throw new ApiError(400, '旧版迁移别名不能用于普通导入。', 'INVALID_IMPORT_MODE');
        }
        const note = cleanNote(item, user);
        if (duplicateIds.has(note.id)) throw new ApiError(409, '本次导入有重复的笔记编号。', 'DUPLICATE_NOTE');
        duplicateIds.add(note.id);
        totalContent += Buffer.byteLength(note.content);
        if (totalContent > MAX_ASSET_BYTES) throw new ApiError(413, '单次导入正文总量不能超过 500 MB。', 'IMPORT_TOO_LARGE');
        prepared.push({ note, aliasOnly: preserveExisting && item.migrationAlias === true });
      }
      const output = transaction(() => {
        const state = directoryState();
        const idMap = new Map();
        if (importing) {
          const paths = new Map();
          for (const existing of state.notes) {
            const key = foldedPath(existing.path);
            if (!paths.has(key)) paths.set(key, []);
            paths.get(key).push(existing.id);
          }
          const batchPaths = new Set();
          for (const entry of prepared) {
            const key = normalizedNotePath(entry.note);
            if (!key) throw new ApiError(400, '导入笔记的完整路径无效。', 'INVALID_NOTE');
            if (batchPaths.has(key)) throw new ApiError(409, '本次导入有完整路径和文件名相同的笔记，请先移除重复文件。', 'DUPLICATE_NOTE_PATH');
            batchPaths.add(key);
            const candidates = paths.get(key) || [];
            if (candidates.length > 1) throw new ApiError(409, '知识库中此完整路径对应多篇历史笔记，请先重命名重复文档。', 'NOTE_PATH_AMBIGUOUS');
            const sameId = queryNote.get(entry.note.id);
            if (sameId && normalizedNotePath(JSON.parse(sameId.data)) !== key) {
              throw new ApiError(409, '笔记编号已用于其他路径，不能通过导入移动或覆盖其他文档。', 'NOTE_ID_CONFLICT');
            }
            const existing = candidates.length ? queryNote.get(candidates[0]) : null;
            if (entry.aliasOnly && !existing) throw new ApiError(409, '待迁移链接的目标文档已被移动或删除，请重新迁移。', 'MIGRATION_TARGET_CHANGED');
            if (existing && !preserveExisting && existing.owner_id !== user.id && !existing.collaborative) throw new ApiError(403, '同路径笔记仅作者可以修改，无法覆盖导入。', 'NOTE_READ_ONLY');
            if (existing) entry.existing = existing;
            idMap.set(entry.note.id, existing?.id || entry.note.id);
          }
          // Resolve every source ID before rewriting: cycles and links from
          // newly created notes to overwritten notes retain stable targets.
          const changedIds = new Map([...idMap].filter(([source, target]) => source !== target));
          let rewrittenBytes = 0;
          for (const entry of prepared) {
            if (preserveExisting && entry.existing) continue;
            const owner = entry.existing ? db.prepare('SELECT * FROM users WHERE id = ?').get(entry.existing.owner_id) : user;
            const targetPath = entry.existing ? notePath(JSON.parse(entry.existing.data)) : notePath(entry.note);
            entry.note = cleanNote({ ...entry.note, path: targetPath,
              content: remapImportedNoteLinks(entry.note.content, changedIds) }, owner, entry.existing);
            rewrittenBytes += Buffer.byteLength(entry.note.content);
            if (rewrittenBytes > MAX_ASSET_BYTES) throw new ApiError(413, '单次导入正文总量不能超过 500 MB。', 'IMPORT_TOO_LARGE');
          }
          // Files may never occupy an explicit/implicit directory, including
          // directories introduced by another file in this same atomic batch.
          const folders = new Set([...state.paths].map(foldedPath));
          const files = new Set(state.notes.map(note => foldedPath(note.path)));
          for (const { note } of prepared) {
            const parts = notePath(note).split('/');
            parts.pop();
            for (let count = 1; count <= parts.length; count++) folders.add(foldedPath(parts.slice(0, count).join('/')));
          }
          for (const { note } of prepared) {
            const target = normalizedNotePath(note);
            const parts = notePath(note).split('/');
            parts.pop();
            if (folders.has(target) || parts.some((_, index) => files.has(foldedPath(parts.slice(0, index + 1).join('/'))))) {
              throw new ApiError(409, '导入路径与已有文档或文件夹冲突。', 'NOTE_PATH_EXISTS');
            }
          }
        } else {
          if (queryNote.get(prepared[0].note.id)) throw new ApiError(409, '笔记编号已存在，请刷新后重试。', 'NOTE_EXISTS');
          assertNoteDestination(prepared[0].note, state);
        }
        // Validate before changing any references: a shared attachment used by
        // another note in this batch must remain visible throughout preflight.
        for (const entry of prepared) if (!preserveExisting || !entry.existing) entry.references = validateReferences(entry.note, user);
        const notes = prepared.map((entry) => {
          if (preserveExisting && entry.existing) return noteOutput(entry.existing);
          const note = entry.note;
          if (entry.existing) {
            // UPDATE retains reading totals/sessions, incoming links, owner,
            // sharing and creation time. Never replace the parent SQLite row.
            db.prepare('UPDATE notes SET data = ?, revision = revision + 1, updated_at = ? WHERE id = ?')
              .run(JSON.stringify(note), note.updatedAt, note.id);
          } else {
            db.prepare('INSERT INTO notes(id,owner_id,data,created_at,updated_at) VALUES(?,?,?,?,?)')
              .run(note.id, user.id, JSON.stringify(note), note.updatedAt, note.updatedAt);
          }
          updateReferences(note.id, entry.references);
          return noteOutput(queryNote.get(note.id));
        });
        return { notes, createdCount: prepared.filter(entry => !entry.existing).length,
          updatedCount: preserveExisting ? 0 : prepared.filter(entry => entry.existing).length,
          ...(preserveExisting ? { skippedCount: prepared.filter(entry => entry.existing).length } : {}) };
      });
      return json(response, 201, importing ? output : { note: output.notes[0] });
    }
    const renameMatch = /^\/api\/notes\/([^/]+)\/rename$/.exec(pathname);
    if (method === 'PATCH' && renameMatch) {
      const user = requireUser(request);
      const id = assertId(decodeURIComponent(renameMatch[1]));
      const body = await readJson(request, 8192);
      const name = directoryName(body.name, true);
      const note = transaction(() => {
        const current = queryNote.get(id);
        if (!current) throw new ApiError(404, '笔记不存在或已被删除。', 'NOTE_NOT_FOUND');
        if (current.owner_id !== user.id && !current.collaborative) throw new ApiError(403, '这篇笔记仅作者可以修改。', 'NOTE_READ_ONLY');
        if (body.revision !== undefined && body.revision !== current.revision) throw new ApiError(409, '笔记已被其他人更新，请刷新后再编辑。', 'REVISION_CONFLICT');
        const original = JSON.parse(current.data);
        const previousPath = notePath(original);
        const parent = path.posix.dirname(previousPath);
        const destination = parent === '.' ? `${name}.md` : `${parent}/${name}.md`;
        if (destination.length > 3000) throw new ApiError(400, '重命名后的路径过长。', 'INVALID_NOTE');
        if (previousPath === destination && original.title === name) return noteOutput(current);
        assertNoteDestination({ ...original, path: destination }, directoryState(), id);
        const now = new Date().toISOString();
        db.prepare("UPDATE notes SET data = json_set(data, '$.title', ?, '$.path', ?, '$.updatedAt', ?), revision = revision + 1, updated_at = ? WHERE id = ?")
          .run(name, destination, now, now, id);
        return noteOutput(queryNote.get(id));
      });
      return json(response, 200, { note });
    }
    const sharingMatch = /^\/api\/notes\/([^/]+)\/sharing$/.exec(pathname);
    if (method === 'PATCH' && sharingMatch) {
      const user = requireUser(request);
      if (user.role !== 'admin') throw new ApiError(403, '只有管理员可以设置全员编辑。', 'ADMIN_REQUIRED');
      const id = assertId(decodeURIComponent(sharingMatch[1]));
      if (!queryNote.get(id)) throw new ApiError(404, '笔记不存在或已被删除。', 'NOTE_NOT_FOUND');
      const body = await readJson(request, 1024);
      if (typeof body.collaborative !== 'boolean') throw new ApiError(400, '请指定是否允许全员编辑。', 'INVALID_SHARING');
      if (!queryNote.get(id)) throw new ApiError(404, '笔记不存在或已被删除。', 'NOTE_NOT_FOUND');
      db.prepare('UPDATE notes SET collaborative = ?, revision = revision + 1 WHERE id = ?').run(body.collaborative ? 1 : 0, id);
      return json(response, 200, { note: noteOutput(queryNote.get(id)) });
    }
    const backlinksMatch = /^\/api\/notes\/([^/]+)\/backlinks$/.exec(pathname);
    if (['GET', 'HEAD'].includes(method) && backlinksMatch) {
      const id = assertId(decodeURIComponent(backlinksMatch[1]));
      const snapshot = librarySnapshot();
      if (!snapshot.notesById.has(id)) throw new ApiError(404, '笔记不存在或已被删除。', 'NOTE_NOT_FOUND');
      return json(response, 200, null, { revalidate: true, representation: backlinksRepresentation(snapshot, id) });
    }
    const noteMatch = /^\/api\/notes\/([^/]+)$/.exec(pathname);
    if (noteMatch) {
      const id = assertId(decodeURIComponent(noteMatch[1]));
      if (['GET', 'HEAD'].includes(method)) {
        const snapshot = librarySnapshot();
        const note = snapshot.notesById.get(id);
        if (!note) throw new ApiError(404, '笔记不存在或已被删除。', 'NOTE_NOT_FOUND');
        if (!snapshot.details.has(id)) snapshot.details.set(id, jsonRepresentation({ note }));
        return json(response, 200, null, { revalidate: true, representation: snapshot.details.get(id) });
      }
      const row = queryNote.get(id);
      if (!row) throw new ApiError(404, '笔记不存在或已被删除。', 'NOTE_NOT_FOUND');
      const user = requireUser(request);
      if (method === 'DELETE') {
        if (row.owner_id !== user.id) throw new ApiError(403, '只能删除自己的笔记。', 'OWNER_REQUIRED');
        const references = db.prepare('SELECT asset_id FROM note_assets WHERE note_id = ?').all(id);
        db.prepare('DELETE FROM notes WHERE id = ?').run(id);
        for (const { asset_id: assetId } of references) {
          if (!assetReferences.get(assetId)) {
            db.prepare('DELETE FROM assets WHERE id = ?').run(assetId);
            await rm(path.join(assetDir, assetId), { force: true });
          }
        }
        response.writeHead(204); response.end(); return;
      }
      if (method === 'PATCH') {
        const body = await readJson(request, 14 * 1024 ** 2);
        const updated = transaction(() => {
          // The body upload can yield to another request. Re-read permissions,
          // revision and destination together under the same SQLite write lock.
          const current = queryNote.get(id);
          if (!current) throw new ApiError(404, '笔记不存在或已被删除。', 'NOTE_NOT_FOUND');
          if (current.owner_id !== user.id && !current.collaborative) throw new ApiError(403, '这篇笔记仅作者可以修改。', 'NOTE_READ_ONLY');
          if (body.revision !== undefined && body.revision !== current.revision) throw new ApiError(409, '笔记已被其他人更新，请刷新后再编辑。', 'REVISION_CONFLICT');
          const owner = db.prepare('SELECT * FROM users WHERE id = ?').get(current.owner_id);
          const note = cleanNote(body.note ?? body, owner, current);
          // Existing imports may contain repeated paths. Ordinary edits remain
          // possible, but a move cannot overwrite another file or a directory.
          if (normalizedNotePath(note) !== normalizedNotePath(JSON.parse(current.data))) assertNoteDestination(note, directoryState(), id);
          const references = validateReferences(note, user);
          db.prepare('UPDATE notes SET data = ?, revision = revision + 1, updated_at = ? WHERE id = ?')
            .run(JSON.stringify(note), note.updatedAt, id);
          updateReferences(id, references);
          return noteOutput(queryNote.get(id));
        });
        return json(response, 200, { note: updated });
      }
    }
    const assetMatch = /^\/api\/assets\/([^/]+)$/.exec(pathname);
    if (assetMatch) {
      const id = assertId(decodeURIComponent(assetMatch[1]));
      const destination = path.join(assetDir, id);
      const existing = queryAsset.get(id);
      if (method === 'GET' || method === 'HEAD') {
        if (!existing) throw new ApiError(404, '附件不存在。', 'ASSET_NOT_FOUND');
        const viewer = currentUser(request);
        if (existing.owner_id !== viewer?.id && !assetReferences.get(id)) throw new ApiError(404, '附件不存在。', 'ASSET_NOT_FOUND');
        return serveFile(request, response, destination, {
          mime: existing.mime,
          disposition: `inline; filename*=UTF-8''${encodeURIComponent(path.basename(existing.path))}`,
          asset: true,
        });
      }
      const user = requireUser(request);
      if (method === 'DELETE') {
        if (!existing) { response.writeHead(204); response.end(); return; }
        if (existing.owner_id !== user.id) throw new ApiError(403, '只能删除自己上传的附件。', 'OWNER_REQUIRED');
        if (assetReferences.get(id)) throw new ApiError(409, '附件仍被笔记使用，无法删除。', 'ASSET_IN_USE');
        db.prepare('DELETE FROM assets WHERE id = ?').run(id);
        await rm(destination, { force: true });
        response.writeHead(204); response.end(); return;
      }
      if (method === 'POST') {
        if (existing || activeUploads.has(id)) throw new ApiError(409, '附件编号已存在。', 'ASSET_EXISTS');
        const declared = Number(request.headers['content-length']);
        if (Number.isFinite(declared) && declared > MAX_ASSET_BYTES) throw new ApiError(413, '单个附件不能超过 500 MB。', 'ASSET_TOO_LARGE');
        const filesystem = await statfs(dataDir);
        if (Number.isFinite(declared) && declared > filesystem.bavail * filesystem.bsize - 16 * 1024 ** 2) {
          throw new ApiError(507, '服务器存储空间不足，请清理后重试。', 'STORAGE_FULL');
        }
        // statfs yields; reserve the ID only after rechecking concurrent uploads.
        if (queryAsset.get(id) || activeUploads.has(id)) throw new ApiError(409, '附件编号已存在。', 'ASSET_EXISTS');
        let assetPath;
        try { assetPath = decodeURIComponent(String(request.headers['x-asset-path'] || id)); }
        catch { throw new ApiError(400, '附件路径格式无效。', 'INVALID_ASSET'); }
        if (!assetPath || assetPath.length > 3000 || /[\u0000-\u001f]/.test(assetPath)) throw new ApiError(400, '附件路径格式无效。', 'INVALID_ASSET');
        const suppliedMime = String(request.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        const mime = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i.test(suppliedMime) ? suppliedMime : MIME_TYPES[path.extname(assetPath).toLowerCase()] || 'application/octet-stream';
        const temporary = path.join(assetDir, `.${id}-${randomUUID()}.upload`);
        let size = 0;
        activeUploads.add(id);
        try {
          const counter = new Transform({ transform(chunk, _encoding, callback) {
            size += chunk.length;
            callback(size > MAX_ASSET_BYTES ? new ApiError(413, '单个附件不能超过 500 MB。', 'ASSET_TOO_LARGE') : null, chunk);
          } });
          await pipeline(request, counter, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
          await rename(temporary, destination);
          db.prepare('INSERT INTO assets(id,owner_id,path,mime,size,created_at) VALUES(?,?,?,?,?,?)')
            .run(id, user.id, assetPath, mime, size, new Date().toISOString());
          return json(response, 201, { asset: { id, path: assetPath, size, mime } });
        } catch (error) {
          await rm(temporary, { force: true });
          if (!queryAsset.get(id)) await rm(destination, { force: true });
          if (error.code === 'ENOSPC') throw new ApiError(507, '服务器存储空间不足，请清理后重试。', 'STORAGE_FULL');
          throw error;
        } finally { activeUploads.delete(id); }
      }
    }
    throw new ApiError(404, '接口不存在。', 'NOT_FOUND');
  }

  const staticBodies = new Map();
  let staticBodyBytes = 0;
  async function serveFile(request, response, filename, options = {}) {
    let info;
    try { info = await stat(filename); }
    catch { throw new ApiError(404, '文件不存在。', 'FILE_NOT_FOUND'); }
    if (!info.isFile()) throw new ApiError(404, '文件不存在。', 'FILE_NOT_FOUND');
    const mime = options.mime || MIME_TYPES[path.extname(filename).toLowerCase()] || 'application/octet-stream';
    const compressible = /^(?:text\/|application\/(?:javascript|json)|image\/svg\+xml)/i.test(mime);
    const immutable = /^assets\/[^/]+-[A-Za-z0-9_-]{6,}\.[^.]+$/.test(path.relative(distDir, filename).replace(/\\/g, '/'));
    const headers = {
      'Content-Type': mime, 'X-Content-Type-Options': 'nosniff',
      'Cache-Control': options.asset ? 'private, no-cache' : immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      'Accept-Ranges': 'bytes',
      'Last-Modified': info.mtime.toUTCString(),
      ETag: `W/"${info.size.toString(16)}-${info.mtimeMs.toString(16)}"`,
    };
    if (options.disposition) headers['Content-Disposition'] = options.disposition;
    if (options.asset) headers['Content-Security-Policy'] = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
    let cached;
    if (!options.asset && compressible && info.size <= 8 * 1024 ** 2) {
      const key = `${filename}:${info.size}:${info.mtimeMs}`;
      cached = staticBodies.get(key);
      if (!cached) {
        cached = representation(await readFile(filename));
        while (staticBodies.size && (staticBodies.size >= 32 || staticBodyBytes + cached.raw.length > 16 * 1024 ** 2)) {
          const first = staticBodies.keys().next().value;
          staticBodyBytes -= staticBodies.get(first).raw.length;
          staticBodies.delete(first);
        }
        staticBodies.set(key, cached);
        staticBodyBytes += cached.raw.length;
      }
      headers.ETag = cached.etag;
    }
    if (!options.asset && compressible) headers.Vary = 'Accept-Encoding';
    if (matchesEtag(request, headers.ETag)) { response.writeHead(304, headers); response.end(); return; }
    let start = 0, end = info.size - 1, status = 200;
    if (request.headers.range && info.size > 0) {
      const range = /^bytes=(\d*)-(\d*)$/.exec(String(request.headers.range));
      if (range && (range[1] || range[2])) {
        if (!range[1]) start = Math.max(0, info.size - Number(range[2]));
        else { start = Number(range[1]); if (range[2]) end = Math.min(end, Number(range[2])); }
        if (start > end || start >= info.size) {
          response.writeHead(416, { 'Content-Range': `bytes */${info.size}` }); response.end(); return;
        }
        status = 206; headers['Content-Range'] = `bytes ${start}-${end}/${info.size}`;
      }
    }
    if (!options.asset && compressible && status === 200) {
      const encoding = acceptedEncoding(request);
      if (cached) {
        const encoded = await encodedRepresentation(cached, encoding);
        if (response.destroyed) return;
        if (encoded.encoding) headers['Content-Encoding'] = encoded.encoding;
        headers['Content-Length'] = encoded.body.length;
        response.writeHead(status, headers);
        response.end(request.method === 'HEAD' ? undefined : encoded.body);
        return;
      }
      if (encoding && info.size >= 1024) {
        headers['Content-Encoding'] = encoding;
        response.writeHead(status, headers);
        if (request.method === 'HEAD') { response.end(); return; }
        await pipeline(createReadStream(filename), encoding === 'br' ? createBrotliCompress(brotliOptions) : createGzip({ level: 4 }), response);
        return;
      }
    }
    headers['Content-Length'] = Math.max(0, end - start + 1);
    response.writeHead(status, headers);
    if (request.method === 'HEAD' || info.size === 0) { response.end(); return; }
    await pipeline(createReadStream(filename, { start, end }), response);
  }

  const server = http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    try {
      const url = new URL(request.url || '/', 'http://localhost');
      if (url.pathname.startsWith('/api/')) await api(request, response, url);
      else {
        if (!['GET', 'HEAD'].includes(request.method || 'GET')) throw new ApiError(405, '不支持的请求方法。', 'METHOD_NOT_ALLOWED');
        let requested;
        try { requested = decodeURIComponent(url.pathname); }
        catch { throw new ApiError(400, 'URL 格式无效。', 'INVALID_URL'); }
        if (requested.includes('\u0000')) throw new ApiError(400, 'URL 格式无效。', 'INVALID_URL');
        let filename = path.resolve(distDir, `.${requested}`);
        if (filename !== distDir && !filename.startsWith(`${distDir}${path.sep}`)) throw new ApiError(403, '无法访问该路径。', 'FORBIDDEN');
        try { if (!(await stat(filename)).isFile()) filename = path.join(distDir, 'index.html'); }
        catch {
          if (path.extname(requested) && requested !== '/index.html') throw new ApiError(404, '文件不存在。', 'FILE_NOT_FOUND');
          filename = path.join(distDir, 'index.html');
        }
        await serveFile(request, response, filename);
      }
    } catch (error) {
      if (response.headersSent || response.destroyed) { if (!response.writableEnded) response.destroy(); return; }
      const status = error.status || (error.code === 'ENOSPC' || error.code === 'SQLITE_FULL' ? 507 : 500);
      if (status >= 500) console.error('Request failed:', error.code || error.name, error.message);
      await json(response, status, { error: error.status ? error.message : status === 507 ? '服务器存储空间不足。' : '服务器处理失败，请稍后重试。', code: error.code || 'INTERNAL_ERROR' });
    }
  });
  server.requestTimeout = 30 * 60 * 1000;
  server.headersTimeout = 60 * 1000;
  server.keepAliveTimeout = 5000;
  server.on('close', () => db.close());
  // Build and compress the small directory before accepting requests. The first
  // page visit then gets the same cached representation as later refreshes.
  const initialIndex = librarySnapshot().index;
  await Promise.all([encodedRepresentation(initialIndex, 'gzip'), encodedRepresentation(initialIndex, 'br')]);
  return { server, dataDir, databasePath };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { server } = await createKnowledgeServer();
  const host = process.env.HOST || '0.0.0.0';
  const port = Number(process.env.PORT || 5175);
  server.listen(port, host, () => console.log(`Knowledge base listening on ${host}:${port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
}
