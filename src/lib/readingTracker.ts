export type ReadingAction = 'start' | 'heartbeat' | 'stop';

export interface ReadingPayload {
  sessionId: string;
  noteId?: string;
  elapsedMs?: number;
}

export interface ReadingTrackerEnvironment {
  now: () => number;
  sessionId: () => string;
  request: (action: ReadingAction, payload: ReadingPayload, keepalive: boolean) => Promise<number>;
  setTimer: (callback: () => void, milliseconds: number) => unknown;
  clearTimer: (timer: unknown) => void;
  isForeground: () => boolean;
  finalRequest?: (payload: ReadingPayload) => void;
}

interface Target { userId: string; noteId: string }
interface Segment extends Target {
  id: string;
  startedAt: number | null;
  endedAt: number | null;
  closed: boolean;
  serverStarted: boolean;
  timer: unknown;
}

const HEARTBEAT_MS = 5_000;
const sameTarget = (first: Target | null, second: Target | null) =>
  first?.userId === second?.userId && first?.noteId === second?.noteId;

/** One visible reading segment, with serialized requests and no persisted client time. */
export function createReadingTracker(environment: ReadingTrackerEnvironment) {
  let desired: Target | null = null;
  let current: Segment | null = null;
  let queue = Promise.resolve();
  let retryTimer: unknown;
  let blocked: Target | null = null;

  const enqueue = (operation: () => Promise<void>) => {
    queue = queue.then(operation).catch(() => { /* Reading telemetry must never interrupt the reader. */ });
    return queue;
  };
  const clearRetry = () => {
    if (retryTimer !== undefined) environment.clearTimer(retryTimer);
    retryTimer = undefined;
  };
  const elapsed = (segment: Segment) => segment.startedAt === null ? 0
    : Math.max(0, Math.floor((segment.endedAt ?? environment.now()) - segment.startedAt));

  const close = (segment: Segment, immediate = false) => {
    if (segment.closed) return;
    segment.closed = true;
    segment.endedAt = environment.now();
    if (segment.timer !== undefined) environment.clearTimer(segment.timer);
    segment.timer = undefined;
    if (current === segment) current = null;
    if (immediate && segment.serverStarted) {
      // A lifecycle event cannot wait for an outstanding heartbeat's response.
      // The server makes this final cumulative stop idempotent with the queue.
      try { environment.finalRequest?.({ sessionId: segment.id, elapsedMs: elapsed(segment) }); }
      catch { /* The normal keepalive request remains queued as a fallback. */ }
    }
    // This also waits for an in-flight start/heartbeat. An old stop therefore
    // cannot overtake the next note's start, including during quick navigation.
    void enqueue(async () => {
      if (segment.serverStarted) {
        await environment.request('stop', { sessionId: segment.id, elapsedMs: elapsed(segment) }, true);
      }
    });
  };

  const recover = (segment: Segment, status: number) => {
    if (segment.closed || current !== segment) return;
    close(segment);
    if (status === 401 || status === 403 || status === 404 || status === 409) blocked = { userId: segment.userId, noteId: segment.noteId };
    if (!desired || !sameTarget(desired, segment) || blocked) return;
    clearRetry();
    // Failed/stale segments never carry their elapsed time into a retry. A new
    // server session must qualify for its own uninterrupted ten seconds.
    retryTimer = environment.setTimer(() => {
      retryTimer = undefined;
      if (desired && !current && environment.isForeground()) begin(desired);
    }, HEARTBEAT_MS);
  };

  const scheduleHeartbeat = (segment: Segment) => {
    if (segment.closed || current !== segment) return;
    segment.timer = environment.setTimer(() => {
      segment.timer = undefined;
      if (segment.closed || current !== segment) return;
      if (!environment.isForeground()) { close(segment); return; }
      void enqueue(async () => {
        if (segment.closed || current !== segment) return;
        let status = 0;
        try {
          status = await environment.request('heartbeat', { sessionId: segment.id, elapsedMs: elapsed(segment) }, false);
        } catch { /* Recover below; no offline interval is saved for later. */ }
        if (segment.closed || current !== segment) return;
        if (status >= 200 && status < 300) scheduleHeartbeat(segment);
        else recover(segment, status);
      });
    }, HEARTBEAT_MS);
  };

  function begin(target: Target) {
    if (current || !environment.isForeground() || sameTarget(blocked, target)) return;
    const segment: Segment = {
      ...target, id: environment.sessionId(), startedAt: null, endedAt: null,
      closed: false, serverStarted: false, timer: undefined,
    };
    current = segment;
    void enqueue(async () => {
      if (segment.closed || current !== segment) return;
      if (!environment.isForeground()) { close(segment); return; }
      // Begin when the request is actually issued, rather than while waiting
      // behind the preceding note's final request.
      segment.startedAt = environment.now();
      let status = 0;
      try {
        status = await environment.request('start', { sessionId: segment.id, noteId: segment.noteId }, false);
      } catch { /* A new session will start only after a retry delay. */ }
      segment.serverStarted = status >= 200 && status < 300;
      if (segment.closed || current !== segment) return;
      if (segment.serverStarted) scheduleHeartbeat(segment);
      else recover(segment, status);
    });
  }

  return {
    update(userId: string | null, noteId: string | null, enabled: boolean) {
      const next = userId && noteId && enabled && environment.isForeground() ? { userId, noteId } : null;
      if (!sameTarget(desired, next)) { clearRetry(); blocked = null; }
      desired = next;
      if (current && !sameTarget(current, next)) close(current);
      if (next && !current && retryTimer === undefined) begin(next);
    },
    stop(immediate = false) {
      desired = null;
      blocked = null;
      clearRetry();
      if (current) close(current, immediate);
      return queue;
    },
  };
}
