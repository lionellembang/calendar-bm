/**
 * Turn the BINUS schedule response (an array of day groups, each with a
 * Schedule[]) into a flat list of normalized, de-duplicated calendar events.
 *
 * We keep only timetabled sessions, classified by scheduleType:
 *   - Online
 *   - Onsite
 *   - Virtual Class
 * Anything else (Assignment, Project, Online/Onsite Exam, Event, …) is dropped
 * and never stored. Each kept event uses only four source keys:
 *   content    → summary (title)
 *   dateStart  → start
 *   dateEnd    → end
 *   location   → location, falling back to locationValue when it's a URL (the
 *                Zoom join link for online sessions). All other keys ignored.
 */
const crypto = require('node:crypto');
const { DateTime } = require('luxon');
const config = require('./config');

const ALLOWED_TYPES = new Set(['Online', 'Onsite', 'Virtual Class']);

function toUtc(naive, zone) {
  if (!naive) return null;
  // Source timestamps are naive local time; some (…Utc fields) carry a trailing
  // Z. Strip it so we always interpret in the BINUS timezone consistently.
  const clean = String(naive).replace(/Z$/, '');
  const dt = DateTime.fromISO(clean, { zone });
  return dt.isValid ? dt.toUTC().toJSDate() : null;
}

function isUrl(v) {
  return typeof v === 'string' && /^https?:\/\//i.test(v.trim());
}

// Stable identity from the kept fields only, so the same session repeated across
// day groups collapses to one event without relying on any ignored keys.
function makeUid(scheduleType, summary, startIso, endIso, location) {
  return crypto
    .createHash('sha1')
    .update([scheduleType, summary, startIso, endIso, location || ''].join('|'))
    .digest('hex');
}

/**
 * @param {Array} dayGroups  raw API response (array of { dateStart, Schedule })
 * @param {object} [opts]    { timezone }
 * @returns {Array} normalized events, de-duplicated by uid, sorted by start
 */
function parseSchedule(dayGroups, opts = {}) {
  const zone = opts.timezone || config.timezone;
  const byUid = new Map();

  for (const group of dayGroups || []) {
    for (const e of group.Schedule || []) {
      if (!ALLOWED_TYPES.has(e.scheduleType)) continue;

      const summary = e.content;
      if (!summary) continue;

      const start = toUtc(e.dateStart, zone);
      const end = toUtc(e.dateEnd, zone);
      if (!start || !end) continue;

      const location = e.location || (isUrl(e.locationValue) ? e.locationValue.trim() : null);
      const uid = makeUid(
        e.scheduleType,
        summary,
        start.toISOString(),
        end.toISOString(),
        location
      );

      // Last write wins; identical entries across months/days collapse here.
      byUid.set(uid, { uid, scheduleType: e.scheduleType, summary, location, start, end });
    }
  }

  return [...byUid.values()].sort((a, b) => a.start - b.start);
}

module.exports = { parseSchedule, ALLOWED_TYPES };
