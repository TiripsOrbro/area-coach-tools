/**
 * Scheduled orders list - vendor table + list date (default tomorrow).
 * New orders: Create link. Existing orders: Process link (still updatable, never Submit).
 */
const { GOTO_OPTS } = require('./mmx-browser');
const { withPageContextRetry } = require('./mmx-context-retry');
const { setReportListDate } = require('./mmx-rad-date-picker');
const { resolveReportDate } = require('./util-dates');
const { waitForAspPostback, waitForDocumentStable } = require('./mmx-postback');
const { waitForScheduledOrdersTableReady } = require('./mmx-order-waits');
const log = require('./util-logging');

const DEFAULT_URL = 'https://tacobellau.macromatix.net/mms_stores_scheduledorders.aspx';

const SCHEDULED_TABLE_WAIT_MS = Number(process.env.MMX_SCHEDULED_TABLE_WAIT_MS || 12000);

async function waitForAspNetSettle(page) {
    await waitForDocumentStable(page, { timeoutMs: 15000, quietMs: 400 });
}

async function waitForScheduledOrdersTable(page, timeoutMs = SCHEDULED_TABLE_WAIT_MS) {
    await waitForScheduledOrdersTableReady(page, timeoutMs).catch(() => null);
}

async function isListDateAlready(page, display) {
    const want = String(display || '').trim().toLowerCase();
    await waitForDocumentStable(page, { timeoutMs: 15000, quietMs: 400 });
    return page.evaluate((target) => {
        const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
        for (const input of document.querySelectorAll('input[type="text"], input:not([type])')) {
            const ctx = ((input.closest('tr, td, div, table') || input.parentElement)?.innerText || '').toLowerCase();
            if (!ctx.includes('date') || ctx.includes('delivery') || ctx.includes('end date')) continue;
            const v = norm(input.value);
            if (v.includes(target) || v.replace(/-/g, ' ').includes(target.replace(/-/g, ' '))) {
                return true;
            }
        }
        return false;
    }, want);
}

async function waitAfterListDateChange(page) {
    await waitForAspPostback(page, { timeoutMs: 12000, quietMs: 500 });
    await waitForScheduledOrdersTable(page, SCHEDULED_TABLE_WAIT_MS);
}

async function setScheduledOrdersListDate(page, dateSpec) {
    const display = resolveReportDate(dateSpec || 'daysFromNow:1', { dateOnly: true });

    await withPageContextRetry(page, 'scheduled orders list date', async () => {
        if (await isListDateAlready(page, display)) {
            log.info(`List date already ${display} - skipping date change`);
            await waitForScheduledOrdersTable(page, 6000);
            return;
        }

        log.info(`Setting scheduled orders date → ${display}`);
        await setReportListDate(page, display);
        await waitAfterListDateChange(page);
    });
}

function getScheduledOrdersDateSpec(vendorOrdersCfg) {
    return vendorOrdersCfg?.scheduledOrdersDate || process.env.MMX_ORDER_DATE || 'tomorrow';
}

async function applyScheduledOrdersListDate(page, vendorOrdersCfg) {
    const dateSpec = getScheduledOrdersDateSpec(vendorOrdersCfg);
    if (dateSpec && dateSpec !== 'today') {
        await setScheduledOrdersListDate(page, dateSpec);
    }
}

/** Same list date as scheduled-order entry (config vendor-orders.json → tomorrow by default). */
async function applyScheduledOrdersListDateFromConfig(page) {
    let vendorOrdersCfg = {};
    try {
        vendorOrdersCfg = require('../../../vendors/src/buildToOrderLines').loadVendorOrdersConfig();
    } catch {
        /* use MMX_ORDER_DATE / tomorrow fallback */
    }
    await applyScheduledOrdersListDate(page, vendorOrdersCfg);
}

async function waitForScheduledOrdersReady(page) {
    await waitForScheduledOrdersTable(page, SCHEDULED_TABLE_WAIT_MS);
}

