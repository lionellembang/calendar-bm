/**
 * BINUSMAYA schedule-request grabber
 * --------------------------------------------------------------------------
 * Logs into BINUSMAYA via Microsoft (Entra) SSO, then reproduces the EXACT
 * click-path a student takes to reach the schedule, and captures the FULL
 * request the portal sends to fetch a month's schedule:
 *
 *   POST https://func-bm7-schedule-prod.azurewebsites.net/api/Schedule/Month-v1/<YYYY-M-1>
 *
 * Verified action sequence:
 *   1. Log in to BINUSMAYA via Microsoft (Entra) SSO.
 *   2. On the dashboard, click the "LMS" app tile → opens a NEW TAB at
 *      lms.binus.ac.id (isSSO=true) that auto-authenticates into the LMS.
 *   3. In the LMS sidebar, click "Schedule" → loads the month view and fires
 *      the Month-v1 POST, which we capture.
 *
 * Navigating straight to the LMS schedule URL was unreliable on a cold session
 * (it bounced back to BINUSMAYA); following the UI click-path avoids that.
 *
 * Every attempt starts from nothing: a brand-new Chromium process with an empty
 * context (no cookies, no storage, no saved session), so it always walks the
 * full Microsoft email + password login. Nothing from a previous attempt or run
 * is reused.
 *
 * It records the method, URL, every request header (including the fresh
 * `authorization` Bearer token and the identification headers), and the JSON
 * body — a self-contained, replayable "request template" written to
 * <DATA_DIR>/schedule-request.json. Replaying it (see src/api.js) pulls any
 * month's schedule. Only the `authorization` token goes stale (~24h); re-running
 * this grabber refreshes it.
 *
 * The token is read straight off the live request (not from localStorage),
 * because BINUS keeps it in an AES-encrypted redux-persist blob.
 *
 * Usage:
 *   - As a module:  const { grabScheduleRequest } = require('./playwright/binusmaya-token');
 *   - As a CLI:     node playwright/binusmaya-token.js
 * --------------------------------------------------------------------------
 */


const { chromium } = require('playwright');
const fs = require('fs');
const config = require('../src/config');

// The single request we want to capture.
const SCHEDULE_API_RE = /func-bm7-schedule-prod\.azurewebsites\.net\/api\/Schedule\/Month-v1\//i;

const CAPTURE_TIMEOUT_MS = 60000;
const STEP_TIMEOUT_MS = 30000;
const CLOSE_TIMEOUT_MS = 15000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isPasswordSet() {
  return !!config.password && config.password !== 'PUT_YOUR_PASSWORD_HERE';
}

function decodeJwtExp(token) {
  const raw = (token || '').replace(/^Bearer\s+/i, '');
  const parts = raw.split('.');
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
    );
    return payload.exp ? new Date(payload.exp * 1000).toISOString() : null;
  } catch {
    return null;
  }
}

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Boot a brand-new Chromium process for one attempt. We go through
 * launchServer() rather than launch() so we hold a handle on the actual OS
 * process: its PID proves each attempt is a fresh process, and kill() lets us
 * tear it down even when a graceful close hangs.
 */
async function launchColdBrowser(attempt) {
  const server = await chromium.launchServer({ headless: !config.headful });
  const pid = server.process().pid;
  const browser = await chromium.connect(server.wsEndpoint());
  console.log(`→ Attempt ${attempt}: launched a fresh Chromium (pid ${pid}).`);
  return { server, browser, pid };
}

/**
 * Close the attempt's browser and make sure its process is really gone:
 * graceful close first, then SIGKILL the process group if it doesn't exit.
 */
async function shutdownBrowser({ server, browser, pid }) {
  await withTimeout(browser.close(), CLOSE_TIMEOUT_MS, 'browser.close() timed out').catch((err) =>
    console.error(`⚠ ${err.message}`)
  );
  try {
    await withTimeout(server.close(), CLOSE_TIMEOUT_MS, 'graceful shutdown timed out');
  } catch (err) {
    console.error(`⚠ Chromium pid ${pid}: ${err.message} — killing it.`);
    await server.kill();
  }
  if (isAlive(pid)) await server.kill();

  if (isAlive(pid)) console.error(`⚠ Chromium pid ${pid} is still running after kill.`);
  else console.log(`→ Browser closed (pid ${pid} exited).`);
}

// Only one scrape may run at a time; concurrent callers share the running one.
let inFlight = null;

/**
 * Run the browser login + LMS schedule flow and capture the schedule request.
 * Writes schedule-request.json (+ tokens.json) and returns the request template.
 *
 * The flow is occasionally flaky — most often it can't make it onto the schedule
 * page (the LMS tile / Schedule link doesn't take, or the Month-v1 POST never
 * fires). When an attempt fails or exceeds config.scrapeAttemptTimeoutSec we kill
 * the whole browser process and retry from a cold start (a brand-new Chromium
 * process + empty context, full password login) after a delay, up to
 * config.scrapeMaxAttempts.
 */
