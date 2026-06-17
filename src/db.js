/**
 * SQLite storage via Node's built-in `node:sqlite` (no native build needed;
 * requires Node >= 24). One `events` table + a tiny `meta` table. Single user →
 * each sync does a full replace inside a transaction so removed or rescheduled
 * sessions disappear cleanly.
 */
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

// Bump when the `events` columns change; getDb() drops + recreates the table on
// a mismatch. Safe because every event is re-derived from the API on next sync.
const SCHEMA_VERSION = '2';

let db;

function getDb() {
  if (db) return db;
  config.ensureDataDir();
  db = new DatabaseSync(config.dbFile);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  // Migrate away from any older schema by recreating the events table.
  if (getMeta('schema_version') !== SCHEMA_VERSION) {
    db.exec('DROP TABLE IF EXISTS events');
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      uid           TEXT PRIMARY KEY,
      schedule_type TEXT NOT NULL,
      summary       TEXT NOT NULL,
      location      TEXT,
      starts_at     TEXT NOT NULL,   -- ISO 8601 UTC
      ends_at       TEXT NOT NULL,   -- ISO 8601 UTC
      synced_at     TEXT NOT NULL
    );
  `);
  setMeta('schema_version', SCHEMA_VERSION);
  return db;
}

/** Replace the entire event set atomically. Returns the row count written. */
function replaceEvents(events) {
  const d = getDb();
  const syncedAt = new Date().toISOString();
  const insert = d.prepare(`
    INSERT INTO events
      (uid, schedule_type, summary, location, starts_at, ends_at, synced_at)
    VALUES
      (@uid, @schedule_type, @summary, @location, @starts_at, @ends_at, @synced_at)
  `);

  d.exec('BEGIN');
  try {
    d.exec('DELETE FROM events');
    for (const ev of events) {
      insert.run({
        uid: ev.uid,
        schedule_type: ev.scheduleType,
        summary: ev.summary,
        location: ev.location || null,
        starts_at: ev.start.toISOString(),
        ends_at: ev.end.toISOString(),
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

/**
 * Events ordered by start time, as plain rows with Date objects. Pass a
 * scheduleType to return only that calendar's events.
 */
function getEvents(scheduleType) {
  const d = getDb();
  const rows = scheduleType
    ? d
        .prepare('SELECT * FROM events WHERE schedule_type = ? ORDER BY starts_at')
        .all(scheduleType)
    : d.prepare('SELECT * FROM events ORDER BY starts_at').all();
  return rows.map((r) => ({
    uid: r.uid,
    scheduleType: r.schedule_type,
    summary: r.summary,
    location: r.location,
    start: new Date(r.starts_at),
    end: new Date(r.ends_at),
  }));
}

/** Map of scheduleType → event count, for /healthz. */
function countsByType() {
  const rows = getDb()
    .prepare('SELECT schedule_type, COUNT(*) AS n FROM events GROUP BY schedule_type')
    .all();
  return Object.fromEntries(rows.map((r) => [r.schedule_type, r.n]));
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

module.exports = { getDb, replaceEvents, getEvents, countsByType, setMeta, getMeta };
