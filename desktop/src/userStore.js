const fs = require('fs');
const path = require('path');
const Store = require('electron-store');

const USERS = [
    { id: 'wa', displayName: 'WA', region: 'WA' },
    { id: 'vic', displayName: 'VIC', region: 'VIC' },
    { id: 'tacobell', displayName: 'Taco Bell', region: 'ALL' },
];

const USER_IDS = USERS.map((u) => u.id);

/** Map retired Ash/Tom profiles onto WA/VIC. */
const LEGACY_PROFILE_MAP = {
    ash: 'wa',
    tom: 'vic',
};

const DEFAULT_ENABLED = {
    wa: ['3901', '3902', '3903', '3904'],
    vic: null, // all VIC from storelist at runtime
    tacobell: null, // all stores from storelist at runtime
};

function emptyCreds() {
    return {
        alertEmail: '',
        downloadFolder: '',
        mmx: { username: '', password: '' },
        lifelenz: { email: '', password: '' },
        gmail: { email: '', password: '' },
    };
}

const store = new Store({
    name: 'area-coach-users',
    encryptionKey: 'area-coach-tools-local-v1',
    defaults: {
        profiles: {
            wa: {
                id: 'wa',
                displayName: 'WA',
                region: 'WA',
                enabledStores: [...DEFAULT_ENABLED.wa],
                ...emptyCreds(),
            },
            vic: {
                id: 'vic',
                displayName: 'VIC',
                region: 'VIC',
                enabledStores: [],
                ...emptyCreds(),
            },
            tacobell: {
                id: 'tacobell',
                displayName: 'Taco Bell',
                region: 'ALL',
                enabledStores: [],
                ...emptyCreds(),
            },
        },
        storeEmails: {},
        activeUserId: null,
        seeded: false,
        profilesMigratedV2: false,
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
        downloadFolder: String(profile?.downloadFolder || '').trim(),
        mmx: {
            username: String(profile?.mmx?.username || '').trim(),
            password: String(profile?.mmx?.password || ''),
        },
        lifelenz: {
            email: String(profile?.lifelenz?.email || '').trim(),
            password: String(profile?.lifelenz?.password || ''),
        },
        gmail: {
            email: String(profile?.gmail?.email || '').trim(),
            password: String(profile?.gmail?.password || ''),
        },
    };
}

function profileHasCreds(p) {
    return Boolean(
        (p?.mmx?.username && p?.mmx?.password) ||
            (p?.lifelenz?.email && p?.lifelenz?.password) ||
            (p?.gmail?.email && p?.gmail?.password) ||
            p?.alertEmail ||
            p?.downloadFolder
    );
}

/** One-time: ash→wa, tom→vic; create tacobell; drop legacy keys. */
function migrateProfilesV2() {
    if (store.get('profilesMigratedV2')) return;
    const profiles = store.get('profiles') || {};
    const next = { ...profiles };

    for (const [legacyId, newId] of Object.entries(LEGACY_PROFILE_MAP)) {
        const legacy = profiles[legacyId];
        if (!legacy) continue;
        const existing = profiles[newId];
        if (!existing || !profileHasCreds(existing)) {
            next[newId] = ensureProfileShape(newId, {
                ...legacy,
                id: newId,
                displayName: USERS.find((u) => u.id === newId)?.displayName || newId,
                region: USERS.find((u) => u.id === newId)?.region || legacy.region,
            });
        }
        delete next[legacyId];
    }

    for (const u of USERS) {
        next[u.id] = ensureProfileShape(u.id, next[u.id] || {});
    }

    // Drop any other unknown profile keys except known ids
    for (const key of Object.keys(next)) {
        if (!USER_IDS.includes(key)) delete next[key];
    }

    let active = store.get('activeUserId');
    if (active && LEGACY_PROFILE_MAP[String(active).toLowerCase()]) {
        active = LEGACY_PROFILE_MAP[String(active).toLowerCase()];
        store.set('activeUserId', active);
    } else if (active && !USER_IDS.includes(String(active).toLowerCase())) {
        store.set('activeUserId', null);
    }

    store.set('profiles', next);
    store.set('profilesMigratedV2', true);
}

function applySeedIfNeeded() {
    migrateProfilesV2();

    const profiles = store.get('profiles');
    let changed = false;
    for (const id of USER_IDS) {
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
        for (const id of USER_IDS) {
            const legacyKey = Object.keys(LEGACY_PROFILE_MAP).find((k) => LEGACY_PROFILE_MAP[k] === id);
            const row = raw[id] || raw[id.toUpperCase()] || (legacyKey ? raw[legacyKey] : null) || {};
            next[id] = ensureProfileShape(id, {
                ...next[id],
                alertEmail: row.alertEmail || next[id].alertEmail,
                downloadFolder: row.downloadFolder || next[id].downloadFolder,
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
                gmail: {
                    email: String(row.gmail?.email || row.gmailEmail || next[id].gmail.email || '').trim(),
                    password: String(row.gmail?.password || row.gmailPassword || next[id].gmail.password || ''),
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
            gmailConfigured: Boolean(p.gmail?.email && p.gmail?.password),
            enabledStoreCount: (p.enabledStores || []).length,
        };
    });
}

function getProfile(userId) {
    applySeedIfNeeded();
    let id = String(userId || '').toLowerCase();
    if (LEGACY_PROFILE_MAP[id]) id = LEGACY_PROFILE_MAP[id];
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
        downloadFolder: p.downloadFolder || '',
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
        gmail: {
            email: p.gmail?.email || '',
            password: p.gmail?.password ? '********' : '',
            configured: Boolean(p.gmail?.email && p.gmail?.password),
        },
    };
}

function saveProfile(userId, patch) {
    let id = String(userId || '').toLowerCase();
    if (LEGACY_PROFILE_MAP[id]) id = LEGACY_PROFILE_MAP[id];
    if (!USERS.some((u) => u.id === id)) throw new Error('Unknown user');
    const profiles = store.get('profiles');
    const prev = ensureProfileShape(id, profiles[id] || {});
    const nextMmx = { ...prev.mmx, ...(patch.mmx || {}) };
    const nextLife = { ...prev.lifelenz, ...(patch.lifelenz || {}) };
    const nextGmail = { ...prev.gmail, ...(patch.gmail || {}) };
    if (nextMmx.password === '********') nextMmx.password = prev.mmx.password;
    if (nextLife.password === '********') nextLife.password = prev.lifelenz.password;
    if (nextGmail.password === '********') nextGmail.password = prev.gmail.password;
    profiles[id] = ensureProfileShape(id, {
        ...prev,
        displayName: patch.displayName || prev.displayName,
        alertEmail: patch.alertEmail != null ? String(patch.alertEmail).trim() : prev.alertEmail,
        downloadFolder:
            patch.downloadFolder != null ? String(patch.downloadFolder).trim() : prev.downloadFolder,
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
        gmail: {
            email: String(nextGmail.email || '').trim(),
            password: String(nextGmail.password || ''),
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
    const id = store.get('activeUserId');
    if (id && LEGACY_PROFILE_MAP[String(id).toLowerCase()]) {
        const mapped = LEGACY_PROFILE_MAP[String(id).toLowerCase()];
        store.set('activeUserId', mapped);
        return mapped;
    }
    return id;
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
