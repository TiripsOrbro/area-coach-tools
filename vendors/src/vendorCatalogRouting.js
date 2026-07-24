const { normalizeItemCode } = require('./reportReader');
const { getAllVendorDefinitions, readCatalogForDefinitionInternal } = require('./vendorCatalog');
const {
    applyAdminCatalogOverrides,
    effectiveCatalogItemFields,
    effectiveSkipStockCount,
} = require('./buildToAdminOverrides');

/**
 * Build stock-count item list for a vendor tab, including items routed from other catalogs.
 */
function buildRoutedStockCountItems(targetSlug, storeNumber) {
    const slug = String(targetSlug || '').trim().toLowerCase();
    const store = String(storeNumber || '').trim();
    if (!slug || !store) return [];

    const items = [];
    const seenCodes = new Set();

    for (const def of getAllVendorDefinitions()) {
        const catalog = readCatalogForDefinitionInternal(def);
        if (!catalog?.items?.length) continue;
        const applied = applyAdminCatalogOverrides(catalog, store, def.slug);
        for (const item of applied.items) {
            const code = normalizeItemCode(item.itemCode);
            if (!code || seenCodes.has(code)) continue;
            const fields = effectiveCatalogItemFields(item, {
                storeNumber: store,
                catalogVendorSlug: def.slug,
            });
            if (fields.effectiveVendorSlug !== slug) continue;
            seenCodes.add(code);
            items.push({
                ...item,
                unitSlots: fields.unitSlots,
                columns: fields.columns,
                innerPerCarton: fields.innerPerCarton,
                unitsPerPack: fields.unitsPerPack,
                effectiveVendorSlug: fields.effectiveVendorSlug,
                catalogVendorSlug: def.slug,
                sourceVendorSlug: def.slug,
            });
        }
    }

    return items;
}

function buildRoutedDailyCountItems(targetSlug, storeNumber) {
    return buildRoutedStockCountItems(targetSlug, storeNumber).filter(
        (item) => !item.skipStockCount && item.includeDaily
    );
}

module.exports = {
    buildRoutedStockCountItems,
    buildRoutedDailyCountItems,
};
