const MMX_SPA_BASE = 'https://m-tacobellau.macromatix.net/';
const CHANGE_STORE_URL = `${MMX_SPA_BASE}#/Administration/ChangeStore?metric=sales`;
const FORECASTING_URL = `${MMX_SPA_BASE}#/Forecasting/Edit?metric=sales`;
const SPA_GOTO_OPTS = { waitUntil: 'load', timeout: 60000 };

function getMacromatixScraper() {
    return require('../macromatixScraper');
}

function getSssgScraper() {
    return require('../sssg/sssgScraper');
}

/** Macromatix SPA date display (MM/DD/YYYY) from ISO YYYY-MM-DD. */
function isoToMmxDate(iso) {
    const [y, m, d] = String(iso || '').split('-').map(Number);
    if (!y || !m || !d) return '';
    return `${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}/${y}`;
}

function mmxDateToIso(mmx) {
    const m = String(mmx || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!m) return '';
    return `${m[3]}-${String(Number(m[1])).padStart(2, '0')}-${String(Number(m[2])).padStart(2, '0')}`;
}

const DATE_PICKER_SEL = '#mx-forecast-dateselection-dropdown-edit';
const MANAGER_OVERRIDE_INPUT = '#overrideInput';
const POLL_MS = 50;
const VERIFY_POLL_MS = 50;
const VERIFY_TIMEOUT_MS = Number(process.env.FORECAST_VERIFY_TIMEOUT_MS) > 0
    ? Number(process.env.FORECAST_VERIFY_TIMEOUT_MS)
    : 2000;
const GRID_WAIT_MS = Number(process.env.FORECAST_GRID_WAIT_MS) > 0
    ? Number(process.env.FORECAST_GRID_WAIT_MS)
    : 20000;
const DATE_CHANGE_MS = 6000;
const SAVE_SETTLE_MS = 8000;
const SAVE_APPEAR_MS = 15000;
/** After a bulk fill, Angular can take >400ms to enable Save — keep this generous. */
const SAVE_APPEAR_FAST_MS = 5000;
const SAVE_SUCCESS_TIMEOUT_MS = 15000;
const SAVE_SUCCESS_PATTERN = /changes saved successfully/i;
const OVERRIDE_CLOSE_MS = 2000;
const OVERRIDE_CLOSE_CONTINUOUS_MS = 250;
const DOLLAR_MODE_MS = 2000;
const ZERO_VERIFY_TIMEOUT_MS = 1200;
const CELL_CLICK_DELAY_MS = 0;

function dayDiffIso(fromIso, toIso) {
    if (!fromIso || !toIso) return null;
    const a = new Date(`${fromIso}T12:00:00Z`).getTime();
    const b = new Date(`${toIso}T12:00:00Z`).getTime();
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    return Math.round((b - a) / 86400000);
}

async function waitForDisplayedForecastDate(page, displayStr, timeoutMs = DATE_CHANGE_MS) {
    if (!displayStr) return false;
    try {
        await page.waitForFunction(
            (want, pickerSel) => {
                const valid = (t) => /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(t) && t !== '01/01/1900';
                const host = document.querySelector(pickerSel);
                if (host) {
                    for (const span of host.querySelectorAll('.ng-binding')) {
                        const t = (span.textContent || '').trim();
                        if (valid(t)) return t === want;
                    }
                }
                return false;
            },
            { timeout: timeoutMs, polling: 60 },
            displayStr,
            DATE_PICKER_SEL
        );
        return true;
    } catch {
        return false;
    }
}

async function waitForForecastSaveSuccessToast(page, timeoutMs = SAVE_SUCCESS_TIMEOUT_MS) {
    try {
        await page.waitForFunction(
            (patternSource) => {
                const pattern = new RegExp(patternSource, 'i');
                const selectors = [
                    '.alert-success',
                    '.alert.alert-success',
                    '[role="alert"]',
                    '.alert',
                    '.toast',
                    '[class*="alert-success"]',
                ];
                const seen = new Set();
                for (const sel of selectors) {
                    for (const el of document.querySelectorAll(sel)) {
                        if (seen.has(el)) continue;
                        seen.add(el);
                        const r = el.getBoundingClientRect();
                        if (r.width <= 0 || r.height <= 0) continue;
                        const style = window.getComputedStyle(el);
                        if (style.visibility === 'hidden' || style.display === 'none') continue;
                        const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
                        if (text.length > 160) continue;
                        if (pattern.test(text)) return true;
                    }
                }
                return false;
            },
            { timeout: timeoutMs, polling: 40 },
            SAVE_SUCCESS_PATTERN.source
        );
        return true;
    } catch {
        return false;
    }
}

async function waitForForecastSaveButtonHidden(page, timeoutMs = 3000) {
    try {
        await page.waitForFunction(
            () => {
                for (const el of document.querySelectorAll('button, a.btn, input[type="button"], input[type="submit"]')) {
                    const r = el.getBoundingClientRect();
                    if (r.width <= 0 || r.height <= 0) continue;
                    const label = (el.textContent || el.value || '').replace(/\s+/g, ' ').trim();
                    const ngClick = el.getAttribute('ng-click') || '';
                    if (/^save$/i.test(label) || /^save\b/i.test(label) || /SaveChanges\s*\(/i.test(ngClick)) return false;
                }
                return true;
            },
            { timeout: timeoutMs, polling: 80 }
        );
        return true;
    } catch {
        return false;
    }
}

/** After Save click: wait for success toast (preferred) or Save button to disappear. */
async function waitForForecastSaveCompleted(page, timeoutMs = SAVE_SUCCESS_TIMEOUT_MS) {
    if (await waitForForecastSaveSuccessToast(page, timeoutMs)) {
        return 'toast';
    }
    if (await waitForForecastSaveButtonHidden(page, Math.min(3000, timeoutMs))) {
        return 'button-hidden';
    }
    return null;
}

/** @deprecated Use waitForForecastSaveCompleted — kept as alias for callers. */
async function waitForForecastSaveSettled(page, timeoutMs = SAVE_SETTLE_MS) {
    await waitForForecastSaveCompleted(page, timeoutMs);
}

/** Wait until the forecast toolbar date picker is mounted (not the workflow-nav 01/01/1900 placeholder). */
async function waitForForecastDatePickerReady(page, timeoutMs = GRID_WAIT_MS) {
    const ok = await page
        .waitForFunction(
            (pickerSel) => {
                const host = document.querySelector(pickerSel);
                if (!host) return false;
                const r = host.getBoundingClientRect();
                if (r.width <= 0 || r.height <= 0) return false;
                const valid = (t) => /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(t) && t !== '01/01/1900';
                for (const span of host.querySelectorAll('.ng-binding')) {
                    const t = (span.textContent || '').trim();
                    if (valid(t)) return true;
                }
                const hasNav =
                    host.querySelector('button.mx-date-picker-nav-next') &&
                    host.querySelector('button.mx-date-picker-nav-prev');
                const hasClickTarget = host.querySelector('.mx-date-picker-selected-date');
                return Boolean(hasNav && hasClickTarget);
            },
            { timeout: timeoutMs, polling: POLL_MS },
            DATE_PICKER_SEL
        )
        .catch(() => null);
    return Boolean(ok);
}

/** Top-of-page date on Forecasting/Edit. */
async function readDisplayedForecastDate(page) {
    return page.evaluate((pickerSel) => {
        const valid = (t) => /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(t) && t !== '01/01/1900';
        const host = document.querySelector(pickerSel);
        if (host) {
            for (const span of host.querySelectorAll('.ng-binding')) {
                const t = (span.textContent || '').trim();
                if (valid(t)) return t;
            }
        }
        const spans = [...document.querySelectorAll('span.ng-binding, span.visible-md-and-larger.ng-binding')].filter(
            (s) => valid((s.textContent || '').trim()) && s.children.length === 0
        );
        spans.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
        return spans[0] ? spans[0].textContent.trim() : null;
    }, DATE_PICKER_SEL);
}

async function clickForecastDayNav(page, direction) {
    const sel =
        direction === 'next'
            ? `${DATE_PICKER_SEL} button.mx-date-picker-nav-next`
            : `${DATE_PICKER_SEL} button.mx-date-picker-nav-prev`;
    const btn = await page.$(sel);
    if (!btn) return false;
    await btn.click();
    return true;
}

const MONTH_LONG_EN = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
];

function parseUibCalendarTitle(title) {
    const m = String(title || '').match(
        /(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})/i
    );
    if (!m) return null;
    const idx = MONTH_LONG_EN.findIndex((x) => x.toLowerCase() === m[1].toLowerCase());
    if (idx < 0) return null;
    return { monthIndex: idx, year: parseInt(m[2], 10) };
}

async function openForecastDateCalendar(page) {
    const picker = await page.$(`${DATE_PICKER_SEL} .mx-date-picker-selected-date`);
    if (!picker) return false;
    await picker.click();
    try {
        await page.waitForSelector('.uib-datepicker-popup', { visible: true, timeout: 3000 });
        return true;
    } catch {
        return false;
    }
}

