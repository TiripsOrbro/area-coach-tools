/**
 * Telerik RadDatePicker on Macromatix report pages.
 * Typing the visible box alone does not commit - use calendar UI + hidden field sync (same as dashboard scraper).
 */
const log = require('./util-logging');

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

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function parseRadCalendarTitle(title) {
    const m = String(title || '').match(
        /(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})/i
    );
    if (!m) return null;
    const idx = MONTH_LONG_EN.findIndex((x) => x.toLowerCase() === m[1].toLowerCase());
    if (idx < 0) return null;
    return { monthIndex: idx, year: parseInt(m[2], 10) };
}

function parseMacromatixDateTime(str) {
    const m = String(str || '').match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})/);
    if (!m) return null;
    const day = parseInt(m[1], 10);
    const monIdx = MONTH_SHORT.findIndex((x) => x.toLowerCase() === m[2].toLowerCase());
    if (monIdx < 0) return null;
    return { year: parseInt(m[3], 10), month: monIdx + 1, day };
}

async function findStartDatePickerMeta(page) {
    return page.evaluate(() => {
        const all = Array.from(document.querySelectorAll('[id$="_DatePicker_dateInput"]'));
        let inp = null;
        for (const el of all) {
            const ctx = ((el.closest('tr, td, div, table') || el).innerText || '').toLowerCase();
            if (ctx.includes('start date')) {
                inp = el;
                break;
            }
        }
        if (!inp) {
            for (const el of all) {
                const ctx = ((el.closest('tr, td, div, table') || el).innerText || '').toLowerCase();
                if (!ctx.includes('end date')) {
                    inp = el;
                    break;
                }
            }
        }
        if (!inp) inp = all[0] || null;
        if (!inp || !inp.id) return null;
        return {
            dateInputId: inp.id,
            baseId: inp.id.replace(/_dateInput$/i, ''),
            currentValue: (inp.value || '').trim(),
        };
    });
}

async function clickCalendarTrigger(page, dateInputId) {
    return page.evaluate((id) => {
        const inp = document.getElementById(id);
        if (!inp) return false;
        const wrapper = inp.closest('[id$="_DatePicker_wrapper"]');
        if (!wrapper) return false;
        const selectors = [
            'a.rcCalPopup',
            'a[class*="CalPopup"]',
            '.rcCalPopup',
            'input.rcCalPopup',
        ];
        for (const sel of selectors) {
            const el = wrapper.querySelector(sel);
            if (el) {
                el.click();
                return true;
            }
        }
        return false;
    }, dateInputId);
}

async function pickDateViaRadCalendarUI(page, year, monthIndex, day, dateInputId) {
    const opened = await clickCalendarTrigger(page, dateInputId);
    if (!opened) {
        log.warn('RadCalendar trigger not found for Start Date');
        return false;
    }

    await page.waitForTimeout(280);
    await page
        .waitForSelector('div.RadCalendarPopup table.RadCalendar, body > table.RadCalendar', {
            visible: true,
            timeout: 12000,
        })
        .catch(() => null);
    await page.waitForTimeout(120);

    const titleSel = 'div.RadCalendarPopup .rcTitle, div.RadCalendarPopup td.rcTitle, table.RadCalendar .rcTitle';
    const nextSel =
        'div.RadCalendarPopup a.rcFastNext, div.RadCalendarPopup a.rcNext, table.RadCalendar a.rcFastNext, table.RadCalendar a.rcNext';
    const prevSel =
        'div.RadCalendarPopup a.rcFastPrev, div.RadCalendarPopup a.rcPrev, table.RadCalendar a.rcFastPrev, table.RadCalendar a.rcPrev';

    for (let step = 0; step < 30; step++) {
        const curTitle = await page
            .evaluate((sel) => {
                const el = document.querySelector(sel);
                return el ? el.textContent.trim() : '';
            }, titleSel)
            .catch(() => '');
        const parsed = parseRadCalendarTitle(curTitle);
        if (parsed && parsed.year === year && parsed.monthIndex === monthIndex) break;
        if (!parsed) break;
        const targetKey = year * 12 + monthIndex;
        const curKey = parsed.year * 12 + parsed.monthIndex;
        const navSel = curKey < targetKey ? nextSel : prevSel;
        const nav = await page.$(navSel);
        if (!nav) break;
        await nav.click();
        await page.waitForTimeout(220);
    }

    const picked = await page.evaluate((dayNum) => {
        const root = document.querySelector('div.RadCalendarPopup') || document.body;
        const cal = root.querySelector('table.RadCalendar');
        if (!cal) return false;
        const want = String(dayNum);
        for (const td of cal.querySelectorAll('td')) {
            if (td.classList.contains('rcOtherMonth')) continue;
            const a = td.querySelector(':scope > a');
            if (a && a.textContent.trim() === want) {
                a.click();
                return true;
            }
        }
        return false;
    }, day);

    if (!picked) {
        log.warn(`RadCalendar: could not click day ${day} for ${MONTH_LONG_EN[monthIndex]} ${year}`);
        await page.keyboard.press('Escape').catch(() => {});
        return false;
    }

    await Promise.race([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {}),
        page.waitForTimeout(1200),
    ]);
    await page.waitForFunction(() => document.readyState === 'complete', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(200);
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(80);
    return true;
}

