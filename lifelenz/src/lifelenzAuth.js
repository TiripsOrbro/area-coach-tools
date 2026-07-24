const puppeteer = require('../../src/puppeteerCompat');
const { pasteIntoSelector } = require('./lifelenzInput');

const { getPuppeteerLaunchOptions } = require('../../mmx/src/macromatixScraper');
const { trackBrowser, closeBrowserQuietly } = require('../../mmx/src/browserLifecycle');

const LIFELENZ_ADMIN_URL = 'https://admin.lifelenz.com/au01/';
const LIFELENZ_BUSINESS_EXPLORER_URL = /admin\.lifelenz\.com\/au\d+\/business-explorer/i;
const LOGIN_WAIT_MS = 60000;
const NAV_WAIT_MS = 60000;
const BUSINESS_PICKER_WAIT_MS = 90000;
const LAUNCH_TIMEOUT_MS = Number(process.env.LIFELENZ_LAUNCH_TIMEOUT_MS || 45000);
/** Area coach scope in the LifeLenz location tree (e.g. T22). Override with LIFELENZ_AREA. */
const DEFAULT_LIFELENZ_AREA = 'T22';

function resolveLifeLenzArea(override) {
    const raw =
        override != null && String(override).trim()
            ? String(override).trim()
            : String(process.env.LIFELENZ_AREA || DEFAULT_LIFELENZ_AREA).trim();
    return raw || DEFAULT_LIFELENZ_AREA;
}

function resolveLifeLenzHeadless(overrides = {}) {
    if (overrides.headless === false) return false;
    if (overrides.headless === true) return true;
    const raw =
        process.env.LIFELENZ_SCRAPER_HEADLESS ??
        process.env.FORECAST_SCRAPER_HEADLESS ??
        process.env.SCRAPER_HEADLESS;
    if (raw === undefined || raw === '') return true;
    return !/^(0|false|no|off)$/i.test(String(raw).trim());
}

function getLifeLenzLaunchOptions(overrides = {}) {
    const headless = resolveLifeLenzHeadless(overrides);
    return getPuppeteerLaunchOptions({ ...overrides, headless, skipSlowMo: overrides.skipSlowMo !== false });
}

function cleanStoreDisplayName(storeNumber, rawName) {
    let name = String(rawName || '').replace(/\s+/g, ' ').trim();
    // LifeLenz glues schedule tokens onto the name, e.g. "South3806Schedule4".
    name = name.replace(new RegExp(`${storeNumber}\\s*schedule\\w*`, 'gi'), '').trim();
    // Trailing trading hours are cosmetic in the picker, e.g. "8:00am - 4:00pm (8hrs)".
    name = name.replace(
        /\s+\d{1,2}(:\d{2})?\s*(am|pm)?\s*-\s*\d{1,2}(:\d{2})?\s*(am|pm)?(\s*\([^)]*\))?/gi,
        ''
    ).trim();
    name = name.replace(new RegExp(`\\b${storeNumber}\\b\\s*$`), '').trim();
    return name.replace(/\s{2,}/g, ' ').trim();
}

function parseStoreLabel(label) {
    const text = String(label || '').replace(/\s+/g, ' ').trim();
    const match = text.match(/^(\d{4})\s*-\s*(.+)$/);
    if (!match) return null;
    const storeNumber = match[1];
    const displayName = cleanStoreDisplayName(storeNumber, match[2]);
    if (!displayName) return null;
    return {
        storeNumber,
        label: `${storeNumber} - ${displayName}`,
        rawLabel: text,
    };
}

function dedupeStores(stores) {
    const seen = new Set();
    const out = [];
    for (const row of stores || []) {
        const key = String(row.storeNumber || '');
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(row);
    }
    out.sort((a, b) => Number(a.storeNumber) - Number(b.storeNumber));
    return out;
}

async function prepareLifeLenzPage(page) {
    await page.setViewport({ width: 1400, height: 900 });
    // LifeLenz admin is an Aurelia SPA - do not use Macromatix resource blocking here.
}