/** Jump to date via calendar popup (click day) - much faster than day arrows. */
async function setForecastPageDateByCalendar(page, isoDate) {
    const [year, month, day] = String(isoDate || '').split('-').map(Number);
    if (!year || !month || !day) return { ok: false };

    const previous = await readDisplayedForecastDate(page);
    const opened = await openForecastDateCalendar(page);
    if (!opened) return { ok: false };

    const targetKey = year * 12 + (month - 1);
    for (let step = 0; step < 24; step += 1) {
        const title = await page.evaluate(() => {
            const btn = document.querySelector('.uib-datepicker-popup button.uib-title, .uib-datepicker-popup .mx-date-picker-title');
            return btn ? (btn.textContent || '').trim() : '';
        });
        const parsed = parseUibCalendarTitle(title);
        if (parsed && parsed.year * 12 + parsed.monthIndex === targetKey) break;
        if (!parsed) return { ok: false, reason: 'calendar-title' };

        const curKey = parsed.year * 12 + parsed.monthIndex;
        const sel = curKey < targetKey ? 'button.uib-right' : 'button.uib-left';
        const nav = await page.$(`.uib-datepicker-popup ${sel}`);
        if (!nav) return { ok: false, reason: 'calendar-nav' };
        await nav.click();
        await page
            .waitForFunction(
                (prev) => {
                    const btn = document.querySelector(
                        '.uib-datepicker-popup button.uib-title, .uib-datepicker-popup .mx-date-picker-title'
                    );
                    return btn && (btn.textContent || '').trim() !== prev;
                },
                { timeout: 3000, polling: POLL_MS },
                title
            )
            .catch(() => {});
    }

    const picked = await page.evaluate((dayNum) => {
        const popup = document.querySelector('.uib-datepicker-popup');
        if (!popup) return { ok: false, reason: 'no-popup' };
        const want = String(dayNum);
        const wantPad = String(dayNum).padStart(2, '0');
        for (const td of popup.querySelectorAll('td.uib-day')) {
            if (td.classList.contains('text-muted')) continue;
            const btn = td.querySelector('button');
            if (!btn) continue;
            const t = (btn.textContent || '').trim();
            if (t !== want && t !== wantPad) continue;
            btn.click();
            return { ok: true };
        }
        return { ok: false, reason: 'day-not-found' };
    }, day);

    if (!picked.ok) {
        await page.keyboard.press('Escape').catch(() => {});
        return { ok: false, ...picked };
    }

    const displayStr = isoToMmxDate(isoDate);
    await waitForDisplayedForecastDate(page, displayStr);
    await waitForForecastGrid(page);
    const current = await readDisplayedForecastDate(page);
    if (current === displayStr) {
        return { ok: true, method: 'calendar-pick', previous, display: displayStr };
    }
    return { ok: false, current, reason: 'verify-failed' };
}

async function setForecastPageDateByAdjacentDay(page, isoDate, dateWaitMs = DATE_CHANGE_MS) {
    const displayStr = isoToMmxDate(isoDate);
    const currentIso = mmxDateToIso(await readDisplayedForecastDate(page));
    const diff = dayDiffIso(currentIso, isoDate);
    if (Math.abs(diff) !== 1) return { ok: false };

    const dir = diff > 0 ? 'next' : 'prev';
    const clicked = await clickForecastDayNav(page, dir);
    if (!clicked) return { ok: false };

    await waitForDisplayedForecastDate(page, displayStr, dateWaitMs);
    await waitForForecastGrid(page);
    const current = await readDisplayedForecastDate(page);
    if (current === displayStr) {
        return { ok: true, method: 'day-adjacent', previous: isoToMmxDate(currentIso), display: displayStr };
    }
    return { ok: false, current };
}

async function setForecastPageDateByDayNav(page, isoDate) {
    const targetMmx = isoToMmxDate(isoDate);
    let previous = await readDisplayedForecastDate(page);
    for (let step = 0; step < 45; step += 1) {
        const current = await readDisplayedForecastDate(page);
        if (current === targetMmx) {
            return { ok: true, method: 'day-nav', previous, steps: step };
        }
        const currentIso = mmxDateToIso(current);
        if (!currentIso) break;
        const cur = new Date(`${currentIso}T12:00:00Z`);
        const tgt = new Date(`${isoDate}T12:00:00Z`);
        const dir = tgt > cur ? 'next' : 'prev';
        const clicked = await clickForecastDayNav(page, dir);
        if (!clicked) break;
        await waitForDisplayedForecastDate(page, targetMmx, 4000);
        await waitForForecastGrid(page);
    }
    return { ok: false };
}

async function setForecastPageDateByKeyboard(page, displayStr) {
    const picker = await page.$(`${DATE_PICKER_SEL} .mx-date-picker-selected-date`);
    if (!picker) return { ok: false };
    await picker.click();
    await page.waitForSelector(`${DATE_PICKER_SEL} .mx-date-picker-selected-date`, { visible: true, timeout: 3000 }).catch(
        () => null
    );
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyA');
    await page.keyboard.up('Control');
    await page.keyboard.type(displayStr, { delay: 35 });
    await page.keyboard.press('Enter');
    const landed = await waitForDisplayedForecastDate(page, displayStr, DATE_CHANGE_MS);
    const current = await readDisplayedForecastDate(page);
    if (landed || current === displayStr) {
        return { ok: true, method: 'keyboard-type', previous: current };
    }
    return { ok: false, current };
}

async function setForecastPageDateByHiddenInput(page, displayStr) {
    return page.evaluate((wantDate) => {
        function fireInput(el, value) {
            el.removeAttribute('readonly');
            el.removeAttribute('disabled');
            el.focus();
            el.value = value;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            el.dispatchEvent(new Event('blur', { bubbles: true }));
        }

        for (const inp of document.querySelectorAll('input[type="text"], input:not([type="hidden"])')) {
            const v = (inp.value || '').trim();
            if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(v) || /date/i.test(inp.id || '') || /date/i.test(inp.name || '')) {
                fireInput(inp, wantDate);
                return { ok: true, method: 'date-input', id: inp.id || null, previous: v || null };
            }
        }
        return { ok: false };
    }, displayStr);
}

function resolveForecastHeadless(options = {}) {
    if (options.headless === false) return false;
    if (options.headless === true) return true;
    const forecastRaw = process.env.FORECAST_SCRAPER_HEADLESS;
    if (forecastRaw !== undefined && forecastRaw !== '') {
        return !/^(0|false|no|off)$/i.test(String(forecastRaw).trim());
    }
    return true;
}

function formatHourLabel(hour) {
    const h = Number(hour);
    if (!Number.isFinite(h)) return '';
    const normalized = ((h % 24) + 24) % 24;
    if (normalized === 0 || normalized === 24) return '12:00 AM';
    if (normalized === 12) return '12:00 PM';
    if (normalized < 12) return `${normalized}:00 AM`;
    return `${normalized - 12}:00 PM`;
}

function normalizeGridHourLabel(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
}

/** Reverse of formatHourLabel — e.g. "10:00 AM" → 10, "12:00 PM" → 12. */
function parseHourLabel(label) {
    const m = normalizeGridHourLabel(label).match(/^(\d{1,2}):00\s*(AM|PM)$/i);
    if (!m) return null;
    let h = parseInt(m[1], 10);
    const pm = m[2].toUpperCase() === 'PM';
    if (h === 12 && !pm) return 0;
    if (h === 12 && pm) return 12;
    if (!pm) return h;
    return h + 12;
}

function hourLabelsMatch(a, b) {
    const left = normalizeGridHourLabel(a);
    const right = normalizeGridHourLabel(b);
    if (left && left === right) return true;
    const ha = parseHourLabel(left);
    const hb = parseHourLabel(right);
    return ha != null && hb != null && ha === hb;
}

function buildGridLabelByHour(labels) {
    const map = new Map();
    for (const label of labels || []) {
        const hour = parseHourLabel(label);
        if (hour != null && !map.has(hour)) map.set(hour, normalizeGridHourLabel(label));
    }
    return map;
}

function alignSlotLabelsToGrid(slots, labelByHour) {
    return (slots || []).map((slot) => {
        const gridLabel = labelByHour.get(Number(slot.hour));
        return gridLabel ? { ...slot, label: gridLabel } : slot;
    });
}

async function realignSlotsFromGrid(page, slots) {
    const gridLabels = await listForecastGridHourLabels(page);
    const labelByHour = buildGridLabelByHour(gridLabels);
    return alignSlotLabelsToGrid(slots, labelByHour);
}

async function scrollForecastGridToTop(page) {
    await page.evaluate(() => {
        const first = document.querySelector('tr.mx-fg-hour');
        first?.scrollIntoView({ block: 'start', inline: 'nearest' });
    });
}

async function scrollForecastHourIntoView(page, slot) {
    const row = await findForecastHourRowHandle(page, slot.label, slot.hour);
    if (!row) return false;
    await row.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'nearest' }));
    await row.dispose();
    return true;
}

/** Escalating Puppeteer retries after bulk fill misses a slot. */
async function retryForecastSlotRedundant(page, slot, onProgress, cellCache) {
    let current = { ...slot };
    for (let pass = 0; pass < 3; pass += 1) {
        if (pass > 0) {
            const [realigned] = await realignSlotsFromGrid(page, [current]);
            if (realigned) current = realigned;
            await scrollForecastHourIntoView(page, current);
            if (pass === 2) {
                await dismissForecastOverrideEditor(page).catch(() => {});
                await waitForForecastGrid(page, { minRows: 1, timeoutMs: 2000 });
            }
        }
        const result = await enterAndVerifyForecastSlot(page, current, onProgress, {
            cellCache,
            continuous: false,
            force: true,
            retry: pass > 0,
        });
        if (result.ok) return { ...result, slot: current };
        await dismissForecastOverrideEditor(page).catch(() => {});
    }
    return { ok: false, slot: current };
}

function isWithinTradingHours(hour, openHour, closeHour) {
    const h = Number(hour);
    const open = Number(openHour);
    const close = Number(closeHour);
    if (!Number.isFinite(h) || !Number.isFinite(open) || !Number.isFinite(close)) return false;
    return h >= open && h < close;
}

async function listForecastGridHourLabels(page) {
    return page.evaluate(() => {
        const labels = [];
        for (const tr of document.querySelectorAll('tr.mx-fg-hour')) {
            const labelSpan = tr.querySelector('[id^="mx-forecast-grid-interval-directive-list-hour-"]');
            const label = (labelSpan?.textContent || '').replace(/\s+/g, ' ').trim();
            if (label) labels.push(label);
        }
        return labels;
    });
}

async function readAllManagerForecastCells(page) {
    const raw = await page.evaluate(() => {
        const out = {};
        for (const tr of document.querySelectorAll('tr.mx-fg-hour')) {
            const labelSpan = tr.querySelector('[id^="mx-forecast-grid-interval-directive-list-hour-"]');
            const rowLabel = (labelSpan?.textContent || '').replace(/\s+/g, ' ').trim();
            if (!rowLabel) continue;
            const cell =
                tr.querySelector('[id*="managerforecast"]') ||
                tr.querySelector('td.mx-grid-column-input');
            if (!cell) continue;
            out[rowLabel] = (cell.textContent || '').replace(/\s+/g, ' ').trim();
        }
        return out;
    });
    const out = { ...raw };
    for (const [label, value] of Object.entries(raw)) {
        const hour = parseHourLabel(label);
        if (hour != null) out[`__h${hour}`] = value;
    }
    return out;
}

