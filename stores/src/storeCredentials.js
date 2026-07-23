const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const paths = require('../../src/paths');

const STORE_CREDENTIALS_DIR =
    process.env.STORE_CREDENTIALS_DIR || path.join(paths.stores.data, 'store-logins');
const VALID_SERVICES = ['mmx', 'lifelenz', 'smg', 'nsf'];

function credentialsKey() {
    const keyMaterial = String(
        process.env.STORE_CREDENTIALS_KEY || process.env.MMX_USER_CREDENTIALS_KEY || ''
    ).trim();
    if (keyMaterial) {
        return crypto.createHash('sha256').update(keyMaterial).digest();
    }
    if (process.env.NODE_ENV === 'production') {
        throw new Error(
            'Set STORE_CREDENTIALS_KEY or MMX_USER_CREDENTIALS_KEY in production to encrypt store portal credentials.'
        );
    }
    console.warn(
        '[Store credentials] No encryption key in env - using development-only key. Set STORE_CREDENTIALS_KEY on the server.'
    );
    return crypto.createHash('sha256').update('dashboard-store-credentials-dev').digest();
}

function encryptPayload(payload) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', credentialsKey(), iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
        iv: iv.toString('base64'),
        tag: tag.toString('base64'),
        data: data.toString('base64'),
    };
}

function decryptPayload(blob) {
    const iv = Buffer.from(blob.iv, 'base64');
    const tag = Buffer.from(blob.tag, 'base64');
    const data = Buffer.from(blob.data, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', credentialsKey(), iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(data), decipher.final()]);
    return JSON.parse(plain.toString('utf8'));
}

function normalizeStoreNumber(storeNumber) {
    return String(storeNumber || '').trim().replace(/\D/g, '');
}

function normalizeService(service) {
    return String(service || '').trim().toLowerCase();
}

function isValidService(service) {
    return VALID_SERVICES.includes(normalizeService(service));
}

function storeCredentialsPath(storeNumber) {
    const store = normalizeStoreNumber(storeNumber);
    if (!store) return null;
    return path.join(STORE_CREDENTIALS_DIR, `${store}.json`);
}

function emptyStoreFile(storeNumber) {
    const store = normalizeStoreNumber(storeNumber);
    const services = {};
    for (const svc of VALID_SERVICES) {
        services[svc] = { primary: null, fallbacks: [] };
    }
    return { storeNumber: store, services };
}

function readStoreFileRaw(storeNumber) {
    const file = storeCredentialsPath(storeNumber);
    if (!file || !fs.existsSync(file)) return null;
    try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        const base = emptyStoreFile(storeNumber);
        base.storeNumber = normalizeStoreNumber(raw.storeNumber || storeNumber);
        for (const svc of VALID_SERVICES) {
            const row = raw.services?.[svc] || {};
            base.services[svc] = {
                primary: row.primary || null,
                fallbacks: Array.isArray(row.fallbacks) ? row.fallbacks : [],
            };
        }
        return base;
    } catch {
        return null;
    }
}

function writeStoreFile(storeNumber, data) {
    const file = storeCredentialsPath(storeNumber);
    if (!file) return { ok: false, error: 'Store number is required.' };
    try {
        fs.mkdirSync(STORE_CREDENTIALS_DIR, { recursive: true });
        fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
        return { ok: true };
    } catch (error) {
        return { ok: false, error: error.message || 'Could not save store credentials.' };
    }
}

function decryptEntry(entry) {
    if (!entry?.encrypted?.iv || !entry?.encrypted?.data || !entry?.encrypted?.tag) return null;
    try {
        return decryptPayload(entry.encrypted);
    } catch (error) {
        console.warn(`[Store credentials] Could not decrypt entry: ${error.message}`);
        return null;
    }
}

function serviceLoginField(service) {
    return normalizeService(service) === 'lifelenz' ? 'email' : 'username';
}

function normalizeCredsForService(service, creds) {
    const svc = normalizeService(service);
    if (svc === 'lifelenz') {
        const email = String(creds?.email || creds?.lifelenzEmail || creds?.username || '').trim();
        const password = String(creds?.password || creds?.lifelenzPassword || '');
        if (!email || !password) return null;
        return { email, password };
    }
    const username = String(creds?.username || creds?.mmxUsername || '').trim();
    const password = String(creds?.password || creds?.mmxPassword || '');
    if (!username || !password) return null;
    return { username, password };
}

