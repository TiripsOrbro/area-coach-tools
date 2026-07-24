const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const userStore = require('./userStore');
const localServer = require('./localServer');
const coachSessionPath = () => {
    // Write active coach into server store after PROJECT_ROOT is set
    const root = localServer.serverRoot();
    return path.join(root, 'stores', 'src', 'coachSession.js');
};

let loginWindow = null;
let toolsWindow = null;
let accountWindow = null;
let tray = null;
/** When true, window close / Quit actually exits the app. */
let isQuitting = false;
let trayHintShown = false;

function quitApp() {
    isQuitting = true;
    app.quit();
}

/** Pull latest from Git (Install-AreaCoachTools.ps1), then relaunch; falls back to Electron relaunch. */
function runUpdateAndRestart() {
    const root = localServer.serverRoot();
    const ps1 = path.join(root, 'Install-AreaCoachTools.ps1');
    const launchCmd = path.join(root, 'Launch-AreaCoachTools.cmd');

    const choice = dialog.showMessageBoxSync({
        type: 'question',
        buttons: ['Update & restart', 'Cancel'],
        defaultId: 0,
        cancelId: 1,
        title: 'Update Area Coach Tools',
        message: 'Check for updates and restart?',
        detail: 'The app will close, pull the latest changes, then reopen.',
    });
    if (choice !== 0) return;

    try {
        if (fs.existsSync(ps1)) {
            const child = spawn(
                'powershell.exe',
                [
                    '-NoProfile',
                    '-ExecutionPolicy',
                    'Bypass',
                    '-File',
                    ps1,
                    '-InstallDir',
                    root,
                    '-Quiet',
                    '-Launch',
                ],
                { cwd: root, detached: true, stdio: 'ignore', windowsHide: false }
            );
            child.unref();
            quitApp();
            return;
        }
        if (fs.existsSync(launchCmd)) {
            const child = spawn(launchCmd, [], {
                cwd: root,
                detached: true,
                stdio: 'ignore',
                shell: true,
                windowsHide: false,
            });
            child.unref();
            quitApp();
            return;
        }
    } catch (err) {
        dialog.showErrorBox(
            'Update failed',
            err?.message || String(err) || 'Could not start the updater.'
        );
        return;
    }

    // Dev / unpackaged fallback when installer scripts are missing
    isQuitting = true;
    app.relaunch();
    app.quit();
}

function accountMenuItems() {
    return [
        {
            label: 'Account settings…',
            click: () => createAccountWindow(),
        },
        {
            label: 'Switch user (log out)',
            click: async () => {
                await logoutFlow();
            },
        },
    ];
}

function viewMenuItems() {
    return [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        {
            label: 'Open in browser',
            click: () => shell.openExternal(localServer.adminUrl()),
        },
    ];
}

function buildTrayMenuTemplate() {
    return [
        {
            label: 'Open Area Coach Tools',
            click: () => showMainWindow(),
        },
        { type: 'separator' },
        {
            label: 'Account',
            submenu: accountMenuItems(),
        },
        {
            label: 'View',
            submenu: viewMenuItems(),
        },
        { type: 'separator' },
        {
            label: 'Update',
            click: () => runUpdateAndRestart(),
        },
        {
            label: 'Exit',
            click: () => quitApp(),
        },
    ];
}

function focusedToolsWindow() {
    if (toolsWindow && !toolsWindow.isDestroyed()) return toolsWindow;
    return BrowserWindow.getFocusedWindow();
}

function preload() {
    return path.join(__dirname, 'coach-preload.js');
}

function trayIcon() {
    const png = path.join(__dirname, '..', 'build', 'icon.png');
    const ico = path.join(__dirname, '..', 'build', 'icon.ico');
    let img = nativeImage.createFromPath(png);
    if (img.isEmpty()) img = nativeImage.createFromPath(ico);
    if (img.isEmpty()) return nativeImage.createEmpty();
    return img.resize({ width: 16, height: 16 });
}

