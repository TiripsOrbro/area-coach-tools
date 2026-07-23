const fs = require('fs');
const path = require('path');

const STATE_FILE =
    process.env.REPORT_DOWNLOAD_STATE_FILE ||
    path.join(require('../../src/paths').mmx.data, 'report-download-schedule-state.json');

function readState() {
    try {
        const raw = fs.readFileSync(STATE_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

function writeState(state) {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

/** True if the scheduled job already ran for this Melbourne calendar day + order date. */
function hasScheduledRunToday(runDateKey, orderDateKey) {
    const state = readState();
    const entry = state.lastScheduledRun;
    if (!entry) return false;
    return entry.runDateKey === runDateKey && entry.orderDateKey === orderDateKey;
}

function markScheduledRun({ runDateKey, orderDateKey, stores, result }) {
    const state = readState();
    state.lastScheduledRun = {
        runDateKey,
        orderDateKey,
        stores: stores || [],
        completedAt: new Date().toISOString(),
        result,
    };
    writeState(state);
}

module.exports = {
    hasScheduledRunToday,
    markScheduledRun,
    readState,
};