async function waitForSelectorSafe(page, selector, timeout = LOGIN_WAIT_MS) {
    try {
        await page.waitForSelector(selector, { timeout, visible: true });
        return true;
    } catch {
        return false;
    }
}

async function safeEvaluate(page, fn, ...args) {
    try {
        return await page.evaluate(fn, ...args);
    } catch (err) {
        if (/context was destroyed|Execution context|Cannot find context/i.test(err.message || '')) {
            return null;
        }
        throw err;
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

async function launchLifeLenzBrowser(options = {}) {
    return withTimeout(
        puppeteer.launch(getLifeLenzLaunchOptions(options)),
        LAUNCH_TIMEOUT_MS,
        'LifeLenz browser launch'
    );
}

async function isLifeLenzShell(page) {
    const result = await safeEvaluate(page, () =>
        Boolean(document.querySelector('[data-testid="lz-dropdown-trigger-analytics"]'))
    );
    return result === true;
}

async function isOnBusinessExplorer(page) {
    const result = await safeEvaluate(page, () => /business-explorer/i.test(location.href || ''));
    return result === true;
}

async function waitForBusinessExplorerUrl(page, timeoutMs = BUSINESS_PICKER_WAIT_MS) {
    await page.waitForFunction(
        () => /business-explorer/i.test(location.href || ''),
        { timeout: timeoutMs, polling: 500 }
    );
}

/** After login submit - Business Explorer picker or store shell (remembered session). */
async function waitForPostLoginLanding(page, timeoutMs = BUSINESS_PICKER_WAIT_MS) {
    await page.waitForFunction(
        () => {
            const href = location.href || '';
            if (/business-explorer/i.test(href)) return true;
            if (document.querySelector('[data-testid="lz-dropdown-trigger-analytics"]')) return true;
            if (document.querySelector('[data-test="view-business-taco-bell-col"]')) return true;
            return false;
        },
        { timeout: timeoutMs, polling: 500 }
    );
}

async function resolvePostLoginState(page) {
    if (await isLifeLenzShell(page)) return 'shell';
    if (await isOnBusinessExplorer(page)) return 'picker';
    return 'unknown';
}

async function waitForBusinessExplorerTile(page, timeoutMs = BUSINESS_PICKER_WAIT_MS) {
    await page.waitForFunction(
        () => {
            if (document.querySelector('[data-test="view-business-taco-bell-col"]')) return true;
            if (document.querySelector('a[au-target-id="320"]')) return true;
            const bodyText = document.body?.innerText || '';
            return /taco bell\s*-\s*col/i.test(bodyText) && /view/i.test(bodyText);
        },
        { timeout: timeoutMs, polling: 500 }
    );
}

/** Click Taco Bell - COL on /business-explorer (Aurelia click.delegate needs a real click). */
async function selectBusinessOnExplorerPage(page) {
    if (await isLifeLenzShell(page)) return true;

    await waitForBusinessExplorerUrl(page);
    if (await isLifeLenzShell(page)) return true;

    const onExplorer = await isOnBusinessExplorer(page);
    if (!onExplorer) {
        throw new Error('Expected LifeLenz Business Explorer page after login but URL was: ' + page.url());
    }

    await waitForBusinessExplorerTile(page);

    const viewSelectors = [
        '[data-test="view-business-taco-bell-col"]',
        'a[au-target-id="320"]',
    ];

    for (const selector of viewSelectors) {
        const handle = await page.$(selector);
        if (!handle) continue;

        await page.evaluate((sel) => {
            const link = document.querySelector(sel);
            if (!link) return;
            link.scrollIntoView({ block: 'center', inline: 'center' });
            link.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
            link.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
            link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        }, selector);

        try {
            await waitForLifeLenzShell(page);
            return true;
        } catch {
            /* try next selector */
        }
    }

    const clicked = await page.evaluate(() => {
        for (const link of document.querySelectorAll('a.au-target, a.btn, a')) {
            const text = (link.textContent || '').replace(/\s+/g, ' ').trim();
            const test = link.getAttribute('data-test') || '';
            const tileText = link.closest('div, li, section, article')?.innerText || '';
            if (test === 'view-business-taco-bell-col') {
                link.scrollIntoView({ block: 'center', inline: 'center' });
                link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
                return true;
            }
            if (/^view$/i.test(text) && /taco bell\s*-\s*col/i.test(tileText)) {
                link.scrollIntoView({ block: 'center', inline: 'center' });
                link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
                return true;
            }
        }
        return false;
    });

    if (!clicked) {
        throw new Error(
            'Could not click Taco Bell - COL on Business Explorer (https://admin.lifelenz.com/au02/business-explorer).'
        );
    }

    await waitForLifeLenzShell(page);
    return true;
}

async function fillLifeLenzLogin(page, email, password) {
    // networkidle2 is unreliable on the Aurelia SPA (background polling can
    // keep the network busy forever); wait for a concrete landing state instead.
    await page.goto(LIFELENZ_ADMIN_URL, { waitUntil: 'domcontentloaded', timeout: LOGIN_WAIT_MS });
    await page
        .waitForFunction(
            () =>
                Boolean(document.querySelector('#email')) ||
                Boolean(document.querySelector('[data-testid="lz-dropdown-trigger-analytics"]')) ||
                /business-explorer/i.test(location.href || ''),
            { timeout: LOGIN_WAIT_MS, polling: 500 }
        )
        .catch(() => null);
    const hasEmail = await waitForSelectorSafe(page, '#email', 8000);
    if (!hasEmail) {
        if (await isLifeLenzShell(page)) return;
        if (await isOnBusinessExplorer(page)) return;
        throw new Error('LifeLenz login page did not load.');
    }
    await pasteIntoSelector(page, '#email', String(email || '').trim(), 8000);
    await pasteIntoSelector(page, '#password', String(password || ''), 8000);
    await page.click('button[type="submit"]');
    try {
        await waitForPostLoginLanding(page, LOGIN_WAIT_MS);
    } catch (err) {
        const stillLogin = await page.$('#email').catch(() => null);
        let href = '';
        try {
            href = String(page.url() || '');
        } catch (_) {
            href = '';
        }
        if (stillLogin) {
            const loginError = await page
                .evaluate(() => {
                    const el = document.querySelector('[role="alert"], .text-danger, .error, p.text-red');
                    return el ? String(el.textContent || '').trim() : '';
                })
                .catch(() => '');
            throw new Error(
                loginError ||
                    `LifeLenz login timed out after ${Math.round(LOGIN_WAIT_MS / 1000)}s (still on login page). Check email/password.`
            );
        }
        throw new Error(
            `LifeLenz login timed out after ${Math.round(LOGIN_WAIT_MS / 1000)}s waiting for Business Explorer / store shell (url: ${href}).`
        );
    }
}

async function selectTacoBellColBusiness(page) {
    return selectBusinessOnExplorerPage(page);
}

async function waitForLifeLenzShell(page) {
    await page.waitForFunction(
        () => {
            const el = document.querySelector('[data-testid="lz-dropdown-trigger-analytics"]');
            if (!el) return false;
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
        },
        { timeout: NAV_WAIT_MS, polling: 100 }
    );
}

async function readStoreLabelsFromBodyText(page) {
    return page.evaluate(() => {
        const text = document.body?.innerText || '';
        const matches = text.match(/\d{4}\s*-\s*[^\n\r]+/g) || [];
        return [...new Set(matches.map((row) => row.replace(/\s+/g, ' ').trim()))];
    });
}

async function readVisibleStoreOptionLabels(page) {
    return page.evaluate(() => {
        const found = [];
        for (const el of document.querySelectorAll('[role="option"], [role="menuitem"]')) {
            const rect = el.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) continue;
            const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
            if (/^\d{4}\s*-\s*\S/.test(text)) found.push(text);
        }
        return found;
    });
}

async function pollAuthUntil(checkFn, { timeoutMs = 5000, pollMs = 100, label = 'condition' } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const result = await checkFn();
            if (result) return result;
        } catch {
            /* transient evaluate errors during SPA updates */
        }
        await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    return null;
}

