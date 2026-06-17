/**
 * The token-gated subscribe page: one card per calendar with one-click subscribe
 * buttons. Served at GET /calendar/<FEED_TOKEN> (HTML), so the secret feed URLs
 * never appear on the public homepage.
 */
const config = require('./config');

// Display order + copy for each calendar. `label` matches the scheduleType so it
// keys straight into countsByType().
const CALENDARS = [
  { slug: 'onsite', label: 'Onsite', icon: '🏫', blurb: 'In-person classes, with the room as the location.' },
  { slug: 'online', label: 'Online', icon: '💻', blurb: 'Online sessions; the Zoom link is the location when provided.' },
  { slug: 'virtual-class', label: 'Virtual Class', icon: '🎥', blurb: 'Scheduled virtual class sessions.' },
];

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderSubscribePage({ token, host, proto, counts = {}, lastSync }) {
  const encToken = encodeURIComponent(token);

  const cards = CALENDARS.map((c) => {
    const httpsUrl = `${proto}://${host}/calendar/${encToken}/${c.slug}.ics`;
    const webcalUrl = `webcal://${host}/calendar/${encToken}/${c.slug}.ics`;
    const googleUrl = `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(webcalUrl)}`;
    const n = counts[c.label] || 0;
    return `
      <article class="card">
        <header>
          <span class="icon" aria-hidden="true">${c.icon}</span>
          <h2>${esc(c.label)}</h2>
          <span class="count">${n} event${n === 1 ? '' : 's'}</span>
        </header>
        <p class="blurb">${esc(c.blurb)}</p>
        <div class="actions">
          <a class="btn primary" href="${esc(webcalUrl)}">Subscribe</a>
          <a class="btn" href="${esc(googleUrl)}" target="_blank" rel="noopener">Add to Google</a>
          <button class="btn copy" type="button" data-url="${esc(httpsUrl)}">Copy link</button>
        </div>
        <code class="url">${esc(httpsUrl)}</code>
      </article>`;
  }).join('\n');

  const synced = lastSync ? `Last synced ${esc(lastSync)}` : 'Not synced yet';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${esc(config.calendarName)} — Subscribe</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    font: 16px/1.5 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    margin: 0; padding: 2.5rem 1rem; background: Canvas; color: CanvasText;
  }
  main { max-width: 44rem; margin: 0 auto; }
  h1 { font-size: 1.6rem; margin: 0 0 .25rem; }
  .lede { margin: 0 0 1.75rem; opacity: .75; }
  .cards { display: grid; gap: 1rem; }
  .card {
    border: 1px solid color-mix(in srgb, CanvasText 18%, transparent);
    border-radius: 14px; padding: 1.1rem 1.25rem;
  }
  .card header { display: flex; align-items: center; gap: .6rem; }
  .card .icon { font-size: 1.4rem; }
  .card h2 { font-size: 1.15rem; margin: 0; flex: 1; }
  .count { font-size: .8rem; opacity: .65; white-space: nowrap; }
  .blurb { margin: .5rem 0 .9rem; opacity: .8; font-size: .92rem; }
  .actions { display: flex; flex-wrap: wrap; gap: .5rem; }
  .btn {
    appearance: none; cursor: pointer; font: inherit; font-size: .9rem;
    border: 1px solid color-mix(in srgb, CanvasText 25%, transparent);
    background: color-mix(in srgb, CanvasText 6%, transparent); color: inherit;
    padding: .45rem .85rem; border-radius: 9px; text-decoration: none;
  }
  .btn:hover { background: color-mix(in srgb, CanvasText 12%, transparent); }
  .btn.primary { background: #2563eb; border-color: #2563eb; color: #fff; }
  .btn.primary:hover { background: #1d4ed8; }
  .btn.ok { background: #16a34a; border-color: #16a34a; color: #fff; }
  .url {
    display: block; margin-top: .8rem; font-size: .78rem; word-break: break-all;
    opacity: .6;
  }
  footer { margin-top: 1.75rem; font-size: .82rem; opacity: .6; }
  footer a { color: inherit; }
</style>
</head>
<body>
<main>
  <h1>${esc(config.calendarName)}</h1>
  <p class="lede"><strong>Subscribe</strong> opens your calendar app (Apple&nbsp;Calendar, Outlook). For Google use <em>Add to Google</em>, or <em>Copy link</em> and paste it into any client that subscribes “from URL”.</p>
  <div class="cards">
${cards}
  </div>
  <footer>${synced} · <a href="/healthz">status</a></footer>
</main>
<script>
  for (const b of document.querySelectorAll('.copy')) {
    b.addEventListener('click', async () => {
      const url = b.dataset.url;
      try {
        await navigator.clipboard.writeText(url);
        const label = b.textContent;
        b.textContent = 'Copied!'; b.classList.add('ok');
        setTimeout(() => { b.textContent = label; b.classList.remove('ok'); }, 1500);
      } catch {
        window.prompt('Copy this URL', url);
      }
    });
  }
</script>
</body>
</html>`;
}

module.exports = { renderSubscribePage };
