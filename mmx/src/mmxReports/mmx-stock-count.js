const fs = require('fs');
const path = require('path');
const log = require('./util-logging');
const { lookupKeysForMmx } = require('../../../vendors/src/itemCodes');
const { enrichVariancesWithFilledItems } = require('../../../vendors/src/varianceCatalogMatch');
const { getVendorCatalog } = require('../../../vendors/src/vendorCatalog');
const { applySkipKeyItemCountOverridesToCatalog } = require('../../../vendors/src/buildToAdminOverrides');
const { GOTO_OPTS } = require('./mmx-browser');
const {
    stockCountUrlTest,
    waitForAspPostback,
    waitForEnabledButton,
    clickAndWaitForPostback,
} = require('./mmx-postback');
const { refreshScrapePauseTimeout } = require('../mmxResourceGate');

const paths = require('../../../src/paths');
const CONFIG_PATH = path.join(paths.mmx.config, 'mmx-stock-count.json');
const EXAMPLE_PATH = path.join(paths.mmx.config, 'mmx-stock-count.json.example');

/** Macromatix Key Item Count location tabs (left to right on the count screen). */
const MMX_COUNT_TABS = [
    'FREEZER',
    'CARRY OVER',
    'FRIDGE',
    'ON FLOOR - IN USE - THAW',
    'DRY',
    'SOFT DRINKS',
    'COUNT AS 0',
];

const DEFAULT_CONFIG = {
    url: 'https://tacobellau.macromatix.net/MMS_Stores_StockCount.aspx?MenuCustomItemID=156',
    countTypeValue: '0',
    countTypeText: 'Key Item Count',
    dailyCountTypeValue: '1',
    dailyCountTypeText: 'Daily',
    deleteCountButtonId: 'ctl00_ph_ButtonDelete',
    /** Dashboard storage location → MMX tab label. */
    locationTabMap: {
        Freezer: 'FREEZER',
        Carryover: 'CARRY OVER',
        'Carry Over': 'CARRY OVER',
        Fridge: 'FRIDGE',
        'In Use': 'ON FLOOR - IN USE - THAW',
        Dry: 'DRY',
        'Soft Drinks': 'SOFT DRINKS',
        BIBs: 'SOFT DRINKS',
        Freezes: 'SOFT DRINKS',
        Bottles: 'SOFT DRINKS',
        Cans: 'SOFT DRINKS',
        Other: 'SOFT DRINKS',
        'Count As 0': 'COUNT AS 0',
    },
    createCountButtonId: 'ctl00_ph_ButtonOK_input',
    countTypeSelectId: 'ctl00_ph_DropDownListCount',
    inProgressCountSelectId: 'ctl00_ph_DropDownListCounts',
    batchNumberInputId: 'ctl00_ph_TextBoxCountNo',
    statusInputId: 'ctl00_ph_TextBoxStatus',
    saveButtonIds: ['ctl00_ph_ButtonUpdate2_input', 'ctl00_ph_ButtonUpdate_input'],
    continueButtonIds: ['ctl00_ph_ButtonContinue_input', 'ctl00_ph_ButtonContinue2_input'],
    applyButtonId: 'ctl00_ph_ButtonApply',
};

function loadMmxStockCountConfig() {
    const file = fs.existsSync(CONFIG_PATH) ? CONFIG_PATH : EXAMPLE_PATH;
    if (!fs.existsSync(file)) return { ...DEFAULT_CONFIG };
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
        ...DEFAULT_CONFIG,
        ...parsed,
        locationTabMap: {
            ...DEFAULT_CONFIG.locationTabMap,
            ...(parsed.locationTabMap || {}),
        },
    };
}

function mmxTabForLocation(cfg, locationName) {
    const map = cfg.locationTabMap || {};
    return map[locationName] || String(locationName || '').toUpperCase();
}

function mmxTabKey(tab) {
    return String(tab || '')
        .trim()
        .toUpperCase();
}

/** Group dashboard location names that share one Macromatix count tab (e.g. Schweppes BIBs…Other → SOFT DRINKS). */
function groupLocationsByMmxTab(cfg, locationNames) {
    const groups = new Map();
    for (const locationName of locationNames || []) {
        const mmxTab = mmxTabForLocation(cfg, locationName);
        const key = mmxTabKey(mmxTab);
        if (!groups.has(key)) {
            groups.set(key, { mmxTab, locationNames: [] });
        }
        groups.get(key).locationNames.push(locationName);
    }
    return groups;
}

function normalizeItemCode(code) {
    return String(code || '')
        .trim()
        .toUpperCase()
        .replace(/^0+/, '');
}

function locationTabLabels() {
    return MMX_COUNT_TABS.map((t) => String(t).trim().toLowerCase());
}

function isLocationCountTabLabel(label) {
    const want = String(label || '').trim().toLowerCase();
    return locationTabLabels().some((tab) => tab === want || tab.startsWith(want) || want.startsWith(tab));
}

async function clickRadTab(page, tabLabel) {
    const want = String(tabLabel || '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
    const preferLocationStrip = isLocationCountTabLabel(want);
    const clicked = await page.evaluate(
        ({ label, preferLocationStrip }) => {
            const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
            const candidates = [];
            const pushFromRoot = (root) => {
                for (const el of root.querySelectorAll('.rtsLink, .rtsTxt, a.rtsLink, li.rtsLI')) {
                    const t = norm(el.textContent);
                    if (!t) continue;
                    candidates.push({ el, t });
                }
            };

            if (preferLocationStrip) {
                for (const strip of document.querySelectorAll('.rtsUL')) {
                    if (!/freezer|carry over|fridge|dry|soft drinks|count as 0|on floor/i.test(strip.textContent || '')) {
                        continue;
                    }
                    pushFromRoot(strip);
                    if (candidates.length) break;
                }
            }
            if (!candidates.length) {
                pushFromRoot(document);
            }

            const clickEl = (entry) => {
                const target =
                    entry.el.closest('.rtsLI')?.querySelector('.rtsLink, a.rtsLink, a') ||
                    entry.el.querySelector('.rtsLink, a, span') ||
                    entry.el;
                target.click();
                return entry.t;
            };
            for (const entry of candidates) {
                if (entry.t === label) return clickEl(entry);
            }
            for (const entry of candidates) {
                if (entry.t.startsWith(label) || label.startsWith(entry.t)) return clickEl(entry);
            }
            return null;
        },
        { label: want, preferLocationStrip }
    );
    if (!clicked) throw new Error(`MMX tab not found: ${tabLabel}`);
    log.info(`Opened MMX tab: ${clicked}`);
    await waitForLocationTabSettled(page, want, {
        timeoutMs: Number(process.env.MMX_COUNT_TAB_READY_MS || 12000),
    });
    return clicked;
}

async function waitForLocationTabSettled(page, tabLabel, options = {}) {
    const timeoutMs = options.timeoutMs ?? 15000;
    const minInputs = options.minInputs ?? 1;
    const want = String(tabLabel || '').trim().toLowerCase();
    const start = Date.now();

    await page
        .waitForResponse(
            (res) => /stockcount|inventorycount/i.test(res.url() || '') && res.status() < 400,
            { timeout: Math.min(timeoutMs, 8000) }
        )
        .catch(() => null);

    if (want) {
        await page
            .waitForFunction(
                (label) => {
                    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
                    for (const el of document.querySelectorAll(
                        '.rtsLI.rtsSelected .rtsTxt, .rtsLI.rtsSelected .rtsLink, .rtsLI.rtsSelected'
                    )) {
                        const t = norm(el.textContent);
                        if (t === label || t.startsWith(label) || label.startsWith(t)) return true;
                    }
                    return false;
                },
                { timeout: 5000, polling: 100 },
                want
            )
            .catch(() => {});
    }

    const ready = await page
        .waitForFunction(
            (min) => {
                let n = 0;
                for (const inp of document.querySelectorAll('input[id*="tbOH"]')) {
                    if (inp.disabled || inp.readOnly) continue;
                    const style = window.getComputedStyle(inp);
                    if (style.display === 'none' || style.visibility === 'hidden') continue;
                    const rect = inp.getBoundingClientRect();
                    if (rect.width > 0 && rect.height > 0) n += 1;
                }
                return n >= min;
            },
            { timeout: timeoutMs, polling: 100 },
            minInputs
        )
        .then(() => true)
        .catch(() => false);

    const inputCount = await page.evaluate(() => {
        let n = 0;
        for (const inp of document.querySelectorAll('input[id*="tbOH"]')) {
            if (inp.disabled || inp.readOnly) continue;
            const style = window.getComputedStyle(inp);
            if (style.display === 'none' || style.visibility === 'hidden') continue;
            const rect = inp.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) n += 1;
        }
        return n;
    });

    const elapsed = Date.now() - start;
    if (ready) {
        log.info(`Count grid ready - ${inputCount} input(s) in ${elapsed}ms (tab: ${want || tabLabel})`);
    } else {
        log.info(`Count grid not ready after ${elapsed}ms (tab: ${want || tabLabel}, saw ${inputCount} input(s))`);
    }
    return ready;
}

