/** Cooperative abort for dashboard sales scrape when higher-priority MMX work takes the browser. */

const { closeBrowserQuietly } = require('../../mmx/src/browserLifecycle');

class MmxWorkAbortedError extends Error {
    constructor(reason = 'MMX work aborted') {
        super(reason);
        this.name = 'MmxWorkAbortedError';
        this.aborted = true;
        this.abortReason = reason;
    }
}

let abortRequested = false;
let abortReason = '';
let activeBrowser = null;
let abortCloseTimer = null;

const ABORT_FORCE_CLOSE_MS = Number(process.env.SALES_SCRAPE_ABORT_CLOSE_MS || 2500);
const DEFAULT_ABORT_REASON = 'higher-priority MMX work';

function isSalesScrapeAbortRequested() {
    return abortRequested;
}

function getSalesScrapeAbortReason() {
    return abortReason || DEFAULT_ABORT_REASON;
}

function salesScrapeAbortError(kind = 'Sales scrape') {
    const label = String(kind || 'Sales scrape').trim() || 'Sales scrape';
    return new MmxWorkAbortedError(`${label} aborted - ${getSalesScrapeAbortReason()}`);
}

function resetSalesScrapeAbort() {
    abortRequested = false;
    abortReason = '';
    if (abortCloseTimer) {
        clearTimeout(abortCloseTimer);
        abortCloseTimer = null;
    }
}

function registerSalesScrapeBrowser(browser) {
    activeBrowser = browser || null;
}

function clearSalesScrapeBrowser(browser) {
    if (activeBrowser === browser) activeBrowser = null;
}

function requestSalesScrapeAbort(reason) {
    const label = String(reason || '').trim();
    // Sales queue acquire calls preempt with its own label — not an abort of in-flight sales work.
    if (/^sales scrape \(/i.test(label)) return false;

    let queuePreempt = false;
    try {
        const { getPreemptRequestForLocalPriority, getLocalSlotPriority, PRIORITY } = require('../../mmx/src/mmxTaskQueue');
        const localPriority = getLocalSlotPriority();
        if (localPriority === PRIORITY.SCRAPE) {
            queuePreempt = Boolean(getPreemptRequestForLocalPriority(localPriority));
        }
    } catch {
        /* ignore */
    }

    const { mmxPauseScrapeForPriority } = require('../../mmx/src/mmxResourceGate');
    if (!queuePreempt && !mmxPauseScrapeForPriority()) return false;
    if (abortRequested) return true;
    abortRequested = true;
    abortReason = String(reason || DEFAULT_ABORT_REASON).trim() || DEFAULT_ABORT_REASON;
    console.log(`[MMX Resource] Aborting in-flight sales scrape - ${abortReason}`);
    // Cooperative abort: scrape checks the flag and closes its own browser. A delayed
    // force-close avoids racing workers mid-page.evaluate (immediate close caused retry storms).
    if (abortCloseTimer) clearTimeout(abortCloseTimer);
    const closeDelayMs = queuePreempt
        ? Number(process.env.SALES_SCRAPE_QUEUE_PREEMPT_CLOSE_MS || 800)
        : ABORT_FORCE_CLOSE_MS;
    abortCloseTimer = setTimeout(() => {
        abortCloseTimer = null;
        const browser = activeBrowser;
        if (!browser) return;
        activeBrowser = null;
        closeBrowserQuietly(browser, `sales-scrape-abort:${abortReason}`).catch(() => {});
    }, closeDelayMs);
    return true;
}

function throwIfSalesScrapeAborted(kind = 'Sales scrape') {
    if (abortRequested) {
        throw salesScrapeAbortError(kind);
    }
}

const { registerMmxAbortHandler } = require('../../mmx/src/mmxResourceGate');
registerMmxAbortHandler(requestSalesScrapeAbort);

module.exports = {
    MmxWorkAbortedError,
    isSalesScrapeAbortRequested,
    getSalesScrapeAbortReason,
    salesScrapeAbortError,
    resetSalesScrapeAbort,
    registerSalesScrapeBrowser,
    clearSalesScrapeBrowser,
    requestSalesScrapeAbort,
    throwIfSalesScrapeAborted,
};
