const { GOTO_OPTS } = require('./mmx-browser');
const { withPageContextRetry } = require('./mmx-context-retry');
const log = require('./util-logging');

async function fillField(page, field, value) {
    const sel = field.selector;
    if (!sel || sel.includes('REPLACE')) {
        throw new Error(`Paste field selector not configured for key ${field.sourceCell}`);
    }
    await page.waitForSelector(sel, { timeout: 30000 });

    if (field.type === 'select') {
        await page.select(sel, String(value));
        return;
    }

    await page.evaluate(
        (s, v) => {
            const el = document.querySelector(s);
            if (!el) return;
            el.focus();
            el.value = v;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
        },
        sel,
        String(value ?? '')
    );
}

async function uploadToMacromatix(page, settings, pasteValues) {
    const paste = settings.pipeline.paste;
    if (!paste || !paste.url || paste.url.includes('REPLACE')) {
        log.warn('Paste URL not configured; skipping Macromatix entry');
        return { skipped: true };
    }

    await page.goto(paste.url, { ...GOTO_OPTS, timeout: settings.navTimeoutMs });
    if (paste.readySelector) {
        await page.waitForSelector(paste.readySelector, { timeout: settings.navTimeoutMs });
    }
    await page.waitForTimeout(600);

    const fields = paste.fields || [];
    await withPageContextRetry(page, 'paste fields', async () => {
        for (const field of fields) {
            const key = field.key || field.sourceCell;
            let value = pasteValues[key];
            if (value === undefined && field.sourceCell) {
                const keys = Object.keys(pasteValues);
                value = pasteValues[keys.find((k) => k.includes(field.sourceCell))];
            }
            if (value === undefined) {
                log.warn(`No paste value for ${key}; skipping field`);
                continue;
            }
            log.info(`Pasting ${key} → ${field.selector}`);
            await fillField(page, field, value);
        }

        if (paste.submitSelector && !paste.dryRunSubmit) {
            await page.waitForSelector(paste.submitSelector, { timeout: 15000 });
            await page.click(paste.submitSelector);
            await page.waitForTimeout(2000);
            log.info('Submitted paste form');
        } else if (paste.dryRunSubmit !== false) {
            log.info('Dry-run: fields filled, submit not clicked (set paste.dryRunSubmit=false to save)');
        }
    });

    return { skipped: false };
}

module.exports = { uploadToMacromatix };
