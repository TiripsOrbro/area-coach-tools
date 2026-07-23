/**
 * Host auto-repair watchdog.
 *
 * Every CHECK_INTERVAL the watchdog verifies the three legs of a healthy Host
 * (tray tooltip: Server / Tunnel / Lease) and repairs whichever is down:
 *
 *   1. Local server  — http://127.0.0.1:3100 health probe → restart via PM2.
 *   2. Cloudflare    — user-mode cloudflared pid → relaunch with saved token.
 *   3. Public/lease  — https://tbadashboard.com host status. Unreachable while
 *      server + tunnel look fine means a zombie connector → force-restart the
 *      tunnel. Reachable but no active host → quietly re-claim the lease.
 *
 * Guardrails:
 *   - Per-component cooldown so a genuinely broken component is not hammered.
 *   - Public repair requires 2 consecutive failed checks AND working internet,
 *     so a brief ISP blip does not bounce the tunnel.
 *   - pause()/resume() lets tray actions (Stop server, Cloudflare setup) run
 *     without the watchdog fighting the operator.
 *   - Never claims the lease away from another PC — takeover stays a human
 *     decision (heartbeat demotion handles losing the lease).
 */
const host = require('./host-controller');
const cloudflare = require('./cloudflare');
const hostLease = require('./host-lease-client');
const { getConfig } = require('./config');

const CHECK_INTERVAL_MS = 60 * 1000;
const REPAIR_COOLDOWN_MS = 3 * 60 * 1000;
const ESCALATE_AFTER_FAILURES = 3;
const PUBLIC_UNREACHABLE_THRESHOLD = 2;

let timer = null;
let tickInProgress = false;
let pausedUntil = 0;
let pauseReason = null;

let notify = () => {};
let afterRepair = () => {};

const state = {
    server: { lastRepairAt: 0, consecutiveFailures: 0, escalated: false },
    tunnel: { lastRepairAt: 0, consecutiveFailures: 0, escalated: false },
    publicSite: { lastRepairAt: 0, consecutiveUnreachable: 0, escalated: false },
    lease: { lastRepairAt: 0 },
    lastCheckAt: 0,
    lastRepair: null,
};

function log(...args) {
    console.log('[watchdog]', ...args);
}

function cooldownPassed(component) {
    return Date.now() - state[component].lastRepairAt >= REPAIR_COOLDOWN_MS;
}

function recordRepair(component, detail) {
    state[component].lastRepairAt = Date.now();
    state.lastRepair = { component, detail, at: Date.now() };
}

function componentFixed(component, title, body) {
    const s = state[component];
    const wasBroken = s.consecutiveFailures > 0 || s.escalated;
    s.consecutiveFailures = 0;
    s.escalated = false;
    if (wasBroken && title) {
        notify({ title, body });
    }
}

function componentStillBroken(component, title, body) {
    const s = state[component];
    s.consecutiveFailures += 1;
    if (s.consecutiveFailures >= ESCALATE_AFTER_FAILURES && !s.escalated) {
        s.escalated = true;
        notify({ title, body });
    }
}

/** Distinguish "our tunnel is down" from "this PC has no internet". */
async function internetLooksUp() {
    const probes = ['https://www.gstatic.com/generate_204', 'https://one.one.one.one/cdn-cgi/trace'];
    for (const url of probes) {
        try {
            const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
            if (res.status >= 200 && res.status < 400) return true;
        } catch {
            /* try next probe */
        }
    }
    return false;
}

async function checkServer() {
    const health = await host.probeLocalHealth();
    if (health.ok) {
        componentFixed('server');
        return true;
    }

    if (!cooldownPassed('server')) {
        componentStillBroken(
            'server',
            'Host server needs attention',
            'The dashboard server keeps going down and auto-repair could not keep it up. Check tray → Updates → Server from Git, or Easy Host repair.'
        );
        return false;
    }

    log('server down — attempting restart');
    recordRepair('server', 'restart');
    try {
        const result = await host.ensureServerRunning({ waitMs: 45000 });
        if (result.health?.ok) {
            componentFixed(
                'server',
                'Auto-repair: server restarted',
                'The dashboard server was down and has been restarted automatically.'
            );
            afterRepair('server');
            return true;
        }
    } catch (err) {
        log('server repair failed', err.message || err);
    }
    componentStillBroken(
        'server',
        'Host server needs attention',
        'The dashboard server is down and automatic restarts are not bringing it back. Use tray → Easy Host repair.'
    );
    return false;
}

async function checkTunnel() {
    const cf = await cloudflare.getCloudflareStatus();
    if (cf.pidRunning) {
        componentFixed('tunnel');
        return true;
    }

    if (!cooldownPassed('tunnel')) {
        componentStillBroken(
            'tunnel',
            'Cloudflare tunnel needs attention',
            'The tunnel keeps stopping and auto-repair could not keep it up. Use tray → Host tools → Setup Cloudflare tunnel…'
        );
        return false;
    }

    log('tunnel down — attempting restart');
    recordRepair('tunnel', 'restart');
    try {
        await cloudflare.ensureHostTunnelRunning({ onProgress: (m) => log('tunnel:', m) });
        componentFixed(
            'tunnel',
            'Auto-repair: tunnel restarted',
            'The Cloudflare tunnel was down and has been restarted, tbadashboard.com should be back shortly.'
        );
        afterRepair('tunnel');
        return true;
    } catch (err) {
        log('tunnel repair failed', err.message || err);
        componentStillBroken(
            'tunnel',
            'Cloudflare tunnel needs attention',
            `Auto-repair could not restart the tunnel: ${String(err.message || err).slice(0, 180)}\nUse tray → Host tools → Setup Cloudflare tunnel…`
        );
        return false;
    }
}

