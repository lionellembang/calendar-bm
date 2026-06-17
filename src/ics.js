/**
 * Render stored events into an iCalendar (VCALENDAR) string.
 *
 * Events are stored as absolute UTC instants (the parser already converted the
 * naive Asia/Jakarta timestamps), so we emit them in UTC (DTSTART:…Z). Every
 * calendar client converts that to the viewer's local time correctly, with no
 * need to ship a VTIMEZONE block.
 */
const ical = require('ical-generator').default;
const config = require('./config');

function buildCalendar(events, { name } = {}) {
  const cal = ical({
    name: name || config.calendarName,
    prodId: { company: 'calender-bm', product: 'binus-schedule', language: 'EN' },
  });

  for (const ev of events) {
    cal.createEvent({
      id: ev.uid,
      start: ev.start,
      end: ev.end,
      allDay: !!ev.allDay,
      summary: ev.summary,
      description: ev.description || undefined,
      location: ev.location || undefined,
    });
  }

  return cal.toString();
}

module.exports = { buildCalendar };
