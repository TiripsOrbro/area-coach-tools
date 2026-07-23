const { getStoreConfig } = require('../../../stores/src/storeList');
const {
    readStoreHistory,
    dailyRowsFromHistory,
    weekdayForIso,
    addDaysToIso,
    sumHourly,
    formatHourLabel,
    WEEKDAY_LABELS,
} = require('../forecast/forecastHistoryLedger');
const { RAW_BASE_HOUR } = require('../salesProgress');

const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

function isoToDdMmYyyy(iso) {
    const [y, m, d] = String(iso || '').split('-').map(Number);
    if (!y || !m || !d) return '';
    return `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}`;
}

function csvEscape(value) {
    const s = value == null ? '' : String(value);
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
}

function datesInRange(startDate, endDate) {
    const out = [];
    let cur = String(startDate || '').trim();
    const end = String(endDate || '').trim();
    while (cur && end && cur <= end) {
        out.push(cur);
        cur = addDaysToIso(cur, 1);
    }
    return out;
}

function hourIntervalLabel(hour) {
    const h = Number(hour);
    const next = h + 1;
    const start = h === 0 ? '00:00' : `${h}:00`;
    const end = next === 24 ? '24:00' : `${next}:00`;
    return `${start}-${end}`;
}

function getHourlyForDate(doc, dateKey, hour) {
    const day = doc.days?.[dateKey] || doc.archive?.[dateKey];
    if (!day) return '';
    const h = Number(hour);
    if (day.actualRaw && Array.isArray(day.actualRaw)) {
        const idx = h - RAW_BASE_HOUR;
        if (idx < 0 || idx >= day.actualRaw.length) return '';
        const v = Number(day.actualRaw[idx]);
        return Number.isFinite(v) ? v : '';
    }
    if (Array.isArray(day.actual)) {
        const open = Number(day.openHour);
        const idx = h - open;
        if (idx < 0 || idx >= day.actual.length) return '';
        const v = Number(day.actual[idx]);
        return Number.isFinite(v) ? v : '';
    }
    return '';
}

function trimWeekdayHourlyValues(dayEntries, hour) {
    const values = dayEntries
        .map(({ dateKey, doc }) => {
            const v = getHourlyForDate(doc, dateKey, hour);
            return Number(v);
        })
        .filter((v) => Number.isFinite(v));
    if (values.length < 3) return '';
    const sorted = [...values].sort((a, b) => a - b);
    const trimmed = sorted.length >= 5 ? sorted.slice(1, -1) : sorted;
    const avg = trimmed.reduce((s, v) => s + v, 0) / trimmed.length;
    return Math.round(avg * 100) / 100;
}

function buildWeekdayColumns(allDates, weekday, maxWeeks = 5) {
    const dates = allDates.filter((d) => weekdayForIso(d) === weekday);
    const picked = dates.slice(-maxWeeks);
    while (picked.length < maxWeeks) picked.unshift('');
    return picked;
}

/**
 * Build Historical Hourly Sales CSV for one store (weekday-grouped layout).
 */
function buildHistoricalHourlySalesCsv(storeNumber, dateRange = {}) {
    const store = String(storeNumber || '').trim();
    const cfg = getStoreConfig(store) || {};
    const storeLabel = [cfg.storeNumber || store, cfg.storeName].filter(Boolean).join(' ').trim() || store;
    const doc = readStoreHistory(store);
    const timeZone = doc.timeZone || cfg.timeZone || 'Australia/Melbourne';

    const startDate = String(dateRange.startDate || '').trim();
    const endDate = String(dateRange.endDate || '').trim();
    const allDates = datesInRange(startDate, endDate);

    const columnMeta = [];
    for (const weekday of WEEKDAY_ORDER) {
        const dates = buildWeekdayColumns(allDates, weekday, 5);
        for (const dateKey of dates) {
            columnMeta.push({
                type: 'date',
                weekday,
                dateKey,
                headerDate: dateKey ? isoToDdMmYyyy(dateKey) : '',
            });
        }
        columnMeta.push({
            type: 'average',
            weekday,
            headerDate: `Average of ${WEEKDAY_LABELS[weekday]}s`,
        });
    }

    const padRow = (cells) => {
        const row = [...cells];
        while (row.length < columnMeta.length + 1) row.push('');
        return row;
    };

    const rows = [];
    rows.push(padRow([storeLabel]));
    rows.push(padRow([isoToDdMmYyyy(startDate)]));
    rows.push(padRow(['', isoToDdMmYyyy(endDate)]));

    const rowDateHeaders = [''];
    for (const col of columnMeta) rowDateHeaders.push(col.type === 'average' ? '' : 'Date');
    rows.push(padRow(rowDateHeaders));

    const rowWeekdays = [''];
    for (const col of columnMeta) {
        rowWeekdays.push(col.type === 'average' ? col.headerDate : WEEKDAY_LABELS[col.weekday]);
    }
    rows.push(padRow(rowWeekdays));

    const rowDates = [''];
    for (const col of columnMeta) {
        rowDates.push(col.type === 'average' ? '' : col.headerDate);
    }
    rows.push(padRow(rowDates));

    for (let hour = 0; hour < 24; hour += 1) {
        const line = [hourIntervalLabel(hour)];
        for (const col of columnMeta) {
            if (col.type === 'average') {
                const dayEntries = buildWeekdayColumns(allDates, col.weekday, 5)
                    .filter(Boolean)
                    .map((dateKey) => ({ dateKey, doc }));
                line.push(trimWeekdayHourlyValues(dayEntries, hour));
            } else if (!col.dateKey) {
                line.push('');
            } else {
                line.push(getHourlyForDate(doc, col.dateKey, hour));
            }
        }
        rows.push(line);
    }

    void timeZone;
    return rows.map((row) => row.map(csvEscape).join(',')).join('\n');
}

function assessHourlySalesCoverage(storeNumber, dateRange = {}) {
    const store = String(storeNumber || '').trim();
    const startDate = String(dateRange.startDate || '').trim();
    const endDate = String(dateRange.endDate || '').trim();
    const allDates = datesInRange(startDate, endDate);
    const doc = readStoreHistory(store);
    const missing = [];
    let present = 0;
    for (const dateKey of allDates) {
        const day = doc.days?.[dateKey] || doc.archive?.[dateKey];
        const total = day ? Number(day.actualTotal) || sumHourly(day.actual) : 0;
        if (day && total > 0) present += 1;
        else missing.push(dateKey);
    }
    return {
        storeNumber: store,
        startDate,
        endDate,
        totalDays: allDates.length,
        presentDays: present,
        missingDays: missing,
        ready: missing.length === 0 && allDates.length > 0,
    };
}

module.exports = {
    buildHistoricalHourlySalesCsv,
    assessHourlySalesCoverage,
    datesInRange,
    isoToDdMmYyyy,
};
