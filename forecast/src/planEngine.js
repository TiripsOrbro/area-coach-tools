/**
 * Pure forecast plan builder — weekday-hour mix from recent history.
 */
const { recentDays } = require('./historyStore');

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
    const nums = (values || []).map(Number).filter((v) => Number.isFinite(v));
    if (!nums.length) return 0;
    if (nums.length < 3) {
        return Math.round(nums.reduce((s, v) => s + v, 0) / nums.length);
    }
    const sorted = [...nums].sort((a, b) => a - b);
    const trimmed = sorted.slice(1, -1);
    return Math.round(trimmed.reduce((s, v) => s + v, 0) / trimmed.length);
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
    for (const row of history) {
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
            days.push({ dateKey, skipped: true, reason: 'protected', hourly: [] });
            continue;
        }
        const wd = dayOfWeek(dateKey, timeZone);
        const peers = byWeekday.get(wd) || [];
        let hourly = averageHourly(peers);
        const adjPct = Number(adjustments[dateKey]);
        if (Number.isFinite(adjPct) && adjPct !== 0) {
            hourly = hourly.map((v) => Math.max(0, Math.round(v * (1 + adjPct / 100))));
        }
        const total = hourly.reduce((s, v) => s + v, 0);
        days.push({
            dateKey,
            weekday: wd,
            skipped: false,
            hourly,
            total,
            peerDays: peers.length,
        });
    }

    return {
        storeNumber,
        generatedAt: new Date().toISOString(),
        historyDaysUsed: history.length,
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
};
