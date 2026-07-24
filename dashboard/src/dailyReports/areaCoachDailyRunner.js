/**
 * Area Coach Tools daily reports pipeline (per store, sequential jobs):
 *   1. Build-to update (reports)
 *   2. Forecast auto-submit
 *   3. Prep Guide regenerate (+ email when configured)
 *   4. Stock level warnings
 *   5. Orders placed (only after Build-to is fresh today)
 */
const fiveAm = require('../fiveAmReports/fiveAmReportsStore');
const { checkCurrentLevelsForStores } = require('../fiveAmReports/checkStockLevels');
const forecastConfig = require('../../../forecast/src/forecastConfig');
const forecastRunner = require('../../../forecast/src/forecastRunner');
const prepGuides = require('../prepGuides/prepGuides');
const buildToExcel = require('../../../src/buildToExcel');
const {
    melbourneDateKey,
    hasCompletedDailyRun,
    markDailyRunComplete,
    TIME_ZONE,
} = require('./dailyReportsRunState');

const JOB_ORDER = ['buildTo', 'forecast', 'prepGuide', 'stock', 'orders'];

function scheduleHour() {
    const h = Number(process.env.DAILY_REPORTS_HOUR ?? process.env.FIVE_AM_REPORTS_HOUR ?? 7);
    return Number.isFinite(h) && h >= 0 && h <= 23 ? Math.floor(h) : 7;
}

function localHourMelbourne(now = new Date()) {
    const parts = new Intl.DateTimeFormat('en-AU', {
        timeZone: TIME_ZONE,
        hour: 'numeric',
        hour12: false,
    }).formatToParts(now);
    return Number(parts.find((p) => p.type === 'hour')?.value || 0);
}

function melbourneWeekdayName(now = new Date()) {
    return new Intl.DateTimeFormat('en-US', {
        timeZone: TIME_ZONE,
        weekday: 'long',
    }).format(now);
}

function jobsForStore(storeNumber) {
    const store = String(storeNumber || '').replace(/\D/g, '');
    const flags = fiveAm.getStoreJobFlags(store);
    return {
        storeNumber: store,
        buildTo: Boolean(flags.buildToEnabled),
        forecast: Boolean(forecastConfig.isAutoSubmitEnabled(store)),
        prepGuide: Boolean(flags.prepGuideEnabled),
        stock: Boolean(flags.stockEnabled),
        orders: Boolean(flags.ordersEnabled),
    };
}

function anyJobEnabled(jobs) {
    return JOB_ORDER.some((k) => jobs[k]);
}

function storeLabel(store) {
    return {
        storeNumber: String(store.storeNumber || '').replace(/\D/g, ''),
        storeName: store.storeName || '',
    };
}

async function runBuildToStep(store, mode, onProgress) {
    const row = storeLabel(store);
    const result = await buildToExcel.runExcelBuildTo({
        mode,
        stores: [row],
        onProgress,
    });
    const one = Array.isArray(result.stores) ? result.stores[0] : null;
    const ok = Boolean(result.ok && one?.ok);
    if (!ok) {
        throw new Error(one?.error || result.error || `Build-to ${mode} failed`);
    }
    return one || result;
}

async function runForecastStep(storeNumber, onProgress) {
    onProgress?.(`Store ${storeNumber}: submitting forecast…`);
    const status = await forecastRunner.runForecastForStore(storeNumber);
    const ok = status?.state === 'done' || status?.state === 'preview';
    if (!ok && status?.state === 'error') {
        throw new Error(status.message || 'Forecast failed');
    }
    return status;
}

async function runPrepGuideStep(storeNumber, onProgress) {
    onProgress?.(`Store ${storeNumber}: regenerating Prep Guide…`);
    await prepGuides.regenerateStore(storeNumber, { fetchMissing: true });
    const weekday = melbourneWeekdayName();
    onProgress?.(`Store ${storeNumber}: emailing Prep Guide (${weekday})…`);
    const emailed = await prepGuides.sendPrepGuideEmail(storeNumber, weekday);
    if (emailed?.skipped) {
        onProgress?.(
            `Store ${storeNumber}: Prep Guide ready (email skipped: ${emailed.reason || 'n/a'})`
        );
    } else if (emailed?.ok === false && emailed?.error) {
        // PDF built — email failure should not fail the whole daily job.
        onProgress?.(`Store ${storeNumber}: Prep Guide email failed — ${emailed.error}`);
    }
    return emailed;
}

async function runStockStep(storeNumber, onProgress) {
    onProgress?.(`Store ${storeNumber}: checking stock level warnings…`);
    const results = await checkCurrentLevelsForStores([storeNumber], { onProgress });
    const row = results[0];
    if (!row?.ok) throw new Error(row?.error || 'Stock levels check failed');
    return row;
}

async function runOrdersStep(store, onProgress) {
    const n = String(store.storeNumber || '').replace(/\D/g, '');
    const statuses = buildToExcel.listStoreStatuses([
        { storeNumber: n, storeName: store.storeName || '' },
    ]);
    const at = statuses[0]?.buildToUpdatedAt;
    if (!buildToExcel.isBuildToFresh(at)) {
        throw new Error('Orders skipped — Build-to not updated today (run Build-to first)');
    }
    onProgress?.(`Store ${n}: placing MMX orders…`);
    return runBuildToStep(store, 'orders', onProgress);
}

