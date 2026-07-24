const { normalizeItemCode } = require('./reportReader');
const { allLookupKeys } = require('./itemCodes');
const { stockCountDisplayName } = require('./stockCountDisplayNames');
const fs = require('fs');
const path = require('path');
const paths = require('../../src/paths');

const OVERRIDES_PATH =
    process.env.BUILD_TO_ADMIN_OVERRIDES_PATH ||
    path.join(paths.vendors.config, 'build-to-admin-overrides.json');

function normalizeItemName(name) {
    return String(name || '')
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeIgnoreList(raw) {
    const list = Array.isArray(raw) ? raw : String(raw || '').split(/\r?\n/);
    const out = [];
    const seenNames = new Set();
    const seenCodes = new Set();
    for (const part of list) {
        const entry = String(part || '').trim();
        if (!entry) continue;
        const code = normalizeItemCode(entry);
        if (/^\d{3,10}$/.test(code)) {
            if (seenCodes.has(code)) continue;
            seenCodes.add(code);
            out.push(code);
            continue;
        }
        const key = normalizeItemName(entry);
        if (!key || seenNames.has(key)) continue;
        seenNames.add(key);
        out.push(entry);
    }
    return out;
}

function readIgnoreListFromSettings() {
    try {
        if (!fs.existsSync(OVERRIDES_PATH)) return [];
        const raw = JSON.parse(fs.readFileSync(OVERRIDES_PATH, 'utf8'));
        if (Array.isArray(raw.settings?.ignoreList)) {
            return normalizeIgnoreList(raw.settings.ignoreList);
        }
    } catch {
        /* ignore */
    }
    return [];
}

function getIgnoreListMatchers() {
    const codes = new Set();
    const names = new Set();
    for (const entry of readIgnoreListFromSettings()) {
        const code = normalizeItemCode(entry);
        if (/^\d{3,10}$/.test(code)) {
            codes.add(code);
            continue;
        }
        const key = normalizeItemName(entry);
        if (key) names.add(key);
    }
    return { codes, names };
}

function getIgnoreList() {
    return readIgnoreListFromSettings();
}

function isOnIgnoreList(item) {
    if (!item) return false;
    const { codes, names } = getIgnoreListMatchers();
    const itemCode = normalizeItemCode(item.itemCode || '');
    const iseCode = normalizeItemCode(item.iseItemCode || '');
    if (itemCode && codes.has(itemCode)) return true;
    if (iseCode && codes.has(iseCode)) return true;
    for (const key of allLookupKeys(itemCode || iseCode)) {
        const alias = normalizeItemCode(key);
        if (alias && codes.has(alias)) return true;
    }
    const description = item.description || item.name || '';
    const descKey = normalizeItemName(description);
    if (descKey && names.has(descKey)) return true;
    const display = stockCountDisplayName(itemCode || iseCode, description);
    const displayKey = normalizeItemName(display);
    if (displayKey && names.has(displayKey)) return true;
    return false;
}

module.exports = {
    normalizeIgnoreList,
    getIgnoreList,
    isOnIgnoreList,
};
