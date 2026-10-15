/**
 * Schedule-request lifecycle: read the captured request template and refresh it
 * via the Playwright scraper only when the embedded `authorization` token is
 * missing or past its expiry. (A token the API rejects early is handled by the
 * 401 retry in src/sync.js.) Re-scraping rewrites the whole template with a
 * fresh token.
 */
const fs = require('fs');
const config = require('./config');
const { grabScheduleRequest, decodeJwtExp } = require('../playwright/binusmaya-token');

function readTemplate() {
  try {
    return JSON.parse(fs.readFileSync(config.requestFile, 'utf8'));
  } catch {
    return null;
  }
}

function expiresAt(tpl) {
  if (tpl.authorizationExpiresAt) {
    const t = Date.parse(tpl.authorizationExpiresAt);
    if (!Number.isNaN(t)) return t;
  }
  // Fall back to decoding the JWT from the captured Authorization header.
  const auth = tpl.headers && tpl.headers.authorization;
  const iso = auth ? decodeJwtExp(auth) : null;
  return iso ? Date.parse(iso) : null;
}

function isExpired(tpl) {
  if (!tpl || !tpl.headers || !tpl.headers.authorization) return true;
  const exp = expiresAt(tpl);
  if (exp === null || Number.isNaN(exp)) return false; // unknown expiry → trust it until a 401
  return exp <= Date.now();
}

/**
 * Return a replayable request template with a valid `authorization` token,
 * refreshing via the scraper if needed. Pass { force: true } to always re-capture.
 */
async function getValidRequest({ force = false } = {}) {
  config.ensureDataDir();
  let tpl = readTemplate();
  if (force || isExpired(tpl)) {
    console.log(force ? '→ Forcing a new login …' : '→ Request template missing/expired — running scraper …');
    tpl = await grabScheduleRequest();
  } else {
    console.log(`→ Using cached request (token expires ${tpl.authorizationExpiresAt}).`);
  }
  return tpl;
}

module.exports = { getValidRequest, readTemplate, isExpired };
