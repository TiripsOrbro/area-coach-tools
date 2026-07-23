const { parseLastYearGridRows } = require('../../../dashboard/src/sssg/sssgGridParser');

function getMacromatixScraper() {
    return require('../macromatixScraper');
}

const MMX_SPA_BASE = 'https://m-tacobellau.macromatix.net/';
const CHANGE_STORE_URL = `${MMX_SPA_BASE}#/Administration/ChangeStore?metric=sales`;
const FORECASTING_URL = `${MMX_SPA_BASE}#/Forecasting/Edit?metric=sales`;

const SPA_GOTO_OPTS = { waitUntil: 'load', timeout: 60000 };
const GRID_WAIT_MS = 20000;

function parseMoneyText(text) {
    const raw = String(text || '').replace(/[^0-9.-]/g, '').trim();
    const value = parseFloat(raw);
    return Number.isFinite(value) ? value : NaN;
}

/**
 * Navigate to the Angular SPA; fall back to SPA login if ASP.NET session cookies are not shared.
 */
async function ensureSpaAuthenticated(page, credentials, options = {}) {
    const quick = options.quick === true;
    await page.goto(CHANGE_STORE_URL, SPA_GOTO_OPTS);
    await page.waitForTimeout(quick ? 700 : 1500);

    const onLogin = await page.evaluate(() => {
        const hasPin = document.querySelector('input[type="password"], #Login_Password, [ng-click*="Login"]');
        const hasUser = document.querySelector('#Login_UserName, input[name="UserName"], input[type="email"]');
        return Boolean(hasPin && hasUser);
    });

    if (onLogin && credentials?.username && credentials?.password) {
        console.log('[SSSG] SPA login required - signing in...');
        await getMacromatixScraper().loginPage(page, credentials.username, credentials.password);
        await page.goto(CHANGE_STORE_URL, SPA_GOTO_OPTS);
        await page.waitForTimeout(quick ? 700 : 1500);
    }

    await page.waitForFunction(
        () => {
            const body = (document.body?.innerText || '').toLowerCase();
            return body.includes('change store') || body.includes('store number') || document.querySelector('table');
        },
        { timeout: GRID_WAIT_MS }
    ).catch(() => {});
}

/**
 * True when the Angular Change Store screen is visible.
 */
async function isOnChangeStorePage(page) {
    return page.evaluate(() => {
        const body = (document.body?.innerText || '').toLowerCase();
        const hash = (location.hash || '').toLowerCase();
        return hash.includes('changestore') || body.includes('change store');
    });
}

async function waitForChangeStorePage(page) {
    await page
        .waitForFunction(
            () => {
                const body = (document.body?.innerText || '').toLowerCase();
                const hash = (location.hash || '').toLowerCase();
                return hash.includes('changestore') || body.includes('change store') || document.querySelector('table');
            },
            { timeout: GRID_WAIT_MS }
        )
        .catch(() => {});
    await page.waitForTimeout(600);
}

/**
 * List stores visible on the Change Store page.
 */
async function listStoresOnChangeStorePage(page) {
    const onPage = await isOnChangeStorePage(page);
    if (!onPage) return [];

    return page.evaluate(() => {
        const stores = [];
        const rows = [...document.querySelectorAll('tr, [role="row"]')];
        for (const row of rows) {
            const cells = [...row.querySelectorAll('td, [role="cell"]')];
            if (cells.length < 2) continue;
            const numText = (cells[0]?.textContent || '').replace(/\D/g, '');
            if (!/^\d{3,6}$/.test(numText)) continue;
            const nameText = (cells[1]?.textContent || '').replace(/\s+/g, ' ').trim();
            stores.push({ storeNumber: numText, storeName: nameText });
        }
        return stores;
    });
}

/**
 * Click Select for the given store on the Change Store page.
 */
async function selectStoreOnSpa(page, storeNumber, options = {}) {
    const quick = options.quick === true;
    const target = String(storeNumber || '').trim().replace(/\D/g, '');
    if (!target) throw new Error('Store number required for SPA store selection');

    await waitForChangeStorePage(page);

    await page.evaluate((num) => {
        for (const inp of document.querySelectorAll('input[type="text"], input[type="search"]')) {
            const ph = (inp.placeholder || '').toLowerCase();
            const label = (inp.closest('label')?.textContent || '').toLowerCase();
            if (ph.includes('store') || ph.includes('search') || ph.includes('filter') || label.includes('store')) {
                inp.focus();
                inp.value = num;
                inp.dispatchEvent(new Event('input', { bubbles: true }));
                inp.dispatchEvent(new Event('change', { bubbles: true }));
                break;
            }
        }
    }, target);
    await page.waitForTimeout(quick ? 250 : 800);

    const clicked = await page.evaluate((num) => {
        const rows = [...document.querySelectorAll('tr, [role="row"]')];
        for (const row of rows) {
            const text = (row.textContent || '').replace(/\s+/g, ' ');
            if (!new RegExp(`\\b${num}\\b`).test(text)) continue;

            const candidates = [...row.querySelectorAll('button, a, input, span, div[role="button"], [ng-click], [data-ng-click]')];
            for (const el of candidates) {
                const label = (el.textContent || el.value || el.getAttribute('aria-label') || '')
                    .replace(/\s+/g, ' ')
                    .trim();
                const ngClick = el.getAttribute('ng-click') || el.getAttribute('data-ng-click') || '';
                if (/^select$/i.test(label) || /^choose$/i.test(label)) {
                    el.click();
                    return true;
                }
                if (/select/i.test(ngClick) && /store|change/i.test(ngClick)) {
                    el.click();
                    return true;
                }
            }
            const actions = [...row.querySelectorAll('button, a')];
            if (actions.length) {
                actions[actions.length - 1].click();
                return true;
            }
        }
        return false;
    }, target);

    if (!clicked) {
        const listed = await listStoresOnChangeStorePage(page);
        const visible = listed.map((s) => s.storeNumber).join(', ') || 'none';
        throw new Error(`Select button not found for store ${target} (visible on Change Store page: ${visible})`);
    }

    await page.waitForTimeout(quick ? 500 : 2000);
    await page
        .waitForFunction((num) => (document.body?.innerText || '').includes(num), { timeout: quick ? 8000 : 15000 }, target)
        .catch(() => {});
}

