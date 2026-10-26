import { apiRequest } from './api';

export interface ReadingUserSummary {
  userId: string;
  name: string;
  email: string;
  avatarUrl?: string;
  totalMs: number;
  noteCount: number;
  lastReadAt: string | null;
}

export interface ReadingNoteSummary {
  noteId: string;
  title: string;
  path: string;
  totalMs: number;
  readerCount: number;
  lastReadAt: string | null;
}

export interface ReadingRecord {
  userId: string;
  userName: string;
  userEmail: string;
  avatarUrl?: string;
  noteId: string;
  noteTitle: string;
  notePath: string;
  totalMs: number;
  lastReadAt: string | null;
}

export interface ReadingAnalyticsData {
  summary: { totalMs: number; readerCount: number; noteCount: number; pairCount: number };
  users: ReadingUserSummary[];
  notes: ReadingNoteSummary[];
  records: ReadingRecord[];
  pagination: { page: number; pageSize: number; total: number };
}

export interface ReadingAnalyticsQuery {
  userId?: string;
  noteId?: string;
  q?: string;
  page?: number;
  pageSize?: number;
}

export function getReadingAnalytics(query: ReadingAnalyticsQuery = {}, signal?: AbortSignal) {
  const params = new URLSearchParams();
  if (query.userId) params.set('userId', query.userId);
  if (query.noteId) params.set('noteId', query.noteId);
  if (query.q?.trim()) params.set('q', query.q.trim());
  params.set('page', String(query.page ?? 1));
  params.set('pageSize', String(query.pageSize ?? 50));
  return apiRequest<ReadingAnalyticsData>(`/admin/reading?${params}`, { signal, cache: 'no-store' });
}

/** Keep seconds visible so brief reading sessions do not appear as zero minutes. */
export function formatReadingDuration(milliseconds: number): string {
  const safeMs = Number.isFinite(milliseconds) ? Math.max(0, milliseconds) : 0;
  if (safeMs > 0 && safeMs < 1_000) return '不足 1 秒';
  const seconds = Math.floor(safeMs / 1_000);
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor(seconds % 3_600 / 60);
  const remainder = seconds % 60;
  return [hours ? `${hours.toLocaleString('zh-CN')} 小时` : '', hours || minutes ? `${minutes} 分` : '', `${remainder} 秒`].filter(Boolean).join(' ');
}

export function formatReadingClock(milliseconds: number): string {
  const seconds = Math.floor((Number.isFinite(milliseconds) ? Math.max(0, milliseconds) : 0) / 1_000);
  return `${Math.floor(seconds / 3_600).toLocaleString('zh-CN')}:${String(Math.floor(seconds % 3_600 / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}
