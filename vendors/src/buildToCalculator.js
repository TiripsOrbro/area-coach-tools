const path = require('path');
const {
    parseInventorySpecialEvent,
    parseStockOnHand,
    parseStockOnOrder,
    resolveStoreReports,
    onHandToCartons,
    onOrderToCartons,
    packSizeFromUnit,
    normalizeItemCode,
} = require('./reportReader');
const {
    listConfiguredVendors,
    getVendorCatalog,
    aggregateCounts,
    buildCatalogBuildToIndex,
} = require('./vendorCatalog');
const { getSummary, melbourneDateKey } = require('./stockCountState');
const {
    lookupKeysForMmx,
    mmxCodeForOrderCode,
    canonicalItemCode,
    findInReportMap,
    allLookupKeys,
} = require('./itemCodes');
const { buildToOverridesForStore, mergeBuildToRules } = require('./buildToStoreOverrides');
const { adminOverridesForStore } = require('./buildToAdminOverrides');
const { isOnIgnoreList } = require('./buildToIgnoreList');
const {
    findIseRowForCatalogItem,
    resolveCatalogItemForIseRow,
    findInReportMapWithNameFallback,
    lineCoversCatalogItem,
} = require('./orderItemNameMatch');
const {
    getDefaultBuildToDays,
    getExtendedBuildToDays,
    getSaladBuildToDays,
    getExtendedBuildToItemCodes,
    isSaladItem,
    buildToDaysForItemDefaults,
} = require('./orderingLiveData');

const paths = require('../../src/paths');
const REPORTS_DIR = paths.vendors.reports;

function catalogRuleForItem(itemCode, catalogRules, storeOverrideMap) {
    if (!catalogRules && !storeOverrideMap) return null;
    const base = catalogRules?.get(normalizeItemCode(itemCode)) || null;
    const override = storeOverrideMap?.get(normalizeItemCode(itemCode)) || null;
    return mergeBuildToRules(base, override);
}

function buildToDaysForItem(itemCode, description, catalogRules, storeOverrideMap) {
    const rule = catalogRuleForItem(itemCode, catalogRules, storeOverrideMap);
    if (rule?.buildToManual || rule?.buildToOrderManual) return null;
    if (rule?.buildToDays != null && Number.isFinite(rule.buildToDays)) {
        return rule.buildToDays;
    }
    if (rule?.buildToFixed != null && Number.isFinite(rule.buildToFixed)) return null;
    return buildToDaysForItemDefaults(itemCode, description);
}

function buildToTarget(avgDaily, itemCode, description, catalogRules, storeOverrideMap) {
    const rule = catalogRuleForItem(itemCode, catalogRules, storeOverrideMap);
    // oh:N / day-prefixed lines: ISE avg × days (+ buffer). Days win over stray buildToFixed
    // from a bad admin save that mirrored oh:13 into buildToFixed: 13.
    if (
        rule?.buildToDays != null &&
        Number.isFinite(rule.buildToDays) &&
        !rule?.buildToManual &&
        !rule?.buildToOrderManual
    ) {
        const add = rule?.buildToAdd != null && Number.isFinite(rule.buildToAdd) ? rule.buildToAdd : 0;
        return num(avgDaily) * rule.buildToDays + add;
    }
    if (rule?.buildToFixed != null && Number.isFinite(rule.buildToFixed)) {
        return rule.buildToFixed;
    }
    const days = buildToDaysForItem(itemCode, description, catalogRules, storeOverrideMap);
    if (days == null) return 0;
    const add = rule?.buildToAdd != null && Number.isFinite(rule.buildToAdd) ? rule.buildToAdd : 0;
    return num(avgDaily) * days + add;
}

function parseWeightFromLabel(label) {
    const m = String(label || '').match(/\(([\d.]+)\s*(kg|gm|g)\)/i);
    if (!m) return null;
    let n = Number(m[1]);
    if (!Number.isFinite(n)) return null;
    if (/^g/i.test(m[2]) && !/^kg/i.test(m[2])) n /= 1000;
    return n;
}

