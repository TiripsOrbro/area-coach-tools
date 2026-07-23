const { DEFAULT_OPEN_HOUR, DEFAULT_CLOSE_HOUR } = require('./storeList');

const TEST_STORE_SLUG = 'teststore';
const TEST_STORE_NAME = 'Test Store';
const TIME_ZONE = process.env.DASHBOARD_TIME_ZONE || 'Australia/Melbourne';

const LEADERBOARD_PLACEHOLDER_NAMES = [
    'LUKE SKYWALKER',
    'HERMIONE GRANGER',
    'MARIO',
    'BATMAN',
    'FRODO BAGGINS',
    'WONDER WOMAN',
    'SPONGEBOB SQUAREPANTS',
];

/** stickyKey → storeNumber chosen for this browser session */
const mirrorPickByKey = new Map();

function isTestStore(store) {
    return String(store || '').trim().toLowerCase() === TEST_STORE_SLUG;
}

/** Normalized store key for APIs, persistence, and auth. Empty when invalid. */
function normalizeStoreKey(store) {
    const raw = String(store || '').trim();
    if (isTestStore(raw)) return TEST_STORE_SLUG;
    const digits = raw.replace(/[^0-9]/g, '');
    return /^\d{3,6}$/.test(digits) ? digits : '';
}

function isRealStoreEntry(store) {
    const n = normalizeStoreKey(store?.storeNumber);
    return Boolean(n) && !isTestStore(n);
}

function storeHasSalesData(store) {
    const sum = (arr) =>
        (Array.isArray(arr) ? arr : []).reduce((t, v) => t + (Number(v) || 0), 0);
    return sum(store?.actual) > 0 || sum(store?.forecast) > 0;
}

function eligibleMirrorStores(payload) {
    const stores = Array.isArray(payload?.stores) ? payload.stores : [];
    const real = stores.filter(isRealStoreEntry);
    const withData = real.filter(storeHasSalesData);
    return withData.length ? withData : real;
}

function pickRandomMirrorStore(payload, stickyKey) {
    const eligible = eligibleMirrorStores(payload);
    if (!eligible.length) return null;

    if (stickyKey && mirrorPickByKey.has(stickyKey)) {
        const prev = mirrorPickByKey.get(stickyKey);
        const found = eligible.find((s) => String(s.storeNumber) === String(prev));
        if (found) return found;
    }

    const picked = eligible[Math.floor(Math.random() * eligible.length)];
    if (stickyKey) mirrorPickByKey.set(stickyKey, String(picked.storeNumber));
    return picked;
}

/** Stable per login session so refreshes keep the same mirrored store until reload/logout. */
function stickyKeyForTestMirror(req, user) {
    const username = String(user?.username || req?.dashboardUser?.username || '').trim();
    if (username) return `user:${username}`;
    const sessionCookie = String(req?.cookies?.dashboard_session || req?.cookies?.session || '').trim();
    if (sessionCookie) return `sess:${sessionCookie.slice(0, 48)}`;
    return '';
}

function sliceFieldsFromMirror(picked, payload) {
    const stores = Array.isArray(payload?.stores) ? payload.stores : [];
    const name = String(picked.storeName || picked.storeNumber || '').trim();
    const number = String(picked.storeNumber || '').trim();
    return {
        actual: Array.isArray(picked.actual) ? picked.actual : [],
        forecast: Array.isArray(picked.forecast) ? picked.forecast : [],
        pendingVendors: Array.isArray(picked.pendingVendors) ? picked.pendingVendors : [],
        openHour: Number.isFinite(picked.openHour) ? picked.openHour : DEFAULT_OPEN_HOUR,
        closeHour: Number.isFinite(picked.closeHour) ? picked.closeHour : DEFAULT_CLOSE_HOUR,
        mirrorStoreNumber: number,
        storeName: name ? `${TEST_STORE_NAME} · ${name}` : TEST_STORE_NAME,
        timestamp: payload?.timestamp || new Date().toISOString(),
        availableStores: stores
            .filter(isRealStoreEntry)
            .map((s) => ({ storeNumber: s.storeNumber, storeName: s.storeName })),
    };
}

function buildTestStoreSalesSlice(payload = null, options = {}) {
    const picked = payload ? pickRandomMirrorStore(payload, options.stickyKey || '') : null;
    if (picked) {
        return {
            success: true,
            ...sliceFieldsFromMirror(picked, payload),
            storeNumber: TEST_STORE_SLUG,
            storeNotFound: false,
            testStore: true,
        };
    }

    return {
        success: true,
        timestamp: new Date().toISOString(),
        actual: [],
        forecast: [],
        pendingVendors: [],
        storeNumber: TEST_STORE_SLUG,
        storeName: TEST_STORE_NAME,
        openHour: DEFAULT_OPEN_HOUR,
        closeHour: DEFAULT_CLOSE_HOUR,
        availableStores: [],
        storeNotFound: false,
        testStore: true,
    };
}

function testStoreListEntry() {
    return {
        storeNumber: TEST_STORE_SLUG,
        storeName: TEST_STORE_NAME,
        openHour: DEFAULT_OPEN_HOUR,
        closeHour: DEFAULT_CLOSE_HOUR,
        testStore: true,
    };
}

function melbourneTodayIso() {
    return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(new Date());
}

function hashToUint(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

/** Random-looking points that stay stable for the same session key. */
function placeholderLeaderboardPoints(stickyKey, name, index) {
    const seed = hashToUint(`${stickyKey || 'anon'}|leaderboard|${index}|${name}`);
    return 12 + (seed % 78);
}

/** Upselling podium payload - 7 demo cashiers with session-stable random scores. */
function buildTestStoreLeaderboardPayload(stickyKey = '') {
    const today = melbourneTodayIso();
    const ranked = LEADERBOARD_PLACEHOLDER_NAMES.map((name, index) => {
        const total = placeholderLeaderboardPoints(stickyKey, name, index);
        return {
            name,
            mmxPoints: total,
            bestDay: today,
            bonusPoints: 0,
            total,
        };
    })
        .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name))
        .map((row, i) => ({ ...row, rank: i + 1 }));

    const top7 = ranked;
    return {
        enabled: true,
        storeNumber: TEST_STORE_SLUG,
        top7,
        top5: top7.slice(0, 5),
        top3: top7.slice(0, 3),
        ranks: ranked,
        byDay: ranked.map((row) => ({
            day: today,
            name: row.name,
            points: row.total,
            mmxPoints: row.mmxPoints,
            basePoints: row.total,
            sourceName: row.name,
        })),
        lastSyncAt: new Date().toISOString(),
        reportDate: today,
        testStore: true,
    };
}

module.exports = {
    TEST_STORE_SLUG,
    TEST_STORE_NAME,
    isTestStore,
    normalizeStoreKey,
    stickyKeyForTestMirror,
    buildTestStoreSalesSlice,
    buildTestStoreLeaderboardPayload,
    testStoreListEntry,
};
