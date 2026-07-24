const fs = require('fs');
const path = require('path');
const { normalizeItemCode } = require('./reportReader');
const { requireLivePiOrderingData, resolvePiLiveFile } = require('./piLiveDataPaths');

const paths = require('../../src/paths');
const ORDERING_DEFAULTS_PATH = path.join(paths.vendors.config, 'ordering-defaults.json');
const ORDERING_DEFAULTS_EXAMPLE = path.join(paths.vendors.config, 'ordering-defaults.json.example');

const FALLBACK_DEFAULTS = {
    buildTo: {
        defaultDays: 10,
        extendedDays: 13,
        saladDays: 7,
        saladNamePattern:
            '\\blettuce\\b|\\btomato\\b|\\bonion\\b|\\bcorriander\\b|\\bcoriander\\b|\\bpico de gallo\\b|\\bsalad\\b',
        extendedItemCodes: ['39520', '37923', '37925', '37927', '37928', '37891', '39009', '40109'],
    },
    orderReminders: {
        monday: ['Cash Order'],
        lastMondayOfMonth: ['Eco Lab', 'Reward', 'Franke', 'Staples'],
    },
    lastMondayOnlyVendors: ['Eco Lab', 'Reward', 'Franke', 'Staples'],
};

let defaultsCache = null;
let defaultsMtime = 0;
let saladNameReCache = null;
let extendedItemCodesCache = null;
let lastMondayOnlyKeysCache = null;
let missingDefaultsWarned = false;

function readJsonFile(filePath) {
    if (!filePath || !fs.existsSync(filePath)) return null;
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
        return null;
    }
}

function loadOrderingDefaultsDoc() {
    if (defaultsCache && !defaultsMtime) return defaultsCache;

    const file = resolvePiLiveFile({
        livePath: ORDERING_DEFAULTS_PATH,
        examplePath: ORDERING_DEFAULTS_EXAMPLE,
        label: 'ordering defaults',
    });
    if (!file) {
        if (requireLivePiOrderingData() && !missingDefaultsWarned) {
            missingDefaultsWarned = true;
            console.warn(
                `[ordering] Missing ${ORDERING_DEFAULTS_PATH} — using embedded fallbacks until configured.`
            );
        }
        defaultsCache = { ...FALLBACK_DEFAULTS };
        defaultsMtime = 0;
        return defaultsCache;
    }

    try {
        const stat = fs.statSync(file);
        if (defaultsCache && stat.mtimeMs === defaultsMtime) return defaultsCache;
        const raw = readJsonFile(file);
        defaultsCache = {
            buildTo: { ...FALLBACK_DEFAULTS.buildTo, ...(raw?.buildTo || {}) },
            orderReminders: {
                ...FALLBACK_DEFAULTS.orderReminders,
                ...(raw?.orderReminders || {}),
            },
            lastMondayOnlyVendors: Array.isArray(raw?.lastMondayOnlyVendors)
                ? raw.lastMondayOnlyVendors
                : FALLBACK_DEFAULTS.lastMondayOnlyVendors,
        };
        defaultsMtime = stat.mtimeMs;
        saladNameReCache = null;
        extendedItemCodesCache = null;
        lastMondayOnlyKeysCache = null;
        missingDefaultsWarned = false;
        return defaultsCache;
    } catch {
        defaultsCache = { ...FALLBACK_DEFAULTS };
        defaultsMtime = 0;
        return defaultsCache;
    }
}

function invalidateOrderingDefaultsCache() {
    defaultsCache = null;
    defaultsMtime = 0;
    saladNameReCache = null;
    extendedItemCodesCache = null;
    lastMondayOnlyKeysCache = null;
    missingDefaultsWarned = false;
}

function getBuildToDefaults() {
    const doc = loadOrderingDefaultsDoc();
    return doc.buildTo || FALLBACK_DEFAULTS.buildTo;
}

function getDefaultBuildToDays() {
    const n = Number(getBuildToDefaults().defaultDays);
    return Number.isFinite(n) && n > 0 ? n : FALLBACK_DEFAULTS.buildTo.defaultDays;
}

function getExtendedBuildToDays() {
    const n = Number(getBuildToDefaults().extendedDays);
    return Number.isFinite(n) && n > 0 ? n : FALLBACK_DEFAULTS.buildTo.extendedDays;
}

