const { closeBrowserQuietly } = require('../../mmx/src/macromatixScraper');
const {
    createAuthenticatedLifeLenzSession,
    parseStoreLabel,
    dedupeStores,
    selectLifeLenzArea,
    resolveLifeLenzArea,
} = require('./lifelenzAuth');
const { aggregateDayPartsFromHourlyPlan, LIFELENZ_DAY_PARTS } = require('./lifelenzDayParts');
const { pasteIntoInput } = require('./lifelenzInput');

const DAY_PART_INPUT_SELECTOR = 'input.forecast-adjustment.form-control, input.input-number.forecast-adjustment';
const DEFAULT_DAY_PART_INPUT_TIMEOUT_MS = 45000;
const DEFAULT_DAY_VIEW_SWITCH_TIMEOUT_MS = 45000;
const DAY_PART_INPUT_COUNT = 9;
const DEFAULT_POLL_MS = 100;
const DEFAULT_POLL_MS_HEADED = 150;
const DAY_PART_STABLE_READS = 2;
const DATE_NAV_TIMEOUT_MS = 20000;
const STORE_PICKER_TIMEOUT_MS = 15000;
const FORECAST_CHROME_TIMEOUT_MS = 20000;
const DATEPICKER_TIMEOUT_MS = 10000;
const ANALYTICS_MENU_TIMEOUT_MS = 10000;
// Upper bound on the post-save reload wait. Polls until inputs return; cap only limits slow reloads.
const DEFAULT_QUIRK_RELOAD_MAX_MS = 8000;
const VERIFY_TIMEOUT_MS_HEADLESS = 6000;
const VERIFY_TIMEOUT_MS_HEADED = 10000;
const WRITE_DAY_MAX_ATTEMPTS = 2;
const FORECAST_DATE_TOOLBAR_SELECTOR =
    '.display-date, a.display-date, [aria-label="Open calendar picker"]';
const FORECAST_CHROME_SELECTOR =
    'a.calendar-unit-link.day, .display-date, a.display-date, [aria-label="Open calendar picker"]';
const DATEPICKER_WIDGET_SELECTOR =
    '.datepicker.datepicker-dropdown, .bootstrap-datetimepicker-widget.dropdown-menu, .bootstrap-datetimepicker-widget, .datepicker:not(.datepicker-inline)';

function isHeadlessOptions(options = {}) {
    return options.headless !== false;
}

function resolvePollMs(options = {}) {
    if (Number.isFinite(options.pollMs)) return options.pollMs;
    return isHeadlessOptions(options) ? DEFAULT_POLL_MS : DEFAULT_POLL_MS_HEADED;
}

function resolveVerifyTimeoutMs(options = {}) {
    if (Number.isFinite(options.verifyTimeoutMs)) return options.verifyTimeoutMs;
    return isHeadlessOptions(options) ? VERIFY_TIMEOUT_MS_HEADLESS : VERIFY_TIMEOUT_MS_HEADED;
}

function resolveDateNavTimeoutMs(options = {}) {
    if (Number.isFinite(options.dateNavTimeoutMs)) return options.dateNavTimeoutMs;
    const raw = process.env.LIFELENZ_DATE_NAV_TIMEOUT_MS;
    if (raw !== undefined && raw !== '') {
        const n = Number(raw);
        if (Number.isFinite(n) && n > 0) return n;
    }
    return DATE_NAV_TIMEOUT_MS;
}

/** Poll until checkFn returns a truthy value. Survives SPA navigation context errors. */
async function pollUntil(checkFn, { timeoutMs = 15000, pollMs = DEFAULT_POLL_MS, label = 'condition' } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const result = await checkFn();
            if (result) return result;
        } catch (err) {
            if (!isDestroyedContextError(err)) throw err;
        }
        await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    return null;
}

