const { Tray, Menu, nativeImage, shell, app, dialog } = require('electron');
const path = require('path');
const { getConfig, dashboardUrl, publicDashboardUrl } = require('./config');
const host = require('./host-controller');
const { checkForUpdates, openProgressSplash, setProgressSplash, closeProgressSplash } = require('./updater');
const cloudflare = require('./cloudflare');
const watchdog = require('./watchdog');

let tray = null;
let openSettings = null;
let refreshMenu = null;
let onStopHosting = null;
let onBecomeHost = null;
let onExportSecrets = null;
let getStatusSummary = null;

function iconPath() {
    return path.join(__dirname, '..', 'build', 'icon.png');
}

function buildTrayIcon() {
    const img = nativeImage.createFromPath(iconPath());
    if (img.isEmpty()) {
        return nativeImage.createEmpty();
    }
    return img.resize({ width: 16, height: 16 });
}

function setOpenSettingsHandler(fn) {
    openSettings = fn;
}

function setTrayTooltip(text) {
    if (tray && !tray.isDestroyed()) {
        tray.setToolTip(String(text || 'Admin Host').slice(0, 250));
    }
}

function notifyTray(title, content) {
    if (!tray || tray.isDestroyed()) return;
    try {
        tray.displayBalloon({
            title: String(title || 'Admin Host').slice(0, 63),
            content: String(content || '').slice(0, 255),
            iconType: 'info',
        });
    } catch {
        /* displayBalloon not always available */
    }
}

function serverAppearsRunning(summary) {
    return /running|starting/i.test(String(summary?.serverLabel || ''));
}

