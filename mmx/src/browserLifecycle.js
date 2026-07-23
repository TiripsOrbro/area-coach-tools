/** Track and tear down Puppeteer/Chromium browsers (prevents orphan processes on Pi). */

const CLOSE_TIMEOUT_MS = Number(process.env.BROWSER_CLOSE_TIMEOUT_MS || 8000);
const KILL_GRACE_MS = Number(process.env.BROWSER_KILL_GRACE_MS || 2000);

/** @type {Map<import('puppeteer').Browser, string>} */
const trackedBrowsers = new Map();

function trackBrowser(browser, label = 'unknown') {
    if (!browser) return;
    trackedBrowsers.set(browser, String(label || 'unknown'));
}

function untrackBrowser(browser) {
    if (!browser) return;
    trackedBrowsers.delete(browser);
}

function getTrackedBrowserCount() {
    return trackedBrowsers.size;
}

async function closePagesAndContexts(browser) {
    try {
        const contexts =
            typeof browser.browserContexts === 'function' ? browser.browserContexts() : [];
        for (const ctx of contexts) {
            const pages = await ctx.pages().catch(() => []);
            for (const page of pages) {
                await page.close().catch(() => {});
            }
        }
    } catch {
        /* ignore */
    }
}

function withTimeout(promise, ms, label) {
    return Promise.race([
        promise,
        new Promise((_, reject) => {
            setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
        }),
    ]);
}

async function killBrowserProcess(browser, label) {
    try {
        const proc = typeof browser.process === 'function' ? browser.process() : null;
        if (!proc?.pid) return;
        try {
            process.kill(proc.pid, 'SIGTERM');
        } catch {
            /* ignore */
        }
        await new Promise((resolve) => setTimeout(resolve, KILL_GRACE_MS));
        try {
            process.kill(proc.pid, 0);
            process.kill(proc.pid, 'SIGKILL');
            console.warn(`[Browser] SIGKILL after failed close (${label}) pid=${proc.pid}`);
        } catch {
            /* already dead */
        }
    } catch (err) {
        console.warn(`[Browser] Kill fallback failed (${label}):`, err.message);
    }
}

async function closeBrowserQuietly(browser, label) {
    if (!browser) return;
    const tag = label || trackedBrowsers.get(browser) || 'unknown';
    try {
        await closePagesAndContexts(browser);
        await withTimeout(browser.close(), CLOSE_TIMEOUT_MS, `browser.close(${tag})`);
    } catch (error) {
        console.warn(`[Browser] Close failed during ${tag}:`, error.message);
        await killBrowserProcess(browser, tag);
    } finally {
        untrackBrowser(browser);
    }
}

async function closeAllTrackedBrowsers(reason) {
    const tag = reason || 'close-all';
    const browsers = [...trackedBrowsers.keys()];
    if (!browsers.length) return;
    console.log(`[Browser] Closing ${browsers.length} tracked browser(s) - ${tag}`);
    await Promise.all(
        browsers.map((browser) =>
            closeBrowserQuietly(browser, `${tag}:${trackedBrowsers.get(browser) || 'unknown'}`)
        )
    );
}

module.exports = {
    trackBrowser,
    untrackBrowser,
    getTrackedBrowserCount,
    closeBrowserQuietly,
    closeAllTrackedBrowsers,
};
