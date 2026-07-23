const { autoUpdater } = require('electron-updater');
const { app, dialog, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

let configured = false;
/** When true, downloaded updates install immediately (no Later prompt). */
let launchGateActive = false;
/** When true, tray "Update tray app" shows the splash and download progress. */
let manualCheckActive = false;
let splashIpcReady = false;
let splashWindow = null;
let quitAndInstallStarted = false;

function requestQuitAndInstall() {
    if (quitAndInstallStarted) return;
    quitAndInstallStarted = true;
    autoUpdater.quitAndInstall(false, true);
}

function parseVersionParts(version) {
    return String(version || '')
        .trim()
        .replace(/^v/i, '')
        .split(/[.+-]/)
        .map((part) => {
            const n = parseInt(part, 10);
            return Number.isFinite(n) ? n : 0;
        });
}

function isNewerVersion(remoteVersion, localVersion) {
    const remote = parseVersionParts(remoteVersion);
    const local = parseVersionParts(localVersion);
    const len = Math.max(remote.length, local.length);
    for (let i = 0; i < len; i += 1) {
        const a = remote[i] || 0;
        const b = local[i] || 0;
        if (a > b) return true;
        if (a < b) return false;
    }
    return false;
}

function ensureSplashIpc() {
    if (splashIpcReady) return;
    splashIpcReady = true;
    ipcMain.on('update-splash-close', () => {
        manualCheckActive = false;
        closeSplashWindow();
    });
}

function createSplashWindow() {
    ensureSplashIpc();
    if (splashWindow && !splashWindow.isDestroyed()) return splashWindow;
    splashWindow = new BrowserWindow({
        width: 400,
        height: 240,
        resizable: false,
        maximizable: false,
        minimizable: false,
        fullscreenable: false,
        frame: true,
        title: 'Taco Bell Dashboard',
        show: false,
        autoHideMenuBar: true,
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            preload: path.join(__dirname, 'update-splash-preload.js'),
        },
    });
    splashWindow.removeMenu();
    splashWindow.loadFile(path.join(__dirname, 'update-splash.html'));
    splashWindow.once('ready-to-show', () => {
        if (splashWindow && !splashWindow.isDestroyed()) splashWindow.show();
    });
    splashWindow.on('closed', () => {
        splashWindow = null;
    });
    return splashWindow;
}

function setSplashView(opts = {}) {
    if (!splashWindow || splashWindow.isDestroyed()) return;
    splashWindow.webContents
        .executeJavaScript(`window.setUpdateView(${JSON.stringify(opts)})`)
        .catch(() => {});
}

function setSplashStatus(text, percent) {
    const hasPercent = typeof percent === 'number' && Number.isFinite(percent);
    setSplashView({
        status: String(text || ''),
        showBar: hasPercent,
        percent: hasPercent ? percent : null,
    });
}

function showManualUpdateFound(version) {
    setSplashView({
        headline: 'Update Found',
        status: `Downloading version ${version}…`,
        showBar: true,
        percent: 0,
        showClose: false,
    });
}

function showManualUpdateInstalled(version) {
    manualCheckActive = false;
    setSplashView({
        headline: 'Update installed',
        status: `Version ${version} is ready. Restart when convenient.`,
        showBar: false,
        showClose: true,
    });
}

function showManualUpToDate(localVersion) {
    manualCheckActive = false;
    setSplashView({
        headline: 'Up to date',
        status: `Taco Bell Dashboard ${localVersion} is current.`,
        showBar: false,
        showClose: true,
    });
}

function closeSplashWindow() {
    if (splashWindow && !splashWindow.isDestroyed()) {
        splashWindow.close();
    }
    splashWindow = null;
}

/** Reusable splash for tray actions (Git server sync, etc.). */
async function openProgressSplash(opts = {}) {
    createSplashWindow();
    await new Promise((r) => setTimeout(r, 200));
    setSplashView({
        headline: opts.headline || 'Taco Bell Dashboard',
        status: opts.status || 'Working…',
        showBar: false,
        showClose: false,
    });
}

