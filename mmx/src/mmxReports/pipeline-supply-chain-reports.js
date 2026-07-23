const { GOTO_OPTS } = require('./mmx-browser');
const { withPageContextRetry } = require('./mmx-context-retry');
const { setReportStartDate, setReportEndDate, waitForDateFieldSettle } = require('./mmx-rad-date-picker');
const { resolveReportDate } = require('./util-dates');
const { getStoreConfig } = require('../../../stores/src/storeList');
const { selectStoreOnPage, assertMacromatixAuthenticated } = require('../macromatixScraper');
const {
    waitForAspPostback,
    waitForReportFormatControls,
    waitForReportSelectionPage,
    waitForScmReportList,
    clickAndWaitForPostback,
} = require('./mmx-postback');
const { refreshScrapePauseTimeout } = require('../mmxResourceGate');
const log = require('./util-logging');

async function reportSelectionPageReady(page) {
    return page.evaluate(() => {
        for (const sel of document.querySelectorAll('select')) {
            const label = ((sel.closest('tr, td') || sel).innerText || '').toLowerCase();
            if (label.includes('group')) return true;
            if (Array.from(sel.options).some((o) => /supply chain|store reports/i.test(o.textContent || ''))) {
                return true;
            }
        }
        return false;
    });
}

async function openReportSelectionPage(page, reportNav, navTimeoutMs) {
    const onReports =
        /MMS_System_Reports/i.test(page.url() || '') && (await reportSelectionPageReady(page));
    if (onReports) {
        log.info('Report Selection already open - reusing page');
        return;
    }
    log.info(`Opening Report Selection: ${reportNav.url}`);
    await page.goto(reportNav.url, { ...GOTO_OPTS, timeout: navTimeoutMs });
    await waitForReportSelectionPage(page, navTimeoutMs);
    await assertMacromatixAuthenticated(page, 'Report Selection');
}

