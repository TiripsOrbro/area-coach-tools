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
const { writeStoreResult } = require('./fiveAmReportsResults');
const { getStoreList } = require('../../../stores/src/storeList');

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

function coachMmxEnv() {
    try {
        const { readSession } = require('../../../stores/src/coachSession');
        const session = readSession();
        const username = String(session.mmx?.username || '').trim();
        const password = String(session.mmx?.password || '');
        if (!username || !password) return {};
        return { SCRAPER_USERNAME: username, SCRAPER_PASSWORD: password };
    } catch {
        return {};
    }
}

function storeLabel(storeNumber) {
    const row = getStoreList().find((s) => String(s.storeNumber) === String(storeNumber));
    const name = row?.storeName || '';
    return name ? `${storeNumber} ${name}` : String(storeNumber);
}

function spawnNode(cwd, args, envExtra = {}) {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, args, {
            cwd,
            env: { ...process.env, ...envExtra },
            windowsHide: true,
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (c) => {
            stdout += c.toString();
        });
        child.stderr.on('data', (c) => {
            stderr += c.toString();
        });
        child.on('close', (code) => {
            resolve({ ok: code === 0, code, stdout: stdout.slice(-6000), stderr: stderr.slice(-4000) });
        });
        child.on('error', (err) => {
            resolve({ ok: false, code: 1, stdout, stderr, error: err.message });
        });
    });
}

async function checkViaAutomation(storeNumber) {
    const root = resolveAutomationRoot();
    if (!root || !fs.existsSync(path.join(root, 'package.json'))) {
        throw new Error(
            'Stock levels check needs live-dashboard-app vendors pipeline or mmx-report-automation. Set MMX_REPORT_AUTOMATION_DIR.'
        );
    }
    const label = storeLabel(storeNumber);
    const mmxEnv = coachMmxEnv();
    // Download On Hand + On Order + ISE (same reports as daily stock check inputs)
    const result = await spawnNode(
        root,
        [path.join(root, 'src', 'run.js'), '--dry-run', '--skip-gate', '--force'],
        {
            ...mmxEnv,
            MMX_STORE_NAME: label,
            MMX_LABOUR_STORES: label,
            MMX_PDF_EXPORT_ENABLED: 'false',
            MMX_EMAIL_ENABLED: 'false',
        }
    );
    if (!result.ok) {
        throw new Error(result.error || result.stderr?.slice(-500) || `automation exit ${result.code}`);
    }
    return { mode: 'automation-download', storeNumber: String(storeNumber), ...result };
}

async function checkCurrentLevelsForStore(storeNumber, { force = true } = {}) {
    const store = String(storeNumber || '').trim();
    if (!store) throw new Error('storeNumber required');

    const pipeline = loadStockPipeline();
    const helpers = loadLowStockHelpers();
    const today = melbourneDateKey();

    if (pipeline && typeof pipeline.checkStockLevelsForStore === 'function' && helpers) {
        const withOnOrder = await pipeline.checkStockLevelsForStore(store, { onHandOnly: false, force });
        let onHandOnly = withOnOrder;
        if (typeof helpers.getLowStockSummary === 'function') {
            onHandOnly = await helpers.getLowStockSummary(store, { onHandOnly: true });
        } else if (typeof pipeline.checkStockLevelsForStore === 'function') {
            onHandOnly = await pipeline.checkStockLevelsForStore(store, { onHandOnly: true, force: false });
        }
        writeStoreResult(today, store, {
            withOnOrder: withOnOrder || null,
            onHandOnly: onHandOnly || null,
        });
        setLastRun(store, new Date());
        return {
            ok: true,
            storeNumber: store,
            mode: 'full-pipeline',
            checkedAt: new Date().toISOString(),
            withOnOrderCount: Number(withOnOrder?.count) || 0,
            onHandOnlyCount: Number(onHandOnly?.count) || 0,
            lastStockRun: getLastRunAt(store),
        };
    }

    const fallback = await checkViaAutomation(store);
    writeStoreResult(today, store, {
        withOnOrder: { checked: true, checkedAt: new Date().toISOString(), source: 'automation' },
        onHandOnly: { checked: true, checkedAt: new Date().toISOString(), source: 'automation' },
    });
    setLastRun(store, new Date());
    return {
        ok: true,
        storeNumber: store,
        mode: fallback.mode,
        checkedAt: new Date().toISOString(),
        lastStockRun: getLastRunAt(store),
        note: 'Downloaded current On Hand / On Order reports via mmx-report-automation.',
    };
}

async function checkCurrentLevelsForStores(storeNumbers) {
    const results = [];
    for (const store of storeNumbers || []) {
        try {
            results.push(await checkCurrentLevelsForStore(store));
        } catch (err) {
            results.push({
                ok: false,
                storeNumber: String(store),
                error: err.message || String(err),
            });
        }
    }
    return results;
}

module.exports = {
    checkCurrentLevelsForStore,
    checkCurrentLevelsForStores,
    melbourneDateKey,
};
