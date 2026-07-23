const { getStoreList } = require('../../stores/src/storeList');
const { storeHasServiceCredentials } = require('../../stores/src/storeCredentials');
const { melbourneDateKey } = require('../../vendors/src/stockCountState');
const { resetSalesScrapeAbort } = require('../../dashboard/src/salesScrapeAbort');
const { openMacromatixBrowser, closeBrowserQuietly, probePendingOrdersForStores } = require('./macromatixScraper');
const {
    applyMorningPrecheckResults,
    morningPrecheckCompletedFor,
    markMorningPrecheckCompleted,
} = require('../../vendors/src/orderingDayState');
const { prefetchOrderingReportsForStore } = require('../../vendors/src/orderingReportPrefetch');
const { runWithPriority, PRIORITY } = require('./mmxTaskQueue');
const { resolveOrderDateKey, ymdToPickParts } = require('./scheduledReportDownload');

const TIME_ZONE = process.env.REPORT_DOWNLOAD_TIME_ZONE || process.env.DASHBOARD_TIME_ZONE || 'Australia/Melbourne';

function resolveMorningPrecheckOrderDateKey(options = {}) {
    if (options.orderDateKey) return options.orderDateKey;
    if (options.orderDate) return resolveOrderDateKey(options.orderDate);
    const { loadVendorOrdersConfig } = require('../../vendors/src/vendorOrdersConfig');
    const cfg = loadVendorOrdersConfig();
    return resolveOrderDateKey(cfg.scheduledOrdersDate || 'tomorrow');
}

function morningPrecheckEnabled() {
    return !/^(0|false|no|off)$/i.test(String(process.env.ORDERING_MORNING_PRECHECK ?? '1').trim());
}

function localHourInTimeZone(date = new Date()) {
    const parts = new Intl.DateTimeFormat('en-AU', {
        timeZone: TIME_ZONE,
        hour: 'numeric',
        hour12: false,
    }).formatToParts(date instanceof Date ? date : new Date(date));
    return Number(parts.find((p) => p.type === 'hour')?.value || 0);
}

/** Inclusive start hour (default 4). Boot catch-up before typical morning restart / reports. */
function morningPrecheckStartHour() {
    const h = Number(process.env.ORDERING_MORNING_PRECHECK_HOUR ?? 4);
    return Number.isFinite(h) && h >= 0 && h <= 23 ? Math.floor(h) : 4;
}

/** Exclusive end hour (default 12). Afternoon dashboard restarts must not re-run precheck. */
function morningPrecheckUntilHour() {
    const h = Number(process.env.ORDERING_MORNING_PRECHECK_UNTIL_HOUR ?? 12);
    return Number.isFinite(h) && h >= 1 && h <= 24 ? Math.floor(h) : 12;
}

/**
 * Scheduled/boot runs only inside the morning window. Manual / force runs ignore this.
 * Window is [startHour, untilHour) in Melbourne (or DASHBOARD_TIME_ZONE).
 */
function isWithinMorningPrecheckWindow(date = new Date()) {
    const hour = localHourInTimeZone(date);
    const start = morningPrecheckStartHour();
    const until = morningPrecheckUntilHour();
    if (until <= start) {
        // Wrap past midnight (e.g. 22 → 6): hour >= start OR hour < until
        return hour >= start || hour < until;
    }
    return hour >= start && hour < until;
}

/** Per-store MMX logins need a store number to decrypt; pick any credentialed store to open the browser. */
function pickMorningPrecheckBootstrapStore(stores = []) {
    for (const store of stores) {
        const num = String(store?.storeNumber || '').trim();
        if (num && storeHasServiceCredentials(num, 'mmx')) return num;
    }
    return String(stores[0]?.storeNumber || '').trim();
}

/**
 * Morning ordering precheck: probe every store once, mark no-order stores done for the day,
 * prefetch ISE + on-order for stores that still need to place orders.
 */