function getCellCacheValue(cellCache, slot) {
    if (!cellCache || !slot) return undefined;
    if (Object.prototype.hasOwnProperty.call(cellCache, slot.label)) {
        return cellCache[slot.label];
    }
    const hour = Number(slot.hour);
    if (Number.isFinite(hour) && Object.prototype.hasOwnProperty.call(cellCache, `__h${hour}`)) {
        return cellCache[`__h${hour}`];
    }
    return undefined;
}

function slotCacheMatches(cellCache, slot) {
    return forecastValuesMatch(getCellCacheValue(cellCache, slot), slot.forecast);
}

/** Trading-hour plan slots plus $0 for every other hour row visible on the MMX grid. */
async function buildDayFillSlots(page, day, openHour, closeHour) {
    const gridLabels = await listForecastGridHourLabels(page);
    const labelByHour = buildGridLabelByHour(gridLabels);
    // Plan hourly is already scoped to history trading hours — do not re-filter by
    // storelist hours (can disagree, e.g. 3904 storelist close 14 vs plan close 22).
    let trading = normalizeHourlySlots(day.hourly || []);
    trading = alignSlotLabelsToGrid(trading, labelByHour);
    const tradingLabels = new Set(trading.map((s) => s.label));
    const outside = [];

    for (const label of gridLabels) {
        if (tradingLabels.has(label)) continue;
        const hour = parseHourLabel(label);
        if (hour == null) continue;
        outside.push({ hour, label: normalizeGridHourLabel(label), forecast: 0, outsideHours: true });
    }

    return [...trading, ...outside];
}

async function waitForForecastGrid(page, { minRows = 1, timeoutMs = GRID_WAIT_MS } = {}) {
    await page
        .waitForFunction(
            () =>
                document.querySelectorAll('tr.mx-fg-hour').length > 0 ||
                document.querySelector('[id^="mx-forecast-grid-interval-directive-list-hour-"]') ||
                document.querySelector('table.forecastGrid'),
            { timeout: timeoutMs, polling: POLL_MS }
        )
        .catch(() => {});
    await waitForForecastHourRows(page, { minRows, timeoutMs });
}

async function countForecastHourRows(page) {
    return page.evaluate(() => {
        return [...document.querySelectorAll('tr.mx-fg-hour')].filter((tr) =>
            tr.querySelector('[id*="managerforecast"], td.mx-grid-column-input')
        ).length;
    });
}

/** Poll until the manager-forecast grid shows enough rows and the first planned hour label. */
async function ensureForecastGridReadyForHours(page, hourly, options = {}) {
    const slots = normalizeHourlySlots(hourly);
    const minRows = Math.max(1, Math.min(slots.length, Number(options.minRows) || 8));
    const targets = slots.slice(0, 8).map((slot) => ({ label: slot.label || '', hour: slot.hour ?? null }));
    const timeoutMs = Number(options.timeoutMs) || GRID_WAIT_MS;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        const ready = await page.evaluate(
            (min, hourTargets) => {
                const norm = (t) => String(t || '').replace(/\s+/g, ' ').trim();
                const parse = (text) => {
                    const m = norm(text).match(/^(\d{1,2}):00\s*(AM|PM)$/i);
                    if (!m) return null;
                    let h = parseInt(m[1], 10);
                    const pm = m[2].toUpperCase() === 'PM';
                    if (h === 12 && !pm) return 0;
                    if (h === 12 && pm) return 12;
                    return pm ? h + 12 : h;
                };
                const rows = [...document.querySelectorAll('tr.mx-fg-hour')].filter((tr) =>
                    tr.querySelector('[id*="managerforecast"], td.mx-grid-column-input')
                );
                if (rows.length < min) return false;
                if (!hourTargets.length) return true;
                const rowMatches = (tr, target) => {
                    const labelSpan = tr.querySelector('[id^="mx-forecast-grid-interval-directive-list-hour-"]');
                    const rowLabel = norm(labelSpan?.textContent);
                    if (target.label && rowLabel === norm(target.label)) return true;
                    return target.hour != null && parse(rowLabel) === target.hour;
                };
                return hourTargets.some((target) => rows.some((tr) => rowMatches(tr, target)));
            },
            minRows,
            targets
        );
        if (ready) return true;
        await page.waitForTimeout(POLL_MS);
    }
    return false;
}

/** Wait until manager-forecast hour rows are present (grid finished reloading after date change). */
async function waitForForecastHourRows(page, { minRows = 8, timeoutMs = GRID_WAIT_MS } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const count = await countForecastHourRows(page);
        if (count >= minRows) return true;
        await page.waitForTimeout(POLL_MS);
    }
    return (await countForecastHourRows(page)) >= minRows;
}

async function waitForOverrideEditorClosed(page, timeoutMs = OVERRIDE_CLOSE_MS) {
    try {
        await page.waitForFunction(
            () => {
                const inp = document.querySelector('#overrideInput');
                if (!inp) return true;
                const r = inp.getBoundingClientRect();
                return r.width <= 0 || r.height <= 0;
            },
            { timeout: timeoutMs, polling: POLL_MS }
        );
        return true;
    } catch {
        return false;
    }
}

/** Poll until inline editor is gone and the manager-forecast cell shows the committed value. */
async function waitForCellCommitted(page, wantLabel, wanted, timeoutMs = VERIFY_TIMEOUT_MS, wantHour = null) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const editorClosed = await page.evaluate(() => {
            const inp = document.querySelector('#overrideInput');
            if (!inp) return true;
            const r = inp.getBoundingClientRect();
            return r.width <= 0 || r.height <= 0;
        });
        if (editorClosed) {
            const readText = await readManagerForecastCell(page, wantLabel, wantHour);
            if (forecastValuesMatch(readText, wanted)) return true;
        }
        await page.waitForTimeout(POLL_MS);
    }
    return false;
}

function commitTimeoutForValue(forecast, options = {}) {
    if (options.fastZero || (Math.round(Number(forecast) || 0) === 0 && options.outsideHours)) {
        return ZERO_VERIFY_TIMEOUT_MS;
    }
    if (Math.round(Number(forecast) || 0) === 0) return ZERO_VERIFY_TIMEOUT_MS;
    return VERIFY_TIMEOUT_MS;
}

async function dismissForecastOverrideEditor(page) {
    // Do not press Escape — in Forecasting/Edit it can cancel pending manager overrides
    // and clear the dirty flag so Save never appears.
    await page.evaluate(() => {
        const inp = document.querySelector('#overrideInput');
        if (inp) {
            inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
            inp.blur();
        }
        const header = document.querySelector('#ForecastGridHeader, .mx-grid-header-container');
        header?.click();
    });
    await waitForOverrideEditorClosed(page);
}

/** Close inline editor without waiting — used between rapid back-to-back cell entries. */
async function dismissForecastOverrideEditorQuick(page) {
    if (!(await isOverrideEditorVisible(page))) return;
    await page.evaluate(() => {
        const inp = document.querySelector('#overrideInput');
        if (inp) {
            inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
            inp.blur();
        }
    });
}

async function ensureManagerForecastDollarMode(page) {
    const already = await page.evaluate(() => {
        for (const btn of document.querySelectorAll('#ForecastGridHeader button.mx-panel-button')) {
            if ((btn.textContent || '').trim() !== '$') continue;
            return btn.classList.contains('btn-success');
        }
        return false;
    });
    if (already) return;

    await page.evaluate(() => {
        for (const btn of document.querySelectorAll('#ForecastGridHeader button.mx-panel-button')) {
            if ((btn.textContent || '').trim() !== '$') continue;
            if (!btn.classList.contains('btn-success')) btn.click();
            break;
        }
    });
    await page
        .waitForFunction(
            () => {
                for (const btn of document.querySelectorAll('#ForecastGridHeader button.mx-panel-button')) {
                    if ((btn.textContent || '').trim() !== '$') continue;
                    return btn.classList.contains('btn-success');
                }
                return false;
            },
            { timeout: DOLLAR_MODE_MS, polling: POLL_MS }
        )
        .catch(() => {});
}

function parseForecastDollar(text) {
    if (text == null || text === '') return null;
    const match = String(text).match(/-?\$?\s*([\d,]+(?:\.\d+)?)/);
    if (!match) return null;
    const n = Number(String(match[1]).replace(/,/g, ''));
    return Number.isFinite(n) ? Math.round(n) : null;
}

function forecastValuesMatch(readText, want) {
    const wanted = Math.round(Number(want) || 0);
    const read = parseForecastDollar(readText);
    if (wanted === 0) {
        return read === 0;
    }
    if (read == null) return false;
    return read === wanted;
}

function normalizeHourlySlots(hourly) {
    return (hourly || []).map((slot) => ({
        hour: slot.hour,
        label: formatHourLabel(slot.hour),
        forecast: Math.round(Number(slot.forecast) || 0),
        ...(slot.outsideHours ? { outsideHours: true } : {}),
        ...(slot.zeroSales ? { zeroSales: true } : {}),
    }));
}

function emitSlotProgress(onProgress, payload) {
    if (typeof onProgress !== 'function') return;
    try {
        onProgress(payload);
    } catch (_) {
        /* ignore UI progress errors */
    }
}

