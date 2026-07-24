const fs = require('fs');
const path = require('path');
const {
    calculateBuildToOrders,
    loadManualCountsForStore,
    manualCountToCartons,
    finalizeOrderQty,
    finalizeManualParOrderQty,
    findManualCountEntry,
    orderRoundingDisabled,
    ensureBuildToReportContext,
    onHandCartonsForCatalogItem,
    onOrderCartonsForCatalogItem,
} = require('./buildToCalculator');
const { melbourneDateKey } = require('./stockCountState');
const { getVendorCatalog } = require('./vendorCatalog');
const { normalizeItemCode } = require('./reportReader');
const { buildBuildToEntriesForVendor, catalogLineCodeMatch } = require('./orderItemNameMatch');
const { isOnIgnoreList } = require('./buildToIgnoreList');

const { loadVendorOrdersConfig } = require('./vendorOrdersConfig');
const { allLookupKeys } = require('./itemCodes');

function itemMatchesVendorConfig(catalogItem, vendorCfg) {
    if (
        vendorCfg.catalogSlug &&
        catalogItem.catalogSlug &&
        vendorCfg.catalogSlug !== catalogItem.catalogSlug
    ) {
        return false;
    }
    if (vendorCfg.orderClasses?.length) {
        return vendorCfg.orderClasses.includes(catalogItem.mmxOrderClass);
    }
    if (vendorCfg.orderClass) {
        return catalogItem.mmxOrderClass === vendorCfg.orderClass;
    }
    return true;
}

function buildCatalogItemIndex() {
    const index = new Map();
    for (const vendorCfg of loadVendorOrdersConfig().vendors || []) {
        const slug = vendorCfg.catalogSlug;
        if (!slug) continue;
        const catalog = getVendorCatalog(slug);
        if (!catalog) continue;
        for (const item of catalog.items) {
            const code = normalizeItemCode(item.itemCode);
            if (!code) continue;
            index.set(code, {
                itemCode: code,
                name: item.name,
                mmxOrderClass: item.mmxOrderClass || 'FRZ',
                skipVendorOrder: Boolean(item.skipVendorOrder),
                catalogSlug: slug,
            });
        }
    }
    return index;
}

/** Per-item pack size from vendor config (e.g. iced coffee bottles in cases of 6). */
function orderRoundStepForItem(vendorCfg, ...itemCodes) {
    const byItem = vendorCfg?.orderRoundToByItemCode || {};
    for (const code of itemCodes) {
        const key = normalizeItemCode(code);
        if (key && byItem[key] != null) return Number(byItem[key]);
    }
    return null;
}

/** Iced coffee / Bega: round to the nearest full pack, not always up to the next pack. */
function roundOrderQtyToNearestPack(qty, step) {
    const n = Number(qty);
    const pack = Number(step);
    if (!Number.isFinite(n) || n <= 0 || !Number.isFinite(pack) || pack <= 1) return 0;
    const rounded = Math.round(n / pack) * pack;
    return rounded > 0 ? rounded : pack;
}

/** True when the vendor catalog line defines its own build-to (order=N, days, =N, oh:N). */
function catalogItemHasBuildToRule(item) {
    if (item.buildToManual && !item.buildToOrderManual) return false;
    if (item.buildToOrderManual) {
        return item.buildToFixed != null && Number.isFinite(item.buildToFixed);
    }
    if (item.buildToFixed != null && Number.isFinite(item.buildToFixed)) return true;
    if (item.buildToDays != null && Number.isFinite(item.buildToDays)) return true;
    return false;
}

/**
 * Order qty from dashboard stock-count draft + fixed build-to (order=N catalog lines).
 * When vendorCfg.uncountedBuildTo is set, uncounted catalog lines with no build-to rule
 * use that default; lines with order=N / days / =N keep their configured targets.
 */