function setProgressSplash(opts = {}) {
    setSplashView(opts);
}

/** Local electron-builder output — packaged, but not a real install (no app-update.yml). */
function isLocalUnpackedDist() {
    try {
        const exe = String(app.getPath('exe') || process.execPath || '');
        return /[\\/]desktop[\\/]dist[\\/]win-unpacked[\\/]/i.test(exe);
    } catch {
        return false;
    }
}

function configureUpdater() {
    if (configured) return;
    configured = true;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    // Don't rely on resources/app-update.yml (missing in local win-unpacked builds).
    autoUpdater.setFeedURL({
        provider: 'github',
        owner: 'TiripsOrbro',
        repo: 'live-dashboard-app',
    });

    autoUpdater.on('error', (err) => {
        console.warn('[desktop-updater]', err && err.message ? err.message : err);
    });

    autoUpdater.on('update-available', (info) => {
        console.log('[desktop-updater] update available', info && info.version);
        if (launchGateActive) {
            setSplashStatus(`Downloading version ${info.version}…`, 0);
        } else if (manualCheckActive) {
            showManualUpdateFound(info.version);
        }
    });

    autoUpdater.on('download-progress', (progress) => {
        if (!launchGateActive && !manualCheckActive) return;
        const pct = Number(progress && progress.percent);
        if (manualCheckActive) {
            setSplashView({
                headline: 'Update Found',
                status: 'Downloading update…',
                showBar: true,
                percent: Number.isFinite(pct) ? pct : undefined,
                showClose: false,
            });
            return;
        }
        setSplashStatus('Downloading update…', Number.isFinite(pct) ? pct : undefined);
    });

    autoUpdater.on('update-downloaded', async (info) => {
        if (launchGateActive) {
            setSplashStatus(`Installing version ${info.version}…`, 100);
            setTimeout(() => requestQuitAndInstall(), 400);
            return;
        }

        if (manualCheckActive) {
            return;
        }

        const win = BrowserWindow.getFocusedWindow();
        const { response } = await dialog.showMessageBox(win || undefined, {
            type: 'info',
            buttons: ['Restart now', 'Later'],
            defaultId: 0,
            cancelId: 1,
            title: 'Update ready',
            message: `Taco Bell Dashboard ${info.version} has been downloaded.`,
            detail: 'Restart to apply the tray app update. Host server updates use Update from Git separately.',
        });
        if (response === 0) {
            requestQuitAndInstall();
        }
    });
}

/**
 * Before setup / tray work: if a newer GitHub Release exists, download and install it,
 * then restart. Offline / no release / unpackaged → continue normally.
 * @returns {Promise<{ proceeded: boolean, skipped?: string, error?: Error }>}
 */
async function ensureUpToDateBeforeLaunch() {
    configureUpdater();

    if (!app.isPackaged || isLocalUnpackedDist()) {
        return { proceeded: true, skipped: 'dev' };
    }

    launchGateActive = true;
    createSplashWindow();
    // Let the splash paint before the network call.
    await new Promise((r) => setTimeout(r, 200));
    setSplashStatus('Checking for updates…');

    try {
        const result = await autoUpdater.checkForUpdates();
        const remote = result && result.updateInfo && result.updateInfo.version;
        const local = app.getVersion();

        if (!remote || !isNewerVersion(remote, local)) {
            closeSplashWindow();
            launchGateActive = false;
            return { proceeded: true };
        }

        setSplashStatus(`Update ${remote} found — downloading…`, 0);

        await waitForUpdateDownload(result);

        // Event handler also installs; call explicitly so we never hang if the event already fired.
        setSplashStatus(`Installing version ${remote}…`, 100);
        requestQuitAndInstall();
        return await new Promise(() => {});
    } catch (err) {
        console.warn(
            '[desktop-updater] launch check skipped:',
            err && err.message ? err.message : err
        );
        closeSplashWindow();
        launchGateActive = false;
        return { proceeded: true, error: err };
    }
}

