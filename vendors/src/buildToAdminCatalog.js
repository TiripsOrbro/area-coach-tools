const { listConfiguredVendors, getVendorCatalog, catalogItemBuildToRule, UNIT_LABEL_OPTIONS, listAllVendorDefinitions } = require('./vendorCatalog');
const { listExistingVendorsForCopy } = require('./existingVendorsCache');
const { buildToOverridesForStore, mergeBuildToRules } = require('./buildToStoreOverrides');
const {
    adminOverridesForStore,
    adminOverridesForScope,
    readOverridesDoc,
    DEFAULT_STOCK_WARNING_DAYS,
    effectiveSkipKeyItemCount,
    effectiveSkipStockCount,
    effectiveIncludeDaily,
    effectiveCatalogItemFields,
    catalogUnitsFromItem,
} = require('./buildToAdminOverrides');
const { codeFieldsFromLayers, areaForStoreNumber } = require('./itemCodeOverrides');
const { normalizeItemCode } = require('./reportReader');
const { stockCountDisplayName } = require('./stockCountDisplayNames');
const { buildToDaysForItemDefaults } = require('./orderingLiveData');

function defaultDaysForItem(itemCode, description) {
    return buildToDaysForItemDefaults(itemCode, description);
}

function describeRuleType(rule, description, itemCode, item, skipKeyItemCount) {
    const manual = Boolean(rule?.buildToManual || item?.buildToManual);
    const orderManual = Boolean(rule?.buildToOrderManual || item?.buildToOrderManual);
    if (skipKeyItemCount && !orderManual && !manual) return 'on-hand';
    if (!rule) return 'default';
    if (rule.buildToManual) return 'manual';
    if (rule.buildToOrderManual) return 'order-manual';
    if (rule.buildToFixed != null) return 'fixed';
    if (rule.onHandOnly) return 'on-hand';
    if (rule.buildToDays != null || rule.buildToAdd) return 'days';
    return 'default';
}

function isOnHandBuildToCatalogItem(item) {
    return Boolean(
        item?.skipStockCount &&
        item?.skipKeyItemCount &&
        !item?.buildToManual &&
        !item?.buildToOrderManual &&
        item?.buildToDays != null
    );
}

