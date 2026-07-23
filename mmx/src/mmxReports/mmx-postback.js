/**
 * ASP.NET / Macromatix postback helpers - prefer response + element waits over fixed sleeps.
 */

const DEFAULT_TIMEOUT_MS = Number(process.env.MMX_POSTBACK_TIMEOUT_MS || 15000);
const DEFAULT_QUIET_MS = Number(process.env.MMX_DOCUMENT_QUIET_MS || 350);

function defaultUrlTest(res) {
    const u = res.url() || '';
    return /macromatix/i.test(u) && res.status() < 500;
}

function stockCountUrlTest(res) {
    const u = res.url() || '';
    return /stockcount|inventorycount/i.test(u) && res.status() < 500;
}

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

/**
 * Wait until the page can evaluate and stays complete for quietMs.
 * Survives mid-wait ASP.NET navigations that destroy the execution context.
 */
async function waitForDocumentStable(page, options = {}) {
    const timeoutMs = options.timeoutMs ?? Math.max(DEFAULT_TIMEOUT_MS, 20000);
    const quietMs = options.quietMs ?? DEFAULT_QUIET_MS;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        try {
            await page.waitForFunction(() => document.readyState === 'complete', {
                timeout: Math.min(8000, remaining),
                polling: 100,
            });

            const snap = await page.evaluate(() => ({
                href: location.href,
                ready: document.readyState,
            }));

            await sleep(page, Math.min(quietMs, Math.max(0, deadline - Date.now())));

            const snap2 = await page.evaluate(() => ({
                href: location.href,
                ready: document.readyState,
            }));

            if (snap2.ready === 'complete' && snap.href === snap2.href) {
                return true;
            }
        } catch (e) {
            if (isTargetDeadError(e)) throw e;
            if (!isContextDestroyedError(e) && !/Protocol error|Timeout/i.test(String(e && e.message ? e.message : e))) {
                // Unexpected — brief pause then retry until deadline
            }
            await sleep(page, 200);
        }
    }
    return false;
}

async function waitForAspPostback(page, options = {}) {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const urlTest = options.urlTest ?? defaultUrlTest;
    const quietMs = options.quietMs ?? DEFAULT_QUIET_MS;

    await Promise.race([
        page.waitForResponse((res) => urlTest(res), { timeout: timeoutMs }).catch(() => null),
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: timeoutMs }).catch(() => null),
        sleep(page, Math.min(timeoutMs, 2500)),
    ]);

    await waitForDocumentStable(page, {
        timeoutMs: Math.max(timeoutMs, 12000),
        quietMs,
    });

    if (options.elementId) {
        await waitForVisibleElement(page, options.elementId, timeoutMs);
    }
}

async function waitForVisibleElement(page, elementId, timeoutMs = DEFAULT_TIMEOUT_MS) {
    await page
        .waitForFunction(
            (id) => {
                const el = document.getElementById(id);
                return el && el.offsetParent !== null;
            },
            { timeout: timeoutMs, polling: 100 },
            elementId
        )
        .catch(() => {});
}

async function waitForEnabledButton(page, buttonId, timeoutMs = DEFAULT_TIMEOUT_MS) {
    await page
        .waitForFunction(
            (id) => {
                const el = document.getElementById(id);
                return el && !el.disabled && el.offsetParent !== null;
            },
            { timeout: timeoutMs, polling: 100 },
            buttonId
        )
        .catch(() => {});
}

/**
 * Attach response/nav waiters BEFORE the click/change that triggers ASP.NET postback.
 */
async function clickAndWaitForPostback(page, clickAction, options = {}) {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const urlTest = options.urlTest ?? defaultUrlTest;
    const skipNavigationWait = Boolean(options.skipNavigationWait);

    const waiters = [
        page.waitForResponse((res) => urlTest(res), { timeout: timeoutMs }).catch(() => null),
        clickAction(),
    ];
    if (!skipNavigationWait) {
        waiters.splice(
            1,
            0,
            page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: timeoutMs }).catch(() => null)
        );
    }
    await Promise.all(waiters);

    if (!options.skipPostbackWait) {
        await waitForDocumentStable(page, {
            timeoutMs: Math.max(timeoutMs, 12000),
            quietMs: options.quietMs ?? DEFAULT_QUIET_MS,
        });
        if (options.elementId) {
            await waitForVisibleElement(page, options.elementId, timeoutMs);
        }
    }
}

async function waitForReportFormatControls(page, timeoutMs = 20000) {
    await page
        .waitForFunction(
            () => {
                for (const sel of document.querySelectorAll('select')) {
                    if (Array.from(sel.options).some((o) => /excel|csv|comma|format/i.test(o.textContent || ''))) {
                        return true;
                    }
                }
                return document.querySelectorAll('input[type="radio"]').length > 0;
            },
            { timeout: timeoutMs, polling: 100 }
        )
        .catch(() => {});
}

async function waitForScmReportList(page, timeoutMs = Number(process.env.MMX_REPORT_LIST_WAIT_MS || 8000)) {
    await page
        .waitForFunction(
            () => {
                for (const sel of document.querySelectorAll('select')) {
                    const label = ((sel.closest('tr, td') || sel).innerText || '').toLowerCase();
                    const hasScm = Array.from(sel.options).some((o) =>
                        /scm|items on hand|items on order/i.test(o.textContent || '')
                    );
                    if (label.includes('report') || hasScm) {
                        if (hasScm) return true;
                    }
                }
                return false;
            },
            { timeout: timeoutMs, polling: 100 }
        )
        .catch(() => {});
}

async function waitForReportSelectionPage(page, timeoutMs = 30000) {
    await page
        .waitForFunction(
            () => {
                for (const sel of document.querySelectorAll('select')) {
                    const label = ((sel.closest('tr, td') || sel).innerText || '').toLowerCase();
                    if (label.includes('group')) return true;
                    if (Array.from(sel.options).some((o) => /supply chain/i.test(o.textContent || ''))) {
                        return true;
                    }
                }
                return false;
            },
            { timeout: timeoutMs, polling: 100 }
        )
        .catch(() => {});
}

module.exports = {
    DEFAULT_TIMEOUT_MS,
    defaultUrlTest,
    stockCountUrlTest,
    isContextDestroyedError,
    isTargetDeadError,
    waitForDocumentStable,
    waitForAspPostback,
    waitForVisibleElement,
    waitForEnabledButton,
    clickAndWaitForPostback,
    waitForReportFormatControls,
    waitForScmReportList,
    waitForReportSelectionPage,
};
