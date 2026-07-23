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

/** Save one day's hourly actuals (array of numbers, typically 5am-based). */
function upsertDay(storeNumber, dateKey, actual, meta = {}) {
    const doc = readHistory(storeNumber);
    doc.days[String(dateKey)] = {
        actual: Array.isArray(actual) ? actual.map((n) => Number(n) || 0) : [],
        source: meta.source || 'manual',
        capturedAt: new Date().toISOString(),
    };
    return writeHistory(storeNumber, doc);
}

function listDayKeys(storeNumber) {
    return Object.keys(readHistory(storeNumber).days || {}).sort();
}

function recentDays(storeNumber, count = 35) {
    const keys = listDayKeys(storeNumber).slice(-Math.max(1, count));
    const doc = readHistory(storeNumber);
    return keys.map((dateKey) => ({ dateKey, ...doc.days[dateKey] }));
}

module.exports = {
    HISTORY_DIR,
    readHistory,
    writeHistory,
    upsertDay,
    listDayKeys,
    recentDays,
};
