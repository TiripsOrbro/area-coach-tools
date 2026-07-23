const fs = require('fs');
const path = require('path');
const paths = require('../../src/paths');

const STATE_FILE =
    process.env.ORDERING_DAY_STATE_FILE ||
    path.join(paths.vendors.data, 'ordering-day-state.json');

const STATUS = {
    UNCHECKED: 'unchecked',
    ACTIVE: 'active',
    NO_ORDERS: 'no_orders',
    COMPLETE: 'complete',
};

let cache = null;
let cacheMtime = 0;

function emptyDoc(dateKey = '') {
    return {
        dateKey: String(dateKey || ''),
        morningPrecheckCompletedAt: null,
        stores: {},
    };
}

function readDoc() {
    try {
        if (!fs.existsSync(STATE_FILE)) return emptyDoc();
        const stat = fs.statSync(STATE_FILE);
        if (cache && stat.mtimeMs === cacheMtime) return cache;
        const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        cache = {
            dateKey: String(raw?.dateKey || ''),
            morningPrecheckCompletedAt: raw?.morningPrecheckCompletedAt || null,
            stores: raw?.stores && typeof raw.stores === 'object' ? raw.stores : {},
        };
        cacheMtime = stat.mtimeMs;
        return cache;
    } catch {
        return emptyDoc();
    }
}

function writeDoc(doc) {
    const next = {
        dateKey: String(doc?.dateKey || ''),
        morningPrecheckCompletedAt: doc?.morningPrecheckCompletedAt || null,
        stores: doc?.stores && typeof doc.stores === 'object' ? doc.stores : {},
    };
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    cache = next;
    cacheMtime = fs.existsSync(STATE_FILE) ? fs.statSync(STATE_FILE).mtimeMs : 0;
    return next;
}

function storeKey(storeNumber) {
    return String(storeNumber || '').replace(/\D/g, '') || '__default__';
}

function ensureDocForDate(dateKey) {
    const doc = readDoc();
    const key = String(dateKey || '');
    if (doc.dateKey === key) return doc;
    return writeDoc(emptyDoc(key));
}

function getStoreEntry(storeNumber, dateKey) {
    const doc = ensureDocForDate(dateKey);
    const sk = storeKey(storeNumber);
    return doc.stores[sk] || { status: STATUS.UNCHECKED, pendingVendors: [] };
}

function patchStoreEntry(storeNumber, dateKey, patch) {
    const doc = ensureDocForDate(dateKey);
    const sk = storeKey(storeNumber);
    const prev = doc.stores[sk] || { status: STATUS.UNCHECKED, pendingVendors: [] };
    doc.stores[sk] = {
        ...prev,
        ...patch,
        pendingVendors: Array.isArray(patch.pendingVendors)
            ? [...patch.pendingVendors]
            : prev.pendingVendors || [],
        updatedAt: new Date().toISOString(),
    };
    return writeDoc(doc).stores[sk];
}

/**
 * Only skip MMX scheduled-orders checks after the store actually finished placing
 * orders. False empties (wrong list date / flaky probe) must not lock the day.
 */
function shouldSkipPendingVendorScrape(storeNumber, dateKey) {
    const entry = getStoreEntry(storeNumber, dateKey);
    if (entry.status !== STATUS.COMPLETE) return false;
    return String(entry.completeReason || '') === 'orders_pipeline';
}

function isScheduledOrdersCompleteToday(storeNumber, dateKey) {
    return shouldSkipPendingVendorScrape(storeNumber, dateKey);
}

function morningPrecheckCompletedFor(dateKey) {
    const doc = readDoc();
    return doc.dateKey === String(dateKey || '') && Boolean(doc.morningPrecheckCompletedAt);
}

function markMorningPrecheckCompleted(dateKey) {
    const doc = ensureDocForDate(dateKey);
    doc.morningPrecheckCompletedAt = new Date().toISOString();
    return writeDoc(doc);
}

function markMorningPrecheckNoOrders(storeNumber, dateKey) {
    return patchStoreEntry(storeNumber, dateKey, {
        status: STATUS.NO_ORDERS,
        pendingVendors: [],
        morningPrecheckAt: new Date().toISOString(),
    });
}

function markMorningPrecheckActive(storeNumber, dateKey, pendingVendors = []) {
    return patchStoreEntry(storeNumber, dateKey, {
        status: STATUS.ACTIVE,
        pendingVendors: [...pendingVendors],
        morningPrecheckAt: new Date().toISOString(),
    });
}