async function buildOrderManualEntriesFromCounts(
    storeNumber,
    vendorCfg,
    catalog,
    dateKey,
    options = {}
) {
    if (!vendorCfg?.orderFromCount || !catalog) return [];
    const counts = await loadManualCountsForStore(storeNumber, dateKey || melbourneDateKey());
    const reportCtx = ensureBuildToReportContext(storeNumber, options);
    const coveredByIse = options.coveredByIse || new Set();
    const uncountedBuildTo = Number(vendorCfg.uncountedBuildTo);
    const hasUncountedDefault =
        Number.isFinite(uncountedBuildTo) && uncountedBuildTo > 0;
    const entries = [];

    for (const item of catalog.items || []) {
        if (!itemMatchesVendorConfig(item, vendorCfg)) continue;
        if (isOnIgnoreList(item)) continue;
        // ignore / manual / oh-only catalog lines
        if (item.buildToManual && !item.buildToOrderManual) continue;

        const code = normalizeItemCode(item.itemCode);
        if (!code) continue;

        const countEntry = findManualCountEntry(counts, item);
        const hasBuildToRule = catalogItemHasBuildToRule(item);
        let buildTo;
        let onHandCartons = 0;

        if (item.buildToOrderManual) {
            buildTo =
                item.buildToFixed != null && Number.isFinite(item.buildToFixed)
                    ? item.buildToFixed
                    : 0;
            // manual= dry supplies: always build-to − stock count (never SOH).
            // order= (e.g. oil): SOH when reports are available after count apply.
            if (item.buildToManual) {
                if (!countEntry) continue;
                onHandCartons = manualCountToCartons(
                    { columns: countEntry.columns },
                    countEntry.catalogItem || item,
                    1
                );
            } else if (countEntry && !options.preferReportOnHand) {
                onHandCartons = manualCountToCartons(
                    { columns: countEntry.columns },
                    countEntry.catalogItem || item,
                    1
                );
            } else if (reportCtx) {
                // No count today (or preferReportOnHand): use the SOH report
                // instead of assuming zero on hand (oil, Schweppes BIBs/FCBs).
                const fromReport = onHandCartonsForCatalogItem(code, item, reportCtx);
                if (Number.isFinite(fromReport)) {
                    onHandCartons = fromReport;
                } else if (countEntry) {
                    onHandCartons = manualCountToCartons(
                        { columns: countEntry.columns },
                        countEntry.catalogItem || item,
                        1
                    );
                }
            }
        } else if (
            hasUncountedDefault &&
            !countEntry &&
            !hasBuildToRule &&
            !coveredByIse.has(code)
        ) {
            buildTo = uncountedBuildTo;
        } else {
            continue;
        }

        // manual= and order= lines both deduct stock-on-order (see VENDOR-FORMAT.md).
        const onOrderCartons =
            item.buildToOrderManual && reportCtx
                ? onOrderCartonsForCatalogItem(code, item, reportCtx)
                : 0;
        const rawOrder = buildTo - onHandCartons - onOrderCartons;
        const orderQty = item.buildToManual
            ? finalizeManualParOrderQty(rawOrder, options)
            : finalizeOrderQty(rawOrder, options);
        if (orderQty <= 0 && !countEntry) continue;

        entries.push({
            catalogName: item.name,
            catalogItemCode: item.itemCode,
            description: item.name,
            orderQty,
            iseItemCode: code,
            matchScore: 100,
            buildToSource: hasBuildToRule ? 'count-manual' : 'count-default',
            onOrderCartons,
        });
    }

    return entries;
}

function mergeBuildToEntries(...entrySets) {
    const byCode = new Map();
    for (const set of entrySets) {
        for (const entry of set || []) {
            const key = normalizeItemCode(entry.catalogItemCode || entry.iseItemCode);
            if (!key) continue;
            const existing = byCode.get(key);
            // Never let low-confidence report fallbacks override manual/fixed entries.
            if (
                existing &&
                (existing.buildToSource === 'catalog-manual' ||
                    existing.buildToManual ||
                    existing.buildToSource === 'count-manual' ||
                    existing.buildToSource === 'count-default')
            ) {
                continue;
            }
            byCode.set(key, entry);
        }
    }
    return [...byCode.values()];
}