/** Poll until N consecutive reads show enough visible day-part inputs. */
async function waitForDayPartInputsStable(page, options = {}, timeoutMs) {
    const cap = Number.isFinite(timeoutMs) ? timeoutMs : resolveDayPartInputTimeoutMs(options);
    const pollMs = resolvePollMs(options);
    const stableNeeded = DAY_PART_STABLE_READS;
    let stableCount = 0;
    const deadline = Date.now() + cap;

    while (Date.now() < deadline) {
        let count = 0;
        try {
            count = await countVisibleDayPartInputs(page);
        } catch (err) {
            if (!isDestroyedContextError(err)) throw err;
            count = 0;
        }
        if (count >= DAY_PART_INPUT_COUNT) {
            stableCount += 1;
            if (stableCount >= stableNeeded) return true;
        } else {
            stableCount = 0;
        }
        await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    return false;
}

async function waitForForecastDateToolbar(page, options = {}) {
    const timeoutMs = Number.isFinite(options.toolbarTimeoutMs) ? options.toolbarTimeoutMs : FORECAST_CHROME_TIMEOUT_MS;
    await page.waitForSelector(FORECAST_DATE_TOOLBAR_SELECTOR, { visible: true, timeout: timeoutMs }).catch(() => null);
    return pollUntil(
        async () => {
            const visible = await page.$(FORECAST_DATE_TOOLBAR_SELECTOR);
            if (!visible) return false;
            const box = await visible.boundingBox().catch(() => null);
            return Boolean(box && box.width > 0 && box.height > 0);
        },
        { timeoutMs: Math.min(timeoutMs, 5000), pollMs: resolvePollMs(options), label: 'forecast date toolbar' }
    );
}

async function waitForDatepickerWidget(page, options = {}, timeoutMs = DATEPICKER_TIMEOUT_MS) {
    return pollUntil(
        () =>
            page.evaluate((selector) => {
                for (const el of document.querySelectorAll(selector)) {
                    const r = el.getBoundingClientRect();
                    if (r.width > 0 && r.height > 0) return true;
                }
                return false;
            }, DATEPICKER_WIDGET_SELECTOR),
        { timeoutMs, pollMs: resolvePollMs(options), label: 'datepicker widget' }
    );
}

async function waitForDropdownOptions(page, options = {}, timeoutMs = STORE_PICKER_TIMEOUT_MS) {
    return pollUntil(
        () =>
            page.evaluate(() => {
                const container =
                    document.querySelector('[role="listbox"]') ||
                    document.querySelector('[role="menu"]') ||
                    document.querySelector('[data-radix-popper-content-wrapper]');
                if (container) {
                    const r = container.getBoundingClientRect();
                    if (
                        r.width > 0 &&
                        r.height > 0 &&
                        container.querySelector('[role="option"], [role="menuitem"], li, button, a')
                    ) {
                        return true;
                    }
                }
                // Hierarchical location picker (Area → stores): search + area codes / store rows.
                for (const input of document.querySelectorAll('input')) {
                    const ph = String(input.getAttribute('placeholder') || '');
                    if (/search by name or code/i.test(ph)) {
                        const r = input.getBoundingClientRect();
                        if (r.width > 0 && r.height > 0) return true;
                    }
                }
                for (const el of document.querySelectorAll('button, a, [role="treeitem"], li, div, span')) {
                    const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
                    const r = el.getBoundingClientRect();
                    if (r.width <= 0 || r.height <= 0) continue;
                    if (/^T\d{2}$/i.test(text)) return true;
                    if (/^\d{4}\s*-\s*\S/.test(text) && text.length < 120) return true;
                }
                return false;
            }),
        { timeoutMs, pollMs: resolvePollMs(options), label: 'store dropdown options' }
    );
}

async function waitForAnalyticsMenuOpen(page, options = {}, timeoutMs = ANALYTICS_MENU_TIMEOUT_MS) {
    return pollUntil(
        () =>
            page.evaluate(() => {
                for (const el of document.querySelectorAll(
                    '[role="menuitem"], [role="option"], span, a, button, li'
                )) {
                    const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
                    if (!/^forecast$/i.test(text)) continue;
                    const r = el.getBoundingClientRect();
                    if (r.width > 0 && r.height > 0) return true;
                }
                return false;
            }),
        { timeoutMs, pollMs: resolvePollMs(options), label: 'analytics forecast menu' }
    );
}

async function waitForInputValueAt(page, index, expected, options = {}, timeoutMs = 4000) {
    const expectedStr = String(expected);
    const numericExpected = /^-?\d+(\.\d+)?$/.test(expectedStr.trim());
    const ok = await pollUntil(
        async () => {
            const raw = await page.evaluate(
                (selector, idx) => {
                    const inputs = [...document.querySelectorAll(selector)].filter((input) => {
                        const r = input.getBoundingClientRect();
                        return r.width > 0 && r.height > 0;
                    });
                    return inputs[idx]?.value ?? '';
                },
                DAY_PART_INPUT_SELECTOR,
                index
            );
            if (numericExpected) {
                const actual = parseDayPartInputNumber(raw);
                return actual != null && Math.round(actual) === Math.round(Number(expectedStr));
            }
            return String(raw).trim().toLowerCase() === expectedStr.trim().toLowerCase();
        },
        { timeoutMs, pollMs: resolvePollMs(options), label: `day-part input ${index}` }
    );
    return Boolean(ok);
}

/** True for puppeteer evaluate errors caused by an in-flight SPA navigation. */
function isDestroyedContextError(err) {
    return /context was destroyed|Execution context|Cannot find context/i.test(err?.message || '');
}

function isNonClickableNodeError(err) {
    return /not clickable|not an HTMLElement|detached|Node is detached/i.test(err?.message || '');
}

/**
 * Click through Puppeteer handles that may point at icons/spans inside controls.
 * Falls back to DOM .click() and mouse coordinates when ElementHandle.click() fails.
 */
async function safeClickHandle(page, handle) {
    if (!handle) return false;
    try {
        await handle.evaluate((el) => {
            const target =
                el.closest?.('a, button, input, [role="button"], [role="menuitem"], [role="option"], label') ||
                el;
            target.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
        });
        await handle.click({ delay: 20 });
        return true;
    } catch (err) {
        if (isDestroyedContextError(err)) return false;
        if (!isNonClickableNodeError(err)) throw err;
        try {
            const clicked = await page.evaluate((el) => {
                if (!el) return false;
                const target =
                    el.closest?.('a, button, input, [role="button"], [role="menuitem"], [role="option"], label') ||
                    el;
                if (!target || typeof target.click !== 'function') return false;
                target.click();
                return true;
            }, handle);
            if (clicked) return true;
        } catch (evaluateErr) {
            if (isDestroyedContextError(evaluateErr)) return false;
            if (!isNonClickableNodeError(evaluateErr)) throw evaluateErr;
        }
        const box = await handle.boundingBox().catch(() => null);
        if (box && box.width > 0 && box.height > 0) {
            await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
            return true;
        }
        return false;
    }
}

function resolveQuirkReloadMaxMs(options = {}) {
    if (Number.isFinite(options.quirkReloadMaxMs)) return options.quirkReloadMaxMs;
    const raw = process.env.LIFELENZ_QUIRK_RELOAD_MAX_MS;
    if (raw !== undefined && raw !== '') {
        const n = Number(raw);
        if (Number.isFinite(n) && n > 0) return n;
    }
    return DEFAULT_QUIRK_RELOAD_MAX_MS;
}

function emitProgress(options, payload) {
    if (typeof options.onProgress === 'function') {
        options.onProgress({ platform: 'lifelenz', ...payload });
    }
}

async function runTimedPhase(options, phase, fn, extra = {}) {
    const start = Date.now();
    try {
        return await fn();
    } finally {
        emitProgress(options, { type: 'phase-timing', phase, ms: Date.now() - start, ...extra });
    }
}

async function isOnForecastPage(page) {
    return page.evaluate((dayPartSelector) => {
        const visible = (selector) =>
            [...document.querySelectorAll(selector)].some((el) => {
                const r = el.getBoundingClientRect();
                return r.width > 0 && r.height > 0;
            });
        const hasDateToolbar = visible('.display-date, a.display-date, [aria-label="Open calendar picker"]');
        const hasDayWeekTabs = visible('a.calendar-unit-link.day, a.calendar-unit-link.week');
        const hasDayPartInputs = visible(dayPartSelector);
        return hasDateToolbar && hasDayWeekTabs && hasDayPartInputs;
    }, DAY_PART_INPUT_SELECTOR);
}

async function clickByText(page, selectors, textPattern, options = {}) {
    const pattern = textPattern instanceof RegExp ? textPattern : new RegExp(String(textPattern), 'i');
    for (const selector of selectors) {
        const handles = await page.$$(selector);
        for (const handle of handles) {
            const text = await page.evaluate((el) => (el.textContent || '').replace(/\s+/g, ' ').trim(), handle);
            if (pattern.test(text)) {
                if (await safeClickHandle(page, handle)) return true;
            }
        }
    }
    return page.evaluate((regexSource, flags) => {
        const pattern = new RegExp(regexSource, flags);
        for (const el of document.querySelectorAll('a, button, span, li, div[role="menuitem"], [role="option"]')) {
            const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
            if (!pattern.test(text)) continue;
            const r = el.getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0) continue;
            el.click();
            return true;
        }
        return false;
    }, pattern.source, pattern.flags.replace('g', ''));
}

async function readCurrentStoreTriggerLabel(page) {
    return page.evaluate(() => {
        for (const el of document.querySelectorAll(
            'button[aria-haspopup="listbox"], button[aria-haspopup="menu"], [data-slot="trigger"], div.max-w-60'
        )) {
            const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
            if (/^\d{4}\s*-\s*/.test(text)) return text;
        }
        return '';
    });
}

/** Poll until the store picker trigger shows the requested store. */
async function waitForStoreSelected(page, labelNeedle, timeoutMs = STORE_PICKER_TIMEOUT_MS, options = {}) {
    const ok = await pollUntil(
        async () => {
            const current = await readCurrentStoreTriggerLabel(page).catch(() => '');
            return current.startsWith(labelNeedle) ? current : null;
        },
        { timeoutMs, pollMs: resolvePollMs(options), label: 'store selected' }
    );
    return Boolean(ok);
}

async function scrollStoreDropdown(page) {
    return page.evaluate(() => {
        const container =
            document.querySelector('[role="listbox"]') ||
            document.querySelector('[role="menu"]') ||
            document.querySelector('[data-radix-popper-content-wrapper]') ||
            document.querySelector('[role="option"]')?.closest('ul, div');
        if (!container) return true;
        const before = container.scrollTop;
        container.scrollTop += 320;
        return (
            container.scrollTop === before ||
            container.scrollTop + container.clientHeight >= container.scrollHeight - 2
        );
    });
}

async function findStorePickerTrigger(page) {
    const handle = await page.evaluateHandle(() => {
        const isStoreLabel = (text) => /^\d{4}\s*-\s*\S/.test(String(text || '').replace(/\s+/g, ' ').trim());
        const candidates = [
            ...document.querySelectorAll('button[aria-haspopup="listbox"]'),
            ...document.querySelectorAll('button[aria-haspopup="menu"]'),
            ...document.querySelectorAll('[data-slot="trigger"]'),
            ...document.querySelectorAll('div.max-w-60'),
        ];
        for (const el of candidates) {
            if (isStoreLabel(el.textContent)) return el;
        }
        return candidates[0] || null;
    });
    return handle.asElement();
}

async function waitForStoreDropdownClosed(page, options = {}, timeoutMs = 3000) {
    return pollUntil(
        () =>
            page.evaluate(() => {
                const open = document.querySelector(
                    '[role="listbox"], [role="menu"], [data-radix-popper-content-wrapper]'
                );
                if (!open) return true;
                const r = open.getBoundingClientRect();
                return r.width <= 0 || r.height <= 0;
            }),
        { timeoutMs, pollMs: resolvePollMs(options), label: 'store dropdown closed' }
    );
}

