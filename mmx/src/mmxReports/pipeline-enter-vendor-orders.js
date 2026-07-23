const { withPageContextRetry } = require('./mmx-context-retry');
const { waitForAspPostback } = require('./mmx-postback');
const { refreshScrapePauseTimeout } = require('../mmxResourceGate');
const {
    setQuantityInputValue,
    typeQuantityIntoInputFallback,
    waitForOrderPageReady,
    waitAfterOrderUpdate,
} = require('./mmx-order-waits');
const {
    openScheduledOrders,
    returnToScheduledOrders,
    scrapeScheduledOrders,
    clickCreateForVendorRow,
    vendorRegex,
    classMatches,
    rowIsOpenable,
} = require('./mmx-scheduled-orders');
const log = require('./util-logging');
const { linesFromOrderGridByName } = require('../../../vendors/src/orderItemNameMatch');

async function waitForOrderItemsGrid(page, timeoutMs = 30000) {
    await waitForOrderPageReady(page, timeoutMs);
}

/** Register before the click that triggers a native `window.confirm`. */
function waitForNativeDialogAccept(page, opts = {}) {
    const timeoutMs = opts.timeoutMs ?? 20000;
    const mustInclude = String(opts.messageIncludes || 'set to zero').toLowerCase();

    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            page.off('dialog', onDialog);
            reject(new Error(`Confirmation dialog did not appear within ${timeoutMs}ms`));
        }, timeoutMs);

        async function onDialog(dialog) {
            const msg = dialog.message() || '';
            if (mustInclude && !msg.toLowerCase().includes(mustInclude)) {
                log.warn(`Unexpected dialog (will accept): ${msg.slice(0, 160)}`);
            }
            clearTimeout(timer);
            page.off('dialog', onDialog);
            log.info(`Accepted dialog: ${msg.slice(0, 160)}`);
            await dialog.accept();
            resolve(msg);
        }

        page.on('dialog', onDialog);
    });
}

async function clickButtonByLabel(page, label, { required = true, waitAfterMs = 0 } = {}) {
    const want = String(label || '').trim();
    const clicked = await page.evaluate((text) => {
        const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
        const wantLower = norm(text).toLowerCase();
        for (const el of document.querySelectorAll(
            'input[type="button"], input[type="submit"], button, a, span'
        )) {
            const t = norm(el.value || el.textContent);
            if (t.toLowerCase() === wantLower) {
                el.click();
                return t;
            }
        }
        return null;
    }, want);

    if (!clicked) {
        if (required) throw new Error(`Button not found on order page: "${want}"`);
        return false;
    }
    log.info(`Clicked "${clicked}"`);
    if (waitAfterMs !== 0) {
        await waitForAspPostback(page, { timeoutMs: Math.max(waitAfterMs, 10000) });
        await waitForOrderPageReady(page, 15000).catch(() => {});
    }
    return true;
}

async function clickClearQuantities(page, orderEntryCfg) {
    const label = orderEntryCfg?.clearQuantitiesButtonText || 'Clear Quantities';
    const confirmText =
        orderEntryCfg?.clearQuantitiesConfirmIncludes || 'set to zero';

    const dialogPromise = waitForNativeDialogAccept(page, { messageIncludes: confirmText });
    await clickButtonByLabel(page, label, { required: true, waitAfterMs: 0 });
    await dialogPromise;
    await waitForOrderItemsGrid(page);
}

