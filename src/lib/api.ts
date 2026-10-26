import type { ImportedNote } from './importer';
import type { LibraryIndex, WorkspaceFolder } from './libraryCache';

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'member';
  avatarUrl?: string;
}

export class ApiError extends Error {
  constructor(message: string, public status: number, public code?: string) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function apiRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      ...options,
      credentials: 'same-origin',
      headers: { ...(options.body && typeof options.body === 'string' ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
    });
  } catch {
    throw new ApiError('连接服务失败，请检查网络后重试。', 0);
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string; code?: string };
    if (response.status === 401 && !path.startsWith('/auth/')) window.dispatchEvent(new Event('session-expired'));
    throw new ApiError(body.error || `请求失败（${response.status}），请稍后重试。`, response.status, body.code);
  }
  return response.status === 204 ? undefined as T : await response.json() as T;
}

const json = (value: unknown) => JSON.stringify(value);

export interface NotesImportResult {
  notes: ImportedNote[];
  createdCount: number;
  updatedCount: number;
}

function importNotes(notes: ImportedNote[], mode?: 'legacy-migration') {
  return apiRequest<NotesImportResult>('/notes/import', { method: 'POST', body: json({ notes, ...(mode ? { mode } : {}) }) });
}

export const authApi = {
  session: () => apiRequest<{ user: SessionUser | null; needsAdminSetup?: boolean }>('/session'),
  register: async (values: { name: string; email: string; password: string }) =>
    (await apiRequest<{ user: SessionUser }>('/auth/register', { method: 'POST', body: json(values) })).user,
  login: async (values: { email: string; password: string }) =>
    (await apiRequest<{ user: SessionUser }>('/auth/login', { method: 'POST', body: json(values) })).user,
  activateAdmin: async (values: { token: string; password: string }) =>
    (await apiRequest<{ user: SessionUser }>('/auth/activate-admin', { method: 'POST', body: json(values) })).user,
  updateProfile: async (values: { name: string }) =>
    (await apiRequest<{ user: SessionUser }>('/profile', { method: 'PATCH', body: json(values) })).user,
  uploadAvatar: async (image: Blob) =>
    (await apiRequest<{ user: SessionUser }>('/profile/avatar', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: image })).user,
  removeAvatar: async () =>
    (await apiRequest<{ user: SessionUser }>('/profile/avatar', { method: 'DELETE' })).user,
  logout: () => apiRequest<void>('/auth/logout', { method: 'POST' }),
};

export const notesApi = {
  list: async () => (await apiRequest<{ notes: ImportedNote[] }>('/notes')).notes,
  create: async (note: Partial<ImportedNote>) =>
    (await apiRequest<{ note: ImportedNote }>('/notes', { method: 'POST', body: json({ note }) })).note,
  importBatch: importNotes,
  import: async (notes: ImportedNote[]) =>
    (await importNotes(notes)).notes,
  migrate: async (notes: ImportedNote[]) =>
    (await importNotes(notes, 'legacy-migration')).notes,
  update: async (note: ImportedNote) =>
    (await apiRequest<{ note: ImportedNote }>(`/notes/${encodeURIComponent(note.id)}`, { method: 'PATCH', body: json({ note, revision: note.revision }) })).note,
  remove: (id: string) => apiRequest<void>(`/notes/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  sharing: async (id: string, collaborative: boolean, revision?: number) =>
    (await apiRequest<{ note: ImportedNote }>(`/notes/${encodeURIComponent(id)}/sharing`, { method: 'PATCH', body: json({ collaborative, revision }) })).note,
  rename: async (id: string, name: string, revision?: number) =>
    (await apiRequest<{ note: ImportedNote }>(`/notes/${encodeURIComponent(id)}/rename`, { method: 'PATCH', body: json({ name, revision }) })).note,
};

export const foldersApi = {
  create: async (parent: string, name: string) =>
    (await apiRequest<{ folder: WorkspaceFolder }>('/folders', { method: 'POST', body: json({ parent, name }) })).folder,
  rename: (path: string, name: string) =>
    apiRequest<LibraryIndex>('/folders', { method: 'PATCH', body: json({ path, name }) }),
  remove: (path: string) =>
    apiRequest<LibraryIndex>('/folders', { method: 'DELETE', body: json({ path }) }),
};

export function canEditNote(note: ImportedNote, user: SessionUser | null): boolean {
  return Boolean(user && (note.ownerId === user.id || note.collaborative === true));
}

export function canDeleteNote(note: ImportedNote, user: SessionUser | null): boolean {
  return Boolean(user && note.ownerId === user.id);
}

export function canManageSharing(user: SessionUser | null): boolean {
  return user?.role === 'admin';
}