async function pickStoreOptionFromOpenDropdown(page, storeNumber, options = {}) {
    const store = String(storeNumber || '').trim();
    const storePattern = new RegExp(`\\b${store}\\s*-`, 'i');

    // Hierarchical picker: type into "Search by name or code" then click the match.
    const searched = await page.evaluate(async (code) => {
        const input = [...document.querySelectorAll('input')].find((el) => {
            const ph = String(el.getAttribute('placeholder') || '');
            const r = el.getBoundingClientRect();
            return /search by name or code/i.test(ph) && r.width > 0 && r.height > 0;
        });
        if (!input) return false;
        input.focus();
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
        if (setter) setter.call(input, code);
        else input.value = code;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    }, store);
    if (searched) {
        await new Promise((resolve) => setTimeout(resolve, resolvePollMs(options) * 4));
    }

    for (let pass = 0; pass < 30; pass += 1) {
        const clicked = await page.evaluate((regexSource, flags) => {
            const pattern = new RegExp(regexSource, flags);
            const selectors = '[role="option"], [role="menuitem"], li, button, a';
            for (const el of document.querySelectorAll(selectors)) {
                const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
                if (!pattern.test(text)) continue;
                const r = el.getBoundingClientRect();
                if (r.width <= 0 || r.height <= 0) continue;
                el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
                el.click();
                return true;
            }
            return false;
        }, storePattern.source, storePattern.flags.replace('g', ''));
        if (clicked) return true;
        if (
            await clickByText(page, ['[role="option"]', '[role="menuitem"]', 'li', 'button', 'a'], storePattern)
        ) {
            return true;
        }
        const atEnd = await scrollStoreDropdown(page);
        if (atEnd) break;
        await new Promise((resolve) => setTimeout(resolve, resolvePollMs(options)));
    }
    return false;
}

async function selectStoreInLifeLenz(page, storeNumber, options = {}) {
    const store = String(storeNumber || '').trim();
    const labelNeedle = `${store} -`;
    let lastError = null;

    for (let attempt = 0; attempt < 3; attempt += 1) {
        await page.keyboard.press('Escape').catch(() => null);
        await waitForStoreDropdownClosed(page, options).catch(() => null);

        const current = await readCurrentStoreTriggerLabel(page);
        if (current.startsWith(labelNeedle)) return true;

        try {
            const trigger = await findStorePickerTrigger(page);
            if (!trigger) {
                throw new Error(`Store picker trigger not found (could not select store ${store}).`);
            }

            await safeClickHandle(page, trigger);
            const pickerOpen = await waitForDropdownOptions(page, options);
            if (!pickerOpen) {
                throw new Error(`Store dropdown did not open for store ${store}.`);
            }

            // Location tree accounts: always force Area T22 (or LIFELENZ_AREA) before the store row.
            const area = resolveLifeLenzArea(options.lifelenzArea);
            const areaCodes = await page.evaluate(() => {
                const codes = [];
                const seen = new Set();
                for (const el of document.querySelectorAll(
                    'button, a, li, div, span, p, [role="treeitem"], [role="option"], [role="menuitem"]'
                )) {
                    const r = el.getBoundingClientRect();
                    if (r.width <= 0 || r.height <= 0 || r.width > 280) continue;
                    const text = (el.textContent || '').replace(/\s+/g, ' ').trim().toUpperCase();
                    if (!/^T\d{2}$/.test(text) || seen.has(text)) continue;
                    seen.add(text);
                    codes.push(text);
                }
                return codes;
            });
            if (areaCodes.length || area) {
                await selectLifeLenzArea(page, area, {
                    required: areaCodes.length > 0,
                    force: true,
                    timeoutMs: 12000,
                });
            }

            if (!(await pickStoreOptionFromOpenDropdown(page, store, options))) {
                await page.keyboard.press('Escape').catch(() => null);
                throw new Error(`Store ${store} was not found in the LifeLenz store list.`);
            }

            await waitForStoreDropdownClosed(page, options, 5000).catch(() => null);

            if (await waitForStoreSelected(page, labelNeedle, STORE_PICKER_TIMEOUT_MS, options)) {
                return true;
            }

            lastError = new Error(
                `Clicked store ${store} in the LifeLenz picker but it did not become active.`
            );
            if (attempt < 2) {
                await new Promise((resolve) => setTimeout(resolve, resolvePollMs(options) * 4));
                continue;
            }
            throw lastError;
        } catch (err) {
            lastError = err;
            const retryable =
                attempt < 2 &&
                /did not become active|did not open|picker trigger not found/i.test(err.message || '');
            if (retryable) {
                await new Promise((resolve) => setTimeout(resolve, resolvePollMs(options) * 4));
                continue;
            }
            throw err;
        }
    }

    throw lastError || new Error(`Could not select store ${store} in LifeLenz.`);
}

async function navigateToForecast(page, options = {}) {
    await page.waitForSelector('[data-testid="lz-dropdown-trigger-analytics"]', {
        visible: true,
        timeout: 15000,
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
        await page.keyboard.press('Escape').catch(() => null);

        const analyticsBtn = await page.$('[data-testid="lz-dropdown-trigger-analytics"]');
        if (analyticsBtn) {
            await safeClickHandle(page, analyticsBtn);
        } else {
            await clickByText(page, ['button'], /analytics/i);
        }

        if (!(await waitForAnalyticsMenuOpen(page, options))) {
            continue;
        }

        const opened = await clickByText(
            page,
            ['span', 'a', 'button', '[role="menuitem"]', 'li'],
            /^forecast$/i
        );
        if (!opened) continue;

        const ready = await page
            .waitForSelector(FORECAST_CHROME_SELECTOR, { visible: true, timeout: FORECAST_CHROME_TIMEOUT_MS })
            .then(() => true)
            .catch(() => false);
        if (ready && (await waitForDayPartInputsStable(page, options, 12000))) {
            return;
        }
        if (ready && (await waitForForecastDateToolbar(page, options))) {
            return;
        }
    }

    throw new Error('Could not open Forecast from the LifeLenz analytics menu.');
}

async function isForecastDayViewActive(page) {
    return page.evaluate(() => {
        const day = document.querySelector('a.calendar-unit-link.day, a[aria-label="Day View"]');
        if (!day) return false;
        if (day.classList.contains('active') || day.classList.contains('is-active')) return true;
        if (day.getAttribute('aria-selected') === 'true') return true;
        if (day.getAttribute('aria-current') === 'page') return true;
        const week = document.querySelector('a.calendar-unit-link.week, a[aria-label="Week View"]');
        if (week && (week.classList.contains('active') || week.classList.contains('is-active'))) return false;
        // Day-part adjusted inputs only render in day view.
        return [...document.querySelectorAll('input.forecast-adjustment.form-control, input.input-number.forecast-adjustment')].some(
            (input) => {
                const r = input.getBoundingClientRect();
                return r.width > 0 && r.height > 0;
            }
        );
    });
}

async function clickDayViewTab(page) {
    const dayLink = await page.$('a.calendar-unit-link.day, a[aria-label="Day View"]');
    if (dayLink && (await safeClickHandle(page, dayLink))) return true;
    return (
        (await clickByText(page, ['a.calendar-unit-link', 'a', 'button'], /^day$/i)) ||
        (await clickByText(page, ['a', 'button'], /^d$/i))
    );
}

async function switchToDayView(page, options = {}) {
    const timeoutMs = resolveDayViewSwitchTimeoutMs(options);
    const deadline = Date.now() + timeoutMs;
    let lastClickAt = 0;
    const clickEveryMs = 800;
    const pollMs = resolvePollMs(options);

    await page
        .waitForSelector(
            'a.calendar-unit-link.day, a.calendar-unit-link.week, .display-date, a.display-date, [aria-label="Open calendar picker"]',
            { visible: true, timeout: Math.min(timeoutMs, 25000) }
        )
        .catch(() => null);

    while (Date.now() < deadline) {
        if (await waitForDayPartInputsStable(page, options, pollMs * 3)) {
            return;
        }

        const inDayView = await isForecastDayViewActive(page);
        if (inDayView) {
            const count = await countVisibleDayPartInputs(page).catch(() => 0);
            if (count >= DAY_PART_INPUT_COUNT && (await waitForDayPartInputsStable(page, options, pollMs * 4))) {
                return;
            }
        }

        if (!inDayView && Date.now() - lastClickAt >= clickEveryMs) {
            await clickDayViewTab(page);
            lastClickAt = Date.now();
            if (await waitForDayPartInputsStable(page, options, clickEveryMs)) {
                return;
            }
        }

        await new Promise((resolve) => setTimeout(resolve, pollMs));
    }

    if (await waitForDayPartInputsStable(page, options, 1000)) return;

    const count = await countVisibleDayPartInputs(page).catch(() => 0);
    if (count >= DAY_PART_INPUT_COUNT) return;

    const activeDate = await readActiveForecastIsoDate(page).catch(() => 'unknown');
    const inDayView = await isForecastDayViewActive(page).catch(() => false);
    throw new Error(
        `Could not switch LifeLenz forecast to Day view (${count} day-part inputs visible, need ${DAY_PART_INPUT_COUNT}, ` +
            `date showing ${activeDate}, day view ${inDayView ? 'active' : 'not active'}).`
    );
}

const LIFELENZ_TIME_ZONE = process.env.DASHBOARD_TIME_ZONE || 'Australia/Melbourne';

function getMelbourneTodayIso(date = new Date()) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: LIFELENZ_TIME_ZONE }).format(date);
}

