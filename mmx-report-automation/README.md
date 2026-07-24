# Macromatix report automation (built into Area Coach Tools)

Vendored Build-to package used by Area Coach Tools (`../src/buildToExcel.js`).
Install deps from the parent app with `npm run buildto:install`.

Originally a standalone Node app that:

1. Logs into Macromatix (same credentials as the dashboard scraper)
2. Waits until a **key item count** gate is satisfied
3. Downloads two **Excel Data Only** reports to a local folder
4. Merges report data into a **local copy** of your company-server Excel template
5. Enters extracted values back into Macromatix

Runs in its **own process** with its **own browser profile** (`data/browser-profile`) so it does not conflict with the sales dashboard scraper.

## Prerequisites

- Node.js 16+
- Macromatix credentials in `.env` (same variables as the dashboard)
- **Windows (dev):** Google Chrome (auto-detected) or set `SCRAPER_EXECUTABLE_PATH`
- **Raspberry Pi (production):** system Chromium — see [docs/raspberry-pi-setup.md](docs/raspberry-pi-setup.md)

## Quick start (Excel only — no Macromatix login)

```bash
cd mmx-report-automation
npm install
cp .env.example .env
npm run setup
```

1. Place your **Build To workbook** where `.env` points (`MMX_BUILD_TO_DIR_*` + `MMX_BUILD_TO_FILENAME`), or use `data/workbooks` fallback.
2. Put sample exports in `data/inbox/samples/` as **`Stock On Hand.xls`** and **`Stock On Order.xls`** (or pass paths on the CLI).
3. Inspect sheets/headers:

```bash
npm run inspect -- data/workbooks/Build To JS.xlsx
npm run inspect -- "data/inbox/samples/Stock On Hand.xls"
```

4. Edit `config/excel-mapping.json` (sheet names, ranges, destination cells).
5. Merge:

```bash
npm run excel-only
```

Output: updated Build To workbook, backup under `data/out/`, and `data/out/paste-values-*.json` for a later Macromatix step.

Optional: enable tab PDF export with `MMX_PDF_EXPORT_ENABLED=true` and `MMX_PDF_EXPORT_TABS` in `.env` to generate one PDF per listed tab after recalc.
Optional: enable SMTP email sending to automatically email generated PDF attachments after each run.

### Macromatix login + key item gate

Reads `SCRAPER_USERNAME` / `SCRAPER_PASSWORD` from this app's own `.env` (this app is fully independent of live-dashboard-app — it does not read the dashboard's `.env`).

```bash
# First time: visible browser (optional)
set SCRAPER_HEADLESS=false
npm run login

# Find menu URLs (Key Item Count, stock reports)
npm run discover
# → data/out/mmx-menu-links.json

# Gate: Count In Progress → latest dropdown = Key Item Count + Applied
npm run gate-check

# After gate passes — open Report Selection → Supply Chain
npm run reports-hub
```

### Full pipeline

```bash
# Edit config/pipeline.json (see docs/mmx-report-automation-discovery.md)
npm run dry-run
npm start
```

After all scheduled orders are updated, the browser **closes** and a daily lock prevents `npm start` from running again until the next calendar day (`data/out/pipeline-complete-today.json`). Use `npm start -- --force` to override.

### Hourly key-item gate check (9 AM–11 PM)

Runs **gate check only** (no downloads or orders), once per hour in `MMX_TIME_ZONE` (default Australia/Melbourne). After **`npm start`** completes for the day (same lock as `data/out/pipeline-complete-today.json`), gate-watch **sleeps until the next day** at `MMX_GATE_SCHEDULE_START` instead of logging in hourly.

```bash
npm run gate-watch
```

Leave this running in a terminal or register it as a Windows scheduled task / service. Configure hours with `MMX_GATE_SCHEDULE_START` / `MMX_GATE_SCHEDULE_END` in `.env`.

### Continuous sales + labour workers

**Replacement for the old interval scraper** lives in `live-dashboard-app`, not this repo.

When `SCRAPER_PERSISTENT_SESSIONS=1` and `SCRAPER_CONTINUOUS_WORKERS=1` in the dashboard `.env`, the dashboard starts one worker per store (login once, labour Day view refresh every 2 min) instead of the old full-market scrape cycle.

```bash
# In live-dashboard-app:
npm run continuous-scrapers          # long-running workers
npm run test-continuous-scrapers     # short timed smoke test
```

This repo's `npm run continuous-scrapers` delegates to the dashboard runner above.

## Configuration

### Edit these first

