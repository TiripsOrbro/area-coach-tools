/**
 * Prep Guides: fill Prep Guide.xlsx inputs, fetch missing history/ISE,
 * render landscape PDFs matching the printable Prep Guide layout.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const paths = require('../../../src/paths');
const { recentDays, listDayKeys } = require('../../../forecast/src/historyStore');
const { listStoresForCoach } = require('../../../stores/src/coachScope');
const { getStoreList } = require('../../../stores/src/storeList');
const { weekTotalsForStore, BACKFILL_DAYS } = require('../../../forecast/src/forecastRunner');
const { melbourneToday, addDaysIso } = require('../../../forecast/src/planEngine');
const storeEmails = require('../storeEmails');

const TEMPLATE = path.join(paths.root, 'data', 'workbooks', 'Prep-Guide-Template.xlsx');
const SOURCE_DOWNLOAD = path.join(process.env.USERPROFILE || '', 'Downloads', 'Prep Guide.xlsx');
const OUT_ROOT = path.join(paths.root, 'data', 'prep-guides');
const STATE_FILE = path.join(paths.dashboard.data, 'prep-guides-state.json');

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const WEEKDAY_INDEX = { Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6 };
const WEEKDAY_COL = { Monday: 2, Tuesday: 3, Wednesday: 4, Thursday: 5, Friday: 6, Saturday: 7, Sunday: 8 };
const PURPLE = '#5b2d8e';

const COOK_LABELS = {
    'MEAT BEEF COOKED': 'BEEF',
    'MEAT CHICKEN COOKED': 'CHICKEN',
    'BEANS BLACK COOKED': 'BEANS',
    'SAUCE NACHO CHEESE': 'NACHO CHEESE',
    'TB MEXICAN RICE (FINISHED PRODUCT)': 'RICE',
};

const SALAD_ORDER = [
    ['TB FIESTA SALSA (FINISHED PRODUCT)', 'FIESTA (PANS)'],
    ['TB GUACAMOLE (FINISHED PRODUCT)', 'GUAC (PANS)'],
    ['CREAM SOUR LIGHT', 'SOUR CREAM'],
    ['SAUCE ZESTY RANCH 1', 'ZESTY RANCH'],
    ['SAUCE CHIPOTLE MAYO 1', 'CHIPOTLE MAYO'],
    ['LAVA SAUCE', 'LAVA'],
    ['SAUCE CREAMY JALAPENO', 'CREAMY J'],
    ['SAUCE CHILLI MILD', 'MILD'],
    ['SAUCE FIRE 10X1KG', 'FIRE'],
];

const FRY_ORDER = [
    ['TB TACO SHELLS (FINISHED PRODUCT)', 'TACOS'],
    ['TB TOSTADA (FINISHED PRODUCT)', 'TOSTADAS'],
    ['CHIP NACHO CORN', 'NACHO CHIPS'],
    ['CINNAMON TWISTS', 'CIN TWISTS'],
];

const THAW_ORDER = [
    ['TORTILLA FLOUR 12INCH', '12" TORTILLAS'],
    ['TORTILLA FLOUR 10.25INCH', '10" TORTILLAS'],
    ['TORTILLA FLOUR 6.5INCH', '6" TORTILLAS'],
    ['FlatBread', 'FLAT BREADS'],
    ['TORTILLA CORN 6 INCH', 'TOSTADAS'],
    ['CHIP NACHO CORN', 'NACHO CHIPS'],
    ['MEAT BEEF COOKED', 'BEEF'],
];

function ensureTemplate() {
    fs.mkdirSync(path.dirname(TEMPLATE), { recursive: true });
    if (fs.existsSync(SOURCE_DOWNLOAD)) {
        // Keep working template in sync with Downloads master (byte copy only)
        fs.copyFileSync(SOURCE_DOWNLOAD, TEMPLATE);
        return TEMPLATE;
    }
    if (fs.existsSync(TEMPLATE)) return TEMPLATE;
    throw new Error('Prep Guide.xlsx not found in Downloads or data/workbooks.');
}

function storeDir(storeNumber) {
    const dir = path.join(OUT_ROOT, String(storeNumber));
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function storeLabel(storeNumber) {
    const row = getStoreList().find((s) => String(s.storeNumber) === String(storeNumber));
    const name = row?.storeName || '';
    return name ? `${storeNumber} - ${name}` : String(storeNumber);
}

function weekdayForIso(dateKey, timeZone = process.env.DASHBOARD_TIME_ZONE || 'Australia/Melbourne') {
    const [y, m, d] = String(dateKey).split('-').map(Number);
    const utc = new Date(Date.UTC(y, m - 1, d, 12));
    return new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long' }).format(utc);
}

function nextDateForWeekday(weekdayName) {
    const today = melbourneToday();
    for (let i = 0; i < 7; i++) {
        const key = addDaysIso(today, i);
        if (weekdayForIso(key) === weekdayName) return key;
    }
    return today;
}

function formatMoney(n) {
    return `$${Math.round(Number(n) || 0).toLocaleString('en-AU')}`;
}

function formatDdMmYyyy(dateKey) {
    const [y, m, d] = String(dateKey).split('-');
    return `${d}/${m}/${y}`;
}

function unitWord(units, qty) {
    const u = String(units || '').trim();
    const n = Math.max(0, Math.round(Number(qty) || 0));
    const map = {
        Pans: n === 1 ? 'PAN' : 'PANS',
        Trays: n === 1 ? 'TRAY' : 'TRAYS',
        Tubs: n === 1 ? 'TUB' : 'TUBS',
        Cups: n === 1 ? 'CUP' : 'CUPS',
        Bottles: n === 1 ? 'BOTTLE' : 'BOTTLES',
        Boxes: n === 1 ? 'BOX' : 'BOXES',
        Bags: n === 1 ? 'BAG' : 'BAGS',
    };
    return `${n} ${map[u] || u.toUpperCase() || 'UNITS'}`;
}

async function ensureHistoryData(storeNumber) {
    const days = listDayKeys(storeNumber).length;
    if (days >= 21) return { ok: true, skipped: true, days };
    try {
        const { backfillHistoryFromMmx, BACKFILL_DAYS: daysBack } = require('../../../forecast/src/forecastRunner');
        const result = await backfillHistoryFromMmx(storeNumber, daysBack || BACKFILL_DAYS || 35);
        return {
            ok: Boolean(result.ok),
            days: listDayKeys(storeNumber).length,
            imported: result.imported || 0,
            error: result.error || null,
            logs: result.logs || [],
        };
    } catch (err) {
        return { ok: false, days, error: err.message || String(err) };
    }
}

function iseSnapshotCount(storeNumber) {
    try {
        const { listWeeklySnapshots } = require('../reportSubscriptions/iseHistoryLedger');
        return listWeeklySnapshots(storeNumber, {}, 5).filter(Boolean).length;
    } catch {
        return 0;
    }
}

async function ensureIseData(storeNumber) {
    if (iseSnapshotCount(storeNumber) >= 3) return { ok: true, skipped: true };
    // Best effort: download Inventory Special Event via mmx-report-automation
    try {
        const { automationRoot } = require('../../../src/buildToExcel');
        const root = automationRoot();
        if (!root || !fs.existsSync(path.join(root, 'package.json'))) {
            return { ok: false, error: 'mmx-report-automation missing for ISE download' };
        }
        const { readSession } = require('../../../stores/src/coachSession');
        const session = readSession();
        const label = storeLabel(storeNumber).replace(' - ', ' ');
        const result = spawnSync(
            process.execPath,
            [path.join(root, 'src', 'run.js'), '--download-inventory-event', '--skip-gate', '--force'],
            {
                cwd: root,
                encoding: 'utf8',
                timeout: 300000,
                env: {
                    ...process.env,
                    SCRAPER_USERNAME: session.mmx?.username || process.env.SCRAPER_USERNAME || '',
                    SCRAPER_PASSWORD: session.mmx?.password || process.env.SCRAPER_PASSWORD || '',
                    MMX_STORE_NAME: label,
                    MMX_LABOUR_STORES: label,
                    MMX_PDF_EXPORT_ENABLED: 'false',
                    MMX_EMAIL_ENABLED: 'false',
                },
                windowsHide: true,
            }
        );
        // Try to ingest any downloaded ISE csv/xls under automation download folders
        try {
            const { recordIseSnapshotFromFile } = require('../reportSubscriptions/iseHistoryLedger');
            const searchRoots = [
                path.join(root, 'data'),
                path.join(paths.root, 'vendors', 'reports', String(storeNumber)),
            ];
            for (const dir of searchRoots) {
                if (!fs.existsSync(dir)) continue;
                const files = walkFiles(dir).filter((f) => /inventory|ise|special.?event/i.test(f));
                for (const file of files.slice(-3)) {
                    try {
                        recordIseSnapshotFromFile(storeNumber, file, { source: 'prep-guide' });
                    } catch {
                        /* ignore */
                    }
                }
            }
        } catch {
            /* ledger optional */
        }
        return {
            ok: result.status === 0 || iseSnapshotCount(storeNumber) > 0,
            snapshots: iseSnapshotCount(storeNumber),
            error: result.status === 0 ? null : (result.stderr || result.stdout || '').slice(-400),
        };
    } catch (err) {
        return { ok: false, error: err.message || String(err) };
    }
}

