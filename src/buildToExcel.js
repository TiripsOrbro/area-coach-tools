/**
 * Build To: per-store workbooks `{store} - Build To.xlsx` in the Account download folder
 * (default: Windows Downloads).
 * Update = download On Hand / On Order / ISE (always --skip-gate, no key-item count).
 * Place orders = MMX vendor orders from that workbook (only after Update today).
 */
const { spawn, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const paths = require('./paths');

const STATE_FILE = path.join(paths.dashboard.data, 'build-to-excel-state.json');
const WORKBOOK_DIR = path.join(paths.root, 'data', 'workbooks');
const FALLBACK_WORKBOOK = path.join(WORKBOOK_DIR, 'Build-To-Master.xlsx');

function defaultDownloadsDir() {
    return path.join(process.env.USERPROFILE || process.env.HOME || '', 'Downloads');
}

/** Build-to workbook folder — Account settings download folder, else ~/Downloads. */
function resolveDownloadsDir() {
    const fromEnv = String(process.env.ACT_DOWNLOAD_FOLDER || process.env.BUILD_TO_DOWNLOADS_DIR || '').trim();
    if (fromEnv) {
        try {
            return path.resolve(fromEnv);
        } catch {
            /* fall through */
        }
    }
    try {
        const { readSession } = require('../stores/src/coachSession');
        const folder = String(readSession().downloadFolder || '').trim();
        if (folder) return path.resolve(folder);
    } catch {
        /* fall through */
    }
    return defaultDownloadsDir();
}

function downloadsMasterPath() {
    return path.join(resolveDownloadsDir(), 'Build To Master File.xlsx');
}

/** Per-store in-flight runs — multiple stores can be queued/updating at once. */
const runningByStore = new Map();

/**
 * Serialize Chromium launches — concurrent children share one browser-profile and
 * crash with "Failed to launch the browser process". UI can still start several stores;
 * they wait for the MMX slot.
 */
let mmxBuildQueue = Promise.resolve();
let mmxBuildActive = null;

function enqueueMmxBuild(storeNumber, onProgress, work) {
    const progress = typeof onProgress === 'function' ? onProgress : () => {};
    const store = String(storeNumber || '').replace(/\D/g, '');
    const run = mmxBuildQueue.then(async () => {
        if (mmxBuildActive && mmxBuildActive !== store) {
            progress(`Store ${store}: queued — waiting for store ${mmxBuildActive} to finish MMX…`);
        }
        mmxBuildActive = store;
        progress(`Store ${store}: MMX browser slot acquired`);
        try {
            return await work();
        } finally {
            if (mmxBuildActive === store) mmxBuildActive = null;
        }
    });
    mmxBuildQueue = run.then(
        () => undefined,
        () => undefined
    );
    return run;
}

/** Prefer a real ERROR line from automation output over bare "exited with code N". */
function extractAutomationError(result) {
    const blob = `${result?.stderr || ''}\n${result?.stdout || ''}`;
    const lines = blob
        .split(/\r?\n/)
        .map((l) => l.replace(/^\[err\]\s*/i, '').trim())
        .filter(Boolean);
    const hit = [...lines]
        .reverse()
        .find((l) =>
            /\[ERROR\]|Failed to launch|Login did not complete|could not select|still on SelectStore|ECONNREFUSED|ENOENT/i.test(
                l
            )
        );
    if (hit) {
        return hit.replace(/^\[ERROR\]\s*/i, '').slice(0, 280);
    }
    return result?.error || (result?.code != null ? `automation exited with code ${result.code}` : 'automation failed');
}

/** Reports-only runs that finished Excel merge should count as success even if a late browser teardown errors. */
function reportsUpdateSucceeded(result) {
    const blob = `${result?.stdout || ''}\n${result?.stderr || ''}`;
    const merged =
        /Updated working template:/i.test(blob) ||
        /Recalculated and saved:/i.test(blob) ||
        /Mapped report1/i.test(blob);
    const dryDone =
        /Dry-run: skipping vendor order entry/i.test(blob) ||
        /Build-to reports update complete/i.test(blob);
    return merged && dryDone;
}

function listRunning() {
    return [...runningByStore.entries()].map(([storeNumber, meta]) => ({
        storeNumber,
        mode: meta.mode,
        startedAt: meta.startedAt,
    }));
}

function isStoreRunning(storeNumber) {
    return runningByStore.has(String(storeNumber || '').replace(/\D/g, ''));
}

/**
 * If the child logged "complete" but Chromium hung before exit, runningByStore stays set
 * and the UI shows Updating forever. Clear those after a short grace period.
 */
function reclaimStuckBuildToRunning() {
    let activity;
    try {
        activity = require('./activityTracker');
    } catch {
        return;
    }
    const { active } = activity.list() || { active: [] };
    for (const [store] of [...runningByStore.entries()]) {
        const entry = (active || []).find(
            (a) =>
                String(a.storeNumber || '') === store &&
                (a.kind === 'build-to-update' || a.kind === 'build-to-orders')
        );
        if (!entry) continue;
        const logText = (entry.logs || []).map((l) => String(l.message || '')).join('\n');
        const complete =
            /Build-to reports update complete/i.test(logText) ||
            /Pipeline finished successfully/i.test(logText) ||
            /reports merged successfully/i.test(logText);
        if (!complete) continue;
        const lastLog = (entry.logs || [])[(entry.logs || []).length - 1];
        const lastAt = Number(lastLog?.at) || Number(entry.updatedAt) || 0;
        if (!lastAt || Date.now() - lastAt < 10000) continue;
        runningByStore.delete(store);
        activity.end(entry.id, { ok: true, detail: 'Done' });
    }
}

function builtinAutomationDir() {
    return path.join(paths.root, 'mmx-report-automation');
}

function automationCandidates() {
    const env = String(process.env.MMX_REPORT_AUTOMATION_DIR || '').trim();
    return [
        env,
        builtinAutomationDir(),
        paths.mmxReportAutomation,
        path.join('Y:', 'Taco Bell Dashboard', 'mmx-report-automation'),
        path.join(paths.root, '..', 'mmx-report-automation'),
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
    return path.resolve(builtinAutomationDir());
}

function automationRoot() {
    return resolveAutomationRoot();
}

function isBuiltinAutomation(root = resolveAutomationRoot()) {
    try {
        return path.resolve(root) === path.resolve(builtinAutomationDir());
    } catch {
        return false;
    }
}

function melbourneDateKey(d = new Date()) {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: process.env.DASHBOARD_TIME_ZONE || 'Australia/Melbourne',
    }).format(d);
}

