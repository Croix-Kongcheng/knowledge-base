const QUALIFICATION_MS = 10_000;
const MAX_HEARTBEAT_GAP_MS = 20_000;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;

/** Private, server-bounded reading accounting. No timer or document body is retained. */
export function createReadingService(db, { ApiError, avatarUrl, now = Date.now, onChanges = () => {} }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS reading_sessions (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL, note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      started_at INTEGER NOT NULL, last_event_at INTEGER NOT NULL,
      elapsed_ms INTEGER NOT NULL DEFAULT 0, reported_ms INTEGER NOT NULL DEFAULT 0, recorded_ms INTEGER NOT NULL DEFAULT 0,
      closed_at INTEGER, closed_reason TEXT, PRIMARY KEY(user_id, session_id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS reading_one_active_user ON reading_sessions(user_id) WHERE closed_at IS NULL;
    CREATE TABLE IF NOT EXISTS reading_totals (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      total_ms INTEGER NOT NULL CHECK(total_ms > 0), last_read_at INTEGER NOT NULL,
      PRIMARY KEY(user_id, note_id)
    );
    CREATE INDEX IF NOT EXISTS reading_totals_note ON reading_totals(note_id);
  `);
  const changes = db.prepare('SELECT total_changes() AS count');
  const session = db.prepare('SELECT * FROM reading_sessions WHERE user_id = ? AND session_id = ?');
  const noteExists = db.prepare('SELECT 1 FROM notes WHERE id = ?');
  const close = db.prepare('UPDATE reading_sessions SET closed_at = ?, closed_reason = ? WHERE user_id = ? AND session_id = ? AND closed_at IS NULL');

  function transaction(callback) {
    const before = changes.get().count;
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = callback();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    } finally {
      // total_changes includes rolled-back writes too. Excluding only these
      // transactions keeps every heartbeat from rebuilding the note directory.
      onChanges(changes.get().count - before);
    }
  }

  function validate(body, keys) {
    if (Object.keys(body).length !== keys.length || keys.some(key => !Object.hasOwn(body, key))
      || typeof body.sessionId !== 'string' || !ID.test(body.sessionId)) {
      throw new ApiError(400, '阅读记录格式无效，不能指定其他账号。', 'INVALID_READING_EVENT');
    }
  }

  const output = row => ({ sessionId: row.session_id, recordedMs: row.recorded_ms, active: row.closed_at === null });
  const expired = () => new ApiError(410, '阅读记录已过期，请重新开始计时。', 'READING_SESSION_EXPIRED');
  const closed = () => new ApiError(410, '这篇笔记的阅读计时已结束。', 'READING_SESSION_CLOSED');
  const closedError = row => row.closed_reason === 'replaced'
    ? new ApiError(409, '另一窗口正在阅读，请重新选中这篇笔记后再计时。', 'READING_SESSION_REPLACED')
    : row.closed_reason === 'expired' ? expired() : closed();

  function start(userId, body) {
    validate(body, ['sessionId', 'noteId']);
    if (typeof body.noteId !== 'string' || !ID.test(body.noteId)) throw new ApiError(400, '笔记标识无效。', 'INVALID_READING_EVENT');
    const time = Math.trunc(now());
    // Commit expiry before surfacing 410, so a delayed heartbeat cannot revive
    // the same visit. A new foreground visit must use a fresh session ID.
    const result = transaction(() => {
      const existing = session.get(userId, body.sessionId);
      if (existing) {
        if (existing.note_id !== body.noteId) throw new ApiError(409, '阅读记录已用于另一篇笔记。', 'READING_SESSION_CONFLICT');
        if (existing.closed_at !== null) return { error: closedError(existing) };
        if (time - existing.last_event_at > MAX_HEARTBEAT_GAP_MS) {
          close.run(time, 'expired', userId, body.sessionId);
          return { error: expired() };
        }
        return { status: 200, body: output(existing) };
      }
      if (!noteExists.get(body.noteId)) throw new ApiError(404, '笔记不存在或已被删除。', 'NOTE_NOT_FOUND');
      db.prepare("UPDATE reading_sessions SET closed_at = ?, closed_reason = 'replaced' WHERE user_id = ? AND closed_at IS NULL").run(time, userId);
      db.prepare('INSERT INTO reading_sessions(user_id,session_id,note_id,started_at,last_event_at) VALUES(?,?,?,?,?)')
        .run(userId, body.sessionId, body.noteId, time, time);
      return { status: 201, body: output(session.get(userId, body.sessionId)) };
    });
    if (result.error) throw result.error;
    return result;
  }

  function update(userId, body, stopping = false) {
    validate(body, ['sessionId', 'elapsedMs']);
    if (!Number.isSafeInteger(body.elapsedMs) || body.elapsedMs < 0) throw new ApiError(400, '阅读时长无效。', 'INVALID_READING_EVENT');
    const time = Math.trunc(now());
    const result = transaction(() => {
      const existing = session.get(userId, body.sessionId);
      if (!existing) return { error: expired() };
      if (existing.closed_at !== null) return stopping ? { body: output(existing) } : { error: closedError(existing) };
      if (time - existing.last_event_at > MAX_HEARTBEAT_GAP_MS) {
        close.run(time, 'expired', userId, body.sessionId);
        return { error: expired() };
      }
      // A client can report only cumulative foreground time. Cap it by our
      // clock, and ignore duplicate/out-of-order samples rather than summing.
      const elapsed = body.elapsedMs > existing.reported_ms
        ? Math.max(existing.elapsed_ms, Math.min(body.elapsedMs, Math.max(0, time - existing.started_at)))
        : existing.elapsed_ms;
      const recorded = Math.max(0, elapsed - QUALIFICATION_MS);
      const delta = recorded - existing.recorded_ms;
      if (delta > 0) {
        db.prepare(`INSERT INTO reading_totals(user_id,note_id,total_ms,last_read_at) VALUES(?,?,?,?)
          ON CONFLICT(user_id,note_id) DO UPDATE SET total_ms = total_ms + excluded.total_ms, last_read_at = MAX(last_read_at, excluded.last_read_at)`)
          .run(userId, existing.note_id, delta, time);
      }
      db.prepare('UPDATE reading_sessions SET elapsed_ms = ?, reported_ms = ?, recorded_ms = ?, last_event_at = ?, closed_at = ?, closed_reason = ? WHERE user_id = ? AND session_id = ?')
        .run(elapsed, Math.max(body.elapsedMs, existing.reported_ms), recorded, Math.max(time, existing.last_event_at), stopping ? time : null, stopping ? 'stopped' : null, userId, body.sessionId);
      return { body: output(session.get(userId, body.sessionId)) };
    });
    if (result.error) throw result.error;
    return result.body;
  }

  const iso = value => value === null || value === undefined ? null : new Date(value).toISOString();
  const avatar = row => row.avatar_version ? { avatarUrl: avatarUrl(row.userId, row.avatar_version) } : {};
  function stats(search) {
    const filterId = key => {
      const value = search.get(key) || '';
      if (value && !ID.test(value)) throw new ApiError(400, '筛选条件无效。', 'INVALID_READING_FILTER');
      return value;
    };
    const userId = filterId('userId'), noteId = filterId('noteId');
    const q = (search.get('q') || '').normalize('NFC').trim();
    if (q.length > 200) throw new ApiError(400, '搜索内容不能超过 200 个字符。', 'INVALID_READING_FILTER');
    const integer = (key, fallback, maximum) => {
      const raw = search.get(key);
      if (raw === null || raw === '') return fallback;
      if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > maximum) throw new ApiError(400, '分页参数无效。', 'INVALID_READING_FILTER');
      return Number(raw);
    };
    const page = integer('page', 1, 1_000_000), pageSize = integer('pageSize', 50, 100);
    const summary = db.prepare(`SELECT COALESCE(SUM(total_ms),0) AS totalMs, COUNT(DISTINCT user_id) AS readerCount,
      COUNT(DISTINCT note_id) AS noteCount, COUNT(*) AS pairCount FROM reading_totals`).get();
    const users = db.prepare(`SELECT users.id AS userId,users.name,users.email,user_avatars.version AS avatar_version,
      COALESCE(SUM(reading_totals.total_ms),0) AS totalMs,COUNT(reading_totals.note_id) AS noteCount,MAX(last_read_at) AS lastReadAt
      FROM users LEFT JOIN user_avatars ON user_avatars.user_id = users.id LEFT JOIN reading_totals ON reading_totals.user_id = users.id
      GROUP BY users.id ORDER BY totalMs DESC,users.name,users.id`).all()
      .map(({ avatar_version, ...row }) => ({ ...row, ...avatar({ ...row, avatar_version }), lastReadAt: iso(row.lastReadAt) }));
    const notes = db.prepare(`SELECT notes.id AS noteId,json_extract(notes.data,'$.title') AS title,
      COALESCE(json_extract(notes.data,'$.path'),'') AS path,COALESCE(SUM(reading_totals.total_ms),0) AS totalMs,
      COUNT(reading_totals.user_id) AS readerCount,MAX(last_read_at) AS lastReadAt
      FROM notes LEFT JOIN reading_totals ON reading_totals.note_id = notes.id
      GROUP BY notes.id ORDER BY totalMs DESC,title,notes.id`).all().map(row => ({ ...row, lastReadAt: iso(row.lastReadAt) }));
    const clauses = [], values = [];
    if (userId) { clauses.push('r.user_id = ?'); values.push(userId); }
    if (noteId) { clauses.push('r.note_id = ?'); values.push(noteId); }
    if (q) {
      clauses.push(`(u.name LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\' OR json_extract(n.data,'$.title') LIKE ? ESCAPE '\\' OR json_extract(n.data,'$.path') LIKE ? ESCAPE '\\')`);
      const pattern = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
      values.push(pattern, pattern, pattern, pattern);
    }
    const from = `FROM reading_totals r JOIN users u ON u.id = r.user_id JOIN notes n ON n.id = r.note_id
      LEFT JOIN user_avatars a ON a.user_id = u.id ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}`;
    const total = db.prepare(`SELECT COUNT(*) AS count ${from}`).get(...values).count;
    const records = db.prepare(`SELECT r.user_id AS userId,u.name AS userName,u.email AS userEmail,a.version AS avatar_version,
      r.note_id AS noteId,json_extract(n.data,'$.title') AS noteTitle,COALESCE(json_extract(n.data,'$.path'),'') AS notePath,
      r.total_ms AS totalMs,r.last_read_at AS lastReadAt ${from}
      ORDER BY r.last_read_at DESC,r.user_id,r.note_id LIMIT ? OFFSET ?`).all(...values, pageSize, (page - 1) * pageSize)
      .map(({ avatar_version, ...row }) => ({ ...row, ...avatar({ ...row, avatar_version }), lastReadAt: iso(row.lastReadAt) }));
    return { summary, users, notes, records, pagination: { page, pageSize, total } };
  }

  return { start, heartbeat: (userId, body) => update(userId, body), stop: (userId, body) => update(userId, body, true), stats };
}
