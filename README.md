# calender-bm — BINUSMAYA → calendar feed

Turns your BINUSMAYA schedule into live **iCalendar (`.ics`) subscription
feeds** you can add to Apple Calendar, Google Calendar, Outlook, etc. Each class
type — **Onsite**, **Online**, and **Virtual Class** — is its own calendar with
its own feed URL, so you can subscribe to whichever you want. They refresh on a
schedule. (Exams, assignments, projects, and other entries are ignored.)

Single-user, read-only, no native build dependencies.

## How it works

```
every SYNC_INTERVAL_MINUTES
  └─ sync
       ├─ request : reuse the captured schedule request, or re-capture it with
       │            the Playwright scraper (binusmaya-token.js) when the token is expired
       ├─ api     : replay the captured POST for a window of months
       ├─ parse   : keep Onsite/Online/Virtual-Class + de-duplicate + Asia/Jakarta → UTC
       └─ db      : full-replace the event set in SQLite (node:sqlite)

calendar client ──GET /calendar/<FEED_TOKEN>/<type>.ics──▶ server → ICS from SQLite
```

The scraper logs in cold (MS SSO), then reproduces the **exact click-path** a
student takes — click the **LMS** app tile on the dashboard (opens a new tab that
auto-authenticates into the LMS), then click **Schedule** in the sidebar — and
captures the **entire** `Schedule/Month-v1` request the LMS fires: method, a
`{year}-{month}` URL template, all headers (incl. the `Authorization` JWT and
identification headers) and the `roleActivity` body — into one replayable file,
`schedule-request.json`. Syncing just replays it for each month. Only the
`Authorization` JWT goes stale (~24h); re-running the scraper refreshes it.

