/**
 * Express app exposing the read-only ICS subscription feed.
 *
 *   GET /calendar/<FEED_TOKEN>.ics  → text/calendar
 *   GET /healthz                    → { ok, lastSync, eventCount }
 *
 * The feed token is a shared secret in the URL path; any other token 404s so the
 * feed isn't world-readable just by guessing the path.
 */
const express = require('express');
const config = require('./config');
const { getEvents, getMeta } = require('./db');
const { buildCalendar } = require('./ics');

function createApp() {
  const app = express();
  app.disable('x-powered-by');

  app.get('/healthz', (req, res) => {
    res.json({
      ok: true,
      lastSync: getMeta('last_sync'),
      eventCount: Number(getMeta('event_count') || 0),
    });
  });

  app.get('/calendar/:token.ics', (req, res) => {
    if (!config.feedToken || req.params.token !== config.feedToken) {
      return res.status(404).send('Not found');
    }
    const ics = buildCalendar(getEvents());
    res.set('Content-Type', 'text/calendar; charset=utf-8');
    res.set('Content-Disposition', 'inline; filename="binus-schedule.ics"');
    res.send(ics);
  });

  app.get('/', (req, res) => res.send('calender-bm is running. See /healthz'));

  return app;
}

function startServer() {
  const app = createApp();
  return app.listen(config.port, () => {
    console.log(`→ Feed server on http://localhost:${config.port}`);
    console.log(`  calendar: http://localhost:${config.port}/calendar/${config.feedToken}.ics`);
  });
}

module.exports = { createApp, startServer };
