import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createReadingTracker } from '../../src/lib/readingTracker.ts';

const pump = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); };

function fixture(handler = () => 200) {
  let now = 0;
  let sequence = 0;
  let foreground = true;
  const timers = new Map();
  const requests = [];
  const finalRequests = [];
  const environment = {
    now: () => now,
    sessionId: () => 'reading-session-' + (++sequence),
    request: async (action, payload, keepalive) => {
      const request = { action, ...payload, keepalive, at: now };
      requests.push(request);
      return await handler(request);
    },
    setTimer(callback, delay) {
      const timer = Symbol();
      timers.set(timer, { callback, at: now + delay });
      return timer;
    },
    clearTimer: timer => timers.delete(timer),
    isForeground: () => foreground,
    finalRequest: payload => finalRequests.push(payload),
  };
  const tracker = createReadingTracker(environment);
  return {
    tracker, requests, finalRequests,
    foreground(value) { foreground = value; },
    async advance(milliseconds) {
      const end = now + milliseconds;
      for (;;) {
        await pump();
        const next = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at;
        timers.delete(next[0]);
        next[1].callback();
      }
      now = end;
      await pump();
    },
  };
}

test('only an authenticated, enabled and focused document starts; every interruption resets qualification', async () => {
  const f = fixture();
  f.tracker.update(null, 'A', true);
  f.tracker.update('user', null, true);
  f.tracker.update('user', 'A', false);
  f.foreground(false);
  f.tracker.update('user', 'A', true);
  await f.advance(30_000);
  assert.equal(f.requests.length, 0);

  f.foreground(true);
  f.tracker.update('user', 'A', true);
  await f.advance(9_999);
  f.foreground(false);
  f.tracker.update('user', 'A', true);
  await pump();
  const first = f.requests.find(request => request.action === 'stop');
  assert.equal(first.elapsedMs, 9_999);
  assert.equal(Math.max(0, first.elapsedMs - 10_000), 0);
  const count = f.requests.length;
  await f.advance(60_000);
  assert.equal(f.requests.length, count);

  f.foreground(true);
  f.tracker.update('user', 'A', true);
  await f.advance(10_001);
  await f.tracker.stop();
  const stops = f.requests.filter(request => request.action === 'stop');
  assert.equal(stops[1].elapsedMs, 10_001);
  assert.notEqual(stops[0].sessionId, stops[1].sessionId);
  assert.equal(Math.max(0, stops[1].elapsedMs - 10_000), 1);
  assert.ok(f.requests.filter(request => request.action === 'heartbeat').every(request => request.keepalive === false));
  assert.ok(stops.every(request => request.keepalive === true));
});

test('slow starts and rapid note switches serialize old stops before the latest note starts', async () => {
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const f = fixture(request => request.action === 'start' && request.noteId === 'A' ? waiting : 200);
  f.tracker.update('user', 'A', true);
  await pump();
  await f.advance(200);
  f.tracker.update('user', 'B', true);
  await f.advance(300);
  f.tracker.update('user', 'C', true);
  release(201);
  await pump();
  assert.deepEqual(f.requests.map(request => [request.action, request.noteId || request.elapsedMs]), [
    ['start', 'A'], ['stop', 200], ['start', 'C'],
  ]);
  await f.advance(12_000);
  await f.tracker.stop();
  assert.equal(f.requests.at(-1).elapsedMs, 12_000);
  assert.equal(f.requests.at(-1).sessionId, f.requests.find(request => request.noteId === 'C').sessionId);
});

test('stale and failed heartbeats restart with a new session and never replay the offline interval', async () => {
  let failures = 1;
  const f = fixture(request => request.action === 'heartbeat' && failures-- > 0 ? 410 : 200);
  f.tracker.update('user', 'A', true);
  await f.advance(5_000);
  assert.equal(f.requests.at(-1).action, 'stop');
  await f.advance(5_000);
  const starts = f.requests.filter(request => request.action === 'start');
  assert.equal(starts.length, 2);
  assert.notEqual(starts[0].sessionId, starts[1].sessionId);
  await f.advance(5_000);
  assert.equal(f.requests.at(-1).elapsedMs, 5_000);
  await f.tracker.stop();
});

test('page exit sends a synchronous final cumulative stop while a heartbeat is still pending', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const f = fixture(request => request.action === 'heartbeat' ? pending : 200);
  f.tracker.update('user', 'A', true);
  await f.advance(5_100);
  const stopped = f.tracker.stop(true);
  assert.deepEqual(f.finalRequests, [{ sessionId: f.requests[0].sessionId, elapsedMs: 5_100 }]);
  release(200);
  await stopped;
  assert.equal(f.requests.at(-1).action, 'stop');
  assert.equal(f.requests.at(-1).elapsedMs, 5_100);
  await f.advance(30_000);
  assert.equal(f.requests.filter(request => request.action === 'start').length, 1);
});

test('a replaced browser session stays paused until a real foreground or document transition', async () => {
  let replaced = true;
  const f = fixture(request => request.action === 'heartbeat' && replaced ? 409 : 200);
  f.tracker.update('user', 'A', true);
  await f.advance(5_000);
  f.tracker.update('user', 'A', true);
  await f.advance(60_000);
  assert.equal(f.requests.filter(request => request.action === 'start').length, 1);
  f.foreground(false);
  f.tracker.update('user', 'A', true);
  f.foreground(true);
  f.tracker.update('user', 'A', true);
  replaced = false;
  await f.advance(5_000);
  assert.equal(f.requests.filter(request => request.action === 'start').length, 2);
  assert.equal(f.requests.at(-1).elapsedMs, 5_000);
  await f.tracker.stop();
});

test('Strict Mode mount cleanup cancels an unissued start and unauthorized sessions do not retry', async () => {
  const f = fixture(() => 401);
  f.tracker.update('user', 'A', true);
  await f.tracker.stop();
  assert.equal(f.requests.length, 0);
  f.tracker.update('user', 'A', true);
  await f.advance(60_000);
  assert.equal(f.requests.length, 1);
  await f.tracker.stop();
});
