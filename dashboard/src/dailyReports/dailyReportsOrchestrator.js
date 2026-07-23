const { getStoreList } = require('../../../stores/src/storeList');
const { storeHasMmxCredentials } = require('../../../mmx/src/macromatixScraper');
const { listCredentialCandidates } = require('../../../stores/src/storeCredentials');
const { assessHistoryReadiness } = require('../forecast/forecastHistoryLedger');
const { runCombinedForecastNextThreeWeeksForStores } = require('../forecast/forecastRunner');
const { isStoreAutoSubmitEnabled } = require('../forecast/forecastStoreAutoSubmitLedger');
const { markScheduledRun } = require('../forecast/forecastSchedule');
const { isStoreEnabled: isStockDailyEnabled, setLastRun: setStockLastRun, getLastRun: getStockLastRun } = require('../fiveAmReports/fiveAmReportsStore');
const { writeStoreResult: writeStockResult, purgeOldReportFiles: purgeStockReportFiles } = require('../fiveAmReports/fiveAmReportsResults');
const {
    listEnabledSubscriptionsDue,
    markSubscriptionSent,
    melbourneTodayIso,
} = require('../reportSubscriptions/reportSubscriptionsStore');
const { sendSubscriptionReport, reportTypeLabel } = require('../reportSubscriptions/reportRunner');
const { runWithPriority, PRIORITY } = require('../../../mmx/src/mmxTaskQueue');
const {
    melbourneDateKey,
    hasCompletedDailyRun,
    markDailyRunComplete,
    clearDailyRun,
    TIME_ZONE,
} = require('./dailyReportsRunState');
const {
    extractForecastFailureLines,
    sendFailedAutomatedReportsEmail,
} = require('./dailyReportsFailureEmail');
const { envConcurrency, mapWithConcurrency } = require('../../../src/shared/concurrency');

const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 5000;

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function scheduleHour() {
    const h = Number(process.env.FIVE_AM_REPORTS_HOUR ?? process.env.FORECAST_SCHEDULE_HOUR ?? 7);
    return Number.isFinite(h) && h >= 0 && h <= 23 ? Math.floor(h) : 7;
}

function localHourInTimeZone(now, timeZone) {
    const parts = new Intl.DateTimeFormat('en-AU', {
        timeZone,
        hour: 'numeric',
        hour12: false,
    }).formatToParts(now instanceof Date ? now : new Date(now));
    return Number(parts.find((p) => p.type === 'hour')?.value || 0);
}

function ymdInTimeZone(now, timeZone) {
    return new Intl.DateTimeFormat('en-CA', { timeZone }).format(now instanceof Date ? now : new Date(now));
}

function storeTimeZone(storeNumber, getStoreConfig) {
    const cfg = getStoreConfig?.(storeNumber) || {};
    return String(cfg.timeZone || TIME_ZONE).trim();
}

function isTestStore(storeNumber, isTestStoreFn) {
    return Boolean(isTestStoreFn?.(storeNumber));
}

async function runWithRetries(label, runFn) {
    let lastError = null;
    let lastDetails = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        try {
            const result = await runFn(attempt);
            return { ok: true, result, attempts: attempt };
        } catch (err) {
            lastError = err;
            if (err?.forecastLines) lastDetails = { forecastLines: err.forecastLines };
            console.warn(
                `[DailyReports] ${label} attempt ${attempt}/${MAX_ATTEMPTS} failed:`,
                err.message || String(err)
            );
            if (attempt < MAX_ATTEMPTS) await sleep(RETRY_DELAY_MS);
        }
    }
    return {
        ok: false,
        error: lastError?.message || String(lastError || 'failed'),
        details: lastDetails,
        attempts: MAX_ATTEMPTS,
    };
}

function serializeStockSummary(summary) {
    if (!summary) return null;
    return {
        count: Number(summary.count) || 0,
        items: Array.isArray(summary.items) ? summary.items : [],
        alerts: Array.isArray(summary.alerts) ? summary.alerts : summary.items || [],
        thresholdDays: summary.thresholdDays,
        onHandOnly: Boolean(summary.onHandOnly),
        checked: Boolean(summary.checked),
        checkedAt: summary.checkedAt || null,
    };
}

