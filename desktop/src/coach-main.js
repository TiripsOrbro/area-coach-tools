const { app, BrowserWindow, ipcMain, Menu, shell } = require('electron');
const path = require('path');
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

function preload() {
    return path.join(__dirname, 'coach-preload.js');
}

function createLoginWindow() {
    if (loginWindow && !loginWindow.isDestroyed()) {
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
    // Expand empty list to all region stores from storelist (e.g. Tom → VIC)
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
        mmx: {
            username: profile.mmx?.username || '',
            password: profile.mmx?.password || '',
        },
        lifelenz: {
            email: profile.lifelenz?.email || '',
            password: profile.lifelenz?.password || '',
        },
    });
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
    const menu = Menu.buildFromTemplate([
        {
            label: 'Account',
            submenu: [
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
            ],
        },
        {
            label: 'View',
            submenu: [
                { role: 'reload' },
                { role: 'toggleDevTools' },
                { type: 'separator' },
                {
                    label: 'Open in browser',
                    click: () => shell.openExternal(localServer.adminUrl()),
                },
            ],
        },
    ]);
    toolsWindow.setMenu(menu);
    toolsWindow.loadURL(url);
    toolsWindow.once('ready-to-show', () => toolsWindow.show());
    toolsWindow.on('closed', () => {
        toolsWindow = null;
    });
    if (loginWindow && !loginWindow.isDestroyed()) loginWindow.close();
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
    if (toolsWindow && !toolsWindow.isDestroyed()) toolsWindow.close();
    if (accountWindow && !accountWindow.isDestroyed()) accountWindow.close();
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
        if (toolsWindow && !toolsWindow.isDestroyed()) {
            toolsWindow.show();
            toolsWindow.focus();
        } else if (loginWindow && !loginWindow.isDestroyed()) {
            loginWindow.focus();
        } else {
            createLoginWindow();
        }
    });

    app.whenReady().then(async () => {
        userStore.applySeedIfNeeded();
        registerIpc();
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

    app.on('window-all-closed', () => {
        if (process.platform !== 'darwin') app.quit();
    });

    app.on('before-quit', () => {
        localServer.stopLocalServer().catch(() => {});
    });
}