function walkFiles(dir, out = [], depth = 0) {
    if (depth > 4 || !fs.existsSync(dir)) return out;
    for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        try {
            const st = fs.statSync(full);
            if (st.isDirectory()) walkFiles(full, out, depth + 1);
            else out.push(full);
        } catch {
            /* ignore */
        }
    }
    return out;
}

/** 5 most recent same-weekday hourly series for Sheet1-style input. */
function fiveWeekHourlyForWeekday(storeNumber, weekdayName) {
    return recentDays(storeNumber, 70)
        .filter((d) => weekdayForIso(d.dateKey) === weekdayName)
        .slice(-5);
}

async function writeStoreWorkbook(storeNumber) {
    ensureTemplate();
    const ExcelJS = require('exceljs');
    const outPath = path.join(storeDir(storeNumber), 'Prep-Guide.xlsx');
    fs.copyFileSync(TEMPLATE, outPath);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(outPath);

    // Weekly Forecast — this week $ by weekday from forecast plan
    const weeks = weekTotalsForStore(storeNumber, 1);
    const weekState = weeks.weekStates?.[0];
    const wf = wb.getWorksheet('Weekly Forecast');
    if (wf && weekState) {
        const { buildPlan } = require('../../../forecast/src/planEngine');
        const dates = [];
        for (let d = 0; d < 7; d++) dates.push(addDaysIso(weekState.monday, d));
        const plan = buildPlan({ storeNumber, targetDates: dates, historyDays: 35 });
        const totals = {};
        let weekTotal = 0;
        for (const day of plan.days || []) {
            const label = weekdayForIso(day.dateKey);
            totals[label] = Math.round(Number(day.total) || 0);
            weekTotal += totals[label];
        }
        // Only overwrite forecast $ when we have real history-based totals
        if (weekTotal > 0) {
            wf.getCell('A2').value = 'Forecast Sales $';
            wf.getCell('B2').value = weekTotal;
            WEEKDAYS.forEach((name, idx) => {
                wf.getCell(1, idx + 3).value = name;
                wf.getCell(2, idx + 3).value = totals[name] || 0;
            });
        }
    }

    // Update store name on Prep Guide header cells (keep layout/formatting)
    for (const sheetName of ['Prep Guide', 'Prep Guide Calculations']) {
        const sheet = wb.getWorksheet(sheetName);
        if (!sheet) continue;
        sheet.getCell('H3').value = storeLabel(storeNumber);
    }

    // Sheet1 — last 5 weeks of hourly for today's weekday (feeds Sales averages when Excel recalcs)
    const sheet1 = wb.getWorksheet('Sheet1');
    const focusDay = weekdayForIso(melbourneToday());
    const series = fiveWeekHourlyForWeekday(storeNumber, focusDay);
    if (sheet1 && series.length) {
        sheet1.getCell('A1').value = storeLabel(storeNumber);
        sheet1.getCell('A4').value = 'Total';
        for (let w = 0; w < 5; w++) {
            sheet1.getCell(2, w + 2).value = `${w + 1} week ago`;
            const day = series[series.length - 1 - w];
            const actual = day?.actual || [];
            let total = 0;
            for (let h = 0; h < 24; h++) {
                const v = Number(actual[h]) || 0;
                total += v;
                sheet1.getCell(5 + h, w + 2).value = v;
            }
            sheet1.getCell(4, w + 2).value = Math.round(total * 100) / 100;
            if (day?.dateKey) sheet1.getCell(3, w + 2).value = day.dateKey;
        }
    }

    await wb.xlsx.writeFile(outPath);
    return outPath;
}

