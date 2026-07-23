const {
    app,
    BrowserWindow,
    ipcMain,
    dialog,
    shell,
    Notification,
} = require('electron');
const path = require('path');
const os = require('os');
const { getConfig, setConfig, settingsUrl, dashboardUrl, appOrigin, DEFAULT_SERVER_URL } = require('./config');
const { createTray, rebuildContextMenu, notifyTray, setTrayTooltip } = require('./tray');
const host = require('./host-controller');
const { configureUpdater, ensureUpToDateBeforeLaunch } = require('./updater');
const cloudflare = require('./cloudflare');
const bootstrap = require('./host-bootstrap');
const hostLease = require('./host-lease-client');
const secretsPack = require('./secrets-pack');
const watchdog = require('./watchdog');

let settingsWindow = null;
let wizardWindow = null;
let livePollTimer = null;
let hostHeartbeatTimer = null;
let statusPollTimer = null;
let lastLiveVersion = 0;
/** @type {'idle'|'starting'|'running'|'stopped'|'error'} */
let hostServerPhase = 'idle';

function applyOpenAtLogin(enabled) {
    try {
        app.setLoginItemSettings({
            openAtLogin: Boolean(enabled),
            path: process.execPath,
            args: [],
        });
    } catch (err) {
        console.warn('[desktop] setLoginItemSettings', err);
    }
}

function showOperatorNotice({ title, body }) {
    const message = String(body || '');
    try {
        if (Notification.isSupported()) {
            new Notification({ title: String(title || 'Live Dashboard'), body: message }).show();
        }
    } catch {
        /* ignore */
    }
    notifyTray(String(title || 'Live Dashboard'), message);
}

/** Guided setup prompts (Cloudflare walkthrough, etc.). Returns button index. */
async function confirmDialog(opts = {}) {
    const { response } = await dialog.showMessageBox({
        type: opts.type || 'info',
        title: opts.title || 'Live Dashboard',
        message: opts.message || '',
        detail: opts.detail || '',
        buttons: opts.buttons && opts.buttons.length ? opts.buttons : ['OK'],
        defaultId: opts.defaultId ?? 0,
        cancelId: opts.cancelId,
        noLink: true,
    });
    return response;
}

function createWizardWindow() {
    if (wizardWindow && !wizardWindow.isDestroyed()) {
        wizardWindow.focus();
        return wizardWindow;
    }
    wizardWindow = new BrowserWindow({
        width: 580,
        height: 680,
        resizable: false,
        title: 'Live Dashboard setup',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
        show: false,
    });
    wizardWindow.removeMenu();
    wizardWindow.loadFile(path.join(__dirname, 'wizard.html'));
    wizardWindow.once('ready-to-show', () => wizardWindow.show());
    wizardWindow.on('closed', () => {
        wizardWindow = null;
    });
    return wizardWindow;
}

