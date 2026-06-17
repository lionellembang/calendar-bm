/**
 * Quick sanity check for the parser using the captured sample responses.
 * Run: npm run test:parse
 */
const fs = require('fs');
const path = require('path');
const { parseSchedule, ALLOWED_TYPES } = require('../src/parse');
const { buildCalendar } = require('../src/ics');
const { TYPE_BY_SLUG } = require('../src/server');

const ROOT = path.join(__dirname, '..');
const TZ = 'Asia/Jakarta';

function loadIfExists(name) {
  const p = path.join(ROOT, name);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
}

const sample = loadIfExists('response.json') || loadIfExists('response2.json');
if (!sample) {
  console.error('No response.json / response2.json fixture found.');
  process.exit(1);
}

const events = parseSchedule(sample, { timezone: TZ });

// 1. Only allowed scheduleTypes survive.
const types = [...new Set(events.map((e) => e.scheduleType))];
const onlyAllowed = types.every((t) => ALLOWED_TYPES.has(t));
const counts = events.reduce((a, e) => ((a[e.scheduleType] = (a[e.scheduleType] || 0) + 1), a), {});
console.log('Parsed events:', events.length, counts);
console.log('Only allowed types present:', onlyAllowed, types);

// 2. UIDs are unique (dedup across day groups holds).
const uids = new Set(events.map((e) => e.uid));
console.log('Unique UIDs:', uids.size, '(== event count:', uids.size === events.length, ')');

// 3. Field mapping: summary, times, and location only when set.
console.log('\nSample of parsed events:');
for (const e of events.slice(0, 8)) {
  console.log(
    ` [${e.scheduleType}] ${e.start.toISOString()} → ${e.end.toISOString()}  ${e.summary}` +
      (e.location ? `  @ ${e.location}` : '')
  );
}

// 4. ICS generation per calendar (one feed per scheduleType).
let icsOk = true;
for (const [slug, scheduleType] of Object.entries(TYPE_BY_SLUG)) {
  const bucket = events.filter((e) => e.scheduleType === scheduleType);
  const ics = buildCalendar(bucket, { name: scheduleType });
  const vevents = (ics.match(/BEGIN:VEVENT/g) || []).length;
  const headerOk = ics.startsWith('BEGIN:VCALENDAR');
  console.log(`ICS [${slug}]: ${vevents} VEVENT(s), valid header: ${headerOk}`);
  if (!headerOk || vevents !== bucket.length) icsOk = false;
}

// 5. Zoom-link fallback: an Online entry with null location but a URL in
//    locationValue must surface that URL as the event location.
const synthetic = [
  {
    Schedule: [
      {
        scheduleType: 'Online',
        content: 'Synthetic Online Class',
        dateStart: '2026-06-20T08:00:00',
        dateEnd: '2026-06-20T10:00:00',
        location: null,
        locationValue: 'https://binus.zoom.us/j/123?pwd=abc',
      },
      {
        // room code in locationValue must NOT be promoted when location is null
        scheduleType: 'Online',
        content: 'Synthetic No-Location Class',
        dateStart: '2026-06-21T08:00:00',
        dateEnd: '2026-06-21T10:00:00',
        location: null,
        locationValue: 'ANG406',
      },
    ],
  },
];
const synthEvents = parseSchedule(synthetic, { timezone: TZ });
const zoom = synthEvents.find((e) => e.summary === 'Synthetic Online Class');
const noLoc = synthEvents.find((e) => e.summary === 'Synthetic No-Location Class');
const zoomOk = zoom && zoom.location === 'https://binus.zoom.us/j/123?pwd=abc';
const roomCodeIgnored = noLoc && noLoc.location === null;
console.log('\nZoom-link fallback used:', zoomOk, '| room code ignored:', roomCodeIgnored);

const ok = onlyAllowed && uids.size === events.length && icsOk && zoomOk && roomCodeIgnored;
console.log('\n' + (ok ? '✓ PARSE TEST PASSED' : '✗ PARSE TEST FAILED'));
process.exit(ok ? 0 : 1);