function grabScheduleRequest() {
  if (inFlight) {
    console.log('→ Scraper already running — waiting on it instead of launching another browser.');
    return inFlight;
  }
  inFlight = runScraper().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function runScraper() {
  config.ensureDataDir();

  // Every attempt logs in from scratch, so the credentials are always required.
  if (!config.username || !isPasswordSet()) {
    throw new Error('BINUS_USERNAME / BINUS_PASSWORD must be set in .env — every scrape logs in from scratch.');
  }

  const attempts = Math.max(1, config.scrapeMaxAttempts);
  const delayMs = Math.max(0, config.scrapeRetryDelaySec) * 1000;
  const attemptTimeoutMs = Math.max(1, config.scrapeAttemptTimeoutSec) * 1000;
  let lastErr;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (attempt > 1) {
      console.log(`↻ Cold-start retry ${attempt}/${attempts} in ${config.scrapeRetryDelaySec}s …`);
      await sleep(delayMs);
    }

    let handle;
    try {
      handle = await launchColdBrowser(attempt);
      // If the deadline wins, capture() keeps running until the browser is torn
      // down below; swallow its late rejection so it can't crash the process.
      const run = capture(handle.browser);
      run.catch(() => {});
      return await withTimeout(
        run,
        attemptTimeoutMs,
        `attempt exceeded ${config.scrapeAttemptTimeoutSec}s`
      );
    } catch (err) {
      lastErr = err;
      console.error(`✗ Scrape attempt ${attempt}/${attempts} failed: ${err.message}`);
    } finally {
      if (handle) await shutdownBrowser(handle);
    }
  }

  throw new Error(
    `Scraper failed after ${attempts} attempt(s): ${lastErr ? lastErr.message : 'unknown error'}`
  );
}

async function capture(browser) {
  // Deliberately no storageState: the context starts empty every attempt.
  const context = await browser.newContext();
  const cookies = await context.cookies();
  if (cookies.length) throw new Error(`New context unexpectedly has ${cookies.length} cookie(s).`);
  console.log('→ Fresh browser context (0 cookies, no saved session).');
  const page = await context.newPage();

  // ---- 1. Capture the schedule request BEFORE it fires -------------------
  // Listen at the CONTEXT level: clicking the LMS tile opens a new tab and the
  // schedule POST fires there, so a page-level listener would miss it.
  let captured = null;
  let onRequest;
  const capturePromise = new Promise((resolve) => {
    onRequest = (req) => {
      if (captured) return;
      if (req.method() !== 'POST') return;
      if (!SCHEDULE_API_RE.test(req.url())) return;

      let body = req.postData();
      try {
        body = JSON.parse(body);
      } catch {
        /* keep raw string */
      }
      captured = { method: req.method(), url: req.url(), headers: req.headers(), body };
      resolve(captured);
    };
    context.on('request', onRequest);
  });

  // ---- 2. Log in and land on the authenticated dashboard -----------------
  console.log('→ Opening BINUSMAYA …');
  const lmsTile = await reachDashboard(page);

  // ---- 3. Click through to the schedule to trigger the POST --------------
  await openSchedule(page, context, lmsTile);

  // ---- 4. Wait for the capture -------------------------------------------
  console.log('→ Waiting for the schedule request …');
  let timer;
  const timeout = new Promise((_, rej) => {
    timer = setTimeout(
      () => rej(new Error('Timed out waiting for the Schedule/Month-v1 request.')),
      CAPTURE_TIMEOUT_MS
    );
  });
  try {
    await Promise.race([capturePromise, timeout]);
  } finally {
    clearTimeout(timer);
    if (onRequest) context.off('request', onRequest);
  }

  // ---- 5. Persist outputs (the browser session itself is never saved) ----
  const auth = captured.headers['authorization'] || null;
  const template = {
    capturedAt: new Date().toISOString(),
    method: captured.method,
    capturedUrl: captured.url,
    urlTemplate:
      'https://func-bm7-schedule-prod.azurewebsites.net/api/Schedule/Month-v1/{year}-{month}-1',
    headers: captured.headers,
    body: captured.body,
    authorizationExpiresAt: decodeJwtExp(auth),
  };
  fs.writeFileSync(config.requestFile, JSON.stringify(template, null, 2));
  fs.writeFileSync(
    config.tokensFile,
    JSON.stringify(
      {
        grabbedAt: new Date().toISOString(),
        authorization: auth,
        authorizationExpiresAt: decodeJwtExp(auth),
      },
      null,
      2
    )
  );

  console.log('\n✓ Captured the schedule request.');
  console.log('  month captured       :', captured.url.split('/').pop());
  console.log('  authorization expires:', template.authorizationExpiresAt);
  console.log('  full request →', config.requestFile);
  return template;
}

