/**
 * Prep Guide: fill Excel template from hourly sales + ISE averages, render day PDFs, email at 5am.
 */
const fs = require('fs');
const path = require('path');
const paths = require('../../../src/paths');
const { recentDays } = require('../../../forecast/src/historyStore');
const { listStoresForCoach } = require('../../../stores/src/coachScope');
const storeEmails = require('../storeEmails');

const TEMPLATE = path.join(paths.root, 'data', 'workbooks', 'Prep-Guide-Template.xlsx');
const SOURCE_DOWNLOAD = path.join(process.env.USERPROFILE || '', 'Downloads', 'Prep Guide.xlsx');
const OUT_ROOT = path.join(paths.root, 'data', 'prep-guides');
const STATE_FILE = path.join(paths.dashboard.data, 'prep-guides-state.json');

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const WEEKDAY_INDEX = { Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6 };

function ensureTemplate() {
    const dir = path.dirname(TEMPLATE);
    fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(TEMPLATE)) return TEMPLATE;
    if (fs.existsSync(SOURCE_DOWNLOAD)) {
        fs.copyFileSync(SOURCE_DOWNLOAD, TEMPLATE);
        return TEMPLATE;
    }
    // Minimal placeholder
    const xlsx = require('xlsx');
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet([['Hourly Sales Average']]), 'Sales');
    xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet([['ISE Average']]), 'ISE');
    xlsx.writeFile(wb, TEMPLATE);
    return TEMPLATE;
}

