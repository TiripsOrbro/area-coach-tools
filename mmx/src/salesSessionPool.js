/**
 * Persistent Macromatix browser for sales/vendor scrapes (opt-in via SCRAPER_PERSISTENT_SESSIONS).
 * One Chromium process, one isolated context per store, labour + scheduled-orders pages, per-store lock.
 */

const puppeteer = require('../../src/puppeteerCompat');
const { trackBrowser, closeBrowserQuietly } = require('./browserLifecycle');
const {
    throwIfSalesScrapeAborted,
    isSalesScrapeAbortRequested,
    registerSalesScrapeBrowser,
    clearSalesScrapeBrowser,
} = require('../../src/services/salesScrapeAbort');
const { registerMmxAbortHandler } = require('./mmxResourceGate');
const { anyStoreInActiveScrapeWindow } = require('../../dashboard/src/scrapeSchedule');

function isPersistentSessionsEnabled() {
    return /^(1|true|yes|on)$/i.test(String(process.env.SCRAPER_PERSISTENT_SESSIONS || '').trim());
}

function mmx() {
    return require('./macromatixScraper');
}

/** Simple async mutex. */
function createLock() {
    let locked = false;
    const waiters = [];
    return {
        async acquire() {
            if (!locked) {
                locked = true;
                return;
            }
            await new Promise((resolve) => waiters.push(resolve));
            locked = true;
        },
        release() {
            const next = waiters.shift();
            if (next) next();
            else locked = false;
        },
    };
}

/** @type {import('puppeteer').Browser | null} */
let poolBrowser = null;
/** @type {Map<string, object>} */
const sessions = new Map();
let disconnectHooked = false;

function storeKey(storeNumber) {
    return String(storeNumber || '').trim();
}

async function destroySession(key, reason) {
    const session = sessions.get(key);
    if (!session) return;
    sessions.delete(key);
    try {
        if (session.context) await session.context.close();
    } catch {
        /* ignore */
    }
    if (reason) {
        console.log(`[SessionPool] Closed store ${key} session - ${reason}`);
    }
}

async function closeAllSessions(reason = 'teardown') {
    const keys = [...sessions.keys()];
    for (const key of keys) {
        await destroySession(key, null);
    }
    const browser = poolBrowser;
    poolBrowser = null;
    disconnectHooked = false;
    if (browser) {
        clearSalesScrapeBrowser(browser);
        await closeBrowserQuietly(browser, `session-pool:${reason}`);
        console.log(`[SessionPool] Browser closed - ${reason}`);
    }
}

function hookBrowserDisconnect(browser) {
    if (disconnectHooked || !browser) return;
    disconnectHooked = true;
    browser.on('disconnected', () => {
        if (poolBrowser === browser) {
            console.warn('[SessionPool] Browser disconnected - clearing pool');
            poolBrowser = null;
            sessions.clear();
            disconnectHooked = false;
            clearSalesScrapeBrowser(browser);
        }
    });
}

async function ensureBrowser(options = {}) {
    throwIfSalesScrapeAborted();
    if (poolBrowser) {
        try {
            if (typeof poolBrowser.isConnected === 'function' && !poolBrowser.isConnected()) {
                throw new Error('disconnected');
            }
            if (typeof poolBrowser.pages === 'function') {
                await poolBrowser.pages();
            }
            return poolBrowser;
        } catch {
            poolBrowser = null;
            sessions.clear();
            disconnectHooked = false;
        }
    }

    const { getPuppeteerLaunchOptions } = mmx();
    const launchOpts = getPuppeteerLaunchOptions(options.launchOptions || {});
    if (!launchOpts.headless) {
        console.log('[SessionPool] Visible browser (SCRAPER_HEADLESS=false/0)');
    }
    const browser = await puppeteer.launch(launchOpts);
    poolBrowser = browser;
    trackBrowser(browser, 'sales-session-pool');
    hookBrowserDisconnect(browser);
    if (typeof options.onBrowser === 'function') {
        options.onBrowser(browser);
    }
    registerSalesScrapeBrowser(browser);
    console.log('[SessionPool] Persistent Chromium launched');
    return browser;
}

async function createIsolatedContext(browser) {
    const fn = browser.createBrowserContext || browser.createIncognitoBrowserContext;
    return fn.call(browser);
}

const LABOUR_URL =
    'https://tacobellau.macromatix.net/MMS_Stores_LabourScheduler.aspx?MenuCustomItemID=249';

async function loginAndBindStore(page, storeNumber, credentials) {
    const { loginPage, selectStoreAfterLogin, applyResourceBlocking, assertMacromatixAuthenticated } =
        mmx();
    await page.setViewport({ width: 1280, height: 720 });
    await applyResourceBlocking(page);
    await loginPage(page, credentials.username, credentials.password);
    await selectStoreAfterLogin(page, storeNumber, credentials);
    await assertMacromatixAuthenticated(page, `store ${storeNumber} after login`);
}