function showMainWindow() {
    if (toolsWindow && !toolsWindow.isDestroyed()) {
        if (toolsWindow.isMinimized()) toolsWindow.restore();
        toolsWindow.show();
        toolsWindow.focus();
        return;
    }
    if (loginWindow && !loginWindow.isDestroyed()) {
        loginWindow.show();
        loginWindow.focus();
        return;
    }
    const active = userStore.getActiveUserId();
    if (active) {
        openToolsWindow().catch(() => createLoginWindow());
    } else {
        createLoginWindow();
    }
}

function bindCloseToTray(win) {
    if (!win || win.isDestroyed()) return;
    win.on('close', (e) => {
        if (isQuitting || win.__forceClose) return;
        e.preventDefault();
        win.hide();
        if (!trayHintShown && tray && !tray.isDestroyed()) {
            trayHintShown = true;
            try {
                tray.displayBalloon({
                    title: 'Area Coach Tools',
                    content: 'Still running in the tray. Right-click the icon to Exit.',
                    iconType: 'info',
                });
            } catch {
                /* balloon optional */
            }
        }
    });
}

function forceCloseWindow(win) {
    if (!win || win.isDestroyed()) return;
    win.__forceClose = true;
    win.close();
}

function createTray() {
    if (tray && !tray.isDestroyed()) return tray;
    tray = new Tray(trayIcon());
    tray.setToolTip('Area Coach Tools');
    tray.setContextMenu(Menu.buildFromTemplate(buildTrayMenuTemplate()));
    tray.on('click', () => showMainWindow());
    tray.on('double-click', () => showMainWindow());
    return tray;
}

function createLoginWindow() {
    if (loginWindow && !loginWindow.isDestroyed()) {
        loginWindow.show();
        loginWindow.focus();
        return loginWindow;
    }
    loginWindow = new BrowserWindow({
        width: 480,
        height: 560,
        resizable: false,
        title: 'Area Coach Tools',
        webPreferences: {
            preload: preload(),
            contextIsolation: true,
            nodeIntegration: false,
        },
        show: false,
    });
    loginWindow.removeMenu();
    loginWindow.loadFile(path.join(__dirname, 'login.html'));
    loginWindow.once('ready-to-show', () => loginWindow.show());
    bindCloseToTray(loginWindow);
    loginWindow.on('closed', () => {
        loginWindow = null;
    });
    return loginWindow;
}

function createAccountWindow() {
    if (accountWindow && !accountWindow.isDestroyed()) {
        accountWindow.focus();
        return accountWindow;
    }
    accountWindow = new BrowserWindow({
        width: 620,
        height: 720,
        title: 'Account — Area Coach Tools',
        webPreferences: {
            preload: preload(),
            contextIsolation: true,
            nodeIntegration: false,
        },
        show: false,
    });
    accountWindow.removeMenu();
    accountWindow.loadFile(path.join(__dirname, 'account.html'));
    accountWindow.once('ready-to-show', () => accountWindow.show());
    // Account is a helper dialog — closing it should not quit or hide the app.
    accountWindow.on('closed', () => {
        accountWindow = null;
    });
    return accountWindow;
}

async function ensureServer() {
    return localServer.startLocalServer(Number(process.env.PORT || 3100));
}