function countedItemCodesByVendor(storeNumber = '') {
    const out = new Map();
    const store = String(storeNumber || '').trim();
    for (const vendor of listConfiguredVendors()) {
        const catalog = getVendorCatalog(
            vendor.slug,
            store ? { storeNumber: store, forStockCount: true } : {}
        );
        if (!catalog) continue;
        const codes = new Set();
        for (const item of catalog.items) {
            if (item.skipStockCount) continue;
            const code = normalizeItemCode(item.itemCode);
            if (!code) continue;
            for (const key of [code, ...lookupKeysForMmx(mmxCodeForOrderCode(code) || code)]) {
                if (key) codes.add(key);
            }
        }
        out.set(vendor.slug, { vendor, catalog, codes });
    }
    return out;
}

function allCountedItemCodes() {
    const set = new Set();
    for (const { codes } of countedItemCodesByVendor().values()) {
        for (const c of codes) set.add(c);
    }
    return set;
}

/** Convert aggregated stock-count row to carton-equivalent (full + fractional cartons). */
function manualCountToCartons(aggregatedItem, catalogItem, isePackSize) {
    const cols = aggregatedItem.columns || {};
    let cartons = 0;
    const innerPerCarton = Number(catalogItem?.innerPerCarton);
    const hasInnerRatio = Number.isFinite(innerPerCarton) && innerPerCarton > 0;

    for (const col of catalogItem.columns || []) {
        const val = num(cols[col.key]);
        if (!Number.isFinite(val) || val < 0) continue;
        const label = String(col.label || '').toLowerCase();

        if (label.includes('carton') || label.includes('box')) {
            cartons += val;
            continue;
        }
        if (hasInnerRatio && (label.includes('pack') || label.includes('roll'))) {
            cartons += val / innerPerCarton;
            continue;
        }
        if (label.includes('tub') || label.includes('bottle') || label.includes('can')) {
            cartons += val;
            continue;
        }
        if (label.includes('kg')) {
            cartons += isePackSize > 0 ? val / isePackSize : 0;
            continue;
        }
        const bagKg = parseWeightFromLabel(col.label);
        if (bagKg != null && isePackSize > 0) {
            cartons += (val * bagKg) / isePackSize;
            continue;
        }
        if (label.includes('bag') || label.includes('each') || label.includes('tender')) {
            if (hasInnerRatio) cartons += val / innerPerCarton;
            else if (isePackSize > 0) cartons += val / isePackSize;
        }
    }

    return cartons;
}

function num(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
}

function orderRoundingDisabled(options = {}) {
    if (options.noOrderRounding) return true;
    const env = String(process.env.ORDER_NO_ROUNDING || '').trim().toLowerCase();
    return env === '1' || env === 'true' || env === 'yes';
}

/**
 * Order qty from build-to − on-hand − on-order.
 * Default: any positive shortage orders at least one carton (round up),
 * matching the manual build-to guide.
 * Testing: raw (4 dp) via --no-order-rounding / ORDER_NO_ROUNDING.
 */
function finalizeOrderQty(value, options = {}) {
    const n = Number(value);
    // 1e-6 guard: ignore floating-point noise from carton conversions.
    if (!Number.isFinite(n) || n <= 1e-6) return 0;
    if (orderRoundingDisabled(options)) return round4(n);
    return Math.ceil(n);
}

/** manual= par lines: any positive shortage orders at least one carton. */
function finalizeManualParOrderQty(value, options = {}) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 1e-6) return 0;
    if (orderRoundingDisabled(options)) return round4(n);
    return Math.ceil(n);
}

