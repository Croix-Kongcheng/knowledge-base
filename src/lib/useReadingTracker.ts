import { useCallback, useEffect, useRef } from 'react';
import { createReadingTracker, type ReadingAction, type ReadingPayload } from './readingTracker';

interface ReadingTrackerOptions {
  userId: string | null;
  noteId: string | null;
  enabled: boolean;
}

function sessionId() {
  // randomUUID is unavailable on the HTTP address used by the FRPC deployment.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function readingRequest(action: ReadingAction, payload: ReadingPayload, keepalive: boolean) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(`/api/reading/${action}`, {
      method: 'POST', credentials: 'same-origin', keepalive,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload), signal: controller.signal,
    });
    if (response.status === 401) window.dispatchEvent(new Event('session-expired'));
    // Consume the small response so keep-alive connections can be reused.
    await response.arrayBuffer();
    return response.status;
  } catch {
    return 0;
  } finally {
    window.clearTimeout(timeout);
  }
}

/** Call with the loaded document that is actually displayed, never cached identity. */
export function useReadingTracker(options: ReadingTrackerOptions) {
  const latest = useRef(options);
  const tracker = useRef<ReturnType<typeof createReadingTracker> | null>(null);
  const manuallyStopped = useRef(false);
  const reconcile = useRef<(() => void) | null>(null);

  useEffect(() => {
    let pageLeaving = false;
    const isForeground = () => !pageLeaving && document.visibilityState === 'visible' && document.hasFocus();
    const instance = createReadingTracker({
      now: () => performance.now(), sessionId, request: readingRequest,
      setTimer: (callback, milliseconds) => window.setTimeout(callback, milliseconds),
      clearTimer: timer => window.clearTimeout(timer as number), isForeground,
      finalRequest: payload => {
        const body = new Blob([JSON.stringify(payload)], { type: 'application/json' });
        if (!navigator.sendBeacon?.('/api/reading/stop', body)) void readingRequest('stop', payload, true);
      },
    });
    tracker.current = instance;
    const sync = () => {
      const { userId, noteId, enabled } = latest.current;
      instance.update(userId, noteId, enabled && !manuallyStopped.current && isForeground());
    };
    const leave = () => { pageLeaving = true; void instance.stop(true); };
    const returnToPage = () => { pageLeaving = false; sync(); };
    reconcile.current = sync;
    document.addEventListener('visibilitychange', sync);
    window.addEventListener('focus', sync);
    window.addEventListener('blur', sync);
    window.addEventListener('pagehide', leave);
    window.addEventListener('beforeunload', leave);
    window.addEventListener('pageshow', returnToPage);
    sync();
    return () => {
      document.removeEventListener('visibilitychange', sync);
      window.removeEventListener('focus', sync);
      window.removeEventListener('blur', sync);
      window.removeEventListener('pagehide', leave);
      window.removeEventListener('beforeunload', leave);
      window.removeEventListener('pageshow', returnToPage);
      void instance.stop();
      if (tracker.current === instance) tracker.current = null;
      if (reconcile.current === sync) reconcile.current = null;
    };
  }, []);

  useEffect(() => {
    latest.current = options;
    manuallyStopped.current = false;
    reconcile.current?.();
  }, [options.userId, options.noteId, options.enabled]);

  const stop = useCallback(() => {
    manuallyStopped.current = true;
    return tracker.current?.stop() ?? Promise.resolve();
  }, []);

  return { stop };
}
