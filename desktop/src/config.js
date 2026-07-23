const fs = require('fs');
const path = require('path');
const Store = require('electron-store');

const DEFAULT_SERVER_URL = 'https://tbadashboard.com';
const LOCAL_SERVER_URL = 'http://127.0.0.1:3100';
const DEFAULT_GIT_BRANCH = '16gb';
const DEFAULT_GIT_REMOTE = 'https://github.com/TiripsOrbro/live-dashboard-app.git';

const STORE_NAME = 'area-coach-tools-desktop';
const STORE_DEFAULTS = {
    setupComplete: false,
    mode: null, // 'host' | 'client'
    hostId: null,
    serverUrl: DEFAULT_SERVER_URL,
    serverDir: null,
    gitBranch: DEFAULT_GIT_BRANCH,
    gitRemote: DEFAULT_GIT_REMOTE,
    openAtLogin: true,
    /** Host: git pull server clone on tray launch when origin is ahead (fail-open). */
    autoUpdateFromGitOnLaunch: true,
    lastHostStatus: 'stopped',
};

/** Strip BOM / recover if PowerShell or editors wrote invalid JSON. */
function parseStoreJson(text) {
    const cleaned = String(text || '').replace(/^\uFEFF/, '').trim();
    if (!cleaned) return {};
    return JSON.parse(cleaned);
}

function repairStoreFileIfNeeded() {
    const filePath = path.join(
        process.env.APPDATA || '',
        STORE_NAME,
        `${STORE_NAME}.json`
    );
    if (!filePath || !fs.existsSync(filePath)) return;
    const raw = fs.readFileSync(filePath, 'utf8');
    try {
        parseStoreJson(raw);
        // Rewrite without BOM if present so Conf/electron-store never trip on it.
        if (raw.charCodeAt(0) === 0xfeff || raw.startsWith('\uFEFF')) {
            fs.writeFileSync(filePath, `${JSON.stringify(parseStoreJson(raw), null, '\t')}\n`, 'utf8');
        }
    } catch (err) {
        const backup = `${filePath}.corrupt-${Date.now()}.bak`;
        try {
            fs.copyFileSync(filePath, backup);
        } catch {
            /* ignore */
        }
        console.warn(`[desktop] Corrupt config ${filePath} — backed up to ${backup}:`, err.message);
        fs.writeFileSync(filePath, `${JSON.stringify(STORE_DEFAULTS, null, '\t')}\n`, 'utf8');
    }
}

repairStoreFileIfNeeded();

const store = new Store({
    name: STORE_NAME,
    defaults: STORE_DEFAULTS,
    deserialize: (text) => parseStoreJson(text),
});

function getConfig() {
    return {
        setupComplete: Boolean(store.get('setupComplete')),
        mode: store.get('mode'),
        hostId: store.get('hostId') || null,
        serverUrl: String(store.get('serverUrl') || DEFAULT_SERVER_URL).replace(/\/+$/, ''),
        serverDir: store.get('serverDir'),
        gitBranch: store.get('gitBranch') || DEFAULT_GIT_BRANCH,
        gitRemote: store.get('gitRemote') || DEFAULT_GIT_REMOTE,
        openAtLogin: store.get('openAtLogin') !== false,
        autoUpdateFromGitOnLaunch: store.get('autoUpdateFromGitOnLaunch') !== false,
        lastHostStatus: store.get('lastHostStatus') || 'stopped',
    };
}

function setConfig(partial) {
    for (const [key, value] of Object.entries(partial || {})) {
        store.set(key, value);
    }
    return getConfig();
}

/** In-app Admin for Hosts uses localhost so CF 502 cannot block setup. */
function appOrigin(cfg = getConfig()) {
    if (cfg.mode === 'host') return LOCAL_SERVER_URL;
    return cfg.serverUrl || DEFAULT_SERVER_URL;
}

function settingsUrl(cfg = getConfig()) {
    return `${appOrigin(cfg)}/admin/`;
}

function dashboardUrl(cfg = getConfig()) {
    return `${appOrigin(cfg)}/`;
}

/** Public site (Cloudflare) — for reachability checks / “open in browser” against the live hostname. */
function publicSettingsUrl(cfg = getConfig()) {
    return `${cfg.serverUrl || DEFAULT_SERVER_URL}/admin/`;
}

function publicDashboardUrl(cfg = getConfig()) {
    return `${cfg.serverUrl || DEFAULT_SERVER_URL}/`;
}

module.exports = {
    DEFAULT_SERVER_URL,
    LOCAL_SERVER_URL,
    DEFAULT_GIT_BRANCH,
    DEFAULT_GIT_REMOTE,
    getConfig,
    setConfig,
    appOrigin,
    settingsUrl,
    dashboardUrl,
    publicSettingsUrl,
    publicDashboardUrl,
};