function addDaysToIso(iso, days) {
    const [y, m, d] = String(iso || '').split('-').map(Number);
    if (!y || !m || !d) return '';
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + (Number(days) || 0));
    return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

function getMelbourneTomorrowIso(date = new Date()) {
    return addDaysToIso(getMelbourneTodayIso(date), 1);
}

function isoToLifeLenzDisplay(iso) {
    const [y, m, d] = String(iso || '').split('-').map(Number);
    if (!y || !m || !d) return '';
    const dt = new Date(`${iso}T12:00:00`);
    const weekday = new Intl.DateTimeFormat('en-AU', { weekday: 'short' }).format(dt);
    const month = new Intl.DateTimeFormat('en-AU', { month: 'short' }).format(dt);
    return { weekday, day: d, month, monthIdx: m - 1, year: y, needle: `${weekday} ${d} ${month}` };
}

async function readActiveForecastIsoDate(page) {
    return page.evaluate(() => {
        const href = location.href || '';
        const urlMatch = href.match(/(\d{4}-\d{2}-\d{2})/);
        if (urlMatch) return urlMatch[1];

        const dateEl = document.querySelector('.display-date, a.display-date, [aria-label="Open calendar picker"]');
        const text = (dateEl?.textContent || '').replace(/\s+/g, ' ').trim();
        if (!text) return '';

        const monthMap = {
            jan: '01',
            january: '01',
            feb: '02',
            february: '02',
            mar: '03',
            march: '03',
            apr: '04',
            april: '04',
            may: '05',
            jun: '06',
            june: '06',
            jul: '07',
            july: '07',
            aug: '08',
            august: '08',
            sep: '09',
            sept: '09',
            september: '09',
            oct: '10',
            october: '10',
            nov: '11',
            november: '11',
            dec: '12',
            december: '12',
        };

        const wordsMatch = text.match(/(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})/);
        if (wordsMatch) {
            const monthKey = wordsMatch[2].toLowerCase();
            const month = monthMap[monthKey] || monthMap[monthKey.slice(0, 3)];
            if (month) {
                return `${wordsMatch[3]}-${month}-${String(Number(wordsMatch[1])).padStart(2, '0')}`;
            }
        }

        const commaMatch = text.match(/[A-Za-z]+,\s*(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})/);
        if (commaMatch) {
            const monthKey = commaMatch[2].toLowerCase();
            const month = monthMap[monthKey] || monthMap[monthKey.slice(0, 3)];
            if (month) {
                return `${commaMatch[3]}-${month}-${String(Number(commaMatch[1])).padStart(2, '0')}`;
            }
        }

        const slashMatch = text.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
        if (slashMatch) {
            const left = Number(slashMatch[1]);
            const right = Number(slashMatch[2]);
            const year = Number(slashMatch[3]);
            const month = right <= 12 ? right : left;
            const day = right <= 12 ? left : right;
            return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        }

        return '';
    });
}

async function isForecastDateActive(page, isoDate) {
    const activeIso = await readActiveForecastIsoDate(page);
    if (activeIso === isoDate) return true;
    return page.url().includes(isoDate);
}

function buildForecastUrlsForDate(currentUrl, isoDate) {
    const out = [];
    if (!isoDate) return out;
    if (currentUrl.includes(isoDate)) out.push(currentUrl);
    if (/\d{4}-\d{2}-\d{2}/.test(currentUrl)) {
        out.push(currentUrl.replace(/\d{4}-\d{2}-\d{2}/g, isoDate));
    }
    try {
        const url = new URL(currentUrl);
        if (/\d{4}-\d{2}-\d{2}/.test(url.hash)) {
            url.hash = url.hash.replace(/\d{4}-\d{2}-\d{2}/g, isoDate);
            out.push(url.toString());
        }
        if (url.searchParams.has('date')) {
            const next = new URL(url.toString());
            next.searchParams.set('date', isoDate);
            out.push(next.toString());
        }
        const basePath = url.pathname.replace(/\/$/, '');
        out.push(`${url.origin}${basePath}/${isoDate}${url.search}${url.hash}`);
        if (url.hash) {
            out.push(`${url.origin}${basePath}${url.search}${url.hash.replace(/\d{4}-\d{2}-\d{2}/g, isoDate)}`);
        }
    } catch {
        /* ignore malformed URLs */
    }
    return [...new Set(out.filter(Boolean))];
}

async function setForecastDateViaUrl(page, isoDate, options = {}) {
    const current = page.url();
    if (current.includes(isoDate)) return true;

    const candidates = buildForecastUrlsForDate(current, isoDate);
    const dateTimeoutMs = resolveDateNavTimeoutMs(options) * 2;
    for (const nextUrl of candidates) {
        if (nextUrl === current) continue;
        await page.goto(nextUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null);
        if (await waitForForecastDate(page, isoDate, dateTimeoutMs, options)) return true;
    }
    return false;
}

/** Poll until the displayed date differs from previousIso (arrow click landed). */
async function waitForActiveDateChange(page, previousIso, options = {}, timeoutMs) {
    const cap = Number.isFinite(timeoutMs) ? timeoutMs : resolveDateNavTimeoutMs(options);
    const changed = await pollUntil(
        async () => {
            const current = await readActiveForecastIsoDate(page).catch(() => '');
            return current && current !== previousIso ? current : null;
        },
        { timeoutMs: cap, pollMs: resolvePollMs(options), label: 'forecast date change' }
    );
    return changed || readActiveForecastIsoDate(page).catch(() => '');
}

