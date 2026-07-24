const { GOTO_OPTS } = require('./mmx-browser');
const { withPageContextRetry } = require('./mmx-context-retry');
const { setReportStartDate, setReportEndDate } = require('./mmx-rad-date-picker');
const { resolveReportDate } = require('./util-dates');
const log = require('./util-logging');

async function openReportSelectionPage(page, reportNav, navTimeoutMs) {
    log.info(`Opening Report Selection: ${reportNav.url}`);
    await page.goto(reportNav.url, { ...GOTO_OPTS, timeout: navTimeoutMs });
    await page.waitForTimeout(reportNav.waitAfterNavigateMs || 2000);
}

async function setGroupDropdown(page, groupName) {
    const set = await page.evaluate((group) => {
        const want = group.toLowerCase();
        for (const sel of document.querySelectorAll('select')) {
            const ctx = ((sel.closest('tr, td, div') || sel).innerText || '').toLowerCase();
            if (!ctx.includes('group') && !Array.from(sel.options).some((o) => o.text.toLowerCase().includes('supply'))) {
                continue;
            }
            for (const opt of sel.options) {
                if ((opt.textContent || '').trim().toLowerCase().includes(want)) {
                    sel.value = opt.value;
                    sel.dispatchEvent(new Event('change', { bubbles: true }));
                    return opt.textContent.trim();
                }
            }
        }
        for (const sel of document.querySelectorAll('select')) {
            for (const opt of sel.options) {
                if ((opt.textContent || '').trim().toLowerCase().includes(want)) {
                    sel.value = opt.value;
                    sel.dispatchEvent(new Event('change', { bubbles: true }));
                    return opt.textContent.trim();
                }
            }
        }
        return null;
    }, groupName);

    if (!set) throw new Error(`Group dropdown: could not select "${groupName}"`);
    log.info(`Group set to: ${set}`);
    const settleMs = Number(process.env.MMX_REPORT_GROUP_SETTLE_MS || 3000);
    await page.waitForTimeout(settleMs);
}

async function listReportOptions(page, opts = {}) {
    const loose = Boolean(opts.loose);
    return page.evaluate((looseMode) => {
        const out = [];
        for (const sel of document.querySelectorAll('select')) {
            const label = ((sel.closest('tr, td') || sel).innerText || '').slice(0, 120);
            const hasInventory = Array.from(sel.options).some((o) => /inventory|special event/i.test(o.text));
            const hasScm = Array.from(sel.options).some((o) => /scm|items on/i.test(o.text));
            if (!looseMode && !label.toLowerCase().includes('report') && !hasScm) continue;
            if (looseMode && !label.toLowerCase().includes('report') && !hasInventory && !hasScm) continue;
            const options = Array.from(sel.options)
                .map((o) => (o.textContent || '').trim())
                .filter(Boolean);
            if (options.length) out.push({ label, options: options.slice(0, 12) });
        }
        return out;
    }, loose);
}

async function waitForReportInList(page, reportName, opts = {}) {
    const loose = Boolean(opts.loose);
    const timeoutMs = Number(process.env.MMX_REPORT_LIST_WAIT_MS || 25000);
    try {
        await page.waitForFunction(
            (name, looseMode) => {
                const want = name.toLowerCase();
                for (const sel of document.querySelectorAll('select')) {
                    const label = ((sel.closest('tr, td') || sel).innerText || '').toLowerCase();
                    const hasInventory = Array.from(sel.options).some((o) => /inventory|special event/i.test(o.text));
                    const hasScm = Array.from(sel.options).some((o) => /scm|items on/i.test(o.text));
                    if (!looseMode && !label.includes('report') && !hasScm) continue;
                    if (looseMode && !label.includes('report') && !hasInventory && !hasScm) continue;
                    for (const opt of sel.options) {
                        const t = (opt.textContent || '').trim();
                        if (t.toLowerCase().includes(want) || want.includes(t.toLowerCase())) return true;
                    }
                }
                return false;
            },
            { timeout: timeoutMs },
            reportName,
            loose
        );
    } catch (err) {
        const lists = await listReportOptions(page, opts).catch(() => []);
        log.warn(`Report list never showed "${reportName}" (${timeoutMs}ms). Visible lists:`, JSON.stringify(lists));
        throw err;
    }
}

