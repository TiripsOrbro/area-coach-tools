const fs = require('fs');
const path = require('path');
const { normalizeItemCode } = require('./reportReader');
const { lookupKeysForMmx, mmxCodeForOrderCode } = require('./itemCodes');
const { mergeBuildToRules } = require('./buildToStoreOverrides');
const { inferPackSizing, effectiveUnitLabel } = require('./packSizing');

const paths = require('../../src/paths');

function resolveOverridesPath() {
    if (process.env.BUILD_TO_ADMIN_OVERRIDES_PATH) {
        return process.env.BUILD_TO_ADMIN_OVERRIDES_PATH;
    }
    // Prefer sibling live-dashboard-app file so Daily shortfalls (LDA pipeline) see the same rules.
    const sibling = path.join(
        paths.root,
        '..',
        'live-dashboard-app',
        'vendors',
        'config',
        'build-to-admin-overrides.json'
    );
    try {
        if (fs.existsSync(sibling) || fs.existsSync(path.dirname(sibling))) return sibling;
    } catch {
        /* fall through */
    }
    return path.join(paths.vendors.config, 'build-to-admin-overrides.json');
}

const OVERRIDES_PATH = resolveOverridesPath();

const DEFAULT_STOCK_WARNING_DAYS = 5;

const UNIT_LABEL_RE =
    /^(boxes|bags|kgs|packs|rolls|bottles|cans|tubs|cartons|each|ea|units?|crates?|n\/a)$/i;

const VALID_VENDOR_SLUGS = new Set(['americold', 'bega', 'cutfresh', 'schweppes']);

function getValidVendorSlugs() {
    try {
        const { getAllVendorDefinitions } = require('./vendorCatalog');
        return new Set(getAllVendorDefinitions().map((d) => d.slug));
    } catch {
        return VALID_VENDOR_SLUGS;
    }
}

function isNaUnitLabel(label) {
    return /^n\s*\/\s*a$/i.test(String(label || '').trim());
}

function normalizeUnitLabel(label) {
    const text = String(label || '').trim();
    if (!text || isNaUnitLabel(text)) return 'N/a';
    if (/^ea$/i.test(text)) return 'Each';
    if (/^units?$/i.test(text)) return 'Units';
    if (/^cartons?$/i.test(text)) return text.match(/^cartons?$/i) ? 'Cartons' : text;
    const lower = text.toLowerCase();
    if (lower === 'boxes') return 'Boxes';
    if (lower === 'bags') return 'Bags';
    if (lower === 'kgs') return 'KGs';
    if (lower === 'packs') return 'Packs';
    if (lower === 'rolls') return 'Rolls';
    if (lower === 'bottles') return 'Bottles';
    if (lower === 'cans') return 'Cans';
    if (lower === 'tubs') return 'Tubs';
    if (lower === 'each') return 'Each';
    if (lower === 'crates' || lower === 'crate') return 'Crates';
    return text.charAt(0).toUpperCase() + text.slice(1);
}

function normalizeUnitsArray(raw) {
    if (!Array.isArray(raw)) return null;
    const out = [];
    for (let i = 0; i < 3; i++) {
        const part = raw[i];
        if (part == null || part === '') {
            out.push('N/a');
            continue;
        }
        const label = normalizeUnitLabel(part);
        if (!isNaUnitLabel(label) && !UNIT_LABEL_RE.test(label)) return null;
        out.push(label);
    }
    return out.length === 3 ? out : null;
}

function catalogUnitsFromItem(item) {
    if (Array.isArray(item?.unitSlots) && item.unitSlots.length === 3) {
        return item.unitSlots.map((slot) => (slot.na ? 'N/a' : slot.label));
    }
    const { normalizeUnitSlots } = require('./vendorCatalog');
    return normalizeUnitSlots(item).map((slot) => (slot.na ? 'N/a' : slot.label));
}

function unitsToSlotsAndColumns(units) {
    const { slugifyKey } = require('./vendorCatalog');
    const unitSlots = (units || []).slice(0, 3).map((label) => {
        const na = isNaUnitLabel(label);
        const text = na ? 'N/a' : normalizeUnitLabel(label);
        return {
            key: na ? null : slugifyKey(text),
            label: text,
            na,
        };
    });
    while (unitSlots.length < 3) unitSlots.push({ key: null, label: 'N/a', na: true });
    const columns = unitSlots.filter((slot) => !slot.na).map((slot) => ({ key: slot.key, label: slot.label }));
    return { unitSlots: unitSlots.slice(0, 3), columns };
}

