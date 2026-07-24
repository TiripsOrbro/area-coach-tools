/**
 * Manual "Check current levels" for Area Coach Tools.
 * Prefers the full pipeline from live-dashboard-app when present on disk;
 * otherwise downloads On Hand (+ On Order) via mmx-report-automation and records the run.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const paths = require('../../../src/paths');
const { setLastRun, getLastRunAt } = require('./fiveAmReportsStore');
const { getStoreList } = require('../../../stores/src/storeList');

async function maybeEmailShortfalls(store, withOnOrder, onProgress) {
    try {
        const { sendShortfallEmail } = require('./shortfallEmail');
        const emailed = await sendShortfallEmail(store, withOnOrder);
        if (emailed?.skipped) {
            onProgress?.(
                `Store ${store}: shortfall email skipped (${emailed.reason || 'n/a'})`
            );
            return emailed;
        }
        if (emailed?.ok) {
            onProgress?.(
                `Store ${store}: shortfall email sent to ${emailed.to} (${emailed.count} item(s))`
            );
            return emailed;
        }
        onProgress?.(
            `Store ${store}: shortfall email failed — ${emailed?.error || 'unknown'}`
        );
        return emailed;
    } catch (err) {
        onProgress?.(
            `Store ${store}: shortfall email failed — ${err.message || err}`
        );
        return { ok: false, error: err.message || String(err) };
    }
}

function writeStoreResultSafe(dateKey, storeNumber, payload) {
    try {
        const { writeStoreResult } = require('./fiveAmReportsResults');
        const normalize = (summary) => {
            if (!summary || typeof summary !== 'object') return summary;
            const alerts = Array.isArray(summary.alerts)
                ? summary.alerts
                : Array.isArray(summary.items)
                  ? summary.items
                  : [];
            return {
                ...summary,
                alerts,
                items: alerts,
                count: Number(summary.count) || alerts.length,
            };
        };
        writeStoreResult(dateKey, storeNumber, {
            ...payload,
            withOnOrder: normalize(payload?.withOnOrder),
            onHandOnly: normalize(payload?.onHandOnly),
        });
    } catch (err) {
        console.warn('[stock-levels] Could not persist result:', err.message || err);
    }
}

function melbourneDateKey() {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: process.env.DASHBOARD_TIME_ZONE || 'Australia/Melbourne',
    }).format(new Date());
}

function stockPipelineCandidates() {
    return [
        path.join('Y:', 'Taco Bell Dashboard', 'live-dashboard-app', 'vendors', 'src', 'stockCountMmxPipeline.js'),
        path.join(paths.root, '..', 'live-dashboard-app', 'vendors', 'src', 'stockCountMmxPipeline.js'),
    ];
}

function loadStockPipeline() {
    for (const file of stockPipelineCandidates()) {
        if (!fs.existsSync(file)) continue;
        try {
            return require(file);
        } catch (err) {
            console.warn('[stock-levels] Could not load', file, err.message);
        }
    }
    return null;
}

function loadLowStockHelpers() {
    const candidates = [
        path.join(paths.root, 'vendors', 'src', 'lowStockAlerts.js'),
        path.join('Y:', 'Taco Bell Dashboard', 'live-dashboard-app', 'vendors', 'src', 'lowStockAlerts.js'),
        path.join(paths.root, '..', 'live-dashboard-app', 'vendors', 'src', 'lowStockAlerts.js'),
    ];
    for (const file of candidates) {
        if (!fs.existsSync(file)) continue;
        try {
            return require(file);
        } catch {
            /* continue */
        }
    }
    return null;
}

function resolveAutomationRoot() {
    try {
        const { automationRoot } = require('../../../src/buildToExcel');
        return automationRoot();
    } catch {
        return process.env.MMX_REPORT_AUTOMATION_DIR || '';
    }
}

/** Coach-session MMX login (Ash/Tom), used when live-dashboard store-logins can't decrypt. */
function coachMmxCredentials() {
    try {
        const { readSession } = require('../../../stores/src/coachSession');
        const session = readSession();
        const username = String(session.mmx?.username || '').trim();
        const password = String(session.mmx?.password || '');
        if (!username || !password) return null;
        return { username, password, source: 'coach-session' };
    } catch {
        return null;
    }
}