async function clickForecastDateArrow(page, forward) {
    const iconSelectors = forward
        ? ['.glyphicon-chevron-right', '.fa-chevron-right', '.icon-chevron-right']
        : ['.glyphicon-chevron-left', '.fa-chevron-left', '.icon-chevron-left'];
    const controlSelectors = forward
        ? ['a.next', 'button.next', '[aria-label*="Next day"]', '[aria-label*="next day"]', '[aria-label*="Next"]']
        : [
              'a.prev',
              'button.prev',
              '[aria-label*="Previous day"]',
              '[aria-label*="previous day"]',
              '[aria-label*="Previous"]',
          ];

    for (const selector of [...iconSelectors, ...controlSelectors]) {
        const handles = await page.$$(selector);
        for (const handle of handles) {
            const shouldClick = await handle.evaluate((el, goForward) => {
                if (el.closest('.datepicker, .bootstrap-datetimepicker-widget, .datepicker-dropdown')) return false;
                const displayDate = document.querySelector(
                    '.display-date, a.display-date, [aria-label="Open calendar picker"]'
                );
                if (!displayDate) return false;
                const displayRect = displayDate.getBoundingClientRect();
                const target = el.closest('a, button') || el;
                const targetRect = target.getBoundingClientRect();
                if (displayRect.width <= 0 || targetRect.width <= 0) return false;
                if (Math.abs(targetRect.top - displayRect.top) > 96) return false;
                const displayMid = displayRect.left + displayRect.width / 2;
                const targetMid = targetRect.left + targetRect.width / 2;
                return goForward ? targetMid > displayMid : targetMid < displayMid;
            }, forward);
            if (!shouldClick) continue;
            if (await safeClickHandle(page, handle)) return true;
        }
    }

    return page.evaluate((goForward) => {
        const displayDate = document.querySelector('.display-date, a.display-date, [aria-label="Open calendar picker"]');
        const roots = [
            displayDate?.closest('div, nav, header, section, form, table, tr, td'),
            document.querySelector('.calendar-unit-link.day')?.closest('div, nav, section, form'),
        ].filter(Boolean);

        const selectors = goForward
            ? ['.glyphicon-chevron-right', '.fa-chevron-right', 'a.next', 'button.next']
            : ['.glyphicon-chevron-left', '.fa-chevron-left', 'a.prev', 'button.prev'];

        for (const root of roots.length ? roots : [document.body]) {
            for (const selector of selectors) {
                for (const el of root.querySelectorAll(selector)) {
                    if (el.closest('.datepicker, .bootstrap-datetimepicker-widget, .datepicker-dropdown')) continue;
                    const target = el.closest('a, button') || el;
                    const r = target.getBoundingClientRect();
                    if (r.width <= 0 || r.height <= 0) continue;
                    target.click();
                    return true;
                }
            }
        }
        return false;
    }, forward);
}

async function advanceForecastDateByDays(page, dayCount, options = {}) {
    const steps = Math.max(0, Number(dayCount) || 0);
    if (!steps) return true;

    for (let step = 0; step < steps; step += 1) {
        const before = await readActiveForecastIsoDate(page).catch(() => '');
        const clicked = await clickForecastDateArrow(page, true);
        if (!clicked) return false;
        const changed = await waitForActiveDateChange(page, before, options);
        if (!changed || changed === before) return false;
    }
    return true;
}

async function advanceForecastDateWithArrows(page, isoDate, options = {}) {
    const targetMs = Date.parse(`${isoDate}T12:00:00Z`);
    for (let step = 0; step < 45; step += 1) {
        if (await isForecastDateActive(page, isoDate)) return true;

        const currentIso = await readActiveForecastIsoDate(page);
        const goForward = !currentIso || targetMs >= Date.parse(`${currentIso}T12:00:00Z`);
        const advanced = await clickForecastDateArrow(page, goForward);
        if (!advanced) return false;
        await waitForActiveDateChange(page, currentIso, options);
    }
    return await isForecastDateActive(page, isoDate);
}

async function openForecastCalendarPicker(page, options = {}) {
    await page.keyboard.press('Escape').catch(() => null);
    await pollUntil(
        () =>
            page.evaluate(() => {
                const open = document.querySelector(
                    '.datepicker.datepicker-dropdown, .bootstrap-datetimepicker-widget.dropdown-menu'
                );
                if (!open) return true;
                const r = open.getBoundingClientRect();
                return r.width <= 0 || r.height <= 0;
            }),
        { timeoutMs: 1500, pollMs: resolvePollMs(options), label: 'calendar closed' }
    ).catch(() => null);

    const dateTrigger = await page.$('.display-date, a.display-date, [aria-label="Open calendar picker"]');
    if (dateTrigger) {
        if (!(await safeClickHandle(page, dateTrigger))) return false;
    } else {
        const clicked = await clickByText(
            page,
            ['a', 'button', 'span'],
            /\d{1,2}\s+[A-Za-z]{3}\s+\d{4}|\d{1,2}\/\d{1,2}\/\d{4}/
        );
        if (!clicked) return false;
    }
    return Boolean(await waitForDatepickerWidget(page, options));
}

