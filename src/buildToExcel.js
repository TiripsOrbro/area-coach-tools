/**
 * Build To: download On Hand / On Order / ISE into the master workbook tabs
 * (values only via mmx-report-automation ExcelJS merge — no formatting rewrites).
 */
const { spawn, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const paths = require('./paths');

const STATE_FILE = path.join(paths.dashboard.data, 'build-to-excel-state.json');
const WORKBOOK_DIR = path.join(paths.root, 'data', 'workbooks');
const FALLBACK_WORKBOOK = path.join(WORKBOOK_DIR, 'Build-To-Master.xlsx');
const DOWNLOADS_MASTER = path.join(
    process.env.USERPROFILE || '',
    'Downloads',
    'Build To Master File.xlsx'
);

function automationCandidates() {
    const env = String(process.env.MMX_REPORT_AUTOMATION_DIR || '').trim();
    return [
        env,
        paths.mmxReportAutomation,
        path.join('Y:', 'Taco Bell Dashboard', 'mmx-report-automation'),
        path.join(paths.root, '..', 'mmx-report-automation'),
        path.join(paths.root, 'mmx-report-automation'),
        path.join(process.env.USERPROFILE || '', 'Taco Bell Dashboard', 'mmx-report-automation'),
    ].filter(Boolean);
}

function resolveAutomationRoot() {
    for (const candidate of automationCandidates()) {
        const resolved = path.resolve(candidate);
        if (fs.existsSync(path.join(resolved, 'package.json'))) {
            return resolved;
        }
    }
    return path.resolve(automationCandidates()[0] || paths.mmxReportAutomation);
}

function automationRoot() {
    return resolveAutomationRoot();
}

/**
 * Prefer the Downloads master file. Never rewrite/reformat it — only byte-copy to fallback.
 */
function resolveWorkbookPath() {
    if (fs.existsSync(DOWNLOADS_MASTER)) {
        return DOWNLOADS_MASTER;
    }
    fs.mkdirSync(WORKBOOK_DIR, { recursive: true });
    if (!fs.existsSync(FALLBACK_WORKBOOK)) {
        // Last resort: keep whatever was shipped under data/workbooks (already in repo)
        // Do not generate/modify sheets here.
    }
    return FALLBACK_WORKBOOK;
}

function ensureWorkbook() {
    const preferred = resolveWorkbookPath();
    if (preferred === DOWNLOADS_MASTER) {
        // Keep a byte-identical fallback copy for machines that later lose Downloads
        try {
            fs.mkdirSync(WORKBOOK_DIR, { recursive: true });
            if (!fs.existsSync(FALLBACK_WORKBOOK)) {
                fs.copyFileSync(DOWNLOADS_MASTER, FALLBACK_WORKBOOK);
            }
        } catch {
            /* ignore */
        }
        return DOWNLOADS_MASTER;
    }
    return preferred;
}

function workbookPath() {
    return ensureWorkbook();
}

function openWorkbook() {
    const file = ensureWorkbook();
    return new Promise((resolve) => {
        if (!fs.existsSync(file)) {
            resolve({
                ok: false,
                path: file,
                error: `Workbook not found. Place "Build To Master File.xlsx" in Downloads.`,
            });
            return;
        }
        if (process.platform === 'win32') {
            exec(`start "" "${file}"`, (err) => {
                resolve({ ok: !err, path: file, error: err?.message || null });
            });
        } else {
            exec(`open "${file}"`, (err) => {
                resolve({ ok: !err, path: file, error: err?.message || null });
            });
        }
    });
}

function readState() {
    if (!fs.existsSync(STATE_FILE)) return { lastRun: null, history: [], stores: {} };
    try {
        const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        return {
            lastRun: raw.lastRun || null,
            history: Array.isArray(raw.history) ? raw.history : [],
            stores: raw.stores && typeof raw.stores === 'object' ? raw.stores : {},
        };
    } catch {
        return { lastRun: null, history: [], stores: {} };
    }
}

function writeState(state) {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

function markStore(storeNumber, patch) {
    const state = readState();
    const key = String(storeNumber || '').trim();
    if (!key) return state;
    state.stores[key] = {
        ...(state.stores[key] || {}),
        ...patch,
        storeNumber: key,
        updatedAt: new Date().toISOString(),
    };
    writeState(state);
    return state;
}

function listStoreStatuses(storeRows = []) {
    const state = readState();
    return (storeRows || []).map((s) => {
        const key = String(s.storeNumber);
        const row = state.stores[key] || {};
        return {
            storeNumber: key,
            storeName: s.storeName || '',
            buildToUpdatedAt: row.buildToUpdatedAt || null,
            mmxOrdersUpdatedAt: row.mmxOrdersUpdatedAt || null,
            lastError: row.lastError || null,
            lastMode: row.lastMode || null,
        };
    });
}

function getStatus(storeRows = []) {
    const root = resolveAutomationRoot();
    const state = readState();
    const wb = ensureWorkbook();
    const packageJson = fs.existsSync(path.join(root, 'package.json'));
    return {
        automationDir: root,
        automationExists: packageJson,
        packageJson,
        workbookPath: wb,
        workbookExists: fs.existsSync(wb),
        workbookSource: wb === DOWNLOADS_MASTER ? 'downloads' : 'fallback',
        downloadsMaster: DOWNLOADS_MASTER,
        downloadsMasterExists: fs.existsSync(DOWNLOADS_MASTER),
        lastRun: state.lastRun,
        history: (state.history || []).slice(0, 10),
        stores: listStoreStatuses(storeRows),
        hint: packageJson
            ? null
            : 'Automation missing: install/clone mmx-report-automation and set MMX_REPORT_AUTOMATION_DIR (e.g. Y:\\Taco Bell Dashboard\\mmx-report-automation).',
    };
}

function coachMmxEnv() {
    try {
        const { readSession } = require('../stores/src/coachSession');
        const session = readSession();
        const username = String(session.mmx?.username || '').trim();
        const password = String(session.mmx?.password || '');
        if (!username || !password) return {};
        return {
            SCRAPER_USERNAME: username,
            SCRAPER_PASSWORD: password,
        };
    } catch {
        return {};
    }
}

function storeLabel(storeNumber, storeName) {
    const n = String(storeNumber || '').trim();
    const name = String(storeName || '').trim();
    return name ? `${n} ${name}` : n;
}

let inFlight = null;

async function maybeSendWarnEmails(result) {
    const text = `${result.stdout || ''}\n${result.stderr || ''}`;
    if (!/WARN|warning threshold|below warn/i.test(text)) return;
    try {
        const { readSession } = require('../stores/src/coachSession');
        const session = readSession();
        const to = String(session.alertEmail || '').trim();
        if (!to) return;
        const nodemailer = require('nodemailer');
        const host = process.env.DASHBOARD_SMTP_HOST;
        if (!host) return;
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
            subject: `Build-to warning - ${session.displayName || session.userId || 'coach'}`,
            text: `A build-to warn threshold was triggered.\n\n${text.slice(-4000)}`,
        });
        result.warnEmailSent = true;
    } catch (err) {
        result.warnEmailError = err.message;
    }
}