/** ACT credential resolution (coach-session first, then per-store file). */
function mmxCredentialsForStore(storeNumber) {
    try {
        const { listCredentialCandidates } = require('../../../stores/src/storeCredentials');
        const picked = listCredentialCandidates(storeNumber, 'mmx')[0];
        if (picked?.username && picked?.password) {
            return {
                username: picked.username,
                password: picked.password,
                source: picked.source || 'store-logins',
            };
        }
    } catch {
        /* ignore */
    }
    return coachMmxCredentials();
}

function coachMmxEnv() {
    const creds = coachMmxCredentials();
    if (!creds) return {};
    return { SCRAPER_USERNAME: creds.username, SCRAPER_PASSWORD: creds.password };
}

function storeLabel(storeNumber) {
    const row = getStoreList().find((s) => String(s.storeNumber) === String(storeNumber));
    const name = row?.storeName || '';
    return name ? `${storeNumber} ${name}` : String(storeNumber);
}

function makeProgress(onProgress) {
    return (message) => {
        const text = String(message || '').trim();
        if (!text) return;
        console.log(`[stock-levels] ${text}`);
        try {
            onProgress?.(text);
        } catch {
            /* ignore UI errors */
        }
    };
}

function spawnNode(cwd, args, envExtra = {}, onLine) {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, args, {
            cwd,
            env: { ...process.env, ...envExtra },
            windowsHide: true,
        });
        let stdout = '';
        let stderr = '';
        let outBuf = '';
        let errBuf = '';
        const flushLines = (chunk, which) => {
            const text = chunk.toString();
            if (which === 'out') stdout += text;
            else stderr += text;
            let buf = which === 'out' ? outBuf + text : errBuf + text;
            const parts = buf.split(/\r?\n/);
            if (which === 'out') outBuf = parts.pop() || '';
            else errBuf = parts.pop() || '';
            for (const line of parts) {
                const cleaned = line.replace(/\x1b\[[0-9;]*m/g, '').trim();
                if (cleaned) onLine?.(cleaned);
            }
        };
        child.stdout.on('data', (c) => flushLines(c, 'out'));
        child.stderr.on('data', (c) => flushLines(c, 'err'));
        child.on('close', (code) => {
            if (outBuf.trim()) onLine?.(outBuf.trim());
            if (errBuf.trim()) onLine?.(errBuf.trim());
            resolve({ ok: code === 0, code, stdout: stdout.slice(-6000), stderr: stderr.slice(-4000) });
        });
        child.on('error', (err) => {
            resolve({ ok: false, code: 1, stdout, stderr, error: err.message });
        });
    });
}

async function checkViaAutomation(storeNumber, { inventoryEventOnly = false, onProgress } = {}) {
    const progress = makeProgress(onProgress);
    const root = resolveAutomationRoot();
    if (!root || !fs.existsSync(path.join(root, 'package.json'))) {
        throw new Error(
            'Stock levels check needs the built-in Build-to package (mmx-report-automation). Run npm run buildto:install.'
        );
    }
    const label = storeLabel(storeNumber);
    const mmxEnv = coachMmxEnv();
    const modeLabel = inventoryEventOnly ? 'Inventory Special Event only' : 'On Hand / On Order / ISE';
    progress(`Store ${storeNumber}: ${modeLabel} via mmx-report-automation...`);
    const args = inventoryEventOnly
        ? [path.join(root, 'src', 'run.js'), '--download-inventory-event', '--skip-gate', '--force']
        : [path.join(root, 'src', 'run.js'), '--dry-run', '--skip-gate', '--force'];
    const result = await spawnNode(
        root,
        args,
        {
            ...mmxEnv,
            MMX_STORE_NAME: label,
            MMX_LABOUR_STORES: label,
            MMX_PDF_EXPORT_ENABLED: 'false',
            MMX_EMAIL_ENABLED: 'false',
            MMX_ARCHIVE_REPORTS_DIR: paths.vendors.reports,
            MMX_ARCHIVE_STORE_NUMBER: String(storeNumber),
        },
        (line) => progress(`${storeNumber}: ${line}`)
    );
    if (!result.ok) {
        throw new Error(result.error || result.stderr?.slice(-500) || `automation exit ${result.code}`);
    }
    return {
        mode: inventoryEventOnly ? 'automation-ise' : 'automation-download',
        storeNumber: String(storeNumber),
        ...result,
    };
}