async function waitForCountGridInputs(page, timeoutMs = 15000) {
    return waitForLocationTabSettled(page, '', { timeoutMs, minInputs: 1 });
}

const MAIN_STOCK_COUNT_TAB_ALIASES = {
    'count in progress': ['count in progress', 'counts in progress', 'in progress'],
    'new count': ['new count', 'start new count', 'create new count'],
    'confirm count': ['confirm count', 'confirm'],
};

function mainStockCountTabLabels() {
    return [...new Set([...MMX_COUNT_TABS, ...Object.values(MAIN_STOCK_COUNT_TAB_ALIASES).flat()])].map((t) =>
        String(t).trim().toLowerCase()
    );
}

async function hasInProgressCountSelect(page, cfg) {
    return page.evaluate(
        (id) => Boolean(document.getElementById(id)),
        cfg.inProgressCountSelectId || DEFAULT_CONFIG.inProgressCountSelectId
    );
}

async function waitForStockCountPageReady(page, cfg) {
    const selectIds = [cfg.inProgressCountSelectId, cfg.countTypeSelectId];
    await page
        .waitForFunction(
            (ids) =>
                ids.some((id) => document.getElementById(id)) ||
                [...document.querySelectorAll('.rtsUL .rtsLink, .rtsUL .rtsTxt, a, span, button, input')].some(
                    (el) => /count in progress|new count/i.test(el.textContent || el.value || '')
                ),
            { timeout: 30000 },
            selectIds
        )
        .catch(() => {});
}

async function isNewCountPanelReady(page, cfg) {
    return page.evaluate(
        ({ countSel, countText }) => {
            const sel = document.getElementById(countSel);
            if (!sel) return false;
            const want = String(countText || '').trim().toLowerCase();
            return [...sel.options].some((o) => (o.textContent || '').trim().toLowerCase().includes(want));
        },
        { countSel: cfg.countTypeSelectId, countText: cfg.countTypeText }
    );
}

async function listVisibleMainStockCountTabs(page) {
    return page.evaluate((locationTabs) => {
        const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const loc = new Set(locationTabs);
        const seen = new Set();
        const out = [];
        const push = (t) => {
            if (!t || loc.has(t) || seen.has(t) || t.length > 40) return;
            seen.add(t);
            out.push(t);
        };

        for (const strip of document.querySelectorAll('.rtsUL')) {
            for (const el of strip.querySelectorAll('.rtsLink, .rtsTxt, li.rtsLI')) {
                push(norm(el.textContent));
            }
        }
        for (const el of document.querySelectorAll('a, button, input[type="button"], input[type="submit"]')) {
            push(norm(el.value || el.textContent));
        }
        return out.filter((t) => /count|report/i.test(t)).slice(0, 20);
    }, mainStockCountTabLabels());
}

async function clickMainTab(page, tabLabel, options = {}) {
    const want = String(tabLabel || '').trim().toLowerCase();
    const labels = MAIN_STOCK_COUNT_TAB_ALIASES[want] || [want];
    const stripFilterName = want === 'confirm count' ? 'confirm' : 'entry';
    const clicked = await page.evaluate(
        ({ labelList, locationTabs, stripFilterName }) => {
            const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
            const loc = new Set(locationTabs);
            const entryStrip = (text) => /count in progress|new count/i.test(text);
            const confirmStrip = (text) => /confirm count/i.test(text) && !entryStrip(text);
            const stripFilter = stripFilterName === 'confirm' ? confirmStrip : entryStrip;

            const pushCandidate = (list, el) => {
                const t = norm(el.value || el.textContent);
                if (!t || loc.has(t) || t.length > 40) return;
                list.push({ el, t });
            };

            const clickEl = (entry) => {
                const target =
                    entry.el.closest('.rtsLI')?.querySelector('.rtsLink, a.rtsLink, a') ||
                    entry.el.querySelector('.rtsLink, a.rtsLink, a, span') ||
                    entry.el;
                target.click();
                return entry.t;
            };

            const tryMatch = (candidates, matcher) => {
                for (const label of labelList) {
                    for (const entry of candidates) {
                        if (matcher(entry.t, label)) return { ok: true, text: clickEl(entry) };
                    }
                }
                return null;
            };

            const matchCandidates = (candidates) => {
                const exact = tryMatch(candidates, (t, label) => t === label);
                if (exact) return exact;
                const starts = tryMatch(candidates, (t, label) => t.startsWith(label) || label.startsWith(t));
                if (starts) return starts;
                return tryMatch(candidates, (t, label) => t.includes(label));
            };

            const collectFromStrips = () => {
                const out = [];
                for (const strip of document.querySelectorAll('.rtsUL')) {
                    const stripText = norm(strip.textContent || '');
                    if (!stripFilter(stripText)) continue;
                    for (const el of strip.querySelectorAll('.rtsLink, .rtsTxt, li.rtsLI')) {
                        pushCandidate(out, el);
                    }
                }
                return out;
            };

            const collectFromRadTabs = () => {
                const out = [];
                for (const el of document.querySelectorAll(
                    '.rtsTxt, a.rtsLink, li.rtsLI .rtsLink, [id*="RadTabStrip"] .rtsLink, [id*="RadTabStrip"] .rtsTxt'
                )) {
                    pushCandidate(out, el);
                }
                return out;
            };

            const collectFromClickables = () => {
                const out = [];
                for (const el of document.querySelectorAll(
                    'a, button, input[type="button"], input[type="submit"]'
                )) {
                    pushCandidate(out, el);
                }
                return out;
            };

            const passes = [collectFromStrips, collectFromRadTabs, collectFromClickables];
            const seen = new Set();
            for (const collect of passes) {
                const candidates = collect().filter((entry) => {
                    if (seen.has(entry.t)) return false;
                    seen.add(entry.t);
                    return true;
                });
                const hit = matchCandidates(candidates);
                if (hit) return hit;
            }

            return {
                ok: false,
                candidates: [...seen].slice(0, 20),
            };
        },
        { labelList: labels, locationTabs: mainStockCountTabLabels(), stripFilterName }
    );

    if (!clicked?.ok) {
        if (options.optional) return null;
        const visible = await listVisibleMainStockCountTabs(page);
        const seen = clicked?.candidates?.length ? clicked.candidates.join(', ') : visible.join(', ') || 'none';
        throw new Error(`Main tab not found: ${tabLabel} (seen: ${seen})`);
    }

    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await waitForAspPostback(page, { urlTest: stockCountUrlTest, timeoutMs: 10000 });
    log.info(`Opened stock count main tab: ${clicked.text}`);
    return clicked.text;
}

async function tryClickEntryTab(page, tabLabel, options = {}) {
    try {
        return await clickMainTab(page, tabLabel, options);
    } catch (error) {
        if (!options.optional) throw error;
        log.info(`Stock count tab "${tabLabel}" not clicked (${error.message})`);
        return null;
    }
}

async function waitForInProgressCountPanel(page, cfg, timeoutMs = 20000) {
    const selId = cfg.inProgressCountSelectId || DEFAULT_CONFIG.inProgressCountSelectId;
    await page
        .waitForFunction(
            (id) => {
                const sel = document.getElementById(id);
                return sel && sel.offsetParent !== null;
            },
            { timeout: timeoutMs },
            selId
        )
        .catch(() => {});
}

async function waitForNewCountPanel(page, cfg, timeoutMs = 20000) {
    await page
        .waitForFunction(
            (countSel) => {
                const sel = document.getElementById(countSel);
                return sel && sel.offsetParent !== null && sel.options && sel.options.length > 0;
            },
            { timeout: timeoutMs },
            cfg.countTypeSelectId
        )
        .catch(() => {});
}

async function isOnInProgressCountPanel(page, cfg) {
    const selId = cfg.inProgressCountSelectId || DEFAULT_CONFIG.inProgressCountSelectId;
    return page.evaluate((id) => {
        const sel = document.getElementById(id);
        return Boolean(sel && sel.offsetParent !== null);
    }, selId);
}

async function openCountInProgressTab(page, cfg) {
    if (await isOnInProgressCountPanel(page, cfg)) {
        log.info('Already on Count in Progress panel');
        return true;
    }

    log.info('Opening Count in Progress tab to check for an open Key Item Count');
    const clicked = await tryClickEntryTab(page, 'count in progress', { optional: true });
    if (!clicked) return false;

    await waitForInProgressCountPanel(page, cfg);
    if (await isOnInProgressCountPanel(page, cfg)) return true;

    log.info('Count in Progress tab clicked but in-progress panel did not appear');
    return false;
}

async function openNewCountTab(page, cfg) {
    if ((await isNewCountPanelReady(page, cfg)) && !(await isOnInProgressCountPanel(page, cfg))) {
        log.info('Already on New Count panel');
        return;
    }

    log.info('Opening New Count tab to start a Key Item Count');
    await tryClickEntryTab(page, 'new count');
    await waitForNewCountPanel(page, cfg);
}

