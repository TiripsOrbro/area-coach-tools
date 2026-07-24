const fs = require('fs');
const path = require('path');
const { GOTO_OPTS } = require('./mmx-browser');
const {
    openCountInProgressTab,
    isOnNewCountTab,
    isOnCountInProgressTab,
    readLatestCountEntry,
    isKeyItemCountApplied,
    countOptionMatchesType,
    countOptionIncludesApplied,
    selectCountOptionByIndex,
    readAppliedStatusBelowCount,
    isAppliedInCountHeader,
} = require('./mmx-navigation');
const { withPageContextRetry } = require('./mmx-context-retry');
const log = require('./util-logging');

function gateUrlConfigured(gate) {
    return Boolean(gate && gate.url && !String(gate.url).includes('REPLACE'));
}

async function probeGatePage(page, gate) {
    const info = {
        url: page.url(),
        title: await page.title(),
        latestCount: null,
        hints: [],
    };

    try {
        info.latestCount = await readLatestCountEntry(page);
        info.onCountInProgressTab = await isOnCountInProgressTab(page);
        info.onNewCountTab = await isOnNewCountTab(page);
        if (info.latestCount) {
            info.hints.push(`Latest count: "${info.latestCount.latest}"`);
            if (info.latestCount.options?.length) {
                info.hints.push(`Options: ${info.latestCount.options.join(' | ')}`);
            }
            info.ready = isKeyItemCountApplied(info.latestCount, gate);
        }
    } catch (e) {
        info.hints.push(`Probe error: ${e.message}`);
    }

    return info;
}

async function evaluateGateComplete(page, gate) {
    if (gate.evaluateComplete) {
        const min = Math.max(0, Number(gate.minCompleteCount) || 1);
        return page.evaluate((expr, minCount) => {
            // eslint-disable-next-line no-eval
            const fn = eval(`(${expr})`);
            return Boolean(fn(document, minCount));
        }, gate.evaluateComplete, min);
    }

    if (gate.completeSelector) {
        const min = Math.max(0, Number(gate.minCompleteCount) || 1);
        const count = await page.evaluate((sel) => document.querySelectorAll(sel).length, gate.completeSelector);
        return count >= min;
    }

    const entry = await readLatestCountEntry(page);

    if (!entry || !entry.options?.length) {
        log.info('No count found in Count In Progress dropdown');
        return false;
    }

    const latest = entry.options[0];
    log.info(`Latest in-progress count: "${latest}" (${entry.source})`);
    if (entry.options.length > 1) {
        log.info(`Other recent: ${entry.options.slice(1, 4).join(' | ')}`);
    }

    if (isKeyItemCountApplied({ latest }, gate)) {
        return true;
    }

    if (!countOptionMatchesType(latest, gate)) {
        log.info('Latest count is not Key Item Count — gate not ready');
        return false;
    }

    log.info('Latest is Key Item Count; checking Applied status box below count dropdown…');
    await selectCountOptionByIndex(page, 0);
    await page.waitForTimeout(800);

    const appliedStatus = await readAppliedStatusBelowCount(page, gate);
    if (appliedStatus.exactAppliedBox) {
        log.info(`Applied status box: found (${appliedStatus.exactAppliedBoxCount} element(s))`);
    } else if (appliedStatus.appliedAtLine && appliedStatus.authorisedLine) {
        log.info('Applied status: Authorised By + Applied at lines present');
    } else {
        log.info('Applied status box: NOT found in count header');
        if (appliedStatus.headerSnippet) {
            log.info(`Header area: ${appliedStatus.headerSnippet.slice(0, 200)}…`);
        }
    }

    return isAppliedInCountHeader(appliedStatus);
}

async function isKeyItemCountComplete(page, gate, navTimeoutMs, options = {}) {
    if (!gateUrlConfigured(gate)) {
        log.warn('Gate URL not configured (set gate.url in config/pipeline.json or MMX_GATE_URL in .env)');
        return false;
    }

    log.info(`Opening Stock Count gate: ${gate.url}`);
    await page.goto(gate.url, { ...GOTO_OPTS, timeout: navTimeoutMs });

    if (gate.readySelector) {
        await page.waitForSelector(gate.readySelector, { timeout: navTimeoutMs });
    }
    await page.waitForTimeout(1200);

    await openCountInProgressTab(page);

    const probe = await probeGatePage(page, gate);
    log.info(`Gate page title: ${probe.title}`);
    probe.hints.forEach((h) => log.info(h));

    const result = await withPageContextRetry(page, 'key item gate', () => evaluateGateComplete(page, gate));

    log.info(
        `Key item gate: ${result ? 'COMPLETE (Key Item Count + Applied)' : 'NOT READY — need latest Key Item Count with Applied'}`
    );

    if (options.saveDiagnostics && options.outDir) {
        const outDir = path.join(options.outDir, 'gate-diagnostics');
        fs.mkdirSync(outDir, { recursive: true });
        const stamp = Date.now();
        const jsonPath = path.join(outDir, `gate-${stamp}.json`);
        fs.writeFileSync(
            jsonPath,
            JSON.stringify({ gate, probe, result, evaluatedAt: new Date().toISOString() }, null, 2)
        );
        log.info(`Gate diagnostics: ${jsonPath}`);
        try {
            await page.screenshot({ path: path.join(outDir, `gate-${stamp}.png`), fullPage: false });
        } catch (e) {
            log.warn(`Screenshot skipped: ${e.message}`);
        }
    }

    return result;
}

module.exports = {
    isKeyItemCountComplete,
    gateUrlConfigured,
    probeGatePage,
    evaluateGateComplete,
};
