const fs = require('fs');
const path = require('path');

const paths = require('../../../src/paths');

const SETTINGS_FILE = path.join(paths.dashboard.data, 'five-am-reports-config.json');
const TIME_ZONE = String(process.env.DASHBOARD_TIME_ZONE || 'Australia/Melbourne').trim();

function defaultSettings() {
    return {
        stores: {},
        lastRunByStore: {},
        defaults: { enabled: false },
        timeZone: TIME_ZONE,
        updatedAt: null,
    };
}

function readSettingsDoc() {
    if (!fs.existsSync(SETTINGS_FILE)) return defaultSettings();
    try {
        const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
        const base = defaultSettings();
        return {
            ...base,
            ...raw,
            stores: raw.stores && typeof raw.stores === 'object' ? raw.stores : {},
            lastRunByStore:
                raw.lastRunByStore && typeof raw.lastRunByStore === 'object' ? raw.lastRunByStore : {},
            defaults: { ...base.defaults, ...(raw.defaults || {}) },
        };
    } catch {
        return defaultSettings();
    }
}

function writeSettingsDoc(doc) {
    fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
}

function isStoreEnabled(storeNumber) {
    const store = String(storeNumber || '').trim();
    if (!store) return false;
    const doc = readSettingsDoc();
    const entry = doc.stores[store];
    if (entry && typeof entry.enabled === 'boolean') return entry.enabled;
    return Boolean(doc.defaults?.enabled);
}

function setStoreEnabled(storeNumber, enabled, updatedBy = null) {
    const store = String(storeNumber || '').trim();
    if (!store) throw new Error('storeNumber is required.');

    const doc = readSettingsDoc();
    doc.stores[store] = {
        enabled: Boolean(enabled),
        updatedAt: new Date().toISOString(),
        updatedBy: updatedBy ? String(updatedBy).trim() : null,
    };
    doc.updatedAt = doc.stores[store].updatedAt;
    writeSettingsDoc(doc);
    return doc.stores[store];
}

function listEnabledStores() {
    const doc = readSettingsDoc();
    return Object.keys(doc.stores).filter((store) => Boolean(doc.stores[store]?.enabled));
}

function isDateKey(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '').trim());
}

function getLastRunRaw(storeNumber) {
    const store = String(storeNumber || '').trim();
    if (!store) return null;
    const doc = readSettingsDoc();
    const raw = doc.lastRunByStore[store];
    return raw ? String(raw).trim() : null;
}

function dateKeyInTimeZone(date, timeZone) {
    const tz = String(timeZone || TIME_ZONE).trim() || TIME_ZONE;
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(date);
}

/** Last run calendar day (YYYY-MM-DD) in the given timezone. */
function getLastRun(storeNumber, timeZone = TIME_ZONE) {
    const raw = getLastRunRaw(storeNumber);
    if (!raw) return null;
    if (isDateKey(raw)) return raw;
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) return null;
    return dateKeyInTimeZone(date, timeZone);
}

/** ISO timestamp of the last stock run, when available. */
function getLastRunAt(storeNumber) {
    const raw = getLastRunRaw(storeNumber);
    if (!raw) return null;
    if (isDateKey(raw)) return null;
    const date = new Date(raw);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function setLastRun(storeNumber, at) {
    const store = String(storeNumber || '').trim();
    if (!store) return;
    const doc = readSettingsDoc();
    const value =
        at instanceof Date
            ? at.toISOString()
            : isDateKey(at)
              ? String(at).trim()
              : String(at || '').trim();
    if (!value) return;
    doc.lastRunByStore[store] = value;
    writeSettingsDoc(doc);
}

function buildStatus(storeNumbers) {
    const doc = readSettingsDoc();
    const stores = {};
    const lastRun = {};
    const lastRunAt = {};
    for (const storeNumber of storeNumbers || []) {
        const store = String(storeNumber || '').trim();
        if (!store) continue;
        stores[store] = isStoreEnabled(store);
        lastRun[store] = getLastRun(store);
        lastRunAt[store] = getLastRunAt(store);
    }
    return {
        stores,
        lastRun,
        lastRunAt,
        defaults: { enabled: Boolean(doc.defaults?.enabled) },
        timeZone: doc.timeZone || TIME_ZONE,
    };
}

module.exports = {
    SETTINGS_FILE,
    isStoreEnabled,
    setStoreEnabled,
    listEnabledStores,
    getLastRun,
    getLastRunAt,
    setLastRun,
    buildStatus,
};
