const fs = require('fs');
const path = require('path');

const paths = require('../../../src/paths');

const STATE_FILE = path.join(paths.dashboard.data, 'daily-reports-run-state.json');
const TIME_ZONE = String(process.env.DASHBOARD_TIME_ZONE || 'Australia/Melbourne').trim();

function writeJsonAtomic(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, filePath);
}

function melbourneDateKey(date = new Date()) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(
        date instanceof Date ? date : new Date(date)
    );
}

function readState() {
    if (!fs.existsSync(STATE_FILE)) return { runs: {} };
    try {
        const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        return raw && typeof raw === 'object' ? raw : { runs: {} };
    } catch {
        return { runs: {} };
    }
}

function hasCompletedDailyRun(dateKey = melbourneDateKey()) {
    const key = String(dateKey || '').trim();
    if (!key) return false;
    const state = readState();
    return Boolean(state.runs?.[key]?.completedAt);
}

function markDailyRunComplete(dateKey, summary = {}) {
    const key = String(dateKey || melbourneDateKey()).trim();
    const state = readState();
    state.runs = state.runs || {};
    state.runs[key] = {
        dateKey: key,
        completedAt: new Date().toISOString(),
        ...summary,
    };
    writeJsonAtomic(STATE_FILE, state);
    return state.runs[key];
}

/** Clear today's completed marker so a manual re-run can proceed. */
function clearDailyRun(dateKey = melbourneDateKey()) {
    const key = String(dateKey || '').trim();
    if (!key) return false;
    const state = readState();
    if (!state.runs?.[key]) return false;
    delete state.runs[key];
    writeJsonAtomic(STATE_FILE, state);
    return true;
}

module.exports = {
    STATE_FILE,
    TIME_ZONE,
    melbourneDateKey,
    hasCompletedDailyRun,
    markDailyRunComplete,
    clearDailyRun,
    readState,
};