function syncCoachSession(profile) {
    const root = localServer.serverRoot();
    process.env.PROJECT_ROOT = root;
    const coachSession = require(coachSessionPath());
    let enabledStores = Array.isArray(profile.enabledStores) ? profile.enabledStores.map(String) : [];
    // Expand empty list to all region stores from storelist (e.g. VIC / Taco Bell)
    if (!enabledStores.length) {
        try {
            const { defaultEnabledStores } = require(path.join(root, 'stores', 'src', 'coachScope.js'));
            enabledStores = defaultEnabledStores(profile.id);
            if (enabledStores.length) {
                userStore.saveProfile(profile.id, { enabledStores });
            }
        } catch {
            /* keep empty */
        }
    }
    coachSession.writeSession({
        userId: profile.id,
        displayName: profile.displayName,
        region: profile.region || null,
        enabledStores,
        alertEmail: profile.alertEmail || '',
        downloadFolder: profile.downloadFolder || '',
        mmx: {
            username: profile.mmx?.username || '',
            password: profile.mmx?.password || '',
        },
        lifelenz: {
            email: profile.lifelenz?.email || '',
            password: profile.lifelenz?.password || '',
        },
    });
    const folder = String(profile.downloadFolder || '').trim();
    if (folder) process.env.ACT_DOWNLOAD_FOLDER = folder;
    else delete process.env.ACT_DOWNLOAD_FOLDER;

    // Gmail SMTP for Prep Guide / shortfall / alert emails (Account settings)
    const gmailEmail = String(profile.gmail?.email || '').trim();
    const gmailPass = String(profile.gmail?.password || '');
    if (gmailEmail && gmailPass && gmailPass !== '********') {
        process.env.DASHBOARD_SMTP_HOST = process.env.DASHBOARD_SMTP_HOST || 'smtp.gmail.com';
        process.env.DASHBOARD_SMTP_PORT = process.env.DASHBOARD_SMTP_PORT || '587';
        process.env.DASHBOARD_SMTP_USER = gmailEmail;
        process.env.DASHBOARD_SMTP_PASS = gmailPass;
        if (!process.env.DASHBOARD_SMTP_FROM) process.env.DASHBOARD_SMTP_FROM = gmailEmail;
    }
}

async function openToolsWindow() {
    await ensureServer();
    const url = localServer.adminUrl();
    if (toolsWindow && !toolsWindow.isDestroyed()) {
        toolsWindow.loadURL(url);
        toolsWindow.show();
        toolsWindow.focus();
        return toolsWindow;
    }
    toolsWindow = new BrowserWindow({
        width: 1280,
        height: 860,
        title: 'Area Coach Tools',
        webPreferences: {
            preload: preload(),
            contextIsolation: true,
            nodeIntegration: false,
        },
        show: false,
    });
    // Account / View / Update / Exit live in the in-app sidebar (and tray).
    toolsWindow.removeMenu();
    toolsWindow.loadURL(url);
    toolsWindow.once('ready-to-show', () => toolsWindow.show());
    bindCloseToTray(toolsWindow);
    toolsWindow.on('closed', () => {
        toolsWindow = null;
    });
    if (loginWindow && !loginWindow.isDestroyed()) forceCloseWindow(loginWindow);
    return toolsWindow;
}

async function logoutFlow() {
    userStore.clearActiveUser();
    try {
        const coachSession = require(coachSessionPath());
        coachSession.clearSession();
    } catch {
        /* ignore */
    }
    if (toolsWindow && !toolsWindow.isDestroyed()) forceCloseWindow(toolsWindow);
    if (accountWindow && !accountWindow.isDestroyed()) forceCloseWindow(accountWindow);
    createLoginWindow();
}

