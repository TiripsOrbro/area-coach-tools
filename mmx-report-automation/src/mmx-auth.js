const crypto = require('crypto');
const puppeteer = require('puppeteer');
const { BASE_URL, GOTO_OPTS, getPuppeteerLaunchOptions } = require('./mmx-browser');
const { patchPageWaitForTimeout } = require('./util-delay');
const { clearChromeProfileSingletonLocks } = require('./util-files');
const log = require('./util-logging');

const SELECT_STORE_URL = `${BASE_URL}MMS_Logon.aspx?mode=SelectStore`;

function decryptCredentialPayload(encryptedPayload, keyText) {
    if (!encryptedPayload || !keyText) return null;

    const key = crypto.createHash('sha256').update(String(keyText)).digest();
    const parsed = JSON.parse(Buffer.from(String(encryptedPayload), 'base64').toString('utf8'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(parsed.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(parsed.tag, 'base64'));
    const decrypted = Buffer.concat([
        decipher.update(Buffer.from(parsed.data, 'base64')),
        decipher.final(),
    ]);
    return JSON.parse(decrypted.toString('utf8'));
}

function getMacromatixCredentials() {
    const encrypted = String(process.env.SCRAPER_CREDENTIALS_ENCRYPTED || '').trim();
    if (encrypted) {
        if (!String(process.env.SCRAPER_CREDENTIALS_KEY || '').trim()) {
            throw new Error('SCRAPER_CREDENTIALS_KEY is required when SCRAPER_CREDENTIALS_ENCRYPTED is set');
        }
        let decrypted;
        try {
            decrypted = decryptCredentialPayload(encrypted, process.env.SCRAPER_CREDENTIALS_KEY);
        } catch (e) {
            throw new Error(`Failed to decrypt SCRAPER_CREDENTIALS_ENCRYPTED: ${e.message}`);
        }
        return {
            username: decrypted && decrypted.username != null ? String(decrypted.username).trim() : '',
            password: decrypted && decrypted.password != null ? String(decrypted.password).trim() : '',
        };
    }
    return {
        username: String(process.env.SCRAPER_USERNAME || '').trim(),
        password: String(process.env.SCRAPER_PASSWORD || '').trim(),
    };
}

function extractStoreNumber(label) {
    const m = String(label || '').match(/\b(\d{3,6})\b/);
    return m ? m[1] : '';
}

function isSelectStoreUrl(url) {
    return /mode=SelectStore/i.test(url || '');
}

/** True for the password form — SelectStore is post-login, not a login failure. */
function isMacromatixLogonPage(url, hasLoginForm) {
    if (isSelectStoreUrl(url)) return false;
    if (hasLoginForm) return true;
    return /\/MMS_Logon\.aspx/i.test(url || '') || /\/login/i.test(url || '');
}

async function readLoginPageError(page) {
    try {
        return await page.evaluate(() => {
            const selectors = [
                '.validation-summary-errors',
                '#Login_FailureText',
                '[id*="Failure"]',
                '[id*="Error"]',
                '.error',
            ];
            for (const sel of selectors) {
                const el = document.querySelector(sel);
                const text = (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
                if (text) return text.slice(0, 240);
            }
            const body = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
            const lower = body.toLowerCase();
            if (lower.includes('invalid') || lower.includes('incorrect') || lower.includes('failed')) {
                return body.slice(0, 240);
            }
            return '';
        });
    } catch {
        return '';
    }
}

async function submitLoginForm(page, username, password, navTimeout) {
    await page.waitForSelector('#Login_UserName', { timeout: navTimeout });
    await page.evaluate(() => {
        const u = document.querySelector('#Login_UserName');
        const p = document.querySelector('#Login_Password');
        if (u) u.value = '';
        if (p) p.value = '';
    });
    await page.type('#Login_UserName', username, { delay: 25 });
    await page.type('#Login_Password', password, { delay: 25 });

    const loginButton = await page.$('input[type="submit"]');
    if (!loginButton) throw new Error('Login button not found');

    log.info('Login submit clicked (Log On)');
    await Promise.all([
        page.waitForNavigation({ waitUntil: 'load', timeout: navTimeout }).catch(() => {}),
        loginButton.click(),
    ]);
}

async function waitForPostLogin(page, loginSuccessUrlPart, loginWaitMs) {
    const needle = String(loginSuccessUrlPart || 'MMS_Stores').replace(/^\//, '');
    const start = Date.now();
    let lastLogAt = 0;
    while (Date.now() - start < loginWaitMs) {
        let url = '';
        let onLogin = null;
        let hasStorePicker = false;
        try {
            url = page.url() || '';
            onLogin = await page.$('#Login_UserName');
            hasStorePicker = Boolean(await page.$('#ddlStoreSelection, select[name="ddlStoreSelection"]'));
        } catch {
            await page.waitForTimeout(500);
            continue;
        }

        if (Date.now() - lastLogAt >= 15000) {
            const onLoginPage = isMacromatixLogonPage(url, Boolean(onLogin));
            const loginError = onLoginPage ? await readLoginPageError(page) : '';
            log.info(
                `Waiting for login… (${Math.round((Date.now() - start) / 1000)}s) url=${url.slice(0, 80)} onLoginPage=${onLoginPage}${
                    loginError ? ` error="${loginError}"` : ''
                }`
            );
            lastLogAt = Date.now();
        }

        // Post-login store picker = authenticated; leave wait so caller can pick a store.
        if (isSelectStoreUrl(url) || hasStorePicker) {
            return true;
        }
        if (isMacromatixLogonPage(url, Boolean(onLogin))) {
            await page.waitForTimeout(1000);
            continue;
        }
        if (needle && url.includes(needle)) {
            return true;
        }
        if (/macromatix\.net/i.test(url)) {
            return true;
        }
        await page.waitForTimeout(1000);
    }
    return false;
}

async function triggerDoPostBackSloppy(page, eventTarget) {
    if (typeof eventTarget !== 'string' || !eventTarget) return;
    await page.evaluate((t) => {
        const s = document.createElement('script');
        s.textContent = `__doPostBack(${JSON.stringify(t)}, "");`;
        const root = document.body || document.documentElement;
        root.appendChild(s);
        s.remove();
    }, eventTarget);
}

async function ensureLoginStorePickerPage(page) {
    if (await page.$('#ddlStoreSelection, select[name="ddlStoreSelection"]')) {
        return true;
    }
    if (isSelectStoreUrl(page.url() || '')) {
        await page
            .waitForSelector('#ddlStoreSelection, select[name="ddlStoreSelection"]', {
                visible: true,
                timeout: 12000,
            })
            .catch(() => {});
        if (await page.$('#ddlStoreSelection, select[name="ddlStoreSelection"]')) {
            return true;
        }
    }
    const url = page.url() || '';
    const onLogin = await page.$('#Login_UserName');
    if (isMacromatixLogonPage(url, Boolean(onLogin))) {
        return false;
    }
    log.info('Opening Macromatix SelectStore picker…');
    await page.goto(SELECT_STORE_URL, GOTO_OPTS);
    await page.waitForFunction(() => document.readyState === 'complete', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(800);
    return Boolean(await page.$('#ddlStoreSelection, select[name="ddlStoreSelection"]'));
}

/**
 * Multi-store accounts land on SelectStore after password login.
 * Pick the store from MMX_STORE_NAME / options.storeNumber.
 */
async function selectStoreOnLoginDropdown(page, storeNumber) {
    const want = String(storeNumber || '').replace(/[^0-9]/g, '');
    if (!want) return null;

    const pickerAvailable = await ensureLoginStorePickerPage(page);
    if (!pickerAvailable) return null;

    const deadline = Date.now() + 18000;
    while (Date.now() < deadline) {
        const ready = await page.evaluate(() => {
            const sel = document.querySelector('#ddlStoreSelection, select[name="ddlStoreSelection"]');
            if (!sel) return false;
            return [...sel.options].some((opt) => {
                const text = (opt.textContent || '').replace(/\s+/g, ' ').trim();
                return text && !/^select store$/i.test(text) && /\b\d{3,6}\b/.test(text);
            });
        });
        if (ready) break;
        await page.waitForTimeout(400);
    }

    const match = await page.evaluate((w) => {
        const sel = document.querySelector('#ddlStoreSelection, select[name="ddlStoreSelection"]');
        if (!sel) return null;
        const re = new RegExp(`(^|\\D)${w}(\\D|$)`);
        for (const opt of sel.options) {
            const text = (opt.textContent || '').replace(/\s+/g, ' ').trim();
            if (!text || /^select store$/i.test(text)) continue;
            if (re.test(text)) {
                return { text, value: opt.value };
            }
        }
        return null;
    }, want);

    if (!match) {
        log.warn(`SelectStore: no dropdown option matched store ${want}`);
        return null;
    }

    try {
        await page.select('#ddlStoreSelection', match.value);
    } catch {
        await page.evaluate((value) => {
            const sel = document.querySelector('#ddlStoreSelection, select[name="ddlStoreSelection"]');
            if (!sel) return;
            sel.value = value;
            sel.dispatchEvent(new Event('change', { bubbles: true }));
        }, match.value);
    }

    await page.waitForTimeout(350);
    await triggerDoPostBackSloppy(page, 'ddlStoreSelection');
    await page.waitForTimeout(450);

    const clicked = await page.evaluate(() => {
        const storeBtn = document.querySelector('#btStoreSelection, input[name="btStoreSelection"]');
        if (storeBtn) {
            storeBtn.click();
            return storeBtn.value || 'btStoreSelection';
        }
        for (const el of document.querySelectorAll('input[type="submit"], input[type="button"], button, a')) {
            const t = (el.value || el.textContent || '').replace(/\s+/g, ' ').trim();
            if (/^(go|continue|ok|select|submit|log\s*on|login)$/i.test(t)) {
                el.click();
                return t;
            }
        }
        return null;
    });

    await Promise.race([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {}),
        page
            .waitForFunction(() => !/mode=SelectStore/i.test(location.href || ''), { timeout: 25000 })
            .catch(() => {}),
        page.waitForTimeout(clicked ? 6000 : 2000),
    ]);
    await page.waitForFunction(() => document.readyState === 'complete', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(600);

    const stillOnPicker =
        isSelectStoreUrl(page.url() || '') ||
        Boolean(await page.$('#ddlStoreSelection, select[name="ddlStoreSelection"]'));
    if (stillOnPicker) {
        throw new Error(`Store ${want} selection did not leave the login picker (still on SelectStore)`);
    }

    log.info(`SelectStore picked: ${match.text}${clicked ? ` (clicked ${clicked})` : ''}`);
    return match.text;
}

async function maybeSelectStoreAfterLogin(page, options = {}) {
    const storeNumber =
        String(options.storeNumber || '').replace(/\D/g, '') ||
        extractStoreNumber(options.storeName) ||
        extractStoreNumber(process.env.MMX_STORE_NAME) ||
        extractStoreNumber(process.env.MMX_LABOUR_STORES);

    if (!storeNumber) {
        const url = page.url() || '';
        const hasPicker = Boolean(await page.$('#ddlStoreSelection, select[name="ddlStoreSelection"]'));
        if (isSelectStoreUrl(url) || hasPicker) {
            log.warn('On SelectStore but no store number in MMX_STORE_NAME — leaving picker as-is');
        }
        return null;
    }

    const url = page.url() || '';
    const hasPicker = Boolean(await page.$('#ddlStoreSelection, select[name="ddlStoreSelection"]'));
    if (isSelectStoreUrl(url) || hasPicker) {
        return selectStoreOnLoginDropdown(page, storeNumber);
    }

    // Shared browser profile may still be logged into a previous store (e.g. 3806).
    // Re-open SelectStore when the target store number is not already in page context.
    const onPage = await page.evaluate((want) => {
        const body = (document.body?.innerText || '').replace(/\s+/g, ' ');
        return new RegExp(`(^|\\D)${want}(\\D|$)`).test(body.slice(0, 25000));
    }, storeNumber);
    if (onPage) {
        log.info(`Session already scoped to store ${storeNumber}`);
        return storeNumber;
    }

    log.info(`Session store does not match ${storeNumber} — reopening SelectStore`);
    await page.goto(SELECT_STORE_URL, { ...GOTO_OPTS, timeout: options.navTimeoutMs || GOTO_OPTS.timeout });
    await page.waitForTimeout(800);
    return selectStoreOnLoginDropdown(page, storeNumber);
}

async function loginMacromatix(page, options = {}) {
    const { username, password } = getMacromatixCredentials();
    if (!username || !password) {
        throw new Error(
            'Macromatix credentials missing. Set SCRAPER_USERNAME/SCRAPER_PASSWORD or SCRAPER_CREDENTIALS_ENCRYPTED in .env'
        );
    }

    const navTimeout = options.navTimeoutMs || GOTO_OPTS.timeout;
    const loginWaitMs = options.loginWaitMs || 300000;
    const loginSuccessUrlPart = options.loginSuccessUrlPart || 'MMS_Stores';

    log.info('Navigating to Macromatix login…');
    await page.goto(BASE_URL, { ...GOTO_OPTS, timeout: navTimeout });

    const alreadyIn = await waitForPostLogin(page, loginSuccessUrlPart, 3000);
    if (alreadyIn) {
        log.info('Session already active (userDataDir); skipping password entry');
        await maybeSelectStoreAfterLogin(page, options);
        return;
    }

    log.info(`Entering credentials for user "${username}"…`);
    await submitLoginForm(page, username, password, navTimeout);

    log.info('Credentials submitted — waiting for Macromatix session…');
    const ok = await waitForPostLogin(page, loginSuccessUrlPart, loginWaitMs);
    if (!ok) {
        const loginError = await readLoginPageError(page);
        let hint = '';
        try {
            hint = ` Last url: ${page.url()}.`;
        } catch {
            /* ignore */
        }
        if (loginError) {
            hint += ` Login page message: ${loginError}`;
        }
        throw new Error(
            `Login did not complete within ${loginWaitMs}ms.${hint} Check SCRAPER_USERNAME/SCRAPER_PASSWORD in .env.production, or copy data/browser-profile from your PC.`
        );
    }
    log.info('Logged in to Macromatix');
    await maybeSelectStoreAfterLogin(page, options);
}

async function launchBrowser(settings) {
    const launchOpts = getPuppeteerLaunchOptions(settings.userDataDir);
    if (settings.ephemeralBrowser) {
        log.info('Using ephemeral browser (no saved profile — logs in each run, like dashboard)');
    } else {
        const clearedLocks = clearChromeProfileSingletonLocks(settings.userDataDir);
        if (clearedLocks.length) {
            log.info(`Cleared stale browser profile locks: ${clearedLocks.join(', ')}`);
        }
    }
    log.info(
        `Launching browser (headless=${launchOpts.headless}, profile=${settings.userDataDir || 'ephemeral'})`
    );
    const browser = await puppeteer.launch(launchOpts);
    const page = patchPageWaitForTimeout(await browser.newPage());
    await page.setViewport({ width: 1280, height: 720 });
    return { browser, page };
}

module.exports = {
    getMacromatixCredentials,
    loginMacromatix,
    launchBrowser,
    waitForPostLogin,
    selectStoreOnLoginDropdown,
    maybeSelectStoreAfterLogin,
};