async function pickForecastDateFromCalendar(page, isoDate, display, options = {}) {
    const opened = await openForecastCalendarPicker(page, options);
    if (!opened) return false;

    const picked = await page.evaluate(({ day, monthIdx, year, isoDate: targetIso }) => {
        const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const want = monthIdx >= 0 ? `${monthNames[monthIdx]} ${year}` : '';

        const widgetSelectors = [
            '.datepicker.datepicker-dropdown',
            '.bootstrap-datetimepicker-widget.dropdown-menu',
            '.bootstrap-datetimepicker-widget',
            '.datepicker:not(.datepicker-inline)',
        ];
        let widget = null;
        for (const selector of widgetSelectors) {
            const candidate = document.querySelector(selector);
            if (candidate && candidate.getBoundingClientRect().width > 0) {
                widget = candidate;
                break;
            }
        }
        if (!widget) return false;

        const readHeader = () =>
            (
                widget.querySelector(
                    '.datepicker-days .datepicker-switch, .bootstrap-datetimepicker-widget .picker-switch, .picker-switch, [class*="switch"]'
                )?.textContent || ''
            ).replace(/\s+/g, ' ');

        const ensureMonth = () => {
            if (!want) return;
            for (let i = 0; i < 24; i += 1) {
                const currentHeader = readHeader();
                if (new RegExp(want, 'i').test(currentHeader)) return;
                const prev = widget.querySelector('.prev, th.prev, .datepicker-prev, [aria-label*="Previous"]');
                const next = widget.querySelector('.next, th.next, .datepicker-next, [aria-label*="Next"]');
                const currentMonthIdx = monthNames.findIndex((name) => currentHeader.includes(name));
                if (currentMonthIdx < 0 || monthIdx < 0) {
                    next?.click();
                    continue;
                }
                if (
                    monthIdx < currentMonthIdx ||
                    (monthIdx === currentMonthIdx && !new RegExp(String(year), 'i').test(currentHeader))
                ) {
                    prev?.click();
                } else {
                    next?.click();
                }
            }
        };

        ensureMonth();

        const dayCells = widget.querySelectorAll('td.day, td[data-day], td[data-date], button.day, a.day, span.day');
        for (const cell of dayCells) {
            const dataDay = cell.getAttribute?.('data-day') || cell.getAttribute?.('data-date') || '';
            if (dataDay) {
                const normalized = dataDay.replace(/\//g, '-');
                if (
                    normalized.startsWith(targetIso) ||
                    normalized.includes(targetIso.slice(5)) ||
                    (dataDay.includes(String(day)) && dataDay.includes(String(year)))
                ) {
                    if (cell.classList?.contains('disabled') || cell.getAttribute('aria-disabled') === 'true') continue;
                    if (cell.classList?.contains('old') || cell.classList?.contains('new')) continue;
                    cell.click();
                    return true;
                }
            }
            const text = (cell.textContent || '').trim();
            if (text !== String(day)) continue;
            if (cell.classList?.contains('old') || cell.classList?.contains('new')) continue;
            if (cell.classList?.contains('disabled') || cell.getAttribute('aria-disabled') === 'true') continue;
            cell.click();
            return true;
        }
        return false;
    }, { day: display.day, monthIdx: display.monthIdx, year: display.year, isoDate });

    if (!picked) {
        await page.keyboard.press('Escape').catch(() => null);
        return false;
    }

    await page.keyboard.press('Escape').catch(() => null);
    return await waitForForecastDate(page, isoDate, resolveDateNavTimeoutMs(options), options);
}

async function waitForForecastDate(page, isoDate, timeoutMs = 15000, options = {}) {
    const ok = await pollUntil(
        () => isForecastDateActive(page, isoDate),
        { timeoutMs, pollMs: resolvePollMs(options), label: `forecast date ${isoDate}` }
    );
    return Boolean(ok);
}

function resolveDayPartInputTimeoutMs(options = {}) {
    if (Number.isFinite(options.dayPartInputTimeoutMs)) return options.dayPartInputTimeoutMs;
    return DEFAULT_DAY_PART_INPUT_TIMEOUT_MS;
}

function resolveDayViewSwitchTimeoutMs(options = {}) {
    if (Number.isFinite(options.dayViewSwitchTimeoutMs)) return options.dayViewSwitchTimeoutMs;
    const raw = process.env.LIFELENZ_DAY_VIEW_TIMEOUT_MS;
    if (raw !== undefined && raw !== '') {
        const n = Number(raw);
        if (Number.isFinite(n) && n > 0) return n;
    }
    return DEFAULT_DAY_VIEW_SWITCH_TIMEOUT_MS;
}

/**
 * Day-part adjusted inputs only appear in day view. After date navigation the
 * Aurelia forecast page can briefly show the date toolbar while still in week
 * view or while inputs are hydrating - poll until 9 fields are visible.
 */
async function ensureForecastDayViewReady(page, options = {}) {
    const timeoutMs = resolveDayPartInputTimeoutMs(options);
    const switchTimeoutMs = Math.max(resolveDayViewSwitchTimeoutMs(options), timeoutMs);
    await switchToDayView(page, { ...options, dayViewSwitchTimeoutMs: switchTimeoutMs });
    await waitForForecastDateToolbar(page, options);

    if (await waitForDayPartInputsStable(page, options, timeoutMs)) return;

    const deadline = Date.now() + timeoutMs;
    let lastCount = 0;
    let lastRetryClickAt = 0;
    const pollMs = resolvePollMs(options);

    while (Date.now() < deadline) {
        try {
            lastCount = await countVisibleDayPartInputs(page);
        } catch (err) {
            if (!isDestroyedContextError(err)) throw err;
            lastCount = 0;
        }
        if (lastCount >= DAY_PART_INPUT_COUNT && (await waitForDayPartInputsStable(page, options, pollMs * 4))) {
            return;
        }
        if (Date.now() - lastRetryClickAt >= 1500) {
            const inDayView = await isForecastDayViewActive(page).catch(() => false);
            if (!inDayView) {
                await clickDayViewTab(page);
                lastRetryClickAt = Date.now();
                if (await waitForDayPartInputsStable(page, options, 3000)) return;
            } else {
                lastRetryClickAt = Date.now();
            }
        }
        await new Promise((resolve) => setTimeout(resolve, pollMs));
    }

    const activeDate = await readActiveForecastIsoDate(page).catch(() => 'unknown');
    const inDayView = await isForecastDayViewActive(page).catch(() => false);
    throw new Error(
        `LifeLenz day-part inputs not ready (${lastCount} visible, need ${DAY_PART_INPUT_COUNT}, ` +
            `date showing ${activeDate}, day view ${inDayView ? 'active' : 'not active'}).`
    );
}

async function finishForecastDateNavigation(page, target, options = {}) {
    if (!(await isForecastDateActive(page, target))) return false;

    if (options.lightDayViewReady) {
        if (await waitForDayPartInputsStable(page, options, 8000)) return true;
        await switchToDayView(page, { ...options, dayViewSwitchTimeoutMs: 12000 });
        if (await waitForDayPartInputsStable(page, options, 8000)) return true;
    }

    await ensureForecastDayViewReady(page, options);
    return true;
}

async function setForecastDate(page, isoDate, options = {}) {
    const target = String(isoDate || '').trim();
    if (!target) throw new Error('Forecast date is required.');

    if (await isForecastDateActive(page, target)) {
        if (await finishForecastDateNavigation(page, target, options)) return;
    }

    const prevIso = String(options.sequentialFromIso || '').trim();
    if (prevIso && target === addDaysToIso(prevIso, 1)) {
        const currentIso = await readActiveForecastIsoDate(page);
        if (currentIso === prevIso) {
            if (
                (await advanceForecastDateByDays(page, 1, options)) &&
                (await finishForecastDateNavigation(page, target, { ...options, lightDayViewReady: true }))
            ) {
                return;
            }
        }
    }

    const currentIso = await readActiveForecastIsoDate(page);
    const tomorrowIso = getMelbourneTomorrowIso();
    console.log(
        `[LifeLenz forecast] Navigating from ${currentIso || 'unknown'} to ${target}` +
            (target === tomorrowIso ? ' (tomorrow)' : '')
    );

    if (target === tomorrowIso) {
        if (await clickByText(page, ['a', 'button', 'span'], /^tomorrow$/i)) {
            if (
                (await waitForForecastDate(page, target, resolveDateNavTimeoutMs(options), options)) &&
                (await finishForecastDateNavigation(page, target, options))
            ) {
                return;
            }
        }
        if (!currentIso || currentIso === getMelbourneTodayIso()) {
            if (
                (await advanceForecastDateByDays(page, 1, options)) &&
                (await finishForecastDateNavigation(page, target, options))
            ) {
                return;
            }
        }
    }

    if (currentIso && /^\d{4}-\d{2}-\d{2}$/.test(currentIso) && /^\d{4}-\d{2}-\d{2}$/.test(target)) {
        const dayOffset = Math.round(
            (Date.parse(`${target}T12:00:00Z`) - Date.parse(`${currentIso}T12:00:00Z`)) / 86400000
        );
        if (dayOffset !== 0 && Math.abs(dayOffset) > 2) {
            const display = isoToLifeLenzDisplay(target);
            if (
                (await setForecastDateViaUrl(page, target, options)) &&
                (await finishForecastDateNavigation(page, target, options))
            ) {
                return;
            }
            if (
                display &&
                (await pickForecastDateFromCalendar(page, target, display, options)) &&
                (await finishForecastDateNavigation(page, target, options))
            ) {
                return;
            }
        }
        if (dayOffset > 0 && dayOffset <= 14) {
            if (
                (await advanceForecastDateByDays(page, dayOffset, options)) &&
                (await finishForecastDateNavigation(page, target, { ...options, lightDayViewReady: dayOffset === 1 }))
            ) {
                return;
            }
        }
    }

    if (
        (await setForecastDateViaUrl(page, target, options)) &&
        (await finishForecastDateNavigation(page, target, options))
    ) {
        return;
    }
    if (
        (await advanceForecastDateWithArrows(page, target, options)) &&
        (await finishForecastDateNavigation(page, target, options))
    ) {
        return;
    }

    const display = isoToLifeLenzDisplay(target);
    if (!display) throw new Error(`Invalid forecast date: ${target}`);

    if (
        (await pickForecastDateFromCalendar(page, target, display, options)) &&
        (await finishForecastDateNavigation(page, target, options))
    ) {
        return;
    }

    if (
        (await setForecastDateViaUrl(page, target, options)) &&
        (await finishForecastDateNavigation(page, target, options))
    ) {
        return;
    }
    if (
        (await advanceForecastDateWithArrows(page, target, options)) &&
        (await finishForecastDateNavigation(page, target, options))
    ) {
        return;
    }
    if (
        (await waitForForecastDate(page, target, resolveDateNavTimeoutMs(options), options)) &&
        (await finishForecastDateNavigation(page, target, options))
    ) {
        return;
    }

    const showing = await readActiveForecastIsoDate(page);
    throw new Error(
        `Could not select date ${target} in LifeLenz calendar` + (showing ? ` (showing ${showing})` : '') + '.'
    );
}

/** Day-part Adjusted inputs only - first 9 visible fields; the 10th is the day total (auto-calculated). */
async function getDayPartAdjustmentInputs(page) {
    const handles = await page.$$(DAY_PART_INPUT_SELECTOR);
    const visible = [];
    for (const handle of handles) {
        const box = await handle.boundingBox();
        if (box && box.width > 0 && box.height > 0) visible.push(handle);
    }
    return visible.slice(0, DAY_PART_INPUT_COUNT);
}

async function locateDayPartInputs(page) {
    const inputs = await getDayPartAdjustmentInputs(page);
    if (inputs.length < DAY_PART_INPUT_COUNT) return [];
    return inputs.slice(0, DAY_PART_INPUT_COUNT).map((_, index) => ({ index }));
}

async function clearAndPasteForecastAdjustment(page, visibleIndex, value, options = {}) {
    const inputs = await getDayPartAdjustmentInputs(page);
    const input = inputs[visibleIndex];
    if (!input) {
        throw new Error(`Forecast adjustment input ${visibleIndex} not found (${inputs.length} day-part fields).`);
    }
    await pasteIntoInput(page, input, value);
    if (options.avoidTab) {
        await input.evaluate((el) => el.blur());
    } else {
        await input.press('Tab').catch(() => null);
    }
}

/** @deprecated use clearAndPasteForecastAdjustment */
async function clearAndTypeForecastAdjustment(page, visibleIndex, value, options = {}) {
    return clearAndPasteForecastAdjustment(page, visibleIndex, value, options);
}

async function clearAndTypeInput(page, _selectorOrIndex, value, inputIndex) {
    await clearAndTypeForecastAdjustment(page, inputIndex, value);
}

async function countVisibleDayPartInputs(page) {
    return page.evaluate((selector) => {
        const inputs = document.querySelectorAll(selector);
        return [...inputs].filter((input) => {
            const r = input.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
        }).length;
    }, DAY_PART_INPUT_SELECTOR);
}

/** Debug helper — snapshot Day/Week state and visible forecast inputs. */
async function describeForecastPageState(page) {
    return page.evaluate((selector) => {
        const pick = (sel) =>
            [...document.querySelectorAll(sel)].map((el) => ({
                tag: el.tagName,
                text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 30),
                className: (el.className || '').toString().slice(0, 60),
                active: el.classList?.contains('active') || el.classList?.contains('is-active'),
            }));
        const inputs = [...document.querySelectorAll(selector)].filter((el) => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
        });
        const dateEl = document.querySelector('.display-date, a.display-date, [aria-label="Open calendar picker"]');
        return {
            url: location.href,
            dateLabel: (dateEl?.textContent || '').replace(/\s+/g, ' ').trim(),
            dayTab: pick('a.calendar-unit-link.day, a[aria-label="Day View"]'),
            weekTab: pick('a.calendar-unit-link.week, a[aria-label="Week View"]'),
            visibleDayPartInputs: inputs.length,
            dayPartSamples: inputs.slice(0, 3).map((el, i) => ({
                index: i,
                className: (el.className || '').slice(0, 60),
                value: el.value,
            })),
        };
    }, DAY_PART_INPUT_SELECTOR);
}

