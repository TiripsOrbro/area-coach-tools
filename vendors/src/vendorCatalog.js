const fs = require('fs');
const { lookupKeysForMmx, mmxCodeForOrderCode, allLookupKeys } = require('./itemCodes');
const { stockCountDisplayName } = require('./stockCountDisplayNames');
const { normalizeItemCode } = require('./reportReader');

const path = require('path');
const paths = require('../../src/paths');
const VENDORS_DIR = paths.vendors.catalogs;
const VENDOR_EXAMPLES_DIR = path.join(paths.vendors.root, 'examples');

/** Macromatix display label → dotfile slug and filename. */
const VENDOR_DEFINITIONS = [
    { slug: 'americold', label: 'Americold', dotfile: '.Americold', example: '.Americold.example' },
    { slug: 'bega', label: 'Bega', dotfile: '.Bega', example: '.Bega.example' },
    { slug: 'cutfresh', label: 'Cut Fresh', dotfile: '.CutFresh', example: '.CutFresh.example' },
    { slug: 'schweppes', label: 'Schweppes', dotfile: '.Schweppes', example: '.Schweppes.example' },
];

const CUSTOM_VENDORS_PATH =
    process.env.CUSTOM_VENDORS_PATH || path.join(paths.vendors.config, 'custom-vendors.json');

const catalogCache = new Map();
let customVendorCache = null;
let customVendorMtime = 0;

/** Fixed unit columns per item line, before per-item location segments. */
const UNIT_SLOTS = 3;

const UNIT_LABEL_RE =
    /^(boxes|bags|kgs|packs|rolls|bottles|cans|tubs|cartons|each|ea|units?|crates?|n\/a)$/i;

