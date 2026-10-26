import type { ImportedNote } from './importer';
import { apiRequest, type SessionUser } from './api';

export interface LibraryTotals {
  notes: number;
  attachments: number;
  contentBytes: number;
  attachmentBytes: number;
}
export interface NoteIndexEntry extends Omit<ImportedNote, 'content' | 'attachments' | 'attachmentSizes'> {
  contentBytes: number;
  attachmentCount: number;
  attachmentBytes: number;
  excerpt: string;
}
export interface WorkspaceFolder { path: string; ownerId: string }
export interface LibraryIndex { notes: NoteIndexEntry[]; totals: LibraryTotals; folders?: WorkspaceFolder[] }

const IDENTITY_KEY = 'zhiyu-session-display-v1';
const documents = new Map<string, ImportedNote>();
const requests = new Map<string, Promise<ImportedNote>>();
const documentGenerations = new Map<string, number>();
const MAX_DOCUMENTS = 60;
let database: Promise<IDBDatabase> | undefined;

function openCache(): Promise<IDBDatabase> {
  if (!database) database = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('zhiyu-server-cache-v1', 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('index')) db.createObjectStore('index');
      const store = db.objectStoreNames.contains('documents') ? request.transaction!.objectStore('documents') : db.createObjectStore('documents', { keyPath: 'id' });
      if (!store.indexNames.contains('cachedAt')) store.createIndex('cachedAt', 'cachedAt');
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => { request.result.close(); database = undefined; };
      resolve(request.result);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Cache unavailable'));
  }).catch(error => { database = undefined; throw error; });
  return database;
}

async function readCache<T>(store: string, key: string): Promise<T | undefined> {
  try {
    const db = await openCache();
    return await new Promise<T | undefined>((resolve, reject) => {
      const request = db.transaction(store).objectStore(store).get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } catch { return undefined; }
}

/** Browser storage is only a disposable read cache. Server writes never depend on it. */
export const readCachedIndex = () => readCache<LibraryIndex>('index', 'current');
export async function cacheIndex(index: LibraryIndex): Promise<void> {
  try {
    const db = await openCache();
    const transaction = db.transaction(['index', 'documents'], 'readwrite');
    transaction.objectStore('index').put(index, 'current');
    const valid = new Set(index.notes.map(note => note.id));
    const store = transaction.objectStore('documents');
    const cursor = store.openKeyCursor();
    cursor.onsuccess = () => {
      const item = cursor.result;
      if (!item) return;
      if (!valid.has(String(item.key))) store.delete(item.primaryKey);
      item.continue();
    };
    for (const id of new Set([...documents.keys(), ...requests.keys()])) if (!valid.has(id)) {
      documents.delete(id);documentGenerations.set(id, (documentGenerations.get(id) || 0) + 1);
    }
  } catch { /* Storage restrictions must not block the live library. */ }
}

export function cacheDocument(note: ImportedNote): void {
  const newer = documents.get(note.id);
  if (newer?.revision !== undefined && note.revision !== undefined && newer.revision > note.revision) return;
  documents.delete(note.id);
  documents.set(note.id, note);
  while (documents.size > MAX_DOCUMENTS) documents.delete(documents.keys().next().value!);
  void openCache().then(db => {
    const store = db.transaction('documents', 'readwrite').objectStore('documents');
    store.put({ ...note, cachedAt: Date.now() });
    const request = store.count();
    request.onsuccess = () => {
      let excess = request.result - MAX_DOCUMENTS;
      if (excess <= 0) return;
      const cursor = store.index('cachedAt').openKeyCursor();
      cursor.onsuccess = () => {
        const item = cursor.result;
        if (!item || excess-- <= 0) return;
        store.delete(item.primaryKey);item.continue();
      };
    };
  }).catch(() => {});
}

export function forgetDocument(id: string): void {
  documentGenerations.set(id, (documentGenerations.get(id) || 0) + 1);
  documents.delete(id);
  void openCache().then(db => db.transaction('documents', 'readwrite').objectStore('documents').delete(id)).catch(() => {});
}
export function peekDocument(id: string): ImportedNote | undefined { return documents.get(id); }
export async function readCachedDocument(id: string): Promise<ImportedNote | undefined> {
  const generation = documentGenerations.get(id) || 0;
  const note = documents.get(id) || await readCache<ImportedNote>('documents', id);
  if ((documentGenerations.get(id) || 0) !== generation) return undefined;
  if (note && !documents.has(id)) documents.set(id, note);
  return note;
}
export function fetchDocument(id: string): Promise<ImportedNote> {
  let pending = requests.get(id);
  if (!pending) {
    const generation = documentGenerations.get(id) || 0;
    pending = apiRequest<{ note: ImportedNote }>(`/notes/${encodeURIComponent(id)}`).then(({ note }) => {
      if ((documentGenerations.get(id) || 0) !== generation) throw new Error('文档已发生变化，请重新打开。');
      cacheDocument(note);
      return documents.get(id) || note;
    }).finally(() => requests.delete(id));
    requests.set(id, pending);
  }
  return pending;
}

export function indexNote(note: ImportedNote): ImportedNote {
  const { content, attachments, attachmentSizes, ...metadata } = note;
  const references = new Set(Object.values(attachments || {}));
  return {
    ...metadata, content: '',
    contentBytes: note.contentBytes ?? new TextEncoder().encode(content).length,
    attachmentCount: note.attachmentCount ?? references.size,
    attachmentBytes: note.attachmentBytes ?? Object.values(attachmentSizes || {}).reduce((sum, size) => sum + size, 0),
    excerpt: note.excerpt ?? content.replace(/[#*`>[\]]/g, '').slice(0, 120),
  };
}
export function materializeIndex(index: LibraryIndex): ImportedNote[] {
  return index.notes.map(note => ({ ...note, content: '' }));
}

/** This hint is presentation only; authorization always uses the live session. */
export function readSessionDisplay(): SessionUser | null {
  try {
    const user = JSON.parse(sessionStorage.getItem(IDENTITY_KEY) || 'null');
    return user && typeof user.id === 'string' && typeof user.name === 'string' && typeof user.email === 'string' && ['admin', 'member'].includes(user.role) ? user : null;
  } catch { return null; }
}
export function cacheSessionDisplay(user: SessionUser | null): void {
  try {
    if (user) sessionStorage.setItem(IDENTITY_KEY, JSON.stringify(user));
    else sessionStorage.removeItem(IDENTITY_KEY);
  } catch { /* Live authentication works without browser storage. */ }
}
