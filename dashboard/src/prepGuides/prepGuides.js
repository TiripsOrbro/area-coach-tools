/**
 * Prep Guides: fill Prep Guide.xlsx inputs, fetch missing history/ISE,
 * render landscape PDFs matching the printable Prep Guide layout.
 */
const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');
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

function workbookFilename(storeNumber) {
    const n = String(storeNumber || '').replace(/\D/g, '');
    return `${n} - Prep Guide.xlsx`;
}

function workbookPath(storeNumber) {
    const n = String(storeNumber || '').replace(/\D/g, '');
    return path.join(OUT_ROOT, n, workbookFilename(n));
}

function legacyWorkbookPath(storeNumber) {
    const n = String(storeNumber || '').replace(/\D/g, '');
    return path.join(OUT_ROOT, n, 'Prep-Guide.xlsx');
}

/** Prefer `3902 - Prep Guide.xlsx`; migrate legacy Prep-Guide.xlsx if needed. */
function resolveWorkbookPath(storeNumber, { migrate = false } = {}) {
    const preferred = workbookPath(storeNumber);
    if (fs.existsSync(preferred)) return preferred;
    const legacy = legacyWorkbookPath(storeNumber);
    if (fs.existsSync(legacy)) {
        if (migrate) {
            try {
                fs.renameSync(legacy, preferred);
                return preferred;
            } catch {
                try {
                    fs.copyFileSync(legacy, preferred);
                    fs.unlinkSync(legacy);
                    return preferred;
                } catch {
                    return legacy;
                }
            }
        }
        return legacy;
    }
    return preferred;
}

/** Open `{store} - Prep Guide.xlsx` in Excel for raw-data review. */
function openWorkbook(storeNumber) {
    return new Promise((resolve) => {
        const store = String(storeNumber || '').replace(/\D/g, '');
        if (!store) {
            resolve({ ok: false, error: 'storeNumber required.' });
            return;
        }
        const file = resolveWorkbookPath(store, { migrate: true });
        if (!fs.existsSync(file)) {
            resolve({
                ok: false,
                path: workbookPath(store),
                storeNumber: store,
                error: `Prep Guide workbook not found for ${store}. Run Forecast or Build PDFs first.`,
            });
            return;
        }
        const cmd = process.platform === 'win32' ? `start "" "${file}"` : `open "${file}"`;
        exec(cmd, (err) => {
            resolve({
                ok: !err,
                path: file,
                storeNumber: store,
                error: err?.message || null,
            });
        });
    });
}