function credsToPlainObject(service, creds) {
    const normalized = normalizeCredsForService(service, creds);
    if (!normalized) return null;
    return normalized;
}

function maskLoginIdentifier(service, value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    if (raw.includes('@')) {
        const [local, domain] = raw.split('@');
        if (!domain) return `${raw.slice(0, 3)}***`;
        const localMask =
            local.length <= 4
                ? `${local.slice(0, 1)}***`
                : `${local.slice(0, 4)}${'*'.repeat(Math.max(4, local.length - 6))}${local.slice(-2)}`;
        return `${localMask}@${domain}`;
    }
    if (raw.length <= 6) return `${raw.slice(0, 2)}***`;
    return `${raw.slice(0, 3)}${'*'.repeat(Math.max(3, raw.length - 5))}${raw.slice(-2)}`;
}

function maskEntryForStatus(service, entry) {
    if (!entry) return null;
    const decrypted = decryptEntry(entry);
    const loginField = serviceLoginField(service);
    const loginValue = decrypted?.[loginField] || decrypted?.username || decrypted?.email || '';
    return {
        id: entry.id || 'primary',
        label: String(entry.label || 'Primary').trim() || 'Primary',
        maskedLogin: maskLoginIdentifier(service, loginValue),
        updatedBy: String(entry.updatedBy || '').trim(),
        updatedAt: String(entry.updatedAt || '').trim(),
        configured: Boolean(loginValue),
    };
}

function buildEncryptedEntry(service, creds, actor, label, id) {
    const plain = credsToPlainObject(service, creds);
    if (!plain) return null;
    const now = new Date().toISOString();
    const actorName = String(actor || '').trim() || 'Unknown';
    return {
        id: id || `fb-${crypto.randomBytes(4).toString('hex')}`,
        label: String(label || 'Primary').trim() || 'Primary',
        encrypted: encryptPayload(plain),
        updatedBy: actorName,
        updatedAt: now,
    };
}