/** Map item code + name → quantity input id in the "Items in this order" grid. */
async function scrapeOrderGridByItemCode(page) {
    return page.evaluate(() => {
        const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();

        for (const table of document.querySelectorAll('table')) {
            const trs = Array.from(table.querySelectorAll('tr'));
            if (!trs.length) continue;

            let headerRowIdx = -1;
            let codeCol = -1;
            let nameCol = -1;
            let qtyCol = -1;

            for (let i = 0; i < Math.min(trs.length, 8); i++) {
                const cells = Array.from(trs[i].querySelectorAll('th, td'));
                const headers = cells.map((c) => norm(c.textContent).toLowerCase());
                const ci = headers.findIndex((h) => h.includes('item code'));
                const qi = headers.findIndex((h) => h === 'quantity' || h.startsWith('quantity'));
                let ni = headers.findIndex((h) => h === 'item' || h === 'item name' || h === 'description');
                if (ni < 0) {
                    ni = headers.findIndex((h) => h.includes('item') && !h.includes('code'));
                }
                if (ci >= 0 && qi >= 0) {
                    headerRowIdx = i;
                    codeCol = ci;
                    nameCol = ni;
                    qtyCol = qi;
                    break;
                }
            }
            if (codeCol < 0) continue;

            const rows = [];
            for (let i = headerRowIdx + 1; i < trs.length; i++) {
                const cells = Array.from(trs[i].querySelectorAll('td'));
                if (cells.length <= Math.max(codeCol, qtyCol)) continue;

                const itemCode = norm(cells[codeCol].textContent);
                if (!itemCode || itemCode.toLowerCase() === 'item code') continue;

                const itemName =
                    nameCol >= 0 && cells[nameCol]
                        ? norm(cells[nameCol].textContent)
                        : norm(cells[Math.min(codeCol + 1, cells.length - 1)]?.textContent);

                const qtyCell = cells[qtyCol];
                const input = qtyCell.querySelector(
                    'input[type="text"], input:not([type="hidden"]):not([type="checkbox"])'
                );
                if (!input || input.disabled || input.offsetParent === null) continue;

                const readBack = String(input.value || '').trim();
                const numericQty = Number(readBack.replace(/,/g, ''));
                rows.push({
                    itemCode,
                    itemName: itemName || itemCode,
                    inputId: input.id || '',
                    readBack,
                    hasQuantity: Number.isFinite(numericQty) && numericQty > 0,
                });
            }

            if (rows.length) return { rows, tableFound: true };
        }
        return { rows: [], tableFound: false };
    });
}

async function typeQuantityIntoInput(page, inputId, quantity) {
    const ok = await setQuantityInputValue(page, inputId, quantity);
    if (ok) return true;
    return typeQuantityIntoInputFallback(page, inputId, quantity);
}

const { normalizeItemCode } = require('../../../vendors/src/reportReader');

async function fillOrderLineQuantities(page, lines, existingGrid = null, options = {}) {
    const grid = existingGrid || (await scrapeOrderGridByItemCode(page));
    if (!grid.tableFound || !grid.rows.length) {
        throw new Error('Order items grid (Item Code / Quantity columns) not found after Create');
    }

    const byCode = new Map(grid.rows.map((r) => [normalizeItemCode(r.itemCode), r]));
    const results = [];
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
    const progressEvery = Math.max(1, Number(options.progressEvery) || 4);

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const key = normalizeItemCode(line.itemCode);
        const row = byCode.get(key);
        if (!row?.inputId) {
            results.push({ itemCode: line.itemCode, quantity: line.quantity, filled: false });
            continue;
        }

        if (onProgress && (i === 0 || (i + 1) % progressEvery === 0 || i === lines.length - 1)) {
            await onProgress(i + 1, lines.length);
        }

        if ((i + 1) % progressEvery === 0) {
            refreshScrapePauseTimeout();
        }

        await typeQuantityIntoInput(page, row.inputId, line.quantity);

        const readBack = await page.evaluate((id) => {
            const inp = document.getElementById(id);
            if (!inp) return '';
            return (inp.value || '').trim();
        }, row.inputId);

        const filled =
            readBack === String(line.quantity) ||
            parseFloat(readBack) === parseFloat(line.quantity);
        results.push({
            itemCode: line.itemCode,
            quantity: line.quantity,
            filled,
            readBack,
        });
    }

    const filled = results.filter((r) => r.filled);
    const missed = results.filter((r) => !r.filled);
    log.info(`Order lines filled: ${filled.length}/${results.length}`);
    if (missed.length) {
        log.warn(
            'Quantity not set for item code(s):',
            missed
                .slice(0, 12)
                .map((m) => `${m.itemCode}${m.readBack ? ` (got "${m.readBack}")` : ''}`)
                .join(', ') + (missed.length > 12 ? ` … +${missed.length - 12}` : '')
        );
    }
    return results;
}

async function clickUpdateOnly(page, orderEntryCfg) {
    const updateText = (orderEntryCfg?.updateButtonText || 'Update').toLowerCase();
    const forbidden = (orderEntryCfg?.forbiddenSubmitTexts || ['Submit', 'Place Order']).map((s) =>
        s.toLowerCase()
    );

    const clicked = await page.evaluate(
        (updateWant, forbiddenList) => {
            const candidates = [];
            for (const el of document.querySelectorAll('input[type="submit"], input[type="button"], button, a')) {
                const t = (el.value || el.textContent || '').trim().toLowerCase();
                if (!t || forbiddenList.some((f) => t.includes(f))) continue;
                if (t === updateWant || (t.includes(updateWant) && !t.includes('submit'))) {
                    candidates.push(el);
                }
            }
            const btn = candidates[0];
            if (!btn) return null;
            btn.click();
            return (btn.value || btn.textContent || 'Update').trim();
        },
        updateText,
        forbidden
    );

    if (!clicked) throw new Error('Update button not found on order page (Submit was not clicked)');
    log.info(`Clicked "${clicked}" only - order not submitted`);
    await waitAfterOrderUpdate(page, 20000);
    return clicked;
}