function applyUnitsToItem(item, units, innerPerCarton) {
    const { unitSlots, columns } = unitsToSlotsAndColumns(units);
    const inner =
        innerPerCarton != null && Number.isFinite(Number(innerPerCarton)) && Number(innerPerCarton) > 0
            ? Number(innerPerCarton)
            : null;
    return {
        ...item,
        unitSlots,
        columns,
        innerPerCarton: inner,
    };
}

let cache = null;
let cacheMtime = 0;

function emptyDoc() {
    return { settings: { stockWarningDays: DEFAULT_STOCK_WARNING_DAYS }, global: {}, areas: {}, stores: {} };
}

function readOverridesDoc() {
    try {
        if (!fs.existsSync(OVERRIDES_PATH)) return emptyDoc();
        const stat = fs.statSync(OVERRIDES_PATH);
        if (cache && stat.mtimeMs === cacheMtime) return cache;
        const raw = JSON.parse(fs.readFileSync(OVERRIDES_PATH, 'utf8'));
        cache = {
            settings: {
                stockWarningDays:
                    raw.settings?.stockWarningDays != null &&
                    Number.isFinite(Number(raw.settings.stockWarningDays))
                        ? Number(raw.settings.stockWarningDays)
                        : DEFAULT_STOCK_WARNING_DAYS,
            },
            global: raw.global && typeof raw.global === 'object' ? raw.global : {},
            areas: raw.areas && typeof raw.areas === 'object' ? raw.areas : {},
            stores: raw.stores && typeof raw.stores === 'object' ? raw.stores : {},
        };
        cacheMtime = stat.mtimeMs;
        return cache;
    } catch {
        return emptyDoc();
    }
}

