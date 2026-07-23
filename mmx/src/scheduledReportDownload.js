const { getStoreList } = require('../../stores/src/storeList');
const { openMacromatixBrowser, closeBrowserQuietly, probePendingOrdersForStores } = require('./macromatixScraper');
const { downloadReportsForStores } = require('./mmxReportDownloader');
const { hasScheduledRunToday, markScheduledRun } = require('./reportDownloadScheduleState');
const { runWithPriority, PRIORITY } = require('./mmxTaskQueue');

const TIME_ZONE = process.env.REPORT_DOWNLOAD_TIME_ZONE || process.env.DASHBOARD_TIME_ZONE || 'Australia/Melbourne';

function melbourneDateKey(date = new Date()) {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: TIME_ZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(date);
}

function addDaysToYmd(ymd, deltaDays) {
    const [y, m, d] = String(ymd).split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + deltaDays);
    const pad = (n) => String(n).padStart(2, '0');
    return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

function ymdToPickParts(ymd) {
    const [year, month, day] = String(ymd).split('-').map(Number);
    return { year, month, day };
}

/**
 * Which scheduled-orders calendar date to inspect.
 * Env / option: today | tomorrow | YYYY-MM-DD | daysFromNow:N
 */
function resolveOrderDateKey(spec) {
    const raw = String(spec ?? process.env.REPORT_DOWNLOAD_ORDER_DATE ?? 'today').trim();
    const today = melbourneDateKey();
    if (!raw || /^today$/i.test(raw)) return today;
    if (/^tomorrow$/i.test(raw)) return addDaysToYmd(today, 1);
    const ahead = raw.match(/^daysFromNow:(\d+)$/i);
    if (ahead) return addDaysToYmd(today, parseInt(ahead[1], 10));
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
    throw new Error(`Invalid order date spec "${raw}" - use today, tomorrow, YYYY-MM-DD, or daysFromNow:N`);
}

function localHourMinute(date = new Date()) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: TIME_ZONE,
        hour: 'numeric',
        minute: 'numeric',
        hour12: false,
    }).formatToParts(date);
    const map = Object.fromEntries(parts.filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]));
    return { hour: parseInt(map.hour, 10), minute: parseInt(map.minute, 10) };
}

function scheduleHour() {
    const h = Number(process.env.REPORT_DOWNLOAD_SCHEDULE_HOUR ?? 8);
    return Number.isFinite(h) && h >= 0 && h <= 23 ? Math.floor(h) : 8;
}

function scheduleWindowMinutes() {
    const m = Number(process.env.REPORT_DOWNLOAD_SCHEDULE_WINDOW_MIN ?? 15);
    return Number.isFinite(m) && m > 0 ? Math.floor(m) : 15;
}

function isScheduleEnabled() {
    return /^(1|true|yes|on)$/i.test(String(process.env.REPORT_DOWNLOAD_SCHEDULE_ENABLED ?? '').trim());
}

function isWithinScheduleWindow(date = new Date()) {
    const { hour, minute } = localHourMinute(date);
    const start = scheduleHour();
    return hour === start && minute < scheduleWindowMinutes();
}

function msUntilNextScheduleRun(date = new Date()) {
    const { hour, minute } = localHourMinute(date);
    const start = scheduleHour();
    const msIntoDay = hour * 3600000 + minute * 60000 + date.getSeconds() * 1000 + date.getMilliseconds();

    if (hour === start && minute < scheduleWindowMinutes()) {
        return 60000;
    }

    if (hour < start) {
        return start * 3600000 - msIntoDay;
    }

    return (24 - hour + start) * 3600000 - minute * 60000 - date.getSeconds() * 1000 - date.getMilliseconds();
}

/**
 * Log into Macromatix, find stores with pending scheduled orders on `orderDateKey`,
 * then download build-to reports for those stores only (single browser session).
 */
async function runOrderDayReportDownload(options = {}) {
    const useMorningPrecheck = !/^(0|false|no|off)$/i.test(
        String(process.env.ORDERING_MORNING_PRECHECK ?? '1').trim()
    );
    if (useMorningPrecheck) {
        const { runMorningOrderingPrecheck } = require('./orderingMorningPrecheck');
        return runMorningOrderingPrecheck(options);
    }

    const orderDateKey = resolveOrderDateKey(options.orderDate);
    const pickYmd = ymdToPickParts(orderDateKey);
    const runDateKey = melbourneDateKey();
    const dryRun = Boolean(options.dryRun);
    const force = Boolean(options.force);

    if (!force && options.scheduled && hasScheduledRunToday(runDateKey, orderDateKey)) {
        return {
            skipped: true,
            reason: 'already-ran-today',
            runDateKey,
            orderDateKey,
        };
    }

    const stores = getStoreList();
    if (!stores.length) {
        throw new Error('No stores in .storelist');
    }

    return runWithPriority(PRIORITY.MIC, {
        type: 'order-day-reports',
        label: `order-day report download (${orderDateKey})`,
        run: async () => {
            let browser;
            let page;
            try {
                ({ browser, page } = await openMacromatixBrowser(options));

                const probe = await probePendingOrdersForStores(page, stores, { pickYmd });
                const withOrders = probe.filter((p) => p.hasOrders);

                const summary = {
                    runDateKey,
                    orderDateKey,
                    dryRun,
                    probed: probe,
                    storesWithOrders: withOrders.map((p) => ({
                        storeNumber: p.storeNumber,
                        storeName: p.storeName,
                        pendingVendors: p.pendingVendors,
                    })),
                    downloads: null,
                };

                if (!withOrders.length) {
                    console.log(
                        `[ReportDownload] No stores with pending orders on ${orderDateKey} - skipping report download.`
                    );
                    if (options.scheduled) {
                        markScheduledRun({
                            runDateKey,
                            orderDateKey,
                            stores: [],
                            result: summary,
                        });
                    }
                    return summary;
                }

                const storeNumbers = withOrders.map((p) => p.storeNumber);
                console.log(
                    `[ReportDownload] ${storeNumbers.length} store(s) have orders on ${orderDateKey}:`,
                    storeNumbers.join(', ')
                );

                if (dryRun) {
                    summary.downloads = { dryRun: true, storeNumbers };
                    return summary;
                }

                summary.downloads = await downloadReportsForStores({
                    storeNumbers,
                    page,
                    browser,
                });

                if (options.scheduled) {
                    markScheduledRun({
                        runDateKey,
                        orderDateKey,
                        stores: storeNumbers,
                        result: summary,
                    });
                }

                return summary;
            } finally {
                await closeBrowserQuietly(browser, 'order-day report download');
            }
        },
    });
}

module.exports = {
    TIME_ZONE,
    melbourneDateKey,
    resolveOrderDateKey,
    ymdToPickParts,
    scheduleHour,
    scheduleWindowMinutes,
    isScheduleEnabled,
    isWithinScheduleWindow,
    msUntilNextScheduleRun,
    runOrderDayReportDownload,
};
