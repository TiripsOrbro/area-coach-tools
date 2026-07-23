const { getStoreList, getStoreConfig } = require('../../stores/src/storeList');
const { getStoreScrapePhase } = require('./scrapeSchedule');
const {
    getUserAccessScope,
    getEffectiveStoresForUser,
    isRealDashboardUser,
    parseCookies,
} = require('../../users/src/core/dashboardUsers');
const { normalizeStoreKey } = require('../../stores/src/testStore');

const ENTRY_COOKIE = 'dashboard_entry';
const PRESENCE_TTL_MS = Number(process.env.SCRAPE_PRESENCE_TTL_SECONDS || 180) * 1000;

/** @type {Map<string, { username: string, accessType: string, tier: string, storeNumbers: string[], isKiosk: boolean, lastSeen: number }>} */
const sessions = new Map();

function storeFromRequest(req) {
    const fromQuery = normalizeStoreKey(req.query?.store);
    if (fromQuery) return fromQuery;

    const path = String(req.path || '');
    const patterns = [
        /^\/nologin\/(\d{3,6})\/?$/i,
        /^\/kiosk\/(\d{3,6})\/?$/i,
        /^\/MIC\/(\d{3,6})\/?$/i,
        /^\/Admin\/(\d{3,6})\/?$/i,
        /^\/admin\/(\d{3,6})\/?$/i,
        /^\/(\d{3,6})\/?$/,
    ];
    for (const re of patterns) {
        const m = path.match(re);
        if (m) return normalizeStoreKey(m[1]);
    }
    return '';
}

function entryFromRequest(req) {
    const cookies = parseCookies(req.headers?.cookie);
    return String(cookies[ENTRY_COOKIE] || '').trim().toLowerCase();
}

function isPresencePath(reqPath) {
    const p = String(reqPath || '');
    if (p.startsWith('/scripts/') || p.startsWith('/styles/')) return false;
    if (/\.(js|css|svg|png|jpg|jpeg|gif|webp|ico|woff2?)$/i.test(p)) return false;

    if (p === '/api/sales' || p.startsWith('/api/mic/') || p.startsWith('/api/area-dashboard') || p === '/api/stores') {
        return true;
    }
    if (p === '/overview') return true;
    if (/^\/Admin\//i.test(p) || /^\/admin\//i.test(p)) return true;
    if (/^\/MIC\//i.test(p)) return true;
    if (/^\/kiosk(\/|$)/i.test(p)) return true;
    if (/^\/nologin\//i.test(p)) return true;
    if (/^\/\d{3,6}\/?$/.test(p)) return true;
    return false;
}

function resolvePresenceScope(user, req) {
    const scope = getUserAccessScope(user);
    const path = String(req.path || '');
    const entry = entryFromRequest(req);
    const isKiosk = entry === 'kiosk' || /^\/kiosk\//i.test(path) || /^\/nologin\//i.test(path);

    if (scope.type === 'super' || scope.type === 'market') {
        return { tier: 'market', storeNumbers: [], isKiosk };
    }

    let stores = getEffectiveStoresForUser(user).map(String);

    if (scope.type === 'store') {
        const fromPath = storeFromRequest(req);
        if (fromPath) {
            const allowed = new Set(stores);
            if (allowed.has(fromPath)) stores = [fromPath];
        }
    }

    return {
        tier: scope.type === 'area' ? 'area' : 'store',
        storeNumbers: stores,
        isKiosk,
    };
}

function touchPresence(req) {
    if (!isPresencePath(req.path)) return;
    const user = req.dashboardUser;
    if (!isRealDashboardUser(user)) return;

    const { tier, storeNumbers, isKiosk } = resolvePresenceScope(user, req);
    const key = String(user.username || '').trim().toLowerCase();
    if (!key) return;

    sessions.set(key, {
        username: user.username,
        accessType: getUserAccessScope(user).type,
        tier,
        storeNumbers: [...storeNumbers],
        isKiosk,
        lastSeen: Date.now(),
    });
}

function pruneExpired(now = Date.now()) {
    for (const [key, session] of sessions) {
        if (now - session.lastSeen > PRESENCE_TTL_MS) sessions.delete(key);
    }
}

function activeSessions(now = Date.now()) {
    pruneExpired(now);
    return [...sessions.values()];
}

function storesInActiveScrapeWindow(storeNumbers) {
    const listed = getStoreList();
    const byNum = new Map(listed.map((s) => [String(s.storeNumber), s]));
    return storeNumbers.filter((num) => {
        const store = byNum.get(String(num)) || getStoreConfig(num);
        if (!store) return false;
        return getStoreScrapePhase(store) === 'active';
    });
}

/**
 * @returns {{ mode: 'full' | 'skip', storeNumbers: string[], reason: string }}
 */
function getFastScrapePlan(now = new Date()) {
    const all = storesInActiveScrapeWindow(getStoreList().map((s) => String(s.storeNumber)), now);
    if (!all.length) {
        return { mode: 'skip', storeNumbers: [], reason: 'no-active-window' };
    }
    return { mode: 'full', storeNumbers: all, reason: 'interval' };
}

module.exports = {
    touchPresence,
    getFastScrapePlan,
    isPresencePath,
    activeSessions,
    PRESENCE_TTL_MS,
};