async function selectCountType(page, cfg, typeOverride = null) {
    const selId = cfg.countTypeSelectId;
    const value = typeOverride?.value ?? cfg.countTypeValue;
    const text = typeOverride?.text ?? cfg.countTypeText;
    await page.evaluate(
        ({ id, value, text }) => {
            const sel = document.getElementById(id);
            if (!sel) throw new Error(`Count type select missing: ${id}`);
            let idx = -1;
            for (let i = 0; i < sel.options.length; i++) {
                const o = sel.options[i];
                if (String(o.value) === String(value) || (o.textContent || '').trim() === text) {
                    idx = i;
                    break;
                }
            }
            if (idx < 0) throw new Error(`Count type option not found: ${text}`);
            sel.selectedIndex = idx;
            sel.dispatchEvent(new Event('change', { bubbles: true }));
        },
        { id: selId, value, text }
    );
    await waitForEnabledButton(page, cfg.createCountButtonId, 10000);
}

function countTypeConfig(cfg, kind = 'key-item') {
    if (kind === 'daily') {
        return {
            value: cfg.dailyCountTypeValue ?? DEFAULT_CONFIG.dailyCountTypeValue,
            text: cfg.dailyCountTypeText ?? DEFAULT_CONFIG.dailyCountTypeText,
        };
    }
    return {
        value: cfg.countTypeValue ?? DEFAULT_CONFIG.countTypeValue,
        text: cfg.countTypeText ?? DEFAULT_CONFIG.countTypeText,
    };
}

function countTitleMatchesType(cfg, optionText, kind = 'key-item') {
    const want = String(countTypeConfig(cfg, kind).text || '')
        .trim()
        .toLowerCase();
    const text = String(optionText || '')
        .trim()
        .toLowerCase();
    if (kind === 'daily') {
        return text.includes('daily');
    }
    return text.includes(want) || text.includes('key item');
}

async function clickButtonById(page, id, options = {}) {
    const selector = `#${String(id).replace(/:/g, '\\:')}`;
    const handle = await page.$(selector);
    if (!handle) throw new Error(`Button not found: #${id}`);
    const saveLike = Boolean(options.waitForReenabled);
    const postbackMs = Number(
        options.timeoutMs ?? (saveLike ? process.env.MMX_STOCK_COUNT_SAVE_MS || 12000 : 45000)
    );
    await clickAndWaitForPostback(page, () => handle.click(), {
        urlTest: stockCountUrlTest,
        timeoutMs: postbackMs,
        skipNavigationWait: saveLike,
        skipPostbackWait: saveLike,
        elementId: options.waitForElementId,
    });
    if (options.waitForReenabled) {
        const reenableMs = Number(
            options.reenableTimeoutMs ?? process.env.MMX_STOCK_COUNT_SAVE_REENABLE_MS ?? 20000
        );
        await waitForEnabledButton(page, id, reenableMs);
    }
}

async function clickEnabledSave(page, cfg) {
    const ids = cfg.saveButtonIds || ['ctl00_ph_ButtonUpdate_input'];
    for (const id of ids) {
        const enabled = await page.evaluate((btnId) => {
            const el = document.getElementById(btnId);
            return el && !el.disabled && el.offsetParent !== null;
        }, id);
        if (!enabled) continue;
        log.info(`Saving stock count tab via #${id}`);
        const saveStarted = Date.now();
        await clickButtonById(page, id, { waitForReenabled: true });
        log.info(`Stock count tab saved via #${id} (${Date.now() - saveStarted}ms)`);
        return id;
    }
    throw new Error('No enabled Save button on stock count tab');
}

async function readCountStatus(page, cfg = {}) {
    const statusId = cfg.statusInputId || DEFAULT_CONFIG.statusInputId;
    return page.evaluate((id) => {
        const status = document.getElementById(id);
        return (status?.value || status?.textContent || '').replace(/\s+/g, ' ').trim();
    }, statusId);
}

async function readBatchNumber(page, cfg = {}) {
    const batchId = cfg.batchNumberInputId || DEFAULT_CONFIG.batchNumberInputId;
    return page.evaluate((id) => {
        const batch = document.getElementById(id);
        return (batch?.value || batch?.textContent || '').replace(/\s+/g, ' ').trim();
    }, batchId);
}

async function readSelectedCountTitle(page, cfg = {}) {
    const selId = cfg.inProgressCountSelectId || DEFAULT_CONFIG.inProgressCountSelectId;
    return page.evaluate((id) => {
        const sel = document.getElementById(id);
        return (sel?.options?.[sel.selectedIndex]?.textContent || '').replace(/\s+/g, ' ').trim();
    }, selId);
}

async function listInProgressCountOptions(page, cfg = {}) {
    const selId = cfg.inProgressCountSelectId || DEFAULT_CONFIG.inProgressCountSelectId;
    return page.evaluate((id) => {
        const sel = document.getElementById(id);
        if (!sel) return [];
        return [...sel.options].map((o) => ({
            value: o.value,
            text: (o.textContent || '').replace(/\s+/g, ' ').trim(),
        }));
    }, selId);
}

async function selectInProgressCountOption(page, cfg, optionValue) {
    const selId = cfg.inProgressCountSelectId || DEFAULT_CONFIG.inProgressCountSelectId;
    const alreadySelected = await page.evaluate(
        ({ id, value }) => document.getElementById(id)?.value === String(value),
        { id: selId, value: optionValue }
    );
    if (alreadySelected) return;

    const batchId = cfg.batchNumberInputId || DEFAULT_CONFIG.batchNumberInputId;
    const prevBatch = await readBatchNumber(page, cfg);

    await clickAndWaitForPostback(
        page,
        () =>
            page.evaluate(
                ({ id, value }) => {
                    const sel = document.getElementById(id);
                    if (!sel) throw new Error(`In-progress count select missing: ${id}`);
                    sel.value = String(value);
                    sel.dispatchEvent(new Event('change', { bubbles: true }));
                },
                { id: selId, value: optionValue }
            ),
        { urlTest: stockCountUrlTest, timeoutMs: 45000, elementId: batchId }
    );
    await page
        .waitForFunction(
            ({ id, prev }) => {
                const batch = document.getElementById(id);
                const val = (batch?.value || '').trim();
                return batch?.offsetParent !== null && (val.length > 0 ? val !== prev : true);
            },
            { timeout: 15000, polling: 100 },
            { id: batchId, prev: prevBatch }
        )
        .catch(() => {});
}

function isKeyItemCountOption(cfg, optionText) {
    return countTitleMatchesType(cfg, optionText, 'key-item');
}

async function listOpenCounts(page, cfg) {
    if (!(await openCountInProgressTab(page, cfg))) return [];
    const options = await listInProgressCountOptions(page, cfg);
    const open = [];
    for (const opt of options) {
        await selectInProgressCountOption(page, cfg, opt.value);
        const status = await readCountStatus(page, cfg);
        if (!/^open$/i.test(status)) continue;
        open.push({
            value: opt.value,
            batch: await readBatchNumber(page, cfg),
            status,
            countTitle: opt.text,
        });
    }
    return open;
}

async function findOpenKeyItemCount(page, cfg) {
    if (!(await hasInProgressCountSelect(page, cfg))) return null;
    const options = await listInProgressCountOptions(page, cfg);
    if (!options.length) return null;

    const keyItemOptions = options.filter((opt) => isKeyItemCountOption(cfg, opt.text));
    if (!keyItemOptions.length) return null;

    for (const opt of keyItemOptions) {
        await selectInProgressCountOption(page, cfg, opt.value);
        const status = await readCountStatus(page, cfg);
        if (!/^open$/i.test(status)) continue;

        return {
            batch: await readBatchNumber(page, cfg),
            status,
            countTitle: opt.text,
        };
    }

    return null;
}

async function deleteInProgressCount(page, cfg, optionValue) {
    if (!(await openCountInProgressTab(page, cfg))) {
        throw new Error('Count in Progress panel is not available.');
    }
    if (optionValue != null && optionValue !== '') {
        await selectInProgressCountOption(page, cfg, optionValue);
    }
    const deleteId = cfg.deleteCountButtonId || DEFAULT_CONFIG.deleteCountButtonId;
    const enabled = await page.evaluate((id) => {
        const el = document.getElementById(id);
        return Boolean(el && !el.disabled && el.offsetParent !== null);
    }, deleteId);
    if (!enabled) {
        throw new Error('Delete is not available for the selected count.');
    }
    log.info(`Deleting in-progress stock count via #${deleteId}`);
    await clickButtonById(page, deleteId);
    await page.waitForTimeout(Number(process.env.MMX_STOCK_COUNT_DELETE_SETTLE_MS || 600));
}

