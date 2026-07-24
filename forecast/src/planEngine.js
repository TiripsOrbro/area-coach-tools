/**
 * Pure forecast plan builder — weekday-hour mix from recent history.
 *
 * Macromatix labour day-view hourly arrays are 5AM-based:
 *   index 0 = 5:00 AM, index 1 = 6:00 AM, …
 * (same as live-dashboard-app RAW_BASE_HOUR).
 */
const { recentDays } = require('./historyStore');

/** Macromatix raw hourly index 0 = 5AM local. */
const RAW_BASE_HOUR = 5;
const DEFAULT_OPEN_HOUR = 10;
const DEFAULT_CLOSE_HOUR = 22;

function dayOfWeek(dateKey, timeZone = 'Australia/Melbourne') {
    const [y, m, d] = String(dateKey).split('-').map(Number);
    const utc = Date.UTC(y, m - 1, d, 12, 0, 0);
    const weekday = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(new Date(utc));
    const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    return map[weekday] ?? new Date(utc).getUTCDay();
}

function addDaysIso(dateKey, days) {
    const [y, m, d] = String(dateKey).split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + days);
    return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

function melbourneToday(timeZone = process.env.DASHBOARD_TIME_ZONE || 'Australia/Melbourne') {
    return new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date());
}

/** Drop highest + lowest samples (when 3+), then average. */
function trimmedMean(values) {
    return explainTrimmedMean(values).mean;
}

/**
 * Same numeric result as trimmedMean, plus a role per input index.
 * roles[i]: 'kept' | 'low-outlier' | 'high-outlier' | 'missing'
 * On ties, marks exactly one lowest and one highest sample as outliers.
 */
function explainTrimmedMean(values) {
    const list = Array.isArray(values) ? values : [];
    const roles = list.map(() => 'missing');
    const samples = [];
    for (let i = 0; i < list.length; i++) {
        const v = Number(list[i]);
        if (!Number.isFinite(v)) continue;
        samples.push({ index: i, value: v });
    }
    if (!samples.length) return { mean: 0, roles };

    if (samples.length < 3) {
        for (const s of samples) roles[s.index] = 'kept';
        const mean = Math.round(samples.reduce((sum, s) => sum + s.value, 0) / samples.length);
        return { mean, roles };
    }

    const sorted = [...samples].sort((a, b) => a.value - b.value || a.index - b.index);
    const low = sorted[0];
    const high = sorted[sorted.length - 1];
    for (const s of samples) roles[s.index] = 'kept';
    roles[low.index] = 'low-outlier';
    roles[high.index] = 'high-outlier';
    const trimmed = sorted.slice(1, -1);
    const mean = Math.round(trimmed.reduce((sum, s) => sum + s.value, 0) / trimmed.length);
    return { mean, roles };
}