/**
 * Final order quantity for MMX entry.
 * Default: nearest whole carton (via finalizeOrderQty). Iced coffee: nearest pack multiple.
 */
function roundOrderQtyForVendor(qty, vendorCfg, options = {}, ...itemCodes) {
    const n = Number(qty);
    if (!Number.isFinite(n) || n <= 0) return 0;
    if (orderRoundingDisabled(options)) return finalizeOrderQty(n, options);

    const itemStep = orderRoundStepForItem(vendorCfg, ...itemCodes);
    if (Number.isFinite(itemStep) && itemStep > 1) {
        return roundOrderQtyToNearestPack(n, itemStep);
    }

    const vendorStep = Number(vendorCfg?.orderRoundTo);
    if (Number.isFinite(vendorStep) && vendorStep > 1) {
        return Math.ceil(n / vendorStep) * vendorStep;
    }

    return finalizeOrderQty(n, options);
}

function vendorCatalogCodeSet(catalog, vendorCfg) {
    const set = new Set();
    for (const item of catalog?.items || []) {
        if (item.skipVendorOrder) continue;
        if (!itemMatchesVendorConfig(item, vendorCfg)) continue;
        const code = normalizeItemCode(item.itemCode);
        if (code) set.add(code);
    }
    return set;
}

/** MMX scheduled-order vendor ids (e.g. americold-frz) for catalog slugs (e.g. americold). */
function vendorIdsForCatalogSlugs(catalogSlugs, vendorOrdersCfg = loadVendorOrdersConfig()) {
    const wanted = new Set(
        (catalogSlugs || []).map((slug) => String(slug || '').trim().toLowerCase()).filter(Boolean)
    );
    if (!wanted.size) return [];
    return (vendorOrdersCfg.vendors || [])
        .filter((vendorCfg) => wanted.has(String(vendorCfg.catalogSlug || '').trim().toLowerCase()))
        .map((vendorCfg) => vendorCfg.id)
        .filter(Boolean);
}

/** All normalized item / alias codes for vendor catalog slugs at a store. */
function catalogItemCodesForSlugs(catalogSlugs, storeNumber) {
    const codes = new Set();
    const store = String(storeNumber || '').trim();
    for (const slug of catalogSlugs || []) {
        const catalog = getVendorCatalog(slug, store ? { storeNumber: store } : {});
        if (!catalog) continue;
        for (const item of catalog.items || []) {
            const code = normalizeItemCode(item.itemCode);
            if (!code) continue;
            codes.add(code);
            for (const alias of allLookupKeys(code)) {
                const normalized = normalizeItemCode(alias);
                if (normalized) codes.add(normalized);
            }
        }
    }
    return codes;
}

function vendorPackHasPositiveOrders(pack) {
    return (pack?.buildToEntries || []).some((entry) => Number(entry.orderQty) > 0);
}