function matchVendorConfigForTableRow(tableRow, vendors) {
    return (vendors || []).find(
        (v) =>
            vendorRegex(v.vendorMatch).test(tableRow.vendor) &&
            classMatches(tableRow.orderClass, v.orderClass)
    );
}

function buildOrderQueue(parsed, vendorOrdersCfg, buildToByVendorId, { vendorIdFilter, skipVendorIds } = {}) {
    const queue = [];
    const skipIds = new Set((skipVendorIds || []).map((id) => String(id)));

    for (const tableRow of parsed.rows) {
        if (!rowIsOpenable(tableRow)) continue;

        const vendorCfg = matchVendorConfigForTableRow(tableRow, vendorOrdersCfg.vendors);
        if (!vendorCfg) {
            log.info(`Skip unmapped row: ${tableRow.vendor} (${tableRow.orderClass || '?'})`);
            continue;
        }
        if (vendorIdFilter && vendorCfg.id !== vendorIdFilter) continue;
        if (skipIds.has(vendorCfg.id)) {
            log.info(`Skip already completed vendor order: ${vendorCfg.label}`);
            continue;
        }

        const pack = buildToByVendorId[vendorCfg.id];
        queue.push({
            vendor: vendorCfg,
            buildToEntries: pack?.buildToEntries || [],
            tableRow,
        });
    }

    return queue;
}

async function orderStep(settings, label) {
    if (settings.onOrderStep) await settings.onOrderStep(String(label || '').trim());
}

async function processOneVendorOrder(page, settings, vendor, buildToEntries) {
    await orderStep(settings, `${vendor.label}: opening order form`);
    await clickCreateForVendorRow(page, vendor);
    await orderStep(settings, `${vendor.label}: loading order items`);
    await waitForOrderItemsGrid(page);

    const grid = await scrapeOrderGridByItemCode(page);
    if (!grid.tableFound || !grid.rows.length) {
        throw new Error('Order items grid (Item Code / Quantity columns) not found after Create');
    }

    await withPageContextRetry(page, `fill order ${vendor.id}`, async () => {
        const hasExistingQty = grid.rows.some((row) => row.hasQuantity);
        if (hasExistingQty) {
            await orderStep(settings, `${vendor.label}: clearing existing quantities`);
            await clickClearQuantities(page, settings.vendorOrders.orderEntry);
        } else {
            log.info(`${vendor.label}: order grid empty - skipping Clear Quantities`);
        }

        const gridAfterClear = hasExistingQty ? await scrapeOrderGridByItemCode(page) : grid;
        if (!gridAfterClear.tableFound || !gridAfterClear.rows.length) {
            throw new Error('Order items grid (Item Code / Quantity columns) not found after Create');
        }

        const lines = linesFromOrderGridByName(gridAfterClear, buildToEntries);
        log.info(
            `${vendor.label}: ${gridAfterClear.rows.length} item(s) on MMX order form - filling ${lines.length} by name match`
        );
        for (const line of lines) {
            log.info(`  ${line.itemName || line.itemCode} × ${line.quantity} ← ${line.matchedFrom || '?'}`);
        }
        if (!lines.length) {
            log.info(`${vendor.label}: no name-matched build-to quantities - saving cleared order`);
        }

        if (lines.length) {
            await orderStep(settings, `${vendor.label}: filling ${lines.length} item(s)`);
        }
        await fillOrderLineQuantities(page, lines, gridAfterClear, {
            progressEvery: 4,
            onProgress: async (done, total) => {
                await orderStep(settings, `${vendor.label}: filled ${done}/${total} items`);
            },
        });
        await orderStep(settings, `${vendor.label}: saving order`);
        await clickUpdateOnly(page, settings.vendorOrders.orderEntry);
    });
}

/**
 * Process every openable scheduled-order row (top → bottom): Create/Process → Clear Quantities → fill → Update → back to list.
 */