function resolveStoreIsePath(storeNumber) {
    try {
        const { resolveStoreReports } = require('../../../vendors/src/reportReader');
        const files = resolveStoreReports(storeNumber, paths.vendors.reports);
        return files.inventorySpecialEvent || null;
    } catch {
        return null;
    }
}

/** Force-download Inventory Special Event into vendors/reports/{store}/ (required by build-to calc). */
async function ensureInventorySpecialEvent(storeNumber, credentials, onProgress) {
    const store = String(storeNumber || '').trim();
    const progress = makeProgress(onProgress);
    const existing = resolveStoreIsePath(store);
    if (existing && fs.existsSync(existing)) {
        try {
            const { reportDateKeyFromFilename } = require('../../../vendors/src/reportReader');
            const day = reportDateKeyFromFilename(existing);
            if (day === melbourneDateKey()) {
                progress(`Store ${store}: ISE already present (${path.basename(existing)})`);
                return { ok: true, skipped: true, path: existing };
            }
            progress(`Store ${store}: ISE is stale (${day}) - re-downloading`);
        } catch {
            progress(`Store ${store}: ISE already present (${path.basename(existing)})`);
            return { ok: true, skipped: true, path: existing };
        }
    } else {
        progress(`Store ${store}: ISE missing - downloading Inventory Special Event...`);
    }

    try {
        progress(`Store ${store}: MMX downloader report3 (ISE)...`);
        const downloader = require('../../../mmx/src/mmxReportDownloader');
        const opts = {
            storeNumbers: [store],
            onlyReportIds: ['report3'],
            parallelReportDownload: false,
        };
        if (credentials?.username && credentials?.password) {
            opts.credentials = credentials;
        }
        await downloader.downloadReportsForStores(opts);
        const after = resolveStoreIsePath(store);
        if (after && fs.existsSync(after)) {
            progress(`Store ${store}: ISE ready (${path.basename(after)})`);
            return { ok: true, path: after, mode: 'mmx-downloader' };
        }
        progress(`Store ${store}: MMX downloader finished but ISE file not found - trying automation`);
    } catch (err) {
        progress(`Store ${store}: ACT ISE download failed (${err.message || err}) - trying automation`);
    }

    await checkViaAutomation(store, { inventoryEventOnly: true, onProgress });
    const afterAuto = resolveStoreIsePath(store);
    if (afterAuto && fs.existsSync(afterAuto)) {
        progress(`Store ${store}: ISE ready via automation (${path.basename(afterAuto)})`);
        return { ok: true, path: afterAuto, mode: 'automation-ise' };
    }
    throw new Error(`Store ${store}: missing inventory-special-event after download attempt`);
}

async function runFullPipelineCheck(store, { force, mmxOpts, helpers, pipeline, onProgress }) {
    const progress = makeProgress(onProgress);
    let reuseReports = false;
    try {
        const { reportsReadyForStore } = require('../../../vendors/src/reportReader');
        const status = reportsReadyForStore(store, paths.vendors.reports);
        reuseReports = Boolean(status?.ready);
        if (reuseReports) {
            progress(
                `Store ${store}: reusing today's SOH / SOO / ISE already on disk (Build-to or prior check)`
            );
        }
    } catch {
        reuseReports = false;
    }

    progress(
        reuseReports
            ? `Store ${store}: calculating shortfalls from existing reports…`
            : `Store ${store}: running stock-level pipeline (SOH/SOO + calc)...`
    );
    const withOnOrder = await pipeline.checkStockLevelsForStore(store, {
        onHandOnly: false,
        forceDownload: Boolean(force) && !reuseReports,
        // Don't force a fresh SOH download when today's triad is already valid.
        forceReportIds: reuseReports ? [] : ['report1'],
        reuseExistingReports: reuseReports,
        ...mmxOpts,
    });
    progress(
        `Store ${store}: with on-order - ${Number(withOnOrder?.count) || 0} shortfall(s)`
    );
    let onHandOnly = withOnOrder;
    if (typeof helpers.getLowStockSummary === 'function') {
        progress(`Store ${store}: computing on-hand-only summary...`);
        onHandOnly = await helpers.getLowStockSummary(store, { onHandOnly: true });
    } else if (typeof pipeline.checkStockLevelsForStore === 'function') {
        progress(`Store ${store}: re-check on-hand-only...`);
        onHandOnly = await pipeline.checkStockLevelsForStore(store, {
            onHandOnly: true,
            forceDownload: false,
            forceReportIds: [],
            reuseExistingReports: true,
            ...mmxOpts,
        });
    }
    progress(
        `Store ${store}: on-hand-only - ${Number(onHandOnly?.count) || 0} shortfall(s)`
    );
    return { withOnOrder, onHandOnly };
}

