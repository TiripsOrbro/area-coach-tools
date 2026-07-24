#!/usr/bin/env node
/**
 * Test vendor order entry from Build To JS.xlsx → scheduled orders → Update (no Submit).
 * Browser stays open when MMX_KEEP_BROWSER_OPEN=1 (default for this script).
 *
 *   npm run orders-test                    # all openable scheduled orders (top → bottom)
 *   npm run orders-test -- --vendor bega   # one vendor only
 *
 * Uses scheduled orders date from config (default tomorrow). Update only — never Submit.
 */
const { getSettings, loadJson } = require('./config');
const { launchBrowser, loginMacromatix } = require('./mmx-auth');
const { runVendorOrderEntry } = require('./pipeline-enter-vendor-orders');
const log = require('./util-logging');

function parseArgs() {
    const argv = process.argv.slice(2);
    let vendorId = process.env.MMX_ORDER_VENDOR_ID || '';
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--vendor' && argv[i + 1]) vendorId = argv[++i];
    }
    return { vendorId: vendorId || undefined };
}

async function main() {
    if (!loadJson('config/vendor-orders.json', false)) {
        console.error('Missing config/vendor-orders.json');
        process.exit(1);
    }

    const { vendorId } = parseArgs();
    const settings = getSettings();
    if (!settings.vendorOrders) {
        console.error('vendor-orders config failed to load');
        process.exit(1);
    }

    const keepOpen = !/^(0|false|no|off)$/i.test(
        String(process.env.MMX_KEEP_BROWSER_OPEN ?? 'true').trim()
    );

    let browser;
    let page;
    try {
        ({ browser, page } = await launchBrowser(settings));
        await loginMacromatix(page, {
            navTimeoutMs: settings.navTimeoutMs,
            loginWaitMs: settings.loginWaitMs,
            loginSuccessUrlPart: settings.loginSuccessUrlPart,
            storeName: settings.storeName,
            storeNumber: String(settings.storeName || '').match(/\b(\d{3,6})\b/)?.[1] || '',
        });

        const result = await runVendorOrderEntry(page, settings, { vendorId });

        if (result.processed?.length > 1) {
            log.info(
                `Order entry complete: ${result.processed.filter((p) => p.ok).length}/${result.processed.length} orders`
            );
            for (const p of result.processed) {
                log.info(`  ${p.ok ? 'OK' : 'FAIL'} ${p.label} (${p.lines} lines)${p.error ? `: ${p.error}` : ''}`);
            }
        } else if (result.vendor) {
            log.info('Order entry test complete:', {
                vendor: result.vendor.label,
                vendorId: result.vendor.id,
                lines: result.lines?.length ?? 0,
            });
        }

        if (keepOpen) {
            log.info('Browser left open — review the order screen, then press Ctrl+C to exit.');
            await new Promise(() => {});
        }
    } catch (err) {
        log.error(err.message, err.stack);
        if (keepOpen && browser) {
            log.info('Error occurred — browser left open for inspection. Press Ctrl+C to exit.');
            await new Promise(() => {});
        }
        process.exit(1);
    } finally {
        if (browser && !keepOpen) {
            await browser.close().catch(() => {});
        }
    }
}

main();