function summarizeOrderPack(orderPack, { onlyVendorIds } = {}) {
    const only = onlyVendorIds ? new Set(onlyVendorIds.map(String)) : null;
    const vendors = [];
    for (const [vendorId, pack] of Object.entries(orderPack?.byVendorId || {})) {
        if (only && !only.has(String(vendorId))) continue;
        const positive = (pack.buildToEntries || []).filter((e) => Number(e.orderQty) > 0);
        vendors.push({
            vendorId,
            label: pack.vendor?.label || vendorId,
            catalogSlug: pack.vendor?.catalogSlug || '',
            catalogItems: pack.buildToEntries?.length || 0,
            orderLines: positive.length,
            cartons: positive.reduce((sum, e) => sum + Number(e.orderQty || 0), 0),
        });
    }
    return vendors.sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * Build-to entries per vendor - ISE lines matched to vendor catalog by item name.
 */
async function buildOrderLinesByVendorId(storeNumber, options = {}) {
    const vendorOrdersCfg = options.vendorOrdersCfg || loadVendorOrdersConfig();
    const onlyVendorIds = Array.isArray(options.onlyVendorIds)
        ? new Set(options.onlyVendorIds.map(String))
        : null;
    const onlyCatalogSlugs = Array.isArray(options.onlyCatalogSlugs)
        ? options.onlyCatalogSlugs.map((slug) => String(slug || '').trim().toLowerCase()).filter(Boolean)
        : null;
    const buildTo = await calculateBuildToOrders(storeNumber, {
        ...options,
        onlyCatalogSlugs: onlyCatalogSlugs?.length ? onlyCatalogSlugs : options.onlyCatalogSlugs,
    });
    const dateKey = options.dateKey || melbourneDateKey();
    const byVendorId = {};

    for (const vendorCfg of vendorOrdersCfg.vendors || []) {
        if (onlyVendorIds && !onlyVendorIds.has(String(vendorCfg.id))) continue;
        if (
            onlyCatalogSlugs?.length &&
            !onlyCatalogSlugs.includes(String(vendorCfg.catalogSlug || '').trim().toLowerCase())
        ) {
            continue;
        }
        const catalog = getVendorCatalog(vendorCfg.catalogSlug);
        const vendorCodes = vendorCatalogCodeSet(catalog, vendorCfg);
        const iseEntries = buildBuildToEntriesForVendor(
            vendorCfg,
            buildTo.lines,
            catalog?.items || [],
            itemMatchesVendorConfig
        );
        const coveredByIse = new Set(
            iseEntries
                .map((entry) => normalizeItemCode(entry.catalogItemCode || entry.iseItemCode))
                .filter(Boolean)
        );
        const countEntries = await buildOrderManualEntriesFromCounts(
            storeNumber,
            vendorCfg,
            catalog,
            dateKey,
            { coveredByIse, ...options }
        );
        const vendorCodeSet = vendorCodes;
        const lineMatchesVendorCatalog = (line) => {
            const code = normalizeItemCode(line.itemCode);
            if (vendorCodeSet.has(code)) return true;
            for (const catCode of vendorCodeSet) {
                if (catalogLineCodeMatch(catCode, code)) return true;
            }
            return false;
        };
        const allReportEntries = (buildTo.lines || [])
            .filter((line) => lineMatchesVendorCatalog(line))
            .filter((line) => Number(line.orderQty) > 0)
            .filter((line) => !/\bfinished product\b/i.test(String(line.description || '')))
            .map((line) => ({
                catalogName: line.description,
                catalogItemCode: line.itemCode,
                description: line.description,
                orderQty: line.orderQty,
                iseItemCode: line.iseItemCode || line.itemCode,
                matchScore: line.iseMatchSource === 'code' ? 100 : line.iseMatchSource === 'name' ? 60 : 30,
                matchSource: line.iseMatchSource || 'report',
                buildToSource: line.buildToSource || 'report',
            }));

        const buildToEntries = mergeBuildToEntries(iseEntries, countEntries, allReportEntries).map((entry) => ({
            ...entry,
            orderQty: roundOrderQtyForVendor(
                entry.orderQty,
                vendorCfg,
                options,
                entry.iseItemCode,
                entry.catalogItemCode
            ),
        }));
        const lines = buildToEntries
            .filter((entry) => entry.orderQty > 0)
            .map((entry) => ({
                itemCode: entry.catalogItemCode || entry.iseItemCode,
                quantity: entry.orderQty,
                itemName: entry.catalogName || entry.description,
            }));
        byVendorId[vendorCfg.id] = { vendor: vendorCfg, buildToEntries, lines };
    }

    return { buildTo, byVendorId, vendorOrdersCfg };
}

module.exports = {
    loadVendorOrdersConfig,
    buildOrderLinesByVendorId,
    buildOrderManualEntriesFromCounts,
    buildCatalogItemIndex,
    itemMatchesVendorConfig,
    roundOrderQtyForVendor,
    roundOrderQtyToNearestPack,
    orderRoundStepForItem,
    vendorIdsForCatalogSlugs,
    catalogItemCodesForSlugs,
    vendorPackHasPositiveOrders,
    summarizeOrderPack,
};