async function triggerDoPostBackSloppy(page, eventTarget) {
    if (typeof eventTarget !== 'string' || !eventTarget) return;
    await page.evaluate((t) => {
        const s = document.createElement('script');
        s.textContent = '__doPostBack(' + JSON.stringify(t) + ', "");';
        const root = document.body || document.documentElement;
        root.appendChild(s);
        s.remove();
    }, eventTarget);
}

async function telerikApplyYmdFields(page, yyyy, month1, dayNum, dateInputId, { withTime = true } = {}) {
    const monthIndex = month1 - 1;
    const dd = String(dayNum).padStart(2, '0');
    const displayStr = withTime
        ? `${dd}-${MONTH_SHORT[monthIndex]}-${yyyy} 00:00:00`
        : `${dd}-${MONTH_SHORT[monthIndex]}-${yyyy}`;
    const pad = (n) => String(n).padStart(2, '0');
    const valueAsString = `${yyyy}-${pad(month1)}-${pad(dayNum)}-00-00-00`;

    return page.evaluate(
        ({ displayStr, valueAsString, y, m1, day, inputId }) => {
            const dateInput = document.getElementById(inputId);
            if (!dateInput) return { ok: false };

            const baseId = dateInput.id.replace(/_dateInput$/i, '');
            const hiddenMain = document.getElementById(baseId);
            const diClient = document.getElementById(`${baseId}_dateInput_ClientState`);
            const calSd = document.getElementById(`${baseId}_calendar_SD`);

            try {
                if (typeof $find === 'function') {
                    const picker = $find(baseId);
                    if (picker && typeof picker.set_selectedDate === 'function') {
                        picker.set_selectedDate(new Date(y, m1 - 1, day));
                    }
                }
            } catch (e) {
                /* ignore */
            }

            dateInput.removeAttribute('readonly');
            dateInput.removeAttribute('disabled');
            dateInput.value = displayStr;
            dateInput.dispatchEvent(new Event('input', { bubbles: true }));
            dateInput.dispatchEvent(new Event('change', { bubbles: true }));
            dateInput.dispatchEvent(new Event('blur', { bubbles: true }));

            if (hiddenMain) hiddenMain.value = valueAsString;
            if (diClient) {
                let o = {};
                try {
                    o = JSON.parse(diClient.value || '{}');
                } catch (e) {
                    o = {};
                }
                o.enabled = true;
                o.validationText = valueAsString;
                o.valueAsString = valueAsString;
                o.lastSetTextBoxValue = displayStr;
                if (!o.minDateStr) o.minDateStr = '1753-01-01-00-00-00';
                if (!o.maxDateStr) o.maxDateStr = '3000-12-31-00-00-00';
                diClient.value = JSON.stringify(o);
            }
            if (calSd) calSd.value = `[[${y},${m1},${day}]]`;

            return { ok: true, postBackTarget: dateInput.id.replace(/_/g, '$'), displayStr };
        },
        { displayStr, valueAsString, y: yyyy, m1: month1, day: dayNum, inputId: dateInputId }
    );
}