async function loadManualCountsForStore(storeNumber, dateKey = melbourneDateKey()) {
    const manual = new Map();
    const byVendor = countedItemCodesByVendor(storeNumber);

    for (const [slug, { catalog }] of byVendor.entries()) {
        const summary = await getSummary(storeNumber, slug, dateKey);
        if (!summary?.items?.length) continue;
        for (const item of summary.items) {
            const code = normalizeItemCode(item.itemCode);
            if (!code) continue;
            const hasCount = Object.values(item.columns || {}).some((v) => num(v) > 0);
            if (!hasCount) continue;
            const itemKey = String(item.itemKey || '').trim();
            const catalogItem = catalog.items.find(
                (i) =>
                    normalizeItemCode(i.itemCode) === code ||
                    (itemKey && i.key === itemKey)
            );
            if (!catalogItem) continue;
            const entry = {
                itemCode: code,
                itemKey: item.itemKey || code,
                itemName: item.itemName,
                vendorSlug: slug,
                columns: { ...item.columns },
                catalogItem,
            };
            const indexKeys = new Set([code, item.itemKey, catalogItem.key].filter(Boolean));
            for (const alias of allLookupKeys(code)) {
                if (alias) indexKeys.add(normalizeItemCode(alias));
            }
            for (const key of indexKeys) {
                const normalized = normalizeItemCode(key) || String(key).trim();
                if (normalized) manual.set(normalized, entry);
            }
        }
    }

    return manual;
}

/** Stock-count row for a catalog line (code, item key, and .item-codes aliases). */
function findManualCountEntry(counts, item) {
    if (!counts || !item) return null;
    const keys = new Set();
    const code = normalizeItemCode(item.itemCode);
    if (code) keys.add(code);
    if (item.key) keys.add(String(item.key).trim());
    for (const alias of allLookupKeys(code)) {
        if (alias) keys.add(normalizeItemCode(alias));
    }
    for (const key of keys) {
        const hit = counts.get(key);
        if (hit) return hit;
    }
    return null;
}

/**
 * Build-to order lines for a store.
 * orderQty = finalizeOrderQty(max(0, buildTo - onHandCartons - onOrderCartons))
 * On-hand comes from the Stock On Hand report (refreshed after stock count apply).
 */
function resolveOnOrderCartons(onOrderReport, itemCode, iseUnit, isePack, storeNumber) {
    const hit = findInReportMap(onOrderReport, itemCode, storeNumber);
    if (!hit) return { onOrderCartons: 0, onOrderRow: null };
    return {
        onOrderCartons: onOrderToCartons(hit.row, iseUnit, isePack, hit.key),
        onOrderRow: hit.row,
    };
}

function allBuildToCatalogItems(storeNumber = '', onlyCatalogSlugs = null) {
    const items = [];
    const store = String(storeNumber || '').trim();
    const wanted = onlyCatalogSlugs
        ? new Set(onlyCatalogSlugs.map((slug) => String(slug || '').trim().toLowerCase()))
        : null;
    for (const vendor of listConfiguredVendors()) {
        if (wanted && !wanted.has(String(vendor.slug || '').trim().toLowerCase())) continue;
        const catalog = getVendorCatalog(vendor.slug, store ? { storeNumber: store } : {});
        if (!catalog) continue;
        for (const item of catalog.items || []) {
            if (item.buildToManual && !item.buildToOrderManual) continue;
            items.push(item);
        }
    }
    return items;
}

function findIseUsageForItemCode(itemCode, usage, catalogItem = null, storeNumber = '') {
    if (!usage) return null;
    if (catalogItem) {
        const hit = findIseRowForCatalogItem(catalogItem, usage);
        return hit?.ise || null;
    }
    const target = normalizeItemCode(itemCode);
    for (const key of allLookupKeys(itemCode, storeNumber)) {
        if (usage.has(key)) return usage.get(key);
    }
    for (const [reportItemCode, ise] of usage.entries()) {
        const canon = canonicalItemCode(reportItemCode) || normalizeItemCode(reportItemCode);
        if (canon === target) return ise;
        for (const key of allLookupKeys(reportItemCode, storeNumber)) {
            if (normalizeItemCode(key) === target) return ise;
        }
    }
    return null;
}

