import { useLayoutEffect, useSyncExternalStore } from 'react';

export interface ReadingPreferences {
  fontSize: number;
  pageMargin: number;
  lineHeight: number;
  paragraphSpacing: number;
}

export const READING_PREFERENCES_KEY = 'zhiyu-reading-preferences-v1';
export const DEFAULT_READING_PREFERENCES: ReadingPreferences = { fontSize: 14, pageMargin: 48, lineHeight: 1.95, paragraphSpacing: 18 };
export const PAGE_MARGIN_SLIDER_MAX = 480;
export const LINE_HEIGHT_MIN = 1.2;
export const LINE_HEIGHT_MAX = 3;
export const PARAGRAPH_SPACING_MAX = 64;

let preferences = DEFAULT_READING_PREFERENCES;
let initialized = false;
const listeners = new Set<() => void>();

function bounded(value: unknown, fallback: number, minimum: number, maximum: number, precision = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, Number(value.toFixed(precision)))) : fallback;
}

function parsePreferences(value: string | null): ReadingPreferences {
  try {
    const stored: unknown = value ? JSON.parse(value) : null;
    if (!stored || typeof stored !== 'object') return DEFAULT_READING_PREFERENCES;
    const candidate = stored as Partial<ReadingPreferences>;
    return {
      fontSize: bounded(candidate.fontSize, 14, 12, 24),
      pageMargin: bounded(candidate.pageMargin, 48, 0, Number.MAX_SAFE_INTEGER),
      lineHeight: bounded(candidate.lineHeight, DEFAULT_READING_PREFERENCES.lineHeight, LINE_HEIGHT_MIN, LINE_HEIGHT_MAX, 2),
      paragraphSpacing: bounded(candidate.paragraphSpacing, DEFAULT_READING_PREFERENCES.paragraphSpacing, 0, PARAGRAPH_SPACING_MAX),
    };
  } catch { return DEFAULT_READING_PREFERENCES; }
}

function getSnapshot(): ReadingPreferences {
  if (!initialized && typeof window !== 'undefined') {
    initialized = true;
    try { preferences = parsePreferences(window.localStorage.getItem(READING_PREFERENCES_KEY)); } catch { /* Preferences also work when browser storage is unavailable. */ }
  }
  return preferences;
}

function applyPreferences(value: ReadingPreferences) {
  if (typeof document === 'undefined') return;
  document.documentElement.style.setProperty('--reading-font-size', `${value.fontSize}px`);
  document.documentElement.style.setProperty('--reading-page-margin', `${value.pageMargin}px`);
  document.documentElement.style.setProperty('--reading-line-height', String(value.lineHeight));
  document.documentElement.style.setProperty('--reading-paragraph-spacing', `${value.paragraphSpacing}px`);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key !== READING_PREFERENCES_KEY && event.key !== null) return;
    preferences = parsePreferences(event.key === null ? null : event.newValue);
    applyPreferences(preferences);
    listeners.forEach(notify => notify());
  };
  window.addEventListener('storage', onStorage);
  return () => { listeners.delete(listener); window.removeEventListener('storage', onStorage); };
}

export function updateReadingPreferences(update: Partial<ReadingPreferences>) {
  const current = getSnapshot();
  preferences = {
    fontSize: bounded(update.fontSize, current.fontSize, 12, 24),
    pageMargin: bounded(update.pageMargin, current.pageMargin, 0, Number.MAX_SAFE_INTEGER),
    lineHeight: bounded(update.lineHeight, current.lineHeight, LINE_HEIGHT_MIN, LINE_HEIGHT_MAX, 2),
    paragraphSpacing: bounded(update.paragraphSpacing, current.paragraphSpacing, 0, PARAGRAPH_SPACING_MAX),
  };
  try { window.localStorage.setItem(READING_PREFERENCES_KEY, JSON.stringify(preferences)); } catch { /* Keep this session's settings even when persistence is unavailable. */ }
  applyPreferences(preferences);
  listeners.forEach(notify => notify());
}

export function useReadingPreferences() {
  const current = useSyncExternalStore(subscribe, getSnapshot, () => DEFAULT_READING_PREFERENCES);
  useLayoutEffect(() => applyPreferences(current), [current]);
  return {
    preferences: current,
    setPreferences: updateReadingPreferences,
    resetPreferences: () => updateReadingPreferences(DEFAULT_READING_PREFERENCES),
  };
}
