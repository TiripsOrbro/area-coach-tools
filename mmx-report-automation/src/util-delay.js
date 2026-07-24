function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Puppeteer v22+ removed page.waitForTimeout; keep older call sites working. */
function patchPageWaitForTimeout(page) {
    if (page && typeof page.waitForTimeout !== 'function') {
        page.waitForTimeout = delay;
    }
    return page;
}

module.exports = { delay, patchPageWaitForTimeout };