async function readManagerForecastCell(page, wantLabel, wantHour = null) {
    return page.evaluate(
        (label, hour) => {
            const norm = (t) => String(t || '').replace(/\s+/g, ' ').trim();
            const parse = (text) => {
                const m = norm(text).match(/^(\d{1,2}):00\s*(AM|PM)$/i);
                if (!m) return null;
                let h = parseInt(m[1], 10);
                const pm = m[2].toUpperCase() === 'PM';
                if (h === 12 && !pm) return 0;
                if (h === 12 && pm) return 12;
                return pm ? h + 12 : h;
            };
            const wantNorm = norm(label);
            for (const tr of document.querySelectorAll('tr.mx-fg-hour')) {
                const labelSpan = tr.querySelector('[id^="mx-forecast-grid-interval-directive-list-hour-"]');
                const rowLabel = norm(labelSpan?.textContent);
                const rowHour = parse(rowLabel);
                const labelMatch = rowLabel === wantNorm;
                const hourMatch = hour != null && rowHour != null && rowHour === hour;
                if (!labelMatch && !hourMatch) continue;
                const cell =
                    tr.querySelector('[id*="managerforecast"]') ||
                    tr.querySelector('td.mx-grid-column-input');
                if (!cell) return null;
                return norm(cell.textContent);
            }
            return null;
        },
        wantLabel,
        wantHour != null ? Number(wantHour) : null
    );
}

async function waitForManagerForecastValue(page, wantLabel, forecast, timeoutMs = VERIFY_TIMEOUT_MS, wantHour = null) {
    const wanted = Math.round(Number(forecast) || 0);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const readText = await readManagerForecastCell(page, wantLabel, wantHour);
        if (forecastValuesMatch(readText, wanted)) {
            return { ok: true, read: parseForecastDollar(readText), readText };
        }
        await page.waitForTimeout(VERIFY_POLL_MS);
    }
    const readText = await readManagerForecastCell(page, wantLabel, wantHour);
    return {
        ok: forecastValuesMatch(readText, wanted),
        read: parseForecastDollar(readText),
        readText,
    };
}

/** Commit a value into #overrideInput (Angular-aware) so MMX replaces existing manager values. */
async function writeForecastOverrideValue(page, value, options = {}) {
    const text = String(Math.round(Number(value) || 0));
    if (!options.skipWait) {
        const ready = await page
            .waitForSelector(MANAGER_OVERRIDE_INPUT, { visible: true, timeout: 2000 })
            .catch(() => null);
        if (!ready) return false;
    } else if (!(await isOverrideEditorVisible(page))) {
        return false;
    }

    const ok = await page.evaluate(
        (sel, val) => {
            const el = document.querySelector(sel);
            if (!el) return false;
            el.focus();
            if (typeof el.select === 'function') el.select();
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
            if (setter) setter.call(el, val);
            else el.value = val;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
            el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
            el.blur();
            return true;
        },
        MANAGER_OVERRIDE_INPUT,
        text
    );
    return Boolean(ok);
}

async function findForecastHourRowHandle(page, wantLabel, wantHour = null) {
    const handle = await page.evaluateHandle(
        (label, hour) => {
            const norm = (t) => String(t || '').replace(/\s+/g, ' ').trim();
            const parse = (text) => {
                const m = norm(text).match(/^(\d{1,2}):00\s*(AM|PM)$/i);
                if (!m) return null;
                let h = parseInt(m[1], 10);
                const pm = m[2].toUpperCase() === 'PM';
                if (h === 12 && !pm) return 0;
                if (h === 12 && pm) return 12;
                return pm ? h + 12 : h;
            };
            const wantNorm = norm(label);
            const labelNeeded = wantNorm.length > 0;
            for (const tr of document.querySelectorAll('tr.mx-fg-hour')) {
                const labelSpan = tr.querySelector('[id^="mx-forecast-grid-interval-directive-list-hour-"]');
                const rowLabel = norm(labelSpan?.textContent);
                const rowHour = parse(rowLabel);
                if (labelNeeded && rowLabel !== wantNorm && (hour == null || rowHour !== hour)) continue;
                if (!labelNeeded && (hour == null || rowHour !== hour)) continue;
                return tr;
            }
            return null;
        },
        wantLabel,
        wantHour != null ? Number(wantHour) : null
    );
    const row = handle.asElement();
    if (!row) {
        await handle.dispose();
        return null;
    }
    return row;
}

async function isOverrideEditorVisible(page) {
    return page.evaluate(() => {
        const inp = document.querySelector('#overrideInput');
        if (!inp) return false;
        const r = inp.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
    });
}

/** Open manager-forecast inline editor via real Puppeteer clicks (synthetic events are unreliable in MMX). */
async function openForecastHourCell(page, wantLabel, options = {}) {
    const quick = Boolean(options.quick);
    const cellSelectors = [
        '[id*="managerforecast"]',
        'td.mx-grid-column-input span.form-control',
        'td.mx-grid-column-input',
        'td:last-child',
    ];

    const wantHour = options.hour != null ? Number(options.hour) : null;
    const maxAttempts = quick ? 3 : 5;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        if (attempt > 0) {
            if (quick) await dismissForecastOverrideEditorQuick(page);
            else await dismissForecastOverrideEditor(page);
        }

        let row = await findForecastHourRowHandle(page, wantLabel, wantHour);
        if (!row && wantHour != null && attempt > 0) {
            row = await findForecastHourRowHandle(page, '', wantHour);
        }
        if (!row) continue;

        await row.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'nearest' }));
        if (!quick) {
            await page
                .waitForFunction(
                    (label, hour) => {
                        const norm = (t) => String(t || '').replace(/\s+/g, ' ').trim();
                        const parse = (text) => {
                            const m = norm(text).match(/^(\d{1,2}):00\s*(AM|PM)$/i);
                            if (!m) return null;
                            let h = parseInt(m[1], 10);
                            const pm = m[2].toUpperCase() === 'PM';
                            if (h === 12 && !pm) return 0;
                            if (h === 12 && pm) return 12;
                            return pm ? h + 12 : h;
                        };
                        for (const tr of document.querySelectorAll('tr.mx-fg-hour')) {
                            const labelSpan = tr.querySelector(
                                '[id^="mx-forecast-grid-interval-directive-list-hour-"]'
                            );
                            const rowLabel = norm(labelSpan?.textContent);
                            const rowHour = parse(rowLabel);
                            const labelMatch = label && rowLabel === norm(label);
                            const hourMatch = hour != null && rowHour === hour;
                            if (!labelMatch && !hourMatch) continue;
                            const r = tr.getBoundingClientRect();
                            return r.top >= 0 && r.bottom <= window.innerHeight;
                        }
                        return false;
                    },
                    { timeout: 2000, polling: POLL_MS },
                    wantLabel,
                    wantHour
                )
                .catch(() => {});
        }

        let opened = false;
        for (const sel of cellSelectors) {
            const cell = await row.$(sel);
            if (!cell) continue;
            try {
                await cell.click({ clickCount: 2, delay: CELL_CLICK_DELAY_MS });
                if (await isOverrideEditorVisible(page)) {
                    opened = true;
                    break;
                }
                await cell.click({ delay: CELL_CLICK_DELAY_MS });
                if (await isOverrideEditorVisible(page)) {
                    opened = true;
                    break;
                }
            } catch {
                /* try next selector */
            }
        }

        if (!opened) {
            const cell = await row.$(cellSelectors[0]);
            if (cell) {
                const box = await cell.boundingBox();
                if (box) {
                    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, {
                        clickCount: 2,
                        delay: CELL_CLICK_DELAY_MS,
                    });
                    opened = await isOverrideEditorVisible(page);
                }
            }
        }

        await row.dispose();
        if (opened) return true;
    }
    return false;
}

/** Click hour row Manager Forecast cell, fill #overrideInput (MMX inline editor). */
async function fillForecastHourCell(page, wantLabel, forecast, options = {}) {
    const wanted = Math.round(Number(forecast) || 0);
    const force = Boolean(options.force);
    const cellCache = options.cellCache;

    if (await isOverrideEditorVisible(page)) {
        if (options.continuous) {
            await dismissForecastOverrideEditorQuick(page);
            await waitForOverrideEditorClosed(page, OVERRIDE_CLOSE_CONTINUOUS_MS);
        } else {
            await dismissForecastOverrideEditor(page);
        }
    }

    const readExisting = () => {
        if (cellCache) {
            const cached = getCellCacheValue(cellCache, { label: wantLabel, hour: options.hour });
            if (cached !== undefined) return cached;
        }
        return readManagerForecastCell(page, wantLabel, options.hour);
    };

    if (!force) {
        const existing = await readExisting();
        if (forecastValuesMatch(existing, wanted)) {
            return 'already';
        }
    }

    const clicked = await openForecastHourCell(
        page,
        wantLabel,
        {
            ...(options.continuous ? { quick: true } : {}),
            hour: options.hour,
        }
    );
    if (!clicked) return false;

    try {
        await page.waitForSelector(MANAGER_OVERRIDE_INPUT, {
            visible: true,
            timeout: options.continuous ? 1500 : 3500,
        });
    } catch {
        const afterClick = await readManagerForecastCell(page, wantLabel, options.hour);
        if (forecastValuesMatch(afterClick, wanted)) return 'already';
        return false;
    }

    let wrote = await writeForecastOverrideValue(page, wanted, { skipWait: options.continuous });
    if (!wrote) {
        wrote = await page.evaluate(
            (sel, val) => {
                const el = document.querySelector(sel);
                if (!el) return false;
                el.focus();
                el.value = val;
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
                el.blur();
                return true;
            },
            MANAGER_OVERRIDE_INPUT,
            String(wanted)
        );
    }
    if (!wrote) return false;

    if (options.continuous) {
        cacheForecastCellValue(cellCache, { label: wantLabel, hour: options.hour }, wanted);
        return true;
    }

    const committed = await waitForCellCommitted(
        page,
        wantLabel,
        wanted,
        commitTimeoutForValue(wanted, options),
        options.hour
    );
    await dismissForecastOverrideEditor(page);
    if (committed && cellCache) {
        cacheForecastCellValue(cellCache, { label: wantLabel, hour: options.hour }, wanted);
    }
    return committed ? true : false;
}

function cacheForecastCellValue(cellCache, slotOrLabel, wanted, hour = null) {
    if (!cellCache) return;
    const val = wanted === 0 ? '$0.00' : `$${Math.round(Number(wanted) || 0).toLocaleString('en-US')}.00`;
    if (slotOrLabel && typeof slotOrLabel === 'object') {
        cellCache[slotOrLabel.label] = val;
        if (slotOrLabel.hour != null) cellCache[`__h${slotOrLabel.hour}`] = val;
        return;
    }
    cellCache[slotOrLabel] = val;
    if (hour != null) cellCache[`__h${hour}`] = val;
}