| What | Where | Variable |
|------|--------|----------|
| Macromatix login | `.env` | `SCRAPER_USERNAME`, `SCRAPER_PASSWORD` |
| Store name (report tree) | `.env` | `MMX_STORE_NAME` |
| Build To folder — OneDrive (Windows) | `.env` | `MMX_BUILD_TO_DIR_ONEDRIVE` |
| Build To folder — Pi (when ready) | `.env` | `MMX_BUILD_TO_DIR_PI` |
| Build To folder — local fallback | `.env` | `MMX_BUILD_TO_DIR_FALLBACK` |
| Build To workbook filename | `.env` | `MMX_BUILD_TO_FILENAME` |
| Chromium on Pi | `.env.production` | `SCRAPER_EXECUTABLE_PATH` |

**Build To folder list:** set `MMX_BUILD_TO_DIR_ONEDRIVE`, `MMX_BUILD_TO_DIR_PI`, and `MMX_BUILD_TO_DIR_FALLBACK` in `.env` (one path per line). The app uses the first `MMX_BUILD_TO_FILENAME` that exists on that machine.

Or use `MMX_BUILD_TO_DIR` with semicolon-separated folders. `MMX_TEMPLATE_LOCAL` is still supported as a legacy workbook-path override.

Each file has an **EDIT THESE** section at the top — change only that block unless you need advanced options below it.

| File | Purpose |
|------|---------|
| `.env` | Shared credentials and settings (see `.env.example`) |
| `.env.windows` | Windows-only paths (OneDrive, Chrome) — auto-loaded on PC |
| `.env.pi` / `.env.production` | Pi paths and Chromium — auto-loaded on Linux |
| `config/pipeline.json` | Gate URL, two report URLs/export selectors, paste-back form |
| `config/excel-mapping.json` | Report ranges → template cells; cells → Macromatix paste keys |
| `docs/mmx-report-automation-discovery.md` | Checklist to fill before production |

### Windows + Pi (two machines)

The same repo runs on your **Windows PC** (writing/testing) and **Raspberry Pi** (hosting). Committed code uses **relative paths** by default; machine-specific absolute paths live in gitignored env files only.

**Load order:** `.env` → `.env.windows` or `.env.pi` (by OS) → `.env.production`

| Machine | Setup |
|---------|--------|
| **Windows** | `cp .env.example .env` — set credentials and the `MMX_BUILD_TO_*` values in **EDIT THESE** |
| **Pi** | Same paths in `.env` or `cp .env.pi.example .env.production` for Pi-only overrides |

Never commit `.env`, `.env.windows`, or `.env.production`. Pulling git on either machine will not overwrite them.

Cross-platform behaviour in code:
- **Paths:** `resolveConfigPath()` accepts relative, absolute Windows, Linux, and UNC paths
- **Browser:** Chrome on Windows, `/usr/bin/chromium` on Pi (`SCRAPER_EXECUTABLE_PATH` overrides)
- **Excel recalc:** Excel COM on Windows, LibreOffice on Pi (`scripts/recalc-workbook.ps1` / `.sh`)

### Environment highlights