async function checkPublicAndLease() {
    const status = await hostLease.getHostStatus();

    if (status.unreachable) {
        // Local pieces look fine but the public site is down. Confirm it is us
        // (internet up) and persistent (2 checks) before bouncing the tunnel.
        if (!(await internetLooksUp())) {
            log('public unreachable but internet is down — skipping repair');
            return;
        }
        state.publicSite.consecutiveUnreachable += 1;
        if (
            state.publicSite.consecutiveUnreachable >= PUBLIC_UNREACHABLE_THRESHOLD &&
            cooldownPassed('publicSite')
        ) {
            log('public site unreachable with healthy internet — force-restarting tunnel');
            recordRepair('publicSite', 'tunnel-force-restart');
            try {
                await cloudflare.ensureHostTunnelRunning({
                    forceRestart: true,
                    onProgress: (m) => log('tunnel:', m),
                });
                afterRepair('publicSite');
                notify({
                    title: 'Auto-repair: tunnel reconnected',
                    body: 'tbadashboard.com was unreachable so the Cloudflare tunnel was restarted.',
                });
            } catch (err) {
                log('public repair failed', err.message || err);
                if (!state.publicSite.escalated) {
                    state.publicSite.escalated = true;
                    notify({
                        title: 'tbadashboard.com unreachable',
                        body: 'The public site is down and auto-repair could not fix it. Use tray → Host tools → Setup Cloudflare tunnel…',
                    });
                }
            }
        }
        return;
    }

    state.publicSite.consecutiveUnreachable = 0;
    state.publicSite.escalated = false;

    // Site reachable — make sure the lease is held. Only claim when nobody
    // holds it; a lease owned by another PC is handled by heartbeat demotion.
    const identity = hostLease.hostIdentity();
    const ownedByUs = status.hasActiveHost && status.lease && status.lease.hostId === identity.hostId;
    if (ownedByUs) return;

    if (!status.hasActiveHost && cooldownPassed('lease')) {
        log('no active host lease — re-claiming');
        recordRepair('lease', 'reclaim');
        try {
            const claim = await hostLease.claimHost({ takeover: false });
            if (claim.ok) {
                afterRepair('lease');
                notify({
                    title: 'Auto-repair: Host lease restored',
                    body: 'The Host lease had lapsed and has been re-claimed by this PC.',
                });
            }
        } catch (err) {
            log('lease reclaim failed', err.message || err);
        }
    }
}

async function tick() {
    if (tickInProgress) return;
    const cfg = getConfig();
    if (cfg.mode !== 'host' || !cfg.setupComplete) return;
    if (Date.now() < pausedUntil) return;
    pauseReason = null;

    tickInProgress = true;
    state.lastCheckAt = Date.now();
    try {
        const serverOk = await checkServer();
        const tunnelOk = await checkTunnel();
        // Public/lease checks only make sense when the local legs are up;
        // otherwise the repairs above are already the fix in progress.
        if (serverOk && tunnelOk) {
            await checkPublicAndLease();
        }
    } catch (err) {
        log('tick error', err.message || err);
    } finally {
        tickInProgress = false;
    }
}

function startWatchdog(handlers = {}) {
    if (typeof handlers.notify === 'function') notify = handlers.notify;
    if (typeof handlers.afterRepair === 'function') afterRepair = handlers.afterRepair;
    if (timer) return;
    timer = setInterval(() => {
        tick().catch((err) => log('tick rejected', err));
    }, CHECK_INTERVAL_MS);
    log('started');
}

function stopWatchdog() {
    if (timer) {
        clearInterval(timer);
        timer = null;
        log('stopped');
    }
}

/** Pause auto-repair (e.g. operator chose Stop server, or a guided setup is running). */
function pauseWatchdog(ms, reason = null) {
    pausedUntil = Date.now() + Math.max(0, Number(ms) || 0);
    pauseReason = reason;
    log(`paused ${Math.round((pausedUntil - Date.now()) / 1000)}s`, reason || '');
}

function resumeWatchdog() {
    pausedUntil = 0;
    pauseReason = null;
    log('resumed');
}

function getWatchdogStatus() {
    return {
        active: Boolean(timer),
        paused: Date.now() < pausedUntil,
        pausedUntil: pausedUntil || null,
        pauseReason,
        lastCheckAt: state.lastCheckAt || null,
        lastRepair: state.lastRepair,
    };
}

module.exports = {
    startWatchdog,
    stopWatchdog,
    pauseWatchdog,
    resumeWatchdog,
    getWatchdogStatus,
};