async function createNewCountBatch(page, cfg, { countKind = 'key-item', onPipelineStep } = {}) {
    if (onPipelineStep) await onPipelineStep('Starting new count…');
    await openNewCountTab(page, cfg);
    if (!(await isNewCountPanelReady(page, cfg))) {
        const visible = await listVisibleMainStockCountTabs(page);
        const hasCountSelect = await page.evaluate(
            (id) => Boolean(document.getElementById(id)),
            cfg.countTypeSelectId
        );
        throw new Error(
            `New Count panel did not load. Count type select present: ${hasCountSelect}. Tabs seen: ${visible.join(', ') || 'none'}`
        );
    }
    const typeCfg = countTypeConfig(cfg, countKind);
    await selectCountType(page, cfg, typeCfg);
    const batchId = cfg.batchNumberInputId || DEFAULT_CONFIG.batchNumberInputId;
    await clickButtonById(page, cfg.createCountButtonId);
    await page
        .waitForFunction(
            (id) => (document.getElementById(id)?.value || '').trim().length > 0,
            { timeout: 15000, polling: 100 },
            batchId
        )
        .catch(() => {});

    const created = {
        mode: 'created',
        batch: await readBatchNumber(page, cfg),
        status: await readCountStatus(page, cfg),
        countTitle: typeCfg.text,
        countKind,
    };
    log.info(
        `Created ${typeCfg.text} batch ${created.batch || '(pending)'} (status: ${created.status || 'open'})`
    );
    return created;
}

/**
 * Open, resume, delete, or create a Macromatix stock count batch.
 */
async function ensureCountEditable(page, cfg, { countKind = 'key-item', resolution = 'create', openBatchValue, onPipelineStep } = {}) {
    await waitForStockCountPageReady(page, cfg);

    if (onPipelineStep) await onPipelineStep('Checking for existing counts');

    if (resolution === 'overwrite') {
        if (!openBatchValue) {
            const openCounts = await listOpenCounts(page, cfg);
            if (!openCounts.length) {
                throw new Error('No open count to overwrite.');
            }
            const picked = openCounts[0];
            await selectInProgressCountOption(page, cfg, picked.value);
            log.info(`Resuming open count batch ${picked.batch} - ${picked.countTitle}`);
            if (onPipelineStep) {
                const batch = picked.batch ? ` (batch ${picked.batch})` : '';
                await onPipelineStep(`Resuming existing count${batch}`);
            }
            return { mode: 'in-progress', ...picked, countKind };
        }
        await openCountInProgressTab(page, cfg);
        await selectInProgressCountOption(page, cfg, openBatchValue);
        const status = await readCountStatus(page, cfg);
        const batch = await readBatchNumber(page, cfg);
        const countTitle = await readSelectedCountTitle(page, cfg);
        log.info(`Resuming selected count batch ${batch} (${status}) - ${countTitle}`);
        return { mode: 'in-progress', value: openBatchValue, batch, status, countTitle, countKind };
    }

    if (resolution === 'delete') {
        const openCounts = await listOpenCounts(page, cfg);
        if (openCounts.length) {
            const target = openBatchValue
                ? openCounts.find((row) => String(row.value) === String(openBatchValue)) || openCounts[0]
                : openCounts[0];
            if (onPipelineStep) await onPipelineStep('Deleting old count…');
            await deleteInProgressCount(page, cfg, target.value);
        }
        return createNewCountBatch(page, cfg, { countKind, onPipelineStep });
    }

    if (countKind === 'key-item') {
        const onInProgress = await openCountInProgressTab(page, cfg);
        if (onInProgress) {
            const openCount = await findOpenKeyItemCount(page, cfg);
            if (openCount) {
                log.info(
                    `Using in-progress Key Item Count batch ${openCount.batch} (status: ${openCount.status}) - ${openCount.countTitle}`
                );
                if (onPipelineStep) {
                    const batch = openCount.batch ? ` (batch ${openCount.batch})` : '';
                    await onPipelineStep(`Resuming existing Key Item Count${batch}`);
                }
                return { mode: 'in-progress', ...openCount, countKind: 'key-item' };
            }
            log.info('Count in Progress tab - no open Key Item Count batch found');
        } else {
            log.info('Count in Progress tab unavailable - will create a new Key Item Count');
        }
    } else {
        const openCounts = await listOpenCounts(page, cfg);
        if (openCounts.length) {
            throw new Error('An open count already exists - choose Overwrite or Delete old count.');
        }
    }

    log.info(`No open ${countKind} count found - starting new count`);
    return createNewCountBatch(page, cfg, { countKind, onPipelineStep });
}

async function ensureKeyItemCountEditable(page, cfg, { onPipelineStep } = {}) {
    return ensureCountEditable(page, cfg, { countKind: 'key-item', resolution: 'create', onPipelineStep });
}

async function scrapeCountGrid(page) {
    return page.evaluate(() => {
        const normCode = (s) =>
            String(s || '')
                .trim()
                .toUpperCase()
                .replace(/^0+(?=\d)/, '');

        const extractCodesFromContext = (ctx) => {
            const codes = new Set();
            const text = String(ctx || '').replace(/\s+/g, ' ').trim();
            if (!text) return [];

            const numMatch = text.match(/\b(\d{3,6}[A-Z]?)\b/i);
            if (numMatch) codes.add(normCode(numMatch[1]));

            const leadMatch = text.match(/^([A-Z0-9]{2,12})\b/i);
            if (leadMatch) codes.add(normCode(leadMatch[1]));

            return [...codes];
        };

        const byRow = new Map();

        for (const inp of document.querySelectorAll('input[id*="tbOH"]')) {
            const slotMatch = inp.id.match(/tbOH([123])$/i);
            if (!slotMatch) continue;
            if (inp.disabled || inp.readOnly) continue;
            if (String(inp.getAttribute('aria-disabled') || '').toLowerCase() === 'true') continue;
            const tr = inp.closest('tr');
            const ctx = (tr?.innerText || '').replace(/\s+/g, ' ').trim();
            const rowKey = tr?.rowIndex ?? inp.id;
            if (!byRow.has(rowKey)) {
                const codes = extractCodesFromContext(ctx);
                byRow.set(rowKey, {
                    itemCode: codes[0] || '',
                    codes,
                    ctx: ctx.slice(0, 120),
                    slotInputs: {},
                });
            }
            const row = byRow.get(rowKey);
            const slotIndex = Number(slotMatch[1]);
            const hint =
                String(inp.getAttribute('title') || '') ||
                String(inp.getAttribute('aria-label') || '') ||
                String(inp.getAttribute('data-original-title') || '') ||
                String(inp.closest('td')?.getAttribute('title') || '');
            row.slotInputs[slotIndex] = { id: inp.id, hint: String(hint || '').trim() };
            if (!row.codes.length) {
                row.codes = extractCodesFromContext(ctx);
                row.itemCode = row.codes[0] || '';
            }
        }

        return [...byRow.values()].filter((r) => r.codes.length && Object.keys(r.slotInputs).length);
    });
}

function buildGridLookup(grid) {
    const byCode = new Map();
    for (const row of grid) {
        for (const code of row.codes || []) {
            const key = normalizeItemCode(code);
            if (key && !byCode.has(key)) byCode.set(key, row);
        }
        if (row.itemCode) {
            const key = normalizeItemCode(row.itemCode);
            if (key && !byCode.has(key)) byCode.set(key, row);
        }
    }
    return byCode;
}

const NAME_MATCH_STOP_WORDS = new Set(['tb', 'tr', 'td', 'dr']);