async function enterAndVerifyForecastSlot(page, slot, onProgress, options = {}) {
    const { retry = false, cellCache = null } = options;
    const preRead =
        cellCache && getCellCacheValue(cellCache, slot) !== undefined
            ? getCellCacheValue(cellCache, slot)
            : await readManagerForecastCell(page, slot.label, slot.hour);
    if (forecastValuesMatch(preRead, slot.forecast)) {
        const read = parseForecastDollar(preRead);
        emitSlotProgress(onProgress, {
            type: 'hour-confirmed',
            hour: slot.hour,
            label: slot.label,
            forecast: slot.forecast,
            read,
            skipped: true,
        });
        return { ok: true, read };
    }

    emitSlotProgress(onProgress, {
        type: 'hour-entering',
        hour: slot.hour,
        label: slot.label,
        forecast: slot.forecast,
        retry,
        outsideHours: Boolean(slot.outsideHours),
    });

    const fillOpts = {
        cellCache,
        hour: slot.hour,
        outsideHours: slot.outsideHours,
        fastZero: slot.outsideHours || slot.forecast === 0,
        continuous: Boolean(options.continuous),
        force: Boolean(options.force || retry),
    };
    const filled = await fillForecastHourCell(page, slot.label, slot.forecast, fillOpts);
    if (!filled) {
        if (!retry) {
            await dismissForecastOverrideEditor(page);
            return enterAndVerifyForecastSlot(page, slot, onProgress, {
                retry: true,
                cellCache,
                force: true,
                suppressFailureProgress: options.suppressFailureProgress,
            });
        }
        if (!options.suppressFailureProgress) {
            emitSlotProgress(onProgress, {
                type: 'hour-failed',
                hour: slot.hour,
                label: slot.label,
                forecast: slot.forecast,
                reason: 'Could not open forecast cell',
            });
        }
        return { ok: false, reason: 'no-fill' };
    }

    if (filled === 'already') {
        const read = parseForecastDollar(preRead);
        emitSlotProgress(onProgress, {
            type: 'hour-confirmed',
            hour: slot.hour,
            label: slot.label,
            forecast: slot.forecast,
            read,
            skipped: true,
        });
        return { ok: true, read };
    }

    if (filled && options.continuous) {
        emitSlotProgress(onProgress, {
            type: 'hour-confirmed',
            hour: slot.hour,
            label: slot.label,
            forecast: slot.forecast,
            read: slot.forecast,
        });
        return { ok: true, read: slot.forecast };
    }

    if (filled) {
        const readText = await readManagerForecastCell(page, slot.label, slot.hour);
        const read = parseForecastDollar(readText);
        emitSlotProgress(onProgress, {
            type: 'hour-confirmed',
            hour: slot.hour,
            label: slot.label,
            forecast: slot.forecast,
            read: read ?? slot.forecast,
        });
        if (cellCache) cacheForecastCellValue(cellCache, slot, slot.forecast);
        return { ok: true, read: read ?? slot.forecast };
    }

    return { ok: false, reason: 'no-fill' };
}

/** Fill many manager-forecast cells in one browser turn (avoids per-cell Puppeteer round-trips). */
async function fillForecastSlotsBulkInPage(page, updates) {
    if (!updates?.length) return { filled: [], failed: [] };

    return page.evaluate((rows) => {
        const spin = (ms) => {
            const end = Date.now() + ms;
            while (Date.now() < end) {
                /* yield to Angular digest between cells */
            }
        };

        const parseDollar = (text) => {
            if (text == null || text === '') return null;
            const match = String(text).match(/-?\$?\s*([\d,]+(?:\.\d+)?)/);
            if (!match) return null;
            const n = Number(String(match[1]).replace(/,/g, ''));
            return Number.isFinite(n) ? Math.round(n) : null;
        };

        const valuesMatch = (readText, want) => {
            const wanted = Math.round(Number(want) || 0);
            const read = parseDollar(readText);
            if (wanted === 0) return read === 0;
            if (read == null) return false;
            return read === wanted;
        };

        const rowForLabel = (label, hour) => {
            const norm = (t) => String(t || '').replace(/\s+/g, ' ').trim();
            const parse = (text) => {
                const m = norm(text).match(/^(\d{1,2}):00\s*(AM|PM)$/i);
                if (!m) return null;
                let h = parseInt(m[1], 10);
                const pm = m[2].toUpperCase() === 'PM';
                if (h === 12 && !pm) return 0;
                if (h === 12 && pm) return 12;
                return pm ? h + 12 : h;
            };
            const wantNorm = norm(label);
            for (const tr of document.querySelectorAll('tr.mx-fg-hour')) {
                const labelSpan = tr.querySelector('[id^="mx-forecast-grid-interval-directive-list-hour-"]');
                const rowLabel = norm(labelSpan?.textContent);
                const rowHour = parse(rowLabel);
                if (rowLabel !== wantNorm && (hour == null || rowHour !== hour)) continue;
                return tr;
            }
            return null;
        };

        const readCell = (tr) => {
            const cell =
                tr.querySelector('[id*="managerforecast"]') || tr.querySelector('td.mx-grid-column-input');
            return (cell?.textContent || '').replace(/\s+/g, ' ').trim();
        };

        const overrideOpen = () => {
            const inp = document.querySelector('#overrideInput');
            if (!inp) return false;
            const r = inp.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
        };

        const closeOverride = () => {
            const inp = document.querySelector('#overrideInput');
            if (inp) {
                inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
                inp.blur();
            }
        };

        const openCell = (tr, slow) => {
            tr.scrollIntoView({ block: 'center', inline: 'nearest' });
            const selectors = [
                '[id*="managerforecast"]',
                'td.mx-grid-column-input span.form-control',
                'td.mx-grid-column-input',
                'td:last-child',
            ];
            for (const sel of selectors) {
                const cell = tr.querySelector(sel);
                if (!cell) continue;
                cell.click();
                cell.click();
                if (slow) cell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
                if (overrideOpen()) return true;
            }
            return false;
        };

        const writeOverride = (val) => {
            const el = document.querySelector('#overrideInput');
            if (!el) return false;
            const text = String(Math.round(Number(val) || 0));
            el.focus();
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
            if (setter) setter.call(el, text);
            else el.value = text;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
            el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
            el.blur();
            return true;
        };

        const fillOne = (row, slow) => {
            const label = row.label;
            const hour = row.hour != null ? Number(row.hour) : null;
            const forecast = Math.round(Number(row.forecast) || 0);
            const tr = rowForLabel(label, hour);
            if (!tr) return { label, hour, ok: false, reason: 'no-row' };
            if (valuesMatch(readCell(tr), forecast)) {
                return { label, hour, ok: true, skipped: true };
            }
            closeOverride();
            spin(slow ? 4 : 1);
            if (!openCell(tr, slow)) {
                return { label, hour, ok: false, reason: 'no-open' };
            }
            spin(slow ? 6 : 2);
            if (!writeOverride(forecast)) {
                return { label, hour, ok: false, reason: 'no-write' };
            }
            spin(slow ? 8 : 2);
            return { label, hour, ok: true, skipped: false };
        };

        const filled = [];
        const failed = [];

        for (const row of rows) {
            const result = fillOne(row, false);
            if (result.ok) filled.push({ label: result.label, skipped: result.skipped });
            else failed.push({ label: result.label, hour: result.hour, reason: result.reason });
        }

        const retryRows = rows.filter((row) =>
            failed.some((f) => f.label === row.label || (f.hour != null && f.hour === row.hour))
        );
        if (retryRows.length) {
            closeOverride();
            spin(4);
            failed.length = 0;
            for (const row of retryRows) {
                const result = fillOne(row, true);
                if (result.ok) {
                    filled.push({ label: result.label, skipped: result.skipped });
                } else {
                    failed.push({ label: result.label, hour: result.hour, reason: result.reason });
                }
            }
        }

        closeOverride();
        return { filled, failed };
    }, updates);
}

