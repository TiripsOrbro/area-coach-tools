# Area Coach Tools

Standalone Windows admin app for area coaches (WA / VIC / Taco Bell):

- Forecast (history → plan → MMX / LifeLenz)
- Build-to via Excel master workbook
- Daily reports (stock + forecast toggles)
- Prep Guides (PDF day tabs + 5am store emails)
- Live logs

Electron desktop shell with coach login, store scope, and portal credentials.

## Steam-style install (recommended)

1. Create a **local** folder for the app (example: `D:\AreaCoachTools` — avoid OneDrive).
2. Put these files in that folder:
   - **`Area Coach Tools.exe`** (from `dist/`, or build with `npm run setup:build`)
   - **`Install-Prerequisites.cmd`** + **`Install-Prerequisites.ps1`** (first-time PCs)
3. On a new PC, double-click **`Install-Prerequisites.cmd`** first (installs Git + Node.js; may ask for admin).
4. Then double-click **`Area Coach Tools.exe`**.

First run of the .exe installs **into the same folder**:

- Downloads / updates the app from GitHub into that folder
- Runs `npm install` (server + desktop + built-in Build-to)
- Creates Desktop / Start Menu shortcuts

Day-to-day: open the same **`Area Coach Tools.exe`** (or the shortcut). Each open checks GitHub for updates first.

Build the .exe from source:

```powershell
npm run setup:build
# -> dist\Area Coach Tools.exe
```

## Dev run (this folder)

```powershell
cd "Y:\Taco Bell Dashboard\Area Coach Tools"
copy .env.example .env   # first time — edit STORE_* paths
npm install
npm run desktop:install
npm run desktop:start    # Electron (WA / VIC / Taco Bell)
# or API only:
npm start                # http://localhost:3100/admin/
```

## Excel build-to

Build-to automation is **built into this app** under `mmx-report-automation/` (OH / OO / ISE download, Excel merge, MMX orders).

```powershell
npm install              # also runs buildto:install via postinstall
npm run buildto:install  # nested deps only
```

Optional override: `MMX_REPORT_AUTOMATION_DIR` in `.env` (defaults to the in-repo folder).

Prefer `Downloads\Build To Master File.xlsx`; fallback copy: `data/workbooks/Build-To-Master.xlsx`.

## Account

In the desktop app: **Account** menu → MMX / LifeLenz, alert email, tick stores in your region, Prep Guide store emails.

- **WA** → WA stores (`3901–3904` by default)
- **VIC** → all VIC stores
- **Taco Bell** → all stores (WA + VIC + others in storelist)

Optional seed (once): copy `desktop/users.seed.example.json` → `desktop/users.seed.json`.

## Packaged .exe (optional)

```powershell
npm run desktop:dist
```

Artifacts under `desktop/dist/`. The Git installer above is the supported “always latest” path.
