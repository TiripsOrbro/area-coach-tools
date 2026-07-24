#!/usr/bin/env node
/** Open Stock Count page and dump link labels + completion hints. */
const path = require('path');
const fs = require('fs');
const { getSettings } = require('../src/config');
const { launchBrowser, loginMacromatix } = require('../src/mmx-auth');
const { GOTO_OPTS } = require('../src/mmx-browser');
const { probeGatePage, evaluateGateComplete } = require('../src/pipeline-gate-key-item-count');
const { ensureDir } = require('../src/util-files');
const log = require('../src/util-logging');

const STOCK_COUNT_URL =
    'https://tacobellau.macromatix.net/MMS_Stores_StockCount.aspx?MenuCustomItemID=156';

async function main() {
    const settings = getSettings();
    const gate = settings.pipeline.gate;
    ensureDir(settings.outDir);
    const outFile = path.join(settings.outDir, 'stock-count-probe.json');

    let browser;
    let page;
    try {
        ({ browser, page } = await launchBrowser(settings));
        await loginMacromatix(page, {
            navTimeoutMs: settings.navTimeoutMs,
            loginWaitMs: settings.loginWaitMs,
            loginSuccessUrlPart: settings.loginSuccessUrlPart,
        });

        await page.goto(STOCK_COUNT_URL, { ...GOTO_OPTS, timeout: settings.navTimeoutMs });
        await page.waitForTimeout(3000);

        const probe = await probeGatePage(page, gate);
        const complete = await evaluateGateComplete(page, gate);
        const links = await page.evaluate(() =>
            Array.from(document.querySelectorAll('a[href]')).map((a) => ({
                text: (a.textContent || '').replace(/\s+/g, ' ').trim(),
                href: a.href,
            }))
        );
        const reportish = links.filter(
            (l) => /stock|hand|order|export|report|excel|count|key/i.test(`${l.text} ${l.href}`)
        );

        const payload = { url: page.url(), probe, complete, reportish, allLinks: links };
        fs.writeFileSync(outFile, JSON.stringify(payload, null, 2));
        log.info(`Stock count complete=${complete}`);
        log.info(`Saved → ${outFile}`);
        reportish.slice(0, 30).forEach((l) => log.info(`  ${l.text} → ${l.href}`));
        process.exit(0);
    } catch (err) {
        log.error(err.message, err.stack);
        process.exit(1);
    } finally {
        if (browser) await browser.close().catch(() => {});
    }
}

main();