/** Serialize MMX browser work — concurrent Checks were crashing Puppeteer ("Failed to launch the browser process"). */
let mmxCheckQueue = Promise.resolve();
let mmxCheckActive = null;

function enqueueMmxCheck(storeNumber, onProgress, work) {
    const progress = makeProgress(onProgress);
    const store = String(storeNumber);
    const run = mmxCheckQueue.then(async () => {
        if (mmxCheckActive) {
            progress(`Store ${store}: queued — waiting for store ${mmxCheckActive} to finish MMX…`);
        }
        mmxCheckActive = store;
        progress(`Store ${store}: MMX browser slot acquired`);
        try {
            return await work();
        } finally {
            if (mmxCheckActive === store) mmxCheckActive = null;
        }
    });
    mmxCheckQueue = run.then(
        () => undefined,
        () => undefined
    );
    return run;
}

async function checkCurrentLevelsForStore(storeNumber, { force = false, onProgress } = {}) {
    const store = String(storeNumber || '').trim();
    if (!store) throw new Error('storeNumber required');

    // When today's SOH/SOO/ISE are already on disk (e.g. from Build-to), skip the MMX queue.
    if (!force) {
        try {
            const { reportsReadyForStore } = require('../../../vendors/src/reportReader');
            if (reportsReadyForStore(store, paths.vendors.reports)?.ready) {
                return checkCurrentLevelsForStoreWork(store, { force: false, onProgress });
            }
        } catch {
            /* fall through to queued MMX path */
        }
    }

    return enqueueMmxCheck(store, onProgress, () =>
        checkCurrentLevelsForStoreWork(store, { force, onProgress })
    );
}