async function primeLabourDayView(page, storeNumber) {
    const { openDayViewAndReadSales } = mmx();
    const { getStoreConfig } = require('../../src/services/storeList');
    const { getStoreDateKey } = require('../../dashboard/src/sssg/sssgWeeklyLedger');
    const cfg = getStoreConfig(storeNumber) || {};
    const timeZone =
        String(cfg.timeZone || '').trim() ||
        process.env.DASHBOARD_TIME_ZONE ||
        process.env.MMX_TIME_ZONE ||
        'Australia/Melbourne';
    const todayKey = getStoreDateKey({ storeNumber, timeZone });

    await page.goto(LABOUR_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForFunction(() => document.readyState === 'complete', { timeout: 15000 }).catch(() => {});
    await openDayViewAndReadSales(page, false, { targetDateIso: todayKey, timeZone });
    console.log(`[SessionPool] Store ${storeNumber} primed on labour Day view (${todayKey})`);
}

async function withDeadline(promise, ms, label) {
    let timer;
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

async function ensureStoreSession(storeNumber, credentials, options = {}) {
    const key = storeKey(storeNumber);
    if (!key) throw new Error('ensureStoreSession requires storeNumber');

    let session = sessions.get(key);
    if (session) {
        try {
            await mmx().assertMacromatixAuthenticated(session.labourPage, `store ${key} labour`);
            return session;
        } catch (authErr) {
            console.warn(
                `[SessionPool] Store ${key} session expired (${authErr.message}) - re-login`
            );
            await destroySession(key, 're-login');
            session = null;
        }
    }

    const browser = await ensureBrowser(options);
    const context = await createIsolatedContext(browser);
    let labourPage = await context.newPage();
    const ordersPage = await context.newPage();

    try {
        await withDeadline(loginAndBindStore(labourPage, key, credentials), 60000, `Store ${key} login`);
        // Edge can wedge the login page after SelectStore postback; continue on a fresh tab.
        try {
            await labourPage.close().catch(() => {});
            labourPage = await context.newPage();
            await labourPage.setViewport({ width: 1280, height: 720 });
            await mmx().applyResourceBlocking(labourPage);
        } catch (pageErr) {
            console.warn(`[SessionPool] Store ${key} could not open fresh labour tab: ${pageErr.message}`);
        }
        console.log(`[SessionPool] Store ${key} logged in — Day view will open on first scrape`);
        await ordersPage.setViewport({ width: 1280, height: 720 });
        await mmx().applyResourceBlocking(ordersPage);
        await ordersPage.goto('about:blank').catch(() => {});
    } catch (err) {
        try {
            await context.close();
        } catch {
            /* ignore */
        }
        throw err;
    }

    session = {
        storeNumber: key,
        context,
        labourPage,
        ordersPage,
        credentials: { username: credentials.username, password: credentials.password },
        lock: createLock(),
    };
    sessions.set(key, session);
    console.log(`[SessionPool] Store ${key} session ready (${credentials.username})`);
    return session;
}

/**
 * Run work under a per-store lock with one re-login retry on auth failure.
 */
async function withStorePage(storeNumber, credentials, pageKind, fn, options = {}) {
    const key = storeKey(storeNumber);
    let lastErr;
    for (let attempt = 0; attempt < 2; attempt++) {
        throwIfSalesScrapeAborted();
        const session = await ensureStoreSession(key, credentials, options);
        await session.lock.acquire();
        let released = false;
        const release = () => {
            if (!released) {
                released = true;
                session.lock.release();
            }
        };
        try {
            throwIfSalesScrapeAborted();
            const page = pageKind === 'orders' ? session.ordersPage : session.labourPage;
            try {
                await mmx().assertMacromatixAuthenticated(page, `store ${key} ${pageKind}`);
            } catch (authErr) {
                if (attempt === 0) {
                    console.warn(
                        `[SessionPool] Store ${key} ${pageKind} auth lost - rebuilding session`
                    );
                    release();
                    await destroySession(key, 'auth-lost');
                    continue;
                }
                throw authErr;
            }
            const result = await fn(page, session);
            release();
            return result;
        } catch (err) {
            lastErr = err;
            const msg = String(err?.message || '');
            const sessionDead =
                /Target closed|Session closed|Protocol error|browser has been closed|not authenticated|login page/i.test(
                    msg
                );
            release();
            if (sessionDead && attempt === 0 && !isSalesScrapeAbortRequested()) {
                console.warn(`[SessionPool] Store ${key} recoverable error - retry once: ${msg}`);
                await destroySession(key, 'recover');
                continue;
            }
            throw err;
        }
    }
    throw lastErr || new Error(`SessionPool: failed for store ${key}`);
}

async function withLabourPage(storeNumber, credentials, fn, options = {}) {
    return withStorePage(storeNumber, credentials, 'labour', fn, options);
}

async function withOrdersPage(storeNumber, credentials, fn, options = {}) {
    return withStorePage(storeNumber, credentials, 'orders', fn, options);
}

function getPoolBrowser() {
    return poolBrowser;
}

function getSessionCount() {
    return sessions.size;
}

function hasStoreSession(storeNumber) {
    return sessions.has(storeKey(storeNumber));
}

/** Tear down when no store is in the active scrape window (frees RAM overnight). */
async function maybeTeardownOutsideWindow() {
    if (!isPersistentSessionsEnabled()) return;
    if (!poolBrowser && !sessions.size) return;
    if (anyStoreInActiveScrapeWindow()) return;
    await closeAllSessions('outside active scrape window');
}

registerMmxAbortHandler((reason) => {
    if (!isPersistentSessionsEnabled()) return;
    if (!poolBrowser && !sessions.size) return;
    console.log(`[SessionPool] Abort - closing persistent sessions (${reason})`);
    closeAllSessions(`abort:${reason}`).catch((err) => {
        console.warn('[SessionPool] Abort teardown failed:', err.message);
    });
});

module.exports = {
    isPersistentSessionsEnabled,
    ensureBrowser,
    ensureStoreSession,
    withLabourPage,
    withOrdersPage,
    closeAllSessions,
    maybeTeardownOutsideWindow,
    getPoolBrowser,
    getSessionCount,
    hasStoreSession,
};
