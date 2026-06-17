/**
 * SQLite storage via Node's built-in `node:sqlite` (no native build needed;
 * requires Node >= 24). One `events` table + a tiny `meta` table. Single user →
 * each sync does a full replace inside a transaction so removed or rescheduled
 * classes disappear cleanly.
 */
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

let db;

function getDb() {
  if (db) return db;
  config.ensureDataDir();
  db = new DatabaseSync(config.dbFile);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      uid          TEXT PRIMARY KEY,
      kind         TEXT NOT NULL,
      summary      TEXT NOT NULL,
      description  TEXT,
      location     TEXT,
      starts_at    TEXT NOT NULL,   -- ISO 8601 UTC
      ends_at      TEXT NOT NULL,   -- ISO 8601 UTC
      all_day      INTEGER NOT NULL DEFAULT 0,
      course_code  TEXT,
      raw_json     TEXT,
      synced_at    TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
  `);
  return db;
}

/** Replace the entire event set atomically. Returns the row count written. */
function replaceEvents(events) {
  const d = getDb();
  const syncedAt = new Date().toISOString();
  const insert = d.prepare(`
    INSERT INTO events
      (uid, kind, summary, description, location, starts_at, ends_at, all_day, course_code, raw_json, synced_at)
    VALUES
      (@uid, @kind, @summary, @description, @location, @starts_at, @ends_at, @all_day, @course_code, @raw_json, @synced_at)
  `);

  d.exec('BEGIN');
  try {
    d.exec('DELETE FROM events');
    for (const ev of events) {
      insert.run({
        uid: ev.uid,
        kind: ev.kind,
        summary: ev.summary,
        description: ev.description || null,
        location: ev.location || null,
        starts_at: ev.start.toISOString(),
        ends_at: ev.end.toISOString(),
        all_day: ev.allDay ? 1 : 0,
        course_code: ev.courseCode || null,
        raw_json: ev.raw ? JSON.stringify(ev.raw) : null,
        synced_at: syncedAt,
      });
    }
    setMeta('last_sync', syncedAt);
    setMeta('event_count', String(events.length));
    d.exec('COMMIT');
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  }
  return events.length;
}

/** All events ordered by start time, as plain rows with Date objects. */
function getEvents() {
  const rows = getDb().prepare('SELECT * FROM events ORDER BY starts_at').all();
  return rows.map((r) => ({
    uid: r.uid,
    kind: r.kind,
    summary: r.summary,
    description: r.description,
    location: r.location,
    courseCode: r.course_code,
    start: new Date(r.starts_at),
    end: new Date(r.ends_at),
    allDay: !!r.all_day,
  }));
}

function setMeta(key, value) {
  getDb()
    .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}

function getMeta(key) {
  const row = getDb().prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : null;
}

module.exports = { getDb, replaceEvents, getEvents, setMeta, getMeta };