function createSettingsWindow() {
    const cfg = getConfig();
    const url = settingsUrl(cfg);
    if (settingsWindow && !settingsWindow.isDestroyed()) {
        settingsWindow.show();
        settingsWindow.focus();
        settingsWindow.loadURL(url);
        return settingsWindow;
    }
    settingsWindow = new BrowserWindow({
        width: 1280,
        height: 860,
        title: 'Live Dashboard — Admin',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
        show: false,
    });
    settingsWindow.removeMenu();
    settingsWindow.loadURL(url);
    settingsWindow.webContents.on('did-fail-load', (_e, code, desc, validatedURL) => {
        if (!settingsWindow || settingsWindow.isDestroyed()) return;
        if (code === -3) return; // aborted
        const safeDesc = String(desc || 'load failed');
        const safeUrl = String(validatedURL || url);
        settingsWindow.loadURL(
            `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<html><body style="font-family:Segoe UI,sans-serif;padding:40px;background:#111;color:#eee;max-width:640px">
  <h1 style="margin:0 0 12px">Admin is starting…</h1>
  <p style="color:#aaa;line-height:1.45">The dashboard server is not ready yet (${safeDesc}).</p>
  <p style="color:#888;font-size:13px;word-break:break-all">${safeUrl}</p>
  <p style="margin-top:20px">This window stays open — it will retry automatically. You can also use the tray → <strong>Start server</strong>.</p>
</body></html>`)}`
        );
        settingsWindow.show();
        settingsWindow.focus();
    });
    settingsWindow.webContents.on('did-finish-load', () => {
        if (settingsWindow && !settingsWindow.isDestroyed()) {
            settingsWindow.show();
            settingsWindow.focus();
        }
    });
    settingsWindow.once('ready-to-show', () => {
        if (settingsWindow && !settingsWindow.isDestroyed()) {
            settingsWindow.show();
            settingsWindow.focus();
        }
    });
    settingsWindow.on('closed', () => {
        settingsWindow = null;
    });
    startLiveWatch();
    return settingsWindow;
}

async function openSettings() {
    const cfg = getConfig();
    if (!cfg.setupComplete) {
        createWizardWindow();
        return;
    }
    // Host: wait for local server before loading Admin so launch doesn't flash CONNECTION_REFUSED.
    if (cfg.mode === 'host') {
        try {
            const health = await host.probeLocalHealth();
            if (!health.ok) {
                hostServerPhase = 'starting';
                refreshTrayStatus().catch(() => {});
                notifyTray('Live Dashboard', 'Starting server before opening Admin…');
                const result = await host.ensureServerRunning({ waitMs: 60000 });
                if (result.health?.ok) hostServerPhase = 'running';
                else hostServerPhase = 'error';
            } else {
                hostServerPhase = 'running';
            }
        } catch (err) {
            console.warn('[desktop] openSettings ensure server', err);
            hostServerPhase = 'error';
        }
    }
    createSettingsWindow();
    if (settingsWindow && !settingsWindow.isDestroyed()) {
        settingsWindow.show();
        settingsWindow.focus();
    }
}

async function pollLiveVersion() {
    const cfg = getConfig();
    if (!cfg.setupComplete) return;
    try {
        const res = await fetch(`${appOrigin(cfg)}/api/live/version`, {
            signal: AbortSignal.timeout(4000),
        });
        if (!res.ok) return;
        const body = await res.json();
        const v = Number(body.version || 0);
        if (lastLiveVersion && v > lastLiveVersion && settingsWindow && !settingsWindow.isDestroyed()) {
            settingsWindow.webContents.send('live:event', body.lastEvent || body);
            // Only reload for genuine config changes — sales.updated fires after
            // every scrape (~1/min) and must not blank the Settings window.
            if (body.lastEvent && /settings|accounts|storelist/i.test(String(body.lastEvent.type))) {
                settingsWindow.webContents.reloadIgnoringCache();
            }
        }
        lastLiveVersion = v || lastLiveVersion;
    } catch {
        /* offline / not logged in */
    }
}

function startLiveWatch() {
    if (livePollTimer) return;
    livePollTimer = setInterval(() => {
        pollLiveVersion().catch(() => {});
    }, 8000);
    pollLiveVersion().catch(() => {});
}

function stopHostHeartbeat() {
    if (hostHeartbeatTimer) {
        clearInterval(hostHeartbeatTimer);
        hostHeartbeatTimer = null;
    }
}

/** Auto-repair loop for Host mode (server / tunnel / lease). */
function startHostWatchdog() {
    watchdog.startWatchdog({
        notify: showOperatorNotice,
        afterRepair: () => {
            hostServerPhase = 'running';
            refreshTrayStatus().catch(() => {});
            rebuildContextMenu().catch(() => {});
        },
    });
}

async function tearDownLocalHosting({ releaseLease = false } = {}) {
    watchdog.stopWatchdog();
    stopHostHeartbeat();
    try {
        await host.stopServer();
    } catch {
        /* ignore */
    }
    try {
        await cloudflare.stopCloudflareTunnel();
    } catch (err) {
        console.warn('[desktop] stopCloudflareTunnel', err);
    }
    if (releaseLease) {
        try {
            await hostLease.releaseHost();
        } catch {
            /* ignore */
        }
    }
    hostServerPhase = 'stopped';
}

async function demoteToClient(message) {
    const cfg = getConfig();
    if (cfg.mode !== 'host') return;
    await tearDownLocalHosting({ releaseLease: false });
    setConfig({ mode: 'client', lastHostStatus: 'demoted' });
    rebuildContextMenu().catch(() => {});
    refreshTrayStatus().catch(() => {});
    const detail =
        message ||
        'Another computer took over hosting. This PC is now a Client. You can keep using Settings as normal.';
    showOperatorNotice({
        title: 'Hosting moved',
        body: detail,
    });
}

/**
 * Voluntary leave Host → Client (stops server + Cloudflare + releases lease).
 */
async function stopHostingBecomeClient() {
    const cfg = getConfig();
    if (cfg.mode !== 'host') return { ok: false, reason: 'not-host' };

    const { response } = await dialog.showMessageBox({
        type: 'question',
        buttons: ['Stop hosting', 'Cancel'],
        defaultId: 0,
        cancelId: 1,
        title: 'Stop hosting?',
        message: 'Become a Client on this PC?',
        detail: [
            'This will:',
            '• Stop the local dashboard server',
            '• Stop Cloudflare tunnel on this PC',
            '• Release the Host lease so another PC can take over',
            '',
            'Export a secrets pack first if you plan to move Host to another computer.',
        ].join('\n'),
    });
    if (response !== 0) return { ok: false, reason: 'cancelled' };

    await tearDownLocalHosting({ releaseLease: true });
    setConfig({ mode: 'client', lastHostStatus: 'stopped' });
    rebuildContextMenu().catch(() => {});
    refreshTrayStatus().catch(() => {});
    showOperatorNotice({
        title: 'Now a Client',
        body: 'This PC stopped hosting. Open Settings against tbadashboard.com as usual.',
    });
    return { ok: true };
}

async function pickSecretsFolderForHost() {
    const suggestions = secretsPack.suggestSecretsFolders();
    const result = await dialog.showOpenDialog({
        title: 'Select Host secrets folder',
        message: 'Choose the secrets folder from your Taco Bell Dashboard Pack (optional but recommended)',
        defaultPath: suggestions[0] || path.join(os.homedir(), 'Desktop'),
        properties: ['openDirectory'],
    });
    if (result.canceled || !result.filePaths?.[0]) return null;
    const resolved = secretsPack.resolveSecretsRoot(result.filePaths[0]);
    if (!secretsPack.looksLikeSecretsPack(resolved)) {
        const { response } = await dialog.showMessageBox({
            type: 'warning',
            buttons: ['Use this folder anyway', 'Skip secrets', 'Cancel'],
            defaultId: 1,
            cancelId: 2,
            title: 'Folder looks incomplete',
            message: 'This does not look like a secrets pack',
            detail:
                'Expected a folder with .env / env.txt and store-logins or accounts. Continue only if you know this is correct.',
        });
        if (response === 2) return undefined; // cancel become-host
        if (response === 1) return null; // skip
    }
    return resolved;
}

/**
 * Client → Host from tray (reuses bootstrap + conflict check).
 */
async function becomeHostFromTray() {
    const cfg = getConfig();
    if (cfg.mode === 'host') {
        await dialog.showMessageBox({
            type: 'info',
            message: 'Already Host',
            detail: 'This PC is already in Host mode.',
        });
        return { ok: false, reason: 'already-host' };
    }

    const { response } = await dialog.showMessageBox({
        type: 'question',
        buttons: ['Continue', 'Cancel'],
        defaultId: 0,
        cancelId: 1,
        title: 'Become Host',
        message: 'Make this PC the main server?',
        detail: [
            'This installs/starts the dashboard server and Cloudflare tunnel.',
            'Only one Host should run at a time.',
            'Have a secrets pack ready if you are moving from another PC.',
        ].join('\n'),
    });
    if (response !== 0) return { ok: false, reason: 'cancelled' };

    const secretsPick = await pickSecretsFolderForHost();
    if (secretsPick === undefined) return { ok: false, reason: 'cancelled' };
    const secretsPath = secretsPick;

    const progressWin = new BrowserWindow({
        width: 480,
        height: 220,
        resizable: false,
        title: 'Becoming Host…',
        autoHideMenuBar: true,
        webPreferences: { contextIsolation: true, nodeIntegration: false },
    });
    progressWin.removeMenu();
    const sendProgress = (msg) => {
        const safe = String(msg || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
        progressWin.loadURL(
            `data:text/html;charset=utf-8,${encodeURIComponent(
                `<!doctype html><html><body style="font-family:Segoe UI,sans-serif;padding:20px;background:#111;color:#eee">
                <h3 style="margin:0 0 12px">Becoming Host</h3>
                <pre style="white-space:pre-wrap;font-size:13px">${safe}</pre>
                </body></html>`
            )}`
        );
    };

    applyOpenAtLogin(true);
    hostLease.ensureHostId();

    try {
        const decision = await resolveHostConflictOrProceed(sendProgress);
        if (decision === null) {
            progressWin.close();
            return { ok: false, reason: 'cancelled' };
        }
        if (decision === 'client') {
            await bootstrap.runClientBootstrap({ onProgress: sendProgress });
            progressWin.close();
            rebuildContextMenu().catch(() => {});
            refreshTrayStatus().catch(() => {});
            openSettings();
            return { ok: true, mode: 'client' };
        }

        setConfig({
            mode: 'host',
            serverUrl: DEFAULT_SERVER_URL,
            openAtLogin: true,
            serverDir: host.defaultServerDir(),
            setupComplete: false,
        });

        sendProgress('This may take several minutes the first time…');
        const result = await bootstrap.runHostBootstrap({
            onProgress: sendProgress,
            setupCloudflare: true,
            secretsPath,
            confirm: confirmDialog,
            guidedCloudflare: true,
            onOpenAdminSettings: openSettings,
        });

        sendProgress('Registering this PC as Host…');
        const claim = await hostLease.claimHost({ takeover: true });
        if (!claim.ok && claim.status === 409) {
            const again = await resolveHostConflictOrProceed(sendProgress);
            if (again !== 'host') {
                await tearDownLocalHosting({ releaseLease: false });
                setConfig({ mode: 'client', setupComplete: true });
                progressWin.close();
                rebuildContextMenu().catch(() => {});
                await openSettings();
                return { ok: true, mode: 'client' };
            }
            await hostLease.claimHost({ takeover: true });
        }

        setConfig({ setupComplete: true, mode: 'host', openAtLogin: true });
        hostServerPhase = 'running';
        startHostHeartbeat();
        startHostWatchdog();
        try {
            await host.ensureServerRunning({ waitMs: 45000 });
        } catch {
            /* ignore */
        }
        progressWin.close();

        const cfOk = result.cloudflare && result.cloudflare.ok !== false;
        await dialog.showMessageBox({
            type: 'info',
            message: 'This PC is now Host',
            detail: [
                `Server folder: ${result.serverDir}`,
                secretsPath ? 'Secrets pack imported.' : 'No secrets pack selected.',
                cfOk
                    ? 'Cloudflare tunnel is configured.'
                    : 'Cloudflare may need tray → Setup Cloudflare tunnel (Admin once).',
                'Opening Admin on this PC now.',
            ].join('\n'),
        });
        rebuildContextMenu().catch(() => {});
        refreshTrayStatus().catch(() => {});
        await openSettings();
        return { ok: true, mode: 'host' };
    } catch (err) {
        try {
            await tearDownLocalHosting({ releaseLease: false });
        } catch {
            /* ignore */
        }
        setConfig({ setupComplete: true, mode: 'client' });
        try {
            progressWin.close();
        } catch {
            /* ignore */
        }
        await dialog.showErrorBox('Become Host failed', String(err.message || err));
        rebuildContextMenu().catch(() => {});
        refreshTrayStatus().catch(() => {});
        return { ok: false, error: String(err.message || err) };
    }
}

async function exportHostSecretsFromTray() {
    const cfg = getConfig();
    if (cfg.mode !== 'host') {
        await dialog.showErrorBox('Export secrets', 'Only available in Host mode.');
        return { ok: false };
    }
    const serverDir = cfg.serverDir || host.defaultServerDir();
    const defaultOut = path.join(os.homedir(), 'Desktop', 'Taco Bell Dashboard Pack', 'secrets');
    try {
        const result = secretsPack.exportSecretsPack(serverDir, defaultOut);
        await shell.openPath(result.outRoot);
        await dialog.showMessageBox({
            type: 'info',
            message: 'Secrets pack exported',
            detail: [
                result.outRoot,
                '',
                'Keep this folder private. Copy the installer into the parent folder when sharing a Host pack.',
            ].join('\n'),
        });
        return result;
    } catch (err) {
        await dialog.showErrorBox('Export failed', String(err.message || err));
        return { ok: false, error: String(err.message || err) };
    }
}

function startHostHeartbeat() {
    stopHostHeartbeat();
    const tick = async () => {
        const cfg = getConfig();
        if (cfg.mode !== 'host') {
            stopHostHeartbeat();
            return;
        }
        try {
            const result = await hostLease.heartbeatHost();
            if (!result.ok && result.body?.demoted) {
                await demoteToClient(result.body.demotionMessage);
            }
        } catch {
            /* offline briefly — keep trying */
        }
    };
    tick();
    hostHeartbeatTimer = setInterval(tick, 45000);
}

/**
 * @returns {'host'|'client'|null} null = user cancelled
 */
async function resolveHostConflictOrProceed(sendProgress) {
    sendProgress('Checking if another Host is already online…');
    const status = await hostLease.getHostStatus(DEFAULT_SERVER_URL);
    const identity = hostLease.hostIdentity();

    if (status.unreachable) {
        sendProgress('Could not reach tbadashboard.com — continuing as Host on this PC');
        return 'host';
    }

    if (!status.hasActiveHost || !status.lease) {
        sendProgress('No active Host found — this PC will become Host');
        return 'host';
    }

    if (status.lease.hostId === identity.hostId) {
        sendProgress('This PC is already the registered Host');
        return 'host';
    }

    const other = status.lease.displayName || status.lease.hostname || 'Another PC';
    const { response } = await dialog.showMessageBox({
        type: 'warning',
        buttons: ['Become a Client instead', 'Take over hosting', 'Cancel'],
        defaultId: 0,
        cancelId: 2,
        title: 'A Host is already running',
        message: `${other} is already the Host`,
        detail: [
            'Only one PC should host at a time.',
            '',
            '• Become a Client — recommended if you just need access',
            '• Take over hosting — moves hosting here and tells the other PC to switch to Client',
        ].join('\n'),
    });

    if (response === 2) return null;
    if (response === 0) return 'client';

    sendProgress(`Taking over hosting from ${other}…`);
    const claim = await hostLease.claimHost({ takeover: true });
    if (!claim.ok) {
        throw new Error(claim.body?.error || 'Could not take over hosting');
    }
    sendProgress('Takeover registered — the previous Host will be notified');
    return 'host';
}

async function ensureHostServerOnLaunch() {
    const cfg = getConfig();
    if (cfg.mode !== 'host' || !cfg.setupComplete) return;

    hostServerPhase = 'starting';
    refreshTrayStatus().catch(() => {});
    notifyTray('Live Dashboard', 'Checking Host server…');

    if (cfg.autoUpdateFromGitOnLaunch !== false) {
        try {
            notifyTray('Live Dashboard', 'Checking Git for server updates…');
            const sync = await host.syncFromGitIfBehind();
            if (sync.updated) {
                showOperatorNotice({
                    title: 'Server updated from Git',
                    body: `Pulled ${sync.branch} and restarted the Host server.`,
                });
            }
        } catch (err) {
            console.warn('[desktop] syncFromGitIfBehind', err);
            // Fail open — still try to start whatever is already on disk.
        }
    }

    try {
        const result = await host.ensureServerRunning({ waitMs: 15000 });
        if (result.already) {
            hostServerPhase = 'running';
        } else if (result.health?.ok) {
            hostServerPhase = 'running';
            showOperatorNotice({
                title: 'Host server started',
                body: 'Dashboard server was down after launch and has been started.',
            });
        } else {
            hostServerPhase = 'error';
            showOperatorNotice({
                title: 'Host server not responding',
                body: 'Tried to start the server but it is not healthy yet. Use tray → Start server, or Easy Host repair.',
            });
        }
    } catch (err) {
        hostServerPhase = 'error';
        showOperatorNotice({
            title: 'Could not start Host server',
            body: String(err.message || err),
        });
    }

    // Same recovery path as install: user-mode Cloudflare tunnel + Startup persistence.
    try {
        await cloudflare.ensureHostTunnelRunning({
            onProgress: (msg) => console.log('[desktop]', msg),
        });
    } catch (err) {
        console.warn('[desktop] ensureHostTunnelRunning', err);
        showOperatorNotice({
            title: 'Cloudflare tunnel not running',
            body: `${err.message || err}\n\nUse tray → Setup Cloudflare tunnel…`,
        });
    }

    rebuildContextMenu().catch(() => {});
    refreshTrayStatus().catch(() => {});
}

async function buildStatusSummary() {
    const cfg = getConfig();
    const isHost = cfg.mode === 'host';
    const identity = hostLease.hostIdentity();

    let serverLabel = 'Server: —';
    let tunnelLabel = 'Tunnel: —';
    let leaseLabel = 'Lease: —';
    let siteLabel = 'Site: —';
    let tooltip = 'Live Dashboard';

    if (isHost) {
        if (hostServerPhase === 'starting') {
            serverLabel = 'Server: starting…';
        } else {
            try {
                const st = await host.getHostStatus();
                serverLabel = st.localHealthy ? 'Server: running' : 'Server: stopped';
                if (st.localHealthy) hostServerPhase = 'running';
                else if (hostServerPhase !== 'starting') hostServerPhase = 'stopped';
            } catch {
                serverLabel = 'Server: error';
                hostServerPhase = 'error';
            }
        }

        try {
            const cf = await cloudflare.getCloudflareStatus();
            if (cf.pidRunning) {
                tunnelLabel = cf.startupInstalled
                    ? 'Tunnel: running (Startup)'
                    : 'Tunnel: running';
            } else if (cf.service?.running) {
                tunnelLabel = 'Tunnel: system service (use Setup Cloudflare)';
            } else {
                tunnelLabel = 'Tunnel: stopped';
            }
        } catch {
            tunnelLabel = 'Tunnel: unknown';
        }

        try {
            const status = await hostLease.getHostStatus();
            if (status.unreachable) {
                leaseLabel = 'Lease: unreachable';
            } else if (status.hasActiveHost && status.lease) {
                const name = status.lease.displayName || status.lease.hostname || 'Host';
                const mine = status.lease.hostId === identity.hostId;
                leaseLabel = mine ? `Lease: this PC (${name})` : `Lease: ${name}`;
            } else {
                leaseLabel = 'Lease: no active Host';
            }
        } catch {
            leaseLabel = 'Lease: unknown';
        }

        tooltip = ['Live Dashboard (Host)', serverLabel, tunnelLabel, leaseLabel].join('\n');
    } else {
        try {
            const status = await hostLease.getHostStatus(cfg.serverUrl || DEFAULT_SERVER_URL);
            if (status.unreachable) {
                siteLabel = 'Site: offline / unreachable';
                leaseLabel = 'Host: unknown';
            } else {
                siteLabel = 'Site: reachable';
                if (status.hasActiveHost && status.lease) {
                    leaseLabel = `Host: ${status.lease.displayName || status.lease.hostname || 'active'}`;
                } else {
                    leaseLabel = 'Host: none registered';
                }
            }
        } catch {
            siteLabel = 'Site: offline / unreachable';
            leaseLabel = 'Host: unknown';
        }
        tooltip = ['Live Dashboard (Client)', siteLabel, leaseLabel].join('\n');
    }

    return {
        isHost,
        serverLabel,
        tunnelLabel,
        leaseLabel,
        siteLabel,
        tooltip,
        hostServerPhase,
    };
}

async function refreshTrayStatus() {
    const summary = await buildStatusSummary();
    setTrayTooltip(summary.tooltip);
    return summary;
}

function startStatusPolling() {
    if (statusPollTimer) return;
    statusPollTimer = setInterval(() => {
        refreshTrayStatus().catch(() => {});
        rebuildContextMenu().catch(() => {});
    }, 30000);
    refreshTrayStatus().catch(() => {});
}

function registerIpc() {
    ipcMain.handle('setup:get', () => ({
        ...getConfig(),
        defaultServerUrl: DEFAULT_SERVER_URL,
        defaultServerDir: host.defaultServerDir(),
        suggestedSecretsFolder: secretsPack.suggestSecretsFolders()[0] || null,
    }));

    ipcMain.handle('setup:suggestSecretsFolder', () => secretsPack.suggestSecretsFolders()[0] || null);

    ipcMain.handle('setup:pickSecretsFolder', async (_event, defaultPath) => {
        const suggestions = secretsPack.suggestSecretsFolders();
        const result = await dialog.showOpenDialog({
            title: 'Select Host secrets folder',
            message: 'Choose the secrets folder from your Taco Bell Dashboard Pack',
            defaultPath:
                String(defaultPath || '').trim() ||
                suggestions[0] ||
                path.join(os.homedir(), 'Desktop'),
            properties: ['openDirectory'],
        });
        if (result.canceled || !result.filePaths?.[0]) return null;
        const resolved = secretsPack.resolveSecretsRoot(result.filePaths[0]);
        if (!secretsPack.looksLikeSecretsPack(resolved)) {
            const { response } = await dialog.showMessageBox({
                type: 'warning',
                buttons: ['Use this folder anyway', 'Cancel'],
                defaultId: 1,
                cancelId: 1,
                title: 'Folder looks incomplete',
                message: 'This does not look like a secrets pack',
                detail:
                    'Expected a folder with .env / env.txt and store-logins or accounts. Continue only if you know this is correct.',
            });
            if (response !== 0) return null;
        }
        return resolved;
    });

    ipcMain.handle('setup:complete', async (_event, payload) => {
        let mode = payload?.mode === 'host' ? 'host' : 'client';
        const secretsPath = mode === 'host' ? String(payload?.secretsPath || '').trim() || null : null;
        const sendProgress = (msg) => {
            if (wizardWindow && !wizardWindow.isDestroyed()) {
                wizardWindow.webContents.send('setup:progress', String(msg || ''));
            }
        };

        applyOpenAtLogin(true);
        hostLease.ensureHostId();

        if (mode === 'host') {
            const decision = await resolveHostConflictOrProceed(sendProgress);
            if (decision === null) {
                throw new Error('Setup cancelled');
            }
            if (decision === 'client') {
                mode = 'client';
                sendProgress('Switching to Client mode…');
            }
        }

        if (mode === 'client') {
            await bootstrap.runClientBootstrap({ onProgress: sendProgress });
            sendProgress('Opening Settings…');
            await openSettings();
            if (wizardWindow && !wizardWindow.isDestroyed()) {
                wizardWindow.close();
            }
            rebuildContextMenu().catch(() => {});
            return getConfig();
        }

        setConfig({
            mode: 'host',
            serverUrl: DEFAULT_SERVER_URL,
            openAtLogin: true,
            serverDir: host.defaultServerDir(),
            setupComplete: false,
        });

        try {
            sendProgress('This may take several minutes the first time…');
            const result = await bootstrap.runHostBootstrap({
                onProgress: sendProgress,
                setupCloudflare: true,
                secretsPath,
                confirm: confirmDialog,
                guidedCloudflare: true,
            });

            sendProgress('Registering this PC as Host…');
            const claim = await hostLease.claimHost({ takeover: true });
            if (!claim.ok && claim.status === 409) {
                const again = await resolveHostConflictOrProceed(sendProgress);
                if (again !== 'host') {
                    await tearDownLocalHosting({ releaseLease: false });
                    setConfig({ mode: 'client', setupComplete: true });
                    if (wizardWindow && !wizardWindow.isDestroyed()) wizardWindow.close();
                    openSettings();
                    return getConfig();
                }
                await hostLease.claimHost({ takeover: true });
            }

            setConfig({ setupComplete: true, mode: 'host', openAtLogin: true });
            hostServerPhase = 'running';
            startHostHeartbeat();
            startHostWatchdog();

            sendProgress('Making sure Admin can open on this PC…');
            try {
                await host.ensureServerRunning({ waitMs: 45000 });
            } catch (err) {
                console.warn('[desktop] post-setup ensureServerRunning', err);
            }

            const cfOk = result.cloudflare && result.cloudflare.ok !== false;
            const secretsNote = secretsPath
                ? 'Host secrets were imported from your pack.'
                : 'No secrets pack was selected — set store logins in Admin if needed.';
            dialog.showMessageBox({
                type: 'info',
                message: 'Setup complete',
                detail: [
                    'This PC is the Host.',
                    `Server folder: ${result.serverDir}`,
                    secretsNote,
                    cfOk
                        ? 'Cloudflare tunnel walkthrough finished.'
                        : 'Cloudflare was skipped or needs tray → Setup Cloudflare tunnel…',
                    'Admin Settings will stay open on this PC.',
                ].join('\n'),
            });
        } catch (err) {
            setConfig({ setupComplete: false });
            throw err;
        }

        // Open Admin first so a window is visible, then close the wizard.
        await openSettings();
        if (wizardWindow && !wizardWindow.isDestroyed()) {
            wizardWindow.close();
        }
        rebuildContextMenu().catch(() => {});
        refreshTrayStatus().catch(() => {});
        return getConfig();
    });

    ipcMain.handle('app:status', async () => {
        const cfg = getConfig();
        const hostStatus = cfg.mode === 'host' ? await host.getHostStatus().catch(() => null) : null;
        const cfStatus = cfg.mode === 'host' ? await cloudflare.getCloudflareStatus().catch(() => null) : null;
        const summary = await buildStatusSummary().catch(() => null);
        return {
            ...cfg,
            hostStatus,
            cloudflare: cfStatus,
            statusSummary: summary,
            settingsUrl: settingsUrl(cfg),
            dashboardUrl: dashboardUrl(cfg),
        };
    });

    ipcMain.handle('cloudflare:setup', async () => {
        const cfg = getConfig();
        let hostname = cloudflare.DEFAULT_HOSTNAME;
        try {
            hostname = new URL(cfg.serverUrl || 'https://tbadashboard.com').hostname;
        } catch {
            /* keep default */
        }
        return cloudflare.setupCloudflareTunnel({ hostname });
    });

    ipcMain.handle('cloudflare:status', async () => cloudflare.getCloudflareStatus());
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
    app.quit();
} else {
    app.on('second-instance', () => openSettings());

    app.whenReady().then(async () => {
        registerIpc();
        configureUpdater();

        await ensureUpToDateBeforeLaunch();

        const cfg = getConfig();
        applyOpenAtLogin(cfg.openAtLogin);
        createTray({
            openSettings,
            onStopHosting: () => stopHostingBecomeClient(),
            onBecomeHost: () => becomeHostFromTray(),
            onExportSecrets: () => exportHostSecretsFromTray(),
            getStatusSummary: () => buildStatusSummary(),
        });

        if (!cfg.setupComplete) {
            createWizardWindow();
        } else {
            startLiveWatch();
            hostLease.ensureHostId();
            startStatusPolling();
            if (cfg.mode === 'host') {
                startHostHeartbeat();
                // Server first, then tunnel, then Admin — avoids refused-connection flash.
                try {
                    await ensureHostServerOnLaunch();
                } catch (err) {
                    console.warn('[desktop] ensureHostServerOnLaunch', err);
                }
                startHostWatchdog();
            }
            await openSettings().catch(() => {});
            refreshTrayStatus().catch(() => {});
        }

        app.on('activate', () => openSettings());
    });

    app.on('window-all-closed', () => {
        // Keep the tray process alive on Windows when all windows are closed.
        // Host Quit leaves PM2/server + Cloudflare running; lease goes stale without heartbeats.
        // Use tray → Stop hosting to tear down CF, stop the server, and release the lease.
    });
}
