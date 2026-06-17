/**
 * Express app exposing the read-only ICS subscription feeds.
 *
 *   GET /calendar/<FEED_TOKEN>/<type>.ics  → text/calendar (one feed per type)
 *   GET /healthz                           → { ok, lastSync, eventCount, counts }
 *
 * Each scheduleType is its own calendar; subscribe to whichever feeds you want.
 * The feed token is a shared secret in the URL path; any other token (or an
 * unknown type) 404s so the feed isn't world-readable just by guessing the path.
 */
const express = require('express');
const config = require('./config');
const { getEvents, getMeta, countsByType } = require('./db');
const { buildCalendar } = require('./ics');

// URL slug → scheduleType. The only calendars we serve.
const TYPE_BY_SLUG = {
  onsite: 'Onsite',
  online: 'Online',
  'virtual-class': 'Virtual Class',
};

function createApp() {
  const app = express();
  app.disable('x-powered-by');

  app.get('/healthz', (req, res) => {
    res.json({
      ok: true,
      lastSync: getMeta('last_sync'),
      eventCount: Number(getMeta('event_count') || 0),
      counts: countsByType(),
    });
  });

  app.get('/calendar/:token/:slug.ics', (req, res) => {
    const { token, slug } = req.params;
    const scheduleType = TYPE_BY_SLUG[slug];
    if (!config.feedToken || token !== config.feedToken || !scheduleType) {
      return res.status(404).send('Not found');
    }
    const ics = buildCalendar(getEvents(scheduleType), {
      name: `${config.calendarName} — ${scheduleType}`,
    });
    res.set('Content-Type', 'text/calendar; charset=utf-8');
    res.set('Content-Disposition', `inline; filename="binus-${slug}.ics"`);
    res.send(ics);
  });

  app.get('/', (req, res) => res.send('calender-bm is running. See /healthz'));

  return app;
}

function startServer() {
  const app = createApp();
  return app.listen(config.port, () => {
    console.log(`→ Feed server on http://localhost:${config.port}`);
    for (const slug of Object.keys(TYPE_BY_SLUG)) {
      console.log(`  calendar: http://localhost:${config.port}/calendar/${config.feedToken}/${slug}.ics`);
    }
  });
}

module.exports = { createApp, startServer, TYPE_BY_SLUG };
