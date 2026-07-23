const fs = require('fs');
const path = require('path');
const { destroySessionsForStore } = require('../../mmx/src/mmxCountSession');
const paths = require('../../src/paths');
const { clearStoreReportFilesPreservingStockLevels } = require('./reportReader');
const REPORTS_DIR = paths.vendors.reports;
const TMP_DOWNLOADS_ROOT = path.join(paths.root, 'out', 'tmp-report-downloads');

function removeMatchingFiles(dir, pattern) {
    if (!dir || !fs.existsSync(dir)) return 0;
    let removed = 0;
    for (const name of fs.readdirSync(dir)) {
        const fp = path.join(dir, name);
        try {
            const stat = fs.statSync(fp);
            if (stat.isFile() && pattern.test(name)) {
                fs.unlinkSync(fp);
                removed++;
            }
        } catch {
            /* file may already be gone */
        }
    }
    return removed;
}

function deleteStoreReportFiles(storeNumber) {
    const { removed } = clearStoreReportFilesPreservingStockLevels(storeNumber, REPORTS_DIR);
    return removed.length;
}

function deleteTempReportDownloadDirs() {
    if (!fs.existsSync(TMP_DOWNLOADS_ROOT)) return 0;
    let removed = 0;
    for (const name of fs.readdirSync(TMP_DOWNLOADS_ROOT)) {
        const fp = path.join(TMP_DOWNLOADS_ROOT, name);
        try {
            if (fs.statSync(fp).isDirectory()) {
                fs.rmSync(fp, { recursive: true, force: true });
                removed++;
            }
        } catch {
            /* best effort */
        }
    }
    return removed;
}

/**
 * True when every morning-pending vendor for this store/date has been submitted and sent to MMX.
 */
async function shouldMarkStoreOrdersComplete(storeNumber, dateKey) {
    const { getStoreEntry } = require('./orderingDayState');
    const { getSubmittedVendorSlugs, getMmxSentVendorSlugs } = require('./stockCountState');
    const { vendorLabelToSlug } = require('./vendorCatalog');
    const { filterVisiblePendingVendors } = require('./orderingLiveData');

    const entry = getStoreEntry(storeNumber, dateKey);
    const pendingLabels = filterVisiblePendingVendors(entry.pendingVendors || []);
    if (!pendingLabels.length) return true;

    const pendingSlugs = pendingLabels.map((label) => vendorLabelToSlug(label)).filter(Boolean);
    const submitted = await getSubmittedVendorSlugs(storeNumber, dateKey);
    const sent = await getMmxSentVendorSlugs(storeNumber, dateKey);

    for (const slug of pendingSlugs) {
        if (!submitted.includes(slug)) {
            console.log(
                `[Macromatix] Store ${storeNumber}: not marking day complete - ${slug} not submitted yet (pending: ${pendingLabels.join(', ')})`
            );
            return false;
        }
        if (!sent.includes(slug)) {
            console.log(
                `[Macromatix] Store ${storeNumber}: not marking day complete - ${slug} not sent to MMX yet`
            );
            return false;
        }
    }
    return true;
}

/**
 * After confirmed empty scheduled orders for a store today: drop ISE and temp downloads,
 * keep SOH/SOO for stock-levels download, and clear any open MMX count browser session.
 */
async function runStoreOrdersCompleteCleanup(storeNumber, dateKey) {
    const label = String(storeNumber || '').trim() || '(default)';
    const markComplete = await shouldMarkStoreOrdersComplete(storeNumber, dateKey);

    if (markComplete) {
        try {
            const { markStoreOrdersComplete } = require('./orderingDayState');
            markStoreOrdersComplete(storeNumber, dateKey, 'orders_pipeline');
        } catch (err) {
            console.warn(`[Macromatix] Store ${label} ordering day mark-complete failed:`, err.message);
        }
    } else {
        console.log(
            `[Macromatix] Store ${label}: partial orders done for ${dateKey} - keeping reports and active ordering day`
        );
    }

    const reportFiles = markComplete ? deleteStoreReportFiles(storeNumber) : 0;
    const tempDirs = markComplete ? deleteTempReportDownloadDirs() : 0;
    await destroySessionsForStore(storeNumber, markComplete ? 'orders-complete' : 'orders-partial');

    const summary = {
        storeNumber: label,
        dateKey,
        markedComplete: markComplete,
        reportFilesRemoved: reportFiles,
        tempDownloadDirsRemoved: tempDirs,
    };

    console.log(
        `[Macromatix] Store ${label} orders ${markComplete ? 'complete' : 'partial'} for ${dateKey}` +
            (markComplete
                ? ` - cleanup: ${reportFiles} report file(s), ${tempDirs} temp download folder(s), MMX count session cleared`
                : ' - reports kept for remaining vendors')
    );

    return summary;
}

module.exports = {
    runStoreOrdersCompleteCleanup,
    shouldMarkStoreOrdersComplete,
    deleteStoreReportFiles,
    deleteTempReportDownloadDirs,
};
