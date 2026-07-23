/**
 * Active Area Coach (Ash / Tom) session: portal creds + store scope + alert email.
 */
const fs = require('fs');
const path = require('path');
const paths = require('../../src/paths');

const SESSION_FILE = path.join(paths.stores.data, 'coach-session.json');

function emptySession() {
    return {
        userId: null,
        displayName: null,
        region: null,
        enabledStores: [],
        alertEmail: '',
        mmx: { username: '', password: '' },
        lifelenz: { email: '', password: '' },
        updatedAt: null,
    };
}

function readSession() {
    if (!fs.existsSync(SESSION_FILE)) return emptySession();
    try {
        const raw = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
        return {
            ...emptySession(),
            ...raw,
            enabledStores: Array.isArray(raw.enabledStores) ? raw.enabledStores.map(String) : [],
            mmx: { username: '', password: '', ...(raw.mmx || {}) },
            lifelenz: { email: '', password: '', ...(raw.lifelenz || {}) },
        };
    } catch {
        return emptySession();
    }
}

function writeSession(partial) {
    const prev = readSession();
    const next = {
        ...prev,
        ...partial,
        enabledStores: Array.isArray(partial.enabledStores)
            ? partial.enabledStores.map(String)
            : prev.enabledStores,
        mmx: { ...prev.mmx, ...(partial.mmx || {}) },
        lifelenz: { ...prev.lifelenz, ...(partial.lifelenz || {}) },
        updatedAt: new Date().toISOString(),
    };
    fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
    fs.writeFileSync(SESSION_FILE, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    return maskSession(next);
}

function clearSession() {
    try {
        if (fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE);
    } catch {
        /* ignore */
    }
    return emptySession();
}

function maskSession(session = readSession()) {
    return {
        userId: session.userId,
        displayName: session.displayName,
        region: session.region,
        enabledStores: [...(session.enabledStores || [])],
        alertEmail: session.alertEmail || '',
        mmx: {
            username: session.mmx?.username || '',
            configured: Boolean(session.mmx?.username && session.mmx?.password),
        },
        lifelenz: {
            email: session.lifelenz?.email || '',
            configured: Boolean(session.lifelenz?.email && session.lifelenz?.password),
        },
        updatedAt: session.updatedAt,
    };
}

function coachCandidates(service) {
    const svc = String(service || '').trim().toLowerCase();
    const session = readSession();
    if (svc === 'mmx') {
        const username = String(session.mmx?.username || '').trim();
        const password = String(session.mmx?.password || '');
        if (!username || !password) return [];
        return [
            {
                username,
                password,
                source: 'coach-session',
                label: session.displayName || session.userId || 'Coach',
                updatedBy: session.userId || 'coach',
            },
        ];
    }
    if (svc === 'lifelenz') {
        const email = String(session.lifelenz?.email || '').trim();
        const password = String(session.lifelenz?.password || '');
        if (!email || !password) return [];
        return [
            {
                email,
                password,
                source: 'coach-session',
                label: session.displayName || session.userId || 'Coach',
                updatedBy: session.userId || 'coach',
            },
        ];
    }
    return [];
}

module.exports = {
    SESSION_FILE,
    readSession,
    writeSession,
    clearSession,
    maskSession,
    coachCandidates,
};