async function commitDateUi(page, dateInputId) {
    const hasInput = await page.evaluate((id) => {
        const inp = document.getElementById(id);
        if (!inp) return false;
        inp.focus();
        inp.click();
        return true;
    }, dateInputId);
    if (!hasInput) return;
    await page.waitForTimeout(180);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(250);

    const form = await page.$('form#aspnetForm, form[name="aspnetForm"]');
    if (form) {
        const box = await form.boundingBox();
        if (box && box.width > 0 && box.height > 0) {
            await page.mouse.click(
                Math.min(box.x + Math.max(24, box.width * 0.08), box.x + box.width - 2),
                Math.min(box.y + Math.max(32, box.height * 0.06), box.y + box.height - 2)
            );
        }
    } else {
        await page.mouse.click(100, 140);
    }
    await page.waitForTimeout(220);
}

function fieldLabel(which) {
    if (which === 'end') return 'end date';
    if (which === 'list') return 'date';
    return 'start date';
}

async function findPlainDateInputMeta(page, which = 'start') {
    const label = fieldLabel(which);
    return page.evaluate((wantLabel, isEnd) => {
        const inputs = Array.from(document.querySelectorAll('input[type="text"], input:not([type])'));
        const pick = (input) => ({
            dateInputId: input.id || null,
            currentValue: (input.value || '').trim(),
        });
        for (const input of inputs) {
            const ctx = ((input.closest('tr, td, div, table') || input.parentElement)?.innerText || '').toLowerCase();
            if (ctx.includes(wantLabel)) return pick(input);
        }
        if (isEnd) {
            for (const input of inputs) {
                const ctx = ((input.closest('tr, td, div, table') || input.parentElement)?.innerText || '').toLowerCase();
                if (ctx.includes('end date')) return pick(input);
            }
        } else if (wantLabel === 'date') {
            for (const input of inputs) {
                const ctx = ((input.closest('tr, td, div, table') || input.parentElement)?.innerText || '').toLowerCase();
                if (
                    ctx.includes('date') &&
                    !ctx.includes('delivery') &&
                    !ctx.includes('cut off') &&
                    !ctx.includes('end date')
                ) {
                    return pick(input);
                }
            }
        } else {
            for (const input of inputs) {
                const v = (input.value || '').trim();
                const ctx = ((input.closest('tr, td, div, table') || input.parentElement)?.innerText || '').toLowerCase();
                if (/\d{1,2}-[A-Za-z]{3}-\d{4}/.test(v) && ctx.includes('date') && !ctx.includes('end date')) {
                    return pick(input);
                }
            }
        }
        return null;
    }, label, which === 'end');
}

async function readStartDateValue(page, dateInputId) {
    if (dateInputId) {
        return page.evaluate((id) => {
            const inp = document.getElementById(id);
            return inp ? (inp.value || '').trim() : null;
        }, dateInputId);
    }
    const meta = (await findStartDatePickerMeta(page)) || (await findPlainDateInputMeta(page, 'start'));
    if (!meta?.dateInputId) return null;
    return readStartDateValue(page, meta.dateInputId);
}

async function readPlainDateValue(page, which = 'start') {
    const meta = await findPlainDateInputMeta(page, which);
    if (!meta) return null;
    if (meta.dateInputId) {
        return page.evaluate((id) => {
            const inp = document.getElementById(id);
            return inp ? (inp.value || '').trim() : null;
        }, meta.dateInputId);
    }
    return meta.currentValue;
}

async function setPlainDateViaKeyboard(page, dateText, which = 'start') {
    const label = fieldLabel(which);
    const handle = await page.evaluateHandle((wantLabel, isEnd) => {
        const inputs = Array.from(document.querySelectorAll('input[type="text"], input:not([type])'));
        for (const input of inputs) {
            const ctx = ((input.closest('tr, td, div, table') || input.parentElement)?.innerText || '').toLowerCase();
            if (ctx.includes(wantLabel)) return input;
        }
        if (isEnd) {
            for (const input of inputs) {
                const ctx = ((input.closest('tr, td, div, table') || input.parentElement)?.innerText || '').toLowerCase();
                if (ctx.includes('end date')) return input;
            }
        } else {
            for (const input of inputs) {
                const v = (input.value || '').trim();
                const ctx = ((input.closest('tr, td, div, table') || input.parentElement)?.innerText || '').toLowerCase();
                if (/\d{1,2}-[A-Za-z]{3}-\d{4}/.test(v) && ctx.includes('date') && !ctx.includes('end date')) {
                    return input;
                }
            }
        }
        return null;
    }, label, which === 'end');

    const el = handle.asElement();
    if (!el) throw new Error(`${which === 'end' ? 'End' : 'Start'} Date text input not found on report page`);

    const before = await el.evaluate((node) => (node.value || '').trim());
    log.info(`${which === 'end' ? 'End' : 'Start'} date (plain input) was: "${before || '(empty)'}" → typing ${dateText}`);

    await el.click({ clickCount: 3 });
    await page.waitForTimeout(120);
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyA');
    await page.keyboard.up('Control');
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(80);
    await page.keyboard.type(dateText, { delay: 25 });
    await page.waitForTimeout(150);
    await page.keyboard.press('Tab');
    await page.waitForTimeout(200);
    await waitForReportPageAfterDateChange(page);

    const after = await el.evaluate((node) => (node.value || '').trim());
    return after;
}