async function openScheduledOrders(page, url, navTimeoutMs, vendorOrdersCfg, storeContext) {
    const target = url || DEFAULT_URL;
    log.info(`Opening scheduled orders: ${target}`);
    await page.goto(target, { ...GOTO_OPTS, timeout: navTimeoutMs });
    await page.waitForFunction(() => document.readyState === 'complete', { timeout: 20000 }).catch(() => {});
    await waitForScheduledOrdersTable(page);
    if (storeContext?.selectStore) {
        await storeContext.selectStore(page, storeContext.storeNumber, storeContext.storeName);
    } else if (storeContext?.storeName) {
        const { selectStore } = require('./pipeline-supply-chain-reports');
        await selectStore(page, storeContext.storeName, {
            storeNumber: storeContext.storeNumber,
            waitMs: 500,
        });
    }
    await waitForAspNetSettle(page);
    await applyScheduledOrdersListDate(page, vendorOrdersCfg);
    await waitForScheduledOrdersReady(page);
}

function vendorRegex(vendorMatch) {
    return new RegExp(String(vendorMatch), 'i');
}

function classMatches(rowClass, orderClass) {
    if (!orderClass) return true;
    return String(rowClass || '').trim().toUpperCase() === String(orderClass).trim().toUpperCase();
}

async function parseScheduledOrdersTable(page) {
    return page.evaluate(() => {
        const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
        const lower = (s) => norm(s).toLowerCase();

        const rowHasCreate = (orderText) => lower(orderText).includes('create');

        let bestRows = [];

        for (const table of document.querySelectorAll('table')) {
            const txt = (table.innerText || '').toLowerCase();
            if (!txt.includes('vendor') && !txt.includes('create')) continue;

            const headerRow = table.querySelector('tr');
            if (!headerRow) continue;
            const headers = Array.from(headerRow.querySelectorAll('th, td')).map((c) => lower(c.textContent));

            let vendorIdx = headers.findIndex((h) => h.includes('vendor'));
            let classIdx = headers.findIndex((h) => h === 'class' || h.startsWith('class'));
            let statusIdx = headers.findIndex((h) => h.includes('order status') || h === 'status');
            let orderIdx = headers.findIndex((h) => h.includes('order #') || h === 'order #');
            if (vendorIdx < 0 && orderIdx >= 0) {
                vendorIdx = 1;
                classIdx = classIdx >= 0 ? classIdx : 2;
            }
            if (vendorIdx < 0) continue;

            const indices = [vendorIdx, classIdx, statusIdx, orderIdx].filter((i) => i >= 0);
            const maxIdx = Math.max(...indices, vendorIdx);

            for (const tr of Array.from(table.querySelectorAll('tr')).slice(1)) {
                const cells = Array.from(tr.querySelectorAll('td'));
                if (cells.length <= maxIdx) continue;
                const vendor = norm(cells[vendorIdx]?.textContent);
                const orderClass = classIdx >= 0 ? norm(cells[classIdx]?.textContent) : '';
                const status = statusIdx >= 0 ? norm(cells[statusIdx]?.textContent) : '';
                const orderCell = orderIdx >= 0 ? cells[orderIdx] : cells[0];
                const statusCell = statusIdx >= 0 ? cells[statusIdx] : null;
                const orderCol = orderCell ? norm(orderCell.textContent) : '';
                let hasCreate = rowHasCreate(orderCol);
                let hasProcess = false;
                let hasOrderLink = false;
                for (const cell of [orderCell, statusCell].filter(Boolean)) {
                    for (const a of cell.querySelectorAll('a')) {
                        const linkText = norm(a.textContent).toLowerCase();
                        if (!a.getAttribute('href')) continue;
                        if (linkText === 'create') hasCreate = true;
                        else if (linkText === 'process') hasProcess = true;
                        else if (linkText) hasOrderLink = true;
                    }
                }
                if (!hasCreate && !hasProcess && lower(orderCol).includes('process')) {
                    hasProcess = true;
                }
                if (!vendor) continue;
                bestRows.push({
                    vendor,
                    orderClass,
                    status,
                    orderCol,
                    hasCreate,
                    hasProcess,
                    hasOrderLink,
                });
            }
        }

        if (!bestRows.length) {
            for (const tr of document.querySelectorAll('tr')) {
                const cells = Array.from(tr.querySelectorAll('td'));
                if (cells.length < 5) continue;
                const orderCol = norm(cells[0]?.textContent);
                if (!rowHasCreate(orderCol)) continue;
                const vendor = norm(cells[1]?.textContent);
                if (!vendor || vendor.length < 3) continue;
                const orderCell = cells[0];
                let hasOrderLink = false;
                for (const a of (orderCell?.querySelectorAll('a') || [])) {
                    if (norm(a.textContent).toLowerCase() !== 'create' && a.getAttribute('href')) {
                        hasOrderLink = true;
                        break;
                    }
                }
                bestRows.push({
                    vendor,
                    orderClass: norm(cells[2]?.textContent),
                    status: norm(cells[6]?.textContent),
                    orderCol,
                    hasCreate: true,
                    hasOrderLink,
                });
            }
        }

        return { rows: bestRows };
    });
}

