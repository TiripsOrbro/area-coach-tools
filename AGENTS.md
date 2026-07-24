# Area Coach Tools

Standalone admin tool for Taco Bell AU area coaches (login as **WA**, **VIC**, or
**Taco Bell**/all): forecast, Excel build-to, daily reports, prep guides, live logs. See
`README.md` for the product overview and the Windows install path.

## Cursor Cloud specific instructions

The startup update script already runs `npm install` (root) and `npm --prefix desktop install`,
so dependencies are in place when a cloud agent starts. Notes below are the non-obvious bits.

### Two Node projects (+ one nested)
- Root project = the Express API + static admin web UI (`src/app.js`, served at
  `http://localhost:3100/admin/`). This is the real functional core.
- `desktop/` = an Electron shell (`desktop/src/coach-main.js`) that starts the same Express
  server in-process and adds the coach login window. Windows is the packaging target, but on
  Linux it runs for dev/testing.
- `mmx-report-automation/` = a **bundled, nested** npm project that powers Build-to (OH / OO /
  ISE download + Excel merge + MMX orders). Root `npm install` runs a `postinstall` that
  installs its deps (`buildto:install`) and ensures Puppeteer Chrome (`puppeteer:install`), so
  a plain `npm install` covers all three. `MMX_REPORT_AUTOMATION_DIR` defaults to this in-repo
  folder (health reports `buildTo.automationSource: "builtin"`).
- Node `>=18` is required (repo tested on Node 22). There is no test runner and no linter
  configured — `package.json`/`desktop/package.json` define no `test`/`lint` scripts, so
  "run tests / lint" is a no-op for this repo.

### Local env
- Copy `.env.example` to `.env` (gitignored) for local dev. The example uses Windows `Y:\`
  paths that don't exist on Linux; this is fine:
  - `STORELIST_PATH` unset/missing → falls back to the committed `stores/.storelist`
    (VIC + WA stores).
  - `MMX_REPORT_AUTOMATION_DIR` unset → uses the bundled `./mmx-report-automation`.
- Runtime state is written to gitignored dirs: `stores/data/`, `forecast/data/`,
  `dashboard/data/`, `data/prep-guides/`.

### Running (pick ONE server — they both bind port 3100)
- API + admin UI only: `npm start` (or `npm run dev` for nodemon). Open
  `http://localhost:3100/admin/`.
- Full desktop app: from `desktop/`, run `npx electron . --no-sandbox` (sandbox flag is
  required in this container). Electron starts its OWN embedded server on 3100, so you MUST
  stop any standalone `npm start` first or Electron crashes at launch with
  `EADDRINUSE 0.0.0.0:3100` (shown as a JS error dialog).
- Electron logs dbus/GPU/`SharedImage` errors and may briefly flash a black screen with a
  spinning cube — these are cosmetic software-rendering artifacts, not crashes.
- Electron remembers the last signed-in user (electron-store at
  `~/.config/area-coach-tools-desktop/area-coach-users.json`) and auto-opens the tools window,
  skipping the login screen. Delete that file (and `stores/data/coach-session.json`) to force
  the WA/VIC/Taco Bell login screen again.

### Coach login & external services
- Login is fully local: the login window just picks WA, VIC, or Taco Bell and writes
  `stores/data/coach-session.json` (VIC → all VIC stores, WA → 3901–3904, Taco Bell → all).
  Legacy `ash`/`tom` ids still resolve to `wa`/`vic`. No external credentials are needed to log
  in and browse the admin UI. This is equivalent to `PUT /api/coach/session`.
- The heavier features (forecast backfill/submit, build-to, stock checks) drive Puppeteer
  against external portals **MacroMatix** (`tacobellau.macromatix.net`) and **LifeLenz**
  (`admin.lifelenz.com`) and need real coach credentials (set via the desktop Account screen).
  These portals are not reachable/authorised in the cloud VM, so those actions will fail
  without setup — expected.
- Quick sanity check: `curl -s http://localhost:3100/api/health` returns
  `{ success, app, stores, buildTo }`.