async function waitForVisibleStoreDropdownOptions(page, timeoutMs = 5000) {
    return pollAuthUntil(
        async () => {
            const labels = await readVisibleStoreOptionLabels(page);
            return labels.length > 0 ? labels : null;
        },
        { timeoutMs, pollMs: 100, label: 'store dropdown options' }
    );
}

async function countVisibleStoreLabels(page) {
    const labels = await readVisibleStoreOptionLabels(page);
    if (labels.length) return labels.length;
    return page.evaluate(() => {
        let count = 0;
        for (const el of document.querySelectorAll('button, a, [role="option"], [role="menuitem"], li, div')) {
            const r = el.getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0) continue;
            const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
            if (/^\d{4}\s*-\s*\S/.test(text) && text.length < 120) count += 1;
        }
        return count;
    });
}

/**
 * Some LifeLenz accounts show a location tree (Taco Bell - COL → T01/T02/T21/T22/…)
 * before store rows. Select the coach area so stores become visible.
 */
async function selectLifeLenzArea(page, areaCode, options = {}) {
    const area = resolveLifeLenzArea(areaCode);
    if (!area) return false;

    const storeCount = await countVisibleStoreLabels(page);
    if (storeCount >= 1) {
        const areaAlreadyActive = await page.evaluate((code) => {
            const nodes = document.querySelectorAll(
                '[aria-selected="true"], [aria-current="true"], .active, [class*="selected"], [class*="bg-"]'
            );
            for (const el of nodes) {
                const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
                if (text === code || new RegExp(`^${code}\\b`, 'i').test(text)) return true;
            }
            return false;
        }, area);
        if (areaAlreadyActive || storeCount >= 2) return true;
    }

    const clicked = await page.evaluate((code) => {
        const escaped = String(code).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const exact = new RegExp(`^\\s*${escaped}\\s*$`, 'i');
        const candidates = [
            ...document.querySelectorAll('[role="treeitem"]'),
            ...document.querySelectorAll('[role="option"]'),
            ...document.querySelectorAll('[role="menuitem"]'),
            ...document.querySelectorAll('button, a, li, div, span'),
        ];

        const scoreClickable = (el) => {
            const r = el.getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0 || r.width > 420) return -1;
            const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
            const ownText = [...el.childNodes]
                .filter((n) => n.nodeType === Node.TEXT_NODE)
                .map((n) => n.textContent || '')
                .join('')
                .replace(/\s+/g, ' ')
                .trim();
            const label = ownText || text;
            if (!(exact.test(label) || label === code)) return -1;
            // Prefer left-rail tree items (area list) over the right-pane header.
            let score = 100;
            if (r.left < window.innerWidth * 0.45) score += 40;
            if (label.length <= 6) score += 20;
            if (el.getAttribute('role') === 'treeitem') score += 30;
            score -= Math.abs(r.width - 80) / 20;
            return score;
        };

        let best = null;
        let bestScore = -1;
        for (const el of candidates) {
            const score = scoreClickable(el);
            if (score > bestScore) {
                best = el;
                bestScore = score;
            }
        }
        if (!best) return false;
        best.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        best.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
        best.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
        best.click();
        return true;
    }, area);

    if (!clicked) {
        if (options.required) {
            throw new Error(`Could not select LifeLenz area ${area} in the location picker.`);
        }
        return false;
    }

    const stores = await pollAuthUntil(
        async () => {
            const n = await countVisibleStoreLabels(page);
            return n >= 1 ? n : null;
        },
        { timeoutMs: options.timeoutMs || 10000, pollMs: 150, label: `area ${area} stores` }
    );
    if (!stores && options.required) {
        throw new Error(`Selected LifeLenz area ${area} but no stores appeared.`);
    }
    return Boolean(stores);
}

