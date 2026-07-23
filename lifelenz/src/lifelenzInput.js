/**
 * Fill LifeLenz inputs in one shot (no per-character typing delays).
 */

async function pasteIntoInput(page, input, value) {
    if (!input) {
        throw new Error('pasteIntoInput: missing input element');
    }
    const text = String(value ?? '');
    await input.click({ clickCount: 3 });
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyA');
    await page.keyboard.up('Control');
    if (typeof page.keyboard.insertText === 'function') {
        await page.keyboard.insertText(text);
        return;
    }
    await page.evaluate((el, val) => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
        if (setter) {
            setter.call(el, val);
        } else {
            el.value = val;
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
    }, input, text);
}

async function pasteIntoSelector(page, selector, value, timeoutMs = 60000) {
    await page.waitForSelector(selector, { visible: true, timeout: timeoutMs });
    const input = await page.$(selector);
    await pasteIntoInput(page, input, value);
}

module.exports = {
    pasteIntoInput,
    pasteIntoSelector,
};