async function runStockJob(storeNumber, deps) {
    const store = String(storeNumber || '').trim();
    const timeZone = storeTimeZone(store, deps.getStoreConfig);
    const todayYmd = ymdInTimeZone(new Date(), timeZone);
    if (!deps.force && getStockLastRun(store, timeZone) === todayYmd) {
        return { skipped: true, reason: 'already-ran-today' };
    }

    const withOnOrder = await deps.checkStockLevelsForStore(store, { onHandOnly: false });
    const onHandOnly = await deps.getLowStockSummary(store, { onHandOnly: true });
    writeStockResult(todayYmd, store, {
        withOnOrder: serializeStockSummary(withOnOrder),
        onHandOnly: serializeStockSummary(onHandOnly),
    });
    setStockLastRun(store, new Date());
    try {
        purgeStockReportFiles(store, todayYmd);
    } catch {
        /* ignore cleanup errors */
    }
    console.info(`[DailyReports] Stock levels completed for store ${store}`);
    return { skipped: false, withOnOrder, onHandOnly, todayYmd };
}

function isForecastEligible(storeNumber) {
    const store = String(storeNumber || '').trim();
    if (!store || !storeHasMmxCredentials(store)) return false;
    if (!isStoreAutoSubmitEnabled(store)) return false;
    const readiness = assessHistoryReadiness(store);
    return Boolean(readiness.ready);
}

function lifelenzCredentialsForStore(storeNumber) {
    const store = String(storeNumber || '').trim();
    const lifelenzCandidates = listCredentialCandidates(store, 'lifelenz');
    const lifelenzCredentials = lifelenzCandidates[0];
    if (!lifelenzCredentials?.email || !lifelenzCredentials?.password) return null;
    return { [store]: { email: lifelenzCredentials.email, password: lifelenzCredentials.password } };
}

async function runForecastJob(storeNumber, runDateKey) {
    const store = String(storeNumber || '').trim();
    const lifelenzByStore = lifelenzCredentialsForStore(store);
    const lifelenzCredentials =
        lifelenzByStore && Object.keys(lifelenzByStore).length > 0 ? { byStore: lifelenzByStore } : null;

    let result;
    try {
        result = await runCombinedForecastNextThreeWeeksForStores([store], {
            completedBy: 'auto',
            headless: true,
            lifelenzHeadless: true,
            lifelenzCredentials,
            onProgress: (payload) => {
                console.log(`[DailyReports] [${store}] forecast`, JSON.stringify(payload));
            },
        });
    } catch (err) {
        const combined = err.combined || err.partialResults?.[err.partialResults.length - 1]?.combined;
        if (combined) {
            const lines = extractForecastFailureLines(combined);
            const detail = lines.join('; ') || err.message || 'Forecast auto-submit failed';
            const wrapped = new Error(
                err.weekLabel ? `Week ${err.weekIndex} of 3 (${err.weekLabel}): ${detail}` : detail
            );
            wrapped.forecastLines = lines;
            wrapped.combined = combined;
            throw wrapped;
        }
        throw err;
    }

    markScheduledRun(runDateKey, result.targetWeeks?.[0] || null, {
        storeCount: 1,
        failedStores: [],
        allSucceeded: true,
        storeNumber: store,
        targetScope: 'next-three-weeks',
        weekStarts: result.targetWeeks || [],
    });
    console.info(`[DailyReports] Forecast auto-submit completed for store ${store} (next 3 weeks)`);
    return result;
}

function buildStorePlan(isTestStoreFn, options = {}) {
    const stockSchedulerEnabled = options.stockSchedulerEnabled?.() !== false;
    const rows = [];
    for (const cfg of getStoreList()) {
        const storeNumber = String(cfg.storeNumber || '').trim();
        if (!storeNumber || isTestStore(storeNumber, isTestStoreFn)) continue;
        const stockEnabled = stockSchedulerEnabled && isStockDailyEnabled(storeNumber);
        const forecastEnabled = isForecastEligible(storeNumber);
        if (!stockEnabled && !forecastEnabled) continue;
        rows.push({
            storeNumber,
            storeName: cfg.storeName || storeNumber,
            stockEnabled,
            forecastEnabled,
        });
    }
    return rows.sort((a, b) =>
        String(a.storeNumber).localeCompare(String(b.storeNumber), undefined, { numeric: true })
    );
}

