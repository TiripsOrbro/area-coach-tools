const { withPageContextRetry } = require('./mmx-context-retry');
const {
    openScheduledOrders,
    returnToScheduledOrders,
    scrapeScheduledOrders,
    clickCreateForVendorRow,
    vendorRegex,
    classMatches,
    rowIsOpenable,
} = require('./mmx-scheduled-orders');
const { readVendorOrderLines, readAllVendorOrderLines } = require('./pipeline-read-vendor-orders');
const log = require('./util-logging');

function normalizeItemCode(code) {
    return String(code || '')
        .replace(/\s+/g, ' ')
        .trim()
        .toUpperCase();
}

async function waitForOrderItemsGrid(page, timeoutMs = 30000) {
    await page.waitForFunction(
        () => {
            for (const table of document.querySelectorAll('table')) {
                const header = (table.querySelector('tr')?.innerText || '').toLowerCase();
                if (header.includes('item code') && header.includes('quantity')) {
                    const inputs = table.querySelectorAll('input[type="text"]');
                    if (inputs.length) return true;
                }
            }
            return (document.body?.innerText || '').toLowerCase().includes('items in this order');
        },
        { timeout: timeoutMs }
    );
    await page.waitForTimeout(500);
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

async function clickButtonByLabel(page, label, { required = true, waitAfterMs = 1500 } = {}) {
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
    if (waitAfterMs > 0) {
        await page.waitForTimeout(waitAfterMs);
        try {
            await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 });
        } catch {
            /* postback optional */
        }
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
    await page.waitForTimeout(1000);
    await waitForOrderItemsGrid(page);
}

