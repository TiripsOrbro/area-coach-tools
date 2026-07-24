const { getStoreConfig } = require('../../../stores/src/storeList');
const { listWeeklySnapshots, resolveIseWeeksDateRange, addDaysToIso } = require('./iseHistoryLedger');
const { weekdayForIso } = require('../forecast/forecastHistoryLedger');
const { isIseAverageItem, sortIseAverageItems } = require('./iseAverageItems');

function isoToDdMmYy(iso) {
    const [y, m, d] = String(iso || '').split('-').map(Number);
    if (!y || !m || !d) return '';
    return `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${String(y % 100).padStart(2, '0')}`;
}

const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
const WEEKDAY_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const DAY_LABEL_TO_INDEX = {
    sun: 0,
    sunday: 0,
    mon: 1,
    monday: 1,
    tue: 2,
    tues: 2,
    tuesday: 2,
    wed: 3,
    wednesday: 3,
    thu: 4,
    thur: 4,
    thurs: 4,
    thursday: 4,
    fri: 5,
    friday: 5,
    sat: 6,
    saturday: 6,
};

const MONTH_TO_NUM = {
    jan: 1,
    feb: 2,
    mar: 3,
    apr: 4,
    may: 5,
    jun: 6,
    jul: 7,
    aug: 8,
    sep: 9,
    oct: 10,
    nov: 11,
    dec: 12,
};

function csvEscape(value) {
    const s = value == null ? '' : String(value);
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
}

function dayLabelToWeekdayIndex(label) {
    const raw = String(label || '').trim();
    if (!raw) return null;
    const named = raw.match(
        /\b(sun(?:day)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?)\b/i
    );
    if (named) {
        const key = named[1].toLowerCase().replace(/[^a-z]/g, '');
        if (DAY_LABEL_TO_INDEX[key] != null) return DAY_LABEL_TO_INDEX[key];
    }
    const key = raw.toLowerCase().replace(/[^a-z]/g, '');
    return DAY_LABEL_TO_INDEX[key] ?? null;
}

