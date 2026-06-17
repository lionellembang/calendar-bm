/**
 * Express app exposing the read-only ICS subscription feeds.
 *
 *   GET /calendar/<FEED_TOKEN>            → HTML subscribe page (one-click buttons)
 *   GET /calendar/<FEED_TOKEN>/<type>.ics → text/calendar (one feed per type)
 *   GET /healthz                          → { ok, lastSync, eventCount, counts }
 *
 * Each scheduleType is its own calendar; subscribe to whichever feeds you want.
 * The feed token is a shared secret in the URL path; any other token (or an
 * unknown type) 404s so the feeds aren't world-readable just by guessing the
 * path. The subscribe page lives behind the token too, so the secret feed URLs
 * never appear on the public homepage.
 */
const express = require('express');
const config = require('./config');
const { getEvents, getMeta, countsByType } = require('./db');
const { buildCalendar } = require('./ics');
const { renderSubscribePage } = require('./page');

// Derive the externally-visible scheme + host, honouring a reverse proxy.
function externalOrigin(req) {
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  const host = req.headers['x-forwarded-host'] || req.get('host');
  return { proto, host };
}

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

  app.get('/calendar/:token', (req, res) => {
    if (!config.feedToken || req.params.token !== config.feedToken) {
      return res.status(404).send('Not found');
    }
    const { proto, host } = externalOrigin(req);
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(
      renderSubscribePage({
        token: config.feedToken,
        host,
        proto,
        counts: countsByType(),
        lastSync: getMeta('last_sync'),
      })
    );
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

  app.get('/', (req, res) => {
    res
      .type('html')
      .send(
        '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
          '<title>calender-bm</title>' +
          '<body style="font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem">' +
          '<h1>calender-bm is running</h1>' +
          '<p>Your subscribe page is at <code>/calendar/&lt;your-feed-token&gt;</code> — open it to one-click subscribe to each calendar.</p>' +
          '<p><a href="/healthz">status</a></p>'
      );
  });

  return app;
}

function startServer() {
  const app = createApp();
  return app.listen(config.port, () => {
    console.log(`→ Feed server on http://localhost:${config.port}`);
    console.log(`  subscribe page: http://localhost:${config.port}/calendar/${config.feedToken}`);
    for (const slug of Object.keys(TYPE_BY_SLUG)) {
      console.log(`  calendar: http://localhost:${config.port}/calendar/${config.feedToken}/${slug}.ics`);
    }
  });
}

module.exports = { createApp, startServer, TYPE_BY_SLUG };