/** Map item code → quantity input id in the "Items in this order" grid. */
async function scrapeOrderGridByItemCode(page) {
    return page.evaluate(() => {
        const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
        const normCode = (s) => norm(s).toUpperCase();

        for (const table of document.querySelectorAll('table')) {
            const trs = Array.from(table.querySelectorAll('tr'));
            if (!trs.length) continue;

            let headerRowIdx = -1;
            let codeCol = -1;
            let qtyCol = -1;

            for (let i = 0; i < Math.min(trs.length, 8); i++) {
                const cells = Array.from(trs[i].querySelectorAll('th, td'));
                const headers = cells.map((c) => norm(c.textContent).toLowerCase());
                const ci = headers.findIndex((h) => h.includes('item code'));
                const qi = headers.findIndex((h) => h === 'quantity' || h.startsWith('quantity'));
                if (ci >= 0 && qi >= 0) {
                    headerRowIdx = i;
                    codeCol = ci;
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

                const qtyCell = cells[qtyCol];
                const input = qtyCell.querySelector(
                    'input[type="text"], input:not([type="hidden"]):not([type="checkbox"])'
                );
                if (!input || input.disabled || input.offsetParent === null) continue;

                rows.push({
                    itemCode,
                    itemCodeKey: normCode(itemCode),
                    inputId: input.id || '',
                });
            }

            if (rows.length) return { rows, tableFound: true };
        }
        return { rows: [], tableFound: false };
    });
}

async function typeQuantityIntoInput(page, inputId, quantity) {
    const handle = await page.evaluateHandle((id) => document.getElementById(id), inputId);
    const el = handle.asElement();
    if (!el) {
        await handle.dispose();
        return false;
    }

    await el.click({ clickCount: 3 });
    await el.focus();
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyA');
    await page.keyboard.up('Control');
    await page.keyboard.press('Backspace');
    const text = String(quantity);
    await page.keyboard.type(text, { delay: 20 });
    await page.keyboard.press('Tab');
    await handle.dispose();
    await page.waitForTimeout(80);
    return true;
}

async function fillOrderLineQuantities(page, lines) {
    const grid = await scrapeOrderGridByItemCode(page);
    if (!grid.tableFound || !grid.rows.length) {
        throw new Error('Order items grid (Item Code / Quantity columns) not found after Create');
    }

    const byCode = new Map(grid.rows.map((r) => [r.itemCodeKey, r]));
    const results = [];

    for (const line of lines) {
        const key = normalizeItemCode(line.itemCode);
        const row = byCode.get(key);
        if (!row?.inputId) {
            results.push({ itemCode: line.itemCode, quantity: line.quantity, filled: false });
            continue;
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
    log.info(`Clicked "${clicked}" only — order not submitted`);
    await Promise.race([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {}),
        page.waitForTimeout(2500),
    ]);
    return clicked;
}

function matchVendorConfigForTableRow(tableRow, vendors) {
    return (vendors || []).find(
        (v) =>
            vendorRegex(v.vendorMatch).test(tableRow.vendor) &&
            classMatches(tableRow.orderClass, v.orderClass)
    );
}

function buildOrderQueue(parsed, vendorOrdersCfg, excelByVendorId, { vendorIdFilter } = {}) {
    const queue = [];

    for (const tableRow of parsed.rows) {
        if (!rowIsOpenable(tableRow)) continue;

        const vendorCfg = matchVendorConfigForTableRow(tableRow, vendorOrdersCfg.vendors);
        if (!vendorCfg) {
            log.info(`Skip unmapped row: ${tableRow.vendor} (${tableRow.orderClass || '?'})`);
            continue;
        }
        if (vendorIdFilter && vendorCfg.id !== vendorIdFilter) continue;

        const pack = excelByVendorId[vendorCfg.id];
        if (!pack?.lines?.length) {
            log.info(`Skip ${vendorCfg.label}: no Excel lines with qty > 0`);
            continue;
        }

        queue.push({
            vendor: vendorCfg,
            lines: pack.lines,
            tableRow,
        });
    }

    return queue;
}

async function processOneVendorOrder(page, settings, vendor, lines) {
    log.info(`${vendor.label}: ${lines.length} line(s) (qty from column K, codes from column L)`);
    for (const line of lines) {
        const name = line.itemName ? ` — ${line.itemName}` : '';
        log.info(`  order line: ${line.itemCode} × ${line.quantity}${name}`);
    }

    await clickCreateForVendorRow(page, vendor);
    await waitForOrderItemsGrid(page);

    await withPageContextRetry(page, `fill order ${vendor.id}`, async () => {
        await clickClearQuantities(page, settings.vendorOrders.orderEntry);
        await fillOrderLineQuantities(page, lines);
        await clickUpdateOnly(page, settings.vendorOrders.orderEntry);
    });
}

/**
 * Process every openable scheduled-order row (top → bottom): Create/Process → Clear Quantities → fill → Update → back to list.
 */
async function runAllScheduledOrders(page, settings, opts = {}) {
    const vendorOrdersCfg = settings.vendorOrders;
    const templatePath = settings.templateLocal;
    const vendorIdFilter = opts.vendorId || process.env.MMX_ORDER_VENDOR_ID || undefined;

    await openScheduledOrders(
        page,
        vendorOrdersCfg.scheduledOrdersUrl,
        settings.navTimeoutMs,
        vendorOrdersCfg,
        settings.storeName
    );
    const table = await scrapeScheduledOrders(page);
    const excelByVendorId = await readAllVendorOrderLines(templatePath, vendorOrdersCfg);

    const queue = buildOrderQueue(table, vendorOrdersCfg, excelByVendorId, { vendorIdFilter });
    if (!queue.length) {
        throw new Error(
            vendorIdFilter
                ? `No openable scheduled order for vendor id "${vendorIdFilter}" with Excel lines`
                : 'No openable scheduled orders with matching Excel lines'
        );
    }

    log.info(`Order queue: ${queue.length} — ${queue.map((q) => q.vendor.label).join(' → ')}`);

    const processed = [];
    for (let i = 0; i < queue.length; i++) {
        const { vendor, lines } = queue[i];
        log.info(`--- Order ${i + 1}/${queue.length}: ${vendor.label} ---`);

        if (i > 0) {
            await returnToScheduledOrders(page, vendorOrdersCfg, settings.navTimeoutMs, settings.storeName);
        }

        try {
            await processOneVendorOrder(page, settings, vendor, lines);
            processed.push({
                vendorId: vendor.id,
                label: vendor.label,
                lines: lines.length,
                ok: true,
            });
        } catch (err) {
            log.error(`Failed ${vendor.label}: ${err.message}`);
            processed.push({
                vendorId: vendor.id,
                label: vendor.label,
                lines: lines.length,
                ok: false,
                error: err.message,
            });
            if (opts.continueOnError !== false) {
                log.warn('Continuing with next order after failure');
            } else {
                throw err;
            }
            await returnToScheduledOrders(page, vendorOrdersCfg, settings.navTimeoutMs, settings.storeName).catch(
                () => {}
            );
        }
    }

    await returnToScheduledOrders(page, vendorOrdersCfg, settings.navTimeoutMs, settings.storeName);

    const failed = processed.filter((p) => !p.ok);
    if (failed.length) {
        log.warn(`${failed.length} order(s) failed:`, failed.map((f) => f.label).join(', '));
    }
    log.info(`Completed ${processed.filter((p) => p.ok).length}/${processed.length} scheduled orders`);

    const lastOk = [...processed].reverse().find((p) => p.ok);
    return {
        processed,
        vendor: lastOk ? queue.find((q) => q.vendor.id === lastOk.vendorId)?.vendor : queue[0]?.vendor,
        lines: lastOk ? queue.find((q) => q.vendor.id === lastOk.vendorId)?.lines : [],
    };
}

/**
 * Excel → scheduled orders → Create or Process → Clear Quantities → fill by item code → Update (never Submit).
 * Without vendorId: processes all openable rows on the list, in table order.
 */
async function runVendorOrderEntry(page, settings, opts = {}) {
    const vendorOrdersCfg = settings.vendorOrders;
    if (!vendorOrdersCfg) throw new Error('config/vendor-orders.json not loaded');

    const vendorId = opts.vendorId || process.env.MMX_ORDER_VENDOR_ID;
    const processAll = opts.processAll !== false && !vendorId;

    if (processAll) {
        return runAllScheduledOrders(page, settings, opts);
    }

    const templatePath = settings.templateLocal;
    const { vendor, lines } = await readVendorOrderLines(templatePath, vendorOrdersCfg, vendorId);

    if (!lines.length) {
        throw new Error(`No order lines for vendor ${vendor.label}`);
    }

    await openScheduledOrders(
        page,
        vendorOrdersCfg.scheduledOrdersUrl,
        settings.navTimeoutMs,
        vendorOrdersCfg,
        settings.storeName
    );
    await processOneVendorOrder(page, settings, vendor, lines);
    await returnToScheduledOrders(page, vendorOrdersCfg, settings.navTimeoutMs, settings.storeName);

    return { vendor, lines, processed: [{ vendorId: vendor.id, label: vendor.label, lines: lines.length, ok: true }] };
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
};
