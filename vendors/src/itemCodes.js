const fs = require('fs');
const path = require('path');
const { normalizeItemCode } = require('./reportReader');

const paths = require('../../src/paths');
const ITEM_CODES_PATH = path.join(paths.vendors.catalogs, '.item-codes');
const ITEM_CODES_EXAMPLE = path.join(paths.vendors.root, 'examples', '.item-codes.example');

let cache = null;

function isAltACode(code) {
    return /A$/.test(String(code || '').toUpperCase());
}

function preferAltCodesFirst(codes) {
    return [...codes].sort((a, b) => {
        const aAlt = isAltACode(a);
        const bAlt = isAltACode(b);
        if (aAlt !== bAlt) return aAlt ? -1 : 1;
        return 0;
    });
}

function parseItemCodesText(text) {
    const byMmx = new Map();
    const orderToMmx = new Map();
    const byName = new Map();

    for (const rawLine of String(text || '').split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;

        const parts = line.split('|').map((p) => p.trim());
        if (parts.length < 2) continue;

        const name = parts[0];
        const mmxCode = normalizeItemCode(parts[1]);
        const orderCode = normalizeItemCode(parts[2] || parts[1]);
        if (!mmxCode || !orderCode || orderCode === mmxCode) continue;

        if (!byMmx.has(mmxCode)) {
            byMmx.set(mmxCode, { name, mmxCode, orderCodes: new Set() });
        }
        const entry = byMmx.get(mmxCode);
        if (name) entry.name = name;
        entry.orderCodes.add(orderCode);

        orderToMmx.set(orderCode, mmxCode);
        if (name) {
            byName.set(name.toLowerCase(), mmxCode);
        }
    }

    return { byMmx, orderToMmx, byName };
}

function loadItemCodes() {
    if (cache) return cache;
    const file = fs.existsSync(ITEM_CODES_PATH) ? ITEM_CODES_PATH : ITEM_CODES_EXAMPLE;
    if (!fs.existsSync(file)) {
        cache = { byMmx: new Map(), orderToMmx: new Map(), byName: new Map(), loaded: false };
        return cache;
    }
    cache = { ...parseItemCodesText(fs.readFileSync(file, 'utf8')), loaded: true, source: path.basename(file) };
    return cache;
}

/** All report/order lookup keys for an ISE (MMX) item code - MMX code plus any order-form aliases. */
function lookupKeysForMmx(mmxItemCode) {
    const mmx = normalizeItemCode(mmxItemCode);
    if (!mmx) return [];

    const { byMmx } = loadItemCodes();
    const entry = byMmx.get(mmx);
    if (!entry) return [mmx];

    // Prefer alias/order-form codes first, then fall back to base MMX code.
    const aliases = [...entry.orderCodes].filter((c) => c !== mmx);
    return preferAltCodesFirst([...aliases, mmx]);
}

function mmxCodeForOrderCode(orderCode) {
    const key = normalizeItemCode(orderCode);
    if (!key) return null;
    const { orderToMmx, byMmx } = loadItemCodes();
    if (orderToMmx.has(key)) return orderToMmx.get(key);
    if (byMmx.has(key)) return key;
    return null;
}

/** Canonical catalog / KIC code for any code in a cross-reference group. */
function canonicalItemCode(itemCode) {
    const key = normalizeItemCode(itemCode);
    if (!key) return null;
    return mmxCodeForOrderCode(key) || key;
}

/** All lookup keys for a catalog line or a raw report row code. Optional storeNumber applies admin overrides. */
function allLookupKeys(itemCode, storeNumber) {
    const store = String(storeNumber || '').trim();
    if (store) {
        const { effectiveLookupKeys } = require('./itemCodeOverrides');
        return effectiveLookupKeys(itemCode, { storeNumber: store });
    }
    const raw = normalizeItemCode(itemCode);
    if (!raw) return [];
    const mmx = mmxCodeForOrderCode(raw) || raw;
    const ordered = [...lookupKeysForMmx(mmx)];
    if (!ordered.includes(raw)) ordered.push(raw);
    return preferAltCodesFirst([...new Set(ordered)]);
}

function reportRowQuantity(row) {
    const qty = Number(row?.quantity);
    return Number.isFinite(qty) ? qty : 0;
}

/** First alias row with qty > 0; if all matches are zero, return the first zero row. */
function findInReportMap(reportMap, itemCode, storeNumber) {
    if (!reportMap) return null;
    let zeroHit = null;
    for (const key of allLookupKeys(itemCode, storeNumber)) {
        const row = reportMap.get(key);
        if (!row) continue;
        if (reportRowQuantity(row) > 0) return { key, row };
        if (!zeroHit) zeroHit = { key, row };
    }
    return zeroHit;
}

function clearItemCodesCache() {
    cache = null;
}

module.exports = {
    loadItemCodes,
    lookupKeysForMmx,
    mmxCodeForOrderCode,
    canonicalItemCode,
    allLookupKeys,
    findInReportMap,
    reportRowQuantity,
    parseItemCodesText,
    clearItemCodesCache,
    preferAltCodesFirst,
    ITEM_CODES_PATH,
};
