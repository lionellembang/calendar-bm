/**
 * Orchestrates one full sync: ensure a valid request template → fetch the month
 * window → parse + dedup → replace the stored event set.
 *
 * A login happens only when the token is unusable: missing/expired up front, or
 * rejected by the API with a 401 (then we log in once and retry the fetch).
 */
const { getValidRequest } = require('./request');
const { fetchSchedule } = require('./api');
const { parseSchedule } = require('./parse');
const { replaceEvents } = require('./db');

async function runSync() {
  const startedAt = Date.now();
  console.log('=== sync start', new Date().toISOString(), '===');

  let template = await getValidRequest();

  console.log('→ Fetching schedule …');
  let dayGroups;
  try {
    dayGroups = await fetchSchedule(template);
  } catch (err) {
    // Don't log in again if this token was captured during this very sync.
    const justCaptured = Date.parse(template.capturedAt) >= startedAt;
    if (!err.unauthorized || justCaptured) throw err;
    console.log('→ Token rejected by the API — logging in for a new one …');
    template = await getValidRequest({ force: true });
    dayGroups = await fetchSchedule(template);
  }

  const events = parseSchedule(dayGroups);
  const counts = events.reduce((acc, e) => {
    acc[e.scheduleType] = (acc[e.scheduleType] || 0) + 1;
    return acc;
  }, {});

  const n = replaceEvents(events);
  console.log(
    `✓ sync done: ${n} events stored (${JSON.stringify(counts)}) in ${Date.now() - startedAt}ms`
  );
  return { count: n, counts };
}

module.exports = { runSync };
