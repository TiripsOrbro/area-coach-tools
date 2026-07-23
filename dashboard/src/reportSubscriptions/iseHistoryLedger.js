const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const paths = require('../../../src/paths');
const { parseInventorySpecialEventFile } = require('../../../vendors/src/reportReader');

const HISTORY_DIR = path.join(paths.dashboard.data, 'ise-history');
const RETAIN_DAYS = Number(process.env.ISE_HISTORY_DAYS || process.env.FORECAST_HISTORY_DAYS || 35);
const WEEKS_NEEDED = 5;
const MAX_ISE_WEEKS = 12;
const TIME_ZONE = String(process.env.DASHBOARD_TIME_ZONE || 'Australia/Melbourne').trim();

function melbourneTodayIso() {
    return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(new Date());
}

function resolveWeeksNeeded(dateRange = {}) {
    const raw = dateRange.weeks ?? WEEKS_NEEDED;
    const weeks = Number(raw);
    if (!Number.isFinite(weeks)) return WEEKS_NEEDED;
    return Math.min(MAX_ISE_WEEKS, Math.max(1, Math.floor(weeks)));
}

function resolveIseWeeksDateRange(dateRange = {}) {
    const weeks = resolveWeeksNeeded(dateRange);
    const endDate = resolveCoverageEndDate(dateRange);
    const anchorDates = weeklySnapshotAnchorDates(endDate, weeks);
    const startDate = anchorDates[anchorDates.length - 1] || endDate;
    return {
        mode: 'ise-weeks',
        weeks,
        endOffsetDays: Number(dateRange.endOffsetDays ?? 1),
        endDate,
        startDate,
        anchorDates,
    };
}

function resolveCoverageEndDate(dateRange = {}) {
    const endDate = String(dateRange.endDate || '').trim();
    if (endDate) return endDate;
    const endOffsetDays = Number(dateRange.endOffsetDays ?? 1);
    return addDaysToIso(
        melbourneTodayIso(),
        -Math.max(0, Number.isFinite(endOffsetDays) ? endOffsetDays : 1)
    );
}

/**
 * Weekly ISE report anchors ending at coverageEndDate (inclusive).
 * Matches the pipeline default of startDate=yesterday for the latest week.
 */
function weeklySnapshotAnchorDates(coverageEndDate, weeksNeeded = WEEKS_NEEDED) {
    const end = String(coverageEndDate || '').trim() || addDaysToIso(melbourneTodayIso(), -1);
    const anchors = [];
    for (let week = 0; week < weeksNeeded; week += 1) {
        anchors.push(addDaysToIso(end, -7 * week));
    }
    return anchors;
}

function historyFilePath(storeNumber) {
    const key = String(storeNumber || '').replace(/[^0-9a-z]/gi, '');
    return path.join(HISTORY_DIR, `${key || 'unknown'}.json`);
}

function emptyStoreHistory(storeNumber) {
    return {
        storeNumber: String(storeNumber || '').trim(),
        snapshots: [],
        updatedAt: null,
    };
}

function readStoreIseHistory(storeNumber) {
    const filePath = historyFilePath(storeNumber);
    if (!fs.existsSync(filePath)) return emptyStoreHistory(storeNumber);
    try {
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        return {
            ...emptyStoreHistory(storeNumber),
            ...raw,
            storeNumber: String(raw.storeNumber || storeNumber).trim(),
            snapshots: Array.isArray(raw.snapshots) ? raw.snapshots : [],
        };
    } catch {
        return emptyStoreHistory(storeNumber);
    }
}

