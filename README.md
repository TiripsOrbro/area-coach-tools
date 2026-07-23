# Area Coach Tools

Standalone Windows admin app for area coaches (Ash / Tom):

- Forecast (history → plan → MMX / LifeLenz)
- Build-to via Excel master workbook
- Daily reports (stock + forecast toggles)
- Prep Guides (PDF day tabs + 5am store emails)
- Live logs

Electron desktop shell with coach login, store scope, and portal credentials.

## One-file install (recommended)

1. Install [Git](https://git-scm.com/download/win) and [Node.js 18+](https://nodejs.org/).
2. Download **`Install-AreaCoachTools.cmd`** from this repo (or copy it anywhere).
3. Double-click it.

The installer:

- Clones / updates from `https://github.com/TiripsOrbro/area-coach-tools`
- Installs into `%LOCALAPPDATA%\Programs\AreaCoachTools`
- Runs `npm install` (server + desktop)
- Creates **Desktop** and **Start Menu** shortcuts

Each shortcut launch pulls the latest Git `main`, then starts the desktop app.

PowerShell equivalent:

```powershell
irm https://raw.githubusercontent.com/TiripsOrbro/area-coach-tools/main/Install-AreaCoachTools.ps1 | iex
# or, after download:
.\Install-AreaCoachTools.ps1
.\Install-AreaCoachTools.ps1 -Quiet -Launch
```

## Dev run (this folder)

```powershell
cd "Y:\Taco Bell Dashboard\Area Coach Tools"
copy .env.example .env   # first time — edit STORE_* paths
npm install
npm run desktop:install
npm run desktop:start    # Electron (Ash / Tom)
# or API only:
npm start                # http://localhost:3100/admin/
```

## Excel build-to

Uses sibling project `mmx-report-automation` (`npm run excel-only`).  
Override with `MMX_REPORT_AUTOMATION_DIR` in `.env` if needed.

Workbook copy: `data/workbooks/Build-To-Master.xlsx` (Edit opens Excel from the admin UI).

## Account

In the desktop app: **Account** menu → MMX / LifeLenz, alert email, tick stores in your region, Prep Guide store emails.

- **Ash** → WA (`3901–3904` by default)
- **Tom** → all VIC stores

Optional seed (once): copy `desktop/users.seed.example.json` → `desktop/users.seed.json`.

## Packaged .exe (optional)

```powershell
npm run desktop:dist
```

Artifacts under `desktop/dist/`. The Git installer above is the supported “always latest” path.
