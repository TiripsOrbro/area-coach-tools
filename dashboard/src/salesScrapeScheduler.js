const { mmxPauseScrapeForPriority } = require('../../mmx/src/mmxResourceGate');
const {
    hasPendingHigherPriority,
    hasBlockingWorkForPriority,
    PRIORITY,
} = require('../../mmx/src/mmxTaskQueue');
const { anyStoreInActiveScrapeWindow } = require('./scrapeSchedule');

const TIME_ZONE = process.env.DASHBOARD_TIME_ZONE || 'Australia/Melbourne';
const INTERVAL_MS = Math.max(30, Number(process.env.SCRAPE_FAST_INTERVAL_SECONDS || 120)) * 1000;

/**
 * @param {{
 *   runFullScrape: (opts?: object) => Promise<unknown>,
 *   shouldPrimeOnBoot?: () => boolean,
 *   isScrapeInFlight?: () => boolean,
 * }} handlers
 */
function startSalesScrapeScheduler(handlers) {
    const { runFullScrape, shouldPrimeOnBoot, isScrapeInFlight } = handlers;

    let intervalId = null;
    let bootTimeoutId = null;
    let lastDeferLogAt = 0;

    const shouldSkipScrapeTick = () => {
        if (!mmxPauseScrapeForPriority()) return false;
        // Only MIC/admin — vendor is lower priority and sales will preempt it.
        let reason = '';
        if (hasPendingHigherPriority(PRIORITY.SCRAPE)) reason = 'higher-priority MMX queue work pending';
        else if (hasBlockingWorkForPriority(PRIORITY.SCRAPE)) reason = 'MMX queue slot blocked';
        if (!reason) return false;
        const now = Date.now();
        if (now - lastDeferLogAt >= 5 * 60 * 1000) {
            console.log(`[Dashboard] Sales scrape deferred — ${reason}`);
            lastDeferLogAt = now;
        }
        return true;
    };

    const intervalTick = async () => {
        try {
            if (!anyStoreInActiveScrapeWindow()) return;
            if (isScrapeInFlight?.()) return;
            if (shouldSkipScrapeTick()) return;
            await runFullScrape({ scrapeReason: 'interval' });
        } catch (error) {
            console.warn('[Dashboard] Interval sales scrape failed:', error.message);
        }
    };

    intervalId = setInterval(intervalTick, INTERVAL_MS);
    intervalId.unref?.();

    if (shouldPrimeOnBoot?.()) {
        bootTimeoutId = setTimeout(async () => {
            try {
                if (shouldSkipScrapeTick()) return;
                await runFullScrape({ scrapeReason: 'boot-prime' });
            } catch (error) {
                console.warn('[Dashboard] Boot prime scrape failed:', error.message);
            }
        }, 3000);
        bootTimeoutId.unref?.();
    }

    console.log(
        `[Dashboard] Sales scrape scheduler - full market every ${INTERVAL_MS / 1000}s (${TIME_ZONE})` +
            (mmxPauseScrapeForPriority() ? '' : ' (parallel with stock count / orders)')
    );

    return {
        cancel() {
            if (intervalId) clearInterval(intervalId);
            if (bootTimeoutId) clearTimeout(bootTimeoutId);
        },
    };
}

module.exports = {
    startSalesScrapeScheduler,
};