/** Normalize description text for fuzzy Key Item Count row matching. */
function normalizeMatchText(text) {
    return String(text || '')
        .toLowerCase()
        .replace(/freeez/g, 'freeze')
        .replace(/freezez/g, 'freeze')
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function significantNameTokens(text) {
    return normalizeMatchText(text)
        .split(' ')
        .filter((t) => t.length >= 2 && !NAME_MATCH_STOP_WORDS.has(t));
}

/**
 * Match catalog line to MMX grid row when item codes differ (word order, typos, extra size text).
 */
function rowMatchesItemName(itemName, rowCtx) {
    const name = normalizeMatchText(itemName);
    const ctx = normalizeMatchText(rowCtx);
    if (!name || !ctx) return false;
    if (ctx.includes(name) || name.includes(ctx)) return true;

    const nameTokens = significantNameTokens(itemName);
    if (!nameTokens.length) return false;

    const ctxTokens = significantNameTokens(rowCtx);
    const ctxSet = new Set(ctxTokens);

    let hits = 0;
    for (const token of nameTokens) {
        if (ctxSet.has(token)) {
            hits++;
            continue;
        }
        if (ctxTokens.some((c) => c.includes(token) || token.includes(c))) hits++;
    }

    const ratio = hits / nameTokens.length;
    if (ratio >= 0.75) return true;
    if (nameTokens.length >= 4 && hits >= nameTokens.length - 1) return true;
    return nameTokens.length <= 3 && hits === nameTokens.length;
}

function findGridRow(byCode, grid, item) {
    const candidates = [
        normalizeItemCode(item.itemCode),
        normalizeItemCode(item.key),
    ].filter(Boolean);

    for (const code of candidates) {
        const row = byCode.get(code);
        if (row) return row;
    }

    const name = String(item.name || '').trim();
    if (!name) return null;

    return grid.find((row) => rowMatchesItemName(name, row.ctx)) || null;
}

/** Macromatix Key Item Count closing columns (tbOH1–tbOH3). */
const MMX_COUNT_SLOT_LABELS = {
    1: 'Closing Box (cartons/boxes)',
    2: 'Closing Inner (bags/packs)',
    3: 'Closing Unit (kg/each)',
};

/**
 * Map each non–N/a dashboard unit column to the MMX slot index used when filling counts.
 * Same order as countsToSlotValues - slot 1/2/3 align with catalog columns left to right.
 */
function normalizeUnitKind(label) {
    const s = String(label || '').trim().toLowerCase();
    if (!s || /^n\/?a$/.test(s)) return '';
    if (/box|carton|crate/.test(s)) return 'box';
    if (/inner|bag|pack|roll/.test(s)) return 'inner';
    if (/kg|each|ea|unit|litre|liter|bottle|can|tub/.test(s)) return 'unit';
    return '';
}

function catalogColumnMappings(catalogItem) {
    const mappings = [];
    let slotIndex = 1;
    for (const slot of (catalogItem?.unitSlots || []).slice(0, 3)) {
        if (slot.na) {
            slotIndex++;
            continue;
        }
        mappings.push({
            catalogLabel: slot.label,
            catalogKey: slot.key,
            catalogKind: normalizeUnitKind(slot.label),
            mmxSlot: slotIndex,
            mmxLabel: MMX_COUNT_SLOT_LABELS[slotIndex] || `Slot ${slotIndex}`,
        });
        slotIndex++;
    }
    return mappings;
}

function mmxSlotsPresent(gridRow) {
    if (!gridRow?.slotInputs) return [];
    return Object.keys(gridRow.slotInputs)
        .map(Number)
        .filter((n) => Number.isFinite(n))
        .sort((a, b) => a - b);
}

function resolveCatalogToMmxAssignments(catalogItem, gridRow) {
    const columns = catalogColumnMappings(catalogItem);
    const presentSlots = mmxSlotsPresent(gridRow);
    const assignments = [];
    const missing = [];
    const usedSlots = new Set();
    const slotMeta = gridRow?.slotInputs || {};

    for (const col of columns) {
        if (presentSlots.includes(col.mmxSlot)) {
            assignments.push({ ...col, mmxSlotResolved: col.mmxSlot });
            usedSlots.add(col.mmxSlot);
        } else {
            missing.push(col);
        }
    }

    if (missing.length) {
        const stillMissing = [];
        for (const col of missing) {
            const targetKind = col.catalogKind;
            const found = presentSlots.find((slot) => {
                if (usedSlots.has(slot)) return false;
                const hintKind = normalizeUnitKind(slotMeta?.[slot]?.hint || '');
                if (!targetKind || !hintKind) return false;
                return hintKind === targetKind;
            });
            if (found) {
                assignments.push({ ...col, mmxSlotResolved: found });
                usedSlots.add(found);
            } else {
                stillMissing.push(col);
            }
        }
        return { columns, assignments, missing: stillMissing, mmxSlots: presentSlots };
    }

    return { columns, assignments, missing, mmxSlots: presentSlots };
}

/**
 * Verify catalog count columns can be entered on the matched MMX grid row.
 */
function verifyItemGridColumns(catalogItem, gridRow) {
    const resolved = resolveCatalogToMmxAssignments(catalogItem, gridRow);
    const columns = resolved.columns;
    if (!gridRow) {
        return {
            ok: false,
            reason: 'no-row',
            columns,
            matched: [],
            missing: columns,
            mmxSlots: [],
            assignments: [],
        };
    }
    const matched = resolved.assignments;
    const missing = resolved.missing;
    return {
        ok: matched.length > 0,
        reason: missing.length ? 'missing-slots' : 'ok',
        columns,
        matched,
        missing,
        mmxSlots: resolved.mmxSlots,
        assignments: resolved.assignments,
    };
}

function formatColumnMappingSummary(columnCheck) {
    if (!columnCheck?.columns?.length) return 'no count columns';
    const parts = columnCheck.matched.map(
        (c) =>
            `${c.catalogLabel}→${(MMX_COUNT_SLOT_LABELS[c.mmxSlotResolved] || c.mmxLabel || '').replace(/^Closing /, '')}`
    );
    const miss = columnCheck.missing.map((c) => `${c.catalogLabel} needs slot ${c.mmxSlot}`);
    if (!parts.length && miss.length) return miss.join('; ');
    if (miss.length) return `${parts.join(', ')} | MISSING: ${miss.join('; ')}`;
    return parts.join(', ');
}

function countsToSlotValues(catalogItem, counts, gridRow) {
    // MMX columns: slot 1 = Closing Box (tbOH1), 2 = Closing Inner (tbOH2), 3 = Closing Unit (tbOH3).
    const values = {};
    const resolved = resolveCatalogToMmxAssignments(catalogItem, gridRow);
    for (const map of resolved.assignments) {
        const val = counts?.[map.catalogKey];
        if (val != null && Number(val) >= 0) {
            values[map.mmxSlotResolved] = String(val);
        }
    }
    return values;
}

function parseClosingNum(raw) {
    if (raw == null || raw === '' || raw === '-' || raw === '-') return null;
    const n = Number(String(raw).replace(/,/g, '').trim());
    return Number.isFinite(n) ? n : null;
}

function filledCountsToClosingArray(catalogItem, counts) {
    const slotMap = countsToSlotValues(catalogItem, counts || {});
    return [1, 2, 3].map((idx) => {
        const raw = slotMap[idx];
        if (raw == null || raw === '') return null;
        const n = Number(raw);
        return Number.isFinite(n) ? n : null;
    });
}

async function typeIntoInput(page, inputId, value) {
    const id = String(inputId || '').trim();
    if (!id) return false;
    const text = String(value);

    const setViaDom = await page.evaluate(
        (inputId, val) => {
            const inp = document.getElementById(inputId);
            if (!inp || inp.disabled || inp.readOnly) return { ok: false };
            inp.scrollIntoView({ block: 'center', inline: 'nearest' });
            inp.focus();
            inp.value = String(val);
            inp.dispatchEvent(new Event('input', { bubbles: true }));
            inp.dispatchEvent(new Event('change', { bubbles: true }));
            inp.dispatchEvent(new Event('blur', { bubbles: true }));
            return { ok: true, readBack: String(inp.value || '').trim() };
        },
        id,
        text
    );
    if (setViaDom?.ok && setViaDom.readBack === text) {
        await page.waitForTimeout(Number(process.env.MMX_STOCK_COUNT_INPUT_SETTLE_MS || 30));
        return true;
    }

    const selector = `#${id.replace(/:/g, '\\:')}`;
    await page.waitForSelector(selector, { visible: true, timeout: 8000 }).catch(() => null);
    const handle = await page.$(selector);
    if (!handle) {
        const forced = await page.evaluate(
            (inputId, val) => {
                const inp = document.getElementById(inputId);
                if (!inp || inp.disabled || inp.readOnly) return false;
                inp.focus();
                inp.value = String(val);
                inp.dispatchEvent(new Event('change', { bubbles: true }));
                return true;
            },
            id,
            text
        );
        return Boolean(forced);
    }

    try {
        await handle.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'nearest' }));
        await page.waitForTimeout(Number(process.env.MMX_STOCK_COUNT_INPUT_SCROLL_SETTLE_MS || 60));
        await handle.focus();
        await page.keyboard.down('Control');
        await page.keyboard.press('KeyA');
        await page.keyboard.up('Control');
        await page.keyboard.press('Backspace');
        await page.keyboard.type(text, { delay: Number(process.env.MMX_STOCK_COUNT_TYPE_DELAY_MS || 5) });
        await page.keyboard.press('Tab');
        await page.waitForTimeout(Number(process.env.MMX_STOCK_COUNT_INPUT_SETTLE_MS || 30));
        return true;
    } catch (error) {
        const forced = await page.evaluate(
            (inputId, val) => {
                const inp = document.getElementById(inputId);
                if (!inp || inp.disabled || inp.readOnly) return false;
                inp.focus();
                inp.value = String(val);
                inp.dispatchEvent(new Event('change', { bubbles: true }));
                return true;
            },
            id,
            text
        );
        if (!forced) throw error;
        return true;
    } finally {
        await handle.dispose();
    }
}

