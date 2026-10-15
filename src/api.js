/**
 * BINUS schedule API client — replays the captured request template
 * (schedule-request.json) for any month.
 *
 * The template carries the method, a {year}-{month} URL template, all headers
 * (including the Authorization JWT + identification headers) and the roleActivity
 * body. We swap the month into the URL and re-send headers + body. Only the token
 * goes stale (~24h) — refreshing is handled in src/request.js and src/sync.js.
 */
const { DateTime } = require('luxon');
const config = require('./config');

// Headers we must NOT forward verbatim: the browser/HTTP-layer ones that Node's
// fetch (undici) needs to compute itself or that would misroute the request.
const STRIP_HEADERS = new Set(['host', 'content-length', 'connection', 'accept-encoding']);

function buildHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    if (!STRIP_HEADERS.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

/** Fetch the schedule for the month containing `date` (a luxon DateTime). */
async function fetchMonth(template, date) {
  const url = template.urlTemplate
    .replace('{year}', date.year)
    .replace('{month}', date.month); // no leading zero, e.g. .../2026-8-1

  const res = await fetch(url, {
    method: template.method || 'POST',
    headers: buildHeaders(template.headers),
    body: typeof template.body === 'string' ? template.body : JSON.stringify(template.body),
  });

  const text = await res.text();

  if (res.status === 401) {
    const err = new Error('401 Unauthorized — the authorization token was rejected.');
    err.unauthorized = true;
    throw err;
  }
  if (!res.ok) {
    throw new Error(
      `Schedule API ${res.status} ${res.statusText} for ${date.toFormat('yyyy-MM')}: ` +
        text.slice(0, 200)
    );
  }

  // Months with no schedule come back empty / non-array — treat as "no events".
  if (!text.trim()) return [];
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Schedule API returned invalid JSON for ${date.toFormat('yyyy-MM')}.`);
  }
  return Array.isArray(json) ? json : [];
}

/**
 * Fetch a window of months around today (MONTHS_BACK … MONTHS_AHEAD) and return
 * all day-grouped entries concatenated. De-duplication happens later in parse.
 */
async function fetchSchedule(template) {
  const now = DateTime.now().setZone(config.timezone);
  const start = now.startOf('month').minus({ months: config.monthsBack });
  const count = config.monthsBack + config.monthsAhead + 1;

  const all = [];
  for (let i = 0; i < count; i++) {
    const month = start.plus({ months: i });
    const days = await fetchMonth(template, month);
    console.log(`  · ${month.toFormat('yyyy-MM')}: ${days.length} day group(s)`);
    all.push(...days);
  }
  return all;
}

module.exports = { fetchMonth, fetchSchedule };
