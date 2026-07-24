const { normalizeItemCode } = require('./reportReader');
const { listConfiguredVendors, getVendorCatalog } = require('./vendorCatalog');
const { lookupKeysForMmx, mmxCodeForOrderCode } = require('./itemCodes');

function registerOverrideKeys(map, itemCode, rule) {
    const raw = normalizeItemCode(itemCode);
    if (!raw || !rule) return;
    const mmx = mmxCodeForOrderCode(raw) || raw;
    const keys = new Set([raw, ...lookupKeysForMmx(mmx)]);
    for (const key of keys) {
        if (key) map.set(key, rule);
    }
}

/** Per-store build-to patches from trailing tokens on vendor catalog lines (e.g. 3811=+2). */
function buildToOverridesForStore(storeNumber) {
    const key = String(storeNumber || '').trim();
    const map = new Map();
    if (!key) return map;

    for (const vendor of listConfiguredVendors()) {
        const catalog = getVendorCatalog(vendor.slug);
        if (!catalog?.items?.length) continue;
        for (const item of catalog.items) {
            const patch = item.storeBuildTo?.[key];
            if (!patch || !item.itemCode) continue;
            registerOverrideKeys(map, item.itemCode, patch);
        }
    }

    return map;
}

function mergeBuildToRules(baseRule, override) {
    if (!override) return baseRule || null;
    if (!baseRule) return { ...override };
    return { ...baseRule, ...override };
}

module.exports = {
    buildToOverridesForStore,
    mergeBuildToRules,
};