/**
 * Read all Last Year cells from the Forecasting grid.
 */
async function readLastYearForecastGrid(page) {
    await page.goto(FORECASTING_URL, SPA_GOTO_OPTS);

    await page.waitForFunction(
        () => document.querySelector('[id^="mx-forecast-grid-Sales-directive-list-lastyear-"]'),
        { timeout: GRID_WAIT_MS }
    );

    await page.waitForTimeout(1000);

    const rawRows = await page.evaluate(() => {
        const spans = [
            ...document.querySelectorAll('[id^="mx-forecast-grid-Sales-directive-list-lastyear-"]'),
        ];

        function rowLabelFor(span) {
            const row = span.closest('tr') || span.closest('[role="row"]') || span.parentElement?.parentElement;
            if (!row) return '';

            const cells = [...row.querySelectorAll('td, th')];
            for (const cell of cells) {
                const text = (cell.textContent || '').replace(/\s+/g, ' ').trim();
                if (/\d{1,2}(:\d{2})?/.test(text) && !/\$/.test(text)) {
                    return text;
                }
            }

            const firstCell = cells[0];
            return firstCell ? (firstCell.textContent || '').replace(/\s+/g, ' ').trim() : '';
        }

        return spans.map((span) => {
            const match = span.id.match(/lastyear-(\d+)$/);
            const rowIndex = match ? parseInt(match[1], 10) : -1;
            const labelText = rowLabelFor(span);
            const valueText = (span.textContent || '').trim();
            const value = parseFloat(valueText.replace(/[^0-9.-]/g, ''));
            return {
                rowIndex,
                labelText,
                valueText,
                value: Number.isFinite(value) ? value : NaN,
                id: span.id,
            };
        });
    });

    return rawRows.filter((r) => Number.isFinite(r.value));
}

/**
 * Change store on an already-authenticated SPA session and read the LY grid.
 */
async function scrapeSssgLastYearStoreInSession(page, storeNumber) {
    const target = String(storeNumber || '').trim();
    await page.goto(CHANGE_STORE_URL, SPA_GOTO_OPTS);
    await page.waitForTimeout(800);
    await selectStoreOnSpa(page, target);

    const rawRows = await readLastYearForecastGrid(page);
    const slots = parseLastYearGridRows(rawRows);

    if (!slots.length) {
        throw new Error(`No Last Year quarter-hour slots parsed for store ${target} (${rawRows.length} raw rows)`);
    }

    return { storeNumber: target, slots, rawRowCount: rawRows.length };
}

/**
 * Scrape Last Year 15-minute slots for one store (standalone - includes SPA auth).
 */
async function scrapeSssgLastYearForStore(page, storeNumber, credentials) {
    await page.goto(CHANGE_STORE_URL, SPA_GOTO_OPTS);
    await page.waitForTimeout(1000);
    await ensureSpaAuthenticated(page, credentials);
    return scrapeSssgLastYearStoreInSession(page, storeNumber);
}

/**
 * One SPA session: Change Store → Select → Forecasting → read LY grid for every store.
 */
async function scrapeSssgLastYearAllStores(page, stores, options = {}) {
    const credentials = options.credentials || getMacromatixScraper().resolveMacromatixCredentials();
    const results = [];

    await ensureSpaAuthenticated(page, credentials);

    for (const store of stores || []) {
        const storeNumber = String(store.storeNumber || '').trim();
        if (!storeNumber) continue;

        try {
            console.log(`[SSSG] Scraping Last Year grid for store ${storeNumber}...`);
            const result = await scrapeSssgLastYearStoreInSession(page, storeNumber);
            results.push(result);
            console.log(
                `[SSSG] Store ${storeNumber}: ${result.slots.length} quarter-hour slots from ${result.rawRowCount} raw rows`
            );
        } catch (err) {
            console.warn(`[SSSG] Store ${storeNumber} LY scrape failed:`, err.message);
            results.push({ storeNumber, slots: [], error: err.message });
        }
    }

    return results;
}

module.exports = {
    MMX_SPA_BASE,
    CHANGE_STORE_URL,
    FORECASTING_URL,
    parseMoneyText,
    ensureSpaAuthenticated,
    isOnChangeStorePage,
    waitForChangeStorePage,
    listStoresOnChangeStorePage,
    selectStoreOnSpa,
    readLastYearForecastGrid,
    scrapeSssgLastYearStoreInSession,
    scrapeSssgLastYearForStore,
    scrapeSssgLastYearAllStores,
};
