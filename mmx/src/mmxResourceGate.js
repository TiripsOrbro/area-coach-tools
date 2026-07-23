/**
 * Coordinates Macromatix browser work across scrapes vs stock count / orders.
 *
 * By default (more RAM hosts), sales/vendor scrapes run in parallel with MIC/admin work.
 * Set MMX_PAUSE_SCRAPE_FOR_PRIORITY=1 on low-RAM hosts (e.g. Pi) to restore exclusive pause/abort.
 */

let holdCount = 0;
let salesPauseHoldCount = 0;
let lightweightHoldCount = 0;
const idleWaiters = [];
const abortHandlers = new Set();
let pauseTimer = null;
/** Optional warning timer only - must never release the hold (stock count / orders can take 15+ min). */
const SCRAPE_PAUSE_MAX_MS = Number(process.env.MMX_SCRAPE_PAUSE_MAX_MS ?? 0);

/** When true, scrapes defer/abort for MIC/admin MMX work. Default off. */
function mmxPauseScrapeForPriority() {
    return /^(1|true|yes|on)$/i.test(String(process.env.MMX_PAUSE_SCRAPE_FOR_PRIORITY ?? '0').trim());
}

function registerMmxAbortHandler(handler) {
    if (typeof handler === 'function') abortHandlers.add(handler);
}

/** Force-stop in-flight MMX browsers (sales scrape when pause enabled, forecast, etc.). */
function abortCompetingMmxWork(reason) {
    const label = String(reason || 'stock count / orders').trim();
    for (const handler of abortHandlers) {
        try {
            handler(label);
        } catch (err) {
            console.warn('[MMX Resource] Abort handler failed:', err.message);
        }
    }
}

function clearPauseTimeout() {
    if (!pauseTimer) return;
    clearTimeout(pauseTimer);
    pauseTimer = null;
}

function schedulePauseTimeout() {
    clearPauseTimeout();
    if (SCRAPE_PAUSE_MAX_MS <= 0) return;
    pauseTimer = setTimeout(() => {
        pauseTimer = null;
        if (holdCount <= 0) return;
        console.warn(
            `[MMX Resource] Stock count / orders still running after ${Math.round(SCRAPE_PAUSE_MAX_MS / 1000)}s - sales scrape remains paused until MMX work finishes`
        );
    }, SCRAPE_PAUSE_MAX_MS);
}

/** Extend scrape-pause window while stock count / orders are still making progress. */
function refreshScrapePauseTimeout() {
    if (holdCount <= 0) return;
    schedulePauseTimeout();
}

function acquireMmxResource(reason, { pausesSales = true } = {}) {
    const wasIdle = holdCount === 0;
    holdCount++;
    if (pausesSales) salesPauseHoldCount++;
    if (wasIdle && reason) {
        if (pausesSales && mmxPauseScrapeForPriority()) {
            console.log(`[MMX Resource] Pausing sales scrape - ${reason}`);
        } else if (!pausesSales) {
            console.log(`[MMX Resource] MMX browser slot in use - ${reason}`);
        } else {
            console.log(`[MMX Resource] Heavy MMX work started - ${reason}`);
        }
    }
    if (holdCount === 1) {
        schedulePauseTimeout();
    }
}

function releaseMmxResource(reason, { pausesSales = true } = {}) {
    clearPauseTimeout();
    if (holdCount <= 0) return;
    holdCount--;
    if (pausesSales && salesPauseHoldCount > 0) salesPauseHoldCount--;
    if (holdCount === 0 && lightweightHoldCount === 0) {
        if (mmxPauseScrapeForPriority()) {
            console.log(
                `[MMX Resource] Sales scrape may resume${reason ? ` (${reason})` : ''}`
            );
        } else {
            console.log(
                `[MMX Resource] Heavy MMX work finished${reason ? ` (${reason})` : ''}`
            );
        }
        while (idleWaiters.length) {
            idleWaiters.shift()();
        }
    }
}

/** Parallel report downloads / stock-level checks — do not pause sales scrape. */
function acquireLightweightMmxResource(reason) {
    lightweightHoldCount++;
    if (reason && lightweightHoldCount === 1) {
        console.log(`[MMX Resource] Lightweight MMX work started - ${reason}`);
    }
}

function releaseLightweightMmxResource(reason) {
    if (lightweightHoldCount <= 0) return;
    lightweightHoldCount--;
    if (lightweightHoldCount === 0 && holdCount === 0) {
        console.log(
            `[MMX Resource] Lightweight MMX work finished${reason ? ` (${reason})` : ''}`
        );
        while (idleWaiters.length) {
            idleWaiters.shift()();
        }
    }
}

function isMmxResourceBusy() {
    return holdCount > 0;
}

/** True when MIC/admin work is holding the gate (vendor scrape alone does not block sales). */
function isSalesScrapeBlocked() {
    return salesPauseHoldCount > 0;
}

function isLightweightMmxResourceBusy() {
    return lightweightHoldCount > 0;
}

function isAnyMmxResourceBusy() {
    return holdCount > 0 || lightweightHoldCount > 0;
}

function waitUntilMmxResourceIdle() {
    if (!isMmxResourceBusy()) return Promise.resolve();
    return new Promise((resolve) => idleWaiters.push(resolve));
}

/** Reset leaked in-process holds (e.g. stale queue slot cleared while work still marked active). */
function forceReleaseAllMmxResourceHolds(reason) {
    clearPauseTimeout();
    const heavy = holdCount;
    const light = lightweightHoldCount;
    if (heavy <= 0 && light <= 0) return false;
    holdCount = 0;
    salesPauseHoldCount = 0;
    lightweightHoldCount = 0;
    console.warn(
        `[MMX Resource] Force-released ${heavy} heavy + ${light} lightweight hold(s)${
            reason ? ` (${reason})` : ''
        } — sales scrape may resume`
    );
    while (idleWaiters.length) {
        idleWaiters.shift()();
    }
    return true;
}

module.exports = {
    mmxPauseScrapeForPriority,
    acquireMmxResource,
    releaseMmxResource,
    acquireLightweightMmxResource,
    releaseLightweightMmxResource,
    refreshScrapePauseTimeout,
    isMmxResourceBusy,
    isSalesScrapeBlocked,
    isLightweightMmxResourceBusy,
    isAnyMmxResourceBusy,
    waitUntilMmxResourceIdle,
    registerMmxAbortHandler,
    abortCompetingMmxWork,
    forceReleaseAllMmxResourceHolds,
};
