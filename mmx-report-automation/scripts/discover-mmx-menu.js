#!/usr/bin/env node
/**
 * Log into Macromatix and list menu links (helps find Key Item Count + report URLs).
 * Run with SCRAPER_HEADLESS=false to watch the browser on first login.
 *
 *   npm run discover
 */
const path = require('path');
const fs = require('fs');
const { getSettings, ROOT } = require('../src/config');
const { launchBrowser, loginMacromatix } = require('../src/mmx-auth');
const { BASE_URL, GOTO_OPTS } = require('../src/mmx-browser');
const { ensureDir } = require('../src/util-files');
const log = require('../src/util-logging');

const KEYWORDS = /key|item|count|stock|inventory|hand|order|build/i;

async function collectLinks(page) {
    return page.evaluate(() => {
        const out = [];
        for (const a of document.querySelectorAll('a[href]')) {
            const href = a.href || '';
            const text = (a.textContent || '').replace(/\s+/g, ' ').trim();
            if (!href || href.startsWith('javascript:')) continue;
            out.push({ text, href });
        }
        return out;
    });
}

async function main() {
    const settings = getSettings();
    ensureDir(settings.outDir);
    const outFile = path.join(settings.outDir, 'mmx-menu-links.json');

    let browser;
    let page;
    try {
        ({ browser, page } = await launchBrowser(settings));
        await loginMacromatix(page, {
            navTimeoutMs: settings.navTimeoutMs,
            loginWaitMs: settings.loginWaitMs,
            loginSuccessUrlPart: settings.loginSuccessUrlPart,
        });

        const hubs = [
            'https://tacobellau.macromatix.net/MMS_Stores_LabourScheduler.aspx?MenuCustomItemID=249',
            'https://tacobellau.macromatix.net/mms_stores_scheduledorders.aspx',
            BASE_URL,
        ];
        const allLinks = [];
        const seen = new Set();
        for (const hub of hubs) {
            log.info(`Scanning links at ${hub}`);
            await page.goto(hub, { ...GOTO_OPTS, timeout: settings.navTimeoutMs });
            await page.waitForTimeout(2500);
            const batch = await collectLinks(page);
            for (const l of batch) {
                const key = `${l.href}|${l.text}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    allLinks.push({ ...l, fromHub: hub });
                }
            }
        }

        const links = allLinks;
        const interesting = links.filter((l) => KEYWORDS.test(l.text) || KEYWORDS.test(l.href));
        const payload = {
            collectedAt: new Date().toISOString(),
            currentUrl: page.url(),
            totalLinks: links.length,
            interesting,
            allLinks: links,
        };

        fs.writeFileSync(outFile, JSON.stringify(payload, null, 2));
        log.info(`Saved ${links.length} links (${interesting.length} matching keywords) → ${outFile}`);
        log.info('Keyword matches (set MMX_GATE_URL or pipeline.json gate.url):');
        for (const l of interesting.slice(0, 40)) {
            log.info(`  ${l.text || '(no text)'} → ${l.href}`);
        }

        await page.waitForTimeout(3000);
        process.exit(0);
    } catch (err) {
        log.error(err.message, err.stack);
        process.exit(1);
    } finally {
        if (browser) await browser.close().catch(() => {});
    }
}

main();