- `MMX_TEMPLATE_SOURCE` — UNC path to master workbook on company server
- `MMX_BUILD_TO_DIR_ONEDRIVE` / `MMX_BUILD_TO_DIR_PI` / `MMX_BUILD_TO_DIR_FALLBACK` — ordered folder list; first existing workbook wins (see `.env.example`)
- `MMX_BUILD_TO_FILENAME` — workbook filename inside the selected folder (default `Build to.xlsx`)
- `MMX_DOWNLOAD_DIR` — optional override for temporary report downloads; default is a per-run temp folder under `MMX_WORK_DIR/out/tmp-report-downloads` (auto-deleted after merge)
- `MMX_TEMPLATE_LOCAL` — legacy optional semicolon-separated workbook list
- `MMX_TEMPLATE_PUBLISH` — optional write-back to server after merge
- `MMX_USER_DATA_DIR` — Chrome profile for saved login session (default `./data/browser-profile`)
- `MMX_CONTINUOUS_REQUIRE_PERSISTENT_PROFILE` — keep `true` to block long-lived workers when using ephemeral browser
- `MMX_LABOUR_STORES` — store list for labour workers (defaults to `MMX_STORE_NAME`)
- `MMX_LABOUR_REFRESH_MINUTES` — labour Day view refresh cadence (default `2`)
- `MMX_SALES_INTERVAL_MINUTES` — sales loop cadence (default matches labour refresh)
- `MMX_SALES_REPORT_URL` / `MMX_SALES_READY_SELECTOR` — optional sales target page and readiness selector
- `MMX_LABOUR_SCHEDULER_URL` — labour scheduler URL to keep open for refresh scraping
- `MMX_LABOUR_DAY_VIEW_SELECTOR` / `MMX_LABOUR_STORE_INPUT_SELECTOR` / `MMX_LABOUR_STORE_APPLY_SELECTOR` / `MMX_LABOUR_READY_SELECTOR` — optional labour UI selectors for Day/store selection and page readiness
- `MMX_WORKER_RETRY_BACKOFF_SECONDS` / `MMX_WORKER_MAX_RETRY_BACKOFF_SECONDS` — worker retry backoff controls
- `MMX_STORE_NAME` — store to select in reports tree (default `3811 Chirnside Park`)
- `MMX_PDF_EXPORT_ENABLED` — when true, export configured workbook tabs to PDF after recalc
- `MMX_PDF_EXPORT_TABS` — semicolon/comma/newline-separated workbook tab names to export
- `MMX_PDF_EXPORT_DIR` — output folder for tab PDFs (default `./data/out/pdfs`)
- `MMX_EMAIL_ENABLED` — when true, send exported PDFs as email attachments
- `MMX_EMAIL_SEND_ON_DRY_RUN` — allow email sends during dry-run (default `true`)
- `MMX_EMAIL_SMTP_HOST` / `MMX_EMAIL_SMTP_PORT` / `MMX_EMAIL_SMTP_SECURE` — SMTP connection settings
- `MMX_EMAIL_SMTP_USER` / `MMX_EMAIL_SMTP_PASS` — SMTP auth credentials
- `MMX_EMAIL_FROM` / `MMX_EMAIL_TO` / `MMX_EMAIL_CC` — sender and recipients (`MMX_EMAIL_TO` supports `;` separators)
- `MMX_MANUAL_FILL_PATH` / `MMX_MANUAL_FILL_FILENAME` — optional manual-fill workbook attachment source (defaults to `Build To Manual Fill.xlsx` beside Build To workbook)

## Commands

| Command | Description |
|---------|-------------|
| `npm run setup` | Create `config/pipeline.json` and `config/excel-mapping.json` from examples |
| `npm run inspect -- <file.xlsx>` | List sheet names and row-1 headers (discovery) |
| `npm run excel-only` | Merge reports into configured Build To workbook (local files only) |
| `npm run login` | Log in only; store session in userDataDir |
| `npm run discover` | After login, list Macromatix menu links (find gate/report URLs) |
| `npm run gate-check` | Login + Stock Count → Count In Progress → latest = Key Item + Applied |
| `npm run reports-hub` | After gate passes, open **Report Selection → Supply Chain** (export TBD) |
| `npm run dry-run` | Gate + download + Excel merge; skip Macromatix paste submit |
| `npm start` | Full pipeline |
| `npm run gate-watch` | Hourly gate check (9 AM–11 PM); pauses until tomorrow after full pipeline; Pi: systemd |
| `npm run continuous-scrapers` | Independent sales + labour loops with persistent logged-in sessions |

Exit codes: `0` success or gate skipped (not ready); `1` error.

## Login session

Password-only login. First run can use `SCRAPER_HEADLESS=false` and `npm run login` to confirm the browser reaches Macromatix. Later runs reuse cookies in `MMX_USER_DATA_DIR` until the session expires.

**Do not** share `MMX_USER_DATA_DIR` with the dashboard’s browser profile.

## Scheduling

**Windows** — Task Scheduler:

```
cd Y:\Taco Bell Dashboard\mmx-report-automation
node src\run.js
```

**Raspberry Pi** — see **[docs/raspberry-pi-setup.md](docs/raspberry-pi-setup.md)** for Chromium, bootstrap, and **`./deploy/systemd/install-units.sh`** (gate-watch with auto-restart, git pull every 15 min, daily pipeline timer).

## Project layout

```
mmx-report-automation/
  config/           pipeline + excel mapping (gitignored when filled)
  data/
    workbooks/      fallback workbook location (when not using Build To path)
    inbox/          local sample reports for excel-only testing
    out/            backups + paste-values JSON
    browser-profile/ saved login session (gitignored)
  docs/             discovery checklist + raspberry-pi-setup.md
  src/
    run*.js         CLI entries (full pipeline, excel-only, scheduler)
    mmx-*.js        Macromatix browser + navigation helpers
    pipeline-*.js   gate/download/excel/order pipeline modules
    util-*.js       shared utility modules
```

## Separation from live-dashboard-app

| | Dashboard | This app |
|---|-----------|----------|
| Express UI | Yes | No |
| Sales labour scrape | Yes (continuous workers when `SCRAPER_CONTINUOUS_WORKERS=1`) | Delegates to dashboard |
| Puppeteer + MMX login | Yes | Yes (duplicated auth module) |
| exceljs | No | Yes |
| Scheduled with dashboard | No — use separate job |