/** Fill each hour via bulk in-page loop; slow Puppeteer retry only for mismatches. */
async function fillForecastHourlyInputs(page, hourly, options = {}) {
    if (!options.skipDollarMode) await ensureManagerForecastDollarMode(page);

    const slots = normalizeHourlySlots(hourly);
    const onProgress = options.onProgress;
    const cellCache = options.cellCache || (await readAllManagerForecastCells(page));
    let confirmed = 0;
    const missed = [];
    const failed = [];

    const pending = slots.filter((slot) => !slotCacheMatches(cellCache, slot));
    for (const slot of slots) {
        if (!pending.some((row) => row.label === slot.label)) {
            confirmed += 1;
            emitSlotProgress(onProgress, {
                type: 'hour-confirmed',
                hour: slot.hour,
                label: slot.label,
                forecast: slot.forecast,
                read: parseForecastDollar(getCellCacheValue(cellCache, slot)),
                skipped: true,
            });
        }
    }

    if (pending.length) {
        for (const slot of pending) {
            emitSlotProgress(onProgress, {
                type: 'hour-entering',
                hour: slot.hour,
                label: slot.label,
                forecast: slot.forecast,
                outsideHours: Boolean(slot.outsideHours),
            });
        }

        const realigned = await realignSlotsFromGrid(page, pending);
        for (let i = 0; i < pending.length; i += 1) {
            pending[i] = realigned[i] || pending[i];
        }

        await dismissForecastOverrideEditor(page).catch(() => {});

        const toBulkRows = (batch) =>
            batch.map((slot) => ({ label: slot.label, forecast: slot.forecast, hour: slot.hour }));

        const tradingPending = pending.filter((slot) => !slot.outsideHours);
        const outsidePending = pending.filter((slot) => slot.outsideHours);
        const bulkFailed = [];

        if (tradingPending.length) {
            await scrollForecastGridToTop(page);
            const tradingBulk = await fillForecastSlotsBulkInPage(page, toBulkRows(tradingPending));
            bulkFailed.push(...tradingBulk.failed);
        }
        if (outsidePending.length) {
            await dismissForecastOverrideEditor(page).catch(() => {});
            const outsideBulk = await fillForecastSlotsBulkInPage(page, toBulkRows(outsidePending));
            bulkFailed.push(...outsideBulk.failed);
        }

        Object.assign(cellCache, await readAllManagerForecastCells(page));

        const stillPending = pending.filter((slot) => !slotCacheMatches(cellCache, slot));
        if (stillPending.length) {
            await dismissForecastOverrideEditor(page).catch(() => {});
            const retryBulk = await fillForecastSlotsBulkInPage(page, toBulkRows(stillPending));
            bulkFailed.push(...retryBulk.failed);
            Object.assign(cellCache, await readAllManagerForecastCells(page));
        }

        for (const slot of pending) {
            if (slotCacheMatches(cellCache, slot)) {
                confirmed += 1;
                emitSlotProgress(onProgress, {
                    type: 'hour-confirmed',
                    hour: slot.hour,
                    label: slot.label,
                    forecast: slot.forecast,
                    read: parseForecastDollar(getCellCacheValue(cellCache, slot)),
                });
            } else {
                const bulkFail = bulkFailed.find(
                    (row) => row.label === slot.label || row.hour === slot.hour
                );
                missed.push(slot.label);
                failed.push({ ...slot, reason: bulkFail?.reason || 'bulk-mismatch' });
            }
        }
    }

    let changed = pending.length > 0;

    const stillMissed = slots.filter((slot) => !slotCacheMatches(cellCache, slot));
    for (const slot of stillMissed) {
        await dismissForecastOverrideEditor(page).catch(() => {});
        const result = await retryForecastSlotRedundant(page, slot, onProgress, cellCache);
        if (result.ok) {
            changed = true;
            if (result.slot && result.slot.label !== slot.label) {
                slot.label = result.slot.label;
            }
            if (missed.includes(slot.label)) {
                missed.splice(missed.indexOf(slot.label), 1);
                failed.splice(
                    failed.findIndex((row) => row.label === slot.label || row.hour === slot.hour),
                    1
                );
            }
            confirmed += 1;
            Object.assign(cellCache, await readAllManagerForecastCells(page));
        }
    }

    confirmed = slots.filter((slot) => slotCacheMatches(cellCache, slot)).length;
    missed.length = 0;
    failed.length = 0;
    for (const slot of slots) {
        if (!slotCacheMatches(cellCache, slot)) {
            missed.push(slot.label);
            failed.push({ ...slot, reason: 'batch-mismatch' });
        }
    }

    const out = { touched: confirmed, confirmed, missed, failed, slotCount: slots.length, changed, cellCache };
    const tradingSlots = slots.filter((s) => !s.outsideHours);
    const tradingMissed = missed.filter((label) => {
        const slot = slots.find((s) => s.label === label);
        return slot && !slot.outsideHours;
    });
    if (!tradingSlots.length) {
        throw new Error('No trading-hour forecast slots in plan for this day.');
    }
    if (tradingMissed.length) {
        const gridLabels = await listForecastGridHourLabels(page).catch(() => []);
        const storeHint = options.storeNumber ? ` (store ${options.storeNumber})` : '';
        throw new Error(
            `Manager Forecast cells not matched for ${tradingMissed.length}/${tradingSlots.length} trading hours${storeHint} ` +
                `(${tradingMissed.join(', ')}). ` +
                (gridLabels.length
                    ? `Grid shows: ${gridLabels.slice(0, 8).join(', ')}${gridLabels.length > 8 ? '…' : ''}.`
                    : 'Forecast grid hour labels not found.') +
                ' Check Macromatix grid layout or store trading hours in .storelist.'
        );
    }
    return out;
}

/** Second pass: read every hour on the page; re-enter any that do not match. */
async function verifyForecastDay(page, hourly, options = {}) {
    const slots = normalizeHourlySlots(hourly);
    const onProgress = options.onProgress;
    const cellCache = options.cellCache || (await readAllManagerForecastCells(page));
    let confirmed = 0;
    const failed = [];

    for (const slot of slots) {
        emitSlotProgress(onProgress, {
            type: 'hour-verifying',
            hour: slot.hour,
            label: slot.label,
            forecast: slot.forecast,
            phase: 'day-check',
        });

        const liveRead = await readManagerForecastCell(page, slot.label, slot.hour);
        const cachedRead = getCellCacheValue(cellCache, slot);
        // Prefer live DOM. Cache-only matches hid unsaved/reverted values after Escape.
        const readText =
            liveRead != null && String(liveRead).trim() !== '' ? liveRead : cachedRead;
        if (forecastValuesMatch(readText, slot.forecast)) {
            confirmed += 1;
            emitSlotProgress(onProgress, {
                type: 'hour-confirmed',
                hour: slot.hour,
                label: slot.label,
                forecast: slot.forecast,
                read: parseForecastDollar(readText),
                phase: 'day-check',
            });
            continue;
        }

        const fix = await enterAndVerifyForecastSlot(page, slot, onProgress, {
            cellCache,
            suppressFailureProgress: true,
        });
        if (fix.ok) {
            confirmed += 1;
        } else {
            failed.push({ ...slot, read: fix.read, reason: fix.reason || 'day-check-failed' });
        }
    }

    return { ok: failed.length === 0, confirmed, slotCount: slots.length, failed };
}

