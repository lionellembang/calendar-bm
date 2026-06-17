/**
 * Central config: reads .env (via dotenv) and resolves data paths. Everything
 * the rest of the app needs comes from here.
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const ROOT = path.join(__dirname, '..');

function bool(v, def) {
  if (v === undefined) return def;
  return /^(1|true|yes)$/i.test(String(v).trim());
}

function int(v, def) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

const dataDir = path.resolve(ROOT, process.env.DATA_DIR || './data');

const config = {
  root: ROOT,
  dataDir,

  // Files that persist across runs (kept in the data dir / mounted volume)
  requestFile: path.join(dataDir, 'schedule-request.json'), // full replayable request
  tokensFile: path.join(dataDir, 'tokens.json'),
  stateFile: path.join(dataDir, 'binus-state.json'),
  dbFile: path.join(dataDir, 'schedule.db'),

  // BINUSMAYA login (for the scraper)
  username: process.env.BINUS_USERNAME || '',
  password: process.env.BINUS_PASSWORD || '',
  headful: bool(process.env.HEADFUL, false),

  // Feed
  feedToken: process.env.FEED_TOKEN || '',
  port: int(process.env.PORT, 3000),
  calendarName: process.env.CALENDAR_NAME || 'BINUS Schedule',

  // Sync — how often to refresh from the API, in minutes (default: 6 hours)
  syncIntervalMinutes: int(process.env.SYNC_INTERVAL_MINUTES, 360),
  monthsBack: int(process.env.MONTHS_BACK, 1),
  monthsAhead: int(process.env.MONTHS_AHEAD, 2),

  // Scraper resilience — if a grab fails (e.g. it can't reach the schedule
  // page), relaunch the whole flow from a cold start, up to this many attempts,
  // waiting this many seconds between tries.
  scrapeMaxAttempts: int(process.env.SCRAPE_MAX_ATTEMPTS, 3),
  scrapeRetryDelaySec: int(process.env.SCRAPE_RETRY_DELAY_SEC, 30),

  // Timezone the BINUS naive timestamps are expressed in
  timezone: process.env.TZ || 'Asia/Jakarta',
};

/**
 * Make sure the data dir exists, and migrate any legacy state/token files that
 * earlier versions wrote to the repo root (so an existing logged-in session is
 * not lost when we move to DATA_DIR). Idempotent — safe to call anywhere.
 */
function ensureDataDir() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const legacy = [
    [path.join(ROOT, 'tokens.json'), config.tokensFile],
    [path.join(ROOT, 'binus-state.json'), config.stateFile],
    [path.join(ROOT, 'schedule-request.json'), config.requestFile],
  ];
  for (const [from, to] of legacy) {
    if (from !== to && fs.existsSync(from) && !fs.existsSync(to)) {
      fs.copyFileSync(from, to);
      console.log(`→ Migrated ${path.basename(from)} into ${config.dataDir}`);
    }
  }
}

config.ensureDataDir = ensureDataDir;

module.exports = config;
