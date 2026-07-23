/**
 * Forecast orchestration: history → plan → MMX + LifeLenz submit.
 */
const fs = require('fs');
const path = require('path');
const paths = require('../../src/paths');
const { buildPlan, addDaysIso, melbourneToday } = require('./planEngine');
const { readConfig, isAutoSubmitEnabled } = require('./forecastConfig');
const { readHistory, recentDays, upsertDay } = require('./historyStore');
const { getStoreList } = require('../../stores/src/storeList');
const { listStoresForCoach } = require('../../stores/src/coachScope');

const STATUS_DIR = path.join(paths.forecast.data, 'runs');
const WEEK_STATUS_FILE = path.join(paths.forecast.data, 'week-submit-status.json');

function statusPath(runId) {
    return path.join(STATUS_DIR, `${runId}.json`);
}

function writeStatus(runId, status) {
    fs.mkdirSync(STATUS_DIR, { recursive: true });
    const doc = { ...status, runId, updatedAt: new Date().toISOString() };
    fs.writeFileSync(statusPath(runId), `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
    return doc;
}

function readWeekStatusDoc() {
    if (!fs.existsSync(WEEK_STATUS_FILE)) return {};
    try {
        return JSON.parse(fs.readFileSync(WEEK_STATUS_FILE, 'utf8')) || {};
    } catch {
        return {};
    }
}

function writeWeekStatusDoc(doc) {
    fs.mkdirSync(path.dirname(WEEK_STATUS_FILE), { recursive: true });
    fs.writeFileSync(WEEK_STATUS_FILE, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
}

function markWeeksSubmitted(storeNumber, weekKeys) {
    const doc = readWeekStatusDoc();
    const key = String(storeNumber);
    doc[key] = doc[key] || {};
    const now = new Date().toISOString();
    for (const wk of weekKeys) {
        doc[key][wk] = { state: 'done', at: now };
    }
    writeWeekStatusDoc(doc);
}

function weekStartMonday(dateKey, timeZone = process.env.DASHBOARD_TIME_ZONE || 'Australia/Melbourne') {
    const [y, m, d] = String(dateKey).split('-').map(Number);
    const utc = new Date(Date.UTC(y, m - 1, d, 12));
    // Get weekday in TZ
    const wd = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(utc);
    const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const day = map[wd] ?? 1;
    const delta = day === 0 ? -6 : 1 - day; // Monday start
    return addDaysIso(dateKey, delta);
}

function datesForWeeks(weeks = 3, timeZone) {
    const today = melbourneToday(timeZone);
    // Start from this week's Monday
    const thisMonday = weekStartMonday(today, timeZone);
    const out = [];
    const weekKeys = [];
    for (let w = 0; w < weeks; w++) {
        const monday = addDaysIso(thisMonday, w * 7);
        weekKeys.push(monday);
        for (let d = 0; d < 7; d++) out.push(addDaysIso(monday, d));
    }
    return { dates: out, weekKeys, thisMonday };
}

function sumPlanDays(days, dateKeys) {
    const set = new Set(dateKeys);
    let total = 0;
    for (const day of days || []) {
        if (day.skipped || !set.has(day.dateKey)) continue;
        total += Number(day.total) || 0;
    }
    return total;
}

function weekTotalsForStore(storeNumber, weeks = 3) {
    const cfg = readConfig();
    const { dates, weekKeys, thisMonday } = datesForWeeks(weeks);
    const plan = buildPlan({
        storeNumber,
        targetDates: dates,
        adjustments: cfg.adjustments,
        protectedDates: cfg.protectedDates,
    });
    const weekStatus = readWeekStatusDoc()[String(storeNumber)] || {};
    const weekStates = weekKeys.map((monday, idx) => {
        const keys = [];
        for (let d = 0; d < 7; d++) keys.push(addDaysIso(monday, d));
        const total = sumPlanDays(plan.days, keys);
        return {
            weekIndex: idx,
            label: idx === 0 ? 'this' : idx === 1 ? 'next' : 'after',
            monday,
            total,
            state: weekStatus[monday]?.state === 'done' ? 'done' : total > 0 ? 'pending' : 'pending',
        };
    });
    // "Next week" $ badge (index 1) — fall back to this week
    const badgeWeek = weekStates[1] || weekStates[0];
    return {
        thisMonday,
        weekTotal: badgeWeek?.total || 0,
        weekStates,
        historyDaysUsed: plan.historyDaysUsed,
    };
}

function listRecentRuns(limit = 20) {
    if (!fs.existsSync(STATUS_DIR)) return [];
    return fs
        .readdirSync(STATUS_DIR)
        .filter((f) => f.endsWith('.json'))
        .map((f) => {
            try {
                return JSON.parse(fs.readFileSync(path.join(STATUS_DIR, f), 'utf8'));
            } catch {
                return null;
            }
        })
        .filter(Boolean)
        .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
        .slice(0, limit);
}

function storeStatusSummary(storeNumber) {
    const history = readHistory(storeNumber);
    const days = Object.keys(history.days || {});
    const weeks = weekTotalsForStore(storeNumber, 3);
    return {
        storeNumber: String(storeNumber),
        storeName: getStoreList().find((s) => String(s.storeNumber) === String(storeNumber))?.storeName || '',
        historyDays: days.length,
        historyReady: days.length >= 21,
        lastHistoryDate: days.sort().slice(-1)[0] || null,
        autoSubmit: isAutoSubmitEnabled(storeNumber),
        weekTotal: weeks.weekTotal,
        weekStates: weeks.weekStates,
        updatedAt: history.updatedAt,
        lastForecastAt: readWeekStatusDoc()[String(storeNumber)]
            ? Object.values(readWeekStatusDoc()[String(storeNumber)])
                  .map((r) => r.at)
                  .filter(Boolean)
                  .sort()
                  .slice(-1)[0] || null
            : null,
    };
}

function listStoreStatuses(storeNumbers = null) {
    const list = Array.isArray(storeNumbers)
        ? storeNumbers.map(String)
        : listStoresForCoach().map((s) => String(s.storeNumber));
    return list.map((n) => storeStatusSummary(n));
}

async function submitPlanToPortals(storeNumber, plan, { mmx = true, lifelenz = true } = {}) {
    const results = { mmx: null, lifelenz: null };
    const activeDays = (plan.days || []).filter((d) => !d.skipped && d.hourly?.length);

    if (mmx) {
        try {
            const forecastScraper = require('../../mmx/src/forecast/forecastScraper');
            if (typeof forecastScraper.writeForecastPlanToMmx === 'function') {
                results.mmx = await forecastScraper.writeForecastPlanToMmx(storeNumber, activeDays);
            } else if (typeof forecastScraper.submitForecastPlan === 'function') {
                results.mmx = await forecastScraper.submitForecastPlan(storeNumber, activeDays);
            } else {
                results.mmx = { ok: true, planOnly: true, message: 'MMX submit stub — plan generated.' };
            }
        } catch (err) {
            results.mmx = { ok: false, error: err.message || String(err) };
        }
    }

    if (lifelenz) {
        try {
            const lifelenzScraper = require('../../lifelenz/src/lifelenzForecastScraper');
            if (typeof lifelenzScraper.submitForecastPlan === 'function') {
                results.lifelenz = await lifelenzScraper.submitForecastPlan(storeNumber, activeDays);
            } else if (typeof lifelenzScraper.writeForecastToLifeLenz === 'function') {
                results.lifelenz = await lifelenzScraper.writeForecastToLifeLenz(storeNumber, activeDays);
            } else {
                results.lifelenz = { ok: true, planOnly: true, message: 'LifeLenz submit stub — plan generated.' };
            }
        } catch (err) {
            results.lifelenz = { ok: false, error: err.message || String(err) };
        }
    }

    return results;
}

async function runForecastForStore(storeNumber, options = {}) {
    const weeks = Math.max(1, Math.min(5, Number(options.weeks || SUBMIT_WEEKS) || SUBMIT_WEEKS));
    const runId = `${storeNumber}-${Date.now()}`;
    const cfg = readConfig();
    const { dates, weekKeys } = datesForWeeks(weeks);

    writeStatus(runId, { storeNumber, state: 'planning', message: 'Building plan' });

    const plan = buildPlan({
        storeNumber,
        targetDates: options.targetDates || dates,
        adjustments: cfg.adjustments,
        protectedDates: cfg.protectedDates,
        historyDays: options.historyDays,
    });

    if (options.previewOnly) {
        return writeStatus(runId, {
            storeNumber,
            state: 'preview',
            message: 'Preview complete',
            plan,
            weekTotal: weekTotalsForStore(storeNumber, weeks).weekTotal,
        });
    }

    const submit = await submitPlanToPortals(storeNumber, plan, {
        mmx: options.mmx !== false,
        lifelenz: options.lifelenz !== false,
    });

    const ok =
        (submit.mmx?.ok !== false || submit.mmx?.planOnly) &&
        (submit.lifelenz?.ok !== false || submit.lifelenz?.planOnly);

    if (ok) markWeeksSubmitted(storeNumber, weekKeys);

    return writeStatus(runId, {
        storeNumber,
        state: ok ? 'done' : 'error',
        message: ok ? 'Forecast run finished' : 'Forecast run finished with errors',
        plan,
        submit,
    });
}

async function runForecastForStores(storeNumbers, options = {}) {
    const results = [];
    for (const store of storeNumbers) {
        results.push(await runForecastForStore(store, options));
    }
    return results;
}

const BACKFILL_DAYS = 35; // always 5 weeks
const SUBMIT_WEEKS = 3;

async function backfillHistoryFromMmx(storeNumber, days = BACKFILL_DAYS) {
    const daysBack = Math.max(7, Number(days) || BACKFILL_DAYS);
    const logs = [];
    try {
        const forecastScraper = require('../../mmx/src/forecast/forecastScraper');
        if (typeof forecastScraper.backfillStoreHistoryFromMmx !== 'function') {
            return {
                ok: false,
                storeNumber: String(storeNumber),
                error: 'backfillStoreHistoryFromMmx not available on forecast scraper.',
                logs: ['ERROR: backfill function missing on forecast scraper.'],
            };
        }
        const result = await forecastScraper.backfillStoreHistoryFromMmx(storeNumber, {
            days: daysBack,
            daysBack,
            onProgress: (ev) => {
                if (ev?.message) logs.push(String(ev.message));
            },
        });
        // Ensure days land in the greenfield history store used by planEngine
        if (Array.isArray(result?.days)) {
            for (const row of result.days) {
                if (row?.dateKey && Array.isArray(row.actual)) {
                    upsertDay(storeNumber, row.dateKey, row.actual, { source: 'mmx-backfill' });
                }
            }
        }
        const localDays = recentDays(storeNumber, daysBack).length;
        const mergedLogs = [...(result.logs || []), ...logs];
        if (result.ok === false) {
            return {
                ok: false,
                storeNumber: String(storeNumber),
                imported: result.imported || 0,
                localDays,
                daysBack,
                error: result.error || 'Backfill failed',
                logs: mergedLogs.length
                    ? mergedLogs
                    : [`Store ${storeNumber}: backfill failed - ${result.error || 'unknown error'}`],
            };
        }
        mergedLogs.push(
            `Store ${storeNumber}: backfill finished - imported ${result.imported || 0} day(s), history now ${localDays} day(s).`
        );
        return {
            ok: true,
            storeNumber: String(storeNumber),
            imported: result.imported || 0,
            localDays,
            daysBack,
            logs: mergedLogs,
        };
    } catch (err) {
        const message = err.message || String(err);
        logs.push(`Store ${storeNumber}: ERROR - ${message}`);
        return { ok: false, storeNumber: String(storeNumber), error: message, logs, daysBack };
    }
}

async function backfillStores(storeNumbers, days = BACKFILL_DAYS) {
    const results = [];
    for (const store of storeNumbers) {
        results.push(await backfillHistoryFromMmx(store, days));
    }
    return results;
}

module.exports = {
    listStoreStatuses,
    storeStatusSummary,
    runForecastForStore,
    runForecastForStores,
    backfillHistoryFromMmx,
    backfillStores,
    listRecentRuns,
    buildPlan,
    weekTotalsForStore,
    BACKFILL_DAYS,
    SUBMIT_WEEKS,
};
