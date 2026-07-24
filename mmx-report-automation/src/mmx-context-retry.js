/** Retry after ASP.NET navigation destroys Puppeteer execution context. */

function isContextDestroyedError(err) {
    const msg = String(err && err.message ? err.message : err);
    return /Execution context was destroyed|most likely because of a navigation|Cannot find context/i.test(msg);
}

function isTargetDeadError(err) {
    const msg = String(err && err.message ? err.message : err);
    return /Target closed|Session closed|browser has been closed|Connection closed/i.test(msg);
}

async function sleep(page, ms) {
    if (ms <= 0) return;
    if (page && typeof page.waitForTimeout === 'function') {
        await page.waitForTimeout(ms);
        return;
    }
    await new Promise((r) => setTimeout(r, ms));
}

async function waitForDocumentStable(page, options = {}) {
    const timeoutMs = options.timeoutMs ?? 25000;
    const quietMs = options.quietMs ?? 500;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        try {
            await page.waitForFunction(() => document.readyState === 'complete', {
                timeout: Math.min(8000, remaining),
                polling: 100,
            });
            const href = await page.evaluate(() => location.href);
            await sleep(page, Math.min(quietMs, Math.max(0, deadline - Date.now())));
            const href2 = await page.evaluate(() => ({
                href: location.href,
                ready: document.readyState,
            }));
            if (href2.ready === 'complete' && href2.href === href) {
                return true;
            }
        } catch (e) {
            if (isTargetDeadError(e)) throw e;
            await sleep(page, 200);
        }
    }
    return false;
}

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
            // Do NOT waitForNavigation here — the destroying nav often already finished.
            await waitForDocumentStable(page, { timeoutMs: 25000, quietMs: 500 }).catch(() => {});
            await sleep(page, backoffMs[attempt]);
        }
    }
    throw lastErr;
}

module.exports = { withPageContextRetry };
