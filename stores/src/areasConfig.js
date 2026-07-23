const fs = require('fs');
const path = require('path');
const paths = require('../../src/paths');

const AREAS_PATH = path.join(paths.stores.config, 'areas.json');
const PERTH_STORE_NUMBERS = new Set(['3901', '3902', '3903', '3904']);
const PERTH_STORE_NAMES = ['midland', 'ellenbrook', 'canning vale', 'butler'];
const QLD_STORE_NUMBER_RE = /^37[56]\d{2}$/;

const DEFAULT_AREAS = [
    { id: 'VIC-1', slug: 'vic-1', label: 'VIC', timeZone: 'Australia/Melbourne', order: 1 },
    { id: 'WA-1', slug: 'wa-1', label: 'WA', timeZone: 'Australia/Perth', order: 2 },
    { id: 'QLD-1', slug: 'qld-1', label: 'QLD', timeZone: 'Australia/Brisbane', order: 3 },
];

const DEFAULT_LEGACY_MAP = {
    'Area 1': 'QLD-1',
    'Area 2': 'QLD-1',
    'Area 21': 'VIC-1',
    'Area 22': 'VIC-1',
};

let areasCache = null;
let areasCacheMtime = 0;

function loadAreasConfig() {
    if (!fs.existsSync(AREAS_PATH)) {
        return { areas: DEFAULT_AREAS, legacyAreaMap: DEFAULT_LEGACY_MAP };
    }
    try {
        const stat = fs.statSync(AREAS_PATH);
        if (areasCache && areasCacheMtime === stat.mtimeMs) {
            return areasCache;
        }
        const parsed = JSON.parse(fs.readFileSync(AREAS_PATH, 'utf8'));
        areasCache = {
            areas: Array.isArray(parsed.areas) && parsed.areas.length ? parsed.areas : DEFAULT_AREAS,
            legacyAreaMap:
                parsed.legacyAreaMap && typeof parsed.legacyAreaMap === 'object'
                    ? parsed.legacyAreaMap
                    : DEFAULT_LEGACY_MAP,
        };
        areasCacheMtime = stat.mtimeMs;
        return areasCache;
    } catch {
        return { areas: DEFAULT_AREAS, legacyAreaMap: DEFAULT_LEGACY_MAP };
    }
}

function getCanonicalAreas() {
    return [...loadAreasConfig().areas].sort((a, b) => (a.order || 0) - (b.order || 0));
}

function getAreaIds() {
    return getCanonicalAreas().map((row) => row.id);
}

function getAreaDisplayLabel(areaId) {
    const id = normalizeAreaLabel(areaId);
    const row = getCanonicalAreas().find((entry) => entry.id === id);
    if (row?.label) return row.label;
    return String(id).replace(/-1$/i, '') || String(id);
}

/** @deprecated use getAreaIds — kept for transitional imports */
const ADMIN_ROTATE_AREAS = getAreaIds();

function normalizeAreaKey(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '');
}

function normalizeAreaLabel(value) {
    const raw = String(value || '').trim();
    if (!raw) return 'VIC-1';

    const legacy = loadAreasConfig().legacyAreaMap[raw];
    if (legacy) return legacy;

    const legacyMatch = raw.match(/^area\s*(\d+)$/i);
    if (legacyMatch) {
        const legacyName = `Area ${Number(legacyMatch[1])}`;
        if (loadAreasConfig().legacyAreaMap[legacyName]) {
            return loadAreasConfig().legacyAreaMap[legacyName];
        }
    }

    const byId = getCanonicalAreas().find(
        (row) => row.id.toLowerCase() === raw.toLowerCase() || row.label.toLowerCase() === raw.toLowerCase()
    );
    if (byId) return byId.id;

    const key = normalizeAreaKey(raw);
    const bySlug = getCanonicalAreas().find((row) => row.slug === key || normalizeAreaKey(row.id) === key);
    if (bySlug) return bySlug.id;

    return raw;
}

function areaSlugFromLabel(value) {
    const label = normalizeAreaLabel(value);
    const row = getCanonicalAreas().find((entry) => entry.id === label);
    if (row?.slug) return row.slug;
    return normalizeAreaKey(label);
}

function areaLabelFromSlug(slug) {
    const key = normalizeAreaKey(slug);
    const row = getCanonicalAreas().find((entry) => entry.slug === key || normalizeAreaKey(entry.id) === key);
    return row?.id || '';
}

function areaCodeFromValue(value) {
    const label = normalizeAreaLabel(value);
    if (label) return areaSlugFromLabel(label);
    const raw = String(value || '').trim();
    const legacy = raw.match(/^a(\d+)$/i);
    if (legacy) {
        const legacyName = `Area ${Number(legacy[1])}`;
        const mapped = loadAreasConfig().legacyAreaMap[legacyName];
        if (mapped) return areaSlugFromLabel(mapped);
    }
    return normalizeAreaKey(raw);
}

function inferAreaFromStore(storeNumber, storeName, explicitArea, timeZone) {
    const normalized = normalizeAreaLabel(explicitArea);
    if (getAreaIds().includes(normalized)) {
        if (normalized === 'VIC-1' && inferStoreTimeZone(storeNumber, storeName, timeZone) === 'Australia/Perth') {
            return 'WA-1';
        }
        return normalized;
    }

    const tz = inferStoreTimeZone(storeNumber, storeName, timeZone);
    if (tz === 'Australia/Perth') return 'WA-1';
    if (tz === 'Australia/Brisbane' || QLD_STORE_NUMBER_RE.test(String(storeNumber || '').trim())) {
        return 'QLD-1';
    }
    return 'VIC-1';
}

function inferStoreTimeZone(storeNumber, storeName, explicit) {
    const fromFile = String(explicit || '').trim();
    if (fromFile) return fromFile;
    const name = String(storeName || '').trim().toLowerCase();
    const num = String(storeNumber || '').trim();
    if (PERTH_STORE_NUMBERS.has(num)) return 'Australia/Perth';
    if (PERTH_STORE_NAMES.some((n) => name.includes(n))) return 'Australia/Perth';
    if (QLD_STORE_NUMBER_RE.test(num)) return 'Australia/Brisbane';
    return process.env.DASHBOARD_TIME_ZONE || 'Australia/Melbourne';
}

function resolveAreaFromParam(areaParam) {
    const raw = String(areaParam || '').trim();
    if (!raw || /^market\s*\d+$/i.test(raw)) return null;

    const label = areaLabelFromSlug(raw) || normalizeAreaLabel(raw);
    if (!getAreaIds().includes(label)) return null;

    return { name: label, key: normalizeAreaKey(label), slug: areaSlugFromLabel(label) };
}

function getAdminAreaPath(areaCodeOrName) {
    const slug = areaCodeFromValue(areaCodeOrName) || areaSlugFromLabel(areaCodeOrName);
    return slug ? `/Admin/${slug}` : '/overview';
}

function invalidateAreasCache() {
    areasCache = null;
    areasCacheMtime = 0;
}

module.exports = {
    ADMIN_ROTATE_AREAS: getAreaIds(),
    getCanonicalAreas,
    getAreaIds,
    getAreaDisplayLabel,
    normalizeAreaKey,
    normalizeAreaLabel,
    areaSlugFromLabel,
    areaLabelFromSlug,
    areaCodeFromValue,
    inferAreaFromStore,
    resolveAreaFromParam,
    getAdminAreaPath,
    invalidateAreasCache,
    loadAreasConfig,
};