async function openKeyItemCountForVerification(page, cfg, options = {}) {
    await waitForStockCountPageReady(page, cfg);
    await openCountInProgressTab(page, cfg);

    const open = (await isOnInProgressCountPanel(page, cfg)) ? await findOpenKeyItemCount(page, cfg) : null;
    if (open) {
        log.info(
            `Verification using in-progress Key Item Count batch ${open.batch} (${open.status}) - ${open.countTitle}`
        );
        return { mode: 'in-progress', ...open };
    }

    if (!options.allowCreate) {
        throw new Error(
            'No open Key Item Count batch found. Open or start one in MMX first, or pass --allow-create (read-only - still no Save/Apply).'
        );
    }

    log.info('No open Key Item Count - creating a new batch for verification only (will not save)');
    return ensureKeyItemCountEditable(page, cfg);
}

function findGridRowWithAliases(byCode, grid, item, lookupKeysForMmx) {
    let row = findGridRow(byCode, grid, item);
    if (row) return row;

    const code = normalizeItemCode(item.itemCode);
    if (!code || !lookupKeysForMmx) return null;

    for (const key of lookupKeysForMmx(code)) {
        const aliasRow = byCode.get(normalizeItemCode(key));
        if (aliasRow) return aliasRow;
    }
    return null;
}

/**
 * Read-only: match vendor catalog items to MMX Key Item Count grid rows (no fill, no save).
 */
async function verifyKeyItemCountCatalog(page, catalog, cfg, options = {}) {
    const lookupKeysForMmx = options.lookupKeysForMmx || null;
    const storeNumber = String(options.storeNumber || '').trim();
    const effectiveCatalog =
        storeNumber && catalog?.items?.length
            ? applySkipKeyItemCountOverridesToCatalog(catalog, storeNumber)
            : catalog;
    const results = {
        vendor: catalog.label,
        slug: catalog.slug,
        locations: [],
        skippedKeyItemCount: [],
        summary: {
            found: 0,
            missing: 0,
            columnOk: 0,
            columnMissing: 0,
            skipped: 0,
            tabErrors: 0,
        },
    };

    for (const item of effectiveCatalog.items || []) {
        if (item.skipKeyItemCount) {
            results.skippedKeyItemCount.push({
                itemCode: item.itemCode,
                name: item.name,
                locations: item.locations,
            });
        }
    }
    results.summary.skipped = results.skippedKeyItemCount.length;

    const tabGroups = groupLocationsByMmxTab(cfg, catalog.locations || []);
    for (const { mmxTab, locationNames } of tabGroups.values()) {
        const items = (effectiveCatalog.items || []).filter(
            (item) =>
                !item.skipKeyItemCount &&
                item.locations.some((loc) => locationNames.includes(loc))
        );
        if (!items.length) continue;

        const locationName = locationNames.join(' + ');
        const locResult = {
            locationName,
            dashboardLocations: locationNames,
            mmxTab,
            gridRows: 0,
            found: [],
            missing: [],
            columnIssues: [],
            error: null,
        };

        try {
            await clickRadTab(page, mmxTab.toLowerCase());
            const grid = await scrapeCountGrid(page);
            locResult.gridRows = grid.length;
            const byCode = buildGridLookup(grid);

            for (const item of items) {
                const row = findGridRowWithAliases(byCode, grid, item, lookupKeysForMmx);
                if (!row) {
                    locResult.missing.push({
                        itemCode: item.itemCode,
                        name: item.name,
                    });
                    results.summary.missing++;
                    continue;
                }

                const columnCheck = verifyItemGridColumns(item, row);
                const entry = {
                    itemCode: item.itemCode,
                    name: item.name,
                    mmxCtx: row.ctx,
                    columns: formatColumnMappingSummary(columnCheck),
                    columnCheck,
                };

                if (columnCheck.ok) {
                    locResult.found.push(entry);
                    results.summary.found++;
                    results.summary.columnOk++;
                } else {
                    locResult.columnIssues.push(entry);
                    results.summary.columnMissing++;
                }
            }
        } catch (err) {
            locResult.error = err.message || String(err);
            results.summary.tabErrors++;
            for (const item of items) {
                locResult.missing.push({
                    itemCode: item.itemCode,
                    name: item.name,
                    reason: locResult.error,
                });
                results.summary.missing++;
            }
        }

        results.locations.push(locResult);
    }

    return results;
}

async function fillLocationTab(page, cfg, catalog, locationName, itemsAtLocation, onPipelineStep) {
    const mmxTab = mmxTabForLocation(cfg, locationName);
    if (onPipelineStep) await onPipelineStep(`Filling ${locationName} tab`);
    await clickRadTab(page, mmxTab.toLowerCase());

    let grid = await scrapeCountGrid(page);
    if (!grid.length) {
        await waitForLocationTabSettled(page, mmxTab.toLowerCase(), { timeoutMs: 12000, minInputs: 1 });
        grid = await scrapeCountGrid(page);
    }
    if (!grid.length) {
        throw new Error(
            `Macromatix ${mmxTab} tab did not load - cannot enter ${locationName} counts. Try again or fill that tab in MMX manually.`
        );
    }
    const byCode = buildGridLookup(grid);
    let filled = 0;
    const missed = [];

    for (const item of itemsAtLocation) {
        const counts = item.counts || {};
        const hasAny = Object.values(counts).some((v) => Number(v) > 0);
        if (!hasAny) continue;

        let row = findGridRow(byCode, grid, item);
        if (!row) row = findGridRowWithAliases(byCode, grid, item, lookupKeysForMmx);
        if (!row) {
            missed.push(item.itemCode || item.key || item.name);
            continue;
        }

        const columnCheck = verifyItemGridColumns(item, row);
        if (!columnCheck.ok) {
            const labels = columnCheck.missing.map((c) => c.catalogLabel).join(', ');
            missed.push(`${item.itemCode || item.name} (no MMX field for: ${labels})`);
            continue;
        }

        const slotValues = countsToSlotValues(item, counts, row);
        for (const [slot, val] of Object.entries(slotValues)) {
            if (val === '') continue;
            const slotNum = Number(slot);
            let inputId = row.slotInputs?.[slotNum]?.id;
            if (!inputId) continue;

            const liveId = await page.evaluate(
                (code, slotIndex) => {
                    const normCode = (s) =>
                        String(s || '')
                            .trim()
                            .toUpperCase()
                            .replace(/^0+(?=\d)/, '');
                    const want = normCode(code);
                    for (const inp of document.querySelectorAll('input[id*="tbOH"]')) {
                        const m = inp.id.match(/tbOH([123])$/i);
                        if (!m || Number(m[1]) !== slotIndex) continue;
                        if (inp.disabled || inp.readOnly) continue;
                        const tr = inp.closest('tr');
                        const ctx = (tr?.innerText || '').replace(/\s+/g, ' ');
                        if (want && !ctx.toUpperCase().includes(want)) continue;
                        return inp.id;
                    }
                    return '';
                },
                item.itemCode || row.itemCode || '',
                slotNum
            );
            if (liveId) inputId = liveId;

            const wrote = await typeIntoInput(page, inputId, val);
            if (!wrote) {
                missed.push(`${item.itemCode || item.name} (could not set slot ${slot})`);
            }
        }
        filled++;
    }

    if (missed.length) {
        log.info(`MMX ${mmxTab}: could not match ${missed.length} item(s): ${missed.join(', ')}`);
    }

    const expectedCount = itemsAtLocation.filter((item) =>
        Object.values(item.counts || {}).some((v) => Number(v) > 0)
    ).length;
    if (expectedCount > 0 && filled === 0) {
        throw new Error(
            `No counts were entered on Macromatix ${mmxTab} (${locationName}). ${missed.length ? `Could not match: ${missed.slice(0, 8).join(', ')}` : 'Count grid was empty or unreadable.'}`
        );
    }

    await clickEnabledSave(page, cfg);
    refreshScrapePauseTimeout();
    await waitForLocationTabSettled(page, mmxTab.toLowerCase(), {
        timeoutMs: Number(process.env.MMX_STOCK_COUNT_SAVE_SETTLE_MS || 15000),
        minInputs: 1,
    });
    return { locationName, mmxTab, filled, missed, expectedCount };
}

function dashboardLocationOrder(cfg) {
    const map = cfg.locationTabMap || DEFAULT_CONFIG.locationTabMap;
    const tabToLocation = new Map();
    for (const [location, tab] of Object.entries(map)) {
        const key = String(tab || '').trim().toUpperCase();
        if (!tabToLocation.has(key)) tabToLocation.set(key, location);
    }
    const ordered = [];
    for (const tab of MMX_COUNT_TABS) {
        const loc = tabToLocation.get(tab);
        if (loc && !ordered.includes(loc)) ordered.push(loc);
    }
    return ordered;
}