async function collectStoreLabelsFromOpenDropdown(page) {
    const labels = new Set();

    const addLabels = async () => {
        for (const label of await readVisibleStoreOptionLabels(page)) {
            labels.add(label);
        }
        for (const label of await readStoreLabelsFromBodyText(page)) {
            labels.add(label);
        }
    };

    await addLabels();

    for (let pass = 0; pass < 24; pass += 1) {
        const beforeCount = labels.size;
        const atEnd = await page.evaluate(() => {
            const container =
                document.querySelector('[role="listbox"]') ||
                document.querySelector('[role="menu"]') ||
                document.querySelector('[data-radix-popper-content-wrapper]') ||
                document.querySelector('[role="option"]')?.closest('ul, div');
            if (!container) return true;
            const before = container.scrollTop;
            container.scrollTop += 320;
            return (
                container.scrollTop === before ||
                container.scrollTop + container.clientHeight >= container.scrollHeight - 2
            );
        });
        await pollAuthUntil(async () => {
            await addLabels();
            return labels.size > beforeCount ? true : null;
        }, { timeoutMs: 1500, pollMs: 80, label: 'dropdown scroll labels' }).catch(() => null);
        if (atEnd) break;
    }

    return [...labels];
}

async function extractStoreLabelsFromPage(page) {
    const labels = await page.evaluate(() => {
        const found = [];
        const push = (text) => {
            const t = String(text || '').replace(/\s+/g, ' ').trim();
            if (/^\d{4}\s*-\s*\S/.test(t) && t.length < 120) found.push(t);
        };

        for (const el of document.querySelectorAll('[role="option"], [role="menuitem"]')) {
            push(el.textContent);
        }

        for (const el of document.querySelectorAll('div.max-w-60, div.truncate')) {
            push(el.textContent);
        }

        return [...new Set(found)];
    });

    return dedupeStores(labels.map(parseStoreLabel).filter(Boolean));
}