function listCredentialCandidates(storeNumber, service) {
    const svc = normalizeService(service);
    if (!isValidService(svc)) return [];

    const out = [];
    const seen = new Set();

    // Active Ash/Tom coach session takes priority over per-store portal logins.
    try {
        const { coachCandidates } = require('./coachSession');
        for (const row of coachCandidates(svc)) {
            const loginValue = String(row.username || row.email || '').trim();
            const password = String(row.password || '');
            if (!loginValue || !password) continue;
            const key = `${loginValue}\0${password}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(row);
        }
    } catch {
        /* ignore */
    }

    const raw = readStoreFileRaw(storeNumber);
    if (!raw) return out;

    const block = raw.services[svc] || { primary: null, fallbacks: [] };

    function push(entry, source) {
        if (!entry) return;
        const decrypted = decryptEntry(entry);
        if (!decrypted) return;
        const loginField = serviceLoginField(svc);
        const loginValue = String(decrypted[loginField] || decrypted.username || decrypted.email || '').trim();
        const password = String(decrypted.password || '');
        if (!loginValue || !password) return;
        const key = `${loginValue}\0${password}`;
        if (seen.has(key)) return;
        seen.add(key);
        if (svc === 'lifelenz') {
            out.push({
                email: loginValue,
                password,
                source,
                label: entry.label || source,
                updatedBy: entry.updatedBy || '',
            });
        } else {
            out.push({
                username: loginValue,
                password,
                source,
                label: entry.label || source,
                updatedBy: entry.updatedBy || '',
            });
        }
    }

    push(block.primary, `${svc}/primary`);
    for (const fb of block.fallbacks) {
        push(fb, `${svc}/fallback/${fb.id || 'unknown'}`);
    }
    return out;
}

function getServiceStatus(storeNumber, service) {
    const svc = normalizeService(service);
    if (!isValidService(svc)) return { configured: false, primary: null, fallbacks: [] };
    const raw = readStoreFileRaw(storeNumber);
    const block = raw?.services?.[svc] || { primary: null, fallbacks: [] };
    const primary = maskEntryForStatus(svc, block.primary);
    const fallbacks = (block.fallbacks || []).map((row) => maskEntryForStatus(svc, row)).filter(Boolean);
    return {
        configured: Boolean(primary?.configured) || fallbacks.some((row) => row.configured),
        primary,
        fallbacks,
    };
}

function getStoreCredentialsSummary(storeNumber) {
    const store = normalizeStoreNumber(storeNumber);
    const services = {};
    for (const svc of VALID_SERVICES) {
        services[svc] = getServiceStatus(store, svc);
    }
    return { storeNumber: store, services };
}

function storeHasServiceCredentials(storeNumber, service) {
    return listCredentialCandidates(storeNumber, service).length > 0;
}

function savePrimary(storeNumber, service, creds, actor, label = 'Primary') {
    const svc = normalizeService(service);
    if (!isValidService(svc)) return { ok: false, error: 'Invalid service.' };
    const store = normalizeStoreNumber(storeNumber);
    if (!store) return { ok: false, error: 'Store number is required.' };

    const entry = buildEncryptedEntry(svc, creds, actor, label, 'primary');
    if (!entry) return { ok: false, error: 'Credentials are required.' };

    const data = readStoreFileRaw(store) || emptyStoreFile(store);
    data.services[svc].primary = { ...entry, id: 'primary' };
    const result = writeStoreFile(store, data);
    if (!result.ok) return result;
    return { ok: true, updatedAt: entry.updatedAt, updatedBy: entry.updatedBy };
}

function addFallback(storeNumber, service, creds, actor, label = 'Fallback') {
    const svc = normalizeService(service);
    if (!isValidService(svc)) return { ok: false, error: 'Invalid service.' };
    const store = normalizeStoreNumber(storeNumber);
    if (!store) return { ok: false, error: 'Store number is required.' };

    const entry = buildEncryptedEntry(svc, creds, actor, label);
    if (!entry) return { ok: false, error: 'Credentials are required.' };

    const data = readStoreFileRaw(store) || emptyStoreFile(store);
    data.services[svc].fallbacks.push(entry);
    const result = writeStoreFile(store, data);
    if (!result.ok) return result;
    return { ok: true, id: entry.id, updatedAt: entry.updatedAt, updatedBy: entry.updatedBy };
}

function removeFallback(storeNumber, service, fallbackId) {
    const svc = normalizeService(service);
    if (!isValidService(svc)) return { ok: false, error: 'Invalid service.' };
    const store = normalizeStoreNumber(storeNumber);
    const id = String(fallbackId || '').trim();
    if (!store || !id) return { ok: false, error: 'Store and fallback id are required.' };

    const data = readStoreFileRaw(store);
    if (!data) return { ok: false, error: 'Store credentials not found.' };
    const before = data.services[svc].fallbacks.length;
    data.services[svc].fallbacks = data.services[svc].fallbacks.filter((row) => row.id !== id);
    if (data.services[svc].fallbacks.length === before) {
        return { ok: false, error: 'Fallback not found.' };
    }
    return writeStoreFile(store, data);
}

function clearServiceCredentials(storeNumber, service) {
    const svc = normalizeService(service);
    if (!isValidService(svc)) return { ok: false, error: 'Invalid service.' };
    const store = normalizeStoreNumber(storeNumber);
    if (!store) return { ok: false, error: 'Store number is required.' };

    const data = readStoreFileRaw(store) || emptyStoreFile(store);
    data.services[svc] = { primary: null, fallbacks: [] };
    return writeStoreFile(store, data);
}

function readDecryptedPrimary(storeNumber, service) {
    const candidates = listCredentialCandidates(storeNumber, service);
    return candidates[0] || null;
}

module.exports = {
    VALID_SERVICES,
    normalizeStoreNumber,
    isValidService,
    maskLoginIdentifier,
    listCredentialCandidates,
    getServiceStatus,
    getStoreCredentialsSummary,
    storeHasServiceCredentials,
    savePrimary,
    addFallback,
    removeFallback,
    clearServiceCredentials,
    readDecryptedPrimary,
    readStoreFileRaw,
    writeStoreFile,
    credsToPlainObject,
};
