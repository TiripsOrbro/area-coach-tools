const { waitForAspPostback } = require('./mmx-postback');

async function waitForQuantityInputValue(page, inputId, expectedValue, timeoutMs = 5000) {
    const want = String(expectedValue);
    await page.waitForFunction(
        (id, target) => {
            const inp = document.getElementById(id);
            if (!inp) return false;
            const val = (inp.value || '').trim();
            if (val === target) return true;
            const a = parseFloat(val);
            const b = parseFloat(target);
            return Number.isFinite(a) && Number.isFinite(b) && a === b;
        },
        { timeout: timeoutMs, polling: 50 },
        inputId,
        want
    );
}

async function setQuantityInputValue(page, inputId, quantity) {
    const text = String(quantity);
    const applied = await page.evaluate((id, val) => {
        const inp = document.getElementById(id);
        if (!inp) return false;
        inp.focus();
        inp.value = val;
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        inp.dispatchEvent(new Event('change', { bubbles: true }));
        inp.dispatchEvent(new Event('blur', { bubbles: true }));
        return true;
    }, inputId, text);

    if (!applied) return false;

    try {
        await waitForQuantityInputValue(page, inputId, text, 2500);
        return true;
    } catch {
        return false;
    }
}

async function typeQuantityIntoInputFallback(page, inputId, quantity) {
    const handle = await page.evaluateHandle((id) => document.getElementById(id), inputId);
    const el = handle.asElement();
    if (!el) {
        await handle.dispose();
        return false;
    }

    await el.click({ clickCount: 3 });
    await el.focus();
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyA');
    await page.keyboard.up('Control');
    await page.keyboard.press('Backspace');
    await page.keyboard.type(String(quantity), { delay: 0 });
    await page.keyboard.press('Tab');
    await handle.dispose();

    try {
        await waitForQuantityInputValue(page, inputId, quantity, 3000);
        return true;
    } catch {
        return false;
    }
}

async function waitForOrderPageReady(page, timeoutMs = 30000) {
    await page.waitForFunction(
        () => {
            for (const table of document.querySelectorAll('table')) {
                const header = (table.querySelector('tr')?.innerText || '').toLowerCase();
                if (header.includes('item code') && header.includes('quantity')) {
                    const inputs = table.querySelectorAll('input[type="text"]');
                    if (inputs.length) return true;
                }
            }
            return (document.body?.innerText || '').toLowerCase().includes('items in this order');
        },
        { timeout: timeoutMs, polling: 100 }
    );
}

async function waitForScheduledOrdersTableReady(page, timeoutMs = 12000) {
    await page.waitForFunction(
        () => {
            const t = (document.body?.innerText || '').toLowerCase();
            if (!t.includes('vendor')) return false;
            const hasAction = [...document.querySelectorAll('a')].some((a) => {
                const x = (a.textContent || '').trim().toLowerCase();
                return x === 'create' || x === 'process';
            });
            if (hasAction) return true;
            return [...document.querySelectorAll('table')].some((tb) => {
                const x = (tb.innerText || '').toLowerCase();
                return x.includes('vendor') && (x.includes('status') || x.includes('order #'));
            });
        },
        { timeout: timeoutMs, polling: 100 }
    );
}

function pageHasScheduledOrderRows() {
    const t = (document.body?.innerText || '').toLowerCase();
    if (!t.includes('vendor')) return false;
    const hasAction = [...document.querySelectorAll('a')].some((a) => {
        const x = (a.textContent || '').trim().toLowerCase();
        return x === 'create' || x === 'process';
    });
    if (hasAction) return true;
    return [...document.querySelectorAll('table')].some((tb) => {
        const x = (tb.innerText || '').toLowerCase();
        return x.includes('vendor') && (x.includes('status') || x.includes('order #'));
    });
}

async function waitAfterOrderUpdate(page, timeoutMs = 20000) {
    await waitForAspPostback(page, { timeoutMs });
    await Promise.race([
        page
            .waitForFunction(() => /scheduledorders/i.test(window.location.href || ''), {
                timeout: timeoutMs,
                polling: 100,
            })
            .catch(() => null),
        waitForScheduledOrdersTableReady(page, timeoutMs).catch(() => null),
        waitForOrderPageReady(page, Math.min(timeoutMs, 8000)).catch(() => null),
    ]);
}

module.exports = {
    waitForQuantityInputValue,
    setQuantityInputValue,
    typeQuantityIntoInputFallback,
    waitForOrderPageReady,
    waitForScheduledOrdersTableReady,
    waitAfterOrderUpdate,
    pageHasScheduledOrderRows,
};
