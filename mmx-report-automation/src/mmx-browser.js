const fs = require('fs');
const { isWindows } = require('./util-platform');

const BASE_URL = 'https://tacobellau.macromatix.net/';
const GOTO_OPTS = { waitUntil: 'load', timeout: 45000 };

const LINUX_CHROMIUM_CANDIDATES = [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    '/usr/bin/google-chrome-stable',
];

const WINDOWS_CHROMIUM_CANDIDATES = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
];

function resolveChromiumExecutablePath() {
    const fromEnv = String(process.env.SCRAPER_EXECUTABLE_PATH || '').trim();
    if (fromEnv) {
        if (fs.existsSync(fromEnv)) {
            return fromEnv;
        }
        console.warn(`[MMX] SCRAPER_EXECUTABLE_PATH not found (${fromEnv}), scanning common paths`);
    }
    const candidates = isWindows()
        ? [...WINDOWS_CHROMIUM_CANDIDATES, ...LINUX_CHROMIUM_CANDIDATES]
        : [...LINUX_CHROMIUM_CANDIDATES, ...WINDOWS_CHROMIUM_CANDIDATES];
    for (const p of candidates) {
        if (fs.existsSync(p)) {
            return p;
        }
    }
    return undefined;
}

function getPuppeteerLaunchOptions(userDataDir) {
    const raw = process.env.SCRAPER_HEADLESS;
    const headless =
        raw === undefined || raw === ''
            ? true
            : !/^(0|false|no|off)$/i.test(String(raw).trim());
    const opts = {
        headless,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-background-networking',
            '--disable-background-timer-throttling',
            '--disable-renderer-backgrounding',
            '--disable-extensions',
            '--mute-audio',
            '--no-first-run',
        ],
    };
    if (userDataDir) {
        opts.userDataDir = userDataDir;
    }
    const chromiumPath = resolveChromiumExecutablePath();
    if (chromiumPath) {
        opts.executablePath = chromiumPath;
        console.log('[MMX] Using Chromium executable:', chromiumPath);
    }
    const slowMo = Number(process.env.SCRAPER_SLOW_MO_MS);
    if (Number.isFinite(slowMo) && slowMo > 0) {
        opts.slowMo = slowMo;
    }
    if (/^(1|true|yes|on)$/i.test(String(process.env.SCRAPER_DEVTOOLS ?? '').trim())) {
        opts.devtools = true;
    }
    return opts;
}

module.exports = {
    BASE_URL,
    GOTO_OPTS,
    getPuppeteerLaunchOptions,
};
