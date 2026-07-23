const fs = require('fs');
const path = require('path');

const paths = require('../../../src/paths');
const { getStoreDateKey } = require('./sssgWeeklyLedger');
const SSSG_LY_DIR = path.join(paths.dashboard.data, 'sssg-lastyear');

/** @type {Map<string, { dateKey: string, slots: object[] }>} */
const sssgLyCacheByStore = new Map();

function storeStateKey(storeNumber) {
    return String(storeNumber || '').trim() || '__default__';
}

function sssgLyFilePath(storeNumber) {
    const key = String(storeNumber || '').replace(/[^0-9a-z]/gi, '');
    if (!key) return null;
    return path.join(SSSG_LY_DIR, `${key}.json`);
}

function getCachedSssgLy(storeNumber, dateKey) {
    const key = storeStateKey(storeNumber);
    const entry = sssgLyCacheByStore.get(key);
    if (entry && entry.dateKey === dateKey && Array.isArray(entry.slots) && entry.slots.length) {
        return entry.slots;
    }

    const loaded = loadSssgLyFromDisk(storeNumber, dateKey);
    return loaded;
}

function setCachedSssgLy(storeNumber, dateKey, slots) {
    const key = storeStateKey(storeNumber);
    const normalized = Array.isArray(slots) ? slots : [];
    sssgLyCacheByStore.set(key, { dateKey, slots: normalized });
    persistSssgLyToDisk(storeNumber, dateKey, normalized);
}

function loadSssgLyFromDisk(storeNumber, dateKey) {
    const filePath = sssgLyFilePath(storeNumber);
    if (!filePath || !fs.existsSync(filePath)) return null;

    try {
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (String(raw.dateKey || '') !== String(dateKey || '')) return null;
        if (!Array.isArray(raw.slots) || !raw.slots.length) return null;

        const key = storeStateKey(storeNumber);
        sssgLyCacheByStore.set(key, { dateKey, slots: raw.slots });
        return raw.slots;
    } catch {
        return null;
    }
}

function persistSssgLyToDisk(storeNumber, dateKey, slots) {
    const filePath = sssgLyFilePath(storeNumber);
    if (!filePath) return;

    try {
        fs.mkdirSync(SSSG_LY_DIR, { recursive: true });
        fs.writeFileSync(
            filePath,
            `${JSON.stringify({ dateKey, slots, capturedAt: new Date().toISOString() }, null, 2)}\n`,
            'utf8'
        );
    } catch (err) {
        console.warn(`[SSSG] Failed to persist LY cache for store ${storeNumber}:`, err.message);
    }
}

function hasSssgLyCachedToday(storeNumber, dateKey) {
    return Boolean(getCachedSssgLy(storeNumber, dateKey)?.length);
}

function sssgDateKeyForStore(storeOrNumber, now = new Date()) {
    return getStoreDateKey(storeOrNumber, now);
}

function needsSssgLyScrape(stores, _legacyDateKey) {
    if (!Array.isArray(stores) || !stores.length) return false;
    return stores.some((s) => !hasSssgLyCachedToday(s.storeNumber, sssgDateKeyForStore(s)));
}

function clearSssgLyCache(storeNumber) {
    const key = storeStateKey(storeNumber);
    sssgLyCacheByStore.delete(key);
    const filePath = sssgLyFilePath(storeNumber);
    if (filePath && fs.existsSync(filePath)) {
        try {
            fs.unlinkSync(filePath);
        } catch {
            /* ignore */
        }
    }
}

function clearAllSssgCaches() {
    sssgLyCacheByStore.clear();
    try {
        if (fs.existsSync(SSSG_LY_DIR)) {
            for (const name of fs.readdirSync(SSSG_LY_DIR)) {
                if (name.endsWith('.json')) {
                    try {
                        fs.unlinkSync(path.join(SSSG_LY_DIR, name));
                    } catch {
                        /* ignore */
                    }
                }
            }
        }
    } catch {
        /* ignore */
    }
}

function resetSssgForNewDay(storeNumber) {
    clearSssgLyCache(storeNumber);
}

module.exports = {
    SSSG_LY_DIR,
    sssgDateKeyForStore,
    getCachedSssgLy,
    setCachedSssgLy,
    loadSssgLyFromDisk,
    hasSssgLyCachedToday,
    needsSssgLyScrape,
    clearSssgLyCache,
    clearAllSssgCaches,
    resetSssgForNewDay,
};
