/**
 * Orchestrates one full sync: ensure a valid request template → fetch the month
 * window → parse + dedup → replace the stored event set.
 */
const { getValidRequest } = require('./request');
const { fetchSchedule } = require('./api');
const { parseSchedule } = require('./parse');
const { replaceEvents } = require('./db');

async function runSync() {
  const startedAt = Date.now();
  console.log('=== sync start', new Date().toISOString(), '===');

  const template = await getValidRequest();

  console.log('→ Fetching schedule …');
  const dayGroups = await fetchSchedule(template);

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
