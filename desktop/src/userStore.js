const fs = require('fs');
const path = require('path');
const Store = require('electron-store');

const USERS = [
    { id: 'ash', displayName: 'Ash', region: 'WA' },
    { id: 'tom', displayName: 'Tom', region: 'VIC' },
];

const DEFAULT_ENABLED = {
    ash: ['3901', '3902', '3903', '3904'],
    tom: null, // filled from storelist VIC at runtime when null
};

const store = new Store({
    name: 'area-coach-users',
    encryptionKey: 'area-coach-tools-local-v1',
    defaults: {
        profiles: {
            ash: {
                id: 'ash',
                displayName: 'Ash',
                region: 'WA',
                enabledStores: [...DEFAULT_ENABLED.ash],
                alertEmail: '',
                mmx: { username: '', password: '' },
                lifelenz: { email: '', password: '' },
            },
            tom: {
                id: 'tom',
                displayName: 'Tom',
                region: 'VIC',
                enabledStores: [],
                alertEmail: '',
                mmx: { username: '', password: '' },
                lifelenz: { email: '', password: '' },
            },
        },
        storeEmails: {},
        activeUserId: null,
        seeded: false,
    },
});

function seedPath() {
    const candidates = [
        path.join(__dirname, '..', 'users.seed.json'),
        path.join(process.resourcesPath || '', 'users.seed.json'),
        path.join(path.dirname(process.execPath || ''), 'users.seed.json'),
    ];
    return candidates.find((p) => p && fs.existsSync(p)) || null;
}

function ensureProfileShape(id, profile) {
    const meta = USERS.find((u) => u.id === id) || { id, displayName: id, region: 'VIC' };
    const enabled =
        Array.isArray(profile?.enabledStores) && profile.enabledStores.length
            ? profile.enabledStores.map(String)
            : DEFAULT_ENABLED[id]
              ? [...DEFAULT_ENABLED[id]]
              : [];
    return {
        id,
        displayName: profile?.displayName || meta.displayName,
        region: profile?.region || meta.region,
        enabledStores: enabled,
        alertEmail: String(profile?.alertEmail || '').trim(),
        mmx: {
            username: String(profile?.mmx?.username || '').trim(),
            password: String(profile?.mmx?.password || ''),
        },
        lifelenz: {
            email: String(profile?.lifelenz?.email || '').trim(),
            password: String(profile?.lifelenz?.password || ''),
        },
    };
}

function applySeedIfNeeded() {
    const profiles = store.get('profiles');
    let changed = false;
    for (const id of ['ash', 'tom']) {
        const shaped = ensureProfileShape(id, profiles[id] || {});
        if (!profiles[id] || profiles[id].region == null || profiles[id].enabledStores == null) {
            profiles[id] = shaped;
            changed = true;
        } else {
            profiles[id] = ensureProfileShape(id, { ...shaped, ...profiles[id] });
        }
    }
    if (changed) store.set('profiles', profiles);

    if (store.get('seeded')) return false;
    const file = seedPath();
    if (!file) {
        store.set('seeded', true);
        return false;
    }
    try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        const next = store.get('profiles');
        for (const id of ['ash', 'tom']) {
            const row = raw[id] || raw[id.toUpperCase()] || {};
            next[id] = ensureProfileShape(id, {
                ...next[id],
                alertEmail: row.alertEmail || next[id].alertEmail,
                enabledStores: Array.isArray(row.enabledStores) ? row.enabledStores : next[id].enabledStores,
                mmx: {
                    username: String(row.mmx?.username || row.mmxUsername || next[id].mmx.username || '').trim(),
                    password: String(row.mmx?.password || row.mmxPassword || next[id].mmx.password || ''),
                },
                lifelenz: {
                    email: String(
                        row.lifelenz?.email || row.lifelenzEmail || row.lifelenz?.username || next[id].lifelenz.email || ''
                    ).trim(),
                    password: String(row.lifelenz?.password || row.lifelenzPassword || next[id].lifelenz.password || ''),
                },
            });
        }
        store.set('profiles', next);
        store.set('seeded', true);
        return true;
    } catch (err) {
        console.warn('[userStore] seed failed:', err.message);
        store.set('seeded', true);
        return false;
    }
}