async function openStoreDropdown(page) {
    const triggers = [
        'button[aria-haspopup="listbox"]',
        'button[aria-haspopup="menu"]',
        '[data-slot="trigger"]',
        'div.max-w-60.min-w-20',
        'div.max-w-60',
    ];

    for (const selector of triggers) {
        await page.keyboard.press('Escape').catch(() => null);
        await pollAuthUntil(
            () =>
                page.evaluate(() => {
                    const open = document.querySelector(
                        '[role="listbox"], [role="menu"], [data-radix-popper-content-wrapper]'
                    );
                    if (!open) return true;
                    const r = open.getBoundingClientRect();
                    return r.width <= 0 || r.height <= 0;
                }),
            { timeoutMs: 1500, pollMs: 80, label: 'dropdown closed' }
        ).catch(() => null);
        const el = await page.$(selector);
        if (!el) continue;
        await el.click().catch(() => null);
        // New accounts: Area (e.g. T22) must be selected before store rows show.
        await selectLifeLenzArea(page, resolveLifeLenzArea(), { required: false }).catch(() => false);
        await waitForVisibleStoreDropdownOptions(page, 5000);
        const labels = await collectStoreLabelsFromOpenDropdown(page);
        // Stop at the first trigger that opens a real store list — do not
        // iterate all selectors (that visibly opens the picker 4–5 times).
        if (labels.length > 0) return labels;
    }

    return [];
}

async function listAccessibleStores(page) {
    await waitForLifeLenzShell(page);
    const dropdownLabels = await openStoreDropdown(page);
    await page.keyboard.press('Escape').catch(() => null);
    await pollAuthUntil(
        () =>
            page.evaluate(() => {
                const open = document.querySelector(
                    '[role="listbox"], [role="menu"], [data-radix-popper-content-wrapper]'
                );
                if (!open) return true;
                const r = open.getBoundingClientRect();
                return r.width <= 0 || r.height <= 0;
            }),
        { timeoutMs: 1500, pollMs: 80, label: 'dropdown closed' }
    ).catch(() => null);

    const fromDropdown = dedupeStores(dropdownLabels.map(parseStoreLabel).filter(Boolean));
    const fromPage = await extractStoreLabelsFromPage(page);
    return dedupeStores([...fromDropdown, ...fromPage]);
}

