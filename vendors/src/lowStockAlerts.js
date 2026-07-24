const { normalizeItemCode, reportsReadyForStore } = require('./reportReader');
const { catalogRuleForItem, calculateBuildToOrders, REPORTS_DIR } = require('./buildToCalculator');
const { buildCatalogBuildToIndex } = require('./vendorCatalog');
const { buildToOverridesForStore } = require('./buildToStoreOverrides');
const { adminOverridesForStore, readOverridesDoc } = require('./buildToAdminOverrides');
const { normalizeItemName } = require('./orderItemNameMatch');
const { stockCountDisplayName } = require('./stockCountDisplayNames');

const DEFAULT_STOCK_WARNING_DAYS = 3;
const SUMMARY_CACHE_MS = Number(process.env.LOW_STOCK_SUMMARY_CACHE_MS || 15 * 60 * 1000);
const summaryCache = new Map();

/** Item descriptions omitted from stock shortfall alerts (prep / packaging — not order-critical). */
const LOW_STOCK_SHORTFALL_EXCLUDE_NAMES = new Set(
    [
        'TB MEXICAN RICE (FINISHED PRODUCT)',
        'TB GUACAMOLE (FINISHED PRODUCT)',
        'TB TACO SHELLS (FINISHED PRODUCT)',
        'TB TOSTADA (FINISHED PRODUCT)',
        'TB FIESTA SALSA (FINISHED PRODUCT)',
        '4OZ PORTION CUP 50EA',
        '260 x 260mm Baking Paper Golden Silidor',
        '4OZ PORTION CUP LID 50EA',
        'TB TOMATO DICED (FINISHED PRODUCT)',
    ].map(normalizeItemName)
);

function isExcludedFromLowStockShortfall(line, options = {}) {
    const name = normalizeItemName(line?.description || '');
    if (name && LOW_STOCK_SHORTFALL_EXCLUDE_NAMES.has(name)) return true;
    const code = normalizeItemCode(line?.itemCode || line?.iseItemCode || '');
    const adminMap = options.adminOverrideMap;
    if (code && adminMap && typeof adminMap.get === 'function') {
        const rule = adminMap.get(code);
        if (rule?.excludeFromShortfall === true) return true;
    }
    return false;
}

function defaultStockWarningDays() {
    const doc = readOverridesDoc();
    const raw = doc?.settings?.stockWarningDays;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_STOCK_WARNING_DAYS;
}

function stockWarningDaysForItem(itemCode, storeNumber, catalogRules, storeOverrideMap, adminOverrideMap) {
    const code = normalizeItemCode(itemCode);
    const rule = catalogRuleForItem(code, catalogRules, storeOverrideMap);
    const adminRule = adminOverrideMap?.get(code) || null;
    const merged = adminRule ? { ...rule, ...adminRule } : rule;
    if (merged?.stockWarningDays != null && Number.isFinite(Number(merged.stockWarningDays))) {
        return Number(merged.stockWarningDays);
    }
    return defaultStockWarningDays();
}

function summaryCacheKey(storeNumber, dateKey = '', onHandOnly = false) {
    return `${String(storeNumber || '').trim()}:${dateKey || ''}:${onHandOnly ? 'oh' : 'ohoo'}`;
}

function computeLowStockAlerts(lines, options = {}) {
    const storeNumber = String(options.storeNumber || '').trim();
    const catalogRules = options.catalogRules || (storeNumber ? buildCatalogBuildToIndex() : null);
    const storeOverrideMap = storeNumber ? buildToOverridesForStore(storeNumber) : new Map();
    const adminOverrideMap = storeNumber ? adminOverridesForStore(storeNumber) : new Map();
    const defaultThreshold = options.thresholdDays != null ? Number(options.thresholdDays) : null;
    const onHandOnly = Boolean(options.onHandOnly);

    const alerts = [];
    for (const line of lines || []) {
        if (isExcludedFromLowStockShortfall(line, { adminOverrideMap })) continue;
        const avgDaily = Number(line.avgDaily);
        if (!Number.isFinite(avgDaily) || avgDaily <= 0) continue;
        const onHand = Number(line.onHandCartons) || 0;
        const onOrder = onHandOnly ? 0 : Number(line.onOrderCartons) || 0;
        const daysOfStock = (onHand + onOrder) / avgDaily;
        const threshold =
            defaultThreshold != null && Number.isFinite(defaultThreshold)
                ? defaultThreshold
                : stockWarningDaysForItem(
                      line.itemCode || line.iseItemCode,
                      storeNumber,
                      catalogRules,
                      storeOverrideMap,
                      adminOverrideMap
                  );
        if (daysOfStock >= threshold) continue;
        const itemCode = line.itemCode || line.iseItemCode;
        const description = line.description || '';
        const displayName = stockCountDisplayName(itemCode, description) || description || itemCode;
        alerts.push({
            itemCode,
            iseItemCode: line.iseItemCode || line.itemCode,
            description,
            displayName,
            onHandCartons: onHand,
            onOrderCartons: onOrder,
            avgDaily,
            daysOfStock: Math.round(daysOfStock * 100) / 100,
            thresholdDays: threshold,
        });
    }
    alerts.sort((a, b) => a.daysOfStock - b.daysOfStock);
    return alerts;
}