async function runAllScheduledOrders(page, settings, opts = {}) {
    const vendorOrdersCfg = settings.vendorOrders;
    const vendorIdFilter = opts.vendorId || process.env.MMX_ORDER_VENDOR_ID || undefined;
    const storeContext = settings.storeContext || { storeName: settings.storeName, storeNumber: settings.storeNumber };

    await orderStep(settings, 'Opening scheduled orders page');
    await openScheduledOrders(
        page,
        vendorOrdersCfg.scheduledOrdersUrl,
        settings.navTimeoutMs,
        vendorOrdersCfg,
        storeContext
    );
    await orderStep(settings, 'Reading scheduled order list');
    const table = await scrapeScheduledOrders(page);
    const buildToByVendorId =
        settings.orderLinesByVendorId ||
        (() => {
            throw new Error('orderLinesByVendorId is required - run buildToOrderLines first');
        })();

    const queue = buildOrderQueue(table, vendorOrdersCfg, buildToByVendorId, {
        vendorIdFilter,
        skipVendorIds: opts.skipVendorIds,
    });
    if (!queue.length) {
        throw new Error(
            vendorIdFilter
                ? `No openable scheduled order for vendor id "${vendorIdFilter}"`
                : 'No openable scheduled orders for configured vendors (BEGA, Cut Fresh, Americold, Schweppes, …)'
        );
    }

    log.info(`Order queue: ${queue.length} - ${queue.map((q) => q.vendor.label).join(' → ')}`);
    await orderStep(
        settings,
        queue.length
            ? `Placing ${queue.length} scheduled order(s): ${queue.map((q) => q.vendor.label).join(', ')}`
            : 'No scheduled orders found'
    );

    const processed = [];
    for (let i = 0; i < queue.length; i++) {
        const { vendor, buildToEntries } = queue[i];
        log.info(`--- Order ${i + 1}/${queue.length}: ${vendor.label} ---`);
        refreshScrapePauseTimeout();
        await orderStep(settings, `Order ${i + 1}/${queue.length}: ${vendor.label}`);

        if (i > 0) {
            await returnToScheduledOrders(page, vendorOrdersCfg, settings.navTimeoutMs, storeContext);
        }

        try {
            await processOneVendorOrder(page, settings, vendor, buildToEntries);
            refreshScrapePauseTimeout();
            if (settings.onVendorOrderComplete) {
                await settings.onVendorOrderComplete(vendor.id, vendor.label);
            }
            processed.push({
                vendorId: vendor.id,
                label: vendor.label,
                ok: true,
            });
        } catch (err) {
            log.error(`Failed ${vendor.label}: ${err.message}`);
            processed.push({
                vendorId: vendor.id,
                label: vendor.label,
                ok: false,
                error: err.message,
            });
            if (opts.continueOnError !== false) {
                log.warn('Continuing with next order after failure');
            } else {
                throw err;
            }
            await returnToScheduledOrders(page, vendorOrdersCfg, settings.navTimeoutMs, storeContext).catch(
                () => {}
            );
        }
    }

    await returnToScheduledOrders(page, vendorOrdersCfg, settings.navTimeoutMs, storeContext);

    const failed = processed.filter((p) => !p.ok);
    if (failed.length) {
        log.warn(`${failed.length} order(s) failed:`, failed.map((f) => f.label).join(', '));
    }
    log.info(`Completed ${processed.filter((p) => p.ok).length}/${processed.length} scheduled orders`);

    const lastOk = [...processed].reverse().find((p) => p.ok);
    return {
        processed,
        vendor: lastOk ? queue.find((q) => q.vendor.id === lastOk.vendorId)?.vendor : queue[0]?.vendor,
        buildToEntries: lastOk ? queue.find((q) => q.vendor.id === lastOk.vendorId)?.buildToEntries : null,
    };
}

/**
 * Build-to order lines → scheduled orders → Create/Process → Clear Quantities → fill → Update (never Submit).
 */
async function runVendorOrderEntry(page, settings, opts = {}) {
    const vendorOrdersCfg = settings.vendorOrders;
    if (!vendorOrdersCfg) throw new Error('config/vendor-orders.json not loaded');

    return runAllScheduledOrders(page, settings, opts);
}

module.exports = {
    runVendorOrderEntry,
    runAllScheduledOrders,
    processOneVendorOrder,
    buildOrderQueue,
    fillOrderLineQuantities,
    clickUpdateOnly,
    clickClearQuantities,
    waitForOrderItemsGrid,
    scrapeOrderGridByItemCode,
};
