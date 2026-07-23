/**
 * Puppeteer entrypoint with shims for APIs removed after v10 (e.g. page.waitForTimeout).
 */
const puppeteer = require('puppeteer');

function attachWaitForTimeout(page) {
    if (!page || typeof page.waitForTimeout === 'function') return page;
    page.waitForTimeout = function waitForTimeout(ms) {
        return new Promise((resolve) => setTimeout(resolve, Number(ms) || 0));
    };
    return page;
}

function patchBrowser(browser) {
    if (!browser || browser.__areaCoachPatched) return browser;
    browser.__areaCoachPatched = true;

    const origNewPage = browser.newPage.bind(browser);
    browser.newPage = async function newPage(...args) {
        return attachWaitForTimeout(await origNewPage(...args));
    };

    if (typeof browser.createBrowserContext === 'function') {
        const origCtx = browser.createBrowserContext.bind(browser);
        browser.createBrowserContext = async function createBrowserContext(...args) {
            const ctx = await origCtx(...args);
            return patchContext(ctx);
        };
    }

    if (typeof browser.createIncognitoBrowserContext === 'function') {
        const origIncognito = browser.createIncognitoBrowserContext.bind(browser);
        browser.createIncognitoBrowserContext = async function createIncognitoBrowserContext(...args) {
            const ctx = await origIncognito(...args);
            return patchContext(ctx);
        };
    }

    const origPages = browser.pages.bind(browser);
    browser.pages = async function pages(...args) {
        const list = await origPages(...args);
        return list.map(attachWaitForTimeout);
    };

    return browser;
}

function patchContext(ctx) {
    if (!ctx || ctx.__areaCoachPatched) return ctx;
    ctx.__areaCoachPatched = true;
    const origNewPage = ctx.newPage.bind(ctx);
    ctx.newPage = async function newPage(...args) {
        return attachWaitForTimeout(await origNewPage(...args));
    };
    return ctx;
}

const origLaunch = puppeteer.launch.bind(puppeteer);
puppeteer.launch = async function launch(...args) {
    return patchBrowser(await origLaunch(...args));
};

if (typeof puppeteer.connect === 'function') {
    const origConnect = puppeteer.connect.bind(puppeteer);
    puppeteer.connect = async function connect(...args) {
        return patchBrowser(await origConnect(...args));
    };
}

module.exports = puppeteer;