/** Lazy-load SOO (+ ISE for units) for count-driven order lines (manual=, order=). */
function ensureBuildToReportContext(storeNumber, options = {}) {
    if (options._buildToReportCtx !== undefined) return options._buildToReportCtx;
    try {
        const files = resolveStoreReports(storeNumber, options.reportsDir || REPORTS_DIR);
        if (!files.stockOnOrder) {
            options._buildToReportCtx = null;
            return null;
        }
        options._buildToReportCtx = {
            storeNumber: String(storeNumber || '').trim(),
            onOrderReport: parseStockOnOrder(files.stockOnOrder, storeNumber),
            onHandReport: files.stockOnHand ? parseStockOnHand(files.stockOnHand, storeNumber) : null,
            usage: files.inventorySpecialEvent
                ? parseInventorySpecialEvent(files.inventorySpecialEvent)
                : null,
        };
    } catch {
        options._buildToReportCtx = null;
    }
    return options._buildToReportCtx;
}

/** Pick the best on-hand cartons across item-code aliases (and optional name fallback). */
function resolveOnHandFromReport(onHandReport, { reportItemCode, itemCode, catalogName, storeNumber, iseUnit, isePack }) {
    if (!onHandReport) return { cartons: 0, row: null, matchSource: 'missing' };

    const keys = new Set();
    for (const code of [reportItemCode, itemCode]) {
        for (const key of allLookupKeys(code, storeNumber)) {
            keys.add(normalizeItemCode(key));
        }
    }

    let bestCartons = 0;
    let bestRow = null;
    let bestKey = null;
    for (const key of keys) {
        const row = onHandReport.get(key);
        if (!row) continue;
        const cartons = onHandToCartons(row, iseUnit, isePack, key);
        if (cartons > bestCartons) {
            bestCartons = cartons;
            bestRow = row;
            bestKey = key;
        }
    }

    if (bestRow) {
        return { cartons: bestCartons, row: bestRow, matchSource: 'code', matchKey: bestKey };
    }

    if (catalogName) {
        const nameHit = findInReportMapWithNameFallback(itemCode, catalogName, onHandReport, storeNumber);
        if (nameHit && Number(nameHit.matchScore) >= 80) {
            const cartons = onHandToCartons(nameHit.row, iseUnit, isePack, nameHit.key);
            return {
                cartons,
                row: nameHit.row,
                matchSource: nameHit.matchSource || 'name',
                matchKey: nameHit.key,
            };
        }
    }

    return { cartons: 0, row: null, matchSource: 'missing' };
}

/** On-hand cartons from stock-on-hand report (alias-aware, same rules as ISE build-to lines). */
function onHandCartonsForCatalogItem(itemCode, catalogItem, ctx) {
    if (!ctx?.onHandReport) return null;
    const storeNumber = ctx.storeNumber || '';
    const ise = findIseUsageForItemCode(itemCode, ctx.usage, catalogItem, storeNumber);
    const iseUnit = ise?.unit || '';
    let isePack = ise?.packSize || packSizeFromUnit(iseUnit);
    if (!Number.isFinite(isePack) || isePack <= 0) {
        const inner = Number(catalogItem?.innerPerCarton);
        isePack = Number.isFinite(inner) && inner > 0 ? inner : 0;
    }
    const resolved = resolveOnHandFromReport(ctx.onHandReport, {
        reportItemCode: itemCode,
        itemCode,
        catalogName: catalogItem?.name || '',
        storeNumber,
        iseUnit,
        isePack,
    });
    return resolved.row ? resolved.cartons : null;
}