function ensureStoreFailureMap(failuresByStore, storeNumber, storeName) {
    const store = String(storeNumber || '').trim();
    if (!failuresByStore.has(store)) {
        failuresByStore.set(store, {
            storeNumber: store,
            storeName: storeName || store,
            stockError: null,
            forecastLines: [],
            forecastError: null,
            iseError: null,
            subscriptionErrors: [],
        });
    }
    return failuresByStore.get(store);
}

function subscriptionStores(sub) {
    if (String(sub.scopeType || '').trim() === 'store') {
        return [{ storeNumber: String(sub.scopeId || '').trim(), storeName: null }];
    }
    if (String(sub.scopeType || '').trim() === 'area') {
        return getStoreList()
            .filter((row) => String(row.area || '').trim() === String(sub.scopeId || '').trim())
            .map((row) => ({
                storeNumber: String(row.storeNumber || '').trim(),
                storeName: row.storeName || null,
            }));
    }
    return [];
}

function subscriptionFailureLabel(sub) {
    const type = reportTypeLabel(sub.reportType);
    if (sub.reportType === 'ise-trimmed-average') return null;
    return `${type} report failed to send`;
}

async function runDailyReportSubscriptions(runDateKey, failuresByStore, options = {}) {
    if (options.subscriptionsEnabled?.() === false) return [];
    const due = listEnabledSubscriptionsDue(new Date(), { force: Boolean(options.force) });
    const results = [];
    for (const sub of due) {
        const label = `${reportTypeLabel(sub.reportType)} — ${sub.scopeType} ${sub.scopeId}`;
        const attempt = await runWithRetries(label, async () => {
            const result = await sendSubscriptionReport(sub, { backfill: true });
            if (!result.email?.sent) {
                throw new Error(result.email?.reason || 'email not sent');
            }
            return result;
        });

        if (attempt.ok) {
            markSubscriptionSent(sub.id, melbourneTodayIso());
            results.push({ subscriptionId: sub.id, ok: true });
            continue;
        }

        const error = attempt.error || 'failed';
        results.push({ subscriptionId: sub.id, ok: false, error });
        const iseFailure = sub.reportType === 'ise-trimmed-average';
        const customLabel = subscriptionFailureLabel(sub);
        for (const row of subscriptionStores(sub)) {
            if (!row.storeNumber) continue;
            const entry = ensureStoreFailureMap(failuresByStore, row.storeNumber, row.storeName);
            if (iseFailure) {
                entry.iseError = error;
            } else if (customLabel) {
                entry.subscriptionErrors.push(customLabel);
            } else {
                entry.subscriptionErrors.push(`${reportTypeLabel(sub.reportType)} failed: ${error}`);
            }
        }
    }
    return results;
}

/**
 * Run all enabled daily automated reports (stock + forecast per store, then subscriptions).
 * Store jobs run with DAILY_REPORTS_CONCURRENCY (default 1). LifeLenz remains serialized inside forecast.
 * Marks the Melbourne calendar day complete when finished so schedulers idle until tomorrow.
 */
