import type { ImportedAsset, ImportedNote } from './importer';
import { getNotePath } from './library';
import { isExcludedPath } from './privacy';
import { administrator, normalizeCurrentUser, roleForEmail, type LocalUser } from './workspace';
import { apiRequest, notesApi, ApiError } from './api';

const builtInDemoIds = new Set(['note-1', 'note-2', 'note-3', 'note-4', 'note-5', 'note-6']);
const formerDemoAuthors = new Set(['林予', '陈一', '苏禾', '周也']);
const cleanupMarker = 'zhiyu-workspace-cleanup-v1';
const importedDemoSignatures = [
  {
    title: '欢迎来到你的知识岛屿',
    paragraphs: ['这是一个可以实际导入的 Obsidian 示例库，包含三篇笔记和一张图片。', '## 图片也一起搬过来了', '## 试试笔记之间的连接'],
  },
  {
    title: '我的知识工作流',
    paragraphs: ['1. 捕捉随手的灵感。', '2. 用文件夹组织大的主题。', '3. 用双向链接连接相近的想法。', '4. 定期回顾，让知识产生新的价值。'],
  },
  {
    title: 'Markdown 写作入门',
    paragraphs: ['用简单的语法，表达清晰的内容。', '- **加粗重点**', '- 为想法添加链接', '> 知识的价值，在于它们之间的连接。'],
  },
];

function isDemoNote(note: ImportedNote): boolean {
  return builtInDemoIds.has(note.id) || importedDemoSignatures.some((demo) =>
    note.title === demo.title && demo.paragraphs.every((paragraph) => note.content.includes(paragraph)));
}

/** Remove shipped examples and the excluded private folder, preserving real notes. */
export function sanitizeWorkspaceNotes(notes: ImportedNote[]): ImportedNote[] {
  return notes.filter((note) => !isDemoNote(note) && !isExcludedPath(getNotePath(note))).map((note) =>
    formerDemoAuthors.has(note.author)
      ? { ...note, author: administrator.name, avatar: administrator.initial, color: administrator.color }
      : note);
}

export function sanitizeFavorites(ids: string[], removedIds: Iterable<string> = []): string[] {
  const excluded = new Set([...builtInDemoIds, ...removedIds]);
  return [...new Set(ids.filter((id) => typeof id === 'string' && !excluded.has(id)))];
}

/** Match server path identity without changing or deleting the legacy source. */
export function getPendingLegacyNotes(localNotes: ImportedNote[], serverNotes: ImportedNote[]): ImportedNote[] {
  const pathKey = (note: ImportedNote) => {
    const parts: string[] = [];
    for (const part of getNotePath(note).split('/')) {
      if (part === '..') parts.pop();
      else parts.push(part);
    }
    return parts.join('/').normalize('NFC').toLocaleLowerCase();
  };
  const ids = new Set(serverNotes.map(note => note.id));
  const paths = new Set(serverNotes.map(pathKey));
  return localNotes.filter(note => !ids.has(note.id) && !paths.has(pathKey(note)));
}

function readLegacyValue(key: string): unknown {
  try { return JSON.parse(localStorage.getItem(key) || 'null'); }
  catch { return null; }
}

function writeLegacyValue(key: string, value: unknown): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch { /* A storage restriction must not prevent this session's cleanup. */ }
}

/** Synchronous legacy cleanup for React's initial state, safe to run repeatedly. */
export function migrateLocalWorkspace(): { notes: ImportedNote[] | null; favorites: string[] } {
  const legacy = readLegacyValue('zhiyu-notes-v1');
  const original: ImportedNote[] = Array.isArray(legacy) ? legacy : [];
  const notes = Array.isArray(legacy) ? sanitizeWorkspaceNotes(original) : null;
  if (notes) writeLegacyValue('zhiyu-notes-v1', notes);
  const keptIds = new Set(notes?.map((note) => note.id) || []);
  const removedIds = original.filter((note) => !keptIds.has(note.id)).map((note) => note.id);
  const storedFavorites = readLegacyValue('zhiyu-stars-v1');
  const favorites = sanitizeFavorites(Array.isArray(storedFavorites) ? storedFavorites : [], removedIds);
  writeLegacyValue('zhiyu-stars-v1', favorites);
  const existingProfile = normalizeCurrentUser(readLegacyValue('zhiyu-user-v1') as LocalUser | null);
  const firstCleanup = readLegacyValue(cleanupMarker) !== true;
  const profile = firstCleanup && roleForEmail(existingProfile?.email) !== '空间管理员' ? null : existingProfile;
  writeLegacyValue('zhiyu-user-v1', profile);
  writeLegacyValue(cleanupMarker, true);
  return { notes, favorites };
}