async function setGroupDropdown(page, groupName) {
    let set = null;
    await clickAndWaitForPostback(
        page,
        async () => {
            set = await page.evaluate((group) => {
                const want = group.toLowerCase();
                for (const sel of document.querySelectorAll('select')) {
                    const ctx = ((sel.closest('tr, td, div') || sel).innerText || '').toLowerCase();
                    if (
                        !ctx.includes('group') &&
                        !Array.from(sel.options).some((o) => o.text.toLowerCase().includes('supply'))
                    ) {
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
        },
        { timeoutMs: 15000 }
    );

    if (!set) throw new Error(`Group dropdown: could not select "${groupName}"`);
    log.info(`Group set to: ${set}`);
    await waitForReportListAfterGroup(page, groupName);
}

async function waitForReportListAfterGroup(page, groupName) {
    const want = String(groupName || '').toLowerCase();
    const listMs = Number(process.env.MMX_REPORT_LIST_WAIT_MS || 8000);
    if (want.includes('store')) {
        await page
            .waitForFunction(
                () => {
                    for (const sel of document.querySelectorAll('select')) {
                        if (
                            Array.from(sel.options).some((o) =>
                                /inventory|special event/i.test(o.textContent || '')
                            )
                        ) {
                            return true;
                        }
                    }
                    return false;
                },
                { timeout: listMs, polling: 100 }
            )
            .catch(() => {});
        return;
    }
    if (want.includes('supply') || want.includes('scm')) {
        await waitForScmReportList(page, listMs);
        return;
    }
    await waitForScmReportList(page, listMs).catch(() => {});
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
    let picked = null;
    await clickAndWaitForPostback(
        page,
        async () => {
            picked = await page.evaluate(
                (name, looseMode) => {
                    const want = name.toLowerCase();
                    for (const sel of document.querySelectorAll('select')) {
                        const label = ((sel.closest('tr, td') || sel).innerText || '').toLowerCase();
                        const hasInventory = Array.from(sel.options).some((o) =>
                            /inventory|special event/i.test(o.text)
                        );
                        const hasScm = Array.from(sel.options).some((o) => /scm|items on/i.test(o.text));
                        if (!looseMode && !label.includes('report') && !hasScm) {
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
        },
        { timeoutMs: 15000 }
    );

    if (!picked) {
        const lists = await listReportOptions(page, opts).catch(() => []);
        log.warn(`Reports list: could not select "${reportName}". Visible lists:`, JSON.stringify(lists));
        throw new Error(`Reports list: could not select "${reportName}"`);
    }
    log.info(`Report selected: ${picked}`);
    await waitForReportFormatControls(page);
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

    // Same total budget as the old 8x2s attempt loop, but poll fast and exit early.
    const maxAttempts = Math.max(4, Number(process.env.MMX_REPORT_FORMAT_ATTEMPTS || 8));
    const attemptDelayMs = Number(process.env.MMX_REPORT_FORMAT_RETRY_MS || 2000);
    const budgetMs = maxAttempts * attemptDelayMs;
    const pollMs = Number(process.env.MMX_REPORT_FORMAT_POLL_MS || 250);

    const startedAt = Date.now();
    let picked = await pickFormatInPage(page, needles);
    let warned = false;
    while (!picked && Date.now() - startedAt < budgetMs) {
        if (!warned) {
            log.warn(`Format "${formatText}" not ready, polling up to ${Math.round(budgetMs / 1000)}s…`);
            warned = true;
        }
        await page.waitForTimeout(pollMs);
        picked = await pickFormatInPage(page, needles);
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
    await waitForAspPostback(page, {
        timeoutMs: Number(process.env.MMX_REPORT_FORMAT_POSTBACK_MS || 3000),
    });
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

function storeTreeHints(storeName, storeNumber) {
    const cfg = getStoreConfig(storeNumber) || {};
    const hints = new Set([
        'tba area',
        'collins food',
        'tba market',
        'area 22',
        'area 21',
        'area 1',
        'area 2',
    ]);
    const area = String(cfg.area || '').trim().toLowerCase();
    if (area) hints.add(area);
    const name = String(cfg.storeName || storeName || '')
        .replace(/^\d+\s*/, '')
        .trim()
        .toLowerCase();
    if (name) hints.add(name);
    return [...hints];
}

/**
 * Wait until the RadTreeView finished its async expand callbacks (no visible loading
 * spinner) instead of a full fixed sleep. Worst case equals the old fixed wait.
 */
async function waitForRadTreeIdle(page, timeoutMs = 800, floorMs = 120) {
    await page
        .waitForFunction(
            () => {
                if (document.readyState !== 'complete') return false;
                const visible = (el) =>
                    el && (el.offsetWidth > 0 || el.offsetHeight > 0) &&
                    window.getComputedStyle(el).visibility !== 'hidden';
                for (const el of document.querySelectorAll('.rtLoading, .raDiv, [id*="LoadingPanel"]')) {
                    if (visible(el)) return false;
                }
                return true;
            },
            { timeout: timeoutMs, polling: 100 }
        )
        .catch(() => {});
    if (floorMs > 0) await page.waitForTimeout(floorMs);
}

async function expandStoreTree(page, hints = []) {
    const needles = new Set(hints.map((h) => String(h).toLowerCase()).filter(Boolean));
    await page.evaluate((list) => {
        for (const el of document.querySelectorAll('a, span, label, div, img, td, li')) {
            const t = (el.textContent || el.title || '').replace(/\s+/g, ' ').trim().toLowerCase();
            if (!t || t.length > 80) continue;
            for (const needle of list) {
                if (t.includes(needle)) {
                    try {
                        el.click();
                    } catch (e) {
                        /* ignore */
                    }
                    break;
                }
            }
        }
        for (const plus of document.querySelectorAll('.rtPlus')) {
            try {
                plus.click();
            } catch (e) {
                /* ignore */
            }
        }
    }, [...needles]);
    await waitForRadTreeIdle(page, Number(process.env.MMX_TREE_EXPAND_WAIT_MS || 800), 150);
}

/** Expand every collapsed node in the RadTreeView (needed before store rows are visible). */
async function expandFullReportStoreTree(page) {
    const maxRounds = Number(process.env.MMX_REPORT_TREE_EXPAND_ROUNDS || 30);
    for (let round = 0; round < maxRounds; round++) {
        const expanded = await page.evaluate(() => {
            let count = 0;
            for (const plus of document.querySelectorAll('.rtPlus')) {
                try {
                    plus.click();
                    count++;
                } catch (e) {
                    /* ignore */
                }
            }
            return count;
        });
        if (!expanded) break;
        await waitForRadTreeIdle(page, 700, 100);
    }
}

async function selectMarketRootInTree(page) {
    return page.evaluate(() => {
        let best = null;
        let bestScore = -1;
        for (const cb of document.querySelectorAll('input[type="checkbox"]')) {
            const row = cb.closest('tr, div, li, span, label') || cb.parentElement;
            const text = (row?.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
            if (!text) continue;
            let score = 0;
            if (text.includes('tba market')) score += 10;
            if (text.includes('market 1')) score += 8;
            if (text.includes('collins food')) score += 6;
            if (/\barea\s*\d+\b/.test(text)) score -= 5;
            if (/\b\d{4}\b/.test(text)) score -= 10;
            if (score > bestScore) {
                bestScore = score;
                best = { cb, label: text.slice(0, 80) };
            }
        }
        if (best && !best.cb.checked) best.cb.click();
        return best?.label || null;
    });
}

async function prepareBulkScmStoreScope(page) {
    if (!(await reportUsesStoreTree(page))) return;
    await expandFullReportStoreTree(page);
    await clearAllReportTreeCheckboxes(page);
    const root = await selectMarketRootInTree(page);
    if (root) {
        log.info(`Bulk SCM: selected market root "${root}" for all-store export`);
    } else {
        log.warn('Bulk SCM: market root not found in tree - export may be area-filtered');
    }
    await page.waitForTimeout(Number(process.env.MMX_REPORT_TREE_CLEAR_SETTLE_MS || 500));
}

function storeVisibleInTreeDocument(storeNumber) {
    const want = String(storeNumber || '').replace(/\D/g, '');
    if (!want) return false;
    const re = new RegExp(`(^|\\D)${want}(\\D|$)`);
    for (const rtIn of document.querySelectorAll('.rtIn')) {
        const text = (rtIn.textContent || '').replace(/\s+/g, ' ');
        if (re.test(text)) return true;
    }
    for (const cb of document.querySelectorAll('input[type="checkbox"]')) {
        const row = cb.closest('tr, div, li, span, label') || cb.parentElement;
        const text = (row?.textContent || '').replace(/\s+/g, ' ');
        if (re.test(text)) return true;
    }
    return false;
}

async function storeVisibleInTree(page, storeNumber) {
    const want = String(storeNumber || '').replace(/\D/g, '');
    if (!want) return false;
    if (await page.mainFrame().evaluate(storeVisibleInTreeDocument, want)) return true;
    for (const frame of page.frames()) {
        if (frame === page.mainFrame()) continue;
        try {
            if (await frame.evaluate(storeVisibleInTreeDocument, want)) return true;
        } catch (e) {
            /* ignore */
        }
    }
    return false;
}

async function reportHasStoreDropdown(page) {
    return page.evaluate(
        () =>
            Boolean(
                document.querySelector('input[id*="DropDownListStore"]') ||
                document.getElementById('ctl00_ph_DropDownListStore')
            )
    );
}

async function reportUsesStoreTree(page) {
    return page.evaluate(() => {
        for (const cb of document.querySelectorAll('input[type="checkbox"]')) {
            const row = cb.closest('tr, div, li, span, label') || cb.parentElement;
            const text = (row?.textContent || '').replace(/\s+/g, ' ');
            if (/\b\d{4}\b/.test(text)) return true;
        }
        return Boolean(document.querySelector('.RadTreeView, .rtPlus, .rtMinus'));
    });
}

function collectScmStoreTreeSnapshot() {
    const labels = [];
    const seen = new Set();
    const add = (text, checked) => {
        const t = String(text || '').replace(/\s+/g, ' ').trim();
        if (!t || seen.has(t)) return;
        seen.add(t);
        labels.push({ text: t, checked: Boolean(checked) });
    };

    for (const label of document.querySelectorAll('label')) {
        const rtIn = label.querySelector('.rtIn');
        const cb = label.querySelector('input.rtChk, input[type="checkbox"]');
        if (rtIn) add(rtIn.textContent, cb?.checked);
    }
    for (const mid of document.querySelectorAll('.rtMid')) {
        const rtIn = mid.querySelector('.rtIn');
        const cb = mid.querySelector('input.rtChk, input[type="checkbox"]');
        if (rtIn) add(rtIn.textContent, cb?.checked);
    }

    return {
        labels,
        rtPlus: document.querySelectorAll('.rtPlus').length,
        rtMinus: document.querySelectorAll('.rtMinus').length,
        hasRadTree: Boolean(document.querySelector('.RadTreeView')),
    };
}

/** Snapshot store rows in the SCM RadTreeView (for debug logging). */
async function listScmStoreTreeLabels(page) {
    const collect = (frame) => frame.evaluate(collectScmStoreTreeSnapshot);

    let best = await collect(page.mainFrame());
    for (const frame of page.frames()) {
        if (frame === page.mainFrame()) continue;
        try {
            const snap = await collect(frame);
            if (snap.labels.length > best.labels.length) best = snap;
        } catch (e) {
            /* cross-origin frame */
        }
    }
    return best;
}

async function waitForScmStoreTreeAfterDates(page) {
    await page.waitForFunction(() => document.readyState === 'complete', { timeout: 8000 }).catch(() => {});
    const treeMs = Number(process.env.MMX_SCM_TREE_AFTER_DATE_MS || 5000);
    await page
        .waitForFunction(
            () => Boolean(document.querySelector('.RadTreeView .rtMid, .RadTreeView .rtPlus, .RadTreeView')),
            { timeout: treeMs, polling: 80 }
        )
        .catch(() => {});
    await page.waitForTimeout(Number(process.env.MMX_SCM_TREE_AFTER_DATE_PAD_MS || 350));
}

function parseAreaNumber(areaLabel) {
    const m = String(areaLabel || '').match(/area\s*(\d+)/i);
    return m ? m[1] : '';
}

/** Click .rtPlus on the first tree row whose label matches needle (label or .rtMid rows). */
async function expandTreeNodeByNeedle(page, needle, opts = {}) {
    const want = String(needle || '').trim().toLowerCase();
    if (!want) return false;

    const result = await page.evaluate((n) => {
        const expandHost = (row) => row.closest('.rtMid') || row.closest('.rtLI') || row;
        const rows = [];
        const seen = new Set();
        const add = (el) => {
            if (!el || seen.has(el)) return;
            seen.add(el);
            rows.push(el);
        };
        for (const mid of document.querySelectorAll('.rtMid')) add(mid);
        for (const label of document.querySelectorAll('label')) {
            if (label.querySelector('.rtIn')) add(label);
        }
        const rowText = (row) => {
            const rtIn = row.querySelector('.rtIn') || expandHost(row).querySelector('.rtIn');
            return (rtIn?.textContent || row.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
        };
        for (const row of rows) {
            const text = rowText(row);
            if (!text.includes(n)) continue;
            const host = expandHost(row);
            if (host.querySelector('.rtMinus')) return { label: text, expanded: true };
            const plus = host.querySelector('.rtPlus');
            if (plus) {
                plus.click();
                return { label: text, expanded: false };
            }
        }
        return null;
    }, want);

    if (!result) return false;
    if (!result.expanded) {
        log.info(`SCM store tree: expanding "${result.label}"`);
        const postbackMs = opts.postbackMs ?? Number(process.env.MMX_SCM_TREE_NODE_POSTBACK_MS || 4000);
        await waitForAspPostback(page, { timeoutMs: postbackMs }).catch(() => {});
        await page.waitForTimeout(Number(opts.settleMs || 200));
    }
    return true;
}

/** Find a RadTreeView area row and click rtPlus/rtMinus (or label) on its .rtMid host. */
async function clickAreaTreeToggle(page, areaNum, action = 'expand') {
    return page.evaluate(
        ({ num, act }) => {
            const matchesArea = (text) => {
                const lower = String(text || '').toLowerCase();
                if (lower.includes(`tba area ${num}`)) return true;
                return new RegExp(`\\barea\\s+${num}(\\b|\\s*\\()`, 'i').test(text);
            };
            const tryHost = (host, text) => {
                if (!host) return null;
                const plus = host.querySelector('.rtPlus');
                const minus = host.querySelector('.rtMinus');
                if (act === 'collapse' && minus) {
                    minus.click();
                    return { action: 'collapse', label: text };
                }
                if (act === 'expand' && plus) {
                    plus.click();
                    return { action: 'expand', label: text };
                }
                if (act === 'expand' && minus) {
                    return { action: 'already-expanded', label: text };
                }
                if (act === 'expand') {
                    const rtIn = host.querySelector('.rtIn');
                    if (rtIn) {
                        rtIn.click();
                        return { action: 'label-click', label: text };
                    }
                }
                return null;
            };
            const rows = [];
            const seen = new Set();
            const add = (el) => {
                if (!el || seen.has(el)) return;
                seen.add(el);
                rows.push(el);
            };
            for (const mid of document.querySelectorAll('.rtMid')) add(mid);
            for (const li of document.querySelectorAll('.RadTreeView .rtLI, .rtLI')) add(li);
            for (const label of document.querySelectorAll('label')) {
                if (label.querySelector('.rtIn')) add(label);
            }
            for (const row of rows) {
                const rtIn = row.querySelector('.rtIn');
                if (!rtIn) continue;
                const text = (rtIn.textContent || '').replace(/\s+/g, ' ').trim();
                if (!matchesArea(text)) continue;
                const host =
                    row.classList?.contains('rtMid') || row.classList?.contains('rtTop')
                        ? row
                        : row.querySelector('.rtMid, .rtTop') || row.closest('.rtMid, .rtTop') || row;
                const hit = tryHost(host, text);
                if (hit) return hit;
            }
            return null;
        },
        { num: areaNum, act: action }
    );
}

async function waitAfterAreaTreeAction(page, action, postbackMs) {
    if (action === 'expand' || action === 'collapse' || action === 'label-click') {
        await waitForAspPostback(page, { timeoutMs: postbackMs }).catch(() => {});
        await page.waitForTimeout(action === 'label-click' ? 500 : 400);
    }
}

/** Click rtPlus on the store's TBA Area N row only (never another area's plus). */
async function expandTargetAreaCollapsedNode(page, areaLabel) {
    const areaNum = parseAreaNumber(areaLabel);
    if (!areaNum) return null;
    return page.evaluate((num) => {
        const matches = (text) => {
            const lower = String(text || '').toLowerCase();
            if (lower.includes(`tba area ${num}`)) return true;
            return new RegExp(`\\barea\\s+${num}(\\b|\\s*\\()`, 'i').test(lower);
        };
        for (const plus of document.querySelectorAll('.rtPlus')) {
            const mid = plus.closest('.rtMid, .rtTop');
            const rtIn = mid?.querySelector('.rtIn');
            if (!rtIn) continue;
            const text = (rtIn.textContent || '').replace(/\s+/g, ' ').trim();
            if (!matches(text)) continue;
            plus.scrollIntoView?.({ block: 'center', inline: 'nearest' });
            plus.click();
            return text;
        }
        return null;
    }, areaNum);
}

async function forceExpandTargetArea(page, areaLabel, storeNumber) {
    const areaNum = parseAreaNumber(areaLabel);
    const num = String(storeNumber || '').replace(/\D/g, '').trim();
    if (!areaNum) return false;
    const postbackMs = Number(process.env.MMX_SCM_TREE_AREA_POSTBACK_MS || 20000);

    const direct = await expandTargetAreaCollapsedNode(page, areaLabel);
    if (direct) {
        log.info(`SCM store tree: expanding target area "${direct}"`);
        await waitForAspPostback(page, { timeoutMs: postbackMs }).catch(() => {});
        await page.waitForTimeout(500);
        if (!num || (await storeVisibleInTree(page, num))) return true;
    }

    const toggled = await clickAreaTreeToggle(page, areaNum, 'expand');
    if (toggled?.action === 'expand' || toggled?.action === 'label-click') {
        log.info(`SCM store tree: expanding target area "${toggled.label}"`);
        await waitAfterAreaTreeAction(page, toggled.action, postbackMs);
        return !num || (await storeVisibleInTree(page, num));
    }
    if (toggled?.action === 'already-expanded' && num) {
        return refreshAreaNodeIfStoreHidden(page, areaLabel, num);
    }
    return Boolean(direct);
}

/** @deprecated Use expandTargetAreaCollapsedNode — kept for callers that pass a needle string. */
async function expandNextCollapsedTreeNode(page, preferNeedle = '') {
    const areaNum = parseAreaNumber(preferNeedle) || String(preferNeedle || '').match(/area\s*(\d+)/i)?.[1];
    if (!areaNum) return null;
    return expandTargetAreaCollapsedNode(page, `Area ${areaNum}`);
}

/** Expand a specific TBA Area N row (avoids matching "Area 2" when looking for "Area 22"). */
async function expandTreeNodeByAreaLabel(page, areaLabel, opts = {}) {
    const areaNum = parseAreaNumber(areaLabel);
    if (!areaNum) return expandTreeNodeByNeedle(page, areaLabel, opts);

    const postbackMs = opts.postbackMs ?? Number(process.env.MMX_SCM_TREE_AREA_POSTBACK_MS || 18000);
    const result = await clickAreaTreeToggle(page, areaNum, 'expand');

    if (!result) {
        log.warn(`SCM store tree: area row not found for "${areaLabel}"`);
        return false;
    }
    if (result.action === 'expand' || result.action === 'label-click') {
        log.info(
            `SCM store tree: expanding area "${result.label}"${result.action === 'label-click' ? ' (label click)' : ''}`
        );
        await waitAfterAreaTreeAction(page, result.action, postbackMs);
    } else if (result.action === 'already-expanded') {
        log.info(`SCM store tree: area "${result.label}" shows expanded - waiting for store rows`);
    }
    return true;
}

/** Area node shows expanded (rtMinus) but store rows missing — collapse and re-expand on slow Pi postbacks. */
async function refreshAreaNodeIfStoreHidden(page, areaLabel, storeNumber) {
    const areaNum = parseAreaNumber(areaLabel);
    const num = String(storeNumber || '').replace(/\D/g, '').trim();
    if (!areaNum || !num || (await storeVisibleInTree(page, num))) return true;

    const postbackMs = Number(process.env.MMX_SCM_TREE_AREA_POSTBACK_MS || 18000);
    const state = await clickAreaTreeToggle(page, areaNum, 'expand');
    if (!state) return false;

    if (state.action === 'already-expanded') {
        log.info(`SCM store tree: area "${state.label}" looks expanded but store ${num} missing - refreshing`);
        const collapsed = await clickAreaTreeToggle(page, areaNum, 'collapse');
        if (collapsed?.action === 'collapse') {
            await waitForAspPostback(page, { timeoutMs: postbackMs }).catch(() => {});
            await page.waitForTimeout(350);
        }
        const reexpanded = await clickAreaTreeToggle(page, areaNum, 'expand');
        if (reexpanded?.action === 'expand' || reexpanded?.action === 'label-click') {
            log.info(`SCM store tree: re-expanding area "${reexpanded.label}"`);
            await waitAfterAreaTreeAction(page, reexpanded.action, postbackMs);
        }
    } else if (state.action === 'expand' || state.action === 'label-click') {
        await waitAfterAreaTreeAction(page, state.action, postbackMs);
    }

    return waitForStoreRowInTree(page, num, postbackMs);
}

async function waitForStoreRowInTree(page, storeNumber, timeoutMs) {
    const num = String(storeNumber || '').replace(/\D/g, '').trim();
    if (!num) return false;
    try {
        await page.waitForFunction(
            (w) => {
                const escaped = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const re = new RegExp(`(^|\\D)${escaped}(\\D|$)`);
                for (const rtIn of document.querySelectorAll('.rtIn')) {
                    const text = (rtIn.textContent || '').replace(/\s+/g, ' ');
                    if (re.test(text)) return true;
                }
                return false;
            },
            { timeout: timeoutMs, polling: 120 },
            num
        );
        return true;
    } catch {
        return storeVisibleInTree(page, num);
    }
}

async function scmAreaRowsVisible(page) {
    return page.evaluate(() => {
        for (const rtIn of document.querySelectorAll('.rtIn')) {
            const t = (rtIn.textContent || '').toLowerCase();
            if (/tba area \d+/.test(t)) return true;
        }
        return false;
    });
}

/**
 * Zone Filter tree: expand Collins → TBA Market 1 → store's TBA Area N (from .storelist), then wait for the store row.
 */
async function expandScmPathToStore(page, storeNumber) {
    const num = String(storeNumber || '').replace(/\D/g, '').trim();
    const cfg = getStoreConfig(num) || {};
    const areaLabel = String(cfg.area || 'Area 22').trim();
    const marketPostback = Number(process.env.MMX_SCM_TREE_NODE_POSTBACK_MS || 6000);
    const areaPostback = Number(process.env.MMX_SCM_TREE_AREA_POSTBACK_MS || 18000);

    await expandTreeNodeByNeedle(page, 'collins food group', { postbackMs: marketPostback });
    await expandTreeNodeByNeedle(page, 'tba market 1', { postbackMs: marketPostback });
    if (!(await scmAreaRowsVisible(page))) {
        await expandTreeNodeByNeedle(page, 'tba market 1', { postbackMs: marketPostback, settleMs: 500 });
    }
    await expandTreeNodeByAreaLabel(page, areaLabel, { postbackMs: areaPostback });
    if (await waitForStoreRowInTree(page, num, areaPostback)) {
        return storeVisibleInTree(page, num);
    }
    await forceExpandTargetArea(page, areaLabel, num);
    if (await storeVisibleInTree(page, num)) {
        return true;
    }
    await refreshAreaNodeIfStoreHidden(page, areaLabel, num);
    if (await storeVisibleInTree(page, num)) {
        return true;
    }
    // Area expand postback can lag on the Pi — one more expand pass before giving up.
    await expandTreeNodeByAreaLabel(page, areaLabel, { postbackMs: areaPostback, settleMs: 500 });
    await waitForStoreRowInTree(page, num, areaPostback);
    return storeVisibleInTree(page, num);
}

async function expandAreaNodeInTree(page, areaNeedle) {
    return expandTreeNodeByAreaLabel(page, areaNeedle || 'Area 22');
}

/** Expand at most one level of visible collapsed nodes (avoids 30-round full-tree hammering). */
async function expandScmTreeOneLevel(page, opts = {}) {
    const clicked = await page.evaluate(() => {
        let count = 0;
        const max = 12;
        for (const plus of document.querySelectorAll('.rtPlus')) {
            if (count >= max) break;
            try {
                plus.click();
                count++;
            } catch (e) {
                /* ignore */
            }
        }
        return count;
    });
    if (clicked > 0) {
        if (opts.light) {
            const settleMs = Number(process.env.MMX_SCM_TREE_EXPAND_SETTLE_MS || 450);
            await page.waitForTimeout(settleMs);
            await page
                .waitForFunction(() => document.readyState === 'complete', {
                    timeout: 1200,
                    polling: 80,
                })
                .catch(() => {});
        } else {
            await waitForAspPostback(page, { timeoutMs: opts.postbackMs || 10000 }).catch(() => {});
            await page.waitForTimeout(350);
        }
    }
    return clicked;
}

/** Expand one collapsed node — target area first, else deepest visible .rtPlus (often Area 22). */
async function expandOneSequentialCollapsedNode(page, areaLabel) {
    const target = await expandTargetAreaCollapsedNode(page, areaLabel);
    if (target) return { label: target, kind: 'target-area' };
    return page.evaluate(() => {
        const plusList = [...document.querySelectorAll('.rtPlus')];
        for (let i = plusList.length - 1; i >= 0; i--) {
            const plus = plusList[i];
            const mid = plus.closest('.rtMid, .rtTop');
            const rtIn = mid?.querySelector('.rtIn');
            const text = (rtIn?.textContent || '').replace(/\s+/g, ' ').trim();
            plus.scrollIntoView?.({ block: 'center', inline: 'nearest' });
            plus.click();
            return { label: text || `rtPlus[${i}]`, kind: 'deepest' };
        }
        return null;
    });
}

async function waitUntilStoreVisibleInTree(page, storeNumber, timeoutMs) {
    const num = String(storeNumber || '').replace(/\D/g, '').trim();
    const cfg = getStoreConfig(num) || {};
    const areaLabel = String(cfg.area || 'Area 22').trim();
    const postbackMs = Number(process.env.MMX_SCM_TREE_AREA_POSTBACK_MS || 20000);

    if (await expandScmPathToStore(page, num)) {
        log.info(`SCM store tree: store ${num} visible in tree`);
        return true;
    }

    const started = Date.now();
    let lastLog = 0;
    while (Date.now() - started < timeoutMs) {
        if (await storeVisibleInTree(page, num)) {
            log.info(`SCM store tree: store ${num} visible in tree`);
            return true;
        }
        if (Date.now() - lastLog >= 4000) {
            log.info(`SCM store tree: waiting for store ${num} - re-expanding market/area…`);
            lastLog = Date.now();
        }
        await forceExpandTargetArea(page, areaLabel, num);
        if (await storeVisibleInTree(page, num)) continue;

        await refreshAreaNodeIfStoreHidden(page, areaLabel, num);
        if (await storeVisibleInTree(page, num)) continue;

        await expandScmPathToStore(page, num);
        if (await storeVisibleInTree(page, num)) continue;

        const expanded = await expandOneSequentialCollapsedNode(page, areaLabel);
        if (expanded) {
            log.info(
                `SCM store tree: expanding ${expanded.kind} node "${expanded.label}"`
            );
            await waitForAspPostback(page, { timeoutMs: postbackMs }).catch(() => {});
            await page.waitForTimeout(500);
        }
    }
    return storeVisibleInTree(page, num);
}

/** Uncheck only store rows (4-digit .rtIn), not parent area/market nodes. */
async function clearStoreCheckboxesInTree(page) {
    const cleared = await page.evaluate(() => {
        let count = 0;
        const uncheck = (cb, text) => {
            if (!cb?.checked || !/\b\d{4}\b/.test(text)) return;
            cb.click();
            count++;
        };
        for (const label of document.querySelectorAll('label')) {
            const rtIn = label.querySelector('.rtIn');
            const cb = label.querySelector('input.rtChk, input[type="checkbox"]');
            if (!rtIn || !cb) continue;
            uncheck(cb, (rtIn.textContent || '').replace(/\s+/g, ' ').trim());
        }
        for (const mid of document.querySelectorAll('.rtMid')) {
            const rtIn = mid.querySelector('.rtIn');
            const cb = mid.querySelector('input.rtChk, input[type="checkbox"]');
            if (!rtIn || !cb) continue;
            uncheck(cb, (rtIn.textContent || '').replace(/\s+/g, ' ').trim());
        }
        return count;
    });
    if (cleared > 0) {
        log.info(`SCM store tree: cleared ${cleared} checked store row(s)`);
    }
    await page.waitForTimeout(300);
}

async function checkStoreCheckboxInTreeFrame(frame, storeNumber) {
    return frame.evaluate((w) => {
        const escaped = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(`(^|\\D)${escaped}(\\D|$)`);
        const tryCheck = (cb, text) => {
            const host = cb.closest('.rtMid') || cb.closest('.rtLI') || cb.closest('label') || cb;
            host.scrollIntoView?.({ block: 'center' });
            if (!cb.checked) cb.click();
            return text;
        };

        for (const mid of document.querySelectorAll('.rtMid')) {
            const rtIn = mid.querySelector('.rtIn');
            const cb = mid.querySelector('input.rtChk, input[type="checkbox"]');
            if (!cb || !rtIn) continue;
            const text = (rtIn.textContent || '').replace(/\s+/g, ' ').trim();
            if (!re.test(text)) continue;
            return tryCheck(cb, text);
        }
        for (const label of document.querySelectorAll('label')) {
            const rtIn = label.querySelector('.rtIn');
            const cb = label.querySelector('input.rtChk, input[type="checkbox"]');
            if (!cb || !rtIn) continue;
            const text = (rtIn.textContent || '').replace(/\s+/g, ' ').trim();
            if (!re.test(text)) continue;
            return tryCheck(cb, text);
        }
        for (const cb of document.querySelectorAll('input.rtChk, input[type="checkbox"]')) {
            const label = cb.closest('label');
            const rtIn = label?.querySelector('.rtIn');
            const text = (rtIn?.textContent || label?.textContent || '').replace(/\s+/g, ' ').trim();
            if (!re.test(text)) continue;
            return tryCheck(cb, text);
        }
        return null;
    }, storeNumber);
}

async function checkStoreCheckboxInTree(page, storeNumber) {
    let picked = await checkStoreCheckboxInTreeFrame(page.mainFrame(), storeNumber);
    if (picked) return picked;
    for (const frame of page.frames()) {
        if (frame === page.mainFrame()) continue;
        try {
            picked = await checkStoreCheckboxInTreeFrame(frame, storeNumber);
            if (picked) return picked;
        } catch (e) {
            /* ignore */
        }
    }
    return null;
}

/**
 * SCM Items On Hand / On Order: check one store in the RadTreeView (label > input.rtChk + span.rtIn).
 */
async function selectScmStoreCheckboxInTree(page, storeNumber, storeName, options = {}) {
    const num = String(storeNumber || '').replace(/\D/g, '').trim();
    if (!num) throw new Error('SCM store tree: storeNumber is required');

    log.info(`SCM store tree: selecting store ${num}${storeName ? ` (${storeName})` : ''}`);
    if (!options.skipDateWait) {
        await waitForScmStoreTreeAfterDates(page);
    }

    const treeHasChecked = await page.evaluate(
        () =>
            [...document.querySelectorAll('.RadTreeView input[type="checkbox"], input.rtChk')].some(
                (cb) => cb.checked
            )
    );
    if (treeHasChecked) {
        log.info('SCM store tree: clearing prior store selections');
        await clearScmTreeSelectedValuesLink(page);
        await clearStoreCheckboxesInTree(page);
        await page.waitForTimeout(Number(process.env.MMX_SCM_TREE_AFTER_CLEAR_MS || 200));
    }

    const waitMs = Number(process.env.MMX_SCM_TREE_WAIT_MS || 60000);
    const visible = await waitUntilStoreVisibleInTree(page, num, waitMs);
    if (!visible) {
        log.warn(`SCM store tree: store ${num} not visible after ${Math.round(waitMs / 1000)}s - trying checkbox anyway`);
    }

    await clearStoreCheckboxesInTree(page);

    const picked = await checkStoreCheckboxInTree(page, num);
    if (!picked) {
        const snap = await listScmStoreTreeLabels(page);
        const sample = snap.labels
            .slice(0, 15)
            .map((r) => `${r.checked ? '[x]' : '[ ]'} ${r.text}`)
            .join('; ');
        log.warn(
            `SCM store tree snapshot: ${snap.labels.length} label(s), rtPlus=${snap.rtPlus}, rtMinus=${snap.rtMinus}, radTree=${snap.hasRadTree}`
        );
        if (sample) log.warn(`SCM store tree sample: ${sample}`);
        throw new Error(
            `SCM store tree: could not check store ${num}${storeName ? ` (${storeName})` : ''} - is the Stores tree visible?`
        );
    }
    log.info(`SCM store tree: checked "${picked}"`);
    await page.waitForTimeout(Number(process.env.MMX_SCM_TREE_SELECT_SETTLE_MS || 250));
}

/** SCM flat reports: store tree loads after dates - expand Area nodes until the store row appears. */
async function prepareStoreTreeForSelection(page, storeName, storeNumber, timeoutMs = 45000) {
    const num = String(storeNumber || storeName.match(/\b(\d{4})\b/)?.[1] || '').trim();
    const hints = storeTreeHints(storeName, num);
    const started = Date.now();
    let lastLog = 0;

    while (Date.now() - started < timeoutMs) {
        if (await storeVisibleInTree(page, num)) {
            log.info(`Store ${num} visible in report tree`);
            return true;
        }
        if (Date.now() - lastLog >= 5000) {
            log.info(`Expanding report store tree for ${num || storeName}…`);
            lastLog = Date.now();
        }
        await expandFullReportStoreTree(page);
        await expandStoreTree(page, hints);
        // Poll for the store row instead of a fixed sleep between expansion rounds.
        const pollUntil = Date.now() + 600;
        while (Date.now() < pollUntil) {
            if (await storeVisibleInTree(page, num)) break;
            await page.waitForTimeout(150);
        }
    }

    log.warn(
        `Store ${num || storeName} not visible in report tree after ${Math.round(timeoutMs / 1000)}s - trying selection anyway`
    );
    return false;
}

async function tryStoreTree(page, needle, treeHints = []) {
    await expandStoreTree(page, treeHints);

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

async function tryStoreReportDropdown(page, storeNumber, storeName) {
    const needles = storeNeedles(storeName || storeNumber);
    const inputSelectors = [
        'input[id*="DropDownListStore_Input"]',
        'input[id*="DropDownListStore"]',
        'input[name*="DropDownListStore"]',
    ];

    let input = null;
    for (const sel of inputSelectors) {
        input = await page.$(sel);
        if (input) break;
    }
    if (!input) return null;

    const matchesStore = (text, want) => {
        const t = String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
        if (!t) return false;
        if (/^\d+$/.test(want)) {
            const escaped = want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            return new RegExp(`(^|\\D)${escaped}(\\D|$)`).test(t);
        }
        return t.includes(want) || want.includes(t);
    };

    async function pickFromOpenList(want) {
        return page.evaluate((needle) => {
            const matches = (text) => {
                const t = String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
                if (!t) return false;
                if (/^\d+$/.test(needle)) {
                    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    return new RegExp(`(^|\\D)${escaped}(\\D|$)`).test(t);
                }
                return t.includes(needle) || needle.includes(t);
            };
            const nodes = document.querySelectorAll(
                '.rcbList li, .rcbItem, .RadComboBoxDropDown li, [id*="DropDownListStore"] .rcbItem, [role="listbox"] [role="option"]'
            );
            for (const el of nodes) {
                const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
                if (matches(t)) {
                    el.click();
                    return t;
                }
            }
            return null;
        }, want);
    }

    async function openDropdown() {
        await input.click();
        await page.waitForTimeout(250);
        await page.evaluate(() => {
            const root =
                document.querySelector('[id*="DropDownListStore"]') ||
                document.getElementById('ctl00_ph_DropDownListStore');
            const arrow = root?.querySelector('.rcbArrowCell a, .rcbArrowCell, a.rcbArrow');
            arrow?.click();
        });
        await page.waitForTimeout(400);
    }

    await openDropdown();
    for (const needle of needles) {
        const picked = await pickFromOpenList(needle);
        if (picked) return picked;
    }

    if (storeNumber) {
        await input.click({ clickCount: 3 });
        await page.waitForTimeout(100);
        await page.keyboard.press('Backspace');
        await page.keyboard.type(String(storeNumber), { delay: 35 });
        await page.waitForTimeout(600);
        for (const needle of needles) {
            const picked = await pickFromOpenList(needle);
            if (picked) return picked;
        }
    }

    const current = await input.evaluate((el) => (el.value || '').trim());
    for (const needle of needles) {
        if (matchesStore(current, needle)) return current;
    }

    return null;
}

async function tryStoreReportTextboxes(page, storeNumber, storeName) {
    return page.evaluate(({ num, name }) => {
        const isStoreContext = (ctx) => /store/i.test(ctx) && !/restore|history|report name|report format|report group/i.test(ctx);
        const candidates = [];

        for (const inp of document.querySelectorAll('input[type="text"], input:not([type])')) {
            const id = (inp.id || '').toLowerCase();
            const ctx = ((inp.closest('tr, td, table, div') || inp.parentElement)?.innerText || '').slice(0, 240);
            if (id.includes('textbox') || isStoreContext(ctx)) {
                candidates.push({ inp, ctx, id });
            }
        }

        for (const { inp, ctx, id } of candidates) {
            if (!id.includes('textbox') && !isStoreContext(ctx)) continue;
            const val = num || name;
            inp.focus();
            inp.value = val;
            inp.dispatchEvent(new Event('input', { bubbles: true }));
            inp.dispatchEvent(new Event('change', { bubbles: true }));
            inp.dispatchEvent(new Event('blur', { bubbles: true }));
            return `${id || 'textbox'}=${val}`;
        }
        return null;
    }, { num: storeNumber, name: storeName });
}

async function tryStoreRadCombo(page, needle) {
    const picked = await page.evaluate((want) => {
        const matchesStore = (text) => {
            const t = String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
            if (!t) return false;
            if (/^\d+$/.test(want)) {
                const escaped = want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                return new RegExp(`(^|\\D)${escaped}(\\D|$)`).test(t);
            }
            return t.includes(want) || want.includes(t);
        };

        for (const inp of document.querySelectorAll('input[id*="RadComboBox"], input.rcbInput')) {
            const ctx = ((inp.closest('tr, td, table, div') || inp.parentElement)?.innerText || '').toLowerCase();
            if (!ctx.includes('store')) continue;
            inp.click();
            return { type: 'combo', id: inp.id };
        }

        for (const sel of document.querySelectorAll('select')) {
            const ctx = ((sel.closest('tr, td, table, div') || sel).innerText || '').toLowerCase();
            if (!ctx.includes('store')) continue;
            for (const opt of sel.options) {
                if (matchesStore(opt.textContent)) {
                    sel.value = opt.value;
                    sel.dispatchEvent(new Event('change', { bubbles: true }));
                    return { type: 'select', label: opt.textContent.trim() };
                }
            }
        }
        return null;
    }, needle);

    if (!picked) return null;
    if (picked.type === 'select') return picked.label;

    await page.waitForTimeout(400);
    const clicked = await page.evaluate((want) => {
        const matchesStore = (text) => {
            const t = String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
            if (!t) return false;
            if (/^\d+$/.test(want)) {
                const escaped = want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                return new RegExp(`(^|\\D)${escaped}(\\D|$)`).test(t);
            }
            return t.includes(want);
        };
        for (const el of document.querySelectorAll('.rcbList li, .rcbItem, [role="listbox"] [role="option"]')) {
            const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
            if (matchesStore(t)) {
                el.click();
                return t;
            }
        }
        return null;
    }, needle);
    return clicked;
}

async function waitForStoreReportDropdownReady(page, storeName, storeNumber, timeoutMs = 20000) {
    if (!(await reportHasStoreDropdown(page))) return;

    const started = Date.now();
    const needles = storeNeedles(storeName || storeNumber);
    const numericNeedles = needles.filter((n) => /^\d+$/.test(n));
    let lastLog = 0;

    while (Date.now() - started < timeoutMs) {
        const ready = await page.evaluate(({ numeric, textual }) => {
            const optionNodes = document.querySelectorAll(
                '.rcbList li, .rcbItem, .RadComboBoxDropDown li, [id*="DropDownListStore"] .rcbItem, [role="listbox"] [role="option"]'
            );
            const samples = [];
            for (const node of optionNodes) {
                const t = (node.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
                if (t) samples.push(t);
            }

            const input =
                document.querySelector('input[id*="DropDownListStore_Input"]') ||
                document.querySelector('input[id*="DropDownListStore"]') ||
                document.querySelector('input[name*="DropDownListStore"]');
            const inputValue = (input?.value || '').replace(/\s+/g, ' ').trim().toLowerCase();
            if (inputValue) samples.push(inputValue);

            const hasNeedle = (want) => {
                if (!want) return false;
                if (/^\d+$/.test(want)) {
                    const escaped = want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    const re = new RegExp(`(^|\\D)${escaped}(\\D|$)`);
                    return samples.some((s) => re.test(s));
                }
                return samples.some((s) => s.includes(want) || want.includes(s));
            };

            return numeric.some(hasNeedle) || textual.some(hasNeedle);
        }, { numeric: numericNeedles, textual: needles });

        if (ready) return;
        if (Date.now() - lastLog >= 5000) {
            log.info(`Waiting for store dropdown (${storeNumber || storeName})…`);
            lastLog = Date.now();
        }
        await page.waitForTimeout(1000);
    }

    log.warn(
        `Store dropdown did not fully populate within ${Math.round(timeoutMs / 1000)}s; attempting selection anyway`
    );
}

/** Store Reports → Inventory Special Event uses DropDownListStore (RadCombo). */
async function selectStoreForStoreReport(page, storeName, opts = {}) {
    const storeNumber = String(opts.storeNumber || storeName.match(/\b(\d{4})\b/)?.[1] || '').trim();
    await page
        .waitForFunction(() => document.readyState === 'complete', { timeout: 15000, polling: 100 })
        .catch(() => {});

    log.info(`Selecting store for store report: ${storeNumber || storeName}`);

    if (storeNumber) {
        const fromCombo = await selectStoreOnPage(page, storeNumber);
        if (fromCombo) {
            log.info(`Store selected (RadCombo): ${fromCombo}`);
            return;
        }
    }

    if (await reportHasStoreDropdown(page)) {
        await waitForStoreReportDropdownReady(
            page,
            storeName,
            storeNumber,
            opts.dropdownReadyTimeoutMs || 20000
        );
    }

    const fromDropdown = await tryStoreReportDropdown(page, storeNumber, storeName);
    if (fromDropdown) {
        log.info(`Store selected (report dropdown): ${fromDropdown}`);
        await waitForAspPostback(page, { timeoutMs: 10000 });
        return;
    }

    const needles = storeNeedles(storeName);
    for (const needle of needles) {
        const fromCombo = await tryStoreRadCombo(page, needle);
        if (fromCombo) {
            log.info(`Store selected (combo): ${fromCombo}`);
            await waitForAspPostback(page, { timeoutMs: 10000 });
            return;
        }
    }

    if (opts.optional) {
        log.warn(`Store not found for "${storeName}" - continuing (optional)`);
        return;
    }

    throw new Error(`Store: could not select "${storeName}" in report dropdown (tried: ${needles.join(', ')})`);
}

/** Uncheck every report tree checkbox (stores, areas, markets) so bulk SCM is not area-filtered. */
async function clearAllReportTreeCheckboxes(page) {
    let total = 0;
    const maxPasses = Number(process.env.MMX_REPORT_TREE_CLEAR_PASSES || 2);
    for (let pass = 0; pass < maxPasses; pass++) {
        const cleared = await page.evaluate(() => {
            let count = 0;
            const root = document.querySelector('.RadTreeView') || document.body;
            for (const cb of root.querySelectorAll('input[type="checkbox"]')) {
                if (cb.checked) {
                    cb.click();
                    count++;
                }
            }
            return count;
        });
        total += cleared;
        if (!cleared) break;
        if (pass === 0) {
            await waitForAspPostback(page, { timeoutMs: 6000 }).catch(() => {});
        }
        await page.waitForTimeout(150);
    }
    if (total > 0) {
        log.info(`Cleared ${total} report tree checkbox(es)`);
    }
    const settleMs = Number(process.env.MMX_REPORT_TREE_CLEAR_SETTLE_MS || 250);
    await page.waitForTimeout(settleMs);
}

async function expandAllRtSpNodes(page) {
    const maxRounds = Number(process.env.MMX_REPORT_TREE_EXPAND_ROUNDS || 20);
    for (let round = 0; round < maxRounds; round++) {
        const clicked = await page.evaluate(() => {
            let count = 0;
            for (const mid of document.querySelectorAll('.rtMid')) {
                const text = (mid.textContent || '').replace(/\s+/g, ' ').trim();
                if (/\b\d{4}\b/.test(text)) continue;
                const plus = mid.querySelector('.rtPlus');
                if (plus) {
                    try {
                        plus.click();
                        count++;
                    } catch (e) {
                        /* ignore */
                    }
                }
            }
            for (const plus of document.querySelectorAll('.rtPlus')) {
                try {
                    plus.click();
                    count++;
                } catch (e) {
                    /* ignore */
                }
            }
            return count;
        });
        if (!clicked) break;
        await page.waitForTimeout(350);
    }
}

async function clearScmTreeSelectedValuesLink(page) {
    await page.evaluate(() => {
        for (const el of document.querySelectorAll('a, span, button')) {
            const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
            if (/selected values/i.test(t)) {
                try {
                    el.click();
                } catch (e) {
                    /* ignore */
                }
            }
        }
    });
    await page.waitForTimeout(500);
}

async function clearStoreTreeSelections(page) {
    await clearAllReportTreeCheckboxes(page);
}

async function selectStore(page, storeName, opts = {}) {
    const storeNumber = String(opts.storeNumber || storeName.match(/\b(\d{4})\b/)?.[1] || '').trim();
    const treeHints = storeTreeHints(storeName, storeNumber);
    const needles = storeNeedles(storeName);
    await page
        .waitForFunction(() => document.readyState === 'complete', { timeout: 15000, polling: 100 })
        .catch(() => {});

    log.info(`Selecting store for report: ${storeNumber || storeName}`);

    if (storeNumber) {
        const fromCombo = await selectStoreOnPage(page, storeNumber);
        if (fromCombo) {
            log.info(`Store selected (RadCombo): ${fromCombo}`);
            return;
        }
    }

    const [hasTree, hasDropdown] = await Promise.all([
        reportUsesStoreTree(page),
        reportHasStoreDropdown(page),
    ]);

    if (hasDropdown) {
        await waitForStoreReportDropdownReady(
            page,
            storeName,
            storeNumber,
            opts.dropdownReadyTimeoutMs || 20000
        );
    }

    const fromReportDropdown = await tryStoreReportDropdown(page, storeNumber, storeName);
    if (fromReportDropdown) {
        log.info(`Store selected (report dropdown): ${fromReportDropdown}`);
        await waitForAspPostback(page, { timeoutMs: 10000 });
        return;
    }

    for (const needle of needles) {
        const fromRadCombo = await tryStoreRadCombo(page, needle);
        if (fromRadCombo) {
            log.info(`Store selected (combo): ${fromRadCombo}`);
            await waitForAspPostback(page, { timeoutMs: 10000 });
            return;
        }
    }

    for (const needle of needles) {
        const fromDropdown = await tryStoreDropdown(page, needle);
        if (fromDropdown) {
            log.info(`Store selected (dropdown): ${fromDropdown}`);
            await waitForAspPostback(page, { timeoutMs: 10000 });
            return;
        }
    }

    if (hasTree) {
        const treeTimeoutMs = Number(
            opts.treeReadyTimeoutMs || process.env.MMX_REPORT_TREE_READY_MS || 90000
        );
        await prepareStoreTreeForSelection(page, storeName, storeNumber, treeTimeoutMs);
        await clearStoreTreeSelections(page);
        for (const needle of needles) {
            const fromTree = await tryStoreTree(page, needle, treeHints);
            if (fromTree) {
                log.info(`Store selected (tree): ${fromTree}`);
                await waitForAspPostback(page, { timeoutMs: 10000 });
                return;
            }
        }
    }

    const fromTextbox = await tryStoreReportTextboxes(page, storeNumber, storeName);
    if (fromTextbox) {
        log.info(`Store selected (textbox): ${fromTextbox}`);
        await waitForAspPostback(page, { timeoutMs: 10000 });
        return;
    }

    for (const needle of needles) {
        const clicked = await tryStoreClickByText(page, needle);
        if (clicked) {
            log.info(`Store selected (click): ${clicked}`);
            await waitForAspPostback(page, { timeoutMs: 10000 });
            return;
        }
    }

    const fromFrame = await tryStoreInFrames(page, needles);
    if (fromFrame) {
        log.info(`Store selected (frame): ${fromFrame}`);
        await waitForAspPostback(page, { timeoutMs: 10000 });
        return;
    }

    if (opts.optional) {
        log.warn(`Store not found for "${storeName}" - continuing (optional)`);
        return;
    }

    if (storeNumber) {
        const { resolveStoreOnCurrentPage, useSingleStoreLoginMode } = require('../macromatixScraper');
        const implicit = await resolveStoreOnCurrentPage(page, storeNumber, { optional: true });
        if (implicit) {
            log.info(`Store ${storeNumber} already in session (${implicit})`);
            return;
        }
        if (useSingleStoreLoginMode()) {
            log.info(`Store ${storeNumber}: single-store login - continuing without report store picker`);
            return;
        }
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
    log.info('Clicked Generate - waiting for report export');
    const postbackMs = Number(process.env.MMX_REPORT_GENERATE_POSTBACK_MS || 45000);
    await clickAndWaitForPostback(page, () => Promise.resolve(), {
        timeoutMs: postbackMs,
        skipNavigationWait: true,
    }).catch(() => {});
    await page.waitForTimeout(Number(process.env.MMX_REPORT_GENERATE_SETTLE_MS || 500));
    refreshScrapePauseTimeout();
}

function dateOpts(report) {
    return { timeZone: report.timeZone, dateOnly: Boolean(report.dateOnly) };
}

async function configureAndGenerateReport(page, report, reportNav, hooks = {}) {
    const reportLabel = report.label || report.reportName || report.id || 'report';
    const chain = hooks.chainSession;
    const useChain =
        hooks.chainReports !== false &&
        process.env.MMX_CHAIN_REPORT_DOWNLOAD !== '0' &&
        Boolean(chain);
    const emit = async (detail) => {
        if (typeof hooks.onStep === 'function') {
            await hooks.onStep(`${reportLabel}: ${detail}`);
        }
    };

    if (!useChain || !chain.hubOpen) {
        await emit('opening Report Selection…');
        await openReportSelectionPage(page, reportNav, report.navTimeoutMs || 45000);
        if (chain) chain.hubOpen = true;
    } else {
        const hubReady = await reportSelectionPageReady(page);
        if (!hubReady) {
            log.warn('Report Selection left the hub page - reopening before next report');
            chain.hubOpen = false;
            await emit('opening Report Selection…');
            await openReportSelectionPage(page, reportNav, report.navTimeoutMs || 45000);
            chain.hubOpen = true;
        } else {
            await emit('reusing Report Selection…');
        }
    }

    const group = report.group || 'Supply Chain';
    if (!useChain || chain.lastGroup !== group) {
        await emit(`choosing ${group} group…`);
        await setGroupDropdown(page, group);
        if (chain) chain.lastGroup = group;
    } else {
        await emit(`keeping ${group} group…`);
    }

    await emit(`selecting ${report.reportName}…`);
    await selectReportInList(page, report.reportName);

    const startDate = resolveReportDate(report.startDate || 'lastWeekMonday', dateOpts(report));
    const formatText = report.format || 'Excel Data Only';
    const hasEndDate = Boolean(report.endDate);

    if (!useChain || chain.lastFormat !== formatText) {
        await emit('choosing export format…');
        await setReportFormat(page, formatText);
        if (chain) chain.lastFormat = formatText;
    } else {
        await emit(`confirming export format (${formatText})…`);
        await setReportFormat(page, formatText);
    }

    if (!useChain || chain.lastStartDate !== startDate) {
        await emit(`setting start date (${startDate})…`);
        await setStartDate(page, startDate);
        if (chain) chain.lastStartDate = startDate;
    } else {
        await emit(`keeping start date (${startDate})…`);
    }

    if (hasEndDate) {
        const endDate = resolveReportDate(report.endDate, dateOpts(report));
        if (!useChain || chain.lastEndDate !== endDate) {
            await emit(`setting end date (${endDate})…`);
            await setEndDate(page, endDate);
            if (chain) chain.lastEndDate = endDate;
        } else {
            await emit(`keeping end date (${endDate})…`);
        }
        await waitForScmStoreTreeAfterDates(page);
    } else if (chain) {
        chain.lastEndDate = null;
    }

    if (report.scmTreeStoreNumber) {
        if (!hasEndDate) {
            await waitForScmStoreTreeAfterDates(page);
        }
        log.info(`SCM store tree: loading store picker for ${report.scmTreeStoreNumber}`);
        await emit(`selecting store ${report.scmTreeStoreNumber} in tree…`);
        await selectScmStoreCheckboxInTree(page, report.scmTreeStoreNumber, report.storeName, {
            skipDateWait: true,
        });
    } else if (!report.skipStoreSelection && report.storeName) {
        await emit('selecting store…');
        await selectStore(page, report.storeName, {
            storeNumber: report.storeNumber,
        });
    }

    await emit('clicking Generate - waiting for Macromatix export…');
    await clickGenerate(page, report.generateButtonText || 'Generate');
    refreshScrapePauseTimeout();
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
        await configureAndGenerateReport(page, cfg, reportNav, {
            onStep: settings.onReportStep,
            chainSession: settings.chainSession,
            chainReports: settings.chainReports,
        });
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
    selectStoreForStoreReport,
    selectScmStoreCheckboxInTree,
    listScmStoreTreeLabels,
    waitForScmStoreTreeAfterDates,
    clickGenerate,
    configureAndGenerateReport,
    runSupplyChainReport,
    isSupplyChainReport,
};