function recalcWorkbook(workbookPath) {
    try {
        const autoRoot =
            process.env.MMX_REPORT_AUTOMATION_DIR ||
            path.join('Y:', 'Taco Bell Dashboard', 'mmx-report-automation');
        const ps1 = path.join(autoRoot, 'scripts', 'recalc-workbook.ps1');
        if (process.platform === 'win32' && fs.existsSync(ps1)) {
            const result = spawnSync(
                'powershell',
                ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1, '-Path', workbookPath],
                { encoding: 'utf8', timeout: 180000, windowsHide: true }
            );
            return { ok: result.status === 0, engine: 'excel-com', detail: (result.stdout || result.stderr || '').slice(-500) };
        }
    } catch (err) {
        return { ok: false, error: err.message };
    }
    return { ok: false, skipped: true };
}

function readAoA(workbookPath, sheetName) {
    const xlsx = require('xlsx');
    const wb = xlsx.readFile(workbookPath, { cellDates: true });
    const sheet = wb.Sheets[sheetName];
    if (!sheet) return [];
    return xlsx.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: true });
}

function buildDayGuide(workbookPath, storeNumber, weekdayName) {
    const col = WEEKDAY_COL[weekdayName];
    const pbs = readAoA(workbookPath, 'Product Block Sales');
    const prep = readAoA(workbookPath, 'Prep Simplified');
    const weekly = readAoA(workbookPath, 'Weekly Forecast');

    // Forecast $ for weekday from Weekly Forecast row 2 (1-index) cols C-I = Mon-Sun
    let forecastSales = 0;
    if (weekly[1]) {
        const idx = WEEKDAYS.indexOf(weekdayName);
        forecastSales = Number(weekly[1][idx + 2]) || 0;
    }

    const cookBlocks = ['8:45', '10:30', '14:00', '15:30', '19:00'];
    const cook = {
        BEEF: [],
        CHICKEN: [],
        BEANS: [],
        'NACHO CHEESE': [],
        RICE: [],
    };
    for (const block of cookBlocks) {
        for (const [raw, label] of Object.entries(COOK_LABELS)) {
            const row = pbs.find(
                (r) =>
                    String(r[0] || '').trim().toUpperCase() === raw.toUpperCase() &&
                    String(r[1] || '').trim() === block
            );
            const val = row ? Number(row[col]) || 0 : 0;
            if (label === 'RICE') {
                const pans = Math.max(0, Math.round(val));
                cook[label].push(pans <= 1 ? '1 PAN' : `${pans} PANS`);
            } else {
                cook[label].push(Math.max(0, Math.round(val)));
            }
        }
    }

    function prepItems(order) {
        return order.map(([raw, label]) => {
            const row = prep.find((r) => String(r[1] || '').trim().toUpperCase() === raw.toUpperCase());
            const units = row ? String(row[9] || '').trim() : '';
            // Prefer "today+tomorrow" qty columns (11-17) when present, else base (2-8)
            const qty = row ? Number(row[col + 9] != null && row[col + 9] !== '' ? row[col + 9] : row[col]) || 0 : 0;
            return { label, value: unitWord(units, qty) };
        });
    }

    // Salad order in photo: Fiesta, Guac first then sauces
    const salad = prepItems(SALAD_ORDER);
    const fry = prepItems(FRY_ORDER);
    const thaw = prepItems(THAW_ORDER);

    return {
        storeNumber: String(storeNumber),
        storeLabel: storeLabel(storeNumber),
        weekday: weekdayName,
        dateKey: nextDateForWeekday(weekdayName),
        forecastSales,
        cookBlocks,
        cook,
        salad,
        fry,
        thaw,
    };
}

