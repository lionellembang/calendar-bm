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
 *   - As a module:  const { grabScheduleRequest } = require('./binusmaya-token');
 *   - As a CLI:     node binusmaya-token.js
 * --------------------------------------------------------------------------
 */

const { chromium } = require('playwright');
const fs = require('fs');
const config = require('./src/config');

// The single request we want to capture.
const SCHEDULE_API_RE = /func-bm7-schedule-prod\.azurewebsites\.net\/api\/Schedule\/Month-v1\//i;

const CAPTURE_TIMEOUT_MS = 60000;
const STEP_TIMEOUT_MS = 30000;

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

/**
 * Run the browser login + LMS schedule flow and capture the schedule request.
 * Writes schedule-request.json (+ tokens.json) and returns the request template.
 */
async function grabScheduleRequest() {
  config.ensureDataDir();

  // A password is only required when there's no saved session to reuse.
  if (!fs.existsSync(config.stateFile) && !isPasswordSet()) {
    throw new Error(
      'No saved session and no BINUS_PASSWORD set — set BINUS_PASSWORD in .env for the first login.'
    );
  }

  const browser = await chromium.launch({ headless: !config.headful });
  try {
    return await capture(browser);
  } finally {
    await browser.close();
    console.log('→ Browser closed.');
  }
}

async function capture(browser) {
  const haveState = fs.existsSync(config.stateFile);
  const context = await browser.newContext(haveState ? { storageState: config.stateFile } : {});
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

  // ---- 5. Persist session + outputs --------------------------------------
  await context.storageState({ path: config.stateFile });

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
 * Logs in (when needed) and waits until the authenticated dashboard has fully
 * loaded — signalled by a *visible* "LMS" app tile. Returns that tile locator.
 *
 * BINUSMAYA's post-login OAuth code-exchange (…/home#code → /home → /) is
 * intermittently flaky: sometimes it never reaches the authenticated dashboard
 * and stalls on the logged-out /home. We treat "the dashboard finished loading"
 * as "the LMS tile is visible", and if that doesn't happen we re-trigger sign-in
 * (silent SSO via the saved Microsoft cookie — no password) and try again.
 *
 * The dashboard renders its tiles in a carousel that clones slides, so several
 * `img[alt="LMS"]` exist but only one is on-screen — `:visible` avoids waiting
 * forever on a hidden clone.
 */
async function reachDashboard(page) {
  const lmsTile = page.locator('img[alt="LMS"]:visible').first();

  for (let attempt = 1; attempt <= 4; attempt++) {
    await page.goto('https://binusmaya.binus.ac.id/', { waitUntil: 'load' });
    await page.waitForLoadState('networkidle').catch(() => {});

    // Already on the authenticated dashboard? (e.g. a warm app session)
    if (await lmsTile.isVisible().catch(() => false)) return lmsTile;

    // Otherwise sign in (cold = password; warm MS cookie = silent SSO).
    const signInBtn = page.getByRole('button', { name: /Sign in with Microsoft/i });
    const haveSignIn = await signInBtn
      .waitFor({ timeout: 10000 })
      .then(() => true)
      .catch(() => false);
    if (haveSignIn) {
      console.log(`→ Signing in via Microsoft (attempt ${attempt}) …`);
      await signInBtn.click();
      await doMicrosoftLogin(page);
    }

    // Wait for the dashboard to FINISH loading (tile visible), riding out the
    // /home#code → / routing.
    console.log('→ Waiting for the dashboard to finish loading …');
    const ok = await lmsTile
      .waitFor({ timeout: 45000 })
      .then(() => true)
      .catch(() => false);
    if (ok) return lmsTile;

    console.log('→ Dashboard stalled on /home — retrying the SSO hand-off …');
  }

  throw new Error('Could not reach the authenticated BINUSMAYA dashboard (SSO kept stalling on /home).');
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
 * When a saved Microsoft session is still alive, clicking "Sign in with Microsoft"
 * redirects straight back to BINUSMAYA without ever showing the email form
 * (silent SSO). We detect that and skip the credential steps — so a reused
 * session refreshes the token without a password.
 */
async function doMicrosoftLogin(page) {
  const email = page.locator('input[type="email"]');
  try {
    await email.waitFor({ timeout: 12000 });
  } catch {
    // No email prompt: either silent SSO already bounced us back, or it will.
    if (/binusmaya\.binus\.ac\.id/.test(page.url())) {
      console.log('→ Silent SSO (no password prompt needed).');
      return;
    }
    await page.waitForURL(/binusmaya\.binus\.ac\.id/, { timeout: 20000 });
    console.log('→ Silent SSO (no password prompt needed).');
    return;
  }

  // The email form is up — this is a cold login, so we need the password.
  if (!isPasswordSet()) {
    throw new Error('Microsoft login is required but BINUS_PASSWORD is not set in .env.');
  }

  await email.fill(config.username);
  await page.locator('#idSIButton9, input[type=submit]').first().click();

  const pwd = page.locator('input[type="password"]');
  await pwd.waitFor({ timeout: 15000 });
  await pwd.fill(config.password);
  await page.locator('#idSIButton9, input[type=submit]').first().click();

  // "Stay signed in?" — click Yes if it appears (keeps the session longer).
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