function mergeVendorEntriesByLocation(vendorEntries) {
    const byLocation = new Map();

    for (const entry of vendorEntries) {
        const { catalog, draftLocations } = entry;
        if (!catalog || !draftLocations) continue;

        for (const locationName of catalog.locations) {
            const locData = draftLocations[locationName];
            if (!locData || typeof locData !== 'object') continue;

            const itemsAtLocation = catalog.items
                .filter((item) => item.locations.includes(locationName) && !item.skipKeyItemCount)
                .map((item) => ({
                    key: item.key,
                    itemCode: item.itemCode,
                    name: item.name,
                    unitSlots: item.unitSlots,
                    skipKeyItemCount: Boolean(item.skipKeyItemCount),
                    counts: locData[item.key] || {},
                    vendorLabel: catalog.label,
                    vendorSlug: entry.slug,
                }))
                .filter((item) => Object.values(item.counts).some((v) => Number(v) > 0));

            if (!itemsAtLocation.length) continue;

            if (!byLocation.has(locationName)) byLocation.set(locationName, []);
            byLocation.get(locationName).push(...itemsAtLocation);
        }
    }

    return byLocation;
}

async function clickButtonByValue(page, label) {
    const want = String(label || '').trim().toLowerCase();
    const clicked = await page.evaluate((text) => {
        for (const el of document.querySelectorAll('input[type="button"], input[type="submit"], button, a')) {
            const t = (el.value || el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
            if (t !== text || el.disabled || el.offsetParent === null) continue;
            el.click();
            return t;
        }
        return null;
    }, want);
    if (!clicked) return false;
    await waitForAspPostback(page, { urlTest: stockCountUrlTest, timeoutMs: 45000 });
    return true;
}

async function clickContinueToConfirm(page, cfg) {
    const ids = cfg.continueButtonIds || ['ctl00_ph_ButtonContinue_input'];
    for (const id of ids) {
        const enabled = await page.evaluate((btnId) => {
            const el = document.getElementById(btnId);
            return el && !el.disabled && el.offsetParent !== null;
        }, id);
        if (!enabled) continue;
        log.info(`Continuing to confirm count via #${id}`);
        await clickButtonById(page, id);
        return id;
    }
    if (await clickButtonByValue(page, 'Continue')) {
        log.info('Continuing to confirm count via Continue button');
        return 'Continue';
    }
    throw new Error('Continue button not found on stock count page.');
}

async function waitForContinueEnabled(page, cfg, timeoutMs = 20000) {
    const ids = cfg.continueButtonIds || DEFAULT_CONFIG.continueButtonIds;
    await page
        .waitForFunction(
            (btnIds) =>
                btnIds.some((btnId) => {
                    const el = document.getElementById(btnId);
                    return el && !el.disabled && el.offsetParent !== null;
                }),
            { timeout: timeoutMs },
            ids
        )
        .catch(() => {});
}

/**
 * MMX only enables Continue while viewing a location tab that has saved counts.
 */
async function clickContinueFromFilledTab(page, cfg, filledTabs) {
    const tabsWithCounts = (filledTabs || []).filter((tab) => tab.filled > 0);
    if (!tabsWithCounts.length) {
        throw new Error(
            'No Macromatix location tabs received counts - nothing to continue to confirm count.'
        );
    }

    const target = tabsWithCounts[tabsWithCounts.length - 1];
    log.info(`Opening ${target.mmxTab} tab before Continue (${target.filled} item(s) saved)`);
    await clickRadTab(page, target.mmxTab.toLowerCase());
    await waitForContinueEnabled(page, cfg);

    const enabled = await page.evaluate((btnIds) => {
        return btnIds.some((btnId) => {
            const el = document.getElementById(btnId);
            return el && !el.disabled && el.offsetParent !== null;
        });
    }, cfg.continueButtonIds || DEFAULT_CONFIG.continueButtonIds);

    if (!enabled) {
        throw new Error(
            `Continue is still disabled on ${target.mmxTab} - save counts on a location tab first.`
        );
    }

    return clickContinueToConfirm(page, cfg);
}

async function scrapeConfirmCountVariances(page) {
    await page
        .waitForFunction(
            () =>
                /review your inventory variances|expected variance/i.test(document.body?.innerText || ''),
            { timeout: 45000 }
        )
        .catch(() => {});

    return page.evaluate(() => {
        const parseNum = (raw) => {
            const s = String(raw ?? '')
                .replace(/[$,]/g, '')
                .trim();
            if (!s || s === '-' || s === '-') return null;
            const n = Number(s);
            return Number.isFinite(n) ? n : null;
        };

        const parseRgb = (bg) => {
            const m = String(bg || '').match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
            if (!m) return null;
            return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) };
        };

        const highlightFromElement = (el) => {
            if (!el) return 'none';
            const nodes = [el, el.querySelector('input'), el.querySelector('span')].filter(Boolean);
            for (const node of nodes) {
                const inline = (node.getAttribute('style') || '').toLowerCase();
                if (/background[^;]*(red|#f00|#ff0000|pink|#ffc)/i.test(inline)) return 'red';
                const rgb = parseRgb(window.getComputedStyle(node).backgroundColor);
                if (!rgb) continue;
                const { r, g, b } = rgb;
                if (r > 240 && g > 240 && b > 240) continue;
                if (g > r + 25 && g > b + 25) return 'green';
                if (r > g + 15 && r > b + 15 && r > 160) return 'red';
            }
            return 'none';
        };

        const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

        const isVarianceHeaderRow = (cells) => {
            if (cells.length < 5 || cells.length > 16) return false;
            const mashed = cells.some(
                (c) => c.includes('expected variance') && c.includes('stock on hand') && c.length > 40
            );
            if (mashed) return false;
            return (
                cells.some((c) => c === 'item') &&
                cells.some((c) => c.includes('expected variance')) &&
                cells.some((c) => c.includes('variance value')) &&
                cells.some((c) => c.includes('stock on hand'))
            );
        };

        let headerRow = null;
        let headerCells = null;
        let table = null;
        for (const tbl of document.querySelectorAll('table')) {
            for (const tr of tbl.querySelectorAll('tr')) {
                const cells = [...tr.querySelectorAll('th, td')];
                const texts = cells.map((c) => norm(c.textContent));
                if (!isVarianceHeaderRow(texts)) continue;
                headerRow = texts;
                headerCells = cells;
                table = tbl;
                break;
            }
            if (table) break;
        }

        if (!table || !headerRow) return [];

        const col = (label) => headerRow.findIndex((c) => c.includes(label));
        const itemIdx = headerRow.findIndex((c) => c === 'item');
        const nameIdx = itemIdx >= 0 ? itemIdx + 1 : -1;
        const unitColIdx = headerRow.findIndex((c) => c === 'unit');
        const boxIdx = headerRow.findIndex((c) => c.startsWith('closing box'));
        const innerIdx = headerRow.findIndex((c) => c.startsWith('closing inner'));
        const unitIdx = headerRow.findIndex((c) => c.startsWith('closing unit'));
        const stockIdx = headerRow.findIndex((c) => c.includes('stock on hand'));
        const varianceQtyIdx = col('expected variance');
        const varianceValueIdx = col('variance value');

        const rows = [];
        for (const tr of table.querySelectorAll('tr')) {
            const cells = [...tr.querySelectorAll('td')];
            if (!cells.length || cells.length < 4) continue;

            const getText = (idx) => {
                if (idx < 0 || !cells[idx]) return '';
                const cell = cells[idx];
                const input = cell.querySelector('input, textarea');
                const raw =
                    input && String(input.value || '').trim()
                        ? input.value
                        : cell.textContent;
                return String(raw).replace(/\s+/g, ' ').trim();
            };
            const getCell = (idx) => (idx >= 0 ? cells[idx] : null);

            const itemCodeText = getText(itemIdx);
            if (!/^\d{3,6}[A-Z]?$/i.test(itemCodeText)) continue;

            const itemName = getText(nameIdx) || itemCodeText;
            const varianceQtyCell = getCell(varianceQtyIdx);
            const varianceValueCell = getCell(varianceValueIdx);
            const qtyHighlight = highlightFromElement(varianceQtyCell);
            const valueHighlight = highlightFromElement(varianceValueCell);
            const isRed = qtyHighlight === 'red' || valueHighlight === 'red';
            if (!isRed) continue;

            const stockCounted = parseNum(getText(stockIdx));
            const varianceQty = parseNum(getText(varianceQtyIdx));
            const varianceValue = parseNum(getText(varianceValueIdx));
            let stockExpected = null;
            if (stockCounted != null && varianceQty != null) {
                stockExpected = stockCounted - varianceQty;
            }

            rows.push({
                itemCode: itemCodeText,
                itemName,
                unit: getText(unitColIdx) || getText(unitIdx) || '',
                closingBox: getText(boxIdx) || '-',
                closingInner: getText(innerIdx) || '-',
                closingUnit: getText(unitIdx) || '-',
                stockCounted,
                stockExpected,
                varianceQty,
                varianceValue,
                isRed: true,
            });
        }

        return rows;
    });
}

async function isStockCountConfirmScreen(page, cfg) {
    const applyId = cfg.applyButtonId || DEFAULT_CONFIG.applyButtonId;
    return page.evaluate((btnId) => {
        const apply = document.getElementById(btnId);
        if (apply && apply.offsetParent !== null) return true;
        const text = (document.body?.innerText || '').replace(/\s+/g, ' ');
        return /confirm\s+count/i.test(text) || /variance\s+value/i.test(text);
    }, applyId);
}

/**
 * Click Apply on the confirm screen when enabled (waits for MMX to enable the button).
 * @returns {{ applied: boolean, alreadyApplied: boolean }}
 */
async function applyKeyItemCount(page, cfg) {
    const applyId = cfg.applyButtonId;
    if (!applyId) throw new Error('Apply button id not configured.');
    const maxMs = Number(process.env.MMX_APPLY_WAIT_MS || 60000);
    const pollMs = 500;
    const start = Date.now();
    let loggedWait = false;

    while (Date.now() - start < maxMs) {
        const enabled = await page.evaluate((btnId) => {
            const el = document.getElementById(btnId);
            return el && !el.disabled && el.offsetParent !== null;
        }, applyId);
        if (enabled) {
            log.info(`Applying Key Item Count via #${applyId}`);
            await clickButtonById(page, applyId);
            return { applied: true, alreadyApplied: false };
        }
        if (await clickButtonByValue(page, 'Apply')) {
            log.info('Applying Key Item Count via Apply button');
            return { applied: true, alreadyApplied: false };
        }

        if (!(await isStockCountConfirmScreen(page, cfg))) {
            log.info('Key Item Count already applied in Macromatix - nothing to apply on this screen');
            return { applied: false, alreadyApplied: true };
        }

        if (!loggedWait) {
            log.info('Waiting for Key Item Count Apply button to enable…');
            loggedWait = true;
        }
        await new Promise((resolve) => setTimeout(resolve, pollMs));
    }

    throw new Error('Apply button not enabled on confirm count screen.');
}

async function applyKeyItemCountIfReady(page, cfg) {
    const applyId = cfg.applyButtonId;
    if (!applyId) return false;

    const enabled = await page.evaluate((btnId) => {
        const el = document.getElementById(btnId);
        return el && !el.disabled && el.offsetParent !== null;
    }, applyId);

    if (!enabled) {
        log.info('Key Item Count apply button not enabled - count saved tab-by-tab only');
        return false;
    }

    log.info(`Applying Key Item Count via #${applyId}`);
    await clickButtonById(page, applyId);
    return true;
}

/**
 * Enter all submitted vendor counts into one Macromatix Key Item Count (tab by tab).
 * @param {object} opts - { page, storeNumber, vendorEntries, navTimeoutMs, selectStore }
 *   vendorEntries: [{ slug, catalog, draftLocations }]
 */
async function enterCombinedStockCount(page, opts) {
    const cfg = loadMmxStockCountConfig();
    const vendorEntries = opts.vendorEntries || [];
    const navTimeoutMs = opts.navTimeoutMs || 45000;

    if (!vendorEntries.length) {
        throw new Error('No vendor counts to send to Macromatix.');
    }

    const byLocation = mergeVendorEntriesByLocation(vendorEntries);
    if (!byLocation.size) {
        throw new Error('No location counts to send to Macromatix.');
    }

    const locationOrder = dashboardLocationOrder(cfg);
    const extraLocations = [...byLocation.keys()].filter((loc) => !locationOrder.includes(loc)).sort();
    const locationsToFill = [...locationOrder.filter((loc) => byLocation.has(loc)), ...extraLocations];

    log.info(
        `Opening stock count page for store ${opts.storeNumber} - ${vendorEntries.length} vendor(s), ${locationsToFill.length} location tab(s)`
    );
    if (opts.onPipelineStep) await opts.onPipelineStep('Opening stock count in Macromatix');
    await page.goto(cfg.url, { ...GOTO_OPTS, timeout: navTimeoutMs });
    await waitForStockCountPageReady(page, cfg);

    if (opts.selectStore) {
        if (opts.onPipelineStep) await opts.onPipelineStep('Selecting store in Macromatix');
        await opts.selectStore(page, opts.storeNumber);
        await waitForStockCountPageReady(page, cfg);
    }

    const countMode = await ensureCountEditable(page, cfg, {
        countKind: opts.countKind || 'key-item',
        resolution: opts.countResolution || 'create',
        openBatchValue: opts.openBatchValue,
        onPipelineStep: opts.onPipelineStep,
    });

    const filledItems = [];
    const results = [];
    const fillGroups = groupLocationsByMmxTab(cfg, locationsToFill);
    for (const { mmxTab, locationNames } of fillGroups.values()) {
        if (mmxTabKey(mmxTab) === 'COUNT AS 0') continue;
        const itemsAtLocation = [];
        for (const locationName of locationNames) {
            const chunk = byLocation.get(locationName) || [];
            for (const item of chunk) {
                filledItems.push({ ...item, locationName });
            }
            itemsAtLocation.push(...chunk);
        }
        if (!itemsAtLocation.length) continue;

        const label =
            locationNames.length > 1 ? `${locationNames.join(' + ')} → ${mmxTab}` : locationNames[0];
        log.info(`Filling ${label} (${itemsAtLocation.length} item(s))`);
        const result = await fillLocationTab(
            page,
            cfg,
            null,
            locationNames[0],
            itemsAtLocation,
            opts.onPipelineStep
        );
        result.locationName = label;
        result.dashboardLocations = locationNames;
        result.mmxTab = mmxTab;
        results.push(result);

        if (result.expectedCount > 0 && result.filled === 0) {
            throw new Error(
                `Macromatix did not accept counts for ${label}. ${(result.missed || []).slice(0, 6).join(', ')}`
            );
        }
        if (result.missed?.length) {
            log.warn(
                `MMX ${result.mmxTab}: ${result.filled}/${result.expectedCount} line(s) entered; missed: ${result.missed.join(', ')}`
            );
        }
    }

    const tabsWithCounts = results.filter((tab) => tab.filled > 0);
    if (!tabsWithCounts.length) {
        throw new Error('No location counts were entered in Macromatix.');
    }
    const skippedTabs = locationsToFill.filter(
        (loc) => !results.some((r) => (r.dashboardLocations || []).includes(loc) && r.filled > 0)
    );
    if (skippedTabs.length) {
        log.warn(
            `Store ${opts.storeNumber}: Macromatix skipped location(s) with no entered lines: ${skippedTabs.join(', ')}`
        );
    }

    if (!results.length) {
        throw new Error('No location counts to send to Macromatix.');
    }

    if (opts.stopAtConfirm) {
        if (opts.onPipelineStep) await opts.onPipelineStep('Checking variances');
        await clickContinueFromFilledTab(page, cfg, results);
        const rawVariances = await scrapeConfirmCountVariances(page);
        const catalogsBySlug = new Map(
            vendorEntries.map((entry) => [
                entry.slug,
                getVendorCatalog(entry.slug) || entry.catalog,
            ])
        );
        const variances = enrichVariancesWithFilledItems(
            rawVariances,
            filledItems,
            catalogsBySlug,
            filledCountsToClosingArray
        );
        log.info(`Confirm count loaded - ${variances.length} red variance row(s)`);
        return {
            mode: 'key-item-count-combined',
            countMode,
            vendorSlugs: vendorEntries.map((e) => e.slug),
            tabs: results,
            variances,
        };
    }

    const applied = await applyKeyItemCountIfReady(page, cfg);

    return {
        mode: 'key-item-count-combined',
        countMode,
        applied,
        vendorSlugs: vendorEntries.map((e) => e.slug),
        tabs: results,
    };
}

/**
 * Enter dashboard stock counts for one vendor into Macromatix Key Item Count.
 * @param {object} opts - { page, storeNumber, catalog, draftLocations, navTimeoutMs }
 */
async function enterVendorStockCount(page, opts) {
    return enterCombinedStockCount(page, {
        storeNumber: opts.storeNumber,
        navTimeoutMs: opts.navTimeoutMs,
        selectStore: opts.selectStore,
        vendorEntries: [
            {
                slug: opts.catalog?.slug,
                catalog: opts.catalog,
                draftLocations: opts.draftLocations,
            },
        ],
    });
}

module.exports = {
    MMX_COUNT_TABS,
    loadMmxStockCountConfig,
    enterCombinedStockCount,
    enterVendorStockCount,
    ensureKeyItemCountEditable,
    ensureCountEditable,
    listOpenCounts,
    deleteInProgressCount,
    createNewCountBatch,
    countTypeConfig,
    openCountInProgressTab,
    listInProgressCountOptions,
    openKeyItemCountForVerification,
    verifyKeyItemCountCatalog,
    scrapeCountGrid,
    buildGridLookup,
    findGridRow,
    rowMatchesItemName,
    normalizeMatchText,
    scrapeConfirmCountVariances,
    clickContinueFromFilledTab,
    applyKeyItemCount,
    isStockCountConfirmScreen,
    normalizeItemCode,
    MMX_COUNT_SLOT_LABELS,
    catalogColumnMappings,
    verifyItemGridColumns,
    formatColumnMappingSummary,
    mergeVendorEntriesByLocation,
    mmxTabForLocation,
};
