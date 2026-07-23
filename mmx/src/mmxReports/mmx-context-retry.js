const {
    waitForDocumentStable,
    isContextDestroyedError,
    isTargetDeadError,
} = require('./mmx-postback');

/** Retry after ASP.NET navigation destroys Puppeteer execution context. */
async function withPageContextRetry(page, label, fn) {
    const backoffMs = [800, 1800, 3500, 6000];
    let lastErr;
    for (let attempt = 0; attempt <= backoffMs.length; attempt++) {
        try {
            return await fn();
        } catch (e) {
            lastErr = e;
            if (isTargetDeadError(e)) {
                throw e;
            }
            const msg = String(e && e.message ? e.message : e);
            const retriable =
                isContextDestroyedError(e) || /Protocol error|most likely because of a navigation/i.test(msg);
            if (!retriable || attempt === backoffMs.length) {
                throw e;
            }
            console.warn(`[MMX] ${label}: context lost; retry ${attempt + 2}/${backoffMs.length + 1}`);
            // Do NOT waitForNavigation here — the destroying nav often already finished,
            // so that waiter hangs for the *next* nav and burns the settle window.
            await waitForDocumentStable(page, { timeoutMs: 25000, quietMs: 500 }).catch(() => {});
            if (typeof page.waitForTimeout === 'function') {
                await page.waitForTimeout(backoffMs[attempt]);
            } else {
                await new Promise((r) => setTimeout(r, backoffMs[attempt]));
            }
        }
    }
    throw lastErr;
}

module.exports = { withPageContextRetry };
