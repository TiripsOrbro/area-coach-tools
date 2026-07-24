const log = require('./util-logging');

const COUNT_IN_PROGRESS_TAB = 'Count In Progress';

/** Click the first visible element whose trimmed text matches (case-insensitive). */
async function clickByExactText(page, text, options = {}) {
    const want = String(text).trim().toLowerCase();
    const clicked = await page.evaluate((label, partial) => {
        for (const el of document.querySelectorAll('a, button, span, li, div, label, td')) {
            const t = (el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
            if (!t) continue;
            const match = partial ? t.includes(label) : t === label;
            if (!match) continue;
            const r = el.getBoundingClientRect();
            if (r.width < 2 || r.height < 2) continue;
            el.click();
            return true;
        }
        return false;
    }, want, Boolean(options.partial));

    if (!clicked) {
        throw new Error(`Could not find clickable element with text "${text}"`);
    }
    await page.waitForTimeout(options.settleMs ?? 800);
}

async function isOnNewCountTab(page) {
    return page.evaluate(() => {
        const text = (document.body.innerText || '').replace(/\s+/g, ' ');
        return /create new count/i.test(text);
    });
}

async function isOnCountInProgressTab(page) {
    return page.evaluate((tabLabel) => {
        const body = (document.body.innerText || '').replace(/\s+/g, ' ');
        if (/create new count/i.test(body)) return false;

        const label = tabLabel.toLowerCase();
        for (const el of document.querySelectorAll('.rtsLink, .rtsTxt, li.rtsLI, a.rtsLink')) {
            const t = (el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
            if (!t.includes(label)) continue;
            const host = el.closest('li.rtsLI') || el;
            const cls = `${host.className} ${el.className}`;
            if (/rtsSelected|rtsSelectedTab|selected/i.test(cls)) return true;
        }

        return false;
    }, COUNT_IN_PROGRESS_TAB);
}

/** Stock Count lands on New Count — must open Count In Progress before reading counts. */
async function openCountInProgressTab(page) {
    if (await isOnCountInProgressTab(page)) {
        log.info('Already on Count In Progress tab');
        return;
    }

    log.info('Switching from New Count → Count In Progress tab…');

    const clicked = await page.evaluate((tabLabel) => {
        const want = tabLabel.toLowerCase();
        for (const el of document.querySelectorAll('.rtsLink, .rtsTxt, a.rtsLink')) {
            const t = (el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
            if (t === want) {
                el.click();
                return true;
            }
        }
        for (const li of document.querySelectorAll('li.rtsLI')) {
            const t = (li.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
            if (t.includes(want)) {
                const link = li.querySelector('.rtsLink, a, span');
                (link || li).click();
                return true;
            }
        }
        return false;
    }, COUNT_IN_PROGRESS_TAB);

    if (!clicked) {
        await clickByExactText(page, COUNT_IN_PROGRESS_TAB, { partial: false, settleMs: 400 });
    }

    await page.waitForTimeout(1500);

    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
        if (await isOnCountInProgressTab(page)) {
            log.info('Count In Progress tab active');
            return;
        }
        await page.waitForTimeout(400);
    }

    const onNew = await isOnNewCountTab(page);
    throw new Error(
        onNew
            ? 'Still on New Count tab — Count In Progress tab did not activate'
            : 'Could not confirm Count In Progress tab is active'
    );
}

/** Open the in-progress count dropdown (not Count Type / When on New Count). */
async function openInProgressCountDropdown(page) {
    const opened = await page.evaluate(() => {
        const selects = Array.from(document.querySelectorAll('select'));
        for (const sel of selects) {
            const ctx = ((sel.closest('tr, div, table') || sel).innerText || '').toLowerCase();
            if (/count type|when:|apply date|create new count/i.test(ctx)) continue;
            const opts = Array.from(sel.options).map((o) => (o.textContent || '').trim());
            if (!opts.some((o) => /\d{1,2}-[A-Za-z]{3}-\d{4}/.test(o))) continue;
            sel.focus();
            sel.click();
            return true;
        }
        const arrow = document.querySelector('.rcbArrowCell a, .rcbArrowCell');
        if (arrow) {
            arrow.click();
            return true;
        }
        return false;
    });
    if (!opened) {
        await openLatestCountDropdownLegacy(page);
    }
    await page.waitForTimeout(600);
}

async function openLatestCountDropdownLegacy(page) {
    await page.evaluate(() => {
        const arrow = document.querySelector(
            '.rcbArrowCell a, .rcbArrowCell, [class*="ComboBox"] .arrow, .dropdown-toggle'
        );
        if (arrow) arrow.click();
    });
}

/**
 * Read the newest in-progress count from the Count In Progress tab only.
 */
async function readLatestCountEntry(page) {
    await openCountInProgressTab(page);
    await openInProgressCountDropdown(page);

    const entry = await page.evaluate(() => {
        const selects = Array.from(document.querySelectorAll('select'));
        for (const sel of selects) {
            const ctx = ((sel.closest('tr, div, table') || sel).innerText || '').toLowerCase();
            if (/count type|when:|apply date|create new count/i.test(ctx)) continue;

            const opts = Array.from(sel.options)
                .map((o) => (o.textContent || '').replace(/\s+/g, ' ').trim())
                .filter((t) => t && !/^choose|^select/i.test(t));

            if (opts.length && opts.some((o) => /\d{1,2}-[A-Za-z]{3}-\d{4}|\d{1,2}:\d{2}:\d{2}/.test(o))) {
                return { source: 'select', latest: opts[0], options: opts.slice(0, 12) };
            }
        }

        const listItems = Array.from(
            document.querySelectorAll('.rcbList li, .rcbItem, [role="listbox"] [role="option"]')
        )
            .map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim())
            .filter((t) => t && /\d{1,2}-[A-Za-z]{3}-\d{4}|\d{1,2}:\d{2}:\d{2}/.test(t));

        if (listItems.length) {
            return { source: 'list', latest: listItems[0], options: listItems.slice(0, 12) };
        }

        return null;
    });

    if (!entry) {
        const onNew = await isOnNewCountTab(page);
        if (onNew) {
            throw new Error('In-progress count list not found — still on New Count tab');
        }
    }

    return entry;
}

function countOptionMatchesType(text, gate) {
    const typeNeedle = String(gate.countTypeText || 'Key Item Count').toLowerCase();
    return String(text || '').toLowerCase().includes(typeNeedle);
}

function countOptionIncludesApplied(text, gate) {
    const statusNeedle = String(gate.appliedStatusText || 'Applied').toLowerCase();
    return String(text || '').toLowerCase().includes(statusNeedle);
}

function isKeyItemCountApplied(entry, gate) {
    if (!entry || !entry.latest) return false;
    const typeOk = countOptionMatchesType(entry.latest, gate);
    const statusOk = countOptionIncludesApplied(entry.latest, gate);
    return typeOk && statusOk;
}

async function selectCountOptionByIndex(page, index) {
    await openCountInProgressTab(page);
    await openInProgressCountDropdown(page);
    const picked = await page.evaluate((idx) => {
        const selects = Array.from(document.querySelectorAll('select'));
        for (const sel of selects) {
            const ctx = ((sel.closest('tr, div, table') || sel).innerText || '').toLowerCase();
            if (/count type|when:|apply date|create new count/i.test(ctx)) continue;
            const opts = Array.from(sel.options).map((o) => (o.textContent || '').trim());
            if (!opts.some((o) => /\d{1,2}-[A-Za-z]{3}-\d{4}/.test(o))) continue;
            if (sel.options.length > idx) {
                sel.selectedIndex = idx;
                sel.dispatchEvent(new Event('change', { bubbles: true }));
                return (sel.options[idx].textContent || '').trim();
            }
        }
        const items = Array.from(
            document.querySelectorAll('.rcbList li, .rcbItem, [role="listbox"] [role="option"]')
        ).filter((el) => /\d{1,2}-[A-Za-z]{3}-\d{4}/.test(el.textContent || ''));
        if (items[idx]) {
            items[idx].click();
            return (items[idx].textContent || '').trim();
        }
        return null;
    }, index);
    await page.waitForTimeout(1000);
    return picked;
}

/**
 * "Applied" in the count header under the dropdown (Batch # row status box),
 * not product lines like "Apply Applied 39009 …" in the grid below.
 */
async function readAppliedStatusBelowCount(page, gate) {
    const statusWord = String(gate.appliedStatusText || 'Applied');
    return page.evaluate((needle) => {
        const want = needle.toLowerCase();

        let countSelect = null;
        for (const sel of document.querySelectorAll('select')) {
            const ctx = ((sel.closest('tr, div, table') || sel).innerText || '').toLowerCase();
            if (/count type|when:|apply date|create new count/i.test(ctx)) continue;
            const opts = Array.from(sel.options).map((o) => (o.textContent || '').trim());
            if (opts.some((o) => /\d{1,2}-[A-Za-z]{3}-\d{4}/.test(o))) {
                countSelect = sel;
                break;
            }
        }

        if (!countSelect) {
            return { exactAppliedBox: false, exactAppliedBoxCount: 0, appliedAtLine: false, authorisedLine: false };
        }

        const table = countSelect.closest('table');
        const rows = table ? Array.from(table.querySelectorAll('tr')) : [];
        const selectRowIdx = rows.findIndex((r) => r.contains(countSelect));
        const headerRows = selectRowIdx >= 0 ? rows.slice(selectRowIdx, selectRowIdx + 8) : rows.slice(0, 8);
        const headerText = headerRows.map((r) => (r.innerText || '').replace(/\s+/g, ' ')).join(' ');

        const exactBoxes = [];
        for (const row of headerRows) {
            for (const el of row.querySelectorAll('input, span, td, div, label')) {
                const t = (el.textContent || el.value || '').replace(/\s+/g, ' ').trim();
                if (t.toLowerCase() === want) {
                    exactBoxes.push({ tag: el.tagName, text: t });
                }
            }
        }

        const appliedAtLine = /applied\s+at\s*:\s*\d/i.test(headerText);
        const authorisedLine = /authorised\s+by\s*:/i.test(headerText);

        return {
            exactAppliedBox: exactBoxes.length > 0,
            exactAppliedBoxCount: exactBoxes.length,
            appliedAtLine,
            authorisedLine,
            headerSnippet: headerText.slice(0, 400),
        };
    }, statusWord);
}

function isAppliedInCountHeader(status) {
    if (!status) return false;
    if (status.exactAppliedBox) return true;
    return Boolean(status.appliedAtLine && status.authorisedLine);
}

async function navigateMenuPath(page, labels) {
    for (const label of labels) {
        log.info(`Reports menu → ${label}`);
        await clickByExactText(page, label, { partial: true, settleMs: 1200 });
    }
}

async function navigateToSupplyChainReports(page, reportNav, navTimeoutMs) {
    if (!reportNav || !reportNav.url || reportNav.url.includes('REPLACE')) {
        throw new Error('reportNavigation.url not configured in config/pipeline.json');
    }

    const { openReportSelectionPage, setGroupDropdown } = require('./pipeline-supply-chain-reports');
    await openReportSelectionPage(page, reportNav, navTimeoutMs);
    if (reportNav.group) {
        await setGroupDropdown(page, reportNav.group);
    }
    log.info('Report Selection open (Supply Chain group)');
}

module.exports = {
    clickByExactText,
    openCountInProgressTab,
    isOnNewCountTab,
    isOnCountInProgressTab,
    readLatestCountEntry,
    countOptionMatchesType,
    countOptionIncludesApplied,
    isKeyItemCountApplied,
    selectCountOptionByIndex,
    readAppliedStatusBelowCount,
    isAppliedInCountHeader,
    navigateToSupplyChainReports,
    navigateMenuPath,
};