async function scrapeScheduledOrders(page) {
    let parsed = { rows: [] };
    for (let attempt = 1; attempt <= 3; attempt++) {
        parsed = await withPageContextRetry(page, 'scheduled orders table', async () => {
            return parseScheduledOrdersTable(page);
        });
        if (parsed.rows.length) break;
        log.warn(`Scheduled orders table empty (attempt ${attempt}/3), waiting…`);
        await waitForScheduledOrdersTable(page, 6000);
    }

    if (!parsed.rows.length) {
        const hint = await page.evaluate(() => (document.body?.innerText || '').slice(0, 800));
        throw new Error(`Scheduled orders table not found. Preview: ${hint.replace(/\s+/g, ' ').slice(0, 280)}`);
    }

    const creatable = parsed.rows.filter((r) => r.hasCreate);
    const openable = parsed.rows.filter((r) => rowIsOpenable(r));
    log.info(
        `Scheduled orders: ${parsed.rows.length} row(s), openable: ${openable.length} - ` +
            openable
                .map(
                    (r) =>
                        `${r.vendor} (${r.orderClass || '?'})` +
                        (r.hasCreate ? ' Create' : r.hasProcess ? ' Process' : '')
                )
                .join(', ')
    );
    return { ...parsed, creatableRows: creatable, openableRows: openable };
}

function rowIsOpenable(row) {
    return !!(row?.hasCreate || row?.hasProcess || row?.hasOrderLink);
}

async function returnToScheduledOrders(page, vendorOrdersCfg, navTimeoutMs, storeContext) {
    const target = vendorOrdersCfg?.scheduledOrdersUrl || DEFAULT_URL;
    log.info(`Returning to scheduled orders: ${target}`);
    await page.goto(target, { ...GOTO_OPTS, timeout: navTimeoutMs }).catch(async (err) => {
        if (!String(err.message || '').includes('ERR_ABORTED')) throw err;
        log.warn('Navigation aborted - waiting for scheduled orders page to settle');
    });
    await page.waitForFunction(() => document.readyState === 'complete', { timeout: 10000 }).catch(() => {});
    await waitForScheduledOrdersTableReady(page, 8000);
    if (storeContext?.selectStore) {
        await storeContext.selectStore(page, storeContext.storeNumber, storeContext.storeName);
    } else if (storeContext?.storeName) {
        const { selectStore } = require('./pipeline-supply-chain-reports');
        await selectStore(page, storeContext.storeName, {
            storeNumber: storeContext.storeNumber,
            waitMs: 300,
        });
    }
    await waitForAspNetSettle(page);
    await applyScheduledOrdersListDate(page, vendorOrdersCfg);
    await waitForScheduledOrdersReady(page);
}

function pickVendorRow(parsed, vendorCfg) {
    const re = vendorRegex(vendorCfg.vendorMatch);
    const matching = parsed.rows.filter(
        (r) => re.test(r.vendor) && classMatches(r.orderClass, vendorCfg.orderClass)
    );

    const pickOpenable = (rows) =>
        rows.find((r) => r.hasCreate) || rows.find((r) => r.hasProcess) || rows.find((r) => r.hasOrderLink) || rows[0];

    if (matching.length) return pickOpenable(matching);

    const loose = parsed.rows.filter((r) => re.test(r.vendor));
    if (loose.length === 1) return pickOpenable(loose);
    if (loose.length > 1 && vendorCfg.orderClass) {
        const byClass = loose.filter((r) => classMatches(r.orderClass, vendorCfg.orderClass));
        if (byClass.length) return pickOpenable(byClass);
    }
    return pickOpenable(loose) || null;
}

