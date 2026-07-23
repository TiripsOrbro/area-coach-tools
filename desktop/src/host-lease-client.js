const { randomUUID } = require('crypto');
const os = require('os');
const { getConfig, setConfig, DEFAULT_SERVER_URL } = require('./config');

function ensureHostId() {
    const cfg = getConfig();
    if (cfg.hostId) return cfg.hostId;
    const hostId = randomUUID();
    setConfig({ hostId });
    return hostId;
}

function hostIdentity() {
    const hostId = ensureHostId();
    const hostname = os.hostname();
    return {
        hostId,
        hostname,
        displayName: `${os.userInfo().username || 'user'}@${hostname}`,
        platform: `${os.platform()} ${os.arch()}`,
    };
}

async function fetchJson(url, opts = {}) {
    const res = await fetch(url, {
        ...opts,
        headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            ...(opts.headers || {}),
        },
        signal: opts.signal || AbortSignal.timeout(opts.timeoutMs || 8000),
    });
    const text = await res.text();
    let body = null;
    try {
        body = text ? JSON.parse(text) : null;
    } catch {
        body = { raw: text };
    }
    return { ok: res.ok, status: res.status, body };
}

function apiBase() {
    return String(getConfig().serverUrl || DEFAULT_SERVER_URL).replace(/\/+$/, '');
}

async function getHostStatus(baseUrl = apiBase()) {
    try {
        const { ok, body } = await fetchJson(`${baseUrl}/api/host/status`);
        if (!ok || !body) return { hasActiveHost: false, unreachable: true };
        return { ...body, unreachable: false };
    } catch {
        return { hasActiveHost: false, unreachable: true };
    }
}

async function claimHost({ takeover = false, message = '' } = {}) {
    const identity = hostIdentity();
    const { ok, status, body } = await fetchJson(`${apiBase()}/api/host/claim`, {
        method: 'POST',
        body: JSON.stringify({
            ...identity,
            takeover: Boolean(takeover),
            message:
                message ||
                `${identity.displayName} took over as Host. This PC is now a Client — open Live Dashboard to continue as Client.`,
        }),
    });
    return { ok, status, body, identity };
}

async function heartbeatHost() {
    const identity = hostIdentity();
    const { ok, status, body } = await fetchJson(`${apiBase()}/api/host/heartbeat`, {
        method: 'POST',
        body: JSON.stringify({ hostId: identity.hostId }),
        timeoutMs: 5000,
    });
    return { ok, status, body };
}

async function releaseHost() {
    const identity = hostIdentity();
    try {
        await fetchJson(`${apiBase()}/api/host/release`, {
            method: 'POST',
            body: JSON.stringify({ hostId: identity.hostId }),
        });
    } catch {
        /* ignore */
    }
}

module.exports = {
    ensureHostId,
    hostIdentity,
    getHostStatus,
    claimHost,
    heartbeatHost,
    releaseHost,
};