function markStoreActivePending(storeNumber, dateKey, pendingVendors = []) {
    const entry = getStoreEntry(storeNumber, dateKey);
    // Real pending rows always reopen the day — including after a false no_orders /
    // confirmed_empty lock. Only an orders_pipeline complete stays closed.
    if (
        entry.status === STATUS.COMPLETE &&
        String(entry.completeReason || '') === 'orders_pipeline'
    ) {
        return entry;
    }
    return patchStoreEntry(storeNumber, dateKey, {
        status: STATUS.ACTIVE,
        pendingVendors: [...pendingVendors],
        emptyCheckCount: 0,
        completeAt: null,
        completeReason: null,
    });
}

function markStoreOrdersComplete(storeNumber, dateKey, reason = 'orders_complete') {
    return patchStoreEntry(storeNumber, dateKey, {
        status: STATUS.COMPLETE,
        pendingVendors: [],
        completeAt: new Date().toISOString(),
        completeReason: String(reason || 'orders_complete'),
    });
}

function recordEmptyPendingVendorScrape(storeNumber, dateKey, options = {}) {
    const entry = getStoreEntry(storeNumber, dateKey);
    if (entry.status === STATUS.NO_ORDERS || entry.status === STATUS.COMPLETE) {
        return { status: entry.status, markedComplete: false };
    }

    const requiredChecks = Number.isFinite(options.requiredChecks)
        ? Math.max(1, Math.floor(options.requiredChecks))
        : Number(process.env.CONFIRMED_EMPTY_ORDER_CHECKS || 1);

    const prevCount = Number(entry.emptyCheckCount) || 0;
    const nextCount = prevCount + 1;
    patchStoreEntry(storeNumber, dateKey, {
        status: entry.status === STATUS.UNCHECKED ? STATUS.ACTIVE : entry.status,
        pendingVendors: [],
        emptyCheckCount: nextCount,
    });

    if (nextCount >= requiredChecks) {
        markStoreOrdersComplete(storeNumber, dateKey, 'confirmed_empty_scrape');
        return { status: STATUS.COMPLETE, markedComplete: true };
    }
    return { status: entry.status, markedComplete: false, emptyCheckCount: nextCount };
}

function recordPendingVendorScrape(storeNumber, dateKey, pendingVendors = [], options = {}) {
    const vendors = Array.isArray(pendingVendors) ? pendingVendors.map(String) : [];
    if (!vendors.length) {
        return recordEmptyPendingVendorScrape(storeNumber, dateKey, options);
    }
    markStoreActivePending(storeNumber, dateKey, vendors);
    return { status: STATUS.ACTIVE, pendingVendors: vendors, markedComplete: false };
}

function resetStoreForNewDay(storeNumber, dateKey) {
    const doc = ensureDocForDate(dateKey);
    const sk = storeKey(storeNumber);
    if (doc.stores[sk]) {
        delete doc.stores[sk];
        writeDoc(doc);
    }
}

function resetAllForNewDay(dateKey) {
    return writeDoc(emptyDoc(dateKey));
}

function getOrderingDayStatusForApi(storeNumber, dateKey) {
    const entry = getStoreEntry(storeNumber, dateKey);
    return {
        status: entry.status || STATUS.UNCHECKED,
        pendingVendors: Array.isArray(entry.pendingVendors) ? entry.pendingVendors : [],
        morningPrecheckAt: entry.morningPrecheckAt || null,
        completeAt: entry.completeAt || null,
        completeReason: entry.completeReason || null,
        skipVendorChecks: shouldSkipPendingVendorScrape(storeNumber, dateKey),
        morningPrecheckCompleted: morningPrecheckCompletedFor(dateKey),
    };
}

function applyMorningPrecheckResults(dateKey, probeResults = []) {
    const doc = ensureDocForDate(dateKey);
    for (const row of probeResults) {
        const storeNumber = String(row?.storeNumber || '').trim();
        if (!storeNumber) continue;
        const vendors = Array.isArray(row.pendingVendors) ? row.pendingVendors : [];
        if (row.error) continue;
        if (row.hasOrders === false || vendors.length === 0) {
            markMorningPrecheckNoOrders(storeNumber, dateKey);
        } else {
            markMorningPrecheckActive(storeNumber, dateKey, vendors);
        }
    }
    markMorningPrecheckCompleted(dateKey);
    return writeDoc(doc);
}

module.exports = {
    STATE_FILE,
    STATUS,
    shouldSkipPendingVendorScrape,
    isScheduledOrdersCompleteToday,
    morningPrecheckCompletedFor,
    markMorningPrecheckCompleted,
    markMorningPrecheckNoOrders,
    markMorningPrecheckActive,
    markStoreActivePending,
    markStoreOrdersComplete,
    recordPendingVendorScrape,
    recordEmptyPendingVendorScrape,
    resetStoreForNewDay,
    resetAllForNewDay,
    getStoreEntry,
    getOrderingDayStatusForApi,
    applyMorningPrecheckResults,
};
