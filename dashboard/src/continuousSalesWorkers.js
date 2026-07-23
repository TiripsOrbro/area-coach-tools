const { anyStoreInActiveScrapeWindow } = require('./scrapeSchedule');

const TIME_ZONE = process.env.DASHBOARD_TIME_ZONE || 'Australia/Melbourne';
const INTERVAL_MS = Math.max(30, Number(process.env.SCRAPE_FAST_INTERVAL_SECONDS || 120)) * 1000;
const BOOT_STAGGER_MS = Math.max(500, Number(process.env.SCRAPE_CONTINUOUS_BOOT_STAGGER_MS || 3000));
const STORE_TIMEOUT_MS = Math.max(
    30000,
    Number(process.env.SCRAPE_CONTINUOUS_STORE_TIMEOUT_MS || 90000) || 90000
);

function isContinuousWorkersEnabled() {
    const explicit = String(process.env.SCRAPER_CONTINUOUS_WORKERS || '').trim();
    if (explicit) return /^(1|true|yes|on)$/i.test(explicit);
    return /^(1|true|yes|on)$/i.test(String(process.env.SCRAPER_PERSISTENT_SESSIONS || '').trim());
}

function withTimeout(promise, ms, label) {
    let timer;
    return Promise.race([
        promise,
        new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
        }),
    ]).finally(() => clearTimeout(timer));
}

/**
 * Per-store sales scrape loops. Each store refreshes its own persistent labour Day view
 * on its own timer instead of one full-market scrape cycle.
 *
 * @param {{
 *   listStores: () => Array<{ storeNumber: string }>,
 *   isStoreActive?: (store: object) => boolean,
 *   scrapeStore: (store: object) => Promise<void>,
 * }} handlers
 */
function startContinuousSalesWorkers(handlers) {
    const { listStores, isStoreActive, scrapeStore } = handlers;
    const storeTimers = new Map();
    const storeInFlight = new Set();
    let bootPromise = null;

    const activeCheck =
        typeof isStoreActive === 'function'
            ? isStoreActive
            : (store) => {
                  const { getStoreScrapePhase } = require('./scrapeSchedule');
                  return getStoreScrapePhase(store) === 'active';
              };

    async function tickStore(store) {
        const key = String(store.storeNumber || '').trim();
        if (!key || storeInFlight.has(key)) return;
        if (!anyStoreInActiveScrapeWindow()) return;
        if (!activeCheck(store)) return;

        storeInFlight.add(key);
        try {
            await withTimeout(scrapeStore(store), STORE_TIMEOUT_MS, `Store ${key} continuous scrape`);
        } catch (error) {
            console.warn(`[Continuous] Store ${key} scrape failed: ${error.message}`);
            try {
                const { requestSalesScrapeAbort } = require('../../src/services/salesScrapeAbort');
                requestSalesScrapeAbort(`continuous store ${key} timeout/failure`);
            } catch {
                /* ignore */
            }
        } finally {
            storeInFlight.delete(key);
        }
    }

    function startStoreInterval(store) {
        const key = String(store.storeNumber || '').trim();
        if (!key || storeTimers.has(key)) return;
        const intervalId = setInterval(() => {
            tickStore(store).catch(() => {});
        }, INTERVAL_MS);
        intervalId.unref?.();
        storeTimers.set(key, intervalId);
    }

    async function bootStoresSequentially() {
        const stores = (listStores() || []).filter((store) => String(store.storeNumber || '').trim());
        // Start intervals first so a hung first store cannot block the whole market.
        for (const store of stores) {
            startStoreInterval(store);
        }
        for (let index = 0; index < stores.length; index += 1) {
            const store = stores[index];
            await tickStore(store);
            if (index < stores.length - 1 && BOOT_STAGGER_MS > 0) {
                await new Promise((resolve) => setTimeout(resolve, BOOT_STAGGER_MS));
            }
        }
    }

    bootPromise = bootStoresSequentially().catch((error) => {
        console.warn('[Continuous] Boot prime failed:', error.message);
    });

    console.log(
        `[Dashboard] Continuous sales workers - one loop per store every ${INTERVAL_MS / 1000}s (${TIME_ZONE}); ` +
            `login once per store, labour Day view refresh (store timeout ${Math.round(STORE_TIMEOUT_MS / 1000)}s)`
    );

    return {
        cancel() {
            for (const timer of storeTimers.values()) clearInterval(timer);
            storeTimers.clear();
            storeInFlight.clear();
        },
        whenReady: () => bootPromise || Promise.resolve(),
        refreshWorkers() {
            bootPromise = bootStoresSequentially().catch((error) => {
                console.warn('[Continuous] Refresh prime failed:', error.message);
            });
            return bootPromise;
        },
    };
}

module.exports = {
    isContinuousWorkersEnabled,
    startContinuousSalesWorkers,
};
