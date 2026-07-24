const fs = require('fs');
const path = require('path');
const paths = require('../../src/paths');

const HISTORY_DIR = path.join(paths.forecast.data, 'history');

function historyPath(storeNumber) {
    const key = String(storeNumber || '').replace(/\D/g, '');
    return path.join(HISTORY_DIR, `${key}.json`);
}

function readHistory(storeNumber) {
    const file = historyPath(storeNumber);
    if (!fs.existsSync(file)) {
        return { storeNumber: String(storeNumber || ''), days: {}, updatedAt: null };
    }
    try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        return {
            storeNumber: String(storeNumber || ''),
            days: raw.days && typeof raw.days === 'object' ? raw.days : {},
            updatedAt: raw.updatedAt || null,
        };
    } catch {
        return { storeNumber: String(storeNumber || ''), days: {}, updatedAt: null };
    }
}

function writeHistory(storeNumber, doc) {
    fs.mkdirSync(HISTORY_DIR, { recursive: true });
    const next = {
        storeNumber: String(storeNumber || ''),
        days: doc.days || {},
        updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(historyPath(storeNumber), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    return next;
}

function sumActual(actual) {
    return (Array.isArray(actual) ? actual : []).reduce((s, v) => s + (Number(v) || 0), 0);
}

/**
 * Save one day's hourly actuals.
 * Macromatix labour day-view arrays are 5AM-based (index 0 = 5:00 AM).
 * Preserves ignored unless meta.ignored is explicitly provided.
 */
function upsertDay(storeNumber, dateKey, actual, meta = {}) {
    const doc = readHistory(storeNumber);
    const key = String(dateKey);
    const prev = doc.days[key] && typeof doc.days[key] === 'object' ? doc.days[key] : {};
    const next = {
        actual: Array.isArray(actual) ? actual.map((n) => Number(n) || 0) : [],
        source: meta.source || prev.source || 'manual',
        capturedAt: new Date().toISOString(),
        ignored: Object.prototype.hasOwnProperty.call(meta, 'ignored')
            ? Boolean(meta.ignored)
            : Boolean(prev.ignored),
    };
    if (prev.note && meta.note == null) next.note = prev.note;
    if (meta.note != null) next.note = String(meta.note || '');
    doc.days[key] = next;
    return writeHistory(storeNumber, doc);
}

function setDayIgnored(storeNumber, dateKey, ignored) {
    const doc = readHistory(storeNumber);
    const key = String(dateKey);
    if (!doc.days[key]) {
        throw new Error(`No history day ${key} for store ${storeNumber}`);
    }
    doc.days[key] = {
        ...doc.days[key],
        ignored: Boolean(ignored),
        capturedAt: doc.days[key].capturedAt || new Date().toISOString(),
    };
    return writeHistory(storeNumber, doc);
}

function deleteDay(storeNumber, dateKey) {
    const doc = readHistory(storeNumber);
    const key = String(dateKey);
    if (!doc.days[key]) {
        return { ok: false, missing: true, doc };
    }
    delete doc.days[key];
    return { ok: true, doc: writeHistory(storeNumber, doc) };
}

function listDayKeys(storeNumber) {
    return Object.keys(readHistory(storeNumber).days || {}).sort();
}

function recentDays(storeNumber, count = 35) {
    const keys = listDayKeys(storeNumber).slice(-Math.max(1, count));
    const doc = readHistory(storeNumber);
    return keys.map((dateKey) => ({ dateKey, ...doc.days[dateKey] }));
}

/** Newest-first list for the history editor UI. */
function listHistoryDays(storeNumber, options = {}) {
    const limit = Math.max(1, Number(options.limit || 70) || 70);
    const doc = readHistory(storeNumber);
    const keys = Object.keys(doc.days || {})
        .sort()
        .reverse()
        .slice(0, limit);
    return keys.map((dateKey) => {
        const day = doc.days[dateKey] || {};
        const actual = Array.isArray(day.actual) ? day.actual.map((n) => Number(n) || 0) : [];
        return {
            dateKey,
            actual,
            total: Math.round(sumActual(actual) * 100) / 100,
            ignored: Boolean(day.ignored),
            source: day.source || null,
            note: day.note || '',
            capturedAt: day.capturedAt || null,
        };
    });
}

function getHistoryDay(storeNumber, dateKey) {
    const doc = readHistory(storeNumber);
    const key = String(dateKey);
    const day = doc.days[key];
    if (!day) return null;
    const actual = Array.isArray(day.actual) ? day.actual.map((n) => Number(n) || 0) : [];
    return {
        dateKey: key,
        actual,
        total: Math.round(sumActual(actual) * 100) / 100,
        ignored: Boolean(day.ignored),
        source: day.source || null,
        note: day.note || '',
        capturedAt: day.capturedAt || null,
    };
}

module.exports = {
    HISTORY_DIR,
    readHistory,
    writeHistory,
    upsertDay,
    setDayIgnored,
    deleteDay,
    listDayKeys,
    recentDays,
    listHistoryDays,
    getHistoryDay,
    sumActual,
};