async function runDailyReportsOrchestrator(deps) {
    const runDateKey = melbourneDateKey();
    const failuresByStore = new Map();
    const summary = {
        dateKey: runDateKey,
        stores: [],
        subscriptions: [],
        startedAt: new Date().toISOString(),
    };

    const storePlan = buildStorePlan(deps.isTestStore, deps);
    const concurrency = envConcurrency('DAILY_REPORTS_CONCURRENCY', 1);
    console.info(
        `[DailyReports] Starting daily batch for ${runDateKey} (${storePlan.length} store job(s), concurrency ${concurrency})`
    );

    const storeSummaries = await mapWithConcurrency(storePlan, concurrency, async (row) => {
        const storeSummary = {
            storeNumber: row.storeNumber,
            storeName: row.storeName,
            stock: null,
            forecast: null,
        };

        if (row.stockEnabled) {
            const stockAttempt = await runWithRetries(`Stock ${row.storeNumber}`, () =>
                runStockJob(row.storeNumber, deps)
            );
            if (stockAttempt.ok) {
                storeSummary.stock = { ok: true, skipped: Boolean(stockAttempt.result?.skipped) };
            } else {
                storeSummary.stock = { ok: false, error: stockAttempt.error };
                ensureStoreFailureMap(failuresByStore, row.storeNumber, row.storeName).stockError =
                    stockAttempt.error || 'Stock levels report failed to download';
            }
        }

        if (row.forecastEnabled) {
            const forecastAttempt = await runWithRetries(`Forecast ${row.storeNumber}`, async () =>
                runForecastJob(row.storeNumber, runDateKey)
            );
            if (forecastAttempt.ok) {
                storeSummary.forecast = { ok: true };
            } else {
                const entry = ensureStoreFailureMap(failuresByStore, row.storeNumber, row.storeName);
                const lines = forecastAttempt.details?.forecastLines;
                if (Array.isArray(lines) && lines.length) {
                    entry.forecastLines = lines;
                } else {
                    entry.forecastError = forecastAttempt.error || 'Forecast auto-submit failed';
                }
                storeSummary.forecast = { ok: false, error: forecastAttempt.error };
            }
        }

        return storeSummary;
    });

    summary.stores = storeSummaries;

    summary.subscriptions = await runDailyReportSubscriptions(runDateKey, failuresByStore, {
        ...deps,
        force: Boolean(deps.force),
    });

    try {
        deps.purgeStockResults?.(runDateKey);
    } catch (err) {
        console.warn('[DailyReports] Results cleanup failed:', err.message);
    }

    const storeFailures = [...failuresByStore.values()];
    if (storeFailures.length && deps.shouldSendFailureEmail?.(runDateKey)) {
        await sendFailedAutomatedReportsEmail(storeFailures, {
            dateKey: runDateKey,
            alertsEnabled: deps.alertsEnabled,
            sendEmail: deps.sendAlertEmail,
            postWebhook: deps.postAlertWebhook,
        });
    } else if (storeFailures.length) {
        console.warn('[DailyReports] Failure digest already sent for', runDateKey);
    }

    summary.completedAt = new Date().toISOString();
    summary.failureCount = storeFailures.length;
    markDailyRunComplete(runDateKey, summary);
    console.info(
        `[DailyReports] Daily batch complete for ${runDateKey} (${storeFailures.length} store(s) with failures)`
    );
    return summary;
}

async function maybeRunDailyReportsOrchestrator(deps) {
    if (deps.isEnabled && !deps.isEnabled()) return null;
    if (deps.isRunning?.()) return null;

    const now = new Date();
    const runDateKey = melbourneDateKey(now);
    if (hasCompletedDailyRun(runDateKey)) return null;
    // Only during the scheduled hour — not any time after (avoids mid-day restart catch-up).
    if (localHourInTimeZone(now, TIME_ZONE) !== scheduleHour()) return null;

    deps.setRunning(true);
    try {
        return await runWithPriority(PRIORITY.ADMIN, {
            type: 'daily-reports-orchestrator',
            label: `daily reports (${runDateKey})`,
            run: () => runDailyReportsOrchestrator(deps),
        });
    } finally {
        deps.setRunning(false);
    }
}

/**
 * Manual / tray re-run: ignore schedule hour and today's completed lock.
 * Re-runs stock + forecast + subscriptions (subscriptions ignore lastSentDate).
 */
async function forceRunDailyReportsOrchestrator(deps) {
    if (deps.isEnabled && !deps.isEnabled()) {
        const err = new Error('Daily reports orchestrator is disabled');
        err.code = 'DISABLED';
        throw err;
    }
    if (deps.isRunning?.()) {
        const err = new Error('Daily reports are already running');
        err.code = 'ALREADY_RUNNING';
        throw err;
    }

    const runDateKey = melbourneDateKey();
    clearDailyRun(runDateKey);
    const forceDeps = { ...deps, force: true };

    deps.setRunning(true);
    try {
        console.info(`[DailyReports] Force re-run started for ${runDateKey}`);
        return await runWithPriority(PRIORITY.ADMIN, {
            type: 'daily-reports-orchestrator',
            label: `daily reports force (${runDateKey})`,
            run: () => runDailyReportsOrchestrator(forceDeps),
        });
    } finally {
        deps.setRunning(false);
    }
}

module.exports = {
    runDailyReportsOrchestrator,
    maybeRunDailyReportsOrchestrator,
    forceRunDailyReportsOrchestrator,
    runWithRetries,
    buildStorePlan,
    scheduleHour,
    MAX_ATTEMPTS,
};