function registerIpc() {
    ipcMain.handle('coach:listUsers', () => ({ success: true, users: userStore.listUsers() }));

    ipcMain.handle('coach:login', async (_e, userId) => {
        try {
            await ensureServer();
            const profile = userStore.setActiveUser(userId);
            syncCoachSession(profile);
            return {
                success: true,
                userId: profile.id,
                displayName: profile.displayName,
                needsCredentials: !(profile.mmx?.username && profile.mmx?.password),
            };
        } catch (err) {
            return { success: false, error: err.message || String(err) };
        }
    });

    ipcMain.handle('coach:logout', async () => {
        await logoutFlow();
        return { success: true };
    });

    ipcMain.handle('coach:getActive', () => {
        const id = userStore.getActiveUserId();
        if (!id) return null;
        const p = userStore.getProfile(id);
        return p
            ? {
                  userId: p.id,
                  displayName: p.displayName,
                  region: p.region,
                  enabledStores: p.enabledStores || [],
              }
            : null;
    });

    ipcMain.handle('coach:getCredentials', (_e, userId) => {
        return userStore.getProfileMasked(userId || userStore.getActiveUserId());
    });

    ipcMain.handle('coach:listRegionStores', async (_e, userId) => {
        await ensureServer();
        const root = localServer.serverRoot();
        const id = userId || userStore.getActiveUserId();
        const { regionStoresForAccount } = require(path.join(root, 'stores', 'src', 'coachScope.js'));
        return { success: true, stores: regionStoresForAccount(id) };
    });

    ipcMain.handle('coach:saveCredentials', (_e, userId, payload) => {
        const id = userId || userStore.getActiveUserId();
        const masked = userStore.saveProfile(id, payload || {});
        const profile = userStore.getProfile(id);
        if (userStore.getActiveUserId() === id) {
            syncCoachSession(profile);
        }
        return { success: true, profile: masked };
    });

    ipcMain.handle('coach:pickDownloadFolder', async () => {
        const win = BrowserWindow.getFocusedWindow() || accountWindow;
        const result = await dialog.showOpenDialog(win || undefined, {
            title: 'Choose Build-to download folder',
            properties: ['openDirectory', 'createDirectory'],
        });
        if (result.canceled || !result.filePaths?.[0]) {
            return { success: false, canceled: true };
        }
        return { success: true, path: result.filePaths[0] };
    });

    ipcMain.handle('coach:getStoreEmails', () => ({
        success: true,
        emails: userStore.getStoreEmails(),
    }));

    ipcMain.handle('coach:setStoreEmails', (_e, map) => {
        const emails = userStore.setStoreEmails(map || {});
        // Mirror onto server disk for schedulers
        try {
            const root = localServer.serverRoot();
            const storeEmails = require(path.join(root, 'dashboard', 'src', 'storeEmails.js'));
            storeEmails.writeAll(emails);
        } catch (err) {
            console.warn('[coach] mirror store emails failed:', err.message);
        }
        return { success: true, emails };
    });

    ipcMain.handle('coach:openTools', async () => {
        await openToolsWindow();
        return { success: true };
    });

    ipcMain.handle('coach:openAccount', () => {
        createAccountWindow();
        return { success: true };
    });

    ipcMain.handle('coach:updateAndRestart', () => {
        runUpdateAndRestart();
        return { success: true };
    });

    ipcMain.handle('coach:exit', () => {
        quitApp();
        return { success: true };
    });

    ipcMain.handle('coach:reload', () => {
        const win = focusedToolsWindow();
        if (win && !win.isDestroyed()) win.webContents.reload();
        return { success: true };
    });

    ipcMain.handle('coach:toggleDevTools', () => {
        const win = focusedToolsWindow();
        if (win && !win.isDestroyed()) win.webContents.toggleDevTools();
        return { success: true };
    });

    ipcMain.handle('coach:openInBrowser', () => {
        shell.openExternal(localServer.adminUrl());
        return { success: true };
    });

    ipcMain.handle('coach:status', () => ({
        success: true,
        port: localServer.getPort(),
        adminUrl: localServer.adminUrl(),
        serverRoot: localServer.serverRoot(),
        activeUserId: userStore.getActiveUserId(),
    }));
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
    app.quit();
} else {
    app.on('second-instance', () => {
        showMainWindow();
    });

    app.whenReady().then(async () => {
        userStore.applySeedIfNeeded();
        registerIpc();
        createTray();
        try {
            await ensureServer();
        } catch (err) {
            console.error('[Area Coach Tools] server start failed:', err);
        }
        const active = userStore.getActiveUserId();
        if (active) {
            const profile = userStore.getProfile(active);
            if (profile) {
                try {
                    syncCoachSession(profile);
                } catch {
                    /* ignore */
                }
                await openToolsWindow();
                return;
            }
        }
        createLoginWindow();
    });

    // Stay alive in the tray when all windows are hidden/closed.
    app.on('window-all-closed', () => {
        /* no-op — Exit from the menu/tray sets isQuitting and calls app.quit() */
    });

    app.on('before-quit', () => {
        isQuitting = true;
        localServer.stopLocalServer().catch(() => {});
    });
}