/** Parse MMX ISE label like "Monday 20-Jul-26" / "20-Jul-2026" / ISO into YYYY-MM-DD. */
function parseIseLabelDate(label) {
    const raw = String(label || '')
        .replace(/\s+/g, ' ')
        .trim();
    if (!raw) return '';
    const iso = raw.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
    const au = raw.match(/(\d{1,2})-([A-Za-z]{3})-(\d{2,4})/);
    if (au) {
        const day = Number(au[1]);
        const month = MONTH_TO_NUM[au[2].toLowerCase()];
        let year = Number(au[3]);
        if (!month || !day || !year) return '';
        if (year < 100) year += 2000;
        return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
    return '';
}

function snapshotDayLabels(snap, labels = null) {
    if (Array.isArray(labels) && labels.length) return labels;
    return snap?.dayLabels || [];
}

/**
 * MMX ISE weeks: Day1…Day7 are the 7 days ENDING on the report/snapshot date
 * (Day7 = snap.date). Older snapshots only store Day1…Day7 text — map from that.
 */
function resolveDayIndexForWeekday(snap, weekdayIndex, labels = null) {
    if (!snap || weekdayIndex == null) return -1;
    const dayLabels = snapshotDayLabels(snap, labels);

    for (let i = 0; i < dayLabels.length; i += 1) {
        if (dayLabelToWeekdayIndex(dayLabels[i]) === weekdayIndex) return i;
    }

    for (let i = 0; i < dayLabels.length; i += 1) {
        const iso = parseIseLabelDate(dayLabels[i]);
        if (iso && weekdayForIso(iso) === weekdayIndex) return i;
    }

    const anchor = String(snap.date || '').trim();
    if (!anchor) return -1;
    const count = Math.max(dayLabels.length, 7);
    for (let i = 0; i < count; i += 1) {
        // Day1 = end-6 … Day7 = end
        if (weekdayForIso(addDaysToIso(anchor, i - (count - 1))) === weekdayIndex) return i;
    }
    return -1;
}

function weekdayDateInSnapshot(snap, weekdayIndex, labels = null) {
    const dayLabels = snapshotDayLabels(snap, labels);
    const idx = resolveDayIndexForWeekday(snap, weekdayIndex, dayLabels);
    if (idx < 0) return '';
    const fromLabel = parseIseLabelDate(dayLabels[idx]);
    if (fromLabel) return isoToDdMmYy(fromLabel);
    if (!snap?.date) return '';
    const count = Math.max(dayLabels.length, 7);
    return isoToDdMmYy(addDaysToIso(snap.date, idx - (count - 1)));
}

function pickItemValueForWeekday(snap, item, weekdayIndex) {
    if (!snap || !item || !Array.isArray(item.dayValues)) return '';
    const labels = item.dayLabels?.length ? item.dayLabels : snap.dayLabels || [];
    const idx = resolveDayIndexForWeekday(snap, weekdayIndex, labels);
    if (idx < 0 || idx >= item.dayValues.length) return '';
    const value = item.dayValues[idx];
    return value == null || value === '' ? '' : value;
}

function trimAverage(values) {
    const nums = values.map((v) => Number(v)).filter((v) => Number.isFinite(v));
    if (nums.length < 3) return '';
    const sorted = [...nums].sort((a, b) => a - b);
    const trimmed = sorted.length >= 5 ? sorted.slice(1, -1) : sorted;
    const avg = trimmed.reduce((s, v) => s + v, 0) / trimmed.length;
    return Math.round(avg * 10000) / 10000;
}

function collectItemWeekdayValues(snapshots, itemCode, weekdayIndex, weeksNeeded = 5) {
    const values = [];
    for (const snap of snapshots) {
        if (!snap) continue;
        const item = snap.items?.[itemCode];
        const picked = pickItemValueForWeekday(snap, item, weekdayIndex);
        const num = Number(picked);
        if (Number.isFinite(num)) values.push(num);
    }
    return values.slice(-weeksNeeded);
}

function buildIseTrimmedAverageCsv(storeNumber, dateRange = {}) {
    const store = String(storeNumber || '').trim();
    const cfg = getStoreConfig(store) || {};
    const storeLabel = [cfg.storeNumber || store, cfg.storeName].filter(Boolean).join(' ').trim() || store;

    const resolved = resolveIseWeeksDateRange(dateRange);
    const weeksNeeded = resolved.weeks;
    const snapshots = listWeeklySnapshots(store, dateRange, weeksNeeded);

    const itemByCode = new Map();
    for (const snap of snapshots) {
        if (!snap) continue;
        for (const [code, row] of Object.entries(snap.items || {})) {
            if (!isIseAverageItem(row)) continue;
            if (!itemByCode.has(code)) {
                itemByCode.set(code, {
                    itemCode: code,
                    description: row.description || '',
                });
            }
        }
    }
    const sortedItems = sortIseAverageItems([...itemByCode.values()]);

    const columnMeta = [];
    for (const weekday of WEEKDAY_ORDER) {
        for (let w = 0; w < weeksNeeded; w += 1) {
            const snap = snapshots[w];
            columnMeta.push({
                type: 'week',
                weekday,
                weekIndex: w,
                headerDate: snap ? weekdayDateInSnapshot(snap, weekday) : '',
            });
        }
        columnMeta.push({
            type: 'average',
            weekday,
            headerDate: `Average of ${WEEKDAY_LABELS[weekday]}s`,
        });
        columnMeta.push({ type: 'gap' });
    }

    const rows = [];
    const padRow = (cells) => {
        const row = [...cells];
        while (row.length < columnMeta.length + 3) row.push('');
        return row;
    };
    rows.push(padRow([storeLabel]));
    rows.push(padRow(['', '', ...columnMeta.map((c) => (c.type === 'week' ? c.headerDate : ''))]));
    rows.push(
        padRow([
            '',
            '',
            ...columnMeta.map((c) =>
                c.type === 'average' ? c.headerDate : c.type === 'week' ? WEEKDAY_LABELS[c.weekday] : ''
            ),
        ])
    );
    rows.push(padRow(['Item', 'Description', ...columnMeta.map(() => '')]));

    for (const meta of sortedItems) {
        const code = meta.itemCode;
        const line = [code, meta.description || ''];
        for (const col of columnMeta) {
            if (col.type === 'gap') {
                line.push('');
            } else if (col.type === 'average') {
                const vals = collectItemWeekdayValues(snapshots, code, col.weekday, weeksNeeded);
                line.push(trimAverage(vals));
            } else {
                const snap = snapshots[col.weekIndex];
                const item = snap?.items?.[code];
                line.push(pickItemValueForWeekday(snap, item, col.weekday));
            }
        }
        rows.push(line);
    }

    return rows.map((row) => row.map(csvEscape).join(',')).join('\n');
}

/**
 * One CSV for multiple stores: each store block (label, headers, items) separated by a blank row.
 */
function buildCombinedIseTrimmedAverageCsv(storeNumbers, dateRange = {}) {
    const sections = [];
    for (const storeNumber of storeNumbers || []) {
        const store = String(storeNumber || '').trim();
        if (!store) continue;
        sections.push(buildIseTrimmedAverageCsv(store, dateRange).trimEnd());
    }
    if (!sections.length) return '';
    if (sections.length === 1) return `${sections[0]}\n`;
    return `${sections.join('\n\n')}\n`;
}

module.exports = {
    buildIseTrimmedAverageCsv,
    buildCombinedIseTrimmedAverageCsv,
    trimAverage,
    collectItemWeekdayValues,
    resolveDayIndexForWeekday,
    dayLabelToWeekdayIndex,
    parseIseLabelDate,
};