async function waitForForecastSaveButton(page, timeoutMs = 15000) {
    const handle = await page
        .waitForFunction(
            () => {
                for (const el of document.querySelectorAll('button, a.btn, input[type="button"], input[type="submit"], [ng-click]')) {
                    const r = el.getBoundingClientRect();
                    if (r.width <= 0 || r.height <= 0) continue;
                    const style = window.getComputedStyle(el);
                    if (style.visibility === 'hidden' || style.display === 'none') continue;
                    if (el.disabled || el.getAttribute('disabled') != null) continue;
                    const label = (el.textContent || el.value || el.getAttribute('aria-label') || el.title || '')
                        .replace(/\s+/g, ' ')
                        .trim();
                    const ngClick = el.getAttribute('ng-click') || '';
                    if (
                        /^save$/i.test(label) ||
                        /^save\b/i.test(label) ||
                        /SaveChanges\s*\(/i.test(ngClick) ||
                        /saveChanges\s*\(/i.test(ngClick)
                    ) {
                        return {
                            tag: el.tagName,
                            id: el.id || null,
                            label,
                            ngClick: ngClick || null,
                            className: (el.className || '').slice(0, 80),
                        };
                    }
                }
                return null;
            },
            { timeout: timeoutMs, polling: 200 }
        )
        .catch(() => null);
    if (!handle) return null;
    return handle.jsonValue();
}

async function listVisibleForecastActionButtons(page) {
    return page.evaluate(() => {
        const out = [];
        for (const el of document.querySelectorAll('button, a.btn, input[type="button"], input[type="submit"], a')) {
            const label = (el.textContent || el.value || el.getAttribute('aria-label') || el.title || '')
                .replace(/\s+/g, ' ')
                .trim()
                .slice(0, 80);
            const ngClick = el.getAttribute('ng-click') || '';
            if (!label && !ngClick) continue;
            const r = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            out.push({
                label,
                ngClick: ngClick.slice(0, 80),
                disabled: Boolean(el.disabled || el.getAttribute('disabled') != null),
                visible: r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none',
            });
        }
        return out.slice(0, 40);
    });
}

async function forceForecastFormDirty(page, hourly) {
    const slots = normalizeHourlySlots(hourly).filter((slot) => !slot.outsideHours);
    const slot = slots.find((row) => Math.round(Number(row.forecast) || 0) > 0) || slots[0];
    if (!slot) return false;
    // Real Puppeteer clicks mark Angular dirty; bulk DOM writes often do not.
    const result = await enterAndVerifyForecastSlot(page, slot, null, { suppressFailureProgress: true });
    await dismissForecastOverrideEditor(page).catch(() => {});
    return Boolean(result?.ok);
}

async function clickForecastSaveViaNgClick(page) {
    return page.evaluate(() => {
        const nodes = [
            ...document.querySelectorAll('[ng-click*="SaveChanges"], [ng-click*="saveChanges"], [ng-click*="save("]'),
        ];
        for (const el of nodes) {
            const r = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            if (r.width <= 0 || r.height <= 0) continue;
            if (style.visibility === 'hidden' || style.display === 'none') continue;
            if (el.disabled || el.getAttribute('disabled') != null) continue;
            el.click();
            return el.getAttribute('ng-click') || 'SaveChanges';
        }
        return null;
    });
}

async function commitForecastDaySave(page, options = {}) {
    const fast = options.fast !== false;
    const hourly = options.hourly || [];

    let savedAs = await clickForecastSave(page, {
        timeoutMs: fast ? SAVE_APPEAR_FAST_MS : SAVE_APPEAR_MS,
        saveSuccessTimeoutMs: SAVE_SUCCESS_TIMEOUT_MS,
    });
    if (savedAs) return savedAs;

    savedAs = await clickForecastSaveViaNgClick(page);
    if (savedAs) {
        await waitForForecastSaveCompleted(page, SAVE_SUCCESS_TIMEOUT_MS);
        await waitForForecastGrid(page);
        return savedAs;
    }

    // Bulk fill can update cell text without Angular dirty → Save stays hidden.
    if (hourly.length) {
        await forceForecastFormDirty(page, hourly);
    }

    savedAs = await clickForecastSave(page, {
        timeoutMs: SAVE_APPEAR_MS,
        saveSuccessTimeoutMs: SAVE_SUCCESS_TIMEOUT_MS,
    });
    if (savedAs) return savedAs;

    savedAs = await clickForecastSaveViaNgClick(page);
    if (savedAs) {
        await waitForForecastSaveCompleted(page, SAVE_SUCCESS_TIMEOUT_MS);
        await waitForForecastGrid(page);
        return savedAs;
    }

    const buttons = await listVisibleForecastActionButtons(page).catch(() => []);
    const sample = buttons
        .filter((b) => b.visible || /save/i.test(b.label) || /save/i.test(b.ngClick))
        .slice(0, 12)
        .map((b) => `${b.visible ? '' : '[hidden]'}${b.label || b.ngClick}${b.disabled ? '(disabled)' : ''}`)
        .join(' | ');
    throw new Error(
        'Macromatix Save button did not appear after forecast edits. Values were entered but not saved.' +
            (sample ? ` Visible actions: ${sample}` : '')
    );
}

async function clickForecastSave(page, { timeoutMs = SAVE_APPEAR_MS, saveSuccessTimeoutMs = SAVE_SUCCESS_TIMEOUT_MS } = {}) {
    await dismissForecastOverrideEditor(page).catch(() => {});
    const meta = await waitForForecastSaveButton(page, timeoutMs);
    if (!meta) return null;

    const clicked = await page.evaluate((want) => {
        for (const el of document.querySelectorAll('button, a.btn, input[type="button"], input[type="submit"]')) {
            const r = el.getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0) continue;
            const label = (el.textContent || el.value || el.getAttribute('aria-label') || el.title || '')
                .replace(/\s+/g, ' ')
                .trim();
            const ngClick = el.getAttribute('ng-click') || '';
            if (!/^save$/i.test(label) && !/^save\b/i.test(label) && !/SaveChanges\s*\(/i.test(ngClick)) continue;
            if (want.id && el.id !== want.id) continue;
            if (el.disabled || el.getAttribute('disabled') != null) continue;
            el.click();
            return label || ngClick || 'Save';
        }
        return null;
    }, meta);

    if (clicked) {
        await waitForForecastSaveCompleted(page, saveSuccessTimeoutMs);
        await waitForForecastGrid(page);
    }
    return clicked;
}

/**
 * Set the trading date on Forecasting/Edit via calendar day pick, keyboard, hidden input, or day arrows.
 */
async function setForecastPageDate(page, isoDate, options = {}) {
    const displayStr = isoToMmxDate(isoDate);
    if (!displayStr) throw new Error(`Invalid forecast date: ${isoDate}`);

    if (!options.skipScroll) {
        await page.evaluate(() => window.scrollTo(0, 0));
        await page
            .waitForFunction(() => window.scrollY === 0, { timeout: 1000, polling: 40 })
            .catch(() => null);
    }
    await waitForForecastGrid(page);
    const datePickerReady = await waitForForecastDatePickerReady(
        page,
        options.fast ? Math.min(GRID_WAIT_MS, 8000) : GRID_WAIT_MS
    );
    if (!datePickerReady) {
        throw new Error(
            'Forecast date picker did not load on Macromatix (page may still be initializing). Try again in a moment.'
        );
    }

    const already = await readDisplayedForecastDate(page);
    if (already === displayStr) {
        return { ok: true, method: 'already-set', date: isoDate, display: displayStr, previous: already };
    }

    const currentIso = mmxDateToIso(already);
    const diff = dayDiffIso(currentIso, isoDate);

    let result = { ok: false };
    const dateWait = options.fast ? 1500 : DATE_CHANGE_MS;
    if (Math.abs(diff) === 1) result = await setForecastPageDateByAdjacentDay(page, isoDate, dateWait);
    if (!result.ok && (diff == null || Math.abs(diff) > 1)) result = await setForecastPageDateByCalendar(page, isoDate);
    if (!result.ok) result = await setForecastPageDateByKeyboard(page, displayStr);
    if (!result.ok) result = await setForecastPageDateByHiddenInput(page, displayStr);
    if (!result.ok) result = await setForecastPageDateByDayNav(page, isoDate);

    if (!result.ok) {
        const hints = await page.evaluate(() => {
            const inputs = [...document.querySelectorAll('input')].slice(0, 12).map((inp) => ({
                id: inp.id || null,
                type: inp.type || null,
                value: (inp.value || '').trim().slice(0, 40),
            }));
            const dateTexts = [...document.querySelectorAll('span, button, a')]
                .map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim())
                .filter((t) => /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(t))
                .slice(0, 8);
            return { inputs, dateTexts };
        });
        throw new Error(
            `Forecast date control not found — the Macromatix forecast page may not have finished loading (${JSON.stringify(hints).slice(0, 400)})`
        );
    }

    const verified = await readDisplayedForecastDate(page);
    if (verified && verified !== displayStr) {
        throw new Error(`Forecast date did not stick: wanted ${displayStr}, still ${verified}`);
    }

    await waitForForecastGrid(page);
    if (options.fast) {
        await waitForForecastHourRows(page, { minRows: 1, timeoutMs: 800 });
    } else {
        await waitForForecastHourRows(page, { minRows: 1 });
    }

    return { date: isoDate, display: displayStr, ...result };
}

async function writeForecastPlanToSpa(page, storeNumber, plan, options = {}) {
    const sssg = getSssgScraper();
    const store = String(storeNumber || '').trim();
    const { getStoreList, resolveHours } = require('../../../stores/src/storeList');
    const storeRow = getStoreList().find((row) => String(row.storeNumber) === store);
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
    const emit = (payload) => {
        if (!onProgress) return;
        try {
            onProgress({ storeNumber: store, ...payload });
        } catch (_) {
            /* ignore UI progress errors */
        }
    };

    const onForecast = await page.evaluate((storeNum) => {
        const hash = (location.hash || '').toLowerCase();
        const body = document.body?.innerText || '';
        return hash.includes('forecasting/edit') && body.includes(storeNum);
    }, store);

    if (!onForecast) {
        const onChangeStore = await sssg.isOnChangeStorePage(page);
        if (!onChangeStore) {
            await page.goto(CHANGE_STORE_URL, SPA_GOTO_OPTS);
            await waitForForecastGrid(page);
        }
        await sssg.selectStoreOnSpa(page, store, { quick: true });
        await page.goto(FORECASTING_URL, SPA_GOTO_OPTS);
    }

    await waitForForecastGrid(page);
    let datePickerReady = await waitForForecastDatePickerReady(page);
    if (!datePickerReady) {
        await page.goto(FORECASTING_URL, SPA_GOTO_OPTS);
        await waitForForecastGrid(page);
        datePickerReady = await waitForForecastDatePickerReady(page);
    }
    if (!datePickerReady) {
        throw new Error(
            `Forecast date picker did not load for store ${store} on Macromatix. The page may still be initializing — try again.`
        );
    }
    await ensureManagerForecastDollarMode(page);

    emit({ type: 'store-start', dayCount: (plan || []).length });

    const dayResults = [];
    for (let dayIndex = 0; dayIndex < (plan || []).length; dayIndex += 1) {
        const day = plan[dayIndex];
        const hourly = (day.hourly || []).map((slot) => ({
            hour: slot.hour,
            forecast: slot.forecast,
        }));
        emit({
            type: 'day-start',
            date: day.date,
            weekday: day.weekday,
            forecastTotal: day.forecastTotal,
            hourly,
        });

        const dateResult = await setForecastPageDate(page, day.date, {
            skipScroll: dayIndex > 0,
            fast: dayIndex > 0,
        });
        let gridReady =
            dayIndex > 0 && dateResult.method === 'day-adjacent' && dateResult.ok
                ? await page.evaluate(() => document.querySelectorAll('tr.mx-fg-hour').length >= 8)
                : false;
        if (!gridReady) {
            gridReady = await ensureForecastGridReadyForHours(page, hourly, {
                minRows: Math.min(8, hourly.length),
                timeoutMs: dayIndex > 0 ? 3000 : GRID_WAIT_MS,
            });
        }
        if (!gridReady) {
            await setForecastPageDate(page, day.date, { skipScroll: true, fast: false });
            gridReady = await ensureForecastGridReadyForHours(page, hourly, {
                minRows: Math.min(8, hourly.length),
                timeoutMs: GRID_WAIT_MS,
            });
        }
        if (!gridReady) {
            const visible = await countForecastHourRows(page);
            const display = await readDisplayedForecastDate(page);
            throw new Error(
                `Forecast grid not ready for ${day.date} (${visible} hour rows visible, date showing ${display || 'unknown'}).`
            );
        }
        await dismissForecastOverrideEditor(page).catch(() => {});
        emit({ type: 'day-filling', date: day.date });

        if (dayIndex === 0) {
            await ensureManagerForecastDollarMode(page);
        }
        const dayHours = storeRow
            ? resolveHours(storeRow, new Date(`${day.date}T12:00:00`))
            : { openHour: day.openHour, closeHour: day.closeHour };
        const dayForFill = {
            ...day,
            openHour: dayHours.openHour ?? day.openHour,
            closeHour: dayHours.closeHour ?? day.closeHour,
        };
        const fillSlots = await buildDayFillSlots(page, day, dayForFill.openHour, dayForFill.closeHour);
        const outsideCount = fillSlots.filter((s) => s.outsideHours).length;
        if (outsideCount) {
            emit({
                type: 'day-outside-hours',
                date: day.date,
                outsideCount,
                openHour: dayForFill.openHour,
                closeHour: dayForFill.closeHour,
            });
        }
        const slotProgress = (evt) => emit({ date: day.date, ...evt });
        let fillResult;
        let verifySlots = fillSlots;
        try {
            fillResult = await fillForecastHourlyInputs(page, fillSlots, {
                skipDollarMode: true,
                onProgress: slotProgress,
                storeNumber: store,
            });
        } catch (fillErr) {
            emit({ type: 'day-fill-retry', date: day.date, error: fillErr.message });
            await setForecastPageDate(page, day.date, { skipScroll: true, fast: false });
            await ensureForecastGridReadyForHours(page, hourly, {
                minRows: Math.min(8, hourly.length),
                timeoutMs: GRID_WAIT_MS,
            });
            await dismissForecastOverrideEditor(page).catch(() => {});
            verifySlots = await buildDayFillSlots(page, day, dayForFill.openHour, dayForFill.closeHour);
            fillResult = await fillForecastHourlyInputs(page, verifySlots, {
                skipDollarMode: true,
                onProgress: slotProgress,
                storeNumber: store,
            });
        }

        emit({ type: 'day-verifying', date: day.date });
        let verifyResult = await verifyForecastDay(page, verifySlots, {
            onProgress: slotProgress,
            cellCache: fillResult?.cellCache,
        });
        if (!verifyResult.ok) {
            const tradingFailed = verifyResult.failed.filter((row) => !row.outsideHours);
            if (tradingFailed.length) {
                await dismissForecastOverrideEditor(page).catch(() => {});
                verifySlots = await realignSlotsFromGrid(page, verifySlots);
                for (const slot of tradingFailed) {
                    const aligned = verifySlots.find((row) => row.hour === slot.hour);
                    const fix = await retryForecastSlotRedundant(
                        page,
                        aligned || slot,
                        slotProgress,
                        fillResult?.cellCache || null
                    );
                    if (fix.ok) verifyResult.confirmed += 1;
                }
                verifyResult = await verifyForecastDay(page, verifySlots, {
                    onProgress: slotProgress,
                    cellCache: fillResult?.cellCache,
                });
            }
        }
        if (!verifyResult.ok) {
            const tradingFailed = verifyResult.failed.filter((row) => !row.outsideHours);
            const labels = tradingFailed.map((row) => row.label).join(', ');
            if (tradingFailed.length) {
                throw new Error(
                    `Forecast verify failed for ${day.date} (${verifyResult.confirmed}/${verifyResult.slotCount} hours confirmed). Failed: ${labels || 'unknown'}`
                );
            }
        }

        emit({ type: 'day-saving', date: day.date, fill: fillResult, verify: verifyResult });

        const savedAs = fillResult.changed
            ? await commitForecastDaySave(page, { fast: true, hourly: verifySlots })
            : 'unchanged';

        const dayResult = {
            date: day.date,
            forecastTotal: day.forecastTotal,
            dateSet: dateResult,
            fill: fillResult,
            verify: verifyResult,
            savedAs,
        };
        dayResults.push(dayResult);
        emit({ type: 'day-done', date: day.date, ...dayResult });
    }

    const hourTouched = dayResults.reduce((sum, d) => sum + (d.verify?.confirmed || d.fill?.confirmed || 0), 0);
    const slotCount = dayResults.reduce((sum, d) => sum + (d.verify?.slotCount || d.fill?.slotCount || 0), 0);
    if (!hourTouched) {
        throw new Error('Could not write any forecast values in Macromatix.');
    }

    const applied = {
        ok: true,
        hourTouched,
        hourVerified: hourTouched,
        slotCount,
        dayTouched: dayResults.length,
        days: dayResults,
    };
    emit({ type: 'store-done', ...applied });
    return applied;
}

async function writeForecastPlanToMmx(storeNumber, plan, options = {}) {
    const scraper = getMacromatixScraper();
    const sssg = getSssgScraper();
    const store = String(storeNumber || '').trim();
    if (!store) throw new Error('Store number is required.');

    const credentials = scraper.resolveMacromatixCredentialsForStore(store);
    if (!credentials?.username || !credentials?.password) {
        throw new Error(`No Macromatix credentials configured for store ${store}.`);
    }

    let browser;
    const headless = resolveForecastHeadless(options);
    try {
        const opened = await scraper.openMacromatixBrowser({
            storeNumber: store,
            mmxUsername: credentials.username,
            mmxPassword: credentials.password,
            browserOptions: { headless, skipSlowMo: headless },
        });
        browser = opened.browser;
        const { page } = opened;

        try {
            const forecastAbort = require('../../../dashboard/src/forecastMmxAbort');
            forecastAbort.resetForecastMmxAbort();
            forecastAbort.registerForecastMmxBrowser(browser);
        } catch {
            /* forecast abort optional outside dashboard process */
        }

        if (!headless) {
            console.log('[Forecast] Headed browser - watch the Macromatix window (FORECAST_SCRAPER_HEADLESS=false)');
        }

        await sssg.ensureSpaAuthenticated(page, credentials, { quick: headless });
        const applied = await writeForecastPlanToSpa(page, store, plan, {
            onProgress: options.onProgress,
        });

        return {
            storeNumber: store,
            forecastDays: plan.length,
            mmx: applied,
        };
    } finally {
        try {
            const forecastAbort = require('../../../dashboard/src/forecastMmxAbort');
            forecastAbort.clearForecastMmxBrowser(browser);
        } catch {
            /* ignore */
        }
        if (!headless && options.keepBrowserOpen) {
            console.log('[Forecast] Headed mode - browser left open (keepBrowserOpen)');
        } else {
            await scraper.closeBrowserQuietly(browser, 'forecast tool');
        }
    }
}

/** Optional MMX backfill for missing history days (slow - use import when possible). */
async function backfillStoreHistoryFromMmx(storeNumber, options = {}) {
    const { upsertDay } = require('../../../forecast/src/historyStore');
    const { addDaysIso, melbourneToday } = require('../../../forecast/src/planEngine');
    let recordForecastHistoryDay = null;
    let sumHourlyLedger = null;
    try {
        const ledger = require('../../../dashboard/src/forecast/forecastHistoryLedger');
        recordForecastHistoryDay = ledger.recordForecastHistoryDay;
        sumHourlyLedger = ledger.sumHourly;
    } catch {
        /* ledger optional */
    }
    const sumHourly = (values) =>
        typeof sumHourlyLedger === 'function'
            ? sumHourlyLedger(values)
            : (Array.isArray(values) ? values : []).reduce((s, v) => s + (Number(v) || 0), 0);

    const LABOUR_URL =
        'https://tacobellau.macromatix.net/MMS_Stores_LabourScheduler.aspx?MenuCustomItemID=249';
    const scraper = getMacromatixScraper();
    const store = String(storeNumber || '').trim();
    // Accept days or daysBack; default 5 weeks
    const daysBack = Math.max(7, Number(options.daysBack || options.days || 35) || 35);
    const credentials = scraper.resolveMacromatixCredentialsForStore(store);
    if (!credentials?.username || !credentials?.password) {
        throw new Error(
            `No Macromatix credentials for store ${store}. Set MMX login in Account (Ash/Tom).`
        );
    }

    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
    const logs = [];
    const pushLog = (message) => {
        const line = String(message || '').trim();
        if (!line) return;
        logs.push(line);
        console.log(`[Forecast backfill ${store}] ${line}`);
        onProgress?.({ storeNumber: store, message: line });
    };

    let browser;
    let imported = 0;
    let skippedEmpty = 0;
    const days = [];
    try {
        pushLog(`Store ${store}: starting MMX backfill for last ${daysBack} days (5 weeks).`);
        pushLog(`Store ${store}: launching headless Chromium + logging into Macromatix as ${credentials.username}...`);
        const opened = await scraper.openMacromatixBrowser({
            storeNumber: store,
            mmxUsername: credentials.username,
            mmxPassword: credentials.password,
            launchOptions: { headless: true },
        });
        browser = opened.browser;
        const { page } = opened;
        pushLog(`Store ${store}: opening labour scheduler page...`);
        await page.goto(LABOUR_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
        pushLog(`Store ${store}: selecting store on labour page...`);
        await scraper.selectStoreOnPage(page, store, { waitMs: 900 });
        pushLog(`Store ${store}: store ${store} selected.`);

        const today = melbourneToday();
        const missingDates = [];
        for (let offset = 1; offset <= daysBack; offset += 1) {
            missingDates.push(addDaysIso(today, -offset));
        }
        const newest = missingDates[0];
        const oldest = missingDates[missingDates.length - 1];
        pushLog(
            `Store ${store}: will scrape ${missingDates.length} calendar day(s) (${oldest} -> ${newest}, excluding today ${today}).`
        );
        const scraped = await scraper.scrapeMissingHistoricalDays(page, missingDates, {
            timeZone: process.env.DASHBOARD_TIME_ZONE || 'Australia/Melbourne',
            onProgress: (ev) => {
                if (ev?.message) pushLog(ev.message);
            },
        });
        pushLog(`Store ${store}: scrape finished (${scraped.length} day response(s)). Saving history...`);
        for (const data of scraped) {
            const iso = data.dateIso;
            if (!iso) continue;
            const actualRaw = data.actual || [];
            const total = sumHourly(actualRaw);
            if (total <= 0) {
                skippedEmpty += 1;
                continue;
            }
            const hoursWithSales = actualRaw.filter((v) => Number(v) > 0).length;
            upsertDay(store, iso, actualRaw, { source: 'mmx-backfill' });
            if (typeof recordForecastHistoryDay === 'function') {
                try {
                    recordForecastHistoryDay(
                        store,
                        iso,
                        {
                            actualRaw,
                            actualFormat: 'raw-mmx',
                            openHour: options.openHour,
                            closeHour: options.closeHour,
                        },
                        { source: 'mmx-backfill', finalized: true, force: Boolean(options.force) }
                    );
                } catch (ledgerErr) {
                    pushLog(
                        `Store ${store}: warning - ledger write failed for ${iso}: ${ledgerErr.message || ledgerErr}`
                    );
                }
            }
            days.push({ dateKey: iso, actual: actualRaw, total });
            imported += 1;
            pushLog(
                `Store ${store}: saved ${iso} ($${Math.round(total * 100) / 100}, ${hoursWithSales} active hour(s)).`
            );
        }
        pushLog(
            `Store ${store}: done - imported ${imported} day(s) with sales, skipped ${skippedEmpty} empty/closed day(s).`
        );
        return { ok: true, storeNumber: store, imported, skippedEmpty, days, logs, daysBack };
    } catch (err) {
        pushLog(`Store ${store}: ERROR - ${err.message || String(err)}`);
        return {
            ok: false,
            storeNumber: store,
            imported,
            skippedEmpty,
            days,
            logs,
            daysBack,
            error: err.message || String(err),
        };
    } finally {
        pushLog(`Store ${store}: closing MMX browser...`);
        await scraper.closeBrowserQuietly(browser, 'forecast backfill');
    }
}

module.exports = {
    CHANGE_STORE_URL,
    FORECASTING_URL,
    isoToMmxDate,
    mmxDateToIso,
    formatHourLabel,
    waitForForecastGrid,
    readDisplayedForecastDate,
    clickForecastDayNav,
    setForecastPageDateByCalendar,
    setForecastPageDate,
    fillForecastHourlyInputs,
    clickForecastSave,
    writeForecastPlanToSpa,
    writeForecastPlanToMmx,
    backfillStoreHistoryFromMmx,
};
