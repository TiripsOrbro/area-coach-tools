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

/**
 * Dates to write into MMX / LifeLenz.
 * Current week: from tomorrow only (past + today are locked in Manager Forecast).
 * Matches live-dashboard submitDatesForWeek behaviour.
 */
function submitDatesForWeeks(weeks = 3, timeZone) {
    const { dates, weekKeys, thisMonday } = datesForWeeks(weeks, timeZone);
    const today = melbourneToday(timeZone);
    const tomorrow = addDaysIso(today, 1);
    const submitDates = dates.filter((d) => d >= tomorrow);
    return { dates: submitDates, weekKeys, thisMonday, today, tomorrow };
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

/** Adapt planEngine days to portal shape (date + {hour,forecast}[]). */
function toPortalPlanDays(plan) {
    const RAW_BASE_HOUR = 5;
    return (plan?.days || [])
        .filter((d) => !d.skipped && Array.isArray(d.hourly) && d.hourly.length)
        .map((d) => {
            const hourly = d.hourly.map((slot, i) => {
                if (slot && typeof slot === 'object') {
                    return {
                        hour: Number(slot.hour ?? RAW_BASE_HOUR + i),
                        forecast: Math.round(Number(slot.forecast ?? slot.value ?? 0) || 0),
                    };
                }
                // Legacy number[] — Macromatix raw arrays are 5AM-based, not midnight.
                return {
                    hour: RAW_BASE_HOUR + i,
                    forecast: Math.round(Number(slot) || 0),
                };
            });
            const date = String(d.date || d.dateKey || '').trim();
            const forecastTotal =
                d.forecastTotal != null
                    ? Number(d.forecastTotal) || 0
                    : Number(d.total) ||
                      hourly.reduce((sum, h) => sum + (Number(h.forecast) || 0), 0);
            return {
                date,
                dateKey: date,
                weekday: d.weekday,
                forecastTotal,
                total: forecastTotal,
                hourly,
                openHour: d.openHour,
                closeHour: d.closeHour,
            };
        })
        .filter((d) => Boolean(d.date));
}

function portalResultOk(result) {
    if (result == null) return true;
    if (result.ok === false || result.error) return false;
    if (result.mmx?.ok === false || result.mmx?.error) return false;
    if (result.lifelenz?.ok === false || result.lifelenz?.error) return false;
    return true;
}

function portalErrorText(result, label) {
    if (!result || portalResultOk(result)) return null;
    const err =
        result.error ||
        result.mmx?.error ||
        result.lifelenz?.error ||
        result.message ||
        'failed';
    return `${label}: ${err}`;
}

async function submitMmxPlan(storeNumber, portalDays, { emit, wrap, shouldAbort }) {
    emit({
        type: 'store-start',
        platform: 'mmx',
        dayCount: portalDays.length,
    });
    const forecastScraper = require('../../mmx/src/forecast/forecastScraper');
    if (typeof forecastScraper.writeForecastPlanToMmx === 'function') {
        const written = await forecastScraper.writeForecastPlanToMmx(storeNumber, portalDays, {
            onProgress: wrap('mmx'),
            shouldAbort,
        });
        emit({ type: 'store-done', platform: 'mmx', ok: true });
        return { ok: true, ...written };
    }
    if (typeof forecastScraper.submitForecastPlan === 'function') {
        const written = await forecastScraper.submitForecastPlan(storeNumber, portalDays, {
            onProgress: wrap('mmx'),
            shouldAbort,
        });
        emit({ type: 'store-done', platform: 'mmx', ok: true });
        return { ok: true, ...written };
    }
    emit({ type: 'store-done', platform: 'mmx', ok: true, planOnly: true });
    return { ok: true, planOnly: true, message: 'MMX submit stub — plan generated.' };
}

async function submitLifelenzPlan(storeNumber, portalDays, { emit, wrap, shouldAbort }) {
    emit({ type: 'lifelenz-phase-start' });
    let credentials = {};
    try {
        const { readSession } = require('../../stores/src/coachSession');
        credentials = readSession()?.lifelenz || {};
    } catch {
        credentials = {};
    }
    const email = String(credentials.email || '').trim();
    const password = String(credentials.password || '');
    if (!email || !password) {
        const error = 'LifeLenz credentials not set — add email/password in Account settings.';
        emit({ type: 'store-error', platform: 'lifelenz', error });
        return { ok: false, error };
    }

    emit({
        type: 'store-start',
        platform: 'lifelenz',
        dayCount: portalDays.length,
    });
    emit({ type: 'session-start', platform: 'lifelenz' });

    const lifelenzScraper = require('../../lifelenz/src/lifelenzForecastScraper');
    if (typeof lifelenzScraper.writeForecastPlanToLifeLenz === 'function') {
        const written = await lifelenzScraper.writeForecastPlanToLifeLenz(
            storeNumber,
            portalDays,
            credentials,
            { onProgress: wrap('lifelenz'), shouldAbort }
        );
        emit({ type: 'store-complete', platform: 'lifelenz', ok: true });
        return { ok: true, ...written };
    }
    if (typeof lifelenzScraper.submitForecastPlan === 'function') {
        const written = await lifelenzScraper.submitForecastPlan(storeNumber, portalDays, {
            onProgress: wrap('lifelenz'),
            shouldAbort,
        });
        emit({ type: 'store-complete', platform: 'lifelenz', ok: true });
        return { ok: true, ...written };
    }
    if (typeof lifelenzScraper.writeForecastToLifeLenz === 'function') {
        const written = await lifelenzScraper.writeForecastToLifeLenz(storeNumber, portalDays, {
            onProgress: wrap('lifelenz'),
            shouldAbort,
        });
        emit({ type: 'store-complete', platform: 'lifelenz', ok: true });
        return { ok: true, ...written };
    }
    emit({ type: 'store-complete', platform: 'lifelenz', ok: true, planOnly: true });
    return {
        ok: true,
        planOnly: true,
        message: 'LifeLenz submit stub — plan generated.',
    };
}

async function submitPlanToPortals(storeNumber, plan, options = {}) {
    const mmx = options.mmx !== false;
    const lifelenz = options.lifelenz !== false;
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
    const shouldAbort =
        typeof options.shouldAbort === 'function' ? options.shouldAbort : () => false;
    const emit = (payload) => {
        if (!onProgress || !payload) return;
        try {
            onProgress({ storeNumber: String(storeNumber), ...payload });
        } catch {
            /* ignore UI errors */
        }
    };
    const wrap = (platform) => (payload) => {
        emit({
            platform,
            ...(payload && typeof payload === 'object' ? payload : { type: 'status', label: String(payload) }),
        });
    };

    const portalDays = toPortalPlanDays(plan);
    if (!portalDays.length) {
        return {
            mmx: mmx ? { ok: false, error: 'No active forecast days in plan' } : null,
            lifelenz: lifelenz ? { ok: false, error: 'No active forecast days in plan' } : null,
        };
    }

    if (shouldAbort()) {
        return {
            mmx: mmx ? { ok: false, error: 'Cancelled', cancelled: true } : null,
            lifelenz: lifelenz ? { ok: false, error: 'Cancelled', cancelled: true } : null,
        };
    }

    // Run both portals together so LifeLenz is not blocked behind a long MMX write.
    const tasks = [];
    if (mmx) {
        tasks.push(
            submitMmxPlan(storeNumber, portalDays, { emit, wrap, shouldAbort })
                .then((result) => ({ key: 'mmx', result }))
                .catch((err) => {
                    const error = err.message || String(err);
                    emit({ type: 'store-error', platform: 'mmx', error });
                    return { key: 'mmx', result: { ok: false, error } };
                })
        );
    }
    if (lifelenz) {
        tasks.push(
            submitLifelenzPlan(storeNumber, portalDays, { emit, wrap, shouldAbort })
                .then((result) => ({ key: 'lifelenz', result }))
                .catch((err) => {
                    const error = err.message || String(err);
                    emit({ type: 'store-error', platform: 'lifelenz', error });
                    return { key: 'lifelenz', result: { ok: false, error } };
                })
        );
    }

    const settled = await Promise.all(tasks);
    const results = { mmx: null, lifelenz: null };
    for (const row of settled) {
        results[row.key] = row.result;
    }
    if (shouldAbort()) {
        if (mmx && results.mmx?.ok !== false && !results.mmx?.cancelled) {
            /* keep completed MMX result */
        }
        if (lifelenz && !results.lifelenz) {
            results.lifelenz = { ok: false, error: 'Cancelled', cancelled: true };
        } else if (lifelenz && results.lifelenz?.ok && shouldAbort()) {
            /* finished before cancel */
        }
    }
    return results;
}

async function runForecastForStore(storeNumber, options = {}) {
    const weeks = Math.max(1, Math.min(5, Number(options.weeks || SUBMIT_WEEKS) || SUBMIT_WEEKS));
    const runId = `${storeNumber}-${Date.now()}`;
    const cfg = readConfig();
    const { dates: submitDates, weekKeys, tomorrow } = submitDatesForWeeks(weeks);
    const shouldAbort =
        typeof options.shouldAbort === 'function' ? options.shouldAbort : () => false;
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;

    if (shouldAbort()) {
        return writeStatus(runId, {
            storeNumber,
            ok: false,
            state: 'error',
            message: 'Cancelled',
            cancelled: true,
        });
    }

    const targetDates = options.targetDates || submitDates;
    if (!targetDates.length) {
        return writeStatus(runId, {
            storeNumber,
            ok: false,
            state: 'error',
            message: `No remaining days to submit (writes start from tomorrow ${tomorrow}).`,
        });
    }

    writeStatus(runId, { storeNumber, state: 'planning', message: 'Building plan' });
    onProgress?.({
        type: 'status',
        label: `Building plan for store ${storeNumber} (${targetDates.length} day(s) from ${targetDates[0]})…`,
        storeNumber,
    });

    const plan = buildPlan({
        storeNumber,
        targetDates,
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

    if (shouldAbort()) {
        return writeStatus(runId, {
            storeNumber,
            ok: false,
            state: 'error',
            message: 'Cancelled',
            cancelled: true,
            plan,
        });
    }

    const wantMmx = options.mmx !== false;
    const wantLifelenz = options.lifelenz !== false;
    writeStatus(runId, {
        storeNumber,
        state: 'submitting',
        message:
            wantMmx && wantLifelenz
                ? 'Submitting to MMX + LifeLenz (in parallel)'
                : wantMmx
                  ? 'Submitting to MMX'
                  : 'Submitting to LifeLenz',
        plan,
    });
    onProgress?.({
        type: 'status',
        label:
            wantMmx && wantLifelenz
                ? `Submitting store ${storeNumber} to MMX and LifeLenz together…`
                : `Submitting store ${storeNumber}…`,
        storeNumber,
    });

    const submit = await submitPlanToPortals(storeNumber, plan, {
        mmx: wantMmx,
        lifelenz: wantLifelenz,
        onProgress,
        shouldAbort,
    });

    const cancelled = Boolean(submit.mmx?.cancelled || submit.lifelenz?.cancelled || shouldAbort());
    const ok = !cancelled && portalResultOk(submit.mmx) && portalResultOk(submit.lifelenz);
    const errorParts = [
        portalErrorText(submit.mmx, 'MMX'),
        portalErrorText(submit.lifelenz, 'LifeLenz'),
    ].filter(Boolean);

    if (ok) markWeeksSubmitted(storeNumber, weekKeys);

    return writeStatus(runId, {
        storeNumber,
        ok,
        state: ok ? 'done' : 'error',
        cancelled,
        message: cancelled
            ? 'Cancelled'
            : ok
              ? 'Forecast run finished'
              : errorParts.join(' · ') || 'Forecast run finished with errors',
        plan,
        submit,
    });
}

async function runForecastForStores(storeNumbers, options = {}) {
    const results = [];
    const shouldAbort =
        typeof options.shouldAbort === 'function' ? options.shouldAbort : () => false;
    for (const store of storeNumbers) {
        if (shouldAbort()) {
            results.push({
                storeNumber: String(store),
                ok: false,
                state: 'error',
                cancelled: true,
                message: 'Cancelled',
            });
            continue;
        }
        results.push(await runForecastForStore(store, options));
    }
    return results;
}

const BACKFILL_DAYS = 35; // always 5 weeks
const SUBMIT_WEEKS = 3;

async function backfillHistoryFromMmx(storeNumber, days = BACKFILL_DAYS, options = {}) {
    const daysBack = Math.max(7, Number(days) || BACKFILL_DAYS);
    const onLog = typeof options.onLog === 'function' ? options.onLog : null;
    const logs = [];
    const emit = (message) => {
        const line = String(message || '').trim();
        if (!line) return;
        logs.push(line);
        onLog?.(line);
    };
    try {
        const forecastScraper = require('../../mmx/src/forecast/forecastScraper');
        if (typeof forecastScraper.backfillStoreHistoryFromMmx !== 'function') {
            emit('ERROR: backfill function missing on forecast scraper.');
            return {
                ok: false,
                storeNumber: String(storeNumber),
                error: 'backfillStoreHistoryFromMmx not available on forecast scraper.',
                logs,
            };
        }
        const result = await forecastScraper.backfillStoreHistoryFromMmx(storeNumber, {
            days: daysBack,
            daysBack,
            onProgress: (ev) => {
                // Scraper already stores lines in result.logs; only stream live here.
                if (ev?.message) onLog?.(String(ev.message));
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
        const mergedLogs = [...(result.logs || [])];
        if (result.ok === false) {
            if (!mergedLogs.length) {
                emit(`Store ${storeNumber}: backfill failed - ${result.error || 'unknown error'}`);
            }
            return {
                ok: false,
                storeNumber: String(storeNumber),
                imported: result.imported || 0,
                localDays,
                daysBack,
                error: result.error || 'Backfill failed',
                logs: mergedLogs.length ? mergedLogs : logs,
            };
        }
        const summary = `Store ${storeNumber}: history check - ${localDays} day(s) on disk after import of ${result.imported || 0}.`;
        mergedLogs.push(summary);
        onLog?.(summary);
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
        emit(`Store ${storeNumber}: ERROR - ${message}`);
        return { ok: false, storeNumber: String(storeNumber), error: message, logs, daysBack };
    }
}

async function backfillStores(storeNumbers, days = BACKFILL_DAYS, options = {}) {
    const results = [];
    for (const store of storeNumbers) {
        results.push(await backfillHistoryFromMmx(store, days, options));
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
    datesForWeeks,
    submitDatesForWeeks,
    BACKFILL_DAYS,
    SUBMIT_WEEKS,
};