function slugifyKey(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

function isNaUnit(label) {
    return /^n\s*\/\s*a$/i.test(String(label || '').trim());
}

/** Three fixed unit slots matching the vendor file column order (N/a keeps its position). */
function normalizeUnitSlots(item) {
    if (Array.isArray(item.unitSlots) && item.unitSlots.length === UNIT_SLOTS) {
        return item.unitSlots;
    }
    const cols = Array.isArray(item.columns) ? item.columns : [];
    if (cols.length === 2) {
        return [
            { key: cols[0].key, label: cols[0].label, na: false },
            { key: null, label: 'N/a', na: true },
            { key: cols[1].key, label: cols[1].label, na: false },
        ];
    }
    if (cols.length === 1) {
        return [
            { key: null, label: 'N/a', na: true },
            { key: null, label: 'N/a', na: true },
            { key: cols[0].key, label: cols[0].label, na: false },
        ];
    }
    if (cols.length >= UNIT_SLOTS) {
        return cols.slice(0, UNIT_SLOTS).map((col) => ({ key: col.key, label: col.label, na: false }));
    }
    const slots = cols.map((col) => ({ key: col.key, label: col.label, na: false }));
    while (slots.length < UNIT_SLOTS) {
        slots.push({ key: null, label: 'N/a', na: true });
    }
    return slots.slice(0, UNIT_SLOTS);
}

function resolveCatalogPath(def) {
    if (isVendorDisabled(def.slug)) return null;
    const live = path.join(VENDORS_DIR, def.dotfile);
    if (fs.existsSync(live)) return live;
    const example = path.join(VENDOR_EXAMPLES_DIR, def.example);
    if (def.example && fs.existsSync(example)) return example;
    return null;
}

/** Live dotfile path for catalog edits; seeds from example when Pi/live file is missing. */
function ensureLiveCatalogPath(def) {
    const livePath = path.join(VENDORS_DIR, def.dotfile);
    if (fs.existsSync(livePath)) return livePath;

    const sourcePath = resolveCatalogPath(def);
    if (!sourcePath) {
        throw new Error(`Vendor catalog file ${def.dotfile} not found on this server.`);
    }

    fs.mkdirSync(VENDORS_DIR, { recursive: true });
    fs.copyFileSync(sourcePath, livePath);
    catalogCache.clear();
    return livePath;
}

function normalizeCustomVendorEntry(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const label = String(raw.label || '').trim();
    const slug = String(raw.slug || slugifyKey(label)).trim();
    if (!slug || !label) return null;
    const dotfile = String(raw.dotfile || `.${label.replace(/[^A-Za-z0-9]+/g, '')}`).trim();
    return { slug, label, dotfile, custom: true };
}

function readCustomVendorsDoc() {
    try {
        if (!fs.existsSync(CUSTOM_VENDORS_PATH)) return { vendors: [], disabledSlugs: [] };
        const raw = JSON.parse(fs.readFileSync(CUSTOM_VENDORS_PATH, 'utf8'));
        return {
            vendors: Array.isArray(raw.vendors) ? raw.vendors : [],
            disabledSlugs: Array.isArray(raw.disabledSlugs)
                ? raw.disabledSlugs.map(slugifyKey).filter(Boolean)
                : [],
        };
    } catch {
        return { vendors: [], disabledSlugs: [] };
    }
}

function writeCustomVendorsDoc(doc) {
    const payload = {
        vendors: Array.isArray(doc.vendors) ? doc.vendors : [],
        disabledSlugs: [...new Set((doc.disabledSlugs || []).map(slugifyKey).filter(Boolean))],
    };
    fs.mkdirSync(path.dirname(CUSTOM_VENDORS_PATH), { recursive: true });
    fs.writeFileSync(CUSTOM_VENDORS_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    invalidateVendorRegistry();
}

function readDisabledVendorSlugs() {
    return new Set(readCustomVendorsDoc().disabledSlugs);
}

function isVendorDisabled(slug) {
    return readDisabledVendorSlugs().has(slugifyKey(slug));
}

function readCustomVendorDefinitions() {
    try {
        if (!fs.existsSync(CUSTOM_VENDORS_PATH)) return [];
        const stat = fs.statSync(CUSTOM_VENDORS_PATH);
        if (customVendorCache && stat.mtimeMs === customVendorMtime) return customVendorCache;
        const doc = readCustomVendorsDoc();
        customVendorCache = doc.vendors.map(normalizeCustomVendorEntry).filter(Boolean);
        customVendorMtime = stat.mtimeMs;
        return customVendorCache;
    } catch {
        return [];
    }
}

function invalidateVendorRegistry() {
    customVendorCache = null;
    customVendorMtime = 0;
    catalogCache.clear();
}

function getAllVendorDefinitions() {
    const disabled = readDisabledVendorSlugs();
    const seen = new Set();
    const out = [];
    for (const def of VENDOR_DEFINITIONS) {
        if (seen.has(def.slug) || disabled.has(def.slug)) continue;
        seen.add(def.slug);
        out.push(def);
    }
    for (const def of readCustomVendorDefinitions()) {
        if (seen.has(def.slug)) continue;
        seen.add(def.slug);
        out.push(def);
    }
    return out;
}

function listAllVendorDefinitions() {
    return getAllVendorDefinitions().map((def) => {
        const catalog = readCatalogForDefinition(def);
        return {
            slug: def.slug,
            label: def.label,
            configured: Boolean(catalog?.items?.length),
            custom: Boolean(def.custom),
            builtIn: Boolean(VENDOR_DEFINITIONS.some((row) => row.slug === def.slug)),
        };
    });
}

function registerCustomVendor({ label, slug: slugInput }) {
    const labelText = String(label || '').trim();
    if (!labelText) throw new Error('Vendor label is required.');
    const slug = String(slugInput || slugifyKey(labelText)).trim();
    if (!slug) throw new Error('Could not derive vendor slug.');

    const builtIn = VENDOR_DEFINITIONS.find((d) => d.slug === slug);
    const custom = readCustomVendorDefinitions();
    const existingCustom = custom.find((d) => d.slug === slug);
    if (builtIn && !existingCustom && !isVendorDisabled(slug)) {
        throw new Error(`Vendor "${builtIn.label}" already exists. Choose a different name.`);
    }

    const dotfile =
        existingCustom?.dotfile || `.${labelText.replace(/[^A-Za-z0-9]+/g, '')}` || `.${slug}`;
    const entry = { slug, label: labelText, dotfile };

    let doc = readCustomVendorsDoc();
    doc.vendors = Array.isArray(doc.vendors) ? doc.vendors : [];
    const idx = doc.vendors.findIndex((v) => String(v.slug || '').trim().toLowerCase() === slug);
    if (idx >= 0) doc.vendors[idx] = entry;
    else doc.vendors.push(entry);
    doc.disabledSlugs = (doc.disabledSlugs || []).filter((s) => slugifyKey(s) !== slug);

    writeCustomVendorsDoc(doc);

    const livePath = path.join(VENDORS_DIR, dotfile);
    if (!fs.existsSync(livePath)) {
        fs.writeFileSync(livePath, `# vendor: ${labelText}\n\n`, 'utf8');
    }

    return { ...entry, custom: true };
}

function removeCustomVendor(slug) {
    const normalized = slugifyKey(slug);
    if (!normalized) throw new Error('Vendor slug is required.');

    const def =
        getVendorDefinition(normalized) ||
        VENDOR_DEFINITIONS.find((row) => row.slug === normalized) ||
        readCustomVendorDefinitions().find((row) => row.slug === normalized);
    if (!def) throw new Error('Unknown vendor.');

    const isBuiltIn = VENDOR_DEFINITIONS.some((row) => row.slug === normalized);
    let doc = readCustomVendorsDoc();
    doc.vendors = (doc.vendors || []).filter((v) => slugifyKey(v.slug) !== normalized);
    if (isBuiltIn) {
        const disabled = new Set(doc.disabledSlugs || []);
        disabled.add(normalized);
        doc.disabledSlugs = [...disabled];
    }
    writeCustomVendorsDoc(doc);

    const livePath = path.join(VENDORS_DIR, def.dotfile);
    if (fs.existsSync(livePath)) {
        fs.unlinkSync(livePath);
    }

    try {
        const { removeVendorOrdersForCatalogSlug } = require('./vendorOrdersConfig');
        removeVendorOrdersForCatalogSlug(normalized);
    } catch (err) {
        console.warn('[vendorCatalog] Could not update vendor-orders after vendor removal:', err.message);
    }

    return { slug: normalized, label: def.label, builtIn: isBuiltIn };
}

function readCatalogFileSections(def) {
    const filePath = resolveCatalogPath(def);
    if (!filePath) return { header: [], itemLines: [], filePath: null };
    const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
    const header = [];
    const itemLines = [];
    for (const line of lines) {
        const trimmed = String(line || '').trim();
        if (!trimmed) continue;
        if (trimmed.startsWith('#')) header.push(line);
        else itemLines.push(line);
    }
    return { header, itemLines, filePath };
}

function looksLikeUnitLabel(value) {
    const label = String(value || '').trim();
    if (!label || isNaUnit(label)) return true;
    return UNIT_LABEL_RE.test(label);
}

function parseLocationListComment(line, key) {
    const m = String(line || '').match(new RegExp(`^#\\s*${key}:\\s*(.+)$`, 'i'));
    if (!m) return null;
    return m[1]
        .split('|')
        .map((p) => p.trim())
        .filter(Boolean);
}

function parseLocationsFromComment(line) {
    return parseLocationListComment(line, 'locations');
}

function parseLocationOrderComment(line) {
    return parseLocationListComment(line, 'location-order');
}

function looksLikeItemCode(value) {
    const s = String(value || '').trim();
    if (/^\d{3,10}$/.test(s)) return true;
    // Alphanumeric supplier codes (e.g. SLETT, DTOM4, 38246A, V366S0398)
    if (/^[A-Za-z0-9]{2,12}$/.test(s) && (/\d/.test(s) || /^[A-Z0-9]+$/.test(s))) return true;
    // Macromatix codes with suffixes e.g. SILA(G)260X260
    if (/^[A-Za-z0-9()[\]/]{2,24}$/.test(s) && /\d/.test(s)) return true;
    return false;
}

/** Leading column: `order=N`, `manual=N`, `=N`, `oh:N`, days, or `manual` (see VENDOR-FORMAT.md). */
function parseBuildToPrefix(parts) {
    if (!parts.length) return null;
    const first = String(parts[0] || '').trim();
    if (!first) return null;

    const ohDaysPlus = first.match(/^oh:(\d{1,2})\+([\d.]+)$/i);
    if (ohDaysPlus) {
        const days = Number(ohDaysPlus[1]);
        const add = Number(ohDaysPlus[2]);
        if (days >= 1 && days <= 31 && Number.isFinite(add) && add >= 0) {
            return {
                buildToManual: false,
                buildToOrderManual: false,
                skipKeyItemCount: true,
                skipStockCount: true,
                buildToDays: days,
                buildToAdd: add,
                buildToFixed: null,
                rest: parts.slice(1),
            };
        }
    }

    const ohMatch = first.match(/^oh:(\d{1,2})$/i);
    if (ohMatch) {
        const days = Number(ohMatch[1]);
        if (days >= 1 && days <= 31) {
            return {
                buildToManual: false,
                buildToOrderManual: false,
                skipKeyItemCount: true,
                skipStockCount: true,
                buildToDays: days,
                buildToAdd: 0,
                buildToFixed: null,
                rest: parts.slice(1),
            };
        }
    }

    const orderMatch = first.match(/^order=(\d+(?:\.\d+)?)$/i);
    if (orderMatch) {
        const buildToFixed = Number(orderMatch[1]);
        if (Number.isFinite(buildToFixed) && buildToFixed >= 0 && buildToFixed <= 999) {
            return {
                buildToManual: false,
                buildToOrderManual: true,
                skipKeyItemCount: true,
                skipStockCount: false,
                buildToDays: null,
                buildToAdd: 0,
                buildToFixed,
                rest: parts.slice(1),
            };
        }
    }

    const fixedMatch = first.match(/^=(\d+(?:\.\d+)?)$/);
    if (fixedMatch) {
        const buildToFixed = Number(fixedMatch[1]);
        if (Number.isFinite(buildToFixed) && buildToFixed >= 0 && buildToFixed <= 999) {
            return {
                buildToManual: false,
                buildToOrderManual: false,
                skipKeyItemCount: false,
                skipStockCount: false,
                buildToDays: null,
                buildToAdd: 0,
                buildToFixed,
                rest: parts.slice(1),
            };
        }
    }

    const manualParMatch = first.match(/^manual=(\d+(?:\.\d+)?)$/i);
    if (manualParMatch) {
        const buildToFixed = Number(manualParMatch[1]);
        if (Number.isFinite(buildToFixed) && buildToFixed >= 0 && buildToFixed <= 999) {
            return {
                buildToManual: true,
                buildToOrderManual: true,
                skipKeyItemCount: true,
                skipStockCount: false,
                buildToDays: null,
                buildToAdd: 0,
                buildToFixed,
                rest: parts.slice(1),
            };
        }
    }

    if (/^manual$/i.test(first) || /^m$/i.test(first)) {
        return {
            buildToManual: true,
            buildToOrderManual: false,
            skipKeyItemCount: true,
            skipStockCount: false,
            buildToDays: null,
            buildToAdd: 0,
            buildToFixed: null,
            rest: parts.slice(1),
        };
    }

    if (/^ignore$/i.test(first) || /^skip$/i.test(first)) {
        return {
            buildToManual: true,
            buildToOrderManual: false,
            skipKeyItemCount: true,
            skipStockCount: true,
            buildToDays: null,
            buildToAdd: 0,
            buildToFixed: null,
            rest: parts.slice(1),
        };
    }

    const daysPlus = first.match(/^(\d{1,2})\+([\d.]+)$/);
    if (daysPlus) {
        const days = Number(daysPlus[1]);
        const add = Number(daysPlus[2]);
        if (days >= 1 && days <= 31 && Number.isFinite(add) && add >= 0) {
            return {
                buildToManual: false,
                buildToOrderManual: false,
                skipKeyItemCount: false,
                skipStockCount: false,
                buildToDays: days,
                buildToAdd: add,
                buildToFixed: null,
                rest: parts.slice(1),
            };
        }
    }

    if (/^\d{1,2}$/.test(first)) {
        const days = Number(first);
        if (days >= 1 && days <= 31) {
            return {
                buildToManual: false,
                buildToOrderManual: false,
                skipKeyItemCount: false,
                skipStockCount: false,
                buildToDays: days,
                buildToAdd: 0,
                buildToFixed: null,
                rest: parts.slice(1),
            };
        }
    }

    return null;
}

function parseItemIdentity(parts) {
    if (parts.length < 1 + UNIT_SLOTS) return null;

    if (
        parts.length >= 2 + UNIT_SLOTS &&
        looksLikeUnitLabel(parts[2]) &&
        looksLikeItemCode(parts[0])
    ) {
        return { itemCode: parts[0], name: parts[1], unitStart: 2 };
    }
    if (looksLikeUnitLabel(parts[1])) {
        return { itemCode: '', name: parts[0], unitStart: 1 };
    }
    return null;
}

function buildCatalogLocations(items, locationOrder, vendorDefaultLocations) {
    const used = new Set();
    for (const item of items) {
        for (const loc of item.locations) used.add(loc);
    }

    const ordered = [];
    const pushUnique = (loc) => {
        if (!loc || !used.has(loc) || ordered.includes(loc)) return;
        ordered.push(loc);
    };

    for (const loc of locationOrder) pushUnique(loc);
    for (const loc of vendorDefaultLocations) pushUnique(loc);
    const rest = [...used].filter((loc) => !ordered.includes(loc)).sort((a, b) => a.localeCompare(b));
    ordered.push(...rest);

    if (!ordered.length) ordered.push('Default');
    return ordered;
}

function parseVendorFromComment(line) {
    const m = String(line || '').match(/^#\s*vendor:\s*(.+)$/i);
    return m ? m[1].trim() : '';
}

function isItemCode(value) {
    return /^\d{3,10}$/.test(String(value || '').trim());
}

function sectionToMmxOrderClass(sectionName) {
    const s = String(sectionName || '').toLowerCase();
    if (s.includes('carryover')) return 'DRY';
    if (s.includes('dry')) return 'DRY';
    if (s.includes('fridge')) return 'FRG';
    return 'FRZ';
}

/** Trailing token: 3811=+2 | 3811=10+2 | 3811=12 - per-store build-to tweak on this line. */
function parseStoreBuildToHint(part) {
    const raw = String(part || '').trim();
    const m = raw.match(/^(\d{4})=(.+)$/);
    if (!m) return null;
    const store = m[1];
    const expr = m[2].trim();

    const daysPlus = expr.match(/^(\d{1,2})\+([\d.]+)$/);
    if (daysPlus) {
        const days = Number(daysPlus[1]);
        const add = Number(daysPlus[2]);
        if (days >= 1 && days <= 31 && Number.isFinite(add) && add >= 0) {
            return { store, buildToDays: days, buildToAdd: add };
        }
        return null;
    }

    if (/^\+/.test(expr)) {
        const add = Number(expr.slice(1));
        if (Number.isFinite(add) && add >= 0) return { store, buildToAdd: add };
        return null;
    }

    if (/^\d{1,2}$/.test(expr)) {
        const days = Number(expr);
        if (days >= 1 && days <= 31) return { store, buildToDays: days };
    }

    return null;
}

/** Optional trailing location token: order:FRG | order:DRY | order:FRZ | no-order | Key | Daily */
function parseLocationPartHints(part) {
    const raw = String(part || '').trim();
    const orderClassMatch = raw.match(/^order:(FRG|DRY|FRZ)$/i);
    if (orderClassMatch) {
        return { mmxOrderClass: orderClassMatch[1].toUpperCase(), skipVendorOrder: false, isHint: true };
    }
    if (/^no-order$/i.test(raw)) {
        return { skipVendorOrder: true, isHint: true };
    }
    if (/^key$/i.test(raw)) {
        return { includeKeyItem: true, isHint: true };
    }
    if (/^daily$/i.test(raw)) {
        return { includeDaily: true, isHint: true };
    }
    return { isHint: false };
}

function inferSectionFromComment(line) {
    const raw = String(line || '').replace(/^#\s*/, '').trim();
    if (!raw) return '';
    const cleaned = raw
        .replace(/^[-\s]+/, '')
        .replace(/[-\s]+$/, '')
        .toLowerCase();
    if (cleaned.includes('dry')) return 'Dry';
    if (cleaned.includes('fridge')) return 'Fridge';
    if (cleaned.includes('freezer')) return 'Freezer';
    return '';
}

function parseCatalogText(text, def) {
    const vendorDefaultLocations = [];
    const locationOrder = [];
    let vendorName = def.label;
    let currentSection = '';
    const items = [];

    for (const rawLine of String(text || '').split(/\r?\n/)) {
        const trimmed = rawLine.trim();
        if (!trimmed) continue;

        if (trimmed.startsWith('#')) {
            const locs = parseLocationsFromComment(trimmed);
            if (locs?.length) vendorDefaultLocations.push(...locs);
            const order = parseLocationOrderComment(trimmed);
            if (order?.length) locationOrder.push(...order);
            const vendor = parseVendorFromComment(trimmed);
            if (vendor) vendorName = vendor;
            const inferredSection = inferSectionFromComment(trimmed);
            if (inferredSection) {
                currentSection = inferredSection;
            } else {
                // e.g. "# oh:10 - not on KIC" must not overwrite Dry/Fridge/Freezer
                const sectionMatch = trimmed.match(/^#\s*(.+?)\s*[--]/);
                if (sectionMatch) {
                    const fromCandidate = inferSectionFromComment(`# ${sectionMatch[1].trim()}`);
                    if (fromCandidate) currentSection = fromCandidate;
                }
            }
            continue;
        }

        const parts = rawLine.split('|').map((p) => p.trim());
        if (!parts.length || !parts[0]) continue;

        let buildToDays = null;
        let buildToManual = false;
        let buildToOrderManual = false;
        let skipKeyItemCount = false;
        let skipStockCount = false;
        let buildToAdd = 0;
        let buildToFixed = null;
        let lineParts = parts;
        const buildToPrefix = parseBuildToPrefix(parts);
        if (buildToPrefix) {
            buildToManual = buildToPrefix.buildToManual;
            buildToOrderManual = Boolean(buildToPrefix.buildToOrderManual);
            skipKeyItemCount = Boolean(buildToPrefix.skipKeyItemCount);
            skipStockCount = Boolean(buildToPrefix.skipStockCount);
            buildToDays = buildToPrefix.buildToDays;
            buildToAdd = buildToPrefix.buildToAdd || 0;
            buildToFixed = buildToPrefix.buildToFixed ?? null;
            lineParts = buildToPrefix.rest;
        }

        const identity = parseItemIdentity(lineParts);
        if (!identity) continue;

        const { itemCode, name, unitStart } = identity;
        const rawUnitParts = lineParts.slice(unitStart, unitStart + UNIT_SLOTS);
        while (rawUnitParts.length < UNIT_SLOTS) rawUnitParts.push('N/a');
        const unitSlots = rawUnitParts.slice(0, UNIT_SLOTS).map((label) => {
            const trimmedLabel = String(label || '').trim();
            if (!trimmedLabel || isNaUnit(trimmedLabel)) {
                return { key: null, label: 'N/a', na: true };
            }
            return { key: slugifyKey(trimmedLabel), label: trimmedLabel, na: false };
        });
        const columns = unitSlots.filter((slot) => !slot.na).map((slot) => ({ key: slot.key, label: slot.label }));
        const locationParts = lineParts
            .slice(unitStart + UNIT_SLOTS)
            .map((p) => p.trim())
            .filter((p) => p && !isNaUnit(p));

        if (!columns.length || !name) continue;

        let innerPerCarton = null;
        const locNames = [];
        const storeBuildTo = {};
        let mmxOrderClassOverride = '';
        let skipVendorOrder = false;
        let includeDaily = false;
        let includeKeyItemExplicit = false;
        for (const part of locationParts) {
            if (/^\d+(\.\d+)?$/.test(part)) {
                innerPerCarton = Number(part);
                continue;
            }
            const storeHint = parseStoreBuildToHint(part);
            if (storeHint) {
                const { store, ...rule } = storeHint;
                storeBuildTo[store] = { ...(storeBuildTo[store] || {}), ...rule };
                continue;
            }
            const hint = parseLocationPartHints(part);
            if (hint.isHint) {
                if (hint.mmxOrderClass) mmxOrderClassOverride = hint.mmxOrderClass;
                if (hint.skipVendorOrder) skipVendorOrder = true;
                if (hint.includeDaily) includeDaily = true;
                if (hint.includeKeyItem) includeKeyItemExplicit = true;
                continue;
            }
            locNames.push(part);
        }

        let itemLocations = locNames.length ? [...new Set(locNames)] : [...new Set(vendorDefaultLocations)];
        if (!itemLocations.length) itemLocations = ['Default'];

        items.push({
            key: itemCode || slugifyKey(name),
            itemCode: itemCode || '',
            name,
            columns,
            unitSlots,
            innerPerCarton: innerPerCarton != null && innerPerCarton > 0 ? innerPerCarton : null,
            locations: itemLocations,
            mmxOrderClass: mmxOrderClassOverride || sectionToMmxOrderClass(currentSection),
            skipVendorOrder: Boolean(skipVendorOrder),
            buildToDays: buildToManual || buildToOrderManual || buildToFixed != null ? null : buildToDays,
            buildToManual: Boolean(buildToManual),
            buildToOrderManual: Boolean(buildToOrderManual),
            skipKeyItemCount: Boolean(skipKeyItemCount),
            skipStockCount: Boolean(skipStockCount),
            buildToAdd: buildToManual && !buildToOrderManual ? 0 : buildToAdd,
            buildToFixed:
                buildToFixed != null && Number.isFinite(buildToFixed) ? buildToFixed : null,
            storeBuildTo: Object.keys(storeBuildTo).length ? storeBuildTo : undefined,
            includeDaily: Boolean(includeDaily),
            includeKeyItemExplicit: Boolean(includeKeyItemExplicit),
        });
    }

    const locations = buildCatalogLocations(items, locationOrder, vendorDefaultLocations);

    return {
        slug: def.slug,
        label: vendorName,
        locations,
        locationOrder: [...new Set(locationOrder)],
        items,
    };
}

function readCatalogForDefinition(def) {
    const filePath = resolveCatalogPath(def);
    if (!filePath) return null;
    const mtime = fs.statSync(filePath).mtimeMs;
    const cacheKey = `${def.slug}:${filePath}:${mtime}`;
    if (catalogCache.has(cacheKey)) return catalogCache.get(cacheKey);

    const text = fs.readFileSync(filePath, 'utf8');
    const catalog = parseCatalogText(text, def);
    catalog.source = path.basename(filePath);
    catalogCache.clear();
    catalogCache.set(cacheKey, catalog);
    return catalog;
}

function getVendorDefinition(slug) {
    const normalized = slugifyKey(slug);
    return getAllVendorDefinitions().find((d) => d.slug === normalized) || null;
}

function vendorLabelToSlug(label) {
    const value = String(label || '').trim();
    if (!value) return null;
    for (const def of getAllVendorDefinitions()) {
        if (def.label.toLowerCase() === value.toLowerCase()) return def.slug;
    }
    const collapsed = value.replace(/\s+/g, '').toLowerCase();
    for (const def of getAllVendorDefinitions()) {
        if (def.slug === collapsed || def.label.replace(/\s+/g, '').toLowerCase() === collapsed) {
            return def.slug;
        }
    }
    return slugifyKey(value) || null;
}

function listConfiguredVendors() {
    return getAllVendorDefinitions()
        .map((def) => {
            const catalog = readCatalogForDefinition(def);
            return {
                slug: def.slug,
                label: def.label,
                configured: Boolean(catalog && catalog.items.length),
                locationCount: catalog?.locations?.length || 0,
                itemCount: catalog?.items?.length || 0,
            };
        })
        .filter((v) => v.configured);
}

function getVendorCatalog(slug, options = {}) {
    const def = getVendorDefinition(slug);
    if (!def) return null;
    const catalog = readCatalogForDefinition(def);
    if (!catalog || !catalog.items.length) return null;

    let sourceItems = catalog.items;
    if (options.storeNumber) {
        const { applyAdminCatalogOverrides } = require('./buildToAdminOverrides');
        sourceItems = applyAdminCatalogOverrides(catalog, options.storeNumber, slug).items;
        if (options.forDailyCount) {
            const { buildRoutedDailyCountItems } = require('./vendorCatalogRouting');
            sourceItems = buildRoutedDailyCountItems(slug, options.storeNumber);
        }
    }

    const normalizeItems = (items) =>
        items.map((item) => {
            const displayName = stockCountDisplayName(item.itemCode, item.name);
            return {
                ...item,
                unitSlots: normalizeUnitSlots(item),
                lookupCodes: allLookupKeys(item.itemCode),
                displayName: displayName || item.name,
            };
        });

    if (options.forStockCount) {
        const countable = sourceItems.filter((item) => !item.skipStockCount);
        if (!countable.length) return null;
        return {
            ...catalog,
            items: normalizeItems(countable),
            locations: buildCatalogLocations(countable, catalog.locationOrder, []),
        };
    }

    if (options.forDailyCount) {
        const dailyItems = sourceItems.filter((item) => !item.skipStockCount && item.includeDaily);
        if (!dailyItems.length) return null;
        return {
            ...catalog,
            items: normalizeItems(dailyItems),
            locations: buildCatalogLocations(dailyItems, catalog.locationOrder, []),
        };
    }

    return {
        ...catalog,
        items: normalizeItems(sourceItems),
    };
}

/**
 * Build-to rules from vendor catalog files, keyed by normalized item code.
 * @returns {Map<string, { buildToDays: number|null, buildToManual: boolean, vendorSlug: string }>}
 */
function catalogItemBuildToRule(item, vendorSlug) {
    const buildToFixed =
        item.buildToFixed != null && Number.isFinite(item.buildToFixed) ? item.buildToFixed : null;
    const manualStockOnly = Boolean(item.buildToManual) && !item.buildToOrderManual;
    return {
        buildToDays:
            manualStockOnly || item.buildToOrderManual || buildToFixed != null ? null : item.buildToDays,
        buildToManual: manualStockOnly,
        buildToOrderManual: Boolean(item.buildToOrderManual),
        buildToFixed,
        buildToAdd: manualStockOnly ? 0 : Number(item.buildToAdd) || 0,
        vendorSlug,
    };
}

function registerCatalogBuildToKeys(byCode, itemCode, rule) {
    const raw = normalizeItemCode(itemCode);
    if (!raw) return;
    const mmx = mmxCodeForOrderCode(raw) || raw;
    const keys = new Set([raw, ...lookupKeysForMmx(mmx)]);
    for (const key of keys) {
        if (key) byCode.set(key, rule);
    }
}

function buildCatalogBuildToIndex() {
    const byCode = new Map();
    for (const def of getAllVendorDefinitions()) {
        const catalog = readCatalogForDefinition(def);
        if (!catalog) continue;
        for (const item of catalog.items) {
            const code = String(item.itemCode || '').trim();
            if (!code) continue;
            registerCatalogBuildToKeys(byCode, code, catalogItemBuildToRule(item, def.slug));
        }
    }
    return byCode;
}

function findCatalogItemByCode(itemCode) {
    const code = normalizeItemCode(itemCode);
    if (!code) return null;
    for (const def of getAllVendorDefinitions()) {
        const catalog = readCatalogForDefinition(def);
        if (!catalog) continue;
        for (const item of catalog.items) {
            if (normalizeItemCode(item.itemCode) === code) {
                return { vendorSlug: def.slug, vendorLabel: def.label, item };
            }
        }
    }
    return null;
}

function buildToPrefixForNewItem(spec) {
    const type = String(spec.ruleType || 'days').toLowerCase();
    const days = Number(spec.buildToDays);
    const add = Number(spec.buildToAdd) || 0;
    const fixed = spec.buildToFixed != null && spec.buildToFixed !== '' ? Number(spec.buildToFixed) : null;

    if (type === 'manual') {
        if (fixed != null) {
            if (!Number.isFinite(fixed) || fixed < 0 || fixed > 999) {
                throw new Error('Fixed build-to must be between 0 and 999.');
            }
            return `manual=${fixed}`;
        }
        return 'manual';
    }

    if (!Number.isFinite(days) || days < 1 || days > 31) {
        throw new Error('Build-to days must be between 1 and 31.');
    }
    if (!Number.isFinite(add) || add < 0) {
        throw new Error('Buffer must be 0 or more.');
    }
    const daysToken = add > 0 ? `${days}+${add}` : `${days}`;
    if (type === 'on-hand') return `oh:${daysToken}`;
    return daysToken;
}

function sanitizeCatalogField(value) {
    return String(value || '')
        .replace(/\|/g, '/')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Append a new item line to a vendor catalog dotfile.
 * @param {string} slug vendor slug (e.g. 'americold')
 * @param {object} spec { itemCode, name, ruleType, buildToDays, buildToAdd, buildToFixed,
 *                        units: [outer, inner, unit], locations: [], innerPerCarton,
 *                        includeKeyItem, includeDaily }
 * @returns {{ line: string, itemCode: string }}
 */
function appendVendorCatalogItem(slug, spec = {}) {
    const def = getVendorDefinition(slug);
    if (!def) throw new Error('Unknown vendor.');
    const livePath = ensureLiveCatalogPath(def);

    const itemCode = sanitizeCatalogField(spec.itemCode);
    const name = sanitizeCatalogField(spec.name);
    if (!name) throw new Error('Item name is required.');
    if (!itemCode) throw new Error('Item code is required.');
    if (!looksLikeItemCode(itemCode)) throw new Error(`"${itemCode}" does not look like a valid item code.`);

    const existing = findCatalogItemByCode(itemCode);
    if (existing) {
        throw new Error(`Item code ${itemCode} already exists in ${existing.vendorLabel} (${existing.item.name}).`);
    }

    const rawUnits = Array.isArray(spec.units) ? spec.units : [];
    const units = [];
    for (let i = 0; i < UNIT_SLOTS; i += 1) {
        const label = sanitizeCatalogField(rawUnits[i]) || 'N/a';
        if (!looksLikeUnitLabel(label)) {
            throw new Error(`"${label}" is not a recognised unit (Boxes, Bags, KGs, Packs, Each, …).`);
        }
        units.push(isNaUnit(label) ? 'N/a' : label);
    }
    if (units.every((u) => isNaUnit(u))) {
        throw new Error('At least one unit column is required.');
    }

    const prefix = buildToPrefixForNewItem(spec);

    const catalog = readCatalogForDefinition(def);
    const knownLocations = new Set(catalog?.locations || []);
    const locations = (Array.isArray(spec.locations) ? spec.locations : [])
        .map((loc) => sanitizeCatalogField(loc))
        .filter(Boolean)
        .filter((loc, i, list) => list.indexOf(loc) === i);
    for (const loc of locations) {
        // New location names are allowed, but guard against tokens the parser treats specially.
        if (looksLikeUnitLabel(loc) || parseLocationPartHints(loc).isHint || /^\d+(\.\d+)?$/.test(loc)) {
            throw new Error(`"${loc}" cannot be used as a location name.`);
        }
        if (!knownLocations.has(loc) && parseStoreBuildToHint(loc)) {
            throw new Error(`"${loc}" cannot be used as a location name.`);
        }
    }

    const parts = [prefix, itemCode, name, ...units, ...locations];
    const innerPerCarton = Number(spec.innerPerCarton);
    if (Number.isFinite(innerPerCarton) && innerPerCarton > 0) parts.push(String(innerPerCarton));
    if (spec.includeKeyItem) parts.push('Key');
    if (spec.includeDaily) parts.push('Daily');

    const line = parts.join(' | ');

    // Confirm the line round-trips through the parser before touching the file.
    const parsed = parseCatalogText(line, def);
    const parsedItem = parsed.items[0];
    if (!parsedItem || normalizeItemCode(parsedItem.itemCode) !== normalizeItemCode(itemCode)) {
        throw new Error('Could not build a valid catalog line from these details.');
    }

    const current = fs.readFileSync(livePath, 'utf8');
    const next = `${current.replace(/\n*$/, '\n')}${line}\n`;
    fs.writeFileSync(livePath, next, 'utf8');
    catalogCache.clear();

    return { line, itemCode: parsedItem.itemCode };
}

/**
 * Update the catalog/MMX name on an existing vendor line (item code unchanged).
 */
function updateVendorCatalogItemName(slug, itemCode, newName) {
    const def = getVendorDefinition(slug);
    if (!def) throw new Error('Unknown vendor.');
    const livePath = ensureLiveCatalogPath(def);

    const code = normalizeItemCode(itemCode);
    const name = sanitizeCatalogField(newName);
    if (!code) throw new Error('Item code is required.');
    if (!name) throw new Error('Item name is required.');

    const current = fs.readFileSync(livePath, 'utf8');
    const lines = current.split(/\r?\n/);
    let found = false;
    const nextLines = lines.map((rawLine) => {
        const trimmed = rawLine.trim();
        if (!trimmed || trimmed.startsWith('#')) return rawLine;

        const parts = rawLine.split('|').map((p) => p.trim());
        const buildToPrefix = parseBuildToPrefix(parts);
        const lineParts = buildToPrefix ? buildToPrefix.rest : parts;
        const identity = parseItemIdentity(lineParts);
        if (!identity || normalizeItemCode(identity.itemCode) !== code) return rawLine;

        found = true;
        const updatedLineParts = [...lineParts];
        updatedLineParts[1] = name;
        const rebuilt = buildToPrefix ? [parts[0], ...updatedLineParts] : updatedLineParts;
        return rebuilt.join(' | ');
    });

    if (!found) {
        throw new Error(`Item code ${code} not found in ${def.dotfile}.`);
    }

    const next = `${nextLines.join('\n').replace(/\n*$/, '\n')}`;
    fs.writeFileSync(livePath, next, 'utf8');
    catalogCache.clear();
    return { itemCode: code, name };
}

/**
 * Remove an item line from a vendor catalog dotfile.
 * @param {string} slug vendor slug (e.g. 'americold')
 * @param {string} itemCode
 * @returns {{ itemCode: string, name: string }}
 */
function removeVendorCatalogItem(slug, itemCode) {
    const def = getVendorDefinition(slug);
    if (!def) throw new Error('Unknown vendor.');
    const livePath = ensureLiveCatalogPath(def);

    const code = normalizeItemCode(itemCode);
    if (!code) throw new Error('Item code is required.');

    const current = fs.readFileSync(livePath, 'utf8');
    const lines = current.split(/\r?\n/);
    let found = false;
    let removedName = '';
    const nextLines = lines.filter((rawLine) => {
        const trimmed = rawLine.trim();
        if (!trimmed || trimmed.startsWith('#')) return true;

        const parts = rawLine.split('|').map((p) => p.trim());
        const buildToPrefix = parseBuildToPrefix(parts);
        const lineParts = buildToPrefix ? buildToPrefix.rest : parts;
        const identity = parseItemIdentity(lineParts);
        if (!identity || normalizeItemCode(identity.itemCode) !== code) return true;

        found = true;
        removedName = identity.name || identity.description || code;
        return false;
    });

    if (!found) {
        throw new Error(`Item code ${code} not found in ${def.dotfile}.`);
    }

    const next = `${nextLines.join('\n').replace(/\n*$/, '\n')}`;
    fs.writeFileSync(livePath, next, 'utf8');
    catalogCache.clear();
    return { itemCode: code, name: removedName };
}

function aggregateCounts(catalog, locationCounts) {
    const totals = {};
    for (const item of catalog.items) {
        const row = {
            itemKey: item.key,
            itemCode: item.itemCode || '',
            itemName: item.name,
            columns: {},
        };
        for (const col of item.columns) {
            row.columns[col.key] = 0;
        }
        totals[item.key] = row;
    }

    const locations = locationCounts && typeof locationCounts === 'object' ? locationCounts : {};
    for (const locName of Object.keys(locations)) {
        const itemsAtLoc = locations[locName];
        if (!itemsAtLoc || typeof itemsAtLoc !== 'object') continue;
        for (const [itemKey, counts] of Object.entries(itemsAtLoc)) {
            const row = totals[itemKey];
            if (!row || !counts || typeof counts !== 'object') continue;
            for (const [colKey, raw] of Object.entries(counts)) {
                if (!(colKey in row.columns)) continue;
                const n = Number(raw);
                if (Number.isFinite(n) && n >= 0) row.columns[colKey] += n;
            }
        }
    }

    return catalog.items.map((item) => totals[item.key]).filter(Boolean);
}

module.exports = {
    VENDOR_DEFINITIONS,
    slugifyKey,
    vendorLabelToSlug,
    listConfiguredVendors,
    listAllVendorDefinitions,
    getAllVendorDefinitions,
    registerCustomVendor,
    removeCustomVendor,
    readCatalogFileSections,
    ensureLiveCatalogPath,
    invalidateVendorRegistry,
    getVendorCatalog,
    getVendorDefinition,
    aggregateCounts,
    appendVendorCatalogItem,
    updateVendorCatalogItemName,
    removeVendorCatalogItem,
    findCatalogItemByCode,
    normalizeUnitSlots,
    parseCatalogText,
    buildCatalogBuildToIndex,
    catalogItemBuildToRule,
    parseBuildToPrefix,
    parseStoreBuildToHint,
    UNIT_SLOTS,
    UNIT_LABEL_OPTIONS: [
        'Boxes',
        'Cartons',
        'Crates',
        'Bags',
        'Packs',
        'Rolls',
        'KGs',
        'Each',
        'Bottles',
        'Cans',
        'Tubs',
    ],
    readCatalogForDefinitionInternal: readCatalogForDefinition,
};
