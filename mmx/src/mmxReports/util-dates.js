const DEFAULT_TZ = process.env.DASHBOARD_TIME_ZONE || 'Australia/Melbourne';

function datePartsInTimeZone(date = new Date(), timeZone = DEFAULT_TZ) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        weekday: 'long',
    }).formatToParts(date);
    const map = Object.fromEntries(parts.filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]));
    const weekdays = {
        Sunday: 0,
        Monday: 1,
        Tuesday: 2,
        Wednesday: 3,
        Thursday: 4,
        Friday: 5,
        Saturday: 6,
    };
    return {
        year: parseInt(map.year, 10),
        month: parseInt(map.month, 10),
        day: parseInt(map.day, 10),
        dayOfWeek: weekdays[map.weekday],
    };
}

function addDays(parts, delta) {
    const dt = new Date(parts.year, parts.month - 1, parts.day);
    dt.setDate(dt.getDate() + delta);
    return {
        year: dt.getFullYear(),
        month: dt.getMonth() + 1,
        day: dt.getDate(),
        dayOfWeek: dt.getDay(),
    };
}

/** Monday of the calendar week before the current week (store timezone). */
function lastWeekMonday(timeZone = DEFAULT_TZ) {
    const today = datePartsInTimeZone(new Date(), timeZone);
    const daysSinceMonday = today.dayOfWeek === 0 ? 6 : today.dayOfWeek - 1;
    const thisMonday = addDays(today, -daysSinceMonday);
    return addDays(thisMonday, -7);
}

function formatMacromatixDateTime(parts) {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const dd = String(parts.day).padStart(2, '0');
    const mon = months[parts.month - 1];
    return `${dd}-${mon}-${parts.year} 00:00:00`;
}

/** Visible date on On Order report (no time suffix). */
function formatMacromatixDate(parts) {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const dd = String(parts.day).padStart(2, '0');
    return `${dd}-${months[parts.month - 1]}-${parts.year}`;
}

function todayInTimeZone(timeZone = DEFAULT_TZ) {
    return datePartsInTimeZone(new Date(), timeZone);
}

function daysAgo(n, timeZone = DEFAULT_TZ) {
    return addDays(todayInTimeZone(timeZone), -n);
}

function daysFromNow(n, timeZone = DEFAULT_TZ) {
    return addDays(todayInTimeZone(timeZone), n);
}

/**
 * Resolve pipeline date spec: today | yesterday | tomorrow | lastWeekMonday | daysAgo:N | daysFromNow:N | literal string.
 * @param {string} spec
 * @param {{ timeZone?: string, dateOnly?: boolean }} [opts]
 */
function isoToMacromatixDate(iso, opts = {}) {
    const [y, m, d] = String(iso || '').split('-').map(Number);
    if (!y || !m || !d) return '';
    const parts = { year: y, month: m, day: d };
    return opts.dateOnly === false ? formatMacromatixDateTime(parts) : formatMacromatixDate(parts);
}

function resolveReportDate(spec, opts = {}) {
    const tz = opts.timeZone || DEFAULT_TZ;
    const fmt = opts.dateOnly ? formatMacromatixDate : formatMacromatixDateTime;

    if (spec === 'today') {
        return fmt(todayInTimeZone(tz));
    }
    if (spec === 'yesterday') {
        return fmt(daysAgo(1, tz));
    }
    if (spec === 'tomorrow') {
        return fmt(daysFromNow(1, tz));
    }
    if (!spec || spec === 'lastWeekMonday') {
        return fmt(lastWeekMonday(tz));
    }
    const ago = String(spec).match(/^daysAgo:(\d+)$/i);
    if (ago) return fmt(daysAgo(parseInt(ago[1], 10), tz));
    const ahead = String(spec).match(/^daysFromNow:(\d+)$/i);
    if (ahead) return fmt(daysFromNow(parseInt(ahead[1], 10), tz));
    return spec;
}

module.exports = {
    DEFAULT_TZ,
    datePartsInTimeZone,
    addDays,
    lastWeekMonday,
    todayInTimeZone,
    daysAgo,
    daysFromNow,
    formatMacromatixDate,
    formatMacromatixDateTime,
    isoToMacromatixDate,
    resolveReportDate,
};
