const { getVendorCatalog, vendorLabelToSlug } = require('./vendorCatalog');

const COMBINED_VENDOR_SLUG = 'combined';

function vendorSlugsFromPendingLabels(pendingLabels) {
    const slugs = [];
    const seen = new Set();
    for (const label of pendingLabels || []) {
        const slug = vendorLabelToSlug(label);
        if (!slug || seen.has(slug)) continue;
        if (!getVendorCatalog(slug, { forStockCount: true })) continue;
        seen.add(slug);
        slugs.push(slug);
    }
    return slugs;
}

/**
 * Merge stock-count catalogs for today's pending vendors into one location-tabbed list.
 */
function buildCombinedStockCountCatalog(pendingLabels, storeNumber) {
    const vendorSlugs = vendorSlugsFromPendingLabels(pendingLabels);
    const items = [];
    const locationOrder = [];
    const seenLocs = new Set();
    const vendorLabels = [];
    const catalogOpts = { forStockCount: true, storeNumber };

    for (const slug of vendorSlugs) {
        const cat = getVendorCatalog(slug, catalogOpts);
        if (!cat) continue;
        vendorLabels.push(cat.label);

        for (const loc of cat.locations || []) {
            const name = String(loc || '').trim();
            if (!name || seenLocs.has(name)) continue;
            seenLocs.add(name);
            locationOrder.push(name);
        }

        for (const item of cat.items) {
            items.push({
                ...item,
                key: `${slug}::${item.key}`,
                catalogKey: item.key,
                sourceVendorSlug: slug,
                vendorLabel: cat.label,
            });
        }
    }

    return {
        slug: COMBINED_VENDOR_SLUG,
        label:
            vendorLabels.length > 1
                ? `Combined (${vendorLabels.join(', ')})`
                : vendorLabels[0] || 'Stock count',
        locations: locationOrder,
        locationOrder,
        items,
        vendorSlugs,
        vendorLabels,
    };
}

function isCombinedStockCountSlug(slug) {
    return String(slug || '')
        .trim()
        .toLowerCase() === COMBINED_VENDOR_SLUG;
}

module.exports = {
    COMBINED_VENDOR_SLUG,
    buildCombinedStockCountCatalog,
    vendorSlugsFromPendingLabels,
    isCombinedStockCountSlug,
};