function dayHtml(guide) {
    const cookRows = ['BEEF', 'CHICKEN', 'BEANS', 'NACHO CHEESE', 'RICE']
        .map((name) => {
            const cells = (guide.cook[name] || []).map((v) => `<td class="num">${v}</td>`).join('');
            return `<tr><th>${name}</th>${cells}</tr>`;
        })
        .join('');

    const colHtml = (title, rows) => `
      <div class="col">
        <div class="col-head">${title}</div>
        <table class="list">${rows
            .map((r) => `<tr><td class="item">${r.label}</td><td class="qty">${r.value}</td></tr>`)
            .join('')}</table>
      </div>`;

    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  @page { size: A4 landscape; margin: 8mm; }
  * { box-sizing: border-box; }
  body {
    margin: 0; font-family: Arial, Helvetica, sans-serif; color: #111;
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
  .page { width: 1120px; margin: 0 auto; }
  .banner {
    background: ${PURPLE}; color: #fff; text-align: center;
    font-size: 28px; font-weight: 700; padding: 10px 12px; border: 2px solid #111;
  }
  .meta {
    display: grid; grid-template-columns: 1.2fr 1fr 1.2fr; border: 2px solid #111; border-top: 0;
  }
  .meta .cell { border-right: 2px solid #111; }
  .meta .cell:last-child { border-right: 0; }
  .meta .label { background: ${PURPLE}; color: #fff; font-weight: 700; padding: 8px 10px; }
  .meta .value { padding: 10px; font-size: 22px; font-weight: 700; min-height: 44px; }
  .meta .center { text-align: center; }
  .initial { border: 2px solid #111; border-top: 0; padding: 8px 10px; font-weight: 700; }
  table.cook {
    width: 100%; border-collapse: collapse; margin-top: 10px;
    border: 2px solid #111;
  }
  table.cook th, table.cook td {
    border: 1px solid #111; padding: 8px 6px; text-align: center; font-size: 16px;
  }
  table.cook thead th { background: ${PURPLE}; color: #fff; font-weight: 700; }
  table.cook tbody th { text-align: left; padding-left: 10px; background: #fff; width: 160px; }
  table.cook td.num { font-weight: 700; }
  .bottom {
    display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 0; margin-top: 12px;
    border: 2px solid #111;
  }
  .col { border-right: 2px solid #111; min-height: 280px; display: flex; flex-direction: column; }
  .col:last-child { border-right: 0; }
  .col-head {
    background: ${PURPLE}; color: #fff; text-align: center;
    font-weight: 700; padding: 8px; border-bottom: 2px solid #111;
  }
  table.list { width: 100%; border-collapse: collapse; flex: 1; }
  table.list td { border-bottom: 1px solid #111; padding: 7px 8px; font-size: 14px; }
  table.list td.item { font-weight: 700; }
  table.list td.qty { text-align: right; font-weight: 700; white-space: nowrap; }
</style></head><body>
  <div class="page">
    <div class="banner">Prep Guide</div>
    <div class="meta">
      <div class="cell">
        <div class="label">Forecasted Sales Below:</div>
        <div class="value">${formatMoney(guide.forecastSales)}</div>
      </div>
      <div class="cell">
        <div class="label center">${guide.storeLabel}</div>
        <div class="value center">${guide.weekday}</div>
      </div>
      <div class="cell">
        <div class="label center">&nbsp;</div>
        <div class="value center">${formatDdMmYyyy(guide.dateKey)}</div>
      </div>
    </div>
    <div class="initial">Manager Initial:</div>
    <table class="cook">
      <thead>
        <tr>
          <th>Cook Cycle</th>
          ${guide.cookBlocks.map((b) => `<th>${b}</th>`).join('')}
        </tr>
      </thead>
      <tbody>${cookRows}</tbody>
    </table>
    <div class="bottom">
      ${colHtml('SALAD PREP', guide.salad)}
      ${colHtml('FRY PREP', guide.fry)}
      ${colHtml('THAWING', guide.thaw)}
    </div>
  </div>
</body></html>`;
}

async function renderPdf(html, outFile) {
    const puppeteer = require('../../../src/puppeteerCompat');
    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    try {
        const page = await browser.newPage();
        await page.setContent(html, { waitUntil: 'networkidle0' });
        await page.pdf({
            path: outFile,
            landscape: true,
            format: 'A4',
            printBackground: true,
            margin: { top: '6mm', bottom: '6mm', left: '6mm', right: '6mm' },
        });
    } finally {
        await browser.close();
    }
}

async function regenerateStore(storeNumber) {
    const store = String(storeNumber || '').trim();
    const logs = [];
    const push = (m) => {
        logs.push(m);
        console.log(`[prep-guides ${store}] ${m}`);
    };

    push('Ensuring sales history...');
    const history = await ensureHistoryData(store);
    push(
        history.skipped
            ? `History ready (${history.days} days).`
            : history.ok
              ? `Backfilled history - now ${history.days} days (imported ${history.imported || 0}).`
              : `History backfill issue: ${history.error || 'unknown'}`
    );

    push('Ensuring ISE data...');
    const ise = await ensureIseData(store);
    push(
        ise.skipped
            ? 'ISE snapshots already present.'
            : ise.ok
              ? `ISE ready (${ise.snapshots || iseSnapshotCount(store)} snapshots).`
              : `ISE fetch skipped/failed: ${ise.error || 'unknown'} - using workbook averages if available.`
    );

    push('Writing store workbook from Prep Guide template...');
    const workbookPath = await writeStoreWorkbook(store);
    const recalc = recalcWorkbook(workbookPath);
    push(
        recalc.ok
            ? 'Excel recalculated formulas.'
            : `Excel recalc ${recalc.skipped ? 'skipped' : 'failed'} - using sheet values as available.`
    );

    const dir = storeDir(store);
    const pdfs = {};
    for (const weekday of WEEKDAYS) {
        const guide = buildDayGuide(workbookPath, store, weekday);
        const html = dayHtml(guide);
        const pdfFile = path.join(dir, `${weekday}.pdf`);
        await renderPdf(html, pdfFile);
        pdfs[weekday] = pdfFile;
        push(`PDF ready: ${weekday} (forecast ${formatMoney(guide.forecastSales)})`);
    }

    const meta = {
        storeNumber: store,
        regeneratedAt: new Date().toISOString(),
        workbookPath,
        pdfs,
        logs,
        history,
        ise,
    };
    fs.writeFileSync(path.join(dir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
    return meta;
}

function listStoreStatus(storeNumbers = null) {
    const stores = Array.isArray(storeNumbers)
        ? storeNumbers.map(String)
        : listStoresForCoach().map((s) => String(s.storeNumber));
    return stores.map((storeNumber) => {
        const dir = path.join(OUT_ROOT, storeNumber);
        const metaPath = path.join(dir, 'meta.json');
        let meta = null;
        if (fs.existsSync(metaPath)) {
            try {
                meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
            } catch {
                meta = null;
            }
        }
        const pdfs = {};
        for (const weekday of WEEKDAYS) {
            const p = path.join(dir, `${weekday}.pdf`);
            pdfs[weekday] = fs.existsSync(p) ? p : null;
        }
        return {
            storeNumber,
            email: storeEmails.getEmail(storeNumber),
            regeneratedAt: meta?.regeneratedAt || null,
            workbookPath: meta?.workbookPath || null,
            pdfs,
        };
    });
}

function pdfPath(storeNumber, weekday) {
    const name = WEEKDAYS.find((w) => w.toLowerCase() === String(weekday || '').toLowerCase()) || weekday;
    const p = path.join(OUT_ROOT, String(storeNumber), `${name}.pdf`);
    return fs.existsSync(p) ? p : null;
}

function melbourneNowParts() {
    const tz = process.env.DASHBOARD_TIME_ZONE || 'Australia/Melbourne';
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        weekday: 'long',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    }).formatToParts(new Date());
    const get = (type) => parts.find((p) => p.type === type)?.value;
    return {
        dateKey: `${get('year')}-${get('month')}-${get('day')}`,
        weekday: get('weekday'),
        hour: Number(get('hour')),
        minute: Number(get('minute')),
    };
}

function readState() {
    if (!fs.existsSync(STATE_FILE)) return { lastEmailDateKey: null };
    try {
        return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    } catch {
        return { lastEmailDateKey: null };
    }
}

function writeState(state) {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

async function sendPrepGuideEmail(storeNumber, weekday) {
    const to = storeEmails.getEmail(storeNumber);
    if (!to) return { ok: false, skipped: true, reason: 'no email' };
    const file = pdfPath(storeNumber, weekday);
    if (!file) return { ok: false, error: 'PDF missing - regenerate first' };
    const host = process.env.DASHBOARD_SMTP_HOST;
    if (!host) return { ok: false, error: 'DASHBOARD_SMTP_HOST not set' };
    const nodemailer = require('nodemailer');
    const transport = nodemailer.createTransport({
        host,
        port: Number(process.env.DASHBOARD_SMTP_PORT || 587),
        secure: false,
        auth: process.env.DASHBOARD_SMTP_USER
            ? { user: process.env.DASHBOARD_SMTP_USER, pass: process.env.DASHBOARD_SMTP_PASS }
            : undefined,
    });
    await transport.sendMail({
        from: process.env.DASHBOARD_SMTP_USER || to,
        to,
        subject: `Prep Guide - Store ${storeNumber} - ${weekday}`,
        text: `Attached: Prep Guide for store ${storeNumber} (${weekday}).`,
        attachments: [{ filename: `${storeNumber}-${weekday}.pdf`, path: file }],
    });
    return { ok: true, to, storeNumber, weekday };
}

async function runFiveAmEmailPass() {
    const now = melbourneNowParts();
    const state = readState();
    if (state.lastEmailDateKey === now.dateKey) {
        return { ok: true, skipped: true, reason: 'already sent today' };
    }
    const stores = listStoresForCoach();
    const results = [];
    for (const s of stores) {
        const email = storeEmails.getEmail(s.storeNumber);
        if (!email) continue;
        try {
            const existing = pdfPath(s.storeNumber, now.weekday);
            if (!existing) await regenerateStore(s.storeNumber);
            results.push(await sendPrepGuideEmail(s.storeNumber, now.weekday));
        } catch (err) {
            results.push({ ok: false, storeNumber: s.storeNumber, error: err.message });
        }
    }
    writeState({ ...state, lastEmailDateKey: now.dateKey, lastEmailAt: new Date().toISOString(), results });
    return { ok: true, dateKey: now.dateKey, weekday: now.weekday, results };
}

let schedulerTimer = null;

function startFiveAmScheduler() {
    if (schedulerTimer) return;
    schedulerTimer = setInterval(async () => {
        const now = melbourneNowParts();
        if (now.hour === 5 && now.minute < 5) {
            try {
                await runFiveAmEmailPass();
            } catch (err) {
                console.error('[prep-guides] 5am email pass failed:', err.message);
            }
        }
    }, 60 * 1000);
    console.log('[prep-guides] 5am Melbourne email scheduler started');
}

module.exports = {
    WEEKDAYS,
    ensureTemplate,
    regenerateStore,
    listStoreStatus,
    pdfPath,
    sendPrepGuideEmail,
    runFiveAmEmailPass,
    startFiveAmScheduler,
    OUT_ROOT,
};