/**
 * Signs in from scratch and waits until the authenticated dashboard has fully
 * loaded — signalled by a *visible* "LMS" app tile. Returns that tile locator.
 *
 * BINUSMAYA's post-login OAuth code-exchange (…/home#code → /home → /) is
 * intermittently flaky: sometimes it never reaches the authenticated dashboard
 * and stalls on the logged-out /home. We treat "the dashboard finished loading"
 * as "the LMS tile is visible"; if that doesn't happen the attempt fails and the
 * caller retries with a brand-new browser and a fresh password login.
 *
 * The dashboard renders its tiles in a carousel that clones slides, so several
 * `img[alt="LMS"]` exist but only one is on-screen — `:visible` avoids waiting
 * forever on a hidden clone.
 */
async function reachDashboard(page) {
  const lmsTile = page.locator('img[alt="LMS"]:visible').first();

  await page.goto('https://binusmaya.binus.ac.id/', { waitUntil: 'load' });
  await page.waitForLoadState('networkidle').catch(() => {});

  console.log('→ Signing in via Microsoft …');
  const signInBtn = page.getByRole('button', { name: /Sign in with Microsoft/i });
  await signInBtn.waitFor({ timeout: STEP_TIMEOUT_MS });
  await signInBtn.click();
  await doMicrosoftLogin(page);

  // Wait for the dashboard to FINISH loading (tile visible), riding out the
  // /home#code → / routing.
  console.log('→ Waiting for the dashboard to finish loading …');
  const ok = await lmsTile
    .waitFor({ timeout: 45000 })
    .then(() => true)
    .catch(() => false);
  if (!ok) throw new Error('Dashboard stalled on /home after sign-in.');
  return lmsTile;
}

/**
 * Reproduces the student's click-path to the schedule:
 *   dashboard "LMS" tile (opens a new tab) → LMS sidebar "Schedule" link.
 * This is what reliably fires the Month-v1 POST; navigating to the schedule URL
 * directly bounces back to BINUSMAYA on a cold session.
 */
async function openSchedule(page, context, lmsTile) {
  // Click the "LMS" app tile — it opens the LMS in a new tab.
  console.log('→ Clicking the LMS app tile …');
  const popupPromise = context.waitForEvent('page', { timeout: STEP_TIMEOUT_MS }).catch(() => null);
  await lmsTile.click();
  const popup = await popupPromise;
  const lms = popup || page; // fall back to the same tab if no popup opened
  await lms.waitForLoadState('domcontentloaded').catch(() => {});

  // Click "Schedule" in the LMS sidebar — this fires the Month-v1 POST.
  console.log('→ Opening the Schedule page …');
  const scheduleLink = lms.getByRole('link', { name: 'Schedule', exact: true });
  await scheduleLink.waitFor({ timeout: STEP_TIMEOUT_MS });
  await scheduleLink.click();
}

/**
 * Walks the Microsoft Entra sign-in pages. Microsoft uses #idSIButton9 as the
 * primary button on every step, so each stage is: fill field → click that button.
 *
 * The context is always empty, so the email form must appear; if Microsoft
 * skips it (silent SSO), something leaked session state and we fail the attempt.
 */
async function doMicrosoftLogin(page) {
  const email = page.locator('input[type="email"]');
  await email.waitFor({ timeout: STEP_TIMEOUT_MS }).catch(() => {
    throw new Error(`Microsoft email prompt never appeared (at ${page.url()}) — expected a fresh login.`);
  });

  await email.fill(config.username);
  await page.locator('#idSIButton9, input[type=submit]').first().click();

  const pwd = page.locator('input[type="password"]');
  await pwd.waitFor({ timeout: 15000 });
  await pwd.fill(config.password);
  await page.locator('#idSIButton9, input[type=submit]').first().click();

  // "Stay signed in?" — answer it if it appears (the session is discarded anyway).
  try {
    await page.locator('#idSIButton9').waitFor({ timeout: 8000 });
    await page.locator('#idSIButton9').click();
  } catch {
    /* prompt didn't appear — fine */
  }

  await page.waitForURL(/binusmaya\.binus\.ac\.id/, { timeout: 30000 });
}

module.exports = { grabScheduleRequest, decodeJwtExp };

// Run as a CLI when invoked directly.
if (require.main === module) {
  grabScheduleRequest()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('✗', err.message);
      process.exit(1);
    });
}