async function performLifeLenzLogin(page, email, password) {
    await fillLifeLenzLogin(page, email, password);

    const stillOnLogin = await page.$('#email');
    if (stillOnLogin) {
        const loginError = await page
            .evaluate(() => {
                const el = document.querySelector('[role="alert"], .text-danger, .error, p.text-red');
                return el ? String(el.textContent || '').trim() : '';
            })
            .catch(() => '');
        throw new Error(loginError || 'LifeLenz login failed. Check email and password.');
    }

    const postLoginState = await resolvePostLoginState(page);

    if (postLoginState === 'picker') {
        await selectBusinessOnExplorerPage(page);
    } else if (postLoginState === 'unknown' && (await isOnBusinessExplorer(page))) {
        await selectBusinessOnExplorerPage(page);
    } else if (postLoginState !== 'shell' && !(await isLifeLenzShell(page))) {
        throw new Error('LifeLenz login did not reach Business Explorer or store shell.');
    }

    await waitForLifeLenzShell(page);
    return listAccessibleStores(page);
}

async function createAuthenticatedLifeLenzSession(email, password, options = {}) {
    const lifelenzEmail = String(email || '').trim();
    const lifelenzPassword = String(password || '');
    if (!lifelenzEmail || !lifelenzPassword) {
        throw new Error('LifeLenz email and password are required.');
    }

    const browser = await launchLifeLenzBrowser(options);
    trackBrowser(browser, 'lifelenz-session');
    const page = await browser.newPage();
    await prepareLifeLenzPage(page);

    // One retry: transient slow renders of the login form or Business Explorer
    // tile are the most common cold-start failure, and login restarts cleanly.
    let stores;
    try {
        stores = await performLifeLenzLogin(page, lifelenzEmail, lifelenzPassword);
    } catch (firstErr) {
        if (/login failed|check email and password/i.test(firstErr.message || '')) {
            await closeBrowserQuietly(browser, 'lifelenz-session');
            throw firstErr;
        }
        console.warn(`[LifeLenz] Login attempt failed (${firstErr.message}); retrying once…`);
        try {
            stores = await performLifeLenzLogin(page, lifelenzEmail, lifelenzPassword);
        } catch (secondErr) {
            await closeBrowserQuietly(browser, 'lifelenz-session');
            throw secondErr;
        }
    }
    return { browser, page, stores };
}

async function verifyLifeLenzLogin(email, password, options = {}) {
    const lifelenzEmail = String(email || '').trim();
    const lifelenzPassword = String(password || '');
    if (!lifelenzEmail || !lifelenzPassword) {
        return { ok: false, error: 'LifeLenz email and password are required.' };
    }

    let browser;
    try {
        browser = await launchLifeLenzBrowser({ headless: true, skipSlowMo: true, ...options });
        trackBrowser(browser, 'lifelenz-login-verify');
        const page = await browser.newPage();
        await prepareLifeLenzPage(page);
        const stores = await performLifeLenzLogin(page, lifelenzEmail, lifelenzPassword);
        if (!stores.length) {
            return { ok: false, error: 'Login succeeded but no stores were found in LifeLenz.' };
        }
        return { ok: true, stores };
    } catch (err) {
        return { ok: false, error: err.message || 'Could not reach LifeLenz.' };
    } finally {
        if (!options.keepBrowserOpen) {
            await closeBrowserQuietly(browser, 'lifelenz-login-verify');
        }
    }
}

function getDevLifeLenzCredentials() {
    const email = String(process.env.TempLifeLenzU || '').trim();
    const password = String(process.env.TempLifeLenzP || '');
    if (!email || !password) return null;
    return { email, password };
}

module.exports = {
    LIFELENZ_ADMIN_URL,
    DEFAULT_LIFELENZ_AREA,
    parseStoreLabel,
    cleanStoreDisplayName,
    dedupeStores,
    resolveLifeLenzHeadless,
    resolveLifeLenzArea,
    getLifeLenzLaunchOptions,
    verifyLifeLenzLogin,
    createAuthenticatedLifeLenzSession,
    performLifeLenzLogin,
    listAccessibleStores,
    selectLifeLenzArea,
    selectTacoBellColBusiness,
    selectBusinessOnExplorerPage,
    waitForBusinessExplorerUrl,
    getDevLifeLenzCredentials,
};