/**
 * Run enabled daily jobs for one store in the required order.
 */
async function runDailyJobsForStore(store, options = {}) {
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
    const row = storeLabel(store);
    const jobs = jobsForStore(row.storeNumber);
    const steps = [];
    const summary = {
        storeNumber: row.storeNumber,
        storeName: row.storeName,
        ok: true,
        steps,
        jobs,
    };

    if (!anyJobEnabled(jobs)) {
        summary.ok = true;
        summary.skipped = true;
        summary.error = 'No daily jobs enabled for this store';
        return summary;
    }

    const runStep = async (id, label, fn) => {
        if (!jobs[id]) return;
        onProgress(`Store ${row.storeNumber}: ${label}…`);
        try {
            const result = await fn();
            steps.push({ id, ok: true, result });
        } catch (err) {
            const error = err.message || String(err);
            steps.push({ id, ok: false, error });
            summary.ok = false;
            summary.error = summary.error || `${label}: ${error}`;
            // Orders must not run if Build-to failed in this pass.
            if (id === 'buildTo') jobs.orders = false;
            // Continue other independent jobs unless fatal.
            if (id === 'buildTo' || id === 'orders') {
                /* keep going for forecast/prep/stock when build-to fails, but block orders */
            }
        }
    };

    await runStep('buildTo', 'Updating Build-to', () => runBuildToStep(row, 'reports', onProgress));
    await runStep('forecast', 'Forecast', () => runForecastStep(row.storeNumber, onProgress));
    await runStep('prepGuide', 'Prep Guide', () => runPrepGuideStep(row.storeNumber, onProgress));
    await runStep('stock', 'Stock level warnings', () => runStockStep(row.storeNumber, onProgress));
    await runStep('orders', 'Orders placed', () => runOrdersStep(row, onProgress));

    if (!summary.error && !summary.ok) {
        summary.error = steps
            .filter((s) => !s.ok)
            .map((s) => `${s.id}: ${s.error}`)
            .join('; ');
    }
    return summary;
}

/**
 * Run daily jobs for many stores sequentially (MMX browser contention).
 */
async function runDailyJobsForStores(stores, options = {}) {
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
    const list = (Array.isArray(stores) ? stores : []).map(storeLabel).filter((s) => s.storeNumber);
    const results = [];
    for (const store of list) {
        onProgress(`Store ${store.storeNumber}: starting daily reports…`);
        const row = await runDailyJobsForStore(store, { onProgress });
        results.push(row);
        onProgress(
            `Store ${store.storeNumber}: ${row.ok ? 'daily reports complete' : `FAILED — ${row.error || 'error'}`}`
        );
    }
    return results;
}

let schedulerTimer = null;
let running = false;

function isOrchestratorEnabled() {
    return !/^(0|false|no|off)$/i.test(String(process.env.DAILY_REPORTS_ORCHESTRATOR_ENABLED ?? '1').trim());
}

async function maybeRunScheduledDailyReports(listStoresFn) {
    if (!isOrchestratorEnabled() || running) return null;
    const now = new Date();
    const dateKey = melbourneDateKey(now);
    if (hasCompletedDailyRun(dateKey)) return null;
    if (localHourMelbourne(now) !== scheduleHour()) return null;

    const stores = typeof listStoresFn === 'function' ? listStoresFn() : [];
    const targets = stores.filter((s) => anyJobEnabled(jobsForStore(s.storeNumber)));
    if (!targets.length) {
        markDailyRunComplete(dateKey, { skipped: true, reason: 'no-enabled-jobs' });
        return null;
    }

    running = true;
    console.info(
        `[DailyReports] Scheduled run ${dateKey} for ${targets.length} store(s) at hour ${scheduleHour()}`
    );
    try {
        const results = await runDailyJobsForStores(targets, {
            onProgress: (msg) => console.info(`[DailyReports] ${msg}`),
        });
        const summary = {
            dateKey,
            scheduled: true,
            results,
            failureCount: results.filter((r) => !r.ok && !r.skipped).length,
            completedAt: new Date().toISOString(),
        };
        markDailyRunComplete(dateKey, summary);
        return summary;
    } finally {
        running = false;
    }
}

function startDailyReportsScheduler(listStoresFn) {
    if (schedulerTimer) return;
    if (!isOrchestratorEnabled()) {
        console.info('[DailyReports] Orchestrator disabled (DAILY_REPORTS_ORCHESTRATOR_ENABLED=0)');
        return;
    }
    const pollMs = Math.max(60_000, Number(process.env.DAILY_REPORTS_POLL_MS || 300_000));
    console.info(
        `[DailyReports] Scheduler armed (Melbourne hour=${scheduleHour()}, poll=${Math.round(pollMs / 1000)}s)`
    );
    schedulerTimer = setInterval(() => {
        maybeRunScheduledDailyReports(listStoresFn).catch((err) => {
            console.warn('[DailyReports] Scheduled run failed:', err.message || err);
        });
    }, pollMs);
    if (typeof schedulerTimer.unref === 'function') schedulerTimer.unref();
}

module.exports = {
    JOB_ORDER,
    jobsForStore,
    anyJobEnabled,
    runDailyJobsForStore,
    runDailyJobsForStores,
    startDailyReportsScheduler,
    maybeRunScheduledDailyReports,
    scheduleHour,
};
