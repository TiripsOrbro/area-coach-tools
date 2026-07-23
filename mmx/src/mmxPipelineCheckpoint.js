const fs = require('fs').promises;
const path = require('path');

const CHECKPOINT_FILE =
    process.env.MMX_PIPELINE_CHECKPOINT_FILE ||
    path.join(require('../../src/paths').vendors.data, 'mmx-pipeline-checkpoints.json');

let cache = null;

function emptyState() {
    return { stores: {} };
}

async function readFileState() {
    try {
        const raw = await fs.readFile(CHECKPOINT_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && parsed.stores && typeof parsed.stores === 'object') {
            return parsed;
        }
    } catch (error) {
        if (error.code !== 'ENOENT') {
            console.warn('[MMX Checkpoint] Failed to read checkpoint file:', error.message);
        }
    }
    return emptyState();
}

async function writeFileState(state) {
    await fs.mkdir(path.dirname(CHECKPOINT_FILE), { recursive: true });
    // Atomic write (tmp + rename) so a crash mid-write can't truncate resume state.
    const tmp = `${CHECKPOINT_FILE}.${process.pid}.${Date.now()}.tmp`;
    try {
        await fs.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
        await fs.rename(tmp, CHECKPOINT_FILE);
    } catch (error) {
        try {
            await fs.unlink(tmp);
        } catch {
            /* already renamed or never created */
        }
        // Windows EBUSY/EPERM on rename: fall back to direct write rather than losing the update.
        if (error.code === 'EBUSY' || error.code === 'EPERM' || error.code === 'EACCES') {
            await fs.writeFile(CHECKPOINT_FILE, JSON.stringify(state, null, 2), 'utf8');
            return;
        }
        throw error;
    }
}

async function getState() {
    if (!cache) cache = await readFileState();
    return cache;
}

function keyForStore(storeNumber) {
    return String(storeNumber || '').trim();
}

async function setCheckpoint(storeNumber, patch) {
    const all = await getState();
    const key = keyForStore(storeNumber);
    const prev = all.stores[key] && typeof all.stores[key] === 'object' ? all.stores[key] : {};
    all.stores[key] = {
        ...prev,
        ...patch,
        storeNumber: key,
        updatedAt: new Date().toISOString(),
    };
    cache = all;
    await writeFileState(all);
    return all.stores[key];
}

async function getCheckpoint(storeNumber) {
    const all = await getState();
    return all.stores[keyForStore(storeNumber)] || null;
}

async function clearCheckpoint(storeNumber) {
    const all = await getState();
    const key = keyForStore(storeNumber);
    if (!all.stores[key]) return false;
    delete all.stores[key];
    cache = all;
    await writeFileState(all);
    return true;
}

async function listAllCheckpoints() {
    const all = await getState();
    return { ...all.stores };
}

module.exports = {
    CHECKPOINT_FILE,
    setCheckpoint,
    getCheckpoint,
    clearCheckpoint,
    listAllCheckpoints,
};