async function rebuildContextMenu() {
    const cfg = getConfig();
    const isHost = cfg.mode === 'host';
    let summary = null;
    if (typeof getStatusSummary === 'function') {
        try {
            summary = await getStatusSummary();
        } catch {
            summary = null;
        }
    }

    if (summary?.tooltip) {
        setTrayTooltip(summary.tooltip);
    }

    const hostItems = isHost
        ? [
              serverAppearsRunning(summary)
                  ? {
                        label: 'Stop server',
                        click: async () => {
                            try {
                                // Operator chose to stop — auto-repair must not undo it.
                                watchdog.pauseWatchdog(60 * 60 * 1000, 'server stopped from tray');
                                await host.stopServer();
                            } catch (err) {
                                await dialog.showErrorBox('Stop failed', String(err.message || err));
                            }
                            refreshMenu && refreshMenu();
                        },
                    }
                  : {
                        label: 'Start server',
                        click: async () => {
                            try {
                                watchdog.resumeWatchdog();
                                await host.startServer();
                                await dialog.showMessageBox({
                                    type: 'info',
                                    message: 'Server started',
                                    detail: 'Ensure Cloudflare tunnel points at http://localhost:3100 for localhost:3100.',
                                });
                            } catch (err) {
                                await dialog.showErrorBox('Start failed', String(err.message || err));
                            }
                            refreshMenu && refreshMenu();
                        },
                    },
              {
                  label: 'Updates',
                  submenu: [
                      {
                          label: 'Server from Git…',
                          click: async () => {
                              try {
                                  watchdog.pauseWatchdog(30 * 60 * 1000, 'git server update running');
                                  await openProgressSplash({
                                      headline: 'Server update',
                                      status: 'Checking Git for updates…',
                                  });
                                  const result = await host.updateFromGit({
                                      onProgress: (msg) =>
                                          setProgressSplash({
                                              headline: 'Server update',
                                              status: msg,
                                              showBar: false,
                                              showClose: false,
                                          }),
                                  });
                                  closeProgressSplash();
                                  if (result.updated) {
                                      await dialog.showMessageBox({
                                          type: 'info',
                                          message: 'Server updated',
                                          detail: `Branch ${result.branch} pulled and server restarted.`,
                                      });
                                  } else {
                                      await dialog.showMessageBox({
                                          type: 'info',
                                          message: 'Already up to date',
                                          detail: `Branch ${result.branch} matches GitHub. Server was restarted.`,
                                      });
                                  }
                              } catch (err) {
                                  closeProgressSplash();
                                  await dialog.showErrorBox('Git update failed', String(err.message || err));
                              } finally {
                                  watchdog.resumeWatchdog();
                              }
                              refreshMenu && refreshMenu();
                          },
                      },
                      {
                          label: 'Tray app…',
                          click: () => checkForUpdates({ silent: false }).catch(() => {}),
                      },
                  ],
              },
              {
                  label: 'Host tools',
                  submenu: [
                      {
                          label: 'Setup Cloudflare tunnel…',
                          click: async () => {
                              try {
                                  watchdog.pauseWatchdog(15 * 60 * 1000, 'cloudflare setup running');
                                  const cf = await cloudflare.setupCloudflareTunnel({
                                      hostname: (() => {
                                          try {
                                              return new URL(getConfig().serverUrl).hostname;
                                          } catch {
                                              return cloudflare.DEFAULT_HOSTNAME;
                                          }
                                      })(),
                                      guided: true,
                                      onOpenAdminSettings: () => openSettings && openSettings(),
                                      confirm: async (opts) => {
                                          const { response } = await dialog.showMessageBox({
                                              type: opts.type || 'info',
                                              title: opts.title || 'Cloudflare',
                                              message: opts.message || '',
                                              detail: opts.detail || '',
                                              buttons: opts.buttons || ['OK'],
                                              defaultId: opts.defaultId ?? 0,
                                              cancelId: opts.cancelId,
                                              noLink: true,
                                          });
                                          return response;
                                      },
                                      onProgress: (msg) => console.log('[cloudflare]', msg),
                                  });
                                  if (cf.skipped) return;
                              } catch (err) {
                                  await dialog.showErrorBox('Cloudflare setup failed', String(err.message || err));
                              } finally {
                                  watchdog.resumeWatchdog();
                              }
                              refreshMenu && refreshMenu();
                          },
                      },
                      {
                          label: 'Export Host secrets pack…',
                          click: async () => {
                              if (onExportSecrets) await onExportSecrets();
                              refreshMenu && refreshMenu();
                          },
                      },
                      {
                          label: 'Easy Host repair / reinstall tools…',
                          click: async () => {
                              const { response } = await dialog.showMessageBox({
                                  type: 'question',
                                  buttons: ['Continue', 'Cancel'],
                                  defaultId: 0,
                                  cancelId: 1,
                                  message: 'Re-run automatic Host setup?',
                                  detail: 'This checks/installs Node, Git, Cloudflare Tunnel, updates the server folder, and restarts services. Approve any Windows prompts.',
                              });
                              if (response !== 0) return;
                              try {
                                  watchdog.pauseWatchdog(60 * 60 * 1000, 'easy host repair running');
                                  const bootstrap = require('./host-bootstrap');
                                  await bootstrap.runHostBootstrap({
                                      onProgress: (msg) => console.log('[host-repair]', msg),
                                      setupCloudflare: true,
                                  });
                                  await dialog.showMessageBox({
                                      type: 'info',
                                      message: 'Host repair finished',
                                  });
                              } catch (err) {
                                  await dialog.showErrorBox('Host repair failed', String(err.message || err));
                              } finally {
                                  watchdog.resumeWatchdog();
                              }
                              refreshMenu && refreshMenu();
                          },
                      },
                      {
                          label: 'Re-run daily reports…',
                          click: async () => {
                              const { response } = await dialog.showMessageBox({
                                  type: 'question',
                                  buttons: ['Start', 'Cancel'],
                                  defaultId: 0,
                                  cancelId: 1,
                                  message: 'Re-run daily reports now?',
                                  detail:
                                      'Runs stock levels, forecast auto-submit, and report subscriptions for enabled stores. This can take a while and may re-send today’s subscription emails.',
                              });
                              if (response !== 0) return;
                              try {
                                  const health = await host.probeLocalHealth();
                                  if (!health?.ok) {
                                      await dialog.showErrorBox(
                                          'Server not running',
                                          'Start the dashboard server first, then try again.'
                                      );
                                      return;
                                  }
                                  const res = await fetch('http://127.0.0.1:3100/api/admin/daily-reports/run', {
                                      method: 'POST',
                                      headers: { 'Content-Type': 'application/json' },
                                      body: JSON.stringify({ force: true }),
                                      signal: AbortSignal.timeout(15000),
                                  });
                                  const body = await res.json().catch(() => ({}));
                                  if (!res.ok) {
                                      throw new Error(body.error || `HTTP ${res.status}`);
                                  }
                                  notifyTray('Daily reports', 'Started — check PM2 / dashboard logs for progress.');
                                  await dialog.showMessageBox({
                                      type: 'info',
                                      message: 'Daily reports started',
                                      detail: `Running in the background for ${body.dateKey || 'today'}. Watch the dashboard logs for progress.`,
                                  });
                              } catch (err) {
                                  await dialog.showErrorBox(
                                      'Could not start daily reports',
                                      String(err.message || err)
                                  );
                              }
                              refreshMenu && refreshMenu();
                          },
                      },
                      {
                          label: 'Stop hosting (become Client)…',
                          click: async () => {
                              if (onStopHosting) await onStopHosting();
                              refreshMenu && refreshMenu();
                          },
                      },
                  ],
              },
          ]
        : cfg.setupComplete
          ? [
                {
                    label: 'Become Host…',
                    click: async () => {
                        if (onBecomeHost) await onBecomeHost();
                        refreshMenu && refreshMenu();
                    },
                },
                {
                    label: 'Update tray app…',
                    click: () => checkForUpdates({ silent: false }).catch(() => {}),
                },
            ]
          : [];

    const menu = Menu.buildFromTemplate([
        {
            label: 'Open Settings',
            click: () => openSettings && openSettings(),
        },
        {
            label: 'Open Dashboard',
            click: () => shell.openExternal(getConfig().mode === 'host' ? dashboardUrl() : publicDashboardUrl()),
        },
        ...(hostItems.length ? [{ type: 'separator' }, ...hostItems] : []),
        { type: 'separator' },
        {
            label: 'Quit Admin Host',
            click: () => app.quit(),
        },
    ]);
    if (tray && !tray.isDestroyed()) {
        tray.setContextMenu(menu);
    }
}

function createTray(handlers = {}) {
    openSettings = handlers.openSettings || openSettings;
    onStopHosting = handlers.onStopHosting || onStopHosting;
    onBecomeHost = handlers.onBecomeHost || onBecomeHost;
    onExportSecrets = handlers.onExportSecrets || onExportSecrets;
    getStatusSummary = handlers.getStatusSummary || getStatusSummary;
    tray = new Tray(buildTrayIcon());
    tray.setToolTip('Admin Host');
    tray.on('click', () => openSettings && openSettings());
    tray.on('double-click', () => openSettings && openSettings());
    refreshMenu = () => rebuildContextMenu().catch(() => {});
    refreshMenu();
    // Status refresh is driven from main (startStatusPolling); keep a light menu rebuild fallback.
    setInterval(() => refreshMenu(), 60000);
    return tray;
}

module.exports = {
    createTray,
    setOpenSettingsHandler,
    rebuildContextMenu,
    notifyTray,
    setTrayTooltip,
};
