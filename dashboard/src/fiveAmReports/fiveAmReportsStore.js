const fs = require('fs');
const path = require('path');

const paths = require('../../../src/paths');

const SETTINGS_FILE = path.join(paths.dashboard.data, 'five-am-reports-config.json');
const TIME_ZONE = String(process.env.DASHBOARD_TIME_ZONE || 'Australia/Melbourne').trim();

function defaultSettings() {
    return {
        stores: {},
        lastRunByStore: {},
        lastEmailByStore: {},
        defaults: {
            enabled: false,
            buildToEnabled: false,
            prepGuideEnabled: false,
            ordersEnabled: false,
        },
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
            lastEmailByStore:
                raw.lastEmailByStore && typeof raw.lastEmailByStore === 'object'
                    ? raw.lastEmailByStore
                    : {},
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
    return getStoreJobFlags(storeNumber).stockEnabled;
}

function getStoreJobFlags(storeNumber) {
    const store = String(storeNumber || '').trim();
    const empty = {
        stockEnabled: false,
        buildToEnabled: false,
        prepGuideEnabled: false,
        ordersEnabled: false,
    };
    if (!store) return empty;
    const doc = readSettingsDoc();
    const entry = doc.stores[store] && typeof doc.stores[store] === 'object' ? doc.stores[store] : {};
    const stock =
        typeof entry.enabled === 'boolean'
            ? entry.enabled
            : typeof entry.stockEnabled === 'boolean'
              ? entry.stockEnabled
              : Boolean(doc.defaults?.enabled);
    return {
        stockEnabled: stock,
        buildToEnabled:
            typeof entry.buildToEnabled === 'boolean'
                ? entry.buildToEnabled
                : Boolean(doc.defaults?.buildToEnabled),
        prepGuideEnabled:
            typeof entry.prepGuideEnabled === 'boolean'
                ? entry.prepGuideEnabled
                : Boolean(doc.defaults?.prepGuideEnabled),
        ordersEnabled:
            typeof entry.ordersEnabled === 'boolean'
                ? entry.ordersEnabled
                : Boolean(doc.defaults?.ordersEnabled),
    };
}

function setStoreEnabled(storeNumber, enabled, updatedBy = null) {
    return setStoreJobFlag(storeNumber, 'stockEnabled', enabled, updatedBy);
}

function setStoreJobFlag(storeNumber, flag, enabled, updatedBy = null) {
    const store = String(storeNumber || '').trim();
    if (!store) throw new Error('storeNumber is required.');
    const key = String(flag || '').trim();
    const allowed = new Set(['stockEnabled', 'buildToEnabled', 'prepGuideEnabled', 'ordersEnabled']);
    if (!allowed.has(key) && key !== 'enabled') {
        throw new Error(`Unknown daily job flag: ${key}`);
    }

    const doc = readSettingsDoc();
    const prev = doc.stores[store] && typeof doc.stores[store] === 'object' ? doc.stores[store] : {};
    const next = { ...prev };
    if (key === 'stockEnabled' || key === 'enabled') {
        next.enabled = Boolean(enabled);
        next.stockEnabled = Boolean(enabled);
    } else {
        next[key] = Boolean(enabled);
    }
    next.updatedAt = new Date().toISOString();
    next.updatedBy = updatedBy ? String(updatedBy).trim() : null;
    doc.stores[store] = next;
    doc.updatedAt = next.updatedAt;
    writeSettingsDoc(doc);
    return getStoreJobFlags(store);
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

function getLastEmailAt(storeNumber) {
    const store = String(storeNumber || '').trim();
    if (!store) return null;
    const doc = readSettingsDoc();
    const raw = doc.lastEmailByStore?.[store];
    if (!raw) return null;
    if (typeof raw === 'object' && raw.at) {
        const date = new Date(raw.at);
        return Number.isNaN(date.getTime()) ? null : date.toISOString();
    }
    const date = new Date(String(raw).trim());
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function setLastEmail(storeNumber, at = new Date(), meta = {}) {
    const store = String(storeNumber || '').trim();
    if (!store) return;
    const doc = readSettingsDoc();
    if (!doc.lastEmailByStore || typeof doc.lastEmailByStore !== 'object') {
        doc.lastEmailByStore = {};
    }
    const iso =
        at instanceof Date
            ? at.toISOString()
            : String(at || '').trim() || new Date().toISOString();
    doc.lastEmailByStore[store] = {
        at: iso,
        to: meta.to ? String(meta.to) : null,
        count: Number.isFinite(Number(meta.count)) ? Number(meta.count) : null,
    };
    writeSettingsDoc(doc);
}

function buildStatus(storeNumbers) {
    const doc = readSettingsDoc();
    const stores = {};
    const jobs = {};
    const lastRun = {};
    const lastRunAt = {};
    const lastEmailAt = {};
    for (const storeNumber of storeNumbers || []) {
        const store = String(storeNumber || '').trim();
        if (!store) continue;
        const flags = getStoreJobFlags(store);
        stores[store] = flags.stockEnabled;
        jobs[store] = flags;
        lastRun[store] = getLastRun(store);
        lastRunAt[store] = getLastRunAt(store);
        lastEmailAt[store] = getLastEmailAt(store);
    }
    return {
        stores,
        jobs,
        lastRun,
        lastRunAt,
        lastEmailAt,
        defaults: {
            enabled: Boolean(doc.defaults?.enabled),
            buildToEnabled: Boolean(doc.defaults?.buildToEnabled),
            prepGuideEnabled: Boolean(doc.defaults?.prepGuideEnabled),
            ordersEnabled: Boolean(doc.defaults?.ordersEnabled),
        },
        timeZone: doc.timeZone || TIME_ZONE,
    };
}

module.exports = {
    SETTINGS_FILE,
    isStoreEnabled,
    setStoreEnabled,
    getStoreJobFlags,
    setStoreJobFlag,
    listEnabledStores,
    getLastRun,
    getLastRunAt,
    setLastRun,
    getLastEmailAt,
    setLastEmail,
    buildStatus,
};
