const { getStoreList } = require('../../stores/src/storeList');
const { normalizeItemCode } = require('./reportReader');
const { loadItemCodes, lookupKeysForMmx, preferAltCodesFirst } = require('./itemCodes');
const { readOverridesDoc } = require('./buildToAdminOverrides');

function normalizeAreaLabel(area) {
    return String(area || '').trim();
}

function areaForStoreNumber(storeNumber) {
    const want = String(storeNumber || '').trim();
    if (!want) return '';
    const store = getStoreList().find((row) => String(row.storeNumber) === want);
    return normalizeAreaLabel(store?.area);
}

function normalizeCodeList(raw) {
    if (!raw) return [];
    const list = Array.isArray(raw) ? raw : String(raw).split(/[,;\s]+/);
    const out = [];
    const seen = new Set();
    for (const part of list) {
        const code = normalizeItemCode(part);
        if (!code || seen.has(code)) continue;
        seen.add(code);
        out.push(code);
    }
    return out;
}

function fileGroupForCatalogCode(catalogCode) {
    const catalog = normalizeItemCode(catalogCode);
    if (!catalog) {
        return { mmxCode: '', vendorCode: '', fallbackCodes: [] };
    }
    const { byMmx, orderToMmx } = loadItemCodes();
    const mmx = orderToMmx.get(catalog) || (byMmx.has(catalog) ? catalog : catalog);
    const entry = byMmx.get(mmx);
    const aliases = entry ? [...entry.orderCodes].filter((c) => c !== mmx) : [];
    return {
        mmxCode: mmx,
        vendorCode: catalog,
        fallbackCodes: preferAltCodesFirst(aliases),
    };
}

function mergeCodeLayer(base, layer) {
    if (!layer || typeof layer !== 'object') return base;
    const next = { ...base };
    if (layer.mmxCode != null && layer.mmxCode !== '') {
        next.mmxCode = normalizeItemCode(layer.mmxCode) || next.mmxCode;
    }
    if (layer.vendorCode != null && layer.vendorCode !== '') {
        next.vendorCode = normalizeItemCode(layer.vendorCode) || '';
    }
    if (Array.isArray(layer.fallbackCodes)) {
        next.fallbackCodes = normalizeCodeList(layer.fallbackCodes);
    }
    return next;
}

function codeLayersForCatalogItem(catalogCode, options = {}) {
    const code = normalizeItemCode(catalogCode);
    const doc = readOverridesDoc();
    const store = String(options.storeNumber || '').trim();
    const area = normalizeAreaLabel(options.areaName || (store ? areaForStoreNumber(store) : ''));
    const layers = [];
    const globalRule = doc.global?.[code];
    if (globalRule) layers.push(globalRule);
    if (area && doc.areas?.[area]?.[code]) layers.push(doc.areas[area][code]);
    if (store && doc.stores?.[store]?.[code]) layers.push(doc.stores[store][code]);
    return layers;
}

/** Effective MMX / vendor / fallback codes for a catalog line (file + admin overrides). */
function effectiveItemCodeGroup(catalogCode, options = {}) {
    const catalog = normalizeItemCode(catalogCode);
    let group = fileGroupForCatalogCode(catalog);
    if (!group.mmxCode) group.mmxCode = catalog;
    if (!group.vendorCode) group.vendorCode = catalog;
    for (const layer of codeLayersForCatalogItem(catalog, options)) {
        group = mergeCodeLayer(group, layer);
    }
    return group;
}

function lookupKeysFromGroup(group) {
    const mmx = normalizeItemCode(group?.mmxCode);
    const vendor = normalizeItemCode(group?.vendorCode);
    const fallbacks = normalizeCodeList(group?.fallbackCodes);
    const ordered = [];
    const seen = new Set();
    const push = (code) => {
        const key = normalizeItemCode(code);
        if (!key || seen.has(key)) return;
        seen.add(key);
        ordered.push(key);
    };
    for (const code of fallbacks) push(code);
    if (vendor && vendor !== mmx) push(vendor);
    push(mmx);
    return preferAltCodesFirst(ordered);
}

/** Lookup keys for reports/ISE — optional storeNumber or areaName applies admin code overrides. */
function effectiveLookupKeys(catalogCode, options = {}) {
    const catalog = normalizeItemCode(catalogCode);
    if (!catalog) return [];
    const store = String(options.storeNumber || '').trim();
    const area = normalizeAreaLabel(options.areaName);
    if (!store && !area) {
        const { byMmx, orderToMmx } = loadItemCodes();
        const mmx = orderToMmx.get(catalog) || (byMmx.has(catalog) ? catalog : catalog);
        const ordered = [...lookupKeysForMmx(mmx)];
        if (!ordered.includes(catalog)) ordered.push(catalog);
        return preferAltCodesFirst([...new Set(ordered)]);
    }
    const group = effectiveItemCodeGroup(catalog, options);
    const keys = lookupKeysFromGroup(group);
    if (!keys.includes(catalog)) keys.push(catalog);
    return preferAltCodesFirst([...new Set(keys)]);
}

function codeFieldsFromLayers(catalogCode, scope = {}) {
    const code = normalizeItemCode(catalogCode);
    const fileGroup = fileGroupForCatalogCode(code);
    const doc = readOverridesDoc();
    const globalRule = doc.global?.[code] || null;
    const areaRule = scope.area ? doc.areas?.[scope.area]?.[code] || null : null;
    const storeRule = scope.store ? doc.stores?.[scope.store]?.[code] || null : null;

    const effective = effectiveItemCodeGroup(code, {
        storeNumber: scope.store || '',
        areaName: scope.area || '',
    });

    return {
        catalogCode: code,
        mmxCode: effective.mmxCode || code,
        vendorCode: effective.vendorCode || code,
        fallbackCodes: effective.fallbackCodes || [],
        catalogMmxCode: code,
        fileMmxCode: fileGroup.mmxCode || code,
        fileVendorCode: fileGroup.vendorCode || code,
        fileFallbackCodes: fileGroup.fallbackCodes || [],
        globalMmxCode: globalRule?.mmxCode != null ? normalizeItemCode(globalRule.mmxCode) : null,
        globalVendorCode: globalRule?.vendorCode != null ? normalizeItemCode(globalRule.vendorCode) : null,
        globalFallbackCodes: Array.isArray(globalRule?.fallbackCodes)
            ? normalizeCodeList(globalRule.fallbackCodes)
            : null,
        areaMmxCode: areaRule?.mmxCode != null ? normalizeItemCode(areaRule.mmxCode) : null,
        areaVendorCode: areaRule?.vendorCode != null ? normalizeItemCode(areaRule.vendorCode) : null,
        areaFallbackCodes: Array.isArray(areaRule?.fallbackCodes)
            ? normalizeCodeList(areaRule.fallbackCodes)
            : null,
        storeMmxCode: storeRule?.mmxCode != null ? normalizeItemCode(storeRule.mmxCode) : null,
        storeVendorCode: storeRule?.vendorCode != null ? normalizeItemCode(storeRule.vendorCode) : null,
        storeFallbackCodes: Array.isArray(storeRule?.fallbackCodes)
            ? normalizeCodeList(storeRule.fallbackCodes)
            : null,
    };
}

module.exports = {
    areaForStoreNumber,
    normalizeCodeList,
    fileGroupForCatalogCode,
    effectiveItemCodeGroup,
    effectiveLookupKeys,
    lookupKeysFromGroup,
    codeFieldsFromLayers,
};
