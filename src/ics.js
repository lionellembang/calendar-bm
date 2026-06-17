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

  // A positive number of seconds means "before the event" (TRIGGER:-PT…).
  const reminderSec = config.reminderMinutes > 0 ? config.reminderMinutes * 60 : null;

  for (const ev of events) {
    const event = cal.createEvent({
      id: ev.uid,
      start: ev.start,
      end: ev.end,
      summary: ev.summary,
      location: ev.location || undefined,
    });
    if (reminderSec) {
      event.createAlarm({ type: 'display', trigger: reminderSec, description: ev.summary });
    }
  }

  return cal.toString();
}

module.exports = { buildCalendar };