function normalizeDateKey(str) {
    const display = parseMacromatixDateTime(str);
    if (display) {
        const pad = (n) => String(n).padStart(2, '0');
        return `${display.year}-${pad(display.month)}-${pad(display.day)}`;
    }
    const hidden = String(str || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (hidden) return `${hidden[1]}-${hidden[2]}-${hidden[3]}`;
    return null;
}

function dateValueMatches(expected, actual) {
    const ek = normalizeDateKey(expected);
    const ak = normalizeDateKey(actual);
    if (ek && ak) return ek === ak;
    return String(actual || '').toLowerCase().includes(String(expected).slice(0, 11).toLowerCase());
}

async function findEndDatePickerMeta(page) {
    return page.evaluate(() => {
        const all = Array.from(document.querySelectorAll('[id$="_DatePicker_dateInput"]'));
        for (const el of all) {
            const ctx = ((el.closest('tr, td, div, table') || el).innerText || '').toLowerCase();
            if (ctx.includes('end date')) {
                return {
                    dateInputId: el.id,
                    baseId: el.id.replace(/_dateInput$/i, ''),
                    currentValue: (el.value || '').trim(),
                };
            }
        }
        if (all.length >= 2) {
            const el = all[1];
            return {
                dateInputId: el.id,
                baseId: el.id.replace(/_dateInput$/i, ''),
                currentValue: (el.value || '').trim(),
            };
        }
        return null;
    });
}

async function waitForReportPageAfterDateChange(page) {
    const timeoutMs = Number(process.env.MMX_REPORT_DATE_POSTBACK_MS || 6000);
    const started = Date.now();
    await Promise.race([
        page
            .waitForResponse(
                (res) => /macromatix/i.test(res.url() || '') && res.status() < 400,
                { timeout: timeoutMs }
            )
            .catch(() => null),
        page
            .waitForFunction(
                () =>
                    Boolean(document.querySelector('.RadTreeView .rtMid, .RadTreeView .rtPlus')) ||
                    document.readyState === 'complete',
                { timeout: timeoutMs, polling: 80 }
            )
            .catch(() => null),
    ]);
    const settleMs = Number(process.env.MMX_REPORT_DATE_SETTLE_MS || 500);
    const elapsed = Date.now() - started;
    if (elapsed < settleMs) {
        await page.waitForTimeout(settleMs - elapsed);
    }
}

async function waitForDateFieldSettle(page) {
    await page.waitForFunction(() => document.readyState === 'complete', { timeout: 8000 }).catch(() => {});
    const settleMs = Number(process.env.MMX_REPORT_DATE_SETTLE_MS || 500);
    await page.waitForTimeout(settleMs);
}

async function readDateValueWithRetry(page, which, dateInputId) {
    let lastErr = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            return await readStartDateValue(page, dateInputId);
        } catch (err) {
            lastErr = err;
            const msg = String(err && err.message ? err.message : err);
            if (!/Execution context was destroyed|most likely because of a navigation|Target closed|Protocol error/i.test(msg)) {
                throw err;
            }
            await waitForDateFieldSettle(page);
        }
    }
    if (lastErr) throw lastErr;
    return await readPlainDateValue(page, which);
}

/**
 * Set report Start or End date (RadDatePicker when present, else keyboard typing).
 * @param {import('puppeteer').Page} page
 * @param {string} dateText
 * @param {'start'|'end'} [which]
 */