function spawnAutomation(args, envExtra = {}) {
    const root = resolveAutomationRoot();
    return new Promise((resolve) => {
        if (!fs.existsSync(path.join(root, 'package.json'))) {
            resolve({
                ok: false,
                code: 1,
                stdout: '',
                stderr: '',
                error: `mmx-report-automation not found at ${root}. Set MMX_REPORT_AUTOMATION_DIR.`,
            });
            return;
        }
        const child = spawn(process.execPath, args, {
            cwd: root,
            env: { ...process.env, ...envExtra },
            windowsHide: true,
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => {
            stdout += chunk.toString();
        });
        child.stderr.on('data', (chunk) => {
            stderr += chunk.toString();
        });
        child.on('close', (code) => {
            resolve({
                ok: code === 0,
                code,
                stdout: stdout.slice(-12000),
                stderr: stderr.slice(-12000),
                error: code === 0 ? null : `automation exited with code ${code}`,
            });
        });
        child.on('error', (err) => {
            resolve({
                ok: false,
                code: 1,
                stdout,
                stderr,
                error: err.message || String(err),
            });
        });
    });
}

/**
 * mode:
 *  - reports (default): download On Hand + On Order + ISE, merge into workbook tabs (dry-run, no MMX orders)
 *  - orders: enter vendor orders in MMX from workbook
 */
async function runExcelBuildTo(options = {}) {
    if (inFlight) return inFlight;

    const mode = String(options.mode || 'reports').toLowerCase() === 'orders' ? 'orders' : 'reports';
    const workbook = ensureWorkbook();
    const root = resolveAutomationRoot();
    const startedAt = new Date().toISOString();

    if (!fs.existsSync(workbook)) {
        return {
            ok: false,
            error: `Workbook missing. Expected Downloads\\Build To Master File.xlsx`,
            workbook,
        };
    }
    if (!fs.existsSync(path.join(root, 'package.json'))) {
        return {
            ok: false,
            error: `mmx-report-automation not found at ${root}. Set MMX_REPORT_AUTOMATION_DIR in .env (e.g. Y:\\Taco Bell Dashboard\\mmx-report-automation).`,
            automationDir: root,
        };
    }

    const stores = Array.isArray(options.stores) && options.stores.length
        ? options.stores
        : options.store
          ? [{ storeNumber: options.store, storeName: '' }]
          : [];

    inFlight = (async () => {
        const perStore = [];
        const mmxEnv = coachMmxEnv();

        if (!stores.length) {
            // Single run with whatever store is configured in automation .env
            const args =
                mode === 'orders'
                    ? [path.join(root, 'src', 'run.js'), '--orders-only', '--force']
                    : [path.join(root, 'src', 'run.js'), '--dry-run', '--skip-gate', '--force'];
            const result = await spawnAutomation(args, {
                ...mmxEnv,
                MMX_TEMPLATE_LOCAL: workbook,
                BUILD_TO_WORKBOOK: workbook,
                MMX_TEMPLATE_ALWAYS_COPY: 'false',
                MMX_PDF_EXPORT_ENABLED: 'false',
                MMX_EMAIL_ENABLED: 'false',
            });
            const finishedAt = new Date().toISOString();
            const doc = {
                ok: result.ok,
                mode,
                startedAt,
                finishedAt,
                workbook,
                automationDir: root,
                ...result,
            };
            await maybeSendWarnEmails(doc);
            const state = readState();
            state.lastRun = doc;
            state.history = [doc, ...(state.history || [])].slice(0, 20);
            writeState(state);
            return doc;
        }

        for (const store of stores) {
            const label = storeLabel(store.storeNumber, store.storeName);
            const args =
                mode === 'orders'
                    ? [path.join(root, 'src', 'run.js'), '--orders-only', '--force']
                    : [path.join(root, 'src', 'run.js'), '--dry-run', '--skip-gate', '--force'];
            const result = await spawnAutomation(args, {
                ...mmxEnv,
                MMX_TEMPLATE_LOCAL: workbook,
                BUILD_TO_WORKBOOK: workbook,
                MMX_TEMPLATE_ALWAYS_COPY: 'false',
                MMX_PDF_EXPORT_ENABLED: 'false',
                MMX_EMAIL_ENABLED: 'false',
                MMX_STORE_NAME: label,
                MMX_LABOUR_STORES: label,
            });
            const row = {
                storeNumber: String(store.storeNumber),
                storeName: store.storeName || '',
                ok: result.ok,
                mode,
                error: result.error,
                stdout: result.stdout,
                stderr: result.stderr,
            };
            perStore.push(row);
            if (result.ok) {
                markStore(store.storeNumber, {
                    lastError: null,
                    lastMode: mode,
                    ...(mode === 'orders'
                        ? { mmxOrdersUpdatedAt: new Date().toISOString() }
                        : { buildToUpdatedAt: new Date().toISOString() }),
                });
            } else {
                markStore(store.storeNumber, {
                    lastError: result.error || 'failed',
                    lastMode: mode,
                });
            }
        }

        const ok = perStore.every((r) => r.ok);
        const finishedAt = new Date().toISOString();
        const doc = {
            ok,
            mode,
            startedAt,
            finishedAt,
            workbook,
            automationDir: root,
            stores: perStore,
            stdout: perStore.map((r) => `=== ${r.storeNumber} ===\n${r.stdout || ''}`).join('\n').slice(-12000),
            stderr: perStore.map((r) => r.stderr || '').join('\n').slice(-8000),
            error: ok ? null : perStore.find((r) => !r.ok)?.error || 'One or more stores failed',
        };
        await maybeSendWarnEmails(doc);
        const state = readState();
        state.lastRun = doc;
        state.history = [doc, ...(state.history || [])].slice(0, 20);
        writeState(state);
        return doc;
    })().finally(() => {
        inFlight = null;
    });

    return inFlight;
}

function isRunning() {
    return Boolean(inFlight);
}

module.exports = {
    getStatus,
    runExcelBuildTo,
    openWorkbook,
    workbookPath,
    isRunning,
    automationRoot,
    ensureWorkbook,
    listStoreStatuses,
    DOWNLOADS_MASTER,
};