function writeOverridesDoc(doc) {
    const next = {
        settings: {
            stockWarningDays:
                doc.settings?.stockWarningDays != null &&
                Number.isFinite(Number(doc.settings.stockWarningDays))
                    ? Number(doc.settings.stockWarningDays)
                    : DEFAULT_STOCK_WARNING_DAYS,
        },
        global: doc.global && typeof doc.global === 'object' ? doc.global : {},
        areas: doc.areas && typeof doc.areas === 'object' ? doc.areas : {},
        stores: doc.stores && typeof doc.stores === 'object' ? doc.stores : {},
    };
    fs.mkdirSync(path.dirname(OVERRIDES_PATH), { recursive: true });
    fs.writeFileSync(OVERRIDES_PATH, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    cache = next;
    cacheMtime = fs.statSync(OVERRIDES_PATH).mtimeMs;
    return next;
}

function normalizeCodeList(raw) {
    if (raw == null) return [];
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

function normalizeRule(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const rule = {};
    if (raw.buildToDays != null && Number.isFinite(Number(raw.buildToDays))) {
        rule.buildToDays = Number(raw.buildToDays);
    }
    if (raw.buildToAdd != null && Number.isFinite(Number(raw.buildToAdd))) {
        rule.buildToAdd = Number(raw.buildToAdd);
    }
    if (raw.buildToFixed != null && Number.isFinite(Number(raw.buildToFixed))) {
        rule.buildToFixed = Number(raw.buildToFixed);
    }
    if (raw.buildToManual === true) rule.buildToManual = true;
    if (raw.buildToOrderManual === true) rule.buildToOrderManual = true;
    if (raw.onHandOnly === true) rule.onHandOnly = true;
    if (raw.skipKeyItemCount === true) rule.skipKeyItemCount = true;
    if (raw.skipKeyItemCount === false) rule.skipKeyItemCount = false;
    if (raw.skipStockCount === true) rule.skipStockCount = true;
    if (raw.skipStockCount === false) rule.skipStockCount = false;
    if (raw.includeDaily === true) rule.includeDaily = true;
    if (raw.includeDaily === false) rule.includeDaily = false;
    if (raw.stockWarningDays != null && Number.isFinite(Number(raw.stockWarningDays))) {
        rule.stockWarningDays = Number(raw.stockWarningDays);
    }
    if (raw.excludeFromShortfall === true) rule.excludeFromShortfall = true;
    if (raw.excludeFromShortfall === false) rule.excludeFromShortfall = false;
    if (raw.mmxCode != null && String(raw.mmxCode).trim() !== '') {
        rule.mmxCode = normalizeItemCode(raw.mmxCode);
    }
    if (raw.vendorCode != null && String(raw.vendorCode).trim() !== '') {
        rule.vendorCode = normalizeItemCode(raw.vendorCode);
    }
    if (Array.isArray(raw.fallbackCodes)) {
        rule.fallbackCodes = normalizeCodeList(raw.fallbackCodes);
    }
    if (raw.vendorSlug != null && String(raw.vendorSlug).trim() !== '') {
        const slug = String(raw.vendorSlug).trim().toLowerCase();
        if (getValidVendorSlugs().has(slug)) rule.vendorSlug = slug;
    }
    if (Array.isArray(raw.units)) {
        const units = normalizeUnitsArray(raw.units);
        if (units) rule.units = units;
    }
    if (raw.innerPerCarton != null && Number.isFinite(Number(raw.innerPerCarton))) {
        rule.innerPerCarton = Number(raw.innerPerCarton);
    }
    if (raw.unitsPerPack != null && Number.isFinite(Number(raw.unitsPerPack))) {
        rule.unitsPerPack = Number(raw.unitsPerPack);
    }
    return Object.keys(rule).length ? rule : null;
}

function resolveAdminRuleForFields(item, options = {}) {
    const code = normalizeItemCode(item?.itemCode);
    if (!code) return null;
    const store = String(options.storeNumber || options.store || '').trim();
    const area = String(options.area || '').trim();
    if (store) return adminOverridesForStore(store).get(code) || null;
    if (area) return adminOverridesForScope({ level: 'area', area }).get(code) || null;
    if (options.level === 'global') return adminOverridesForScope({ level: 'global' }).get(code) || null;
    return null;
}

function effectiveCatalogItemFields(item, options = {}) {
    const catalogVendorSlug = String(options.catalogVendorSlug || options.vendorSlug || '').trim().toLowerCase();
    const adminRule = resolveAdminRuleForFields(item, options);
    const fileUnits = catalogUnitsFromItem(item);
    let effectiveVendorSlug = catalogVendorSlug;
    if (adminRule?.vendorSlug && getValidVendorSlugs().has(adminRule.vendorSlug)) {
        effectiveVendorSlug = adminRule.vendorSlug;
    }
    let units = fileUnits;
    if (Array.isArray(adminRule?.units) && adminRule.units.length === 3) {
        units = adminRule.units;
    }
    let innerPerCarton =
        item.innerPerCarton != null && Number.isFinite(Number(item.innerPerCarton))
            ? Number(item.innerPerCarton)
            : null;
    if (adminRule && Object.prototype.hasOwnProperty.call(adminRule, 'innerPerCarton')) {
        innerPerCarton =
            adminRule.innerPerCarton != null && Number.isFinite(Number(adminRule.innerPerCarton))
                ? Number(adminRule.innerPerCarton)
                : null;
    }
    const inferred = inferPackSizing(
        item.name || item.description,
        effectiveUnitLabel(units),
        item.innerPerCarton
    );
    if (innerPerCarton == null && inferred.packsPerBox != null) {
        innerPerCarton = inferred.packsPerBox;
    }
    let unitsPerPack = inferred.unitsPerPack;
    if (adminRule && Object.prototype.hasOwnProperty.call(adminRule, 'unitsPerPack')) {
        unitsPerPack =
            adminRule.unitsPerPack != null && Number.isFinite(Number(adminRule.unitsPerPack))
                ? Number(adminRule.unitsPerPack)
                : null;
    }
    const merged = applyUnitsToItem(item, units, innerPerCarton);
    const fileInferred = inferPackSizing(
        item.name || item.description,
        effectiveUnitLabel(fileUnits),
        item.innerPerCarton
    );
    return {
        catalogVendorSlug,
        effectiveVendorSlug,
        units,
        fileUnits,
        innerPerCarton: merged.innerPerCarton,
        unitsPerPack,
        fileInnerPerCarton:
            item.innerPerCarton != null && Number.isFinite(Number(item.innerPerCarton))
                ? Number(item.innerPerCarton)
                : null,
        fileUnitsPerPack: fileInferred.unitsPerPack,
        unitSlots: merged.unitSlots,
        columns: merged.columns,
        scopeVendorSlug: adminRule?.vendorSlug ?? null,
        scopeUnits: adminRule?.units ?? null,
        scopeInnerPerCarton: adminRule?.innerPerCarton ?? null,
        scopeUnitsPerPack: adminRule?.unitsPerPack ?? null,
    };
}

function effectiveSkipStockCount(catalogItem, storeNumber) {
    if (!catalogItem) return true;
    const code = normalizeItemCode(catalogItem.itemCode);
    if (!code) return Boolean(catalogItem.skipStockCount);
    const adminRule = adminOverridesForStore(storeNumber).get(code);
    if (adminRule && typeof adminRule.skipStockCount === 'boolean') {
        return adminRule.skipStockCount;
    }
    return Boolean(catalogItem.skipStockCount);
}

function effectiveSkipKeyItemCount(catalogItem, storeNumber) {
    if (!catalogItem) return true;
    const code = normalizeItemCode(catalogItem.itemCode);
    if (!code) return Boolean(catalogItem.skipKeyItemCount);
    const adminRule = adminOverridesForStore(storeNumber).get(code);
    if (adminRule && typeof adminRule.skipKeyItemCount === 'boolean') {
        return adminRule.skipKeyItemCount;
    }
    return Boolean(catalogItem.skipKeyItemCount);
}

function effectiveIncludeDaily(catalogItem, storeNumber) {
    if (!catalogItem) return false;
    const code = normalizeItemCode(catalogItem.itemCode);
    if (!code) return Boolean(catalogItem.includeDaily);
    const adminRule = adminOverridesForStore(storeNumber).get(code);
    if (adminRule && typeof adminRule.includeDaily === 'boolean') {
        return adminRule.includeDaily;
    }
    return Boolean(catalogItem.includeDaily);
}

function applySkipKeyItemCountOverridesToCatalog(catalog, storeNumber) {
    return applyAdminCatalogOverrides(catalog, storeNumber);
}

function applyAdminCatalogOverrides(catalog, storeNumber, catalogVendorSlug) {
    if (!catalog?.items?.length) return catalog;
    const store = String(storeNumber || '').trim();
    const vendorSlug = String(catalogVendorSlug || '').trim().toLowerCase();
    if (!store) return catalog;
    return {
        ...catalog,
        items: (catalog.items || []).map((item) => {
            const fields = effectiveCatalogItemFields(item, { storeNumber: store, catalogVendorSlug: vendorSlug });
            return {
                ...item,
                skipStockCount: effectiveSkipStockCount(item, store),
                skipKeyItemCount: effectiveSkipKeyItemCount(item, store),
                includeDaily: effectiveIncludeDaily(item, store),
                unitSlots: fields.unitSlots,
                columns: fields.columns,
                innerPerCarton: fields.innerPerCarton,
                unitsPerPack: fields.unitsPerPack,
                effectiveVendorSlug: fields.effectiveVendorSlug,
                catalogVendorSlug: fields.catalogVendorSlug,
            };
        }),
    };
}

function mergeItemOverridePatch(existing, itemPatch) {
    const merged = { ...(existing || {}), ...itemPatch };
    const clearKeys = [
        'skipKeyItemCount',
        'skipStockCount',
        'includeDaily',
        'buildToDays',
        'buildToAdd',
        'buildToFixed',
        'buildToManual',
        'buildToOrderManual',
        'onHandOnly',
        'stockWarningDays',
        'excludeFromShortfall',
        'mmxCode',
        'vendorCode',
        'fallbackCodes',
        'vendorSlug',
        'units',
        'innerPerCarton',
        'unitsPerPack',
    ];
    for (const key of clearKeys) {
        if (itemPatch?.[key] === null) delete merged[key];
    }
    return Object.keys(merged).length ? merged : null;
}

function registerOverrideKeys(map, itemCode, rule) {
    const raw = normalizeItemCode(itemCode);
    if (!raw || !rule) return;
    const mmx = mmxCodeForOrderCode(raw) || raw;
    const keys = new Set([raw, ...lookupKeysForMmx(mmx)]);
    for (const key of keys) {
        if (key) map.set(key, rule);
    }
}

function adminOverridesForStore(storeNumber) {
    const doc = readOverridesDoc();
    const storeKey = String(storeNumber || '').trim();
    const map = new Map();

    for (const [itemCode, rawRule] of Object.entries(doc.global || {})) {
        const rule = normalizeRule(rawRule);
        if (rule) registerOverrideKeys(map, itemCode, rule);
    }

    let areaKey = '';
    if (storeKey) {
        const { areaForStoreNumber } = require('./itemCodeOverrides');
        areaKey = areaForStoreNumber(storeKey);
    }
    const areaRules = areaKey ? doc.areas?.[areaKey] : null;
    if (areaRules && typeof areaRules === 'object') {
        for (const [itemCode, rawRule] of Object.entries(areaRules)) {
            const rule = normalizeRule(rawRule);
            if (!rule) continue;
            const existing = [...map.keys()].find((k) => normalizeItemCode(k) === normalizeItemCode(itemCode));
            const merged = mergeBuildToRules(existing ? map.get(existing) : null, rule);
            registerOverrideKeys(map, itemCode, merged);
        }
    }

    const storeRules = storeKey ? doc.stores?.[storeKey] : null;
    if (storeRules && typeof storeRules === 'object') {
        for (const [itemCode, rawRule] of Object.entries(storeRules)) {
            const rule = normalizeRule(rawRule);
            if (!rule) continue;
            const existing = [...map.keys()].find((k) => normalizeItemCode(k) === normalizeItemCode(itemCode));
            const merged = mergeBuildToRules(existing ? map.get(existing) : null, rule);
            registerOverrideKeys(map, itemCode, merged);
        }
    }

    return map;
}

function adminOverridesForScope(scope = {}) {
    const doc = readOverridesDoc();
    const map = new Map();
    const level = scope.level || 'global';
    const areaKey = String(scope.area || '').trim();
    const storeKey = String(scope.store || '').trim();

    const applyLayer = (layer) => {
        if (!layer || typeof layer !== 'object') return;
        for (const [itemCode, rawRule] of Object.entries(layer)) {
            const rule = normalizeRule(rawRule);
            if (!rule) continue;
            const existing = [...map.keys()].find((k) => normalizeItemCode(k) === normalizeItemCode(itemCode));
            const merged = mergeBuildToRules(existing ? map.get(existing) : null, rule);
            registerOverrideKeys(map, itemCode, merged);
        }
    };

    if (level === 'global') {
        applyLayer(doc.global);
        return map;
    }
    applyLayer(doc.global);
    if (level === 'area' || level === 'store') {
        if (areaKey) applyLayer(doc.areas?.[areaKey]);
    }
    if (level === 'store' && storeKey) {
        applyLayer(doc.stores?.[storeKey]);
    }
    return map;
}

function patchOverrides({ global = null, areas = null, stores = null, settings = null }) {
    const doc = readOverridesDoc();
    if (settings && typeof settings === 'object') {
        doc.settings = doc.settings || {};
        if (settings.stockWarningDays != null) {
            const n = Number(settings.stockWarningDays);
            if (Number.isFinite(n) && n > 0) doc.settings.stockWarningDays = n;
            else delete doc.settings.stockWarningDays;
        }
    }
    if (global && typeof global === 'object') {
        doc.global = doc.global || {};
        for (const [itemCode, itemPatch] of Object.entries(global)) {
            if (itemPatch == null) {
                delete doc.global[itemCode];
                continue;
            }
            const merged = mergeItemOverridePatch(doc.global[itemCode], itemPatch);
            if (merged) doc.global[itemCode] = merged;
            else delete doc.global[itemCode];
        }
    }
    if (areas && typeof areas === 'object') {
        doc.areas = doc.areas || {};
        for (const [areaName, patch] of Object.entries(areas)) {
            const ak = String(areaName || '').trim();
            if (!ak) continue;
            if (patch == null) {
                delete doc.areas[ak];
                continue;
            }
            doc.areas[ak] = doc.areas[ak] || {};
            for (const [itemCode, itemPatch] of Object.entries(patch)) {
                if (itemPatch == null) {
                    delete doc.areas[ak][itemCode];
                    continue;
                }
                const merged = mergeItemOverridePatch(doc.areas[ak][itemCode], itemPatch);
                if (merged) doc.areas[ak][itemCode] = merged;
                else delete doc.areas[ak][itemCode];
            }
            if (!Object.keys(doc.areas[ak]).length) delete doc.areas[ak];
        }
    }
    if (stores && typeof stores === 'object') {
        doc.stores = doc.stores || {};
        for (const [storeNumber, patch] of Object.entries(stores)) {
            const sk = String(storeNumber || '').trim();
            if (!sk) continue;
            if (patch == null) {
                delete doc.stores[sk];
                continue;
            }
            doc.stores[sk] = doc.stores[sk] || {};
            for (const [itemCode, itemPatch] of Object.entries(patch)) {
                if (itemPatch == null) {
                    delete doc.stores[sk][itemCode];
                    continue;
                }
                const merged = mergeItemOverridePatch(doc.stores[sk][itemCode], itemPatch);
                if (merged) doc.stores[sk][itemCode] = merged;
                else delete doc.stores[sk][itemCode];
            }
            if (!Object.keys(doc.stores[sk]).length) delete doc.stores[sk];
        }
    }
    return writeOverridesDoc(doc);
}

function purgeItemFromOverrides(itemCode) {
    const code = normalizeItemCode(itemCode);
    if (!code) throw new Error('Item code is required.');
    const doc = readOverridesDoc();
    let changed = false;

    if (doc.global?.[code]) {
        delete doc.global[code];
        changed = true;
    }
    for (const areaKey of Object.keys(doc.areas || {})) {
        if (!doc.areas[areaKey]?.[code]) continue;
        delete doc.areas[areaKey][code];
        changed = true;
        if (!Object.keys(doc.areas[areaKey]).length) delete doc.areas[areaKey];
    }
    for (const storeKey of Object.keys(doc.stores || {})) {
        if (!doc.stores[storeKey]?.[code]) continue;
        delete doc.stores[storeKey][code];
        changed = true;
        if (!Object.keys(doc.stores[storeKey]).length) delete doc.stores[storeKey];
    }

    if (changed) writeOverridesDoc(doc);
    return { itemCode: code };
}

const BUILD_TO_CONFIGURE_KEYS = [
    'mmxCode',
    'vendorCode',
    'fallbackCodes',
    'vendorSlug',
    'units',
    'innerPerCarton',
    'unitsPerPack',
    'catalogName',
    'displayName',
];

function stripConfigureFieldsFromScopePatch(scopePatch) {
    if (!scopePatch || typeof scopePatch !== 'object') return scopePatch;
    const out = {};
    for (const [itemCode, rule] of Object.entries(scopePatch)) {
        if (rule == null) {
            out[itemCode] = rule;
            continue;
        }
        if (typeof rule !== 'object') continue;
        const next = { ...rule };
        for (const key of BUILD_TO_CONFIGURE_KEYS) delete next[key];
        if (Object.keys(next).length) out[itemCode] = next;
    }
    return out;
}

/** Remove configure-field overrides from a build-to patch (store managers may not edit codes/units). */
function stripItemCodeFieldsFromBuildToPatch(patch) {
    if (!patch || typeof patch !== 'object') return patch;
    const out = { ...patch };
    if (out.global) out.global = stripConfigureFieldsFromScopePatch(out.global);
    if (out.areas) {
        out.areas = {};
        for (const [area, areaPatch] of Object.entries(patch.areas)) {
            out.areas[area] = stripConfigureFieldsFromScopePatch(areaPatch);
        }
    }
    if (out.stores) {
        out.stores = {};
        for (const [store, storePatch] of Object.entries(patch.stores)) {
            out.stores[store] = stripConfigureFieldsFromScopePatch(storePatch);
        }
    }
    return out;
}

module.exports = {
    OVERRIDES_PATH,
    DEFAULT_STOCK_WARNING_DAYS,
    readOverridesDoc,
    writeOverridesDoc,
    patchOverrides,
    purgeItemFromOverrides,
    stripItemCodeFieldsFromBuildToPatch,
    adminOverridesForStore,
    adminOverridesForScope,
    normalizeRule,
    normalizeCodeList,
    effectiveSkipKeyItemCount,
    effectiveSkipStockCount,
    effectiveIncludeDaily,
    applySkipKeyItemCountOverridesToCatalog,
    applyAdminCatalogOverrides,
    effectiveCatalogItemFields,
    normalizeUnitsArray,
    catalogUnitsFromItem,
    unitsToSlotsAndColumns,
    BUILD_TO_CONFIGURE_KEYS,
    VALID_VENDOR_SLUGS,
};
