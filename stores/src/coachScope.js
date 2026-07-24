/**
 * Coach region ownership: WA / VIC / Taco Bell (all), with optional enabledStores subset.
 */
const { getStoreList } = require('./storeList');
const { inferAreaFromStore } = require('./areasConfig');
const { readSession } = require('./coachSession');

/** Legacy Ash/Tom ids still resolve so old sessions don't break mid-upgrade. */
const USER_ALIASES = {
    ash: 'wa',
    tom: 'vic',
};

const REGION_DEFAULTS = {
    wa: { region: 'WA', areaIds: ['WA-1'], storeNumbers: ['3901', '3902', '3903', '3904'] },
    vic: { region: 'VIC', areaIds: ['VIC-1'], storeNumbers: null },
    tacobell: { region: 'ALL', areaIds: null, storeNumbers: null },
};

function canonicalUserId(userId) {
    const id = String(userId || '').toLowerCase().trim();
    return USER_ALIASES[id] || id;
}

function regionForUser(userId) {
    const id = canonicalUserId(userId);
    return REGION_DEFAULTS[id] || null;
}

function storeRegionLabel(store) {
    const area = inferAreaFromStore(store?.storeNumber, store?.storeName, store?.area, store?.timeZone);
    const upper = String(area || '').toUpperCase();
    if (upper.startsWith('WA') || ['3901', '3902', '3903', '3904'].includes(String(store?.storeNumber))) {
        return 'WA';
    }
    if (upper.startsWith('VIC')) return 'VIC';
    if (upper.startsWith('QLD')) return 'QLD';
    return upper.split('-')[0] || 'VIC';
}

function storesInRegion(region) {
    const want = String(region || '').toUpperCase();
    if (want === 'ALL' || want === '*') {
        return getStoreList().slice();
    }
    return getStoreList().filter((s) => storeRegionLabel(s) === want);
}

function defaultEnabledStores(userId) {
    const def = regionForUser(userId);
    if (!def) return [];
    if (Array.isArray(def.storeNumbers) && def.storeNumbers.length) {
        return def.storeNumbers.map(String);
    }
    return storesInRegion(def.region).map((s) => String(s.storeNumber));
}

function allowedStoreNumbers(userId) {
    const def = regionForUser(userId);
    if (!def) return new Set();
    const allowed = new Set(storesInRegion(def.region).map((s) => String(s.storeNumber)));
    if (def.storeNumbers) {
        for (const n of def.storeNumbers) allowed.add(String(n));
    }
    return allowed;
}

function normalizeEnabledStores(userId, enabledStores) {
    const def = regionForUser(userId);
    if (!def) return [];
    const allowed = allowedStoreNumbers(userId);
    const raw = Array.isArray(enabledStores) ? enabledStores.map(String) : defaultEnabledStores(userId);
    const filtered = [...new Set(raw.filter((n) => allowed.has(n)))];
    return filtered.length ? filtered : defaultEnabledStores(userId).filter((n) => allowed.has(n) || !allowed.size);
}

function listStoresForCoach(session = readSession()) {
    const userId = canonicalUserId(session?.userId);
    const def = regionForUser(userId);
    if (!def) return [];
    const enabled = new Set(
        normalizeEnabledStores(
            userId,
            session.enabledStores?.length ? session.enabledStores : defaultEnabledStores(userId)
        )
    );
    const regionStores = storesInRegion(def.region);
    const byNum = new Map(regionStores.map((s) => [String(s.storeNumber), s]));
    for (const num of enabled) {
        if (!byNum.has(num)) {
            byNum.set(num, {
                storeNumber: num,
                storeName: num,
                area: def.region === 'ALL' ? '' : def.region,
            });
        }
    }
    return [...byNum.values()]
        .filter((s) => enabled.has(String(s.storeNumber)))
        .sort((a, b) => String(a.storeNumber).localeCompare(String(b.storeNumber), undefined, { numeric: true }));
}

function coachOwnsStore(storeNumber, session = readSession()) {
    const key = String(storeNumber || '').trim();
    return listStoresForCoach(session).some((s) => String(s.storeNumber) === key);
}

function regionStoresForAccount(userId) {
    const id = canonicalUserId(userId);
    const def = regionForUser(id);
    if (!def) return [];
    return storesInRegion(def.region).map((s) => ({
        storeNumber: String(s.storeNumber),
        storeName: s.storeName || '',
        region: storeRegionLabel(s),
    }));
}

module.exports = {
    REGION_DEFAULTS,
    USER_ALIASES,
    canonicalUserId,
    regionForUser,
    storeRegionLabel,
    storesInRegion,
    defaultEnabledStores,
    normalizeEnabledStores,
    listStoresForCoach,
    coachOwnsStore,
    regionStoresForAccount,
};