function writeStoreIseHistory(doc) {
    const store = String(doc?.storeNumber || '').trim();
    if (!store) throw new Error('storeNumber is required');
    fs.mkdirSync(HISTORY_DIR, { recursive: true });
    fs.writeFileSync(historyFilePath(store), `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
    return doc;
}

function addDaysToIso(iso, days) {
    const [y, m, d] = String(iso || '').split('-').map(Number);
    if (!y || !m || !d) return '';
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + (Number(days) || 0));
    return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

function pruneSnapshots(doc) {
    const cutoff = addDaysToIso(
        new Intl.DateTimeFormat('en-CA', {
            timeZone: process.env.DASHBOARD_TIME_ZONE || 'Australia/Melbourne',
        }).format(new Date()),
        -RETAIN_DAYS
    );
    doc.snapshots = (doc.snapshots || []).filter((s) => String(s.date || '') >= cutoff);
}

function fingerprintIseItems(items) {
    const codes = Object.keys(items || {})
        .sort()
        .slice(0, 40);
    const chunks = codes.map((code) => {
        const row = items[code] || {};
        return `${code}:${(row.dayValues || []).join('|')}`;
    });
    return crypto.createHash('sha1').update(chunks.join(';')).digest('hex');
}

function findSnapshotByFingerprint(doc, fingerprint, excludeDate = '') {
    const skip = String(excludeDate || '').trim();
    return (
        (doc.snapshots || []).find(
            (snap) =>
                String(snap.date || '').trim() !== skip &&
                fingerprintIseItems(snap.items) === fingerprint
        ) || null
    );
}

/**
 * Append or replace an ISE snapshot for a store/date from a downloaded CSV file.
 */
function recordIseSnapshotFromFile(storeNumber, filePath, options = {}) {
    const store = String(storeNumber || '').trim();
    const dateKey = String(options.date || options.dateKey || '').trim();
    if (!store || !filePath) throw new Error('storeNumber and filePath are required');

    const parsed = parseInventorySpecialEventFile(filePath);
    const items = {};
    for (const [code, row] of parsed.items.entries()) {
        items[code] = {
            itemCode: row.itemCode,
            description: row.description,
            unit: row.unit,
            dayLabels: row.dayLabels || parsed.dayLabels || [],
            dayValues: row.dayValues || [],
            avgDaily: row.avgDaily,
        };
    }

    const fingerprint = fingerprintIseItems(items);
    const doc = readStoreIseHistory(store);
    const duplicate = findSnapshotByFingerprint(doc, fingerprint, dateKey);
    if (duplicate) {
        throw new Error(
            `ISE data for ${dateKey || 'this week'} matches the snapshot already stored for ${duplicate.date}. ` +
                'Macromatix likely returned the same report — check the start date was applied.'
        );
    }

    const snapshotDate =
        dateKey ||
        new Intl.DateTimeFormat('en-CA', {
            timeZone: process.env.DASHBOARD_TIME_ZONE || 'Australia/Melbourne',
        }).format(new Date());

    doc.snapshots = (doc.snapshots || []).filter((s) => s.date !== snapshotDate);
    doc.snapshots.push({
        date: snapshotDate,
        sourceFile: path.basename(filePath),
        capturedAt: new Date().toISOString(),
        dayLabels: parsed.dayLabels || [],
        items,
        fingerprint,
    });
    doc.snapshots.sort((a, b) => String(a.date).localeCompare(String(b.date)));
    pruneSnapshots(doc);
    doc.updatedAt = new Date().toISOString();
    writeStoreIseHistory(doc);
    return doc.snapshots[doc.snapshots.length - 1];
}

function listSnapshotsInRange(storeNumber, startDate, endDate) {
    const doc = readStoreIseHistory(storeNumber);
    const start = String(startDate || '').trim();
    const end = String(endDate || '').trim();
    return (doc.snapshots || []).filter((s) => {
        const d = String(s.date || '');
        return (!start || d >= start) && (!end || d <= end);
    });
}

function listWeeklySnapshots(storeNumber, dateRange = {}, weeksNeeded = WEEKS_NEEDED) {
    const weeks = resolveWeeksNeeded({ ...dateRange, weeks: weeksNeeded ?? dateRange.weeks });
    const coverageEndDate = resolveCoverageEndDate(dateRange);
    const anchors = weeklySnapshotAnchorDates(coverageEndDate, weeks);
    const doc = readStoreIseHistory(storeNumber);
    const byDate = new Map((doc.snapshots || []).map((s) => [String(s.date || ''), s]));
    return anchors.map((date) => byDate.get(date) || null);
}

function assessIseCoverage(storeNumber, dateRange = {}) {
    const weeksNeeded = resolveWeeksNeeded(dateRange);
    const endDate = resolveCoverageEndDate(dateRange);
    const anchorDates = weeklySnapshotAnchorDates(endDate, weeksNeeded);
    const doc = readStoreIseHistory(storeNumber);
    const snapshotDates = new Set((doc.snapshots || []).map((s) => String(s.date || '')));
    const presentDates = anchorDates.filter((date) => snapshotDates.has(date));
    const missingSnapshotDates = anchorDates.filter((date) => !snapshotDates.has(date));
    const startDate = anchorDates[anchorDates.length - 1] || endDate;
    return {
        storeNumber: String(storeNumber),
        startDate,
        endDate,
        anchorDates,
        snapshotCount: presentDates.length,
        weeksNeeded,
        ready: presentDates.length >= weeksNeeded,
        missingWeeks: Math.max(0, weeksNeeded - presentDates.length),
        missingSnapshotDates,
        snapshotDates: presentDates,
    };
}

module.exports = {
    HISTORY_DIR,
    WEEKS_NEEDED,
    MAX_ISE_WEEKS,
    readStoreIseHistory,
    writeStoreIseHistory,
    recordIseSnapshotFromFile,
    listSnapshotsInRange,
    listWeeklySnapshots,
    weeklySnapshotAnchorDates,
    resolveCoverageEndDate,
    resolveWeeksNeeded,
    resolveIseWeeksDateRange,
    assessIseCoverage,
    fingerprintIseItems,
    addDaysToIso,
    melbourneTodayIso,
};