function storeDir(storeNumber) {
    const dir = path.join(OUT_ROOT, String(storeNumber));
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function weekdayForIso(dateKey, timeZone = process.env.DASHBOARD_TIME_ZONE || 'Australia/Melbourne') {
    const [y, m, d] = String(dateKey).split('-').map(Number);
    const utc = new Date(Date.UTC(y, m - 1, d, 12));
    return new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long' }).format(utc);
}

/** Average hourly actuals by weekday (Mon–Sun), using last N history days. */
function hourlySalesByWeekday(storeNumber, lookback = 56) {
    const days = recentDays(storeNumber, lookback);
    const buckets = {};
    for (const name of WEEKDAYS) buckets[name] = { sums: [], counts: [] };

    for (const day of days) {
        const label = weekdayForIso(day.dateKey);
        if (!buckets[label]) continue;
        const actual = Array.isArray(day.actual) ? day.actual : [];
        const b = buckets[label];
        for (let h = 0; h < actual.length; h++) {
            if (!b.sums[h]) {
                b.sums[h] = 0;
                b.counts[h] = 0;
            }
            const n = Number(actual[h]);
            if (!Number.isFinite(n)) continue;
            b.sums[h] += n;
            b.counts[h] += 1;
        }
    }

    const out = {};
    for (const name of WEEKDAYS) {
        const b = buckets[name];
        out[name] = b.sums.map((sum, i) => {
            const c = b.counts[i] || 0;
            return c ? Math.round((sum / c) * 100) / 100 : 0;
        });
    }
    return out;
}

function iseAverages(storeNumber) {
    try {
        const { listWeeklySnapshots, resolveIseWeeksDateRange } = require('../reportSubscriptions/iseHistoryLedger');
        const { collectItemWeekdayValues, trimAverage } = require('../reportSubscriptions/iseTrimmedAverage');
        const resolved = resolveIseWeeksDateRange({});
        const snapshots = listWeeklySnapshots(storeNumber, {}, resolved.weeks);
        const itemCodes = new Set();
        for (const snap of snapshots) {
            Object.keys(snap?.items || {}).forEach((c) => itemCodes.add(c));
        }
        const byWeekday = {};
        for (const name of WEEKDAYS) {
            const wd = WEEKDAY_INDEX[name];
            byWeekday[name] = [];
            for (const code of [...itemCodes].sort()) {
                const vals = collectItemWeekdayValues(snapshots, code, wd, resolved.weeks);
                const avg = trimAverage(vals);
                const sample = snapshots.map((s) => s?.items?.[code]).find(Boolean) || {};
                byWeekday[name].push({
                    code,
                    description: sample.description || '',
                    average: avg === '' ? null : avg,
                });
            }
        }
        return byWeekday;
    } catch (err) {
        return { error: err.message || String(err) };
    }
}

function writeWorkbookForStore(storeNumber) {
    ensureTemplate();
    const xlsx = require('xlsx');
    const wb = xlsx.readFile(TEMPLATE);
    const hourly = hourlySalesByWeekday(storeNumber);
    const ise = iseAverages(storeNumber);

    const salesRows = [['Weekday', 'Hour', 'Average']];
    for (const name of WEEKDAYS) {
        (hourly[name] || []).forEach((val, hour) => {
            salesRows.push([name, hour, val]);
        });
    }
    const salesSheet = xlsx.utils.aoa_to_sheet(salesRows);
    if (wb.SheetNames.includes('Sales')) {
        wb.Sheets.Sales = salesSheet;
    } else {
        xlsx.utils.book_append_sheet(wb, salesSheet, 'Sales');
    }

    const iseRows = [['Weekday', 'Item', 'Description', 'Average']];
    if (!ise.error) {
        for (const name of WEEKDAYS) {
            for (const row of ise[name] || []) {
                iseRows.push([name, row.code, row.description, row.average ?? '']);
            }
        }
    } else {
        iseRows.push(['ERROR', '', ise.error, '']);
    }
    const iseSheet = xlsx.utils.aoa_to_sheet(iseRows);
    if (wb.SheetNames.includes('ISE')) {
        wb.Sheets.ISE = iseSheet;
    } else {
        xlsx.utils.book_append_sheet(wb, iseSheet, 'ISE');
    }

    const outPath = path.join(storeDir(storeNumber), 'Prep-Guide.xlsx');
    xlsx.writeFile(wb, outPath);
    return { workbookPath: outPath, hourly, ise };
}

function dayHtml(storeNumber, weekday, hourly, ise) {
    const hours = hourly[weekday] || [];
    const items = (ise && !ise.error ? ise[weekday] : []) || [];
    const hourRows = hours
        .map((v, i) => `<tr><td>${String(i).padStart(2, '0')}:00</td><td style="text-align:right">${v}</td></tr>`)
        .join('');
    const itemRows = items
        .filter((r) => r.average != null)
        .slice(0, 80)
        .map(
            (r) =>
                `<tr><td>${r.code}</td><td>${r.description || ''}</td><td style="text-align:right">${r.average}</td></tr>`
        )
        .join('');
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
      body{font-family:Segoe UI,sans-serif;color:#1a1520;padding:24px}
      h1{margin:0 0 4px;font-size:22px} h2{margin:18px 0 8px;font-size:16px}
      .sub{color:#666;margin:0 0 16px}
      table{width:100%;border-collapse:collapse;font-size:12px;margin-bottom:16px}
      th,td{border-bottom:1px solid #ddd;padding:6px 4px;text-align:left}
      th{background:#f4f1f6}
    </style></head><body>
      <h1>Prep Guide — Store ${storeNumber}</h1>
      <p class="sub">${weekday}</p>
      <h2>Hourly sales average</h2>
      <table><thead><tr><th>Hour</th><th>Avg $</th></tr></thead><tbody>${hourRows || '<tr><td colspan="2">No history</td></tr>'}</tbody></table>
      <h2>ISE average</h2>
      <table><thead><tr><th>Item</th><th>Description</th><th>Avg</th></tr></thead><tbody>${itemRows || '<tr><td colspan="3">No ISE data</td></tr>'}</tbody></table>
    </body></html>`;
}

async function renderPdf(html, outFile) {
    const puppeteer = require('puppeteer');
    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    try {
        const page = await browser.newPage();
        await page.setContent(html, { waitUntil: 'networkidle0' });
        await page.pdf({ path: outFile, format: 'A4', printBackground: true, margin: { top: '12mm', bottom: '12mm', left: '10mm', right: '10mm' } });
    } finally {
        await browser.close();
    }
}

async function regenerateStore(storeNumber) {
    const store = String(storeNumber || '').trim();
    const { workbookPath, hourly, ise } = writeWorkbookForStore(store);
    const dir = storeDir(store);
    const pdfs = {};
    for (const weekday of WEEKDAYS) {
        const html = dayHtml(store, weekday, hourly, ise);
        const pdfPath = path.join(dir, `${weekday}.pdf`);
        await renderPdf(html, pdfPath);
        pdfs[weekday] = pdfPath;
    }
    const meta = {
        storeNumber: store,
        regeneratedAt: new Date().toISOString(),
        workbookPath,
        pdfs,
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
    if (!file) return { ok: false, error: 'PDF missing — regenerate first' };
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
        subject: `Prep Guide — Store ${storeNumber} — ${weekday}`,
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
            // Ensure PDFs exist
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