async function waitForUpdateDownload(result) {
    if (result && result.downloadPromise) {
        await result.downloadPromise;
        return;
    }
    await new Promise((resolve, reject) => {
        let settled = false;
        const finish = (fn, arg) => {
            if (settled) return;
            settled = true;
            autoUpdater.removeListener('update-downloaded', onDownloaded);
            autoUpdater.removeListener('error', onError);
            fn(arg);
        };
        const onDownloaded = () => finish(resolve);
        const onError = (err) => finish(reject, err);
        autoUpdater.once('update-downloaded', onDownloaded);
        autoUpdater.once('error', onError);
    });
}

async function checkForUpdates({ silent = false } = {}) {
    configureUpdater();

    if (!app.isPackaged || isLocalUnpackedDist()) {
        if (!silent) {
            await dialog.showMessageBox({
                type: 'info',
                title: 'Development build',
                message: isLocalUnpackedDist()
                    ? 'This is the local dist\\win-unpacked build, not the installed tray app.'
                    : 'Development build — tray app updates apply when you rebuild the installer.',
                detail: isLocalUnpackedDist()
                    ? 'Install from GitHub Releases (desktop-v*), or use Start Menu → Live Dashboard. For day-to-day tray work from git, run desktop\\start-from-git.cmd instead.'
                    : 'Use desktop\\start-from-git.cmd for source, or install a desktop-v* release for auto-update.',
            });
        }
        return null;
    }

    const useSplash = !silent;
    if (useSplash) {
        manualCheckActive = true;
        createSplashWindow();
        await new Promise((r) => setTimeout(r, 200));
        setSplashView({
            headline: 'Taco Bell Dashboard',
            status: 'Checking for updates…',
            showBar: false,
            showClose: false,
        });
    }

    try {
        const result = await autoUpdater.checkForUpdates();
        const remote = result && result.updateInfo && result.updateInfo.version;
        const local = app.getVersion();

        if (!remote || !isNewerVersion(remote, local)) {
            if (useSplash) {
                showManualUpToDate(local);
            } else if (!silent) {
                await dialog.showMessageBox({
                    type: 'info',
                    title: 'Up to date',
                    message: `Taco Bell Dashboard ${local} is up to date.`,
                });
            }
            return result;
        }

        if (useSplash) {
            showManualUpdateFound(remote);
            await waitForUpdateDownload(result);
            setSplashView({
                headline: 'Update Found',
                status: 'Installing update…',
                showBar: true,
                percent: 100,
                showClose: false,
            });
            await new Promise((r) => setTimeout(r, 500));
            showManualUpdateInstalled(remote);
        }

        return result;
    } catch (err) {
        if (useSplash) {
            closeSplashWindow();
            manualCheckActive = false;
        }
        if (!silent) {
            const raw = String(err && err.message ? err.message : err);
            const missingLatest = /latest\.yml/i.test(raw);
            const missingAppUpdate = /app-update\.yml/i.test(raw) || /ENOENT/i.test(raw);
            await dialog.showMessageBox({
                type: 'warning',
                title: 'Update check failed',
                message: missingLatest
                    ? 'Update metadata (latest.yml) is missing from the GitHub release.'
                    : missingAppUpdate
                      ? 'This copy of the tray app cannot auto-update (missing update config).'
                      : raw.slice(0, 280),
                detail: missingLatest
                    ? 'Desktop releases must include latest.yml next to the installer. Tag desktop-v* after the release workflow fix, or re-upload that file to the current release.'
                    : missingAppUpdate
                      ? 'Install the latest Taco-Bell-Dashboard-Installer.exe from GitHub Releases, or run the Start Menu “Live Dashboard” shortcut — not desktop\\dist\\win-unpacked.'
                      : 'Updates come from GitHub Releases (desktop-v* tags). Check your network and try again.',
            });
        }
        throw err;
    }
}

module.exports = {
    configureUpdater,
    checkForUpdates,
    ensureUpToDateBeforeLaunch,
    openProgressSplash,
    setProgressSplash,
    closeProgressSplash: closeSplashWindow,
};