/**
 * Wait for LifeLenz to settle after the overnight quirk save. The save can
 * trigger a full SPA reload, so instead of racing fixed sleeps against
 * networkidle2 (which an Aurelia SPA may never reach), poll until the
 * day-part inputs are visible again and hold steady, capped by maxMs.
 */
async function waitForDayPartSaveSettle(page, options = {}) {
    const maxMs = resolveQuirkReloadMaxMs(options);
    const appeared = await waitForDayPartInputsStable(page, options, maxMs);
    if (!appeared) {
        const count = await countVisibleDayPartInputs(page).catch(() => 0);
        throw new Error(
            `LifeLenz day-part inputs not ready after save (${count} visible, need ${DAY_PART_INPUT_COUNT}, waited ${maxMs}ms).`
        );
    }
}

function parseDayPartInputNumber(raw) {
    const cleaned = String(raw ?? '').replace(/[^0-9.-]/g, '');
    if (!cleaned) return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
}

/** Read the current values of the 9 visible day-part adjustment inputs. */
async function readDayPartInputValues(page) {
    const raw = await page.evaluate((selector) => {
        return [...document.querySelectorAll(selector)]
            .filter((input) => {
                const r = input.getBoundingClientRect();
                return r.width > 0 && r.height > 0;
            })
            .slice(0, 9)
            .map((input) => input.value);
    }, DAY_PART_INPUT_SELECTOR);
    return raw.map(parseDayPartInputNumber);
}

/**
 * Read the entered day-part values back and confirm they match the plan.
 * Polls because the quirk save/reload can briefly repopulate inputs with
 * stale values before the saved ones render.
 */
async function verifyDayPartValues(page, dayParts, options = {}) {
    const timeoutMs = resolveVerifyTimeoutMs(options);
    const expected = dayParts.map((part) => Math.round(Number(part.adjusted) || 0));
    const deadline = Date.now() + timeoutMs;
    let mismatches = [];
    const pollMs = resolvePollMs(options);

    while (Date.now() < deadline) {
        let values = null;
        try {
            values = await readDayPartInputValues(page);
        } catch (err) {
            if (!isDestroyedContextError(err)) throw err;
        }
        if (values && values.length >= expected.length) {
            mismatches = [];
            for (let i = 0; i < expected.length; i += 1) {
                const actual = values[i];
                if (actual == null || Math.round(actual) !== expected[i]) {
                    mismatches.push({ index: i, label: dayParts[i].label, expected: expected[i], actual });
                }
            }
            if (!mismatches.length) return { ok: true };
        }
        await new Promise((resolve) => setTimeout(resolve, pollMs));
    }

    return { ok: false, mismatches };
}

async function fillDayPartsWithOvernightQuirk(page, dayParts, options = {}) {
    const inputs = await locateDayPartInputs(page);

    if (inputs.length < dayParts.length) {
        throw new Error(
            `Could not locate LifeLenz day-part adjusted inputs (${inputs.length} found, need ${dayParts.length}).`
        );
    }

    const firstOvernightValue = dayParts[0]?.adjusted ?? 0;
    const progressDate = options.activeDate || null;
    const emitDayPart = (type, part, extra = {}) => {
        emitProgress(options, {
            type,
            date: progressDate,
            label: part?.label,
            key: part?.key,
            value: part?.adjusted,
            ...extra,
        });
    };

    emitProgress(options, {
        type: 'daypart-entering',
        date: progressDate,
        label: 'OVERNIGHT',
        key: dayParts[0]?.key,
        phase: 'quirk-start',
    });
    await clearAndPasteForecastAdjustment(page, 0, 'x');
    await waitForInputValueAt(page, 0, 'x', options, 3000).catch(() => null);

    for (let i = 1; i < dayParts.length; i += 1) {
        const part = dayParts[i];
        emitDayPart('daypart-entering', part);
        const isLastDayPart = i === dayParts.length - 1;
        await clearAndPasteForecastAdjustment(page, i, part.adjusted, { avoidTab: isLastDayPart });
        const entered = await waitForInputValueAt(page, i, part.adjusted, options, 4000);
        if (entered) emitDayPart('daypart-confirmed', part, { read: part.adjusted });
    }

    emitProgress(options, {
        type: 'daypart-entering',
        date: progressDate,
        label: 'OVERNIGHT',
        key: dayParts[0]?.key,
        phase: 'quirk-finish',
        value: firstOvernightValue,
    });
    await clearAndPasteForecastAdjustment(page, 0, firstOvernightValue, { avoidTab: true });
    const overnightEntered = await waitForInputValueAt(page, 0, firstOvernightValue, options, 4000);
    if (overnightEntered) {
        emitDayPart('daypart-confirmed', dayParts[0], { read: firstOvernightValue });
    }

    await runTimedPhase(options, 'save-settle', () => waitForDayPartSaveSettle(page, options), {
        date: progressDate,
    });
}

