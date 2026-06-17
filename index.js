/**
 * Entrypoint: start the ICS feed server, schedule periodic syncs, and run one
 * sync on boot.
 */
const config = require('./src/config');
const { startServer } = require('./src/server');
const { runSync } = require('./src/sync');

async function safeSync(reason) {
  try {
    console.log(`(sync trigger: ${reason})`);
    await runSync();
  } catch (err) {
    console.error('✗ sync failed:', err.message);
  }
}

function main() {
  config.ensureDataDir();

  if (!config.feedToken || config.feedToken === 'change-me') {
    console.warn('⚠ FEED_TOKEN is unset/default — set a strong value in .env.');
  }

  startServer();

  const minutes = config.syncIntervalMinutes;
  if (!Number.isFinite(minutes) || minutes < 1) {
    console.error(`✗ Invalid SYNC_INTERVAL_MINUTES "${minutes}" — skipping scheduler.`);
  } else {
    setInterval(() => safeSync('interval'), minutes * 60 * 1000);
    console.log(`→ Scheduled sync: every ${minutes} minute(s).`);
  }

  // Kick off an initial sync in the background so the server is up immediately.
  safeSync('startup');
}

main();