async function setReportDateField(page, dateText, which = 'start') {
    const parts = parseMacromatixDateTime(dateText);
    if (!parts) throw new Error(`Invalid Macromatix date: "${dateText}"`);

    const labelNeedle = fieldLabel(which);

    await page
        .waitForFunction(
            (needle) => {
                const t = (document.body.innerText || '').toLowerCase();
                if (t.includes(needle)) return true;
                if (needle === 'date' && /\bdate\b/.test(t)) return true;
                return !!document.querySelector('[id$="_DatePicker_dateInput"]');
            },
            { timeout: 20000 },
            labelNeedle
        )
        .catch(() => null);
    await page.waitForTimeout(500);

    const radMeta = which === 'end' ? await findEndDatePickerMeta(page) : await findStartDatePickerMeta(page);
    const fieldName = which === 'end' ? 'End' : which === 'list' ? 'List' : 'Start';

    if (radMeta?.currentValue && dateValueMatches(dateText, radMeta.currentValue)) {
        log.info(`${fieldName} date already set: ${radMeta.currentValue}`);
        return radMeta.currentValue;
    }

    const plainBefore = await readPlainDateValue(page, which);
    if (!radMeta && plainBefore && dateValueMatches(dateText, plainBefore)) {
        log.info(`${fieldName} date already set: ${plainBefore}`);
        return plainBefore;
    }

    if (radMeta) {
        log.info(`${fieldName} date was: "${radMeta.currentValue || '(empty)'}" → setting ${dateText} (RadDatePicker)`);

        const picked = await pickDateViaRadCalendarUI(page, parts.year, parts.month - 1, parts.day, radMeta.dateInputId);
        if (picked) {
            await page.waitForFunction(() => document.readyState === 'complete', { timeout: 25000 }).catch(() => {});
            await page.waitForTimeout(800);
            try {
                const freshMeta = which === 'end' ? await findEndDatePickerMeta(page) : await findStartDatePickerMeta(page);
                if (freshMeta) await commitDateUi(page, freshMeta.dateInputId);
            } catch (e) {
                log.warn('commitDateUi after RadCalendar:', e.message);
            }
        } else {
            const withTime = /\d{1,2}:\d{2}:\d{2}/.test(dateText);
            const applied = await telerikApplyYmdFields(page, parts.year, parts.month, parts.day, radMeta.dateInputId, {
                withTime,
            });
            if (!applied.ok) throw new Error(`Could not sync Telerik ${fieldName} Date fields`);
            await page.waitForTimeout(250);
            await commitDateUi(page, radMeta.dateInputId);
            if (applied.postBackTarget) {
                try {
                    const nav = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 12000 }).catch(() => {});
                    await triggerDoPostBackSloppy(page, applied.postBackTarget);
                    await Promise.race([nav, page.waitForTimeout(5000)]);
                    await page.waitForFunction(() => document.readyState === 'complete', { timeout: 12000 }).catch(() => {});
                } catch (e) {
                    log.warn(`${fieldName} date postback:`, e.message);
                }
            }
        }

        await waitForReportPageAfterDateChange(page);
        const actual = await readDateValueWithRetry(page, which, radMeta.dateInputId);
        if (!dateValueMatches(dateText, actual)) {
            throw new Error(`${fieldName} Date did not stick: expected "${dateText}", still "${actual || '(empty)'}"`);
        }
        log.info(`${fieldName} date set to: ${actual}`);
        return actual;
    }

    const actual = await setPlainDateViaKeyboard(page, dateText, which);
    if (!dateValueMatches(dateText, actual)) {
        throw new Error(`${fieldName} Date did not stick: expected "${dateText}", still "${actual || '(empty)'}"`);
    }
    log.info(`${fieldName} date set to: ${actual}`);
    return actual;
}

async function setReportStartDate(page, dateText) {
    return setReportDateField(page, dateText, 'start');
}

async function setReportEndDate(page, dateText) {
    return setReportDateField(page, dateText, 'end');
}

/** Scheduled orders list page - top “Date” field (not Start Date). */
async function setReportListDate(page, dateText) {
    return setReportDateField(page, dateText, 'list');
}

module.exports = {
    setReportStartDate,
    setReportEndDate,
    setReportListDate,
    setReportDateField,
    parseMacromatixDateTime,
    findStartDatePickerMeta,
    waitForDateFieldSettle,
    waitForReportPageAfterDateChange,
};