const WEEKDAY_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function formatHourLabel(hour) {
    const h = Number(hour);
    if (!Number.isFinite(h)) return String(hour);
    const period = h >= 12 ? 'PM' : 'AM';
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${h12}${period}`;
}

function formatShortDateLabel(dateKey) {
    const [y, m, d] = String(dateKey || '').split('-').map(Number);
    if (!y || !m || !d) return String(dateKey || '');
    const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
    return new Intl.DateTimeFormat('en-AU', {
        day: 'numeric',
        month: 'short',
        timeZone: 'UTC',
    }).format(dt);
}

/**
 * Transparency payload for one weekday: peer date columns × trading hours,
 * with per-cell outlier roles matching buildPlan / trimmedMean.
 */
function explainWeekdayHourly(options = {}) {
    const storeNumber = String(options.storeNumber || '').trim();
    const timeZone = options.timeZone || process.env.DASHBOARD_TIME_ZONE || 'Australia/Melbourne';
    const historyDays = Math.max(7, Number(options.historyDays || 35) || 35);
    let weekday = Number(options.weekday);
    if (!Number.isFinite(weekday) || weekday < 0 || weekday > 6) {
        weekday = dayOfWeek(melbourneToday(timeZone), timeZone);
    }
    weekday = Math.trunc(weekday);

    const history = recentDays(storeNumber, historyDays);
    let historyDaysIgnored = 0;
    const peerRows = [];
    for (const row of history) {
        if (row.ignored) historyDaysIgnored += 1;
        const wd = dayOfWeek(row.dateKey, timeZone);
        if (wd !== weekday) continue;
        peerRows.push({
            dateKey: row.dateKey,
            ignored: Boolean(row.ignored),
            actual: Array.isArray(row.actual) ? row.actual : [],
        });
    }

    // Oldest → newest (recentDays is ascending by date key)
    const columns = peerRows.map((row) => ({
        dateKey: row.dateKey,
        label: formatShortDateLabel(row.dateKey),
        ignored: row.ignored,
        hasData: row.actual.length > 0,
    }));

    const activePeers = peerRows.filter((row) => !row.ignored && row.actual.length);
    const hours = resolveStoreHours(
        storeNumber,
        peerRows[peerRows.length - 1]?.dateKey || melbourneToday(timeZone),
        timeZone
    );
    const openHour = hours.openHour;
    const closeHour = hours.closeHour;

    const rows = [];
    for (let hour = openHour; hour < closeHour; hour += 1) {
        const rawIdx = hour - RAW_BASE_HOUR;
        const activeValues = activePeers.map((row) => {
            if (rawIdx < 0 || rawIdx >= row.actual.length) return null;
            const v = Number(row.actual[rawIdx]);
            return Number.isFinite(v) ? v : null;
        });
        const explained = explainTrimmedMean(activeValues);
        const byDate = new Map();
        activePeers.forEach((row, i) => {
            byDate.set(row.dateKey, {
                value: activeValues[i],
                role: explained.roles[i] || 'missing',
            });
        });
        const cells = peerRows.map((row) => {
            if (row.ignored) {
                return { dateKey: row.dateKey, value: null, role: 'ignored-day' };
            }
            const hit = byDate.get(row.dateKey);
            if (!hit || hit.value == null) {
                return { dateKey: row.dateKey, value: null, role: 'missing' };
            }
            return {
                dateKey: row.dateKey,
                value: Math.round(hit.value * 100) / 100,
                role: hit.role,
            };
        });
        rows.push({
            hour,
            label: formatHourLabel(hour),
            cells,
            average: explained.mean,
        });
    }

    return {
        storeNumber,
        weekday,
        weekdayLabel: WEEKDAY_LABELS[weekday] || String(weekday),
        timeZone,
        historyDaysUsed: history.length - historyDaysIgnored,
        historyDaysIgnored,
        peerDays: activePeers.length,
        openHour,
        closeHour,
        columns,
        rows,
        legend:
            'With 3+ samples, the highest and lowest values for that hour are dropped, then the rest are averaged.',
    };
}

/** Per-hour trimmed average across peer days (removes high/low hour outliers). */
function averageHourly(seriesList) {
    if (!seriesList.length) return [];
    const len = Math.max(...seriesList.map((s) => (Array.isArray(s) ? s.length : 0)));
    const out = [];
    for (let i = 0; i < len; i++) {
        const hourValues = [];
        for (const series of seriesList) {
            if (!Array.isArray(series)) continue;
            const v = Number(series[i]);
            if (Number.isFinite(v)) hourValues.push(v);
        }
        out.push(trimmedMean(hourValues));
    }
    return out;
}

function resolveStoreHours(storeNumber, dateKey, timeZone) {
    try {
        const { getStoreConfig, resolveHours } = require('../../stores/src/storeList');
        const row = getStoreConfig(storeNumber);
        if (!row) {
            return { openHour: DEFAULT_OPEN_HOUR, closeHour: DEFAULT_CLOSE_HOUR, timeZone };
        }
        const when = dateKey ? new Date(`${dateKey}T12:00:00`) : new Date();
        if (row.hoursByDay) {
            const h = resolveHours(row, when);
            return {
                openHour: h.openHour,
                closeHour: h.closeHour,
                timeZone: row.timeZone || timeZone,
            };
        }
        const open = Number(row.openHour);
        const close = Number(row.closeHour);
        return {
            openHour: Number.isFinite(open) ? open : DEFAULT_OPEN_HOUR,
            closeHour: Number.isFinite(close) && close > open ? close : DEFAULT_CLOSE_HOUR,
            timeZone: row.timeZone || timeZone,
        };
    } catch {
        return { openHour: DEFAULT_OPEN_HOUR, closeHour: DEFAULT_CLOSE_HOUR, timeZone };
    }
}

/**
 * Convert a raw MMX hourly number[] (5AM-based) into portal slots {hour, forecast}
 * for the store's trading window [openHour, closeHour).
 */
function rawHourlyToSlots(rawValues, openHour, closeHour) {
    const open = Number.isFinite(openHour) ? Math.trunc(openHour) : DEFAULT_OPEN_HOUR;
    const close =
        Number.isFinite(closeHour) && closeHour > open ? Math.trunc(closeHour) : DEFAULT_CLOSE_HOUR;
    const raw = Array.isArray(rawValues) ? rawValues : [];
    const slots = [];
    for (let hour = open; hour < close; hour += 1) {
        const idx = hour - RAW_BASE_HOUR;
        const forecast =
            idx >= 0 && idx < raw.length ? Math.max(0, Math.round(Number(raw[idx]) || 0)) : 0;
        slots.push({ hour, forecast });
    }
    return { hourly: slots, openHour: open, closeHour: close };
}

/**
 * Build hourly plan for target dates from same-weekday history.
 * @param {object} options
 * @param {string} options.storeNumber
 * @param {string[]} [options.targetDates] ISO dates; default next 21 days
 * @param {Record<string, number>} [options.adjustments] dateKey -> percent (e.g. 10 = +10%)
 * @param {Set<string>|string[]} [options.protectedDates] skip these dates
 * @param {number} [options.historyDays]
 */
function buildPlan(options = {}) {
    const storeNumber = String(options.storeNumber || '').trim();
    const timeZone = options.timeZone || process.env.DASHBOARD_TIME_ZONE || 'Australia/Melbourne';
    // Default: 5 weeks of history for weekday-hour averages
    const historyDays = Math.max(7, Number(options.historyDays || 35) || 35);
    const adjustments = options.adjustments && typeof options.adjustments === 'object' ? options.adjustments : {};
    const protectedSet = new Set(
        [...(options.protectedDates || [])].map((d) => String(d).trim()).filter(Boolean)
    );

    const history = recentDays(storeNumber, historyDays);
    const byWeekday = new Map();
    let ignoredPeers = 0;
    for (const row of history) {
        if (row.ignored) {
            ignoredPeers += 1;
            continue;
        }
        const wd = dayOfWeek(row.dateKey, timeZone);
        if (!byWeekday.has(wd)) byWeekday.set(wd, []);
        byWeekday.get(wd).push(row.actual || []);
    }

    const today = melbourneToday(timeZone);
    let targetDates = Array.isArray(options.targetDates) ? options.targetDates.map(String) : null;
    if (!targetDates || !targetDates.length) {
        targetDates = [];
        for (let i = 1; i <= 21; i++) targetDates.push(addDaysIso(today, i));
    }

    const days = [];
    for (const dateKey of targetDates) {
        if (protectedSet.has(dateKey)) {
            days.push({
                dateKey,
                date: dateKey,
                skipped: true,
                reason: 'protected',
                hourly: [],
            });
            continue;
        }
        const wd = dayOfWeek(dateKey, timeZone);
        const peers = byWeekday.get(wd) || [];
        let rawAvg = averageHourly(peers);
        const adjPct = Number(adjustments[dateKey]);
        if (Number.isFinite(adjPct) && adjPct !== 0) {
            rawAvg = rawAvg.map((v) => Math.max(0, Math.round(v * (1 + adjPct / 100))));
        }
        const hours = resolveStoreHours(storeNumber, dateKey, timeZone);
        const { hourly, openHour, closeHour } = rawHourlyToSlots(
            rawAvg,
            hours.openHour,
            hours.closeHour
        );
        const total = hourly.reduce((s, slot) => s + (Number(slot.forecast) || 0), 0);
        days.push({
            dateKey,
            date: dateKey,
            weekday: wd,
            skipped: false,
            hourly,
            /** @deprecated number[] kept for older callers that expect raw averages */
            hourlyRaw: rawAvg,
            total,
            forecastTotal: total,
            openHour,
            closeHour,
            peerDays: peers.length,
        });
    }

    return {
        storeNumber,
        generatedAt: new Date().toISOString(),
        historyDaysUsed: history.length - ignoredPeers,
        historyDaysIgnored: ignoredPeers,
        rawBaseHour: RAW_BASE_HOUR,
        days,
    };
}

module.exports = {
    buildPlan,
    dayOfWeek,
    addDaysIso,
    melbourneToday,
    averageHourly,
    trimmedMean,
    explainTrimmedMean,
    explainWeekdayHourly,
    rawHourlyToSlots,
    RAW_BASE_HOUR,
    DEFAULT_OPEN_HOUR,
    DEFAULT_CLOSE_HOUR,
};