async function writeForecastDay(page, isoDate, planDay, options = {}) {
    emitProgress(options, {
        type: 'day-start',
        date: isoDate,
        forecastTotal: planDay.forecastTotal,
        weekday: planDay.weekday,
        hourly: planDay.hourly,
    });
    const dayParts = aggregateDayPartsFromHourlyPlan(planDay);
    const runOptions = { ...options, activeDate: isoDate };

    await runTimedPhase(options, 'set-date', () => setForecastDate(page, isoDate, options), { date: isoDate });

    const preCheck = await runTimedPhase(
        options,
        'verify-dayparts',
        () => verifyDayPartValues(page, dayParts, options),
        { date: isoDate, phase: 'pre-check' }
    );
    if (preCheck.ok) {
        for (const part of dayParts) {
            emitProgress(options, {
                type: 'daypart-confirmed',
                date: isoDate,
                label: part.label,
                key: part.key,
                value: part.adjusted,
                read: part.adjusted,
                skipped: true,
            });
        }
        emitProgress(options, {
            type: 'day-complete',
            date: isoDate,
            verified: true,
            skipped: true,
            adjustedTotal: dayParts.reduce((sum, row) => sum + row.adjusted, 0),
        });
        return { date: isoDate, dayParts, verified: true, skipped: true };
    }

    let verification = null;
    for (let attempt = 1; attempt <= WRITE_DAY_MAX_ATTEMPTS; attempt += 1) {
        if (attempt > 1) {
            await runTimedPhase(options, 'set-date', () => setForecastDate(page, isoDate, options), {
                date: isoDate,
                attempt,
            });
        }
        await runTimedPhase(options, 'fill-dayparts', () => fillDayPartsWithOvernightQuirk(page, dayParts, runOptions), {
            date: isoDate,
            attempt,
        });

        verification = await runTimedPhase(
            options,
            'verify-dayparts',
            () => verifyDayPartValues(page, dayParts, options),
            { date: isoDate, attempt }
        );
        if (verification.ok) break;

        const detail = (verification.mismatches || [])
            .map((m) => `${m.label}: expected ${m.expected}, saw ${m.actual ?? 'blank'}`)
            .join('; ');
        if (attempt < WRITE_DAY_MAX_ATTEMPTS) {
            console.warn(
                `[LifeLenz forecast] ${isoDate} verification mismatch (attempt ${attempt}), re-entering: ${detail}`
            );
            emitProgress(options, { type: 'day-retry', date: isoDate, attempt, detail });
        } else {
            throw new Error(`LifeLenz values did not persist for ${isoDate} after ${attempt} attempts: ${detail}`);
        }
    }

    emitProgress(options, {
        type: 'day-complete',
        date: isoDate,
        verified: true,
        adjustedTotal: dayParts.reduce((sum, row) => sum + row.adjusted, 0),
    });
    return { date: isoDate, dayParts, verified: true };
}

async function writeForecastPlanOnPage(page, storeNumber, plan, accessibleStores, options = {}) {
    const store = String(storeNumber || '').trim();
    const allowed = new Set((accessibleStores || []).map((row) => String(row.storeNumber)));
    // Initial list can be incomplete (virtualized / wrong area leaf). Always try T22 picker.
    if (allowed.size && !allowed.has(store)) {
        console.warn(
            `[LifeLenz] Store ${store} missing from initial list (${[...allowed].join(', ')}); selecting via T22 search…`
        );
    }

    await runTimedPhase(options, 'select-store', () => selectStoreInLifeLenz(page, store, options), { store });
    const onForecast = await isOnForecastPage(page);
    if (onForecast) {
        emitProgress(options, { type: 'phase-timing', phase: 'navigate-forecast', ms: 0, store, skipped: true });
    } else {
        await runTimedPhase(options, 'navigate-forecast', () => navigateToForecast(page, options), { store });
    }
    await runTimedPhase(
        options,
        onForecast ? 'store-switch-settle' : 'day-view-ready',
        () => ensureForecastDayViewReady(page, options),
        { store }
    );

    const applied = [];
    let previousDate = null;
    for (const day of plan || []) {
        const dayOptions = {
            ...options,
            lightDayViewReady: Boolean(previousDate),
            sequentialFromIso: previousDate,
        };
        try {
            const result = await runTimedPhase(
                options,
                'write-day',
                () => writeForecastDay(page, day.date, day, dayOptions),
                { store, date: day.date }
            );
            applied.push(result);
            previousDate = day.date;
        } catch (err) {
            emitProgress(options, { type: 'day-error', date: day.date, error: err.message || String(err) });
            throw err;
        }
    }
    return applied;
}

function clarifyLifeLenzWaitError(err) {
    const msg = String(err?.message || err || '');
    if (/Waiting failed:\s*60000ms exceeded/i.test(msg)) {
        return new Error(
            'LifeLenz login timed out after 60s (did not reach Business Explorer / store shell). Check credentials, or try again if Macromatix was also busy.'
        );
    }
    if (/Waiting failed:\s*(\d+)ms exceeded/i.test(msg)) {
        const ms = RegExp.$1;
        return new Error(`LifeLenz timed out after ${Math.round(Number(ms) / 1000)}s: ${msg}`);
    }
    return err instanceof Error ? err : new Error(msg);
}

async function writeForecastPlanToLifeLenz(storeNumber, plan, credentials, options = {}) {
    const email = String(credentials?.email || credentials?.lifelenzEmail || '').trim();
    const password = String(credentials?.password || credentials?.lifelenzPassword || '');
    if (!email || !password) {
        throw new Error('LifeLenz credentials are required.');
    }

    let browser = options.browser;
    let page = options.page;
    let ownsSession = false;

    if (!page) {
        emitProgress(options, { type: 'session-start', label: 'Signing in to LifeLenz…' });
        try {
            const session = await createAuthenticatedLifeLenzSession(email, password, options);
            browser = session.browser;
            page = session.page;
            options.accessibleStores = session.stores;
            ownsSession = true;
            emitProgress(options, {
                type: 'status',
                label: `LifeLenz signed in (${(session.stores || []).length} store(s) visible)`,
            });
        } catch (err) {
            throw clarifyLifeLenzWaitError(err);
        }
    }

    try {
        const applied = await writeForecastPlanOnPage(
            page,
            storeNumber,
            plan,
            options.accessibleStores || [],
            options
        );
        return {
            storeNumber: String(storeNumber),
            forecastDays: applied.length,
            lifelenz: applied,
        };
    } finally {
        if (ownsSession && !options.keepBrowserOpen) {
            await closeBrowserQuietly(browser, 'lifelenz-forecast');
        }
    }
}

module.exports = {
    safeClickHandle,
    selectStoreInLifeLenz,
    navigateToForecast,
    switchToDayView,
    setForecastDate,
    isOnForecastPage,
    getDayPartAdjustmentInputs,
    ensureForecastDayViewReady,
    finishForecastDateNavigation,
    fillDayPartsWithOvernightQuirk,
    waitForDayPartSaveSettle,
    readDayPartInputValues,
    verifyDayPartValues,
    countVisibleDayPartInputs,
    describeForecastPageState,
    resolveQuirkReloadMaxMs,
    writeForecastPlanToLifeLenz,
    writeForecastPlanOnPage,
    aggregateDayPartsFromHourlyPlan,
    parseStoreLabel,
    dedupeStores,
};