async function checkCurrentLevelsForStoreWork(store, { force = true, onProgress } = {}) {
    const progress = makeProgress(onProgress);

    const pipeline = loadStockPipeline();
    const helpers = loadLowStockHelpers();
    const today = melbourneDateKey();
    // Pass ACT/coach MMX creds - live-dashboard's store-logins often can't decrypt ACT files.
    const credentials = mmxCredentialsForStore(store);
    const mmxOpts = credentials ? { credentials } : {};

    progress(
        `Store ${store}: start check (${credentials ? `login via ${credentials.source}` : 'no MMX credentials'})`
    );

    if (pipeline && typeof pipeline.checkStockLevelsForStore === 'function' && helpers) {
        try {
            let reportsReady = false;
            try {
                const { reportsReadyForStore } = require('../../../vendors/src/reportReader');
                reportsReady = Boolean(reportsReadyForStore(store, paths.vendors.reports)?.ready);
            } catch {
                reportsReady = false;
            }
            // Pre-flight ISE download only when we don't already have today's triad.
            if (!reportsReady || force) {
                await ensureInventorySpecialEvent(store, credentials, onProgress);
            } else {
                progress(`Store ${store}: skipping MMX download — using existing Build-to / report files`);
            }
            const result = await runFullPipelineCheck(store, {
                force,
                mmxOpts,
                helpers,
                pipeline,
                onProgress,
            });
            writeStoreResultSafe(today, store, {
                withOnOrder: result.withOnOrder || null,
                onHandOnly: result.onHandOnly || null,
            });
            setLastRun(store, new Date());
            progress(`Store ${store}: check complete (full pipeline)`);
            const emailed = await maybeEmailShortfalls(store, result.withOnOrder, progress);
            return {
                ok: true,
                storeNumber: store,
                mode: 'full-pipeline',
                checkedAt: new Date().toISOString(),
                withOnOrderCount: Number(result.withOnOrder?.count) || 0,
                onHandOnlyCount: Number(result.onHandOnly?.count) || 0,
                lastStockRun: getLastRunAt(store),
                emailedAt: emailed?.at || null,
                email: emailed || null,
            };
        } catch (err) {
            const msg = String(err?.message || err);
            const missingIse = /missing inventory-special-event/i.test(msg);
            const noLogin = /No Macromatix login/i.test(msg);
            const browserLaunchFail = /Failed to launch the browser process/i.test(msg);
            progress(`Store ${store}: pipeline error - ${msg}`);
            if (missingIse || browserLaunchFail) {
                try {
                    progress(
                        `Store ${store}: retrying${browserLaunchFail ? ' after browser launch failure' : ' after forcing ISE download'}...`
                    );
                    // Brief pause so Chromium/locks can settle after a failed launch.
                    if (browserLaunchFail) {
                        await new Promise((r) => setTimeout(r, 2500));
                    }
                    await ensureInventorySpecialEvent(store, credentials, onProgress);
                    const result = await runFullPipelineCheck(store, {
                        force: false,
                        mmxOpts,
                        helpers,
                        pipeline,
                        onProgress,
                    });
                    writeStoreResultSafe(today, store, {
                        withOnOrder: result.withOnOrder || null,
                        onHandOnly: result.onHandOnly || null,
                    });
                    setLastRun(store, new Date());
                    progress(`Store ${store}: check complete after retry`);
                    const emailed = await maybeEmailShortfalls(store, result.withOnOrder, progress);
                    return {
                        ok: true,
                        storeNumber: store,
                        mode: 'full-pipeline',
                        checkedAt: new Date().toISOString(),
                        withOnOrderCount: Number(result.withOnOrder?.count) || 0,
                        onHandOnlyCount: Number(result.onHandOnly?.count) || 0,
                        lastStockRun: getLastRunAt(store),
                        emailedAt: emailed?.at || null,
                        email: emailed || null,
                        note: browserLaunchFail
                            ? 'Retried after browser launch failure.'
                            : 'Retried after downloading Inventory Special Event.',
                    };
                } catch (retryErr) {
                    progress(
                        `Store ${store}: retry failed (${retryErr.message || retryErr}) - falling back to automation`
                    );
                }
            } else if (!noLogin || !credentials) {
                throw err;
            } else {
                progress(`Store ${store}: login failed - falling back to automation`);
            }
        }
    } else {
        progress(
            `Store ${store}: live-dashboard pipeline not available - using automation download`
        );
    }

    const fallback = await checkViaAutomation(store, { onProgress });
    writeStoreResultSafe(today, store, {
        withOnOrder: { checked: true, checkedAt: new Date().toISOString(), source: 'automation' },
        onHandOnly: { checked: true, checkedAt: new Date().toISOString(), source: 'automation' },
    });
    setLastRun(store, new Date());
    progress(`Store ${store}: automation download finished`);
    return {
        ok: true,
        storeNumber: store,
        mode: fallback.mode,
        checkedAt: new Date().toISOString(),
        lastStockRun: getLastRunAt(store),
        note: 'Downloaded current On Hand / On Order / ISE reports via mmx-report-automation.',
    };
}

async function checkCurrentLevelsForStores(storeNumbers, { onProgress } = {}) {
    const progress = makeProgress(onProgress);
    const list = (storeNumbers || []).map(String);
    const results = [];
    progress(`Checking current levels for ${list.length} store(s)...`);
    for (let i = 0; i < list.length; i++) {
        const store = list[i];
        progress(`--- Store ${store} (${i + 1}/${list.length}) ---`);
        try {
            results.push(await checkCurrentLevelsForStore(store, { onProgress }));
        } catch (err) {
            const error = err.message || String(err);
            progress(`Store ${store}: FAILED - ${error}`);
            results.push({
                ok: false,
                storeNumber: String(store),
                error,
            });
        }
    }
    const okCount = results.filter((r) => r.ok).length;
    const failCount = results.length - okCount;
    progress(
        failCount
            ? `Done. ${okCount} ok, ${failCount} failed.`
            : `Done. Checked ${okCount} store(s).`
    );
    return results;
}

module.exports = {
    checkCurrentLevelsForStore,
    checkCurrentLevelsForStores,
    melbourneDateKey,
};