function getSaladBuildToDays() {
    const n = Number(getBuildToDefaults().saladDays);
    return Number.isFinite(n) && n > 0 ? n : FALLBACK_DEFAULTS.buildTo.saladDays;
}

function getSaladNamePattern() {
    const pattern = String(getBuildToDefaults().saladNamePattern || '').trim();
    return pattern || FALLBACK_DEFAULTS.buildTo.saladNamePattern;
}

function getSaladNameRegExp() {
    if (saladNameReCache) return saladNameReCache;
    try {
        saladNameReCache = new RegExp(getSaladNamePattern(), 'i');
    } catch {
        saladNameReCache = new RegExp(FALLBACK_DEFAULTS.buildTo.saladNamePattern, 'i');
    }
    return saladNameReCache;
}

function isSaladItem(description) {
    return getSaladNameRegExp().test(String(description || ''));
}

function getExtendedBuildToItemCodes() {
    if (extendedItemCodesCache) return extendedItemCodesCache;
    const raw = getBuildToDefaults().extendedItemCodes;
    const list = Array.isArray(raw) ? raw : FALLBACK_DEFAULTS.buildTo.extendedItemCodes;
    extendedItemCodesCache = new Set(list.map(normalizeItemCode).filter(Boolean));
    return extendedItemCodesCache;
}

function buildToDaysForItemDefaults(itemCode, description) {
    if (isSaladItem(description)) return getSaladBuildToDays();
    return getExtendedBuildToItemCodes().has(normalizeItemCode(itemCode))
        ? getExtendedBuildToDays()
        : getDefaultBuildToDays();
}

function normalizeVendorMatchKey(label) {
    return String(label || '').replace(/\s+/g, '').toLowerCase();
}

function getLastMondayOnlyVendorKeys() {
    if (lastMondayOnlyKeysCache) return lastMondayOnlyKeysCache;
    const doc = loadOrderingDefaultsDoc();
    const list = Array.isArray(doc.lastMondayOnlyVendors)
        ? doc.lastMondayOnlyVendors
        : FALLBACK_DEFAULTS.lastMondayOnlyVendors;
    lastMondayOnlyKeysCache = list.map(normalizeVendorMatchKey).filter(Boolean);
    return lastMondayOnlyKeysCache;
}

function matchesLastMondayOnlyVendor(label) {
    const key = normalizeVendorMatchKey(label);
    if (!key) return false;
    return getLastMondayOnlyVendorKeys().includes(key);
}

function getOrderReminders() {
    const doc = loadOrderingDefaultsDoc();
    const reminders = doc.orderReminders || FALLBACK_DEFAULTS.orderReminders;
    return {
        monday: Array.isArray(reminders.monday) ? reminders.monday.map(String) : [],
        lastMondayOfMonth: Array.isArray(reminders.lastMondayOfMonth)
            ? reminders.lastMondayOfMonth.map(String)
            : [],
    };
}

function getOrderRemindersForApi() {
    return getOrderReminders();
}

function filterVisiblePendingVendors(pendingVendors = [], { lastMondayOfMonth = false } = {}) {
    const list = Array.isArray(pendingVendors) ? pendingVendors.map(String) : [];
    return list.filter((v) => {
        if (!lastMondayOfMonth && matchesLastMondayOnlyVendor(v)) return false;
        return true;
    });
}

module.exports = {
    requireLivePiOrderingData,
    resolvePiLiveFile,
    loadOrderingDefaultsDoc,
    invalidateOrderingDefaultsCache,
    getBuildToDefaults,
    getDefaultBuildToDays,
    getExtendedBuildToDays,
    getSaladBuildToDays,
    getSaladNamePattern,
    isSaladItem,
    getExtendedBuildToItemCodes,
    buildToDaysForItemDefaults,
    getLastMondayOnlyVendorKeys,
    matchesLastMondayOnlyVendor,
    getOrderReminders,
    getOrderRemindersForApi,
    filterVisiblePendingVendors,
    ORDERING_DEFAULTS_PATH,
    ORDERING_DEFAULTS_EXAMPLE,
    FALLBACK_DEFAULTS,
};