/** On-order cartons from stock-on-order report (same rules as ISE build-to lines). */
function onOrderCartonsForCatalogItem(itemCode, catalogItem, ctx) {
    if (!ctx?.onOrderReport) return 0;
    const storeNumber = ctx.storeNumber || '';
    const ise = findIseUsageForItemCode(itemCode, ctx.usage, catalogItem, storeNumber);
    const iseUnit = ise?.unit || '';
    let isePack = ise?.packSize || packSizeFromUnit(iseUnit);
    if (!Number.isFinite(isePack) || isePack <= 0) {
        const inner = Number(catalogItem?.innerPerCarton);
        isePack = Number.isFinite(inner) && inner > 0 ? inner : 0;
    }
    const { onOrderCartons } = resolveOnOrderCartons(ctx.onOrderReport, itemCode, iseUnit, isePack, storeNumber);
    return onOrderCartons;
}

async function calculateBuildToOrders(storeNumber, options = {}) {
    const reportsRoot = options.reportsDir || REPORTS_DIR;
    const dateKey = options.dateKey || melbourneDateKey();
    const files = resolveStoreReports(storeNumber, reportsRoot);

    if (!files.inventorySpecialEvent || !files.stockOnHand || !files.stockOnOrder) {
        const missing = [];
        if (!files.inventorySpecialEvent) missing.push('inventory-special-event');
        if (!files.stockOnHand) missing.push('stock-on-hand');
        if (!files.stockOnOrder) missing.push('stock-on-order');
        throw new Error(
            `Missing reports for store ${storeNumber}. Need ${missing.join(', ')} in ${files.storeDir}`
        );
    }

    const onlyCatalogSlugs = Array.isArray(options.onlyCatalogSlugs)
        ? options.onlyCatalogSlugs.map((slug) => String(slug || '').trim().toLowerCase()).filter(Boolean)
        : null;
    let scopedCatalogCodes = null;
    if (onlyCatalogSlugs?.length) {
        const { catalogItemCodesForSlugs } = require('./buildToOrderLines');
        scopedCatalogCodes = catalogItemCodesForSlugs(onlyCatalogSlugs, storeNumber);
    }

    function iseRowInScope(reportItemCode, catalogItem = null) {
        if (!scopedCatalogCodes) return true;
        const code = normalizeItemCode(reportItemCode);
        if (code && scopedCatalogCodes.has(code)) return true;
        if (catalogItem) {
            const catCode = normalizeItemCode(catalogItem.itemCode);
            if (catCode && scopedCatalogCodes.has(catCode)) return true;
        }
        for (const key of allLookupKeys(reportItemCode, storeNumber)) {
            if (scopedCatalogCodes.has(normalizeItemCode(key))) return true;
        }
        return false;
    }

    const usage = parseInventorySpecialEvent(files.inventorySpecialEvent);
    const onHandReport = parseStockOnHand(files.stockOnHand, storeNumber);
    const onOrderReport = parseStockOnOrder(files.stockOnOrder, storeNumber);

    const countedCodes = allCountedItemCodes();
    const catalogRules = buildCatalogBuildToIndex();
    const storeOverrideMap = buildToOverridesForStore(storeNumber);
    for (const [key, rule] of adminOverridesForStore(storeNumber)) {
        storeOverrideMap.set(key, mergeBuildToRules(storeOverrideMap.get(key), rule));
    }
    const manualCounts = await loadManualCountsForStore(storeNumber, dateKey);
    let manualCountItems = 0;
    const catalogItems = allBuildToCatalogItems(storeNumber, onlyCatalogSlugs);

    const lines = [];
    const usedIseCodes = new Set();

    const appendLineFromIse = (reportItemCode, ise, catalogItem, iseMatchSource) => {
        // If this ISE code belongs to an ignore/manual catalog line, never name-match
        // it onto another catalog item (e.g. ignored small bags → medium bags).
        const reportCanonCode = canonicalItemCode(reportItemCode) || normalizeItemCode(reportItemCode);
        const reportCodeRule = catalogRuleForItem(reportCanonCode, catalogRules, storeOverrideMap);
        const resolved = catalogItem
            ? { item: catalogItem, matchSource: iseMatchSource || 'code' }
            : reportCodeRule?.buildToManual
              ? null
              : resolveCatalogItemForIseRow(ise, reportItemCode, catalogItems);
        const matchedCatalog = resolved?.item || null;
        const itemCode = matchedCatalog
            ? normalizeItemCode(matchedCatalog.itemCode)
            : canonicalItemCode(reportItemCode) || reportItemCode;
        const matchSource = resolved?.matchSource || iseMatchSource || 'code';
        const catalogName = matchedCatalog?.name || ise.description || '';

        const isePack = ise.packSize || packSizeFromUnit(ise.unit);
        const onHandResolved = resolveOnHandFromReport(onHandReport, {
            reportItemCode,
            itemCode,
            catalogName,
            storeNumber,
            iseUnit: ise.unit,
            isePack,
        });
        const onHandRow = onHandResolved.row;

        let manualEntry = manualCounts.get(normalizeItemCode(reportItemCode)) || null;
        if (!manualEntry && matchedCatalog) {
            manualEntry = manualCounts.get(normalizeItemCode(matchedCatalog.itemCode)) || null;
        }
        if (!manualEntry) {
            for (const key of allLookupKeys(reportItemCode, storeNumber)) {
                manualEntry = manualCounts.get(normalizeItemCode(key)) || null;
                if (manualEntry) break;
            }
        }
        const catalogRule = catalogRuleForItem(itemCode, catalogRules, storeOverrideMap);
        const onHandFromReport = onHandResolved.cartons;
        const onHandFromManual =
            manualEntry && manualEntry.catalogItem
                ? manualCountToCartons({ columns: manualEntry.columns }, manualEntry.catalogItem, isePack)
                : null;
        const useReportOnHandOnly =
            Boolean(catalogRule?.skipStockCount) ||
            (Boolean(options.preferReportOnHand) && !options.preferManualCountWhenPresent);
        const useManualAfterApply =
            Boolean(options.preferManualCountWhenPresent) &&
            !catalogRule?.skipStockCount &&
            onHandFromManual != null;
        const onHandCartons = useManualAfterApply
            ? onHandFromManual
            : useReportOnHandOnly
              ? onHandFromReport
              : onHandFromManual != null
                ? onHandFromManual
                : onHandFromReport;
        const onHandSource = useManualAfterApply
            ? 'manual-count'
            : useReportOnHandOnly
              ? onHandRow
                  ? 'report'
                  : 'missing'
              : onHandFromManual != null
                ? 'manual-count'
                : onHandRow
                  ? 'report'
                  : 'missing';
        if (onHandFromManual != null && (useManualAfterApply || !useReportOnHandOnly)) manualCountItems++;

        const { onOrderCartons, onOrderRow } = resolveOnOrderCartons(
            onOrderReport,
            reportItemCode,
            ise.unit,
            isePack,
            storeNumber
        );
        const description = ise.description || onHandRow?.description || onOrderRow?.description || '';

        if (catalogRule?.buildToManual) {
            lines.push({
                itemCode,
                iseItemCode: normalizeItemCode(reportItemCode),
                iseMatchSource: matchSource,
                description,
                unit: ise.unit,
                avgDaily: round4(ise.avgDaily),
                buildToDays: null,
                buildToManual: true,
                buildTo: null,
                onHandCartons: round4(onHandCartons),
                onHandSource,
                onOrderCartons: round4(onOrderCartons),
                orderQty: 0,
                buildToSource: 'catalog-manual',
                manualColumns: null,
            });
            usedIseCodes.add(normalizeItemCode(reportItemCode));
            return;
        }

        const buildToDays = buildToDaysForItem(itemCode, description, catalogRules, storeOverrideMap);
        const buildTo = buildToTarget(ise.avgDaily, itemCode, description, catalogRules, storeOverrideMap);
        const rawOrder = buildTo - onHandCartons - onOrderCartons;
        let orderQty = finalizeOrderQty(rawOrder, options);
        if (isOnIgnoreList({ itemCode, iseItemCode: reportItemCode, description })) {
            orderQty = 0;
        }
        const hasStoreOverride = storeOverrideMap.has(normalizeItemCode(itemCode));
        const buildToSource =
            catalogRule?.buildToOrderManual ||
            (catalogRule?.buildToFixed != null && catalogRule?.buildToDays == null)
                ? 'catalog-fixed'
                : hasStoreOverride
                  ? 'store-override'
                  : catalogRule?.buildToDays != null
                    ? 'catalog-days'
                    : 'default';

        lines.push({
            itemCode,
            iseItemCode: normalizeItemCode(reportItemCode),
            iseMatchSource: matchSource,
            description,
            unit: ise.unit,
            avgDaily: round4(ise.avgDaily),
            buildToDays,
            buildToManual: false,
            buildTo: round4(buildTo),
            onHandCartons: round4(onHandCartons),
            onHandSource,
            onOrderCartons: round4(onOrderCartons),
            orderQty,
            buildToSource,
            manualColumns: null,
        });
        usedIseCodes.add(normalizeItemCode(reportItemCode));
    };

    for (const [reportItemCode, ise] of usage.entries()) {
        if (!iseRowInScope(reportItemCode)) continue;
        appendLineFromIse(reportItemCode, ise, null, 'code');
    }

    for (const item of catalogItems) {
        if (item.buildToFixed != null || item.buildToOrderManual) continue;
        if (lines.some((line) => lineCoversCatalogItem(line, item))) continue;
        const hit = findIseRowForCatalogItem(item, usage, usedIseCodes);
        if (!hit) continue;
        appendLineFromIse(hit.reportItemCode, hit.ise, item, hit.matchSource);
    }

    lines.sort((a, b) => {
        if (b.orderQty !== a.orderQty) return b.orderQty - a.orderQty;
        return a.itemCode.localeCompare(b.itemCode);
    });

    const onHandFromReportCount = lines.filter((l) => l.onHandSource === 'report').length;
    const onHandFromManualCount = lines.filter((l) => l.onHandSource === 'manual-count').length;

    return {
        storeNumber: String(storeNumber),
        dateKey,
        files,
        countedItemCodes: [...countedCodes],
        manualCountItems,
        onHandFromReportCount,
        onHandFromManualCount,
        lines,
        orderLines: lines.filter((l) => l.orderQty > 0),
        reportFiles: {
            inventorySpecialEvent: files.inventorySpecialEvent,
            stockOnHand: files.stockOnHand,
            stockOnOrder: files.stockOnOrder || null,
        },
    };
}

function round4(n) {
    return Math.round(Number(n) * 10000) / 10000;
}

/** Americold vendor items only (matches scheduled-order vendor label). */
function filterAmericoldOrderLines(result) {
    const americoldCodes = countedItemCodesByVendor().get('americold')?.codes || new Set();
    return {
        ...result,
        orderLines: result.orderLines.filter((l) => americoldCodes.has(l.itemCode)),
    };
}

module.exports = {
    calculateBuildToOrders,
    finalizeOrderQty,
    finalizeManualParOrderQty,
    findManualCountEntry,
    orderRoundingDisabled,
    filterAmericoldOrderLines,
    loadManualCountsForStore,
    manualCountToCartons,
    buildCatalogBuildToIndex,
    catalogRuleForItem,
    buildToDaysForItem,
    buildToTarget,
    ensureBuildToReportContext,
    onHandCartonsForCatalogItem,
    onOrderCartonsForCatalogItem,
    getDefaultBuildToDays,
    getExtendedBuildToDays,
    getSaladBuildToDays,
    getExtendedBuildToItemCodes,
    isSaladItem,
    buildToDaysForItemDefaults,
    REPORTS_DIR,
};