const databaseName = 'zhiyu-knowledge';
const assetBatchBytes = 8 * 1024 * 1024;
let database: Promise<IDBDatabase> | undefined;

function storageError(error: unknown, fallback = '本地保存失败，请检查浏览器存储空间'): Error {
  if (error instanceof Error && (error.name === 'QuotaExceededError' || /quota|disk.*full/i.test(error.message))) {
    return new Error('浏览器可用存储空间不足。请清理磁盘或此站点的其他数据后重试；已有知识库不会被覆盖。');
  }
  return error instanceof Error ? error : new Error(fallback);
}

function openDatabase(): Promise<IDBDatabase> {
  if (!database) database = new Promise<IDBDatabase>((resolve, reject) => {
    if (!globalThis.indexedDB) { reject(new Error('当前浏览器未启用本地数据库')); return; }
    const request = indexedDB.open(databaseName, 2);
    let blocked = false;
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('workspace')) db.createObjectStore('workspace');
      if (!db.objectStoreNames.contains('assets')) db.createObjectStore('assets');
    };
    request.onsuccess = () => {
      const db = request.result;
      if (blocked) { db.close(); return; }
      db.onversionchange = () => { db.close(); database = undefined; };
      resolve(db);
    };
    request.onerror = () => reject(storageError(request.error, '无法打开本地数据库'));
    request.onblocked = () => {
      blocked = true;
      reject(new Error('其他标签页仍在使用旧版数据库，请关闭本网站的其他标签页后重试。'));
    };
  }).catch(error => { database = undefined; throw error; });
  return database;
}

/** Check available browser storage when the browser exposes quota estimates. */
export async function ensureLocalStorageCapacity(requiredBytes: number): Promise<void> {
  if (!navigator.storage?.estimate || requiredBytes <= 0) return;
  let estimate: StorageEstimate;
  try { estimate = await navigator.storage.estimate(); }
  catch { return; }
  if (typeof estimate.quota === 'number' && typeof estimate.usage === 'number'
      && estimate.quota - estimate.usage < requiredBytes * 1.1) {
    throw new Error(`浏览器剩余存储空间不足，需要约 ${Math.ceil(requiredBytes * 1.1 / 1024 / 1024).toLocaleString('zh-CN')} MB。请释放磁盘空间后重试。`);
  }
}

export interface AssetSaveProgress { completed: number; total: number; bytes: number; totalBytes: number }

/** Store binary attachments in small transactions, without duplicating them in note text. */
export async function saveLocalAssets(assets: ImportedAsset[], onProgress?: (progress: AssetSaveProgress) => void): Promise<void> {
  if (!assets.length) return;
  const totalBytes = assets.reduce((total, asset) => total + asset.blob.size, 0);
  onProgress?.({ completed: 0, total: assets.length, bytes: 0, totalBytes });
  await ensureLocalStorageCapacity(totalBytes);
  const db = await openDatabase();
  let completed = 0;
  let bytes = 0;
  while (completed < assets.length) {
    let end = completed;
    let batchBytes = 0;
    while (end < assets.length && (end === completed || batchBytes + assets[end].blob.size <= assetBatchBytes)) {
      batchBytes += assets[end].blob.size;
      end += 1;
    }
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('assets', 'readwrite');
      const store = transaction.objectStore('assets');
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(storageError(transaction.error));
      transaction.onabort = () => reject(storageError(transaction.error, '附件保存已中断，请重试'));
      try {
        for (let index = completed; index < end; index += 1) {
          const asset = assets[index];
          store.put({ id: asset.id, path: asset.path, blob: asset.blob }, asset.id);
        }
      } catch (error) {
        transaction.abort();
        reject(storageError(error));
      }
    });
    completed = end;
    bytes += batchBytes;
    onProgress?.({ completed, total: assets.length, bytes, totalBytes });
  }
}