async function runMorningOrderingPrecheck(options = {}) {
    if (!morningPrecheckEnabled()) {
        return { skipped: true, reason: 'disabled' };
    }

    const runDateKey = options.runDateKey || melbourneDateKey();
    const orderDateKey = resolveMorningPrecheckOrderDateKey(options);
    const pickYmd = ymdToPickParts(orderDateKey);

    if (
        options.scheduled &&
        !options.force &&
        !isWithinMorningPrecheckWindow()
    ) {
        const hour = localHourInTimeZone();
        const start = morningPrecheckStartHour();
        const until = morningPrecheckUntilHour();
        console.log(
            `[Ordering] Morning precheck skipped - outside morning window ` +
                `(hour ${hour}, window ${start}-${until} ${TIME_ZONE})`
        );
        return {
            skipped: true,
            reason: 'outside-morning-window',
            runDateKey,
            orderDateKey,
            localHour: hour,
            windowStartHour: start,
            windowUntilHour: until,
        };
    }

    if (!options.force && morningPrecheckCompletedFor(runDateKey)) {
        return { skipped: true, reason: 'already-ran-today', runDateKey, orderDateKey };
    }

    const stores = getStoreList();
    if (!stores.length) {
        throw new Error('No stores in .storelist');
    }

    const bootstrapStore =
        String(options.storeNumber || options.store || '').trim() || pickMorningPrecheckBootstrapStore(stores);
    if (!bootstrapStore || !storeHasServiceCredentials(bootstrapStore, 'mmx')) {
        console.warn(
            '[Ordering] Morning precheck skipped - no Macromatix store logins found. ' +
                'Configure in Admin → Setup Store Logins.'
        );
        return { skipped: true, reason: 'no-mmx-credentials', runDateKey, orderDateKey };
    }

    return runWithPriority(PRIORITY.MIC, {
        type: 'morning-ordering-precheck',
        label: `morning ordering precheck (${orderDateKey})`,
        run: async () => {
            let browser;
            let page;
            try {
                ({ browser, page } = await openMacromatixBrowser({ ...options, storeNumber: bootstrapStore }));
                // Preempt clears the cooperative abort flag for the old sales scrape; reset so our probes run.
                resetSalesScrapeAbort();
                const probe = await probePendingOrdersForStores(page, stores, { pickYmd });
                applyMorningPrecheckResults(runDateKey, probe);

                const withOrders = probe.filter((p) => p.hasOrders && (p.pendingVendors || []).length);
                const prefetchResults = [];

                for (const row of withOrders) {
                    try {
                        const result = await prefetchOrderingReportsForStore(row.storeNumber, {
                            ...options,
                            waitForIdle: true,
                        });
                        prefetchResults.push({ storeNumber: row.storeNumber, ...result });
                    } catch (err) {
                        prefetchResults.push({
                            storeNumber: row.storeNumber,
                            success: false,
                            error: err?.message || String(err),
                        });
                    }
                }

                markMorningPrecheckCompleted(runDateKey);

                const summary = {
                    runDateKey,
                    orderDateKey,
                    probed: probe,
                    storesWithOrders: withOrders.map((p) => ({
                        storeNumber: p.storeNumber,
                        storeName: p.storeName,
                        pendingVendors: p.pendingVendors,
                    })),
                    storesMarkedNoOrders: probe
                        .filter((p) => !p.hasOrders || !(p.pendingVendors || []).length)
                        .map((p) => p.storeNumber),
                    prefetchResults,
                };

                console.log(
                    `[Ordering] Morning precheck ${runDateKey}: ${withOrders.length} store(s) with orders, ` +
                        `${summary.storesMarkedNoOrders.length} marked no orders for the day`
                );

                return summary;
            } finally {
                await closeBrowserQuietly(browser, 'morning ordering precheck');
            }
        },
    });
}

module.exports = {
    morningPrecheckEnabled,
    isWithinMorningPrecheckWindow,
    morningPrecheckStartHour,
    morningPrecheckUntilHour,
    runMorningOrderingPrecheck,
    resolveMorningPrecheckOrderDateKey,
};