async function selectReportInList(page, reportName, opts = {}) {
    const loose = Boolean(opts.loose);
    await waitForReportInList(page, reportName, opts);
    const picked = await page.evaluate(
        (name, looseMode) => {
        const want = name.toLowerCase();
        for (const sel of document.querySelectorAll('select')) {
            const label = ((sel.closest('tr, td') || sel).innerText || '').toLowerCase();
            const hasInventory = Array.from(sel.options).some((o) => /inventory|special event/i.test(o.text));
            const hasScm = Array.from(sel.options).some((o) => /scm|items on/i.test(o.text));
            if (
                !looseMode &&
                !label.includes('report') &&
                !hasScm
            ) {
                continue;
            }
            if (looseMode && !label.includes('report') && !hasInventory && !hasScm) {
                continue;
            }
            for (const opt of sel.options) {
                const t = (opt.textContent || '').trim();
                if (t.toLowerCase().includes(want) || want.includes(t.toLowerCase())) {
                    if (sel.multiple) {
                        for (const o of sel.options) o.selected = false;
                    }
                    opt.selected = true;
                    sel.dispatchEvent(new Event('change', { bubbles: true }));
                    sel.dispatchEvent(new Event('click', { bubbles: true }));
                    return t;
                }
            }
        }
        return null;
    },
        reportName,
        loose
    );

    if (!picked) {
        const lists = await listReportOptions(page, opts).catch(() => []);
        log.warn(`Reports list: could not select "${reportName}". Visible lists:`, JSON.stringify(lists));
        throw new Error(`Reports list: could not select "${reportName}"`);
    }
    log.info(`Report selected: ${picked}`);
    await page.waitForTimeout(2000);
}

function formatNeedles(formatText) {
    const want = String(formatText || '').trim().toLowerCase();
    const needles = new Set([want]);
    if (want === 'csv') {
        needles.add('comma');
        needles.add('delimited');
        needles.add('separated');
    }
    if (want.includes('excel')) {
        needles.add('excel data only');
        needles.add('data only');
    }
    return [...needles];
}

async function pickFormatInPage(page, needles) {
    return page.evaluate((needlesArr) => {
        const matches = (text) => {
            const t = String(text || '').trim().toLowerCase();
            return needlesArr.some((n) => t.includes(n) || (n.length > 3 && t === n));
        };
        for (const sel of document.querySelectorAll('select')) {
            const near = (sel.closest('tr, td, div') || sel).innerText || '';
            if (
                !/excel|format|report|csv|comma/i.test(near) &&
                !Array.from(sel.options).some((o) => /excel|csv|comma/i.test(o.text))
            ) {
                continue;
            }
            for (const opt of sel.options) {
                if (matches(opt.textContent)) {
                    sel.value = opt.value;
                    sel.dispatchEvent(new Event('change', { bubbles: true }));
                    return opt.textContent.trim();
                }
            }
        }
        for (const sel of document.querySelectorAll('select')) {
            for (const opt of sel.options) {
                if (matches(opt.textContent)) {
                    sel.value = opt.value;
                    sel.dispatchEvent(new Event('change', { bubbles: true }));
                    return opt.textContent.trim();
                }
            }
        }
        for (const inp of document.querySelectorAll('input[type="radio"]')) {
            const label =
                (inp.id && document.querySelector(`label[for="${inp.id}"]`)?.textContent) ||
                inp.parentElement?.textContent ||
                '';
            if (matches(label)) {
                inp.click();
                return label.trim().slice(0, 80);
            }
        }
        return null;
    }, needles);
}