function storeWorkbookFilename(storeNumber) {
    const n = String(storeNumber || '').replace(/\D/g, '');
    return `${n} - Build To.xlsx`;
}

/** Prefer Downloads\{store} - Build To.xlsx, else data/workbooks\{store} - Build To.xlsx */
function resolveStoreWorkbookPath(storeNumber) {
    const name = storeWorkbookFilename(storeNumber);
    const downloads = path.join(resolveDownloadsDir(), name);
    if (fs.existsSync(downloads)) return downloads;
    const fallback = path.join(WORKBOOK_DIR, name);
    if (fs.existsSync(fallback)) return fallback;
    return downloads;
}

function masterTemplateCandidates() {
    return [
        downloadsMasterPath(),
        FALLBACK_WORKBOOK,
        path.join(resolveAutomationRoot(), 'assets', 'workbooks', 'Build To.xlsx'),
        path.join(paths.root, '..', 'mmx-report-automation', 'assets', 'workbooks', 'Build To.xlsx'),
    ];
}

function findMasterTemplate() {
    for (const p of masterTemplateCandidates()) {
        if (p && fs.existsSync(p)) return p;
    }
    return null;
}

/**
 * Ensure per-store workbook exists (copy from master template on first use).
 * Returns absolute path to `{store} - Build To.xlsx`.
 */
function ensureStoreWorkbook(storeNumber) {
    const n = String(storeNumber || '').replace(/\D/g, '');
    if (!n) throw new Error('storeNumber required for Build-to workbook');
    const downloadsDir = resolveDownloadsDir();
    const preferred = path.join(downloadsDir, storeWorkbookFilename(n));
    if (fs.existsSync(preferred)) return preferred;
    const fallback = path.join(WORKBOOK_DIR, storeWorkbookFilename(n));
    if (fs.existsSync(fallback)) return fallback;

    const template = findMasterTemplate();
    if (!template) {
        throw new Error(
            `No Build-to template found. Place "Build To Master File.xlsx" in ${downloadsDir}, or ${storeWorkbookFilename(n)}.`
        );
    }
    try {
        fs.mkdirSync(downloadsDir, { recursive: true });
        fs.copyFileSync(template, preferred);
        return preferred;
    } catch {
        fs.mkdirSync(WORKBOOK_DIR, { recursive: true });
        fs.copyFileSync(template, fallback);
        return fallback;
    }
}

