const crypto = require('crypto');
const { closeBrowserQuietly } = require('./macromatixScraper');

const SESSION_TTL_MS = Number(process.env.MMX_COUNT_SESSION_TTL_MS || 30 * 60 * 1000);
const sessionsById = new Map();
const sessionIdByStore = new Map();

function sessionKey(storeNumber, sessionId) {
    return `${String(storeNumber)}:${sessionId}`;
}

function isExpired(session) {
    return Date.now() - session.createdAt > SESSION_TTL_MS;
}

async function destroySession(session, reason = 'closed') {
    if (!session) return;
    sessionsById.delete(sessionKey(session.storeNumber, session.sessionId));
    if (sessionIdByStore.get(String(session.storeNumber)) === session.sessionId) {
        sessionIdByStore.delete(String(session.storeNumber));
    }
    await closeBrowserQuietly(session.browser, `mmx count session ${reason}`);
}

async function cleanupExpiredSessions() {
    for (const session of [...sessionsById.values()]) {
        if (!isExpired(session)) continue;
        const storeNumber = session.storeNumber;
        await destroySession(session, 'expired');
        try {
            const { endStockCountMmxWork } = require('../../vendors/src/stockCountMmxPipeline');
            await endStockCountMmxWork(storeNumber, `session expired (store ${storeNumber})`);
        } catch (err) {
            const { releasePrioritySlot, PRIORITY } = require('./mmxTaskQueue');
            await releasePrioritySlot(PRIORITY.MIC, `session expired fallback (store ${storeNumber})`).catch(() => {});
            console.warn('[MMX Session] Expired cleanup release fallback:', err.message);
        }
    }
}

async function createSession(payload) {
    await cleanupExpiredSessions();
    const storeNumber = String(payload.storeNumber);
    const existingId = sessionIdByStore.get(storeNumber);
    if (existingId) {
        const existing = sessionsById.get(sessionKey(storeNumber, existingId));
        if (existing && !isExpired(existing)) {
            await destroySession(existing, 'replaced');
        }
    }

    const sessionId = crypto.randomUUID();
    const session = {
        sessionId,
        storeNumber,
        dateKey: payload.dateKey,
        vendorSlugs: payload.vendorSlugs || [],
        browser: payload.browser,
        page: payload.page,
        variances: payload.variances || [],
        createdAt: Date.now(),
    };
    sessionsById.set(sessionKey(storeNumber, sessionId), session);
    sessionIdByStore.set(storeNumber, sessionId);
    return session;
}

function getSession(storeNumber, sessionId) {
    const session = sessionsById.get(sessionKey(storeNumber, sessionId));
    if (!session) return null;
    if (isExpired(session)) {
        destroySession(session, 'expired').catch(() => {});
        return null;
    }
    return session;
}

async function destroySessionsForStore(storeNumber, reason = 'closed') {
    const key = String(storeNumber);
    const sessionId = sessionIdByStore.get(key);
    if (!sessionId) return false;
    const session = sessionsById.get(sessionKey(key, sessionId));
    if (session) await destroySession(session, reason);
    return true;
}

module.exports = {
    createSession,
    getSession,
    destroySession,
    destroySessionsForStore,
    cleanupExpiredSessions,
};