async function setReportFormat(page, formatText) {
    const needles = formatNeedles(formatText);

    await page
        .waitForFunction(
            () => {
                for (const sel of document.querySelectorAll('select')) {
                    if (Array.from(sel.options).some((o) => /excel|csv|comma|format/i.test(o.textContent || ''))) {
                        return true;
                    }
                }
                return document.querySelectorAll('input[type="radio"]').length > 0;
            },
            { timeout: 20000 }
        )
        .catch(() => null);
    await page.waitForTimeout(1500);

    let picked = null;
    for (let attempt = 1; attempt <= 4; attempt++) {
        picked = await pickFormatInPage(page, needles);
        if (picked) break;
        log.warn(`Format "${formatText}" not ready (attempt ${attempt}/4), waiting…`);
        await page.waitForTimeout(1500);
    }

    if (!picked) {
        const available = await page.evaluate(() => {
            const out = [];
            for (const sel of document.querySelectorAll('select')) {
                const opts = Array.from(sel.options).map((o) => o.textContent.trim());
                if (opts.some((o) => /excel|csv|format|comma/i.test(o))) out.push(...opts);
            }
            return [...new Set(out)].slice(0, 20).join(' | ');
        });
        throw new Error(
            `Format dropdown: could not select "${formatText}"` +
                (available ? `. Options seen: ${available}` : '')
        );
    }
    log.info(`Report format: ${picked}`);
    await page.waitForTimeout(500);
}

async function setStartDate(page, dateText) {
    return setReportStartDate(page, dateText);
}

async function setEndDate(page, dateText) {
    return setReportEndDate(page, dateText);
}

function storeNeedles(storeName) {
    const s = String(storeName || '').trim();
    const needles = new Set();
    if (s) needles.add(s.toLowerCase());
    const nameOnly = s.replace(/^\d+\s*/, '').trim().toLowerCase();
    if (nameOnly) needles.add(nameOnly);
    const num = s.match(/\b(\d{4})\b/);
    if (num) needles.add(num[1]);
    return [...needles];
}

async function tryStoreDropdown(page, needle) {
    return page.evaluate((want) => {
        const matchesStore = (text) => {
            const t = String(text || '').trim().toLowerCase();
            if (!t) return false;
            if (/^\d+$/.test(want)) {
                const escaped = want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                return new RegExp(`(^|\\D)${escaped}(\\D|$)`).test(t);
            }
            return t.includes(want) || want.includes(t);
        };
        for (const sel of document.querySelectorAll('select')) {
            const ctx = ((sel.closest('tr, td, div, table') || sel).innerText || '').toLowerCase();
            if (!ctx.includes('store') && !Array.from(sel.options).some((o) => /\b\d{4}\b/.test(o.text))) {
                continue;
            }
            for (const opt of sel.options) {
                if (matchesStore(opt.textContent)) {
                    sel.value = opt.value;
                    sel.dispatchEvent(new Event('change', { bubbles: true }));
                    return opt.textContent.trim();
                }
            }
        }
        return null;
    }, needle);
}

async function expandStoreTree(page, hints = []) {
    const needles = [
        'tba area',
        'collins food',
        'tba market',
        'wa-1',
        'wa 1',
        'western australia',
        'area 1',
        'area 22',
        'area 21',
        ...hints.map((h) => String(h || '').toLowerCase()).filter(Boolean),
    ];
    await page.evaluate((list) => {
        for (const el of document.querySelectorAll('a, span, label, div, img, td, li')) {
            const t = (el.textContent || el.title || '').replace(/\s+/g, ' ').trim().toLowerCase();
            if (!t || t.length > 80) continue;
            if (list.some((n) => t.includes(n))) {
                try {
                    el.click();
                } catch (e) {
                    /* ignore */
                }
            }
        }
        // SCM On Hand / On Order: expand collapsed RadTreeView nodes so store rows appear
        for (const plus of document.querySelectorAll('.rtPlus')) {
            try {
                plus.click();
            } catch (e) {
                /* ignore */
            }
        }
    }, needles);
    await page.waitForTimeout(1200);
}