/** @deprecated Use ensureStoreWorkbook — kept for startup status. */
function resolveWorkbookPath() {
    const master = downloadsMasterPath();
    if (fs.existsSync(master)) return master;
    fs.mkdirSync(WORKBOOK_DIR, { recursive: true });
    return FALLBACK_WORKBOOK;
}

function ensureWorkbook() {
    return resolveWorkbookPath();
}

function workbookPath(storeNumber) {
    if (storeNumber) return resolveStoreWorkbookPath(storeNumber);
    return ensureWorkbook();
}

function isBuildToFresh(iso) {
    if (!iso) return false;
    try {
        return melbourneDateKey(new Date(iso)) === melbourneDateKey();
    } catch {
        return false;
    }
}

function openWorkbook(storeNumber) {
    return new Promise((resolve) => {
        const store = String(storeNumber || '').replace(/\D/g, '');
        if (!store) {
            resolve({
                ok: false,
                error: 'storeNumber required — open a store Build-to file (e.g. 3901 - Build To.xlsx).',
            });
            return;
        }
        let file;
        try {
            file = ensureStoreWorkbook(store);
        } catch (err) {
            resolve({ ok: false, path: null, error: err.message || String(err) });
            return;
        }
        if (!fs.existsSync(file)) {
            resolve({
                ok: false,
                path: file,
                error: `Workbook not found: ${storeWorkbookFilename(store)}`,
            });
            return;
        }
        if (process.platform === 'win32') {
            exec(`start "" "${file}"`, (err) => {
                resolve({ ok: !err, path: file, storeNumber: store, error: err?.message || null });
            });
        } else {
            exec(`open "${file}"`, (err) => {
                resolve({ ok: !err, path: file, storeNumber: store, error: err?.message || null });
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

/** Serialize state file read/modify/write so concurrent store runs don't clobber each other. */
let stateLock = Promise.resolve();
function withStateLock(fn) {
    const run = stateLock.then(() => fn());
    stateLock = run.then(
        () => undefined,
        () => undefined
    );
    return run;
}

function markStore(storeNumber, patch) {
    const key = String(storeNumber || '').trim();
    if (!key) return readState();
    return withStateLock(() => {
        const state = readState();
        state.stores[key] = {
            ...(state.stores[key] || {}),
            ...patch,
            storeNumber: key,
            updatedAt: new Date().toISOString(),
        };
        writeState(state);
        return state;
    });
}

function appendRunHistory(doc) {
    return withStateLock(() => {
        const state = readState();
        state.lastRun = doc;
        state.history = [doc, ...(state.history || [])].slice(0, 20);
        writeState(state);
        return state;
    });
}

function listStoreStatuses(storeRows = []) {
    reclaimStuckBuildToRunning();
    const state = readState();
    return (storeRows || []).map((s) => {
        const key = String(s.storeNumber);
        const row = state.stores[key] || {};
        const wbPath = resolveStoreWorkbookPath(key);
        const buildToUpdatedAt = row.buildToUpdatedAt || null;
        const running = runningByStore.get(key) || null;
        return {
            storeNumber: key,
            storeName: s.storeName || '',
            buildToUpdatedAt,
            mmxOrdersUpdatedAt: row.mmxOrdersUpdatedAt || null,
            lastError: row.lastError || null,
            lastMode: row.lastMode || null,
            workbookPath: wbPath,
            workbookName: storeWorkbookFilename(key),
            workbookExists: fs.existsSync(wbPath),
            canPlaceOrders: isBuildToFresh(buildToUpdatedAt),
            running: Boolean(running),
            runningMode: running?.mode || null,
        };
    });
}

function getStatus(storeRows = []) {
    const root = resolveAutomationRoot();
    const state = readState();
    const packageJson = fs.existsSync(path.join(root, 'package.json'));
    const builtin = isBuiltinAutomation(root);
    const nodeModules = fs.existsSync(path.join(root, 'node_modules'));
    const template = findMasterTemplate();
    return {
        automationDir: root,
        automationExists: packageJson,
        automationBuiltin: builtin,
        automationSource: builtin ? 'builtin' : packageJson ? 'external' : 'missing',
        packageJson,
        nodeModules,
        templatePath: template,
        templateExists: Boolean(template),
        workbookPath: template || downloadsMasterPath(),
        workbookExists: Boolean(template),
        workbookSource: 'per-store',
        downloadsDir: resolveDownloadsDir(),
        downloadsMaster: downloadsMasterPath(),
        downloadsMasterExists: fs.existsSync(downloadsMasterPath()),
        lastRun: state.lastRun,
        history: (state.history || []).slice(0, 10),
        stores: listStoreStatuses(storeRows),
        runningStores: listRunning(),
        runningCount: runningByStore.size,
        hint: packageJson
            ? nodeModules
                ? null
                : 'Build-to package found but dependencies are missing. Run: npm run buildto:install'
            : 'Built-in Build-to package missing from this install. Re-run the Area Coach Tools installer/update.',
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

function emitLineChunks(buffer, chunk, onLine) {
    const text = String(chunk || '');
    if (!onLine) return buffer + text;
    const combined = buffer + text;
    const parts = combined.split(/\r?\n/);
    const rest = parts.pop() || '';
    for (const line of parts) {
        const trimmed = line.trim();
        if (trimmed) onLine(trimmed);
    }
    return rest;
}

function spawnAutomation(args, envExtra = {}, { onLog } = {}) {
    const root = resolveAutomationRoot();
    const log = typeof onLog === 'function' ? onLog : null;
    const hangKillMs = Number(process.env.MMX_BUILDTO_HANG_KILL_MS || 20000);
    return new Promise((resolve) => {
        if (!fs.existsSync(path.join(root, 'package.json'))) {
            resolve({
                ok: false,
                code: 1,
                stdout: '',
                stderr: '',
                error: `Build-to automation not found at ${root}. Re-run installer or set MMX_REPORT_AUTOMATION_DIR.`,
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
        let outBuf = '';
        let errBuf = '';
        let settled = false;
        let hangTimer = null;

        const finish = (payload) => {
            if (settled) return;
            settled = true;
            if (hangTimer) clearTimeout(hangTimer);
            hangTimer = null;
            resolve(payload);
        };

        const armHangKill = (reason) => {
            if (hangTimer || settled) return;
            hangTimer = setTimeout(() => {
                if (settled) return;
                log?.(
                    `Automation hung after "${reason}" — stopping child so status can clear`
                );
                try {
                    child.kill('SIGTERM');
                } catch {
                    /* ignore */
                }
                setTimeout(() => {
                    try {
                        if (!settled) child.kill('SIGKILL');
                    } catch {
                        /* ignore */
                    }
                }, 2500);
                // Resolve as success when reports already finished — UI was stuck on Updating.
                finish({
                    ok: true,
                    code: 0,
                    stdout: stdout.slice(-12000),
                    stderr: stderr.slice(-12000),
                    error: null,
                    killedAfterComplete: true,
                });
            }, Math.max(5000, hangKillMs));
        };

        const noteStdout = (s) => {
            if (/Build-to reports update complete/i.test(s) || /Pipeline finished successfully/i.test(s)) {
                armHangKill('reports complete');
            }
        };

        child.stdout.on('data', (chunk) => {
            const s = chunk.toString();
            stdout += s;
            noteStdout(s);
            outBuf = emitLineChunks(outBuf, s, log);
        });
        child.stderr.on('data', (chunk) => {
            const s = chunk.toString();
            stderr += s;
            errBuf = emitLineChunks(errBuf, s, (line) => log?.(`[err] ${line}`));
        });
        child.on('close', (code) => {
            if (outBuf.trim()) log?.(outBuf.trim());
            if (errBuf.trim()) log?.(`[err] ${errBuf.trim()}`);
            const blob = `${stdout}\n${stderr}`;
            const recovered =
                code !== 0 &&
                /Build-to reports update complete/i.test(blob) &&
                (/Updated working template:/i.test(blob) ||
                    /Recalculated and saved:/i.test(blob) ||
                    /Mapped report1/i.test(blob));
            finish({
                ok: code === 0 || recovered,
                code: recovered ? 0 : code,
                stdout: stdout.slice(-12000),
                stderr: stderr.slice(-12000),
                error: code === 0 || recovered ? null : `automation exited with code ${code}`,
            });
        });
        child.on('error', (err) => {
            finish({
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
 * Run Build-to automation for a single store. Caller must register/clear runningByStore.
 */
async function runOneStore(store, mode, root, mmxEnv, onProgress) {
    const storeNumber = String(store.storeNumber || '').replace(/\D/g, '');
    const label = storeLabel(storeNumber, store.storeName);
    const progress = typeof onProgress === 'function' ? onProgress : () => {};

    if (mode === 'orders') {
        const prior = readState().stores[storeNumber] || {};
        if (!isBuildToFresh(prior.buildToUpdatedAt)) {
            const row = {
                storeNumber,
                storeName: store.storeName || '',
                ok: false,
                mode,
                error: 'Update Build-to first (reports must be refreshed today before placing orders).',
            };
            await markStore(storeNumber, { lastError: row.error, lastMode: mode });
            return row;
        }
    }

    let workbook;
    try {
        workbook = ensureStoreWorkbook(storeNumber);
        progress(`Store ${storeNumber}: workbook ${path.basename(workbook)}`);
    } catch (err) {
        const row = {
            storeNumber,
            storeName: store.storeName || '',
            ok: false,
            mode,
            error: err.message || String(err),
        };
        await markStore(storeNumber, { lastError: row.error, lastMode: mode });
        return row;
    }

    // Always skip key-item gate — Update Build-to is reports-only.
    const args =
        mode === 'orders'
            ? [path.join(root, 'src', 'run.js'), '--orders-only', '--skip-gate', '--force']
            : [path.join(root, 'src', 'run.js'), '--dry-run', '--skip-gate', '--force'];
    progress(
        mode === 'orders'
            ? `Store ${storeNumber}: placing MMX orders…`
            : `Store ${storeNumber}: downloading SOH / SOO / ISE into Build-to…`
    );

    const result = await enqueueMmxBuild(storeNumber, progress, () =>
        spawnAutomation(
            args,
            {
                ...mmxEnv,
                MMX_TEMPLATE_LOCAL: workbook,
                BUILD_TO_WORKBOOK: workbook,
                MMX_TEMPLATE_ALWAYS_COPY: 'false',
                MMX_PDF_EXPORT_ENABLED: 'false',
                MMX_EMAIL_ENABLED: 'false',
                MMX_SKIP_GATE: '1',
                MMX_STORE_NAME: label,
                MMX_LABOUR_STORES: label,
                MMX_BUILDTO_WORKBOOK_PASSWORD:
                    process.env.MMX_BUILDTO_WORKBOOK_PASSWORD || '123456',
                MMX_REPORTS_CONCURRENT: process.env.MMX_REPORTS_CONCURRENT || '0',
                MMX_KEEP_BROWSER_OPEN: process.env.MMX_KEEP_BROWSER_OPEN || '0',
                // Persist SOH/SOO/ISE for shortfall checks (vendors/reports/{store}/).
                MMX_ARCHIVE_REPORTS_DIR: paths.vendors.reports,
                MMX_ARCHIVE_STORE_NUMBER: String(storeNumber),
            },
            {
                onLog: (line) => progress(`Store ${storeNumber}: ${line}`),
            }
        )
    );
    // Reports dry-run sometimes closed the browser then still hit scheduled-orders → exit 1
    // even though SOH/SOO/ISE were already merged. Treat that as success.
    const recovered = !result.ok && mode !== 'orders' && reportsUpdateSucceeded(result);
    const ok = Boolean(result.ok || recovered);
    if (recovered) {
        progress(
            `Store ${storeNumber}: reports merged successfully (ignored late browser teardown error)`
        );
    }
    const error = ok ? null : extractAutomationError(result);
    const row = {
        storeNumber,
        storeName: store.storeName || '',
        ok,
        mode,
        workbook,
        error,
        stdout: result.stdout,
        stderr: result.stderr,
    };
    if (ok) {
        await markStore(storeNumber, {
            lastError: null,
            lastMode: mode,
            workbookPath: workbook,
            ...(mode === 'orders'
                ? { mmxOrdersUpdatedAt: new Date().toISOString() }
                : { buildToUpdatedAt: new Date().toISOString() }),
        });
    } else {
        await markStore(storeNumber, {
            lastError: error || 'failed',
            lastMode: mode,
            workbookPath: workbook,
        });
    }
    return row;
}

/**
 * mode:
 *  - reports (default): download On Hand + On Order + ISE into `{store} - Build To.xlsx` (--skip-gate, no key-item check)
 *  - orders: enter vendor orders in MMX from that store workbook (requires Build-to updated today)
 *
 * Multiple stores (and multiple API calls) run concurrently. The same store cannot run twice at once.
 */
async function runExcelBuildTo(options = {}) {
    const mode = String(options.mode || 'reports').toLowerCase() === 'orders' ? 'orders' : 'reports';
    const root = resolveAutomationRoot();
    const startedAt = new Date().toISOString();

    if (!fs.existsSync(path.join(root, 'package.json'))) {
        return {
            ok: false,
            error: `Build-to automation not found at ${root}. Re-run the installer (npm run buildto:install) or set MMX_REPORT_AUTOMATION_DIR.`,
            automationDir: root,
        };
    }

    const stores = Array.isArray(options.stores) && options.stores.length
        ? options.stores
        : options.store
          ? [{ storeNumber: options.store, storeName: '' }]
          : [];

    if (!stores.length) {
        return { ok: false, error: 'No stores selected for Build-to.', mode };
    }

    const mmxEnv = coachMmxEnv();
    const claimed = [];
    const skipped = [];
    const toRun = [];

    for (const store of stores) {
        const storeNumber = String(store.storeNumber || '').replace(/\D/g, '');
        if (!storeNumber) continue;
        if (runningByStore.has(storeNumber)) {
            skipped.push({
                storeNumber,
                storeName: store.storeName || '',
                ok: false,
                mode,
                skipped: true,
                error: `Build-to already running for store ${storeNumber}.`,
            });
            continue;
        }
        runningByStore.set(storeNumber, { mode, startedAt });
        claimed.push(storeNumber);
        toRun.push({ ...store, storeNumber });
    }

    if (!toRun.length) {
        return {
            ok: false,
            mode,
            startedAt,
            finishedAt: new Date().toISOString(),
            automationDir: root,
            stores: skipped,
            runningStores: listRunning(),
            error: skipped[0]?.error || 'All selected stores are already running.',
        };
    }

    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;

    try {
        const settled = await Promise.all(
            toRun.map((store) =>
                runOneStore(store, mode, root, mmxEnv, (message) => {
                    onProgress?.(message, String(store.storeNumber));
                })
            )
        );
        const perStore = [...settled, ...skipped];
        const ok = settled.every((r) => r.ok) && skipped.length === 0;
        const finishedAt = new Date().toISOString();
        const doc = {
            ok,
            mode,
            startedAt,
            finishedAt,
            automationDir: root,
            stores: perStore,
            runningStores: listRunning().filter((r) => !claimed.includes(r.storeNumber)),
            stdout: settled
                .map((r) => `=== ${r.storeNumber} ===\n${r.stdout || ''}`)
                .join('\n')
                .slice(-12000),
            stderr: settled
                .map((r) => r.stderr || '')
                .join('\n')
                .slice(-8000),
            error: ok
                ? null
                : perStore.find((r) => !r.ok)?.error || 'One or more stores failed',
        };
        await maybeSendWarnEmails(doc);
        await appendRunHistory(doc);
        return doc;
    } finally {
        for (const storeNumber of claimed) {
            runningByStore.delete(storeNumber);
        }
    }
}

function isRunning(storeNumber) {
    if (storeNumber != null && String(storeNumber).trim() !== '') {
        return isStoreRunning(storeNumber);
    }
    return runningByStore.size > 0;
}

module.exports = {
    getStatus,
    runExcelBuildTo,
    openWorkbook,
    workbookPath,
    isRunning,
    isStoreRunning,
    listRunning,
    automationRoot,
    isBuiltinAutomation,
    builtinAutomationDir,
    ensureWorkbook,
    ensureStoreWorkbook,
    resolveStoreWorkbookPath,
    storeWorkbookFilename,
    isBuildToFresh,
    listStoreStatuses,
    resolveDownloadsDir,
    downloadsMasterPath,
    get DOWNLOADS_MASTER() {
        return downloadsMasterPath();
    },
};
