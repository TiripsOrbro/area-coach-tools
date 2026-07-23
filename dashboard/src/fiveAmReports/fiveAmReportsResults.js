const fs = require('fs');
const path = require('path');

const paths = require('../../../src/paths');
const { reportDateKeyFromFilename } = require('../../../vendors/src/reportReader');

const RESULTS_DIR = path.join(paths.dashboard.data, 'five-am-reports');
const REPORTS_DIR = paths.vendors.reports;

function resultsFilePath(dateKey) {
    return path.join(RESULTS_DIR, `${String(dateKey || '').trim()}.json`);
}

function readResultsDoc(dateKey) {
    const file = resultsFilePath(dateKey);
    if (!fs.existsSync(file)) return {};
    try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        return raw && typeof raw === 'object' ? raw : {};
    } catch {
        return {};
    }
}

/**
 * Persist a store's computed stock-levels result for both modes for a given day.
 * payload: { withOnOrder: {...summary}, onHandOnly: {...summary} }
 */
function writeStoreResult(dateKey, storeNumber, payload) {
    const store = String(storeNumber || '').trim();
    const key = String(dateKey || '').trim();
    if (!store || !key) return;
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
    const doc = readResultsDoc(key);
    doc[store] = {
        ...payload,
        savedAt: new Date().toISOString(),
    };
    fs.writeFileSync(resultsFilePath(key), `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
}

function readStoreResult(dateKey, storeNumber) {
    const store = String(storeNumber || '').trim();
    if (!store) return null;
    const doc = readResultsDoc(dateKey);
    return doc[store] || null;
}

/** Delete every saved daily results file except the day we want to keep. */
function purgeOldResults(keepDateKey) {
    const keep = `${String(keepDateKey || '').trim()}.json`;
    if (!fs.existsSync(RESULTS_DIR)) return { removed: [] };
    const removed = [];
    for (const name of fs.readdirSync(RESULTS_DIR)) {
        if (!name.endsWith('.json') || name === keep) continue;
        try {
            fs.unlinkSync(path.join(RESULTS_DIR, name));
            removed.push(name);
        } catch {
            /* ignore */
        }
    }
    return { removed };
}

/** Delete a store's downloaded report files from days other than today (keep today's for the tile). */
function purgeOldReportFiles(storeNumber, keepDateKey) {
    const store = String(storeNumber || '').trim();
    const keep = String(keepDateKey || '').trim();
    const storeDir = path.join(REPORTS_DIR, store);
    if (!store || !fs.existsSync(storeDir)) return { removed: [] };
    const removed = [];
    for (const name of fs.readdirSync(storeDir)) {
        const filePath = path.join(storeDir, name);
        try {
            if (!fs.statSync(filePath).isFile()) continue;
        } catch {
            continue;
        }
        const day = reportDateKeyFromFilename(name);
        // Only remove files we can date and that are from a previous day.
        if (!day || day === keep) continue;
        try {
            fs.unlinkSync(filePath);
            removed.push(name);
        } catch {
            /* ignore */
        }
    }
    return { removed };
}

module.exports = {
    RESULTS_DIR,
    writeStoreResult,
    readStoreResult,
    purgeOldResults,
    purgeOldReportFiles,
};