async function clickCreateForVendorRow(page, vendorCfg) {
    const parsed = await scrapeScheduledOrders(page);
    const row = pickVendorRow(parsed, vendorCfg);

    if (!row) {
        const seen = parsed.rows
            .map(
                (r) =>
                    `${r.vendor}/${r.orderClass}` +
                    (r.hasCreate ? ' [Create]' : r.hasProcess ? ' [Process]' : r.hasOrderLink ? ' [Order]' : '')
            )
            .join(' | ');
        throw new Error(
            `No scheduled order row for ${vendorCfg.label} (vendor=/${vendorCfg.vendorMatch}/ class=${vendorCfg.orderClass || '*'}). ` +
                `Rows: ${seen || '(none)'}`
        );
    }

    log.info(
        `Order row: vendor="${row.vendor}" class="${row.orderClass}" status="${row.status}" ` +
            `(create=${row.hasCreate}, process=${row.hasProcess}, orderLink=${row.hasOrderLink})`
    );

    const clicked = await page.evaluate(
        (vendorText, classText, preferProcess) => {
            const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
            const wantVendor = norm(vendorText).toLowerCase();
            const wantClass = norm(classText).toUpperCase();

            const tryRow = (tr) => {
                const cells = Array.from(tr.querySelectorAll('td'));
                if (!cells.length) return null;
                const rowText = norm(tr.innerText);
                if (!rowText.toLowerCase().includes(wantVendor)) return null;
                if (wantClass && !rowText.toUpperCase().includes(wantClass)) return null;

                for (const a of tr.querySelectorAll('a')) {
                    if (norm(a.textContent).toLowerCase() === 'create' && a.getAttribute('href')) {
                        a.click();
                        return 'Create';
                    }
                }
                if (preferProcess) {
                    for (const a of tr.querySelectorAll('a')) {
                        if (norm(a.textContent).toLowerCase() === 'process' && a.getAttribute('href')) {
                            a.click();
                            return 'Process';
                        }
                    }
                }
                const orderCell = cells[0];
                for (const a of orderCell?.querySelectorAll('a') || []) {
                    const label = norm(a.textContent);
                    const low = label.toLowerCase();
                    if (!label || low === 'create' || !a.getAttribute('href')) continue;
                    a.click();
                    return `Order ${label}`;
                }
                return null;
            };

            for (const table of document.querySelectorAll('table')) {
                if (!(table.innerText || '').toLowerCase().includes('vendor')) continue;
                for (const tr of table.querySelectorAll('tr')) {
                    const hit = tryRow(tr);
                    if (hit) return hit;
                }
            }
            return null;
        },
        row.vendor,
        row.orderClass,
        !row.hasCreate && (row.hasProcess || /process/i.test(row.orderCol || ''))
    );

    if (!clicked) throw new Error(`Could not open order for ${vendorCfg.label}`);
    log.info(`Clicked "${clicked}" for ${vendorCfg.label}`);
    await waitForAspPostback(page, { timeoutMs: 30000 });
    await page
        .waitForFunction(
            () => {
                const t = (document.body?.innerText || '').toLowerCase();
                return (
                    document.querySelectorAll('input[id*="tbOH"], input[type="text"]').length > 3 ||
                    /order detail|purchase order|vendor order/i.test(t)
                );
            },
            { timeout: 25000, polling: 100 }
        )
        .catch(() => {});

    return { row, parsed };
}

module.exports = {
    openScheduledOrders,
    returnToScheduledOrders,
    applyScheduledOrdersListDate,
    getScheduledOrdersDateSpec,
    setScheduledOrdersListDate,
    scrapeScheduledOrders,
    pickVendorRow,
    clickCreateForVendorRow,
    vendorRegex,
    classMatches,
    rowIsOpenable,
    setScheduledOrdersListDate,
    applyScheduledOrdersListDateFromConfig,
};