function setLowStockSummaryCache(storeNumber, summary, dateKey = '', onHandOnly = false) {
    const cacheKey = summaryCacheKey(storeNumber, dateKey, onHandOnly);
    summaryCache.set(cacheKey, { at: Date.now(), summary });
}

function buildLowStockSummaryFromAlerts(alerts, options = {}) {
    const thresholdDays = options.thresholdDays ?? defaultStockWarningDays();
    return {
        count: alerts.length,
        items: alerts.slice(0, 5),
        alerts,
        thresholdDays,
        onHandOnly: Boolean(options.onHandOnly),
        checked: true,
        checkedAt: options.checkedAt || new Date().toISOString(),
    };
}

function stockLevelsSubFromSummary(summary) {
    const threshold = summary.thresholdDays ?? defaultStockWarningDays();
    const modeLabel = summary.onHandOnly ? 'current on hand' : 'on hand + on order';
    if (summary.count > 0) {
        return `${summary.count} item${summary.count === 1 ? '' : 's'} under ${threshold} days (${modeLabel})`;
    }
    if (summary.checked) {
        return `No stock shortfalls (${modeLabel})`;
    }
    return 'Stock levels not checked today';
}

async function getLowStockSummary(storeNumber, options = {}) {
    const store = String(storeNumber || '').trim();
    const onHandOnly = Boolean(options.onHandOnly);
    const thresholdDays = defaultStockWarningDays();
    if (!store) {
        return { count: 0, items: [], thresholdDays, onHandOnly, checked: false, checkedAt: null };
    }

    const cacheKey = summaryCacheKey(store, options.dateKey || '', onHandOnly);
    if (!options.skipCache) {
        const cached = summaryCache.get(cacheKey);
        if (cached && Date.now() - cached.at < SUMMARY_CACHE_MS) {
            return cached.summary;
        }
    }

    const reportsDir = options.reportsDir || REPORTS_DIR;
    const { ready } = reportsReadyForStore(store, reportsDir);
    if (!ready) {
        const empty = { count: 0, items: [], thresholdDays, onHandOnly, checked: false, checkedAt: null };
        if (!options.skipCache) setLowStockSummaryCache(store, empty, options.dateKey, onHandOnly);
        return empty;
    }

    try {
        const buildTo = await calculateBuildToOrders(store, {
            reportsDir,
            dateKey: options.dateKey,
            preferReportOnHand: true,
        });
        const alerts = computeLowStockAlerts(buildTo.lines || [], { storeNumber: store, onHandOnly });
        const summary = buildLowStockSummaryFromAlerts(alerts, { thresholdDays, onHandOnly });
        setLowStockSummaryCache(store, summary, options.dateKey, onHandOnly);
        return summary;
    } catch {
        const empty = { count: 0, items: [], thresholdDays, onHandOnly, checked: false, checkedAt: null };
        setLowStockSummaryCache(store, empty, options.dateKey, onHandOnly);
        return empty;
    }
}

function invalidateLowStockSummaryCache(storeNumber, options = {}) {
    const store = String(storeNumber || '').trim();
    const prefix = `${store}:`;
    if (options.onHandOnly === true || options.onHandOnly === false) {
        summaryCache.delete(summaryCacheKey(store, options.dateKey || '', options.onHandOnly));
        return;
    }
    for (const key of summaryCache.keys()) {
        if (key.startsWith(prefix)) summaryCache.delete(key);
    }
}

module.exports = {
    DEFAULT_STOCK_WARNING_DAYS,
    defaultStockWarningDays,
    stockWarningDaysForItem,
    isExcludedFromLowStockShortfall,
    computeLowStockAlerts,
    getLowStockSummary,
    setLowStockSummaryCache,
    buildLowStockSummaryFromAlerts,
    stockLevelsSubFromSummary,
    summaryCacheKey,
    invalidateLowStockSummaryCache,
};