async function tryStoreTree(page, needle) {
    await expandStoreTree(page);

    return page.evaluate((want) => {
        const matchesStore = (text) => {
            const t = String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
            if (!t) return false;
            if (/^\d+$/.test(want)) {
                const escaped = want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                return new RegExp(`(^|\\D)${escaped}(\\D|$)`).test(t);
            }
            return t.includes(want);
        };
        for (const cb of document.querySelectorAll('input[type="checkbox"]')) {
            const row = cb.closest('tr, div, li, span, label') || cb.parentElement;
            const text = (row && row.textContent ? row.textContent : '').replace(/\s+/g, ' ').toLowerCase();
            if (matchesStore(text)) {
                row?.scrollIntoView?.({ block: 'center' });
                if (!cb.checked) cb.click();
                return text.trim().slice(0, 80);
            }
        }
        for (const el of document.querySelectorAll('label, span, a, option, td')) {
            const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
            if (matchesStore(t) && t.length < 60) {
                el.scrollIntoView?.({ block: 'center' });
                const cb = el.querySelector('input[type="checkbox"]') || el.previousElementSibling;
                if (cb && cb.type === 'checkbox') {
                    if (!cb.checked) cb.click();
                    return t;
                }
            }
        }
        return null;
    }, needle);
}

async function tryStoreClickByText(page, needle) {
    const handle = await page.evaluateHandle((want) => {
        const matchesStore = (text) => {
            const t = String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
            if (!t) return false;
            if (/^\d+$/.test(want)) {
                const escaped = want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                return new RegExp(`(^|\\D)${escaped}(\\D|$)`).test(t);
            }
            return t.includes(want);
        };
        for (const el of document.querySelectorAll('label, span, a, td, div')) {
            const t = (el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
            if (!matchesStore(t) || t.length > 70) continue;
            if (el.children.length > 4) continue;
            const cb = el.querySelector('input[type="checkbox"]');
            if (cb) return cb;
            if (/\b\d{4}\b/.test(t)) return el;
        }
        return null;
    }, needle);
    const el = handle.asElement();
    if (!el) return null;
    await el.evaluate((node) => node.scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(200);
    await el.click();
    const label = await el.evaluate((node) => {
        const row = node.closest('tr, div, li, span, label') || node;
        return (row.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    });
    return label || needle;
}

async function tryStoreInFrames(page, needles) {
    for (const frame of page.frames()) {
        if (frame === page.mainFrame()) continue;
        for (const needle of needles) {
            try {
                const picked = await frame.evaluate((want) => {
                    const matchesStore = (text) => {
                        const t = String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
                        if (!t) return false;
                        if (/^\d+$/.test(want)) {
                            const escaped = want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                            return new RegExp(`(^|\\D)${escaped}(\\D|$)`).test(t);
                        }
                        return t.includes(want);
                    };
                    for (const cb of document.querySelectorAll('input[type="checkbox"]')) {
                        const row = cb.closest('tr, div, li, span, label') || cb.parentElement;
                        const text = (row?.textContent || '').replace(/\s+/g, ' ').toLowerCase();
                        if (matchesStore(text)) {
                            if (!cb.checked) cb.click();
                            return text.trim().slice(0, 80);
                        }
                    }
                    for (const sel of document.querySelectorAll('select')) {
                        for (const opt of sel.options) {
                            if (matchesStore(opt.textContent)) {
                                sel.value = opt.value;
                                sel.dispatchEvent(new Event('change', { bubbles: true }));
                                return opt.textContent.trim();
                            }
                        }
                    }
                    return null;
                }, needle);
                if (picked) return picked;
            } catch (e) {
                /* frame detached */
            }
        }
    }
    return null;
}

async function selectStore(page, storeName, opts = {}) {
    if (opts.waitMs) await page.waitForTimeout(opts.waitMs);

    const storeNumber = String(
        opts.storeNumber || String(storeName || '').match(/\b(\d{3,6})\b/)?.[1] || ''
    ).trim();
    const needles = storeNeedles(storeName);

    // Prefer RadCombo / dropdown, then SCM Zone Filter when needed.
    // Do not default-skip the tree — SelectStore login does not scope Flat SOH/SOO.
    try {
        const advanced = require('../../mmx/src/mmxReports/pipeline-supply-chain-reports');
        if (typeof advanced.selectStore === 'function') {
            log.info(`Selecting store via MMX report picker: ${storeNumber || storeName}`);
            await advanced.selectStore(page, storeName, {
                ...opts,
                storeNumber,
                skipTree: opts.skipTree === true,
            });
            return;
        }
    } catch (err) {
        log.warn(`Advanced store picker unavailable (${err.message}) — using built-in`);
    }

    for (const needle of needles) {
        const fromDropdown = await tryStoreDropdown(page, needle);
        if (fromDropdown) {
            log.info(`Store selected (dropdown): ${fromDropdown}`);
            await page.waitForTimeout(500);
            return;
        }
    }

    if (opts.skipTree !== true) {
        const hints = ['wa-1', 'western australia', 'tba area', 'tba market', 'collins food'];
        await expandStoreTree(page, hints);
        await page.waitForTimeout(800);
        await expandStoreTree(page, hints);

        if (storeNumber) {
            const checked = await page.evaluate((want) => {
                const re = new RegExp(`(^|\\D)${want}(\\D|$)`);
                for (const cb of document.querySelectorAll(
                    '.RadTreeView input[type="checkbox"], input.rtChk, input[type="checkbox"]'
                )) {
                    const row = cb.closest('label, li, tr, div, span') || cb.parentElement;
                    const text = (row?.textContent || '').replace(/\s+/g, ' ').trim();
                    if (!re.test(text)) continue;
                    row?.scrollIntoView?.({ block: 'center' });
                    if (!cb.checked) cb.click();
                    return text.slice(0, 80);
                }
                return null;
            }, storeNumber);
            if (checked) {
                log.info(`Store selected (tree checkbox): ${checked}`);
                await page.waitForTimeout(500);
                return;
            }
        }

        for (const needle of needles) {
            const fromTree = await tryStoreTree(page, needle);
            if (fromTree) {
                log.info(`Store selected: ${fromTree}`);
                await page.waitForTimeout(500);
                return;
            }
        }
    }

    for (const needle of needles) {
        const clicked = await tryStoreClickByText(page, needle);
        if (clicked) {
            log.info(`Store selected (click): ${clicked}`);
            await page.waitForTimeout(500);
            return;
        }
    }

    const fromFrame = await tryStoreInFrames(page, needles);
    if (fromFrame) {
        log.info(`Store selected (frame): ${fromFrame}`);
        await page.waitForTimeout(500);
        return;
    }

    // Already scoped via SelectStore login — allow continue when the number is on-page.
    if (storeNumber) {
        const onPage = await page.evaluate((want) => {
            const body = (document.body?.innerText || '').replace(/\s+/g, ' ');
            return new RegExp(`\\b${want}\\b`).test(body.slice(0, 20000));
        }, storeNumber);
        if (onPage) {
            log.info(`Store ${storeNumber} already present in page context — continuing`);
            return;
        }
    }

    if (opts.optional) {
        log.warn(`Store not found for "${storeName}" — continuing (optional)`);
        return;
    }

    throw new Error(`Store: could not select "${storeName}" (tried: ${needles.join(', ')})`);
}

async function clickGenerate(page, buttonText = 'Generate') {
    const clicked = await page.evaluate((label) => {
        const want = label.toLowerCase();
        for (const el of document.querySelectorAll('input, button, a')) {
            const t = (el.value || el.textContent || '').trim().toLowerCase();
            if (t === want || t.includes(want)) {
                el.click();
                return t || label;
            }
        }
        return null;
    }, buttonText);

    if (!clicked) throw new Error(`Generate button not found`);
    log.info('Clicked Generate');
    await page.waitForTimeout(1000);
}

function dateOpts(report) {
    return { timeZone: report.timeZone, dateOnly: Boolean(report.dateOnly) };
}

async function configureAndGenerateReport(page, report, reportNav) {
    const storeNumber = String(
        report.scmTreeStoreNumber ||
            report.storeNumber ||
            String(report.storeName || '').match(/\b(\d{3,6})\b/)?.[1] ||
            ''
    ).trim();

    // Prefer the full MMX report configurator (dates + SCM Zone Filter checkbox).
    try {
        const advanced = require('../../mmx/src/mmxReports/pipeline-supply-chain-reports');
        if (typeof advanced.configureAndGenerateReport === 'function') {
            log.info(
                `Configuring ${report.label || report.id} via MMX pipeline` +
                    (storeNumber ? ` (SCM tree store ${storeNumber})` : '')
            );
            await advanced.configureAndGenerateReport(
                page,
                {
                    ...report,
                    storeNumber: storeNumber || report.storeNumber,
                    scmTreeStoreNumber:
                        report.type === 'supplyChain' && storeNumber
                            ? storeNumber
                            : report.scmTreeStoreNumber,
                    skipStoreTree: false,
                },
                reportNav
            );
            return;
        }
    } catch (err) {
        log.warn(`Advanced SCM configurator unavailable (${err.message}) — using built-in`);
    }

    await openReportSelectionPage(page, reportNav, report.navTimeoutMs || 45000);
    await setGroupDropdown(page, report.group || 'Supply Chain');
    await selectReportInList(page, report.reportName);
    await setReportFormat(page, report.format || 'Excel Data Only');
    await page.waitForTimeout(1000);

    const startDate = resolveReportDate(report.startDate || 'lastWeekMonday', dateOpts(report));
    await setStartDate(page, startDate);

    if (report.endDate) {
        const endDate = resolveReportDate(report.endDate, dateOpts(report));
        await setEndDate(page, endDate);
    }

    if (storeNumber) {
        try {
            const advanced = require('../../mmx/src/mmxReports/pipeline-supply-chain-reports');
            if (typeof advanced.selectScmStoreCheckboxInTree === 'function') {
                await page.waitForTimeout(800);
                await advanced.selectScmStoreCheckboxInTree(page, storeNumber, report.storeName);
            } else {
                await selectStore(page, report.storeName, {
                    storeNumber,
                    waitMs: 300,
                    skipTree: false,
                });
            }
        } catch (err) {
            log.warn(`SCM tree select failed (${err.message}) — trying generic store picker`);
            await selectStore(page, report.storeName, {
                storeNumber,
                waitMs: 300,
                skipTree: false,
            });
        }
    } else if (report.storeName) {
        await selectStore(page, report.storeName, { waitMs: 300, skipTree: false });
    }

    await clickGenerate(page, report.generateButtonText || 'Generate');
}

async function runSupplyChainReport(page, report, settings) {
    const reportNav = settings.pipeline.reportNavigation;
    if (!reportNav?.url) {
        throw new Error('pipeline.reportNavigation.url is required');
    }

    const cfg = {
        ...report,
        navTimeoutMs: settings.navTimeoutMs,
    };

    await withPageContextRetry(page, `supply chain ${report.id}`, async () => {
        await configureAndGenerateReport(page, cfg, reportNav);
    });
}

function isSupplyChainReport(report) {
    return report.type === 'supplyChain';
}

module.exports = {
    openReportSelectionPage,
    setGroupDropdown,
    selectReportInList,
    setReportFormat,
    setStartDate,
    setEndDate,
    selectStore,
    clickGenerate,
    configureAndGenerateReport,
    runSupplyChainReport,
    isSupplyChainReport,
};
