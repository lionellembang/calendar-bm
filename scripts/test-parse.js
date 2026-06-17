/**
 * Quick sanity check for the parser using the captured sample response.json.
 * Run: npm run test:parse
 */
const fs = require('fs');
const path = require('path');
const { parseSchedule } = require('../src/parse');
const { buildCalendar } = require('../src/ics');

const sample = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'response.json'), 'utf8')
);

const events = parseSchedule(sample, { includeDeadlines: true, timezone: 'Asia/Jakarta' });

const counts = events.reduce((a, e) => ((a[e.kind] = (a[e.kind] || 0) + 1), a), {});
console.log('Parsed events:', events.length, counts);

// The CB Kewarganegaraan FINAL PROJECT is repeated on every day in its range in
// the source; assert it collapses to a single deadline event.
const cb = events.filter((e) => /Kewarganegaraan/i.test(e.summary) && e.kind === 'deadline');
console.log('CB Kewarganegaraan deadline events (expect 1):', cb.length);

// No two events should share a UID.
const uids = new Set(events.map((e) => e.uid));
console.log('Unique UIDs:', uids.size, '(== event count:', uids.size === events.length, ')');

console.log('\nSample of parsed events:');
for (const e of events.slice(0, 8)) {
  console.log(
    ` [${e.kind}] ${e.start.toISOString()} → ${e.end.toISOString()}  ${e.summary}` +
      (e.location ? `  @ ${e.location}` : '')
  );
}

// Make sure ICS generation works end-to-end.
const ics = buildCalendar(events);
const vevents = (ics.match(/BEGIN:VEVENT/g) || []).length;
console.log('\nICS generated:', ics.length, 'bytes,', vevents, 'VEVENTs');
console.log('Valid VCALENDAR header:', ics.startsWith('BEGIN:VCALENDAR'));

const ok = cb.length === 1 && uids.size === events.length && vevents === events.length;
console.log('\n' + (ok ? '✓ PARSE TEST PASSED' : '✗ PARSE TEST FAILED'));
process.exit(ok ? 0 : 1);