function effectiveRuleForCatalogItem(item, vendorSlug, storeNumber, scope = {}) {
    const catalogRule = catalogItemBuildToRule(item, vendorSlug);
    const store = String(storeNumber || scope.store || '').trim();
    const area = String(scope.area || (store ? areaForStoreNumber(store) : '')).trim();
    const adminMap =
        scope.level === 'global'
            ? adminOverridesForScope({ level: 'global' })
            : scope.level === 'area' && area
              ? adminOverridesForScope({ level: 'area', area })
              : store
                ? adminOverridesForStore(store)
                : adminOverridesForScope({ level: 'global' });
    const storeMap = store ? buildToOverridesForStore(store) : new Map();
    const code = normalizeItemCode(item.itemCode);
    let effective = mergeBuildToRules(catalogRule, storeMap.get(code));
    effective = mergeBuildToRules(effective, adminMap.get(code));

    const description = item.name || item.description || '';
    const adminRule = adminMap.get(code);
    const skipKeyItemCount = store
        ? effectiveSkipKeyItemCount(item, store)
        : adminRule?.skipKeyItemCount != null
          ? Boolean(adminRule.skipKeyItemCount)
          : Boolean(item.skipKeyItemCount);
    const skipStockCount = store
        ? effectiveSkipStockCount(item, store)
        : adminRule?.skipStockCount != null
          ? Boolean(adminRule.skipStockCount)
          : Boolean(item.skipStockCount);
    const ruleType = describeRuleType(effective, description, code, item, skipKeyItemCount);
    const defaultDays = defaultDaysForItem(code, description);
    const doc = readOverridesDoc();
    const storeKey = store;
    const storeRule = storeKey ? doc.stores?.[storeKey]?.[code] : null;
    const areaRule = area ? doc.areas?.[area]?.[code] : null;
    const globalRule = doc.global?.[code] || null;
    const codeFields = codeFieldsFromLayers(code, { store: storeKey, area });
    const fieldOpts = {
        storeNumber: store,
        area,
        catalogVendorSlug: vendorSlug,
        level: scope.level,
    };
    const catalogFields = effectiveCatalogItemFields(item, fieldOpts);
    const fileCatalogName = item.name || item.description || code;
    const fileDisplayName = stockCountDisplayName(code, fileCatalogName) || '';

    return {
        itemCode: code,
        name: fileCatalogName,
        fileCatalogName,
        displayName: fileDisplayName,
        fileDisplayName,
        vendorSlug,
        catalogVendorSlug: vendorSlug,
        effectiveVendorSlug: catalogFields.effectiveVendorSlug,
        ruleType,
        needsCount: !skipStockCount,
        catalogNeedsCount: !Boolean(item.skipStockCount),
        skipKeyItemCount,
        skipStockCount,
        storeSkipStockCountOverride:
            storeRule && typeof storeRule.skipStockCount === 'boolean' ? storeRule.skipStockCount : null,
        globalSkipStockCountOverride:
            globalRule && typeof globalRule.skipStockCount === 'boolean' ? globalRule.skipStockCount : null,
        storeSkipKeyItemCountOverride:
            storeRule && typeof storeRule.skipKeyItemCount === 'boolean' ? storeRule.skipKeyItemCount : null,
        globalSkipKeyItemCountOverride:
            globalRule && typeof globalRule.skipKeyItemCount === 'boolean' ? globalRule.skipKeyItemCount : null,
        includeDaily: store
            ? effectiveIncludeDaily(item, store)
            : adminRule?.includeDaily != null
              ? Boolean(adminRule.includeDaily)
              : Boolean(item.includeDaily),
        catalogIncludeDaily: Boolean(item.includeDaily),
        storeIncludeDailyOverride:
            storeRule && typeof storeRule.includeDaily === 'boolean' ? storeRule.includeDaily : null,
        globalIncludeDailyOverride:
            globalRule && typeof globalRule.includeDaily === 'boolean' ? globalRule.includeDaily : null,
        areaSkipStockCountOverride:
            areaRule && typeof areaRule.skipStockCount === 'boolean' ? areaRule.skipStockCount : null,
        areaSkipKeyItemCountOverride:
            areaRule && typeof areaRule.skipKeyItemCount === 'boolean' ? areaRule.skipKeyItemCount : null,
        areaIncludeDailyOverride:
            areaRule && typeof areaRule.includeDaily === 'boolean' ? areaRule.includeDaily : null,
        mmxCode: codeFields.mmxCode,
        vendorCode: codeFields.vendorCode,
        fallbackCodes: codeFields.fallbackCodes,
        catalogMmxCode: codeFields.catalogMmxCode,
        fileMmxCode: codeFields.fileMmxCode,
        fileVendorCode: codeFields.fileVendorCode,
        fileFallbackCodes: codeFields.fileFallbackCodes,
        scopeMmxCode:
            scope.level === 'global'
                ? codeFields.globalMmxCode
                : scope.level === 'area'
                  ? codeFields.areaMmxCode
                  : codeFields.storeMmxCode,
        scopeVendorCode:
            scope.level === 'global'
                ? codeFields.globalVendorCode
                : scope.level === 'area'
                  ? codeFields.areaVendorCode
                  : codeFields.storeVendorCode,
        scopeFallbackCodes:
            scope.level === 'global'
                ? codeFields.globalFallbackCodes
                : scope.level === 'area'
                  ? codeFields.areaFallbackCodes
                  : codeFields.storeFallbackCodes,
        buildToDays:
            effective?.buildToDays != null && Number.isFinite(effective.buildToDays)
                ? effective.buildToDays
                : ruleType === 'days' || ruleType === 'default' || ruleType === 'on-hand'
                  ? defaultDays
                  : null,
        buildToAdd: effective?.buildToAdd != null ? effective.buildToAdd : 0,
        buildToFixed: effective?.buildToFixed != null ? effective.buildToFixed : null,
        buildToManual: Boolean(effective?.buildToManual),
        buildToOrderManual: Boolean(effective?.buildToOrderManual),
        onHandOnly: ruleType === 'on-hand',
        stockWarningDays:
            effective?.stockWarningDays != null && Number.isFinite(Number(effective.stockWarningDays))
                ? Number(effective.stockWarningDays)
                : null,
        defaultStockWarningDays:
            doc.settings?.stockWarningDays != null &&
            Number.isFinite(Number(doc.settings.stockWarningDays))
                ? Number(doc.settings.stockWarningDays)
                : DEFAULT_STOCK_WARNING_DAYS,
        excludeFromShortfall: Boolean(effective?.excludeFromShortfall),
        storeExcludeFromShortfallOverride:
            storeRule && typeof storeRule.excludeFromShortfall === 'boolean'
                ? storeRule.excludeFromShortfall
                : null,
        globalExcludeFromShortfallOverride:
            globalRule && typeof globalRule.excludeFromShortfall === 'boolean'
                ? globalRule.excludeFromShortfall
                : null,
        areaExcludeFromShortfallOverride:
            areaRule && typeof areaRule.excludeFromShortfall === 'boolean'
                ? areaRule.excludeFromShortfall
                : null,
        catalogRule,
        storeOverride: storeMap.get(code) || null,
        adminOverride: adminMap.get(code) || null,
        unitSlots: catalogFields.unitSlots,
        units: catalogFields.units,
        fileUnits: catalogFields.fileUnits,
        innerPerCarton: catalogFields.innerPerCarton,
        fileInnerPerCarton: catalogFields.fileInnerPerCarton,
        unitsPerPack: catalogFields.unitsPerPack,
        fileUnitsPerPack: catalogFields.fileUnitsPerPack,
        scopeVendorSlug: catalogFields.scopeVendorSlug,
        scopeUnits: catalogFields.scopeUnits,
        scopeInnerPerCarton: catalogFields.scopeInnerPerCarton,
        scopeUnitsPerPack: catalogFields.scopeUnitsPerPack,
    };
}