export async function getLegacyAsset(id: string): Promise<ImportedAsset | null> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction('assets', 'readonly').objectStore('assets').get(id);
    request.onsuccess = () => {
      const value = request.result as ImportedAsset | undefined;
      resolve(value?.blob instanceof Blob ? value : null);
    };
    request.onerror = () => reject(storageError(request.error, '附件读取失败，请刷新后重试'));
  });
}

export async function getLegacyBlob(id: string): Promise<Blob | null> {
  return (await getLegacyAsset(id))?.blob || null;
}

/** Remove only the new asset IDs from an import whose note commit failed. */
export async function deleteLocalAssets(ids: string[]): Promise<void> {
  if (!ids.length) return;
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction('assets', 'readwrite');
    const store = transaction.objectStore('assets');
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(storageError(transaction.error));
    transaction.onabort = () => reject(storageError(transaction.error, '附件清理已中断'));
    for (const id of ids) store.delete(id);
  });
}

export async function loadLegacyNotes(): Promise<ImportedNote[] | null> {
  const db = await openDatabase();
  const stored = await new Promise<ImportedNote[] | null>((resolve, reject) => {
    const request = db.transaction('workspace', 'readonly').objectStore('workspace').get('notes');
    request.onsuccess = () => resolve(Array.isArray(request.result) ? request.result : null);
    request.onerror = () => reject(request.error);
  });
  if (!stored) return null;
  const notes = sanitizeWorkspaceNotes(stored);
  if (notes.length !== stored.length || notes.some((note, index) => note !== stored[index])) await saveLocalNotes(notes);
  return notes;
}

export async function saveLocalNotes(notes: ImportedNote[]): Promise<void> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('workspace', 'readwrite');
    transaction.objectStore('workspace').put(sanitizeWorkspaceNotes(notes), 'notes');
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(storageError(transaction.error));
    transaction.onabort = () => reject(storageError(transaction.error, '本地保存已中断'));
  });
}

/** Shared notes and attachments are persisted on the Orange Pi. */
export const loadNotes = notesApi.list;

export async function ensureStorageCapacity(requiredBytes: number): Promise<void> {
  if (requiredBytes <= 0) return;
  const capacity = await apiRequest<{ availableBytes: number }>('/storage');
  if (capacity.availableBytes < requiredBytes * 1.1) {
    throw new Error('服务器剩余存储空间不足，请释放空间后重试。');
  }
}

export async function saveAssets(assets: ImportedAsset[], onProgress?: (progress: AssetSaveProgress) => void): Promise<void> {
  const totalBytes = assets.reduce((sum, asset) => sum + asset.blob.size, 0);
  let completed = 0;
  let bytes = 0;
  onProgress?.({ completed, total: assets.length, bytes, totalBytes });
  for (const asset of assets) {
    await new Promise<void>((resolve, reject) => {
      const request = new XMLHttpRequest();
      request.open('POST', `/api/assets/${encodeURIComponent(asset.id)}`);
      request.withCredentials = true;
      request.setRequestHeader('Content-Type', asset.blob.type || 'application/octet-stream');
      request.setRequestHeader('X-Asset-Path', encodeURIComponent(asset.path));
      request.upload.onprogress = event => onProgress?.({ completed, total: assets.length, bytes: bytes + event.loaded, totalBytes });
      request.onload = () => {
        if (request.status >= 200 && request.status < 300) { resolve(); return; }
        let message = '附件上传失败，请稍后重试。';
        try { message = JSON.parse(request.responseText).error || message; } catch { /* Preserve the readable fallback. */ }
        if (request.status === 401) window.dispatchEvent(new Event('session-expired'));
        reject(new ApiError(message, request.status));
      };
      request.onerror = () => reject(new Error('上传连接中断，请检查网络后重试。'));
      request.onabort = () => reject(new Error('附件上传已中断，请重试。'));
      request.send(asset.blob);
    });
    completed += 1;
    bytes += asset.blob.size;
    onProgress?.({ completed, total: assets.length, bytes, totalBytes });
  }
}

export async function deleteAssets(ids: string[]): Promise<void> {
  let firstFailure: unknown;
  for (let start = 0; start < ids.length; start += 20) {
    const results = await Promise.allSettled(ids.slice(start, start + 20).map(id => apiRequest<void>(`/assets/${encodeURIComponent(id)}`, { method: 'DELETE' })));
    for (const result of results) if (result.status === 'rejected') firstFailure ??= result.reason;
  }
  if (firstFailure) throw firstFailure;
}
