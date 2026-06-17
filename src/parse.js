/**
 * Turn the BINUS schedule response (an array of day groups, each with a
 * Schedule[]) into a flat list of normalized, de-duplicated calendar events.
 *
 * Three kinds of entries, by scheduleType:
 *   - class    : Onsite / Virtual Class        → timed session
 *   - exam     : Onsite Exam / Online Exam     → timed exam
 *   - deadline : Assignment / Project          → due-date event (repeated daily
 *                in the source, so MUST be de-duplicated)
 */
const { DateTime } = require('luxon');
const config = require('./config');

const CLASS_TYPES = new Set(['Onsite', 'Virtual Class']);
const EXAM_TYPES = new Set(['Onsite Exam', 'Online Exam']);
const DEADLINE_TYPES = new Set(['Assignment', 'Project']);

// How long before the due time a deadline event should block out.
const DEADLINE_LEAD_MIN = 15;

function toUtc(naive, zone) {
  if (!naive) return null;
  // Source timestamps are naive local time; some (…Utc fields) carry a trailing
  // Z. Strip it so we always interpret in the BINUS timezone consistently.
  const clean = String(naive).replace(/Z$/, '');
  const dt = DateTime.fromISO(clean, { zone });
  return dt.isValid ? dt.toUTC().toJSDate() : null;
}

function classify(type) {
  if (CLASS_TYPES.has(type)) return 'class';
  if (EXAM_TYPES.has(type)) return 'exam';
  if (DEADLINE_TYPES.has(type)) return 'deadline';
  return 'class'; // default: treat unknown timed entries as a session
}

function buildClass(e, cp, zone) {
  const isVirtual = e.scheduleType === 'Virtual Class' || e.deliveryMode === 'VC';
  const descParts = [
    e.title && `Class: ${e.title}`,
    cp.sessionNumber && `Session ${cp.sessionNumber}`,
    e.deliveryModeDesc,
  ].filter(Boolean);
  return {
    uid: cp.classSessionId || e.scheduleId,
    kind: 'class',
    summary: isVirtual ? `${e.content} (Online)` : e.content,
    description: descParts.join('\n'),
    location: isVirtual ? null : e.location,
    start: toUtc(e.dateStart, zone),
    end: toUtc(e.dateEnd, zone),
    allDay: 0,
    courseCode: cp.courseCode || null,
  };
}

function buildExam(e, cp, zone) {
  const component = cp.Component || e.assessmentActivity || e.scheduleType;
  const location = e.location || cp.roomCode || cp.campus || null;
  const descParts = [
    e.title && `Class: ${e.title}`,
    cp.seatNumber && `Seat: ${cp.seatNumber}`,
    cp.time && `Time: ${cp.time}`,
    cp.url && `Link: ${cp.url}`,
  ].filter(Boolean);
  return {
    uid: `exam:${cp.courseCode || e.scheduleId}:${component}:${e.dateStart}`,
    kind: 'exam',
    summary: `${e.content} — ${component}`,
    description: descParts.join('\n'),
    location,
    start: toUtc(e.dateStart, zone),
    end: toUtc(e.dateEnd, zone),
    allDay: 0,
    courseCode: cp.courseCode || null,
  };
}

function buildDeadline(e, cp, zone) {
  const due = toUtc(cp.dueDate || e.dateEnd, zone);
  if (!due) return null;
  const start = new Date(due.getTime() - DEADLINE_LEAD_MIN * 60 * 1000);
  const label = cp.title ? `${e.content} — ${cp.title}` : e.content;
  const descParts = [
    e.title && `Class: ${e.title}`,
    e.assessmentActivity,
  ].filter(Boolean);
  return {
    uid: `due:${cp.assessmentId || e.scheduleId}`,
    kind: 'deadline',
    summary: `Due: ${label}`,
    description: descParts.join('\n'),
    location: null,
    start,
    end: due,
    allDay: 0,
    courseCode: cp.courseCode || null,
  };
}

/**
 * @param {Array} dayGroups  raw API response (array of { dateStart, Schedule })
 * @param {object} [opts]    { includeDeadlines, timezone }
 * @returns {Array} normalized events, de-duplicated by uid
 */
function parseSchedule(dayGroups, opts = {}) {
  const includeDeadlines =
    opts.includeDeadlines !== undefined ? opts.includeDeadlines : config.includeDeadlines;
  const zone = opts.timezone || config.timezone;

  const byUid = new Map();

  for (const group of dayGroups || []) {
    for (const e of group.Schedule || []) {
      const cp = e.customParam || {};
      const kind = classify(e.scheduleType);

      if (kind === 'deadline' && !includeDeadlines) continue;

      let ev;
      if (kind === 'exam') ev = buildExam(e, cp, zone);
      else if (kind === 'deadline') ev = buildDeadline(e, cp, zone);
      else ev = buildClass(e, cp, zone);

      if (!ev || !ev.uid || !ev.start || !ev.end) continue;
      ev.raw = e;
      // Last write wins; identical entries across months/days collapse here.
      byUid.set(ev.uid, ev);
    }
  }

  return [...byUid.values()].sort((a, b) => a.start - b.start);
}

module.exports = { parseSchedule };