function buildAdminBuildToCatalog(options = {}) {
    const store = String(options.storeNumber || options.store || '').trim();
    const area = String(options.areaName || options.area || '').trim();
    const configure = Boolean(options.configure);
    const level = configure
        ? 'global'
        : options.level || (store ? 'store' : area ? 'area' : 'global');
    const scope = configure
        ? { level: 'global', store: '', area: '' }
        : { level, store, area: area || (store ? areaForStoreNumber(store) : '') };
    const vendors = [];
    for (const vendor of listConfiguredVendors()) {
        const catalog = getVendorCatalog(vendor.slug);
        if (!catalog?.items?.length) continue;
        const items = [];
        for (const item of catalog.items) {
            const code = String(item.itemCode || '').trim();
            if (!code || (item.skipStockCount && !isOnHandBuildToCatalogItem(item))) continue;
            items.push(effectiveRuleForCatalogItem(item, vendor.slug, configure ? '' : store, scope));
        }
        if (items.length) {
            vendors.push({
                slug: vendor.slug,
                label: vendor.label || vendor.slug,
                locations: Array.isArray(catalog.locations) ? catalog.locations : [],
                items: Array.isArray(items) ? items : [],
            });
        }
    }
    return {
        storeNumber: configure ? '' : store,
        areaName: scope.area,
        scopeLevel: level,
        configure,
        unitLabelOptions: UNIT_LABEL_OPTIONS,
        allVendors: configure ? listAllVendorDefinitions() : undefined,
        existingVendors: configure ? listExistingVendorsForCopy() : undefined,
        vendors,
        settings: readOverridesDoc().settings || {},
    };
}

function filterOverridesForActor(doc, actorStores, canEditGlobal, accessibleAreas = []) {
    const out = { global: {}, areas: {}, stores: {} };
    if (canEditGlobal && doc.global) out.global = { ...doc.global };
    const allowedAreas = new Set((accessibleAreas || []).map(String));
    if (canEditGlobal && doc.areas) {
        out.areas = { ...doc.areas };
    } else if (doc.areas) {
        for (const [area, patch] of Object.entries(doc.areas)) {
            if (allowedAreas.has(String(area))) out.areas[area] = { ...patch };
        }
    }
    const allowed = new Set((actorStores || []).map(String));
    for (const [store, patch] of Object.entries(doc.stores || {})) {
        if (allowed.has(String(store))) out.stores[store] = { ...patch };
    }
    return out;
}

module.exports = {
    buildAdminBuildToCatalog,
    effectiveRuleForCatalogItem,
    filterOverridesForActor,
    isOnHandBuildToCatalogItem,
    readOverridesDoc,
    UNIT_LABEL_OPTIONS,
    catalogUnitsFromItem,
};