/** Template Chirnside weekday $ (Weekly Forecast C2:I2) — used to scale cook/prep. */
function readTemplateWeekdayTotals() {
    try {
        const xlsx = require('xlsx');
        if (!fs.existsSync(TEMPLATE)) return {};
        const wb = xlsx.readFile(TEMPLATE, { cellDates: true });
        const wf = wb.Sheets['Weekly Forecast'];
        if (!wf) return {};
        const aoa = xlsx.utils.sheet_to_json(wf, { header: 1, defval: '', raw: true });
        const headers = aoa[0] || [];
        const values = aoa[1] || [];
        const out = {};
        for (let c = 0; c < headers.length; c++) {
            const day = String(headers[c] || '').trim();
            if (WEEKDAYS.includes(day)) out[day] = Math.round(Number(values[c]) || 0);
        }
        return out;
    } catch {
        return {};
    }
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

/** Match Excel ROUNDUP(n, 0) for non-negative prep/cook quantities. */
function roundUpQty(qty) {
    const v = Number(qty);
    if (!Number.isFinite(v) || v <= 0) return 0;
    return Math.ceil(v - 1e-12);
}

function unitWord(units, qty) {
    const u = String(units || '').trim();
    const n = roundUpQty(qty);
    const raw = u.toLowerCase();
    // Map both singular + plural spellings (do not strip trailing "s" — Boxes → boxe).
    const plurals = {
        pan: ['PAN', 'PANS'],
        pans: ['PAN', 'PANS'],
        tray: ['TRAY', 'TRAYS'],
        trays: ['TRAY', 'TRAYS'],
        tub: ['TUB', 'TUBS'],
        tubs: ['TUB', 'TUBS'],
        cup: ['CUP', 'CUPS'],
        cups: ['CUP', 'CUPS'],
        bottle: ['BOTTLE', 'BOTTLES'],
        bottles: ['BOTTLE', 'BOTTLES'],
        box: ['BOX', 'BOXES'],
        boxes: ['BOX', 'BOXES'],
        bag: ['BAG', 'BAGS'],
        bags: ['BAG', 'BAGS'],
    };
    const pair = plurals[raw];
    if (pair) return `${n} ${n === 1 ? pair[0] : pair[1]}`;
    const upper = u.toUpperCase();
    if (!upper) return `${n} UNITS`;
    return `${n} ${upper}`;
}


function spawnAsync(command, args, options = {}) {
    return new Promise((resolve) => {
        const child = spawn(command, args, {
            windowsHide: true,
            ...options,
        });
        let stdout = '';
        let stderr = '';
        const timer =
            Number(options.timeout) > 0
                ? setTimeout(() => {
                      try {
                          child.kill();
                      } catch {
                          /* ignore */
                      }
                      resolve({
                          status: 1,
                          stdout,
                          stderr: `${stderr}\nTimed out after ${options.timeout}ms`.trim(),
                      });
                  }, Number(options.timeout))
                : null;
        child.stdout?.on('data', (chunk) => {
            stdout += chunk.toString();
        });
        child.stderr?.on('data', (chunk) => {
            stderr += chunk.toString();
        });
        child.on('error', (err) => {
            if (timer) clearTimeout(timer);
            resolve({ status: 1, stdout, stderr: err.message || String(err) });
        });
        child.on('close', (code) => {
            if (timer) clearTimeout(timer);
            resolve({ status: code == null ? 1 : code, stdout, stderr });
        });
    });
}

async function ensureHistoryData(storeNumber, options = {}) {
    const force = Boolean(options.force);
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
    const days = listDayKeys(storeNumber).length;
    if (!force && days >= 21) return { ok: true, skipped: true, days };
    try {
        onProgress?.(`MMX sales backfill for store ${storeNumber}...`);
        const { backfillHistoryFromMmx, BACKFILL_DAYS: daysBack } = require('../../../forecast/src/forecastRunner');
        const result = await backfillHistoryFromMmx(storeNumber, daysBack || BACKFILL_DAYS || 35, {
            onLog: (line) => onProgress?.(line),
        });
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

const ISE_DATE_RANGE = { mode: 'ise-weeks', weeks: 5, endOffsetDays: 1 };

function iseSnapshotCount(storeNumber) {
    try {
        const { listWeeklySnapshots } = require('../reportSubscriptions/iseHistoryLedger');
        return listWeeklySnapshots(storeNumber, ISE_DATE_RANGE, 5).filter(Boolean).length;
    } catch {
        return 0;
    }
}

/**
 * Up to 5 weekly ISE snapshots for the Prep Guide grid.
 * Oldest → newest (left → right). Missing weeks stay null — never duplicate one week across columns.
 */
function loadIseWeekSnaps(storeNumber) {
    const { listWeeklySnapshots, readStoreIseHistory } = require('../reportSubscriptions/iseHistoryLedger');
    // listWeeklySnapshots returns newest-first (anchor order); reverse for sheet columns.
    let snaps = (listWeeklySnapshots(storeNumber, ISE_DATE_RANGE, 5) || []).slice();
    while (snaps.length < 5) snaps.push(null);
    snaps = snaps.slice(0, 5).reverse();

    if (!snaps.some(Boolean)) {
        const doc = readStoreIseHistory(storeNumber);
        const recent = (doc.snapshots || []).slice(-5);
        snaps = Array.from({ length: 5 }, (_, i) => recent[i] || null);
    }
    return snaps;
}

/**
 * Ensure 5 weekly ISE snapshots exist.
 * Default: download only missing weeks. force:true re-downloads all 5.
 */
async function ensureIseData(storeNumber, options = {}) {
    const force = Boolean(options.force);
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;

    try {
        const { assessIseCoverage } = require('../reportSubscriptions/iseHistoryLedger');
        const { ensureIseHistory } = require('../reportSubscriptions/reportRunner');
        const before = assessIseCoverage(storeNumber, ISE_DATE_RANGE);
        if (!force && before.ready) {
            return {
                ok: true,
                skipped: true,
                snapshots: before.snapshotCount,
                coverage: before,
            };
        }

        const missing = Array.isArray(before.missingSnapshotDates)
            ? before.missingSnapshotDates.length
            : Math.max(0, 5 - (before.snapshotCount || 0));
        onProgress?.(
            force
                ? `Re-downloading all 5 ISE weeks for ${storeLabel(storeNumber)}…`
                : `Downloading ${missing} missing ISE week(s) for ${storeLabel(storeNumber)}…`
        );

        const coverage = await ensureIseHistory(storeNumber, {
            dateRange: ISE_DATE_RANGE,
            force,
            onProgress: onProgress
                ? (evt) => {
                      const msg = evt?.message || (typeof evt === 'string' ? evt : '');
                      if (msg) onProgress(msg);
                  }
                : null,
        });
        const snapshots = Number(coverage.snapshotCount || iseSnapshotCount(storeNumber)) || 0;
        return {
            ok: Boolean(coverage.ready || snapshots > 0),
            snapshots,
            coverage,
            skipped: false,
            error: coverage.ready ? null : `ISE coverage ${snapshots}/5 weeks`,
        };
    } catch (err) {
        return {
            ok: false,
            error: err.message || String(err),
            snapshots: iseSnapshotCount(storeNumber),
        };
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

function storeWeekdayForecastTotals(storeNumber) {
    const { buildPlan } = require('../../../forecast/src/planEngine');
    const dates = WEEKDAYS.map((name) => nextDateForWeekday(name));
    const plan = buildPlan({ storeNumber, targetDates: dates, historyDays: 35 });
    const totals = Object.fromEntries(WEEKDAYS.map((name) => [name, 0]));
    for (const day of plan.days || []) {
        const label = weekdayForIso(day.dateKey);
        if (WEEKDAYS.includes(label)) {
            totals[label] = Math.round(Number(day.total) || 0);
        }
    }
    for (const name of WEEKDAYS) {
        if (!totals[name]) {
            totals[name] = forecastSalesForDate(storeNumber, nextDateForWeekday(name), name);
        }
    }
    const weekTotal = WEEKDAYS.reduce((sum, name) => sum + (Number(totals[name]) || 0), 0);
    return { totals, weekTotal };
}

/** Fill Sales! with 5 recent same-weekday hours (history is 5am-indexed × 21). */
function fillSalesSheet(sheet, storeNumber) {
    if (!sheet) return;
    const label = storeLabel(storeNumber);
    sheet.getCell('A1').value = label;

    // Col layout: each weekday = 5 week cols + 1 average (ExcelJS 1-based).
    // Monday starts at col 2, block width 6 → Tue=8, Wed=14, ...
    for (let d = 0; d < WEEKDAYS.length; d++) {
        const dayName = WEEKDAYS[d];
        const baseCol = 2 + d * 6;
        const series = fiveWeekHourlyForWeekday(storeNumber, dayName);
        for (let w = 0; w < 5; w++) {
            const col = baseCol + w;
            const day = series[series.length - 1 - w];
            const actual = Array.isArray(day?.actual) ? day.actual : [];
            if (day?.dateKey) {
                const [y, m, dd] = String(day.dateKey).split('-').map(Number);
                sheet.getCell(6, col).value = y && m && dd ? new Date(Date.UTC(y, m - 1, dd)) : day.dateKey;
            } else {
                sheet.getCell(6, col).value = null;
            }
            // History index 0 = 5am → Sales rows 7–30 = 00:00–23:00
            for (let hour = 0; hour < 24; hour++) {
                const row = 7 + hour;
                let v = 0;
                if (hour >= 5 && hour < 5 + actual.length) {
                    v = Number(actual[hour - 5]) || 0;
                }
                sheet.getCell(row, col).value = Math.round(v * 100) / 100;
            }
        }
    }
}

/** Map ISE Day1…Day7 (or date labels) onto Monday…Sunday index. */
function iseDayIndex(snapshot, weekdayName) {
    const labels = snapshot?.dayLabels || [];
    for (let i = 0; i < labels.length; i++) {
        const raw = String(labels[i] || '').trim();
        if (!raw || /^day\s*\d+$/i.test(raw)) continue;
        // Excel serial / ISO / AU date strings
        let key = raw;
        const m = raw.match(/(\d{4})-(\d{2})-(\d{2})/);
        if (m) key = `${m[1]}-${m[2]}-${m[3]}`;
        else {
            const d = new Date(raw);
            if (!Number.isNaN(d.getTime())) {
                key = d.toISOString().slice(0, 10);
            }
        }
        try {
            if (/^\d{4}-\d{2}-\d{2}$/.test(key) && weekdayForIso(key) === weekdayName) return i;
        } catch {
            /* ignore */
        }
    }
    const idx = WEEKDAYS.indexOf(weekdayName);
    return idx >= 0 ? idx : 0;
}

/**
 * Fill ISE Average from up to 5 weekly snapshots.
 * Layout: each weekday = 5 week cols + average, blocks start at cols 3,10,17,24,31,38,45.
 */
function fillIseAverageSheet(sheet, storeNumber) {
    if (!sheet) return;
    const label = storeLabel(storeNumber);
    sheet.getCell('A1').value = label;

    const snaps = loadIseWeekSnaps(storeNumber);

    const itemByCode = new Map();
    for (const snap of snaps) {
        if (!snap?.items) continue;
        for (const [code, row] of Object.entries(snap.items)) {
            const key = String(code || row.itemCode || '').trim();
            if (!key) continue;
            if (!itemByCode.has(key)) {
                itemByCode.set(key, {
                    itemCode: key,
                    description: row.description || '',
                });
            }
        }
    }

    // Clear existing data rows (keep header rows 1–4), then rewrite from store ISE.
    const lastRow = Math.max(sheet.rowCount || 0, 5);
    for (let r = 5; r <= lastRow; r++) {
        for (let c = 1; c <= 50; c++) {
            sheet.getCell(r, c).value = null;
        }
    }

    // Row 2 dates + row 3 weekday labels for each block
    for (let d = 0; d < WEEKDAYS.length; d++) {
        const baseCol = 3 + d * 7;
        const dayName = WEEKDAYS[d];
        for (let w = 0; w < 5; w++) {
            sheet.getCell(3, baseCol + w).value = dayName;
            const snap = snaps[w];
            if (!snap?.date) {
                sheet.getCell(2, baseCol + w).value = null;
                continue;
            }
            // Date of that weekday in the snapshot week ending snap.date
            const end = String(snap.date);
            let dateKey = end;
            for (let back = 0; back < 7; back++) {
                const k = addDaysIso(end, -back);
                if (weekdayForIso(k) === dayName) {
                    dateKey = k;
                    break;
                }
            }
            const [y, m, dd] = dateKey.split('-').map(Number);
            sheet.getCell(2, baseCol + w).value = new Date(Date.UTC(y, m - 1, dd));
        }
        sheet.getCell(3, baseCol + 5).value = `Average of ${dayName}s`;
    }

    sheet.getCell(4, 1).value = 'Item';
    sheet.getCell(4, 2).value = 'Description';

    let row = 5;
    for (const [code, meta] of itemByCode) {
        sheet.getCell(row, 1).value = /^\d+$/.test(code) ? Number(code) : code;
        sheet.getCell(row, 2).value = meta.description || '';
        for (let d = 0; d < WEEKDAYS.length; d++) {
            const baseCol = 3 + d * 7;
            const dayName = WEEKDAYS[d];
            const weekVals = [];
            for (let w = 0; w < 5; w++) {
                const snap = snaps[w];
                let v = null;
                if (snap?.items?.[code]) {
                    const di = iseDayIndex(snap, dayName);
                    const raw = snap.items[code].dayValues?.[di];
                    v = Number(raw);
                    if (!Number.isFinite(v)) v = null;
                }
                sheet.getCell(row, baseCol + w).value = v;
                if (v != null) weekVals.push(v);
            }
            const avgCol = baseCol + 5;
            sheet.getCell(row, avgCol).value = weekVals.length
                ? Math.round((weekVals.reduce((s, n) => s + n, 0) / weekVals.length) * 10000) / 10000
                : 0;
        }
        row += 1;
    }
}

/** Brand Monday–Sunday Calcs tabs (printable day sheets pull H3 from here). */
function brandDayCalcSheets(wb, storeNumber) {
    const label = storeLabel(storeNumber);
    for (const day of WEEKDAYS) {
        const sheet = wb.getWorksheet(`${day} Calcs`);
        if (!sheet) continue;
        sheet.getCell('H3').value = label;
    }
}

function numericCellValue(cell) {
    const v = cell?.value;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (v && typeof v === 'object') {
        if (typeof v.result === 'number' && Number.isFinite(v.result)) return v.result;
    }
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

/** Scale Chirnside cook/prep caches by storeForecast/templateForecast per weekday. */
function scaleCookPrepSheets(wb, storeTotals, templateTotals) {
    const pbs = wb.getWorksheet('Product Block Sales');
    const prep = wb.getWorksheet('Prep Simplified');
    const scales = WEEKDAYS.map((day) => {
        const t = Number(templateTotals[day]) || 0;
        const s = Number(storeTotals[day]) || 0;
        return t > 0 && s > 0 ? s / t : 1;
    });

    if (pbs) {
        pbs.eachRow((row, rowNumber) => {
            if (rowNumber === 1) return;
            for (let i = 0; i < 7; i++) {
                const cell = row.getCell(3 + i);
                const n = numericCellValue(cell);
                if (n != null) cell.value = n * scales[i];
            }
        });
    }

    if (prep) {
        prep.eachRow((row, rowNumber) => {
            if (rowNumber <= 2) return;
            // Base Mon–Sun cols 3–9; today+tomorrow Mon–Sun cols 12–18
            for (let i = 0; i < 7; i++) {
                for (const col of [3 + i, 12 + i]) {
                    const cell = row.getCell(col);
                    const n = numericCellValue(cell);
                    if (n != null) cell.value = n * scales[i];
                }
            }
        });
    }
}

/** ExcelJS often corrupts worksheet Tables / AutoFilters / ISE sheets on round-trip. */
function stripWorksheetTables(wb) {
    for (const sheet of wb.worksheets || []) {
        try {
            if (typeof sheet.getTables === 'function') {
                for (const table of [...sheet.getTables()]) {
                    try {
                        sheet.removeTable(table.name);
                    } catch {
                        /* ignore */
                    }
                }
            }
        } catch {
            /* ignore */
        }
        try {
            if (sheet.autoFilter) sheet.autoFilter = undefined;
        } catch {
            /* ignore */
        }
    }
}

/**
 * Drop ISE sheets ExcelJS corrupts (sheet2.xml repair). PDF/build use PBS + Prep Simplified only.
 * Replace with a short note sheet so the workbook still opens cleanly.
 */
function replaceFragileIseSheets(wb) {
    for (const name of ['ISE', 'ISE Average']) {
        const existing = wb.getWorksheet(name);
        if (existing) {
            try {
                wb.removeWorksheet(existing.id);
            } catch {
                /* ignore */
            }
        }
    }
    let note = wb.getWorksheet('ISE Note');
    if (!note) note = wb.addWorksheet('ISE Note', { state: 'visible' });
    note.getCell('A1').value =
        'ISE / ISE Average tabs are omitted from this store file (Excel repair issues).';
    note.getCell('A2').value =
        'Prep Guide quantities come from Product Block Sales + Prep Simplified (scaled to this store).';
}

/**
 * Full visual clone of Prep Guide (styles, merges, column widths).
 * Formulas become cached results so day tabs stay fixed for that weekday.
 */
function clonePrepGuideSheet(wb, newName) {
    const source = wb.getWorksheet('Prep Guide');
    if (!source) throw new Error('Prep Guide sheet missing');

    const existing = wb.getWorksheet(newName);
    if (existing) {
        try {
            wb.removeWorksheet(existing.id);
        } catch {
            /* ignore */
        }
    }

    const to = wb.addWorksheet(newName, {
        properties: { ...(source.properties || {}) },
        views: JSON.parse(JSON.stringify(source.views || [])),
        pageSetup: JSON.parse(JSON.stringify(source.pageSetup || {})),
    });

    source.columns.forEach((col, idx) => {
        if (!col) return;
        const c = to.getColumn(idx + 1);
        if (col.width != null) c.width = col.width;
        if (col.hidden != null) c.hidden = col.hidden;
    });

    source.eachRow({ includeEmpty: true }, (row, rowNumber) => {
        const newRow = to.getRow(rowNumber);
        if (row.height != null) newRow.height = row.height;
        if (row.hidden) newRow.hidden = true;
        row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
            const nc = newRow.getCell(colNumber);
            const v = cell.value;
            if (v && typeof v === 'object' && v.formula != null) {
                nc.value = v.result != null && v.result !== '' ? v.result : null;
            } else {
                nc.value = v;
            }
            try {
                nc.style = JSON.parse(JSON.stringify(cell.style || {}));
            } catch {
                /* ignore style clone failures */
            }
        });
    });

    for (const range of source.model?.merges || []) {
        try {
            to.mergeCells(range);
        } catch {
            /* ignore */
        }
    }
    return to;
}

/**
 * Overwrite day-specific values on Prep Guide only (keeps template merges/styles).
 * Writes the top-left cell of each merged pair — same cells the original template uses.
 */
function stampPrintableDay(wbOrSheet, guide) {
    const sheets = [];
    if (wbOrSheet && typeof wbOrSheet.getWorksheet === 'function') {
        const sheet = wbOrSheet.getWorksheet('Prep Guide');
        if (sheet) sheets.push(sheet);
    } else if (wbOrSheet) {
        sheets.push(wbOrSheet);
    }

    const cookBlocks = guide.cookBlocks || ['8:45', '10:30', '14:00', '15:30', '19:00'];
    const cookCols = [4, 6, 8, 10, 12]; // D F H J L — left of each D:E / F:G / … merge

    for (const sheet of sheets) {
        sheet.getCell('B2').value = 'Prep Guide';
        sheet.getCell('B3').value = 'Forecasted Sales Below:';
        sheet.getCell('H3').value = guide.storeLabel;
        sheet.getCell('B4').value = Math.round(Number(guide.forecastSales) || 0);
        sheet.getCell('H4').value = guide.weekday;
        sheet.getCell('K4').value = formatDdMmYyyy(guide.dateKey);
        sheet.getCell('B6').value = 'Manager Initial:';

        const cookRows = {
            BEEF: 9,
            CHICKEN: 10,
            BEANS: 11,
            'NACHO CHEESE': 12,
            RICE: 13,
        };
        for (const [name, row] of Object.entries(cookRows)) {
            sheet.getCell(row, 2).value = name;
            const values = guide.cook[name] || [];
            cookBlocks.forEach((_, i) => {
                sheet.getCell(row, cookCols[i]).value = values[i] != null ? values[i] : '';
            });
        }

        sheet.getCell('B15').value = 'SALAD PREP';
        sheet.getCell('F15').value = 'FRY PREP';
        sheet.getCell('J15').value = 'THAWING';

        const stampPrepCol = (items, labelCol, qtyCol, startRow, maxRows = 9) => {
            for (let i = 0; i < maxRows; i++) {
                const row = startRow + i;
                const item = items[i];
                if (!item || item.empty || (!item.label && !item.value)) {
                    sheet.getCell(row, labelCol).value = null;
                    sheet.getCell(row, qtyCol).value = null;
                    continue;
                }
                sheet.getCell(row, labelCol).value = item.label;
                sheet.getCell(row, qtyCol).value = item.value;
            }
        };
        stampPrepCol(guide.salad || [], 2, 4, 16);
        stampPrepCol(guide.fry || [], 6, 8, 16);
        stampPrepCol(guide.thaw || [], 10, 12, 16);
    }
}

function mmxScriptsDir() {
    try {
        const { automationRoot } = require('../../../src/buildToExcel');
        return path.join(automationRoot(), 'scripts');
    } catch {
        return path.join(
            process.env.MMX_REPORT_AUTOMATION_DIR ||
                path.join(__dirname, '..', '..', '..', 'mmx-report-automation'),
            'scripts'
        );
    }
}

/** Excel date serial (1900 date system) for an ISO yyyy-MM-dd. */
function isoToExcelSerial(dateKey) {
    const [y, m, d] = String(dateKey || '').split('-').map(Number);
    if (!y || !m || !d) return null;
    const utc = Date.UTC(y, m - 1, d);
    return Math.floor(utc / 86400000) + 25569;
}

/** JSON payload for fill-prep-guide.ps1 (Sales + ISE + Forecast + store name). */
function buildPrepGuideFillPayload(storeNumber) {
    const store = String(storeNumber || '').replace(/\D/g, '');
    const { totals, weekTotal } = storeWeekdayForecastTotals(store);
    const forecast = {};
    for (const day of WEEKDAYS) forecast[day] = totals[day] || 0;

    const sales = {};
    for (let d = 0; d < WEEKDAYS.length; d++) {
        const dayName = WEEKDAYS[d];
        const baseCol = 2 + d * 6;
        const series = fiveWeekHourlyForWeekday(store, dayName);
        const weeks = [];
        for (let w = 0; w < 5; w++) {
            const day = series[series.length - 1 - w];
            const actual = Array.isArray(day?.actual) ? day.actual : [];
            const hours = [];
            for (let hour = 0; hour < 24; hour++) {
                let v = 0;
                if (hour >= 5 && hour < 5 + actual.length) {
                    v = Math.round((Number(actual[hour - 5]) || 0) * 100) / 100;
                }
                hours.push(v);
            }
            weeks.push({
                dateKey: day?.dateKey || null,
                excelSerial: day?.dateKey ? isoToExcelSerial(day.dateKey) : null,
                hours,
            });
        }
        sales[dayName] = { baseCol, weeks };
    }

    const snaps = loadIseWeekSnaps(store);

    const itemByCode = new Map();
    for (const snap of snaps) {
        if (!snap?.items) continue;
        for (const [code, row] of Object.entries(snap.items)) {
            const key = String(code || row.itemCode || '').trim();
            if (!key) continue;
            if (!itemByCode.has(key)) {
                itemByCode.set(key, { itemCode: key, description: row.description || '' });
            }
        }
    }

    const iseItems = [];
    for (const [code, meta] of itemByCode) {
        const days = {};
        for (const dayName of WEEKDAYS) {
            const values = [];
            const excelSerials = [];
            for (let w = 0; w < 5; w++) {
                const snap = snaps[w];
                let v = null;
                if (snap?.items?.[code]) {
                    const di = iseDayIndex(snap, dayName);
                    const raw = Number(snap.items[code].dayValues?.[di]);
                    v = Number.isFinite(raw) ? raw : null;
                }
                values.push(v);
                if (snap?.date) {
                    let dateKey = String(snap.date);
                    for (let back = 0; back < 7; back++) {
                        const k = addDaysIso(String(snap.date), -back);
                        if (weekdayForIso(k) === dayName) {
                            dateKey = k;
                            break;
                        }
                    }
                    excelSerials.push(isoToExcelSerial(dateKey));
                } else {
                    excelSerials.push(null);
                }
            }
            const present = values.filter((x) => x != null);
            const avg = present.length
                ? Math.round((present.reduce((s, n) => s + n, 0) / present.length) * 10000) / 10000
                : 0;
            days[dayName] = { values, avg, excelSerials };
        }
        iseItems.push({
            code,
            description: meta.description || '',
            days,
        });
    }

    return {
        storeLabel: storeLabel(store),
        weekTotal,
        forecast,
        sales,
        iseItems,
    };
}

/**
 * Build store Prep Guide without ExcelJS round-trip (avoids repair dialogs).
 * Binary-copies the app template, then fills Sales / ISE / Forecast / names via Excel COM.
 */
async function writeStoreWorkbook(storeNumber) {
    ensureTemplate();
    const store = String(storeNumber || '').replace(/\D/g, '');
    const outPath = workbookPath(store);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.copyFileSync(TEMPLATE, outPath);

    const legacy = legacyWorkbookPath(store);
    if (fs.existsSync(legacy) && path.resolve(legacy) !== path.resolve(outPath)) {
        try {
            fs.unlinkSync(legacy);
        } catch {
            /* ignore locked legacy */
        }
    }

    const ps1 = path.join(mmxScriptsDir(), 'fill-prep-guide.ps1');
    if (process.platform !== 'win32' || !fs.existsSync(ps1)) {
        throw new Error(
            'Excel COM fill script missing — Prep Guide updates require Windows Excel (fill-prep-guide.ps1).'
        );
    }

    const payload = buildPrepGuideFillPayload(store);
    const payloadPath = path.join(
        process.env.TEMP || process.env.TMP || osTmp(),
        `act-prep-fill-${store}-${Date.now()}.json`
    );
    fs.writeFileSync(payloadPath, `${JSON.stringify(payload)}\n`, 'utf8');

    try {
        const result = await spawnAsync(
            'powershell',
            [
                '-NoProfile',
                '-ExecutionPolicy',
                'Bypass',
                '-File',
                ps1,
                '-Path',
                outPath,
                '-PayloadPath',
                payloadPath,
            ],
            { timeout: 600000 }
        );
        const detail = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
        if (result.status !== 0) {
            throw new Error(detail.slice(-800) || `fill-prep-guide exited ${result.status}`);
        }
        if (/Unable to get the Open property|Exception/i.test(detail) && !/Filled Prep Guide/i.test(detail)) {
            throw new Error(detail.slice(-800));
        }
    } finally {
        try {
            fs.unlinkSync(payloadPath);
        } catch {
            /* ignore */
        }
    }

    return outPath;
}

function osTmp() {
    return require('os').tmpdir();
}

/**
 * Day tabs already exist in the template — do not ExcelJS-rewrite them (causes repair dialogs).
 * Kept as a no-op compatibility export for callers that only need guide summaries.
 */
async function stampWorkbookToMatchPdf(workbookPath, storeNumber, weekdayName) {
    const todayName = weekdayName || weekdayForIso(melbourneToday());
    const guides = {};
    for (const day of WEEKDAYS) {
        guides[day] = buildDayGuide(workbookPath, storeNumber, day);
    }
    const todayGuide = guides[todayName] || buildDayGuide(workbookPath, storeNumber, todayName);
    return { ...todayGuide, allDays: guides };
}

async function recalcWorkbook(workbookPath) {
    try {
        const ps1 = path.join(mmxScriptsDir(), 'recalc-workbook.ps1');
        if (process.platform === 'win32' && fs.existsSync(ps1)) {
            const result = await spawnAsync(
                'powershell',
                ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1, '-Path', workbookPath],
                { timeout: 180000 }
            );
            const detail = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
            const comFailed = /Unable to get the Open property|Exception/i.test(detail);
            return {
                ok: result.status === 0 && !comFailed,
                engine: 'excel-com',
                detail: detail.slice(-500),
            };
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

function daySalesTotal(actual) {
    return (Array.isArray(actual) ? actual : []).reduce((s, v) => s + (Number(v) || 0), 0);
}

function averageSameWeekdaySales(storeNumber, weekdayName) {
    const peers = recentDays(storeNumber, 70)
        .filter((d) => !d.ignored && weekdayForIso(d.dateKey) === weekdayName)
        .map((d) => daySalesTotal(d.actual))
        .filter((n) => n > 0);
    if (!peers.length) return 0;
    if (peers.length < 3) {
        return Math.round(peers.reduce((s, n) => s + n, 0) / peers.length);
    }
    const sorted = [...peers].sort((a, b) => a - b);
    const trimmed = sorted.slice(1, -1);
    return Math.round(trimmed.reduce((s, n) => s + n, 0) / trimmed.length);
}

function forecastSalesForDate(storeNumber, dateKey, weekdayName) {
    try {
        const { buildPlan } = require('../../../forecast/src/planEngine');
        const plan = buildPlan({
            storeNumber: String(storeNumber),
            targetDates: [String(dateKey)],
            historyDays: 35,
        });
        const day = (plan.days || [])[0];
        const fromPlan = Math.round(Number(day?.total) || 0);
        if (fromPlan > 0) return fromPlan;
    } catch {
        /* fall through */
    }
    return averageSameWeekdaySales(storeNumber, weekdayName || weekdayForIso(dateKey));
}

function parseMoneyCell(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    const n = Number(String(value ?? '').replace(/[^0-9.-]/g, ''));
    return Number.isFinite(n) ? n : 0;
}

function buildDayGuide(workbookPath, storeNumber, weekdayName) {
    const col = WEEKDAY_COL[weekdayName];
    const pbs = readAoA(workbookPath, 'Product Block Sales');
    const prep = readAoA(workbookPath, 'Prep Simplified');
    const weekly = readAoA(workbookPath, 'Weekly Forecast');
    const dateKey = nextDateForWeekday(weekdayName);

    // Prefer Weekly Forecast sheet (header row finds Mon…Sun columns).
    let forecastSales = 0;
    if (weekly[0] && weekly[1]) {
        const headers = weekly[0].map((h) => String(h || '').trim());
        const values = weekly[1];
        let idx = headers.indexOf(weekdayName);
        if (idx < 0) idx = WEEKDAYS.indexOf(weekdayName) + 3; // D=3 fallback when headers blank
        if (idx >= 0) forecastSales = Math.round(parseMoneyCell(values[idx]));
    }
    if (forecastSales <= 0) {
        forecastSales = forecastSalesForDate(storeNumber, dateKey, weekdayName);
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
                // Match Excel ROUNDUP(... ,0) used on day Calcs sheets
                const pans = roundUpQty(val);
                cook[label].push(pans <= 1 ? '1 PAN' : `${pans} PANS`);
            } else {
                cook[label].push(roundUpQty(val));
            }
        }
    }

    function prepItems(order, preferUnitsIncludes) {
        return order.map(([raw, label]) => {
            const candidates = prep.filter(
                (r) => String(r[1] || '').trim().toUpperCase() === raw.toUpperCase()
            );
            let row = candidates[0];
            // CHIP NACHO CORN appears as Fry/Tubs and Thaw/Boxes — pick the right units.
            if (preferUnitsIncludes && candidates.length > 1) {
                const hit = candidates.find((r) =>
                    String(r[9] || '')
                        .toLowerCase()
                        .includes(String(preferUnitsIncludes).toLowerCase())
                );
                if (hit) row = hit;
            }
            const units = row ? String(row[9] || '').trim() : '';
            // Prefer "today+tomorrow" qty columns (11-17) when present, else base (2-8)
            const qty = row
                ? Number(row[col + 9] != null && row[col + 9] !== '' ? row[col + 9] : row[col]) || 0
                : 0;
            return { label, value: unitWord(units, qty), empty: false };
        });
    }

    // Salad order in photo: Fiesta, Guac first then sauces
    const salad = prepItems(SALAD_ORDER);
    const fry = prepItems(FRY_ORDER, 'tub');
    const thaw = prepItems(THAW_ORDER, 'box');

    return {
        storeNumber: String(storeNumber),
        storeLabel: storeLabel(storeNumber),
        weekday: weekdayName,
        dateKey,
        forecastSales,
        cookBlocks,
        cook,
        salad,
        fry,
        thaw,
    };
}

function padPrepRows(rows, target) {
    const out = (rows || []).map((r) => ({ ...r, empty: false }));
    while (out.length < target) {
        out.push({ label: '', value: '', empty: true });
    }
    return out;
}

function dayHtml(guide) {
    const cookBlocks = guide.cookBlocks || ['8:45', '10:30', '14:00', '15:30', '19:00'];
    const cookRows = ['BEEF', 'CHICKEN', 'BEANS', 'NACHO CHEESE', 'RICE']
        .map((name) => {
            const values = guide.cook[name] || [];
            const cells = cookBlocks
                .map((_, i) => `<td class="num">${values[i] != null ? values[i] : ''}</td>`)
                .join('');
            return `<tr><th>${name}</th>${cells}</tr>`;
        })
        .join('');
    // One blank initial cell under each cook-cycle column
    const initialCells = cookBlocks
        .map(() => '<td class="initial-box"></td>')
        .join('');

    // Keep all three prep columns the same height with grey filler rows.
    const prepRowTarget = Math.max(9, SALAD_ORDER.length, FRY_ORDER.length, THAW_ORDER.length);
    const salad = padPrepRows(guide.salad, prepRowTarget);
    const fry = padPrepRows(guide.fry, prepRowTarget);
    const thaw = padPrepRows(guide.thaw, prepRowTarget);

    const prepRowsHtml = Array.from({ length: prepRowTarget }, (_, i) => {
        const cells = [salad[i], fry[i], thaw[i]]
            .map((r) => {
                if (!r || r.empty || (!r.label && !r.value)) {
                    return `<td class="prep-item empty">&nbsp;</td><td class="prep-qty empty">&nbsp;</td>`;
                }
                return `<td class="prep-item">${r.label}</td><td class="prep-qty">${r.value}</td>`;
            })
            .join('');
        return `<tr>${cells}</tr>`;
    }).join('');

    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  @page { size: A4 landscape; margin: 7mm; }
  * { box-sizing: border-box; }
  body {
    margin: 0; font-family: Arial, Helvetica, sans-serif; color: #111;
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
  .page { width: 1120px; margin: 0 auto; }
  .banner {
    background: ${PURPLE}; color: #fff; text-align: center;
    font-size: 28px; font-weight: 700; padding: 10px 12px;
    border: 1px solid #111; border-bottom: 0;
  }
  table.meta, table.cook, table.prep {
    width: 100%;
    border-collapse: collapse;
    table-layout: fixed;
  }
  table.meta th, table.meta td,
  table.cook th, table.cook td,
  table.prep th, table.prep td {
    border: 1px solid #111;
    padding: 7px 6px;
    vertical-align: middle;
  }
  table.meta th {
    background: ${PURPLE}; color: #fff; font-weight: 700; text-align: center; font-size: 14px;
  }
  table.meta td {
    font-size: 22px; font-weight: 700; height: 46px; text-align: center;
  }
  table.meta col.c1, table.meta col.c2, table.meta col.c3 { width: 33.333%; }
  table.cook { margin-top: 10px; }
  table.cook col.label { width: 18%; }
  table.cook col.cycle { width: 16.4%; }
  table.cook thead th { background: ${PURPLE}; color: #fff; font-weight: 700; text-align: center; }
  table.cook tbody th { text-align: left; padding-left: 10px; background: #fff; font-size: 16px; height: 34px; }
  table.cook td.num { text-align: center; font-weight: 700; font-size: 16px; height: 34px; }
  table.cook tr.initials th {
    font-size: 16px; font-weight: 700; background: #eee; height: 34px;
  }
  table.cook td.initial-box { height: 34px; background: #fff; }
  table.prep { margin-top: 12px; }
  table.prep col.item { width: 18%; }
  table.prep col.qty { width: 15.333%; }
  table.prep thead th {
    background: ${PURPLE}; color: #fff; font-weight: 700; text-align: center; font-size: 15px;
  }
  table.prep td {
    height: 28px; font-size: 13px; font-weight: 700;
  }
  table.prep td.prep-qty { text-align: center; white-space: nowrap; }
  table.prep td.empty { background: #c8c8c8; color: transparent; }
</style></head><body>
  <div class="page">
    <div class="banner">Prep Guide</div>
    <table class="meta">
      <colgroup><col class="c1"><col class="c2"><col class="c3"></colgroup>
      <tr>
        <th>Forecast</th>
        <th>${guide.storeLabel}</th>
        <th>Date</th>
      </tr>
      <tr>
        <td>${formatMoney(guide.forecastSales)}</td>
        <td>${guide.weekday}</td>
        <td>${formatDdMmYyyy(guide.dateKey)}</td>
      </tr>
    </table>
    <table class="cook">
      <colgroup>
        <col class="label">
        ${cookBlocks.map(() => '<col class="cycle">').join('')}
      </colgroup>
      <thead>
        <tr>
          <th>Cook Cycle</th>
          ${cookBlocks.map((b) => `<th>${b}</th>`).join('')}
        </tr>
      </thead>
      <tbody>
        ${cookRows}
        <tr class="initials">
          <th>MANAGER INITIAL</th>
          ${initialCells}
        </tr>
      </tbody>
    </table>
    <table class="prep">
      <colgroup>
        <col class="item"><col class="qty">
        <col class="item"><col class="qty">
        <col class="item"><col class="qty">
      </colgroup>
      <thead>
        <tr>
          <th colspan="2">SALAD PREP</th>
          <th colspan="2">FRY PREP</th>
          <th colspan="2">THAWING</th>
        </tr>
      </thead>
      <tbody>${prepRowsHtml}</tbody>
    </table>
  </div>
</body></html>`;
}

async function renderPdf(html, outFile, browser) {
    const page = await browser.newPage();
    try {
        await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.pdf({
            path: outFile,
            landscape: true,
            format: 'A4',
            printBackground: true,
            margin: { top: '6mm', bottom: '6mm', left: '6mm', right: '6mm' },
        });
    } finally {
        await page.close().catch(() => {});
    }
}

async function renderWeekPdfs(storeNumber, workbookPath, onProgress) {
    const puppeteer = require('../../../src/puppeteerCompat');
    const dir = storeDir(storeNumber);
    const pdfs = {};
    // One browser for all 7 weekdays - launching Chromium 7x was freezing the app.
    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    try {
        for (const weekday of WEEKDAYS) {
            onProgress?.(`Rendering ${weekday} PDF...`);
            const guide = buildDayGuide(workbookPath, storeNumber, weekday);
            const html = dayHtml(guide);
            const pdfFile = path.join(dir, `${weekday}.pdf`);
            await renderPdf(html, pdfFile, browser);
            pdfs[weekday] = pdfFile;
            onProgress?.(`PDF ready: ${weekday} (forecast ${formatMoney(guide.forecastSales)})`);
            // Yield to the event loop so Electron UI can paint between days.
            await new Promise((r) => setImmediate(r));
        }
    } finally {
        await browser.close().catch(() => {});
    }
    return pdfs;
}

async function updateSalesHistory(storeNumber, options = {}) {
    const store = String(storeNumber || '').trim();
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
    onProgress?.(`Updating sales history for ${store}...`);
    return ensureHistoryData(store, { force: options.force !== false, onProgress });
}

async function updateIse(storeNumber, options = {}) {
    const store = String(storeNumber || '').trim();
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
    onProgress?.(`Updating ISE for ${store}...`);
    return ensureIseData(store, { force: options.force !== false, onProgress });
}

async function updateForecastWorkbook(storeNumber, options = {}) {
    const store = String(storeNumber || '').trim();
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;

    // Always fill any missing ISE weeks before writing the workbook.
    onProgress?.(`Checking ISE coverage for ${store}…`);
    const ise = await ensureIseData(store, {
        force: Boolean(options.forceIse),
        onProgress,
    });
    onProgress?.(
        ise.skipped
            ? `ISE ready (${ise.snapshots}/5 weeks).`
            : ise.ok
              ? `ISE updated (${ise.snapshots}/5 weeks).`
              : `ISE incomplete: ${ise.error || 'unknown'} — writing workbook with what we have.`
    );

    onProgress?.(`Writing ISE + Sales + forecast into Prep Guide for ${store}...`);
    const outPath = await writeStoreWorkbook(store);
    onProgress?.('Recalculating Excel formulas (async)...');
    const recalc = await recalcWorkbook(outPath);
    onProgress?.(
        recalc.ok
            ? 'Excel recalculated formulas.'
            : `Excel recalc ${recalc.skipped ? 'skipped' : 'failed'} - workbook values saved anyway.`
    );
    const weeks = weekTotalsForStore(store, 1);
    return {
        ok: true,
        workbookPath: outPath,
        recalc,
        ise,
        weekTotal: weeks.weekStates?.[0]?.total || weeks.weekTotal || 0,
        historyDays: listDayKeys(store).length,
        iseSnapshots: iseSnapshotCount(store),
    };
}

/**
 * Build Prep Guide PDFs for a store from current local data.
 * Always downloads any missing ISE weeks (5 total). Pass fetchIse:true to re-download all 5.
 * fetchMissing:true also backfills sales history.
 */
async function regenerateStore(storeNumber, options = {}) {
    const store = String(storeNumber || '').trim();
    const fetchMissing = Boolean(options.fetchMissing);
    const fetchIse = Boolean(options.fetchIse);
    const logs = [];
    const push = (m) => {
        const line = String(m || '').trim();
        if (!line) return;
        logs.push(line);
        console.log(`[prep-guides ${store}] ${line}`);
        options.onProgress?.(line);
    };

    let history = { ok: true, skipped: true, days: listDayKeys(store).length };
    let ise = { ok: true, skipped: true, snapshots: iseSnapshotCount(store) };

    if (fetchMissing) {
        push('Ensuring sales history...');
        history = await ensureHistoryData(store, {
            force: Boolean(options.forceSales),
            onProgress: push,
        });
        push(
            history.skipped
                ? `History ready (${history.days} days).`
                : history.ok
                  ? `Backfilled history - now ${history.days} days (imported ${history.imported || 0}).`
                  : `History backfill issue: ${history.error || 'unknown'}`
        );
    } else {
        push(`Sales history on disk: ${history.days} day(s).`);
    }

    push(fetchIse ? 'Re-downloading all 5 ISE weeks…' : 'Ensuring missing ISE weeks are downloaded…');
    ise = await ensureIseData(store, { force: fetchIse, onProgress: push });
    push(
        ise.skipped
            ? `ISE ready (${ise.snapshots || iseSnapshotCount(store)}/5 weeks).`
            : ise.ok
              ? `ISE ready (${ise.snapshots || iseSnapshotCount(store)}/5 weeks).`
              : `ISE fetch issue: ${ise.error || 'unknown'} - building with workbook values.`
    );

    push('Writing store workbook from Prep Guide template...');
    const workbookPath = await writeStoreWorkbook(store);
    push('Recalculating Excel formulas (async)...');
    const recalc = await recalcWorkbook(workbookPath);
    push(
        recalc.ok
            ? 'Excel recalculated formulas.'
            : `Excel recalc ${recalc.skipped ? 'skipped' : 'failed'} - using sheet values as available.`
    );

    const pdfs = await renderWeekPdfs(store, workbookPath, push);

    // Day sheets (Monday…Sunday) already live in the template — formulas recalc from ISE/Sales/Forecast.
    for (const day of WEEKDAYS) {
        try {
            const g = buildDayGuide(workbookPath, store, day);
            push(
                `${day} ${formatDdMmYyyy(g.dateKey)}: forecast ${formatMoney(g.forecastSales)} · beef ${
                    (g.cook.BEEF || []).join('/')
                }`
            );
        } catch (err) {
            push(`${day}: ${err.message || err}`);
        }
    }
    push('Open the Monday–Sunday tabs in Excel (template layout). PDFs mirror those values.');

    const meta = {
        storeNumber: store,
        regeneratedAt: new Date().toISOString(),
        workbookPath,
        pdfs,
        logs,
        history,
        ise: { ...ise, snapshots: Number(ise.snapshots ?? iseSnapshotCount(store)) || 0 },
        recalc,
    };
    fs.writeFileSync(path.join(storeDir(store), 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
    push('Prep Guide regenerate finished.');
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
        let pdfCount = 0;
        for (const weekday of WEEKDAYS) {
            const p = path.join(dir, `${weekday}.pdf`);
            const exists = fs.existsSync(p);
            pdfs[weekday] = exists ? p : null;
            if (exists) pdfCount += 1;
        }
        const historyDays = listDayKeys(storeNumber).length;
        const iseSnapshots = iseSnapshotCount(storeNumber);
        let weekTotal = 0;
        try {
            const weeks = weekTotalsForStore(storeNumber, 1);
            weekTotal = Number(weeks.weekStates?.[0]?.total || weeks.weekTotal || 0) || 0;
        } catch {
            weekTotal = 0;
        }
        return {
            storeNumber,
            storeName: storeLabel(storeNumber).replace(/^\d+\s*-\s*/, ''),
            storeLabel: storeLabel(storeNumber),
            email: storeEmails.getEmail(storeNumber),
            regeneratedAt: meta?.regeneratedAt || null,
            workbookPath: meta?.workbookPath || workbookPath(storeNumber),
            workbookExists: fs.existsSync(resolveWorkbookPath(storeNumber)),
            pdfs,
            pdfCount,
            historyDays,
            historyReady: historyDays >= 21,
            iseSnapshots,
            iseReady: iseSnapshots >= 1,
            weekTotal,
            lastError: meta?.history?.error || meta?.ise?.error || null,
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
    const sentAt = new Date().toISOString();
    const storesSent = { ...(state.storesSent && typeof state.storesSent === 'object' ? state.storesSent : {}) };
    for (const s of stores) {
        const email = storeEmails.getEmail(s.storeNumber);
        if (!email) continue;
        try {
            const existing = pdfPath(s.storeNumber, now.weekday);
            if (!existing) {
                await regenerateStore(s.storeNumber, { fetchMissing: true });
            }
            const row = await sendPrepGuideEmail(s.storeNumber, now.weekday);
            results.push(row);
            if (row?.ok) {
                storesSent[String(s.storeNumber)] = {
                    at: sentAt,
                    weekday: now.weekday,
                    to: row.to || email,
                };
            }
        } catch (err) {
            results.push({ ok: false, storeNumber: s.storeNumber, error: err.message });
        }
    }
    writeState({
        ...state,
        lastEmailDateKey: now.dateKey,
        lastEmailAt: sentAt,
        results,
        storesSent,
    });
    return { ok: true, dateKey: now.dateKey, weekday: now.weekday, results };
}

/** Last successful prep-guide email time per store (ISO), if known. */
function lastPrepEmailAt(storeNumber) {
    const store = String(storeNumber || '').trim();
    if (!store) return null;
    const state = readState();
    const row = state.storesSent?.[store];
    if (row?.at) return row.at;
    // Fall back to last bulk pass if this store was in the successful results.
    if (state.lastEmailAt && Array.isArray(state.results)) {
        const hit = state.results.find(
            (r) => String(r?.storeNumber) === store && r.ok && !r.skipped
        );
        if (hit) return state.lastEmailAt;
    }
    return null;
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
    updateSalesHistory,
    updateIse,
    updateForecastWorkbook,
    listStoreStatus,
    pdfPath,
    workbookPath,
    workbookFilename,
    resolveWorkbookPath,
    openWorkbook,
    stampWorkbookToMatchPdf,
    buildDayGuide,
    sendPrepGuideEmail,
    runFiveAmEmailPass,
    lastPrepEmailAt,
    startFiveAmScheduler,
    OUT_ROOT,
};