function listUsers() {
    applySeedIfNeeded();
    const profiles = store.get('profiles');
    return USERS.map((u) => {
        const p = ensureProfileShape(u.id, profiles[u.id] || {});
        return {
            id: u.id,
            displayName: p.displayName,
            region: p.region,
            mmxConfigured: Boolean(p.mmx?.username && p.mmx?.password),
            lifelenzConfigured: Boolean(p.lifelenz?.email && p.lifelenz?.password),
            enabledStoreCount: (p.enabledStores || []).length,
        };
    });
}

function getProfile(userId) {
    applySeedIfNeeded();
    const id = String(userId || '').toLowerCase();
    const profiles = store.get('profiles');
    if (!profiles[id]) return null;
    return ensureProfileShape(id, profiles[id]);
}

function getProfileMasked(userId) {
    const p = getProfile(userId);
    if (!p) return null;
    return {
        id: p.id,
        displayName: p.displayName,
        region: p.region,
        enabledStores: [...(p.enabledStores || [])],
        alertEmail: p.alertEmail || '',
        mmx: {
            username: p.mmx?.username || '',
            password: p.mmx?.password ? '********' : '',
            configured: Boolean(p.mmx?.username && p.mmx?.password),
        },
        lifelenz: {
            email: p.lifelenz?.email || '',
            password: p.lifelenz?.password ? '********' : '',
            configured: Boolean(p.lifelenz?.email && p.lifelenz?.password),
        },
    };
}

function saveProfile(userId, patch) {
    const id = String(userId || '').toLowerCase();
    if (!USERS.some((u) => u.id === id)) throw new Error('Unknown user');
    const profiles = store.get('profiles');
    const prev = ensureProfileShape(id, profiles[id] || {});
    const nextMmx = { ...prev.mmx, ...(patch.mmx || {}) };
    const nextLife = { ...prev.lifelenz, ...(patch.lifelenz || {}) };
    if (nextMmx.password === '********') nextMmx.password = prev.mmx.password;
    if (nextLife.password === '********') nextLife.password = prev.lifelenz.password;
    profiles[id] = ensureProfileShape(id, {
        ...prev,
        displayName: patch.displayName || prev.displayName,
        alertEmail: patch.alertEmail != null ? String(patch.alertEmail).trim() : prev.alertEmail,
        enabledStores: Array.isArray(patch.enabledStores)
            ? patch.enabledStores.map(String)
            : prev.enabledStores,
        mmx: {
            username: String(nextMmx.username || '').trim(),
            password: String(nextMmx.password || ''),
        },
        lifelenz: {
            email: String(nextLife.email || '').trim(),
            password: String(nextLife.password || ''),
        },
    });
    store.set('profiles', profiles);
    return getProfileMasked(id);
}

function setActiveUser(userId) {
    const profile = getProfile(userId);
    if (!profile) throw new Error('Unknown user');
    store.set('activeUserId', profile.id);
    return profile;
}

function getActiveUserId() {
    return store.get('activeUserId');
}

function clearActiveUser() {
    store.set('activeUserId', null);
}

function getStoreEmails() {
    const raw = store.get('storeEmails') || {};
    return typeof raw === 'object' && raw ? { ...raw } : {};
}

function setStoreEmail(storeNumber, email) {
    const key = String(storeNumber || '').trim();
    const emails = getStoreEmails();
    const value = String(email || '').trim();
    if (!value) delete emails[key];
    else emails[key] = value;
    store.set('storeEmails', emails);
    return emails;
}

function setStoreEmails(map) {
    const next = {};
    for (const [k, v] of Object.entries(map || {})) {
        const email = String(v || '').trim();
        if (email) next[String(k)] = email;
    }
    store.set('storeEmails', next);
    return next;
}

module.exports = {
    USERS,
    listUsers,
    getProfile,
    getProfileMasked,
    saveProfile,
    setActiveUser,
    getActiveUserId,
    clearActiveUser,
    applySeedIfNeeded,
    getStoreEmails,
    setStoreEmail,
    setStoreEmails,
    defaultEnabledStores: DEFAULT_ENABLED,
};