(Navigating straight to the LMS schedule URL was unreliable on a cold session —
it bounced back to BINUSMAYA — so the scraper follows the real UI click-path. It
also waits for the dashboard to *finish* loading and retries the SSO hand-off,
since BINUSMAYA's post-login redirect occasionally stalls on the logged-out page.)

## Layout

| File | Role |
|---|---|
| `binusmaya-token.js` | Playwright scraper; cold login → click LMS tile → Schedule sidebar → captures the full schedule request. Exports `grabScheduleRequest()`, also runs as a CLI. |
| `src/config.js` | Reads `.env`; resolves data paths. |
| `src/request.js` | `getValidRequest()` — read cached request template + refresh when the token expires. |
| `src/api.js` | `fetchSchedule()` — replay the captured request per month. |
| `src/parse.js` | `parseSchedule()` — keep Onsite/Online/Virtual-Class, normalize/dedup. |
| `src/db.js` | SQLite via built-in `node:sqlite`. |
| `src/ics.js` | `buildCalendar()` — events → VCALENDAR. |
| `src/sync.js` | Orchestrates one sync. |
| `src/server.js` | Express: subscribe page + per-type ICS feeds + `/healthz`. |
| `src/page.js` | `renderSubscribePage()` — the one-click subscribe HTML. |
| `index.js` | Boots the server + interval scheduler + initial sync. |

## Requirements

- **Node ≥ 24** (uses the built-in `node:sqlite` module) — or just use Docker.

## Setup

```bash
npm install
npx playwright install chromium   # for the scraper

cp .env.example .env              # fill in BINUS_PASSWORD + a FEED_TOKEN
```

Generate a feed token:

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

### The schedule request is captured automatically

Everything the schedule API needs — the `Authorization` token, the
identification headers, and the `roleActivity` body — is captured in one pass by
the scraper and written to `<DATA_DIR>/schedule-request.json`. You don't fill
anything in. The sync runs the scraper automatically when the file is missing or
the token has expired.

## Run

```bash
# 1. First capture (interactive once, for MFA). Use a visible browser:
HEADFUL=true node binusmaya-token.js

# 2. Start the server (serves the feed + syncs on a schedule):
npm start
```

Then open the **subscribe page** and use the one-click buttons:

```
http://<host>:<PORT>/calendar/<FEED_TOKEN>
```

It lists each calendar (Onsite / Online / Virtual Class) with a **Subscribe**
button (opens Apple Calendar / Outlook via `webcal://`), an **Add to Google**
button, and a **Copy link** button for any client that subscribes "from URL".
The page is gated by the token, so the secret feed URLs never show on the public
homepage.

Prefer to wire it up by hand? The raw feeds are:

```
http://<host>:<PORT>/calendar/<FEED_TOKEN>/onsite.ics
http://<host>:<PORT>/calendar/<FEED_TOKEN>/online.ics
http://<host>:<PORT>/calendar/<FEED_TOKEN>/virtual-class.ics
```

Useful endpoints:
- `GET /` — public landing page (no secrets); points to the subscribe page.
- `GET /calendar/<FEED_TOKEN>` — the one-click subscribe page (any other token → 404).
- `GET /calendar/<FEED_TOKEN>/<type>.ics` — a feed, where `<type>` is `onsite`,
  `online`, or `virtual-class` (any other token/type → 404).
- `GET /healthz` — `{ ok, lastSync, eventCount, counts }` (`counts` is per type).

Run a one-off sync without the server: `npm run sync`.

## Docker

State lives in a named Docker volume, `calendar-data` (not a bind mount), so the
host `./data` is **not** shared with the container. The volume holds
`schedule-request.json`, `tokens.json`, `binus-state.json`, and `schedule.db` —
all captured/created automatically.

```bash
# Bootstrap the MS session once on the host (handles MFA) — writes to ./data:
HEADFUL=true node binusmaya-token.js

docker compose up -d                              # build (first run) + start
docker compose cp ./data/. calendar:/app/data/    # seed the volume from the bootstrap
docker compose restart                            # pick up the seeded state
```

- `.env` is loaded via `env_file`. Compose sets `shm_size: 1gb` and `init: true` so headless Chromium runs reliably.
- **MFA note:** the container runs the scraper headless. It can only refresh the
  request non-interactively while the saved Microsoft session in `binus-state.json`
  is valid. When that session lapses (or for the very first capture), run the
  bootstrap step on the host and copy it back in with `docker compose cp` (above).
  A cold login from a datacenter IP can also trigger a Microsoft "verify it's you"
  challenge a headless container can't answer — seed `binus-state.json` from your
  own machine in that case.
- Exposing publicly? Put it behind HTTPS (reverse proxy / Cloudflare Tunnel).

### Useful commands

```bash
docker compose build              # build the image only — don't start anything
docker compose build --no-cache   # rebuild from scratch, ignore cached layers
docker compose up -d              # start detached (builds on first run)
docker compose up -d --build      # force a rebuild, then start
docker compose ps                 # list containers + status
docker compose logs -f            # follow logs (Ctrl-C stops watching, not the app)
docker compose restart            # restart the container
docker compose down               # stop + remove the container (keeps the volume)
docker compose down -v            # also DELETE the calendar-data volume (wipes all state)

# Inspect / move state in the named volume (service name is "calendar"):
docker compose exec calendar ls -la /app/data        # list state files (while running)
docker compose cp ./file.json calendar:/app/data/    # copy a file INTO the volume
docker compose cp calendar:/app/data/schedule.db ./  # copy a file OUT to the host
docker volume ls                                     # find the volume (calender-bm_calendar-data)
docker volume inspect calender-bm_calendar-data      # volume metadata

docker compose exec calendar npm run sync            # run a one-off sync in the container
```

## Config (`.env`)

| Key | Default | Notes |
|---|---|---|
| `BINUS_USERNAME` / `BINUS_PASSWORD` | — | BINUSMAYA login for the scraper |
| `HEADFUL` | `false` | `true` shows the browser (needed once for MFA) |
| `FEED_TOKEN` | — | secret path segment for the `.ics` URL |
| `PORT` | `3000` | feed server port |
| `CALENDAR_NAME` | `BINUS Schedule` | base display name; each feed appends its type (e.g. "… — Onsite") |
| `SYNC_INTERVAL_MINUTES` | `360` | how often to refresh from the API, in minutes |
| `MONTHS_BACK` / `MONTHS_AHEAD` | `1` / `2` | month window to fetch |
| `TZ` | `Asia/Jakarta` | timezone the BINUS timestamps use |
| `DATA_DIR` | `./data` | where tokens/session/db live |

## Security

`.env`, `schedule-request.json`, `tokens.json`, and `binus-state.json` grant
access to your account and are **gitignored** — never commit them. The `.ics` URL
is protected only by the secret `FEED_TOKEN`; treat the URL as a password.
