const fs = require('fs').promises;
const path = require('path');
const {
    aggregateCounts,
    getVendorCatalog,
    vendorLabelToSlug,
} = require('./vendorCatalog');
const { isCombinedStockCountSlug } = require('./combinedStockCountCatalog');
const { isTestStore, TEST_STORE_SLUG } = require('../../stores/src/testStore');

const STATE_FILE =
    process.env.STOCK_COUNT_STATE_FILE || path.join(require('../../src/paths').vendors.data, 'stock-count-state.json');
const TIME_ZONE = process.env.DASHBOARD_TIME_ZONE || 'Australia/Melbourne';

let stateCache = null;

function storeKey(storeNumber) {
    const raw = String(storeNumber || '').trim().toLowerCase();
    if (isTestStore(raw)) return TEST_STORE_SLUG;
    const digits = raw.replace(/[^0-9]/g, '');
    return digits || '__default__';
}

function vendorSlugKey(vendorSlug) {
    return String(vendorSlug || '').trim().toLowerCase();
}

function melbourneDateKey(date = new Date()) {
    return date.toLocaleDateString('en-CA', { timeZone: TIME_ZONE });
}

function emptyState() {
    return { stores: {} };
}

async function readStateFile() {
    try {
        const raw = await fs.readFile(STATE_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && parsed.stores && typeof parsed.stores === 'object') {
            return { stores: parsed.stores };
        }
        return emptyState();
    } catch (error) {
        if (error.code !== 'ENOENT') {
            console.warn('[StockCount] Failed to read state file:', error.message);
        }
        return emptyState();
    }
}

async function writeStateFile(state) {
    await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });
    await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

async function getStateAll() {
    if (!stateCache) {
        stateCache = await readStateFile();
    }
    return stateCache;
}

function normalizeCounts(counts) {
    const out = {};
    if (!counts || typeof counts !== 'object') return out;
    for (const [colKey, raw] of Object.entries(counts)) {
        const n = Number(raw);
        if (!Number.isFinite(n) || n < 0) continue;
        out[String(colKey)] = n;
    }
    return out;
}

function normalizeLocationPayload(catalog, locationPayload, locationName) {
    const out = {};
    if (!locationPayload || typeof locationPayload !== 'object') return out;
    const allowedItems = new Set(
        catalog.items.filter((item) => item.locations.includes(locationName)).map((item) => item.key)
    );
    const itemByKey = new Map(catalog.items.map((i) => [i.key, i]));

    for (const [itemKey, counts] of Object.entries(locationPayload)) {
        if (!allowedItems.has(itemKey)) continue;
        const item = itemByKey.get(itemKey);
        if (!item) continue;
        const normalized = normalizeCounts(counts);
        const allowed = new Set(item.columns.map((c) => c.key));
        const filtered = {};
        for (const [k, v] of Object.entries(normalized)) {
            if (allowed.has(k)) filtered[k] = v;
        }
        if (Object.keys(filtered).length) out[itemKey] = filtered;
    }
    return out;
}

async function getDraft(storeNumber, vendorSlug, dateKey = melbourneDateKey()) {
    const catalog = getVendorCatalog(vendorSlug, { forStockCount: true, storeNumber });
    if (!catalog) return null;

    const all = await getStateAll();
    const store = all.stores[storeKey(storeNumber)] || {};
    const vendor = store[vendorSlugKey(vendorSlug)] || {};
    const day = vendor[dateKey] || { locations: {} };

    return {
        success: true,
        storeNumber: storeKey(storeNumber),
        vendorSlug: vendorSlugKey(vendorSlug),
        vendorLabel: catalog.label,
        dateKey,
        locations: day.locations || {},
        updatedAt: day.updatedAt || null,
        submittedAt: day.submittedAt || null,
        mmxSentAt: day.mmxSentAt || null,
    };
}

function summaryHasCounts(items) {
    if (!Array.isArray(items)) return false;
    return items.some(
        (row) =>
            row?.columns &&
            typeof row.columns === 'object' &&
            Object.values(row.columns).some((v) => Number(v) > 0)
    );
}

async function getStockCountQueueStatus(storeNumber, options = {}) {
    const dateKey = options.dateKey || melbourneDateKey();
    const currentVendorSlug = vendorSlugKey(options.vendorSlug);
    const all = await getStateAll();
    const sk = storeKey(storeNumber);
    const store = all.stores[sk] || {};

    const queue = [];
    const seen = new Set();

    for (const slug of Object.keys(store).sort()) {
        const day = store[slug]?.[dateKey];
        if (!day) continue;
        const catalog = getVendorCatalog(slug, { forStockCount: true, storeNumber });
        if (!catalog) continue;
        const hasDraft =
            day.locations &&
            typeof day.locations === 'object' &&
            Object.values(day.locations).some(
                (items) =>
                    items &&
                    typeof items === 'object' &&
                    Object.values(items).some(
                        (counts) =>
                            counts &&
                            typeof counts === 'object' &&
                            Object.values(counts).some((n) => Number(n) > 0)
                    )
            );
        if (!day.submittedAt && !day.mmxSentAt && !hasDraft) continue;
        queue.push({
            slug,
            label: catalog.label,
            submittedAt: day.submittedAt || null,
            mmxSentAt: day.mmxSentAt || null,
        });
        seen.add(slug);
    }

    const ensureSlugs =
        isCombinedStockCountSlug(currentVendorSlug) && Array.isArray(options.pendingVendorLabels)
            ? options.pendingVendorLabels
                  .map((label) => vendorLabelToSlug(label))
                  .filter(Boolean)
            : currentVendorSlug
              ? [currentVendorSlug]
              : [];

    for (const slug of ensureSlugs) {
        if (!slug || seen.has(slug) || isCombinedStockCountSlug(slug)) continue;
        const catalog = getVendorCatalog(slug, { forStockCount: true, storeNumber });
        if (!catalog) continue;
        const day = store[slug]?.[dateKey];
        queue.push({
            slug,
            label: catalog.label,
            submittedAt: day?.submittedAt || null,
            mmxSentAt: day?.mmxSentAt || null,
        });
        seen.add(slug);
    }

    const submitted = queue.filter((entry) => entry.submittedAt);
    const submittedNotSent = queue.filter((entry) => entry.submittedAt && !entry.mmxSentAt);
    const submittedCount = submitted.length;
    const canSendToMmx = submittedCount > 0;
    const allMmxSent =
        submittedCount > 0 && queue.filter((entry) => entry.submittedAt).every((entry) => entry.mmxSentAt);

    return {
        dateKey,
        storeNumber: sk,
        vendorSlug: currentVendorSlug,
        queue,
        canSendToMmx,
        allMmxSent,
        submittedCount,
        readyToSend: submitted.map((entry) => entry.label),
        pendingSubmitCount: queue.filter((entry) => !entry.submittedAt).length,
    };
}

async function saveDraftLocation(
    storeNumber,
    vendorSlug,
    locationName,
    itemCounts,
    dateKey = melbourneDateKey(),
    options = {}
) {
    const catalog = getVendorCatalog(vendorSlug, { forStockCount: true, storeNumber });
    if (!catalog) return null;

    const loc = String(locationName || '').trim();
    if (!catalog.locations.includes(loc)) {
        throw new Error(`Unknown location: ${locationName}`);
    }

    const normalized = normalizeLocationPayload(catalog, itemCounts, loc);
    const merge = Boolean(options.merge);
    const all = await getStateAll();
    const sk = storeKey(storeNumber);
    const vk = vendorSlugKey(vendorSlug);
    if (!all.stores[sk]) all.stores[sk] = {};
    if (!all.stores[sk][vk]) all.stores[sk][vk] = {};
    if (!all.stores[sk][vk][dateKey]) all.stores[sk][vk][dateKey] = { locations: {} };

    const day = all.stores[sk][vk][dateKey];
    if (day.mmxSentAt) {
        day.mmxSentAt = null;
    }
    if (day.submittedAt) {
        day.submittedAt = null;
    }

    if (merge) {
        const existing =
            day.locations[loc] && typeof day.locations[loc] === 'object' ? { ...day.locations[loc] } : {};
        for (const [itemKey, counts] of Object.entries(normalized)) {
            existing[itemKey] = counts;
        }
        day.locations[loc] = existing;
    } else {
        day.locations[loc] = normalized;
    }
    day.updatedAt = new Date().toISOString();
    stateCache = all;
    await writeStateFile(all);

    return getDraft(storeNumber, vendorSlug, dateKey);
}

async function getSummary(storeNumber, vendorSlug, dateKey = melbourneDateKey()) {
    const catalog = getVendorCatalog(vendorSlug, { forStockCount: true, storeNumber });
    if (!catalog) return null;

    const draft = await getDraft(storeNumber, vendorSlug, dateKey);
    const items = aggregateCounts(catalog, draft.locations);

    return {
        success: true,
        storeNumber: draft.storeNumber,
        vendorSlug: draft.vendorSlug,
        vendorLabel: catalog.label,
        dateKey,
        items,
        submittedAt: draft.submittedAt,
    };
}

async function submitStockCount(storeNumber, vendorSlug, dateKey = melbourneDateKey()) {
    const catalog = getVendorCatalog(vendorSlug, { forStockCount: true, storeNumber });
    if (!catalog) return null;

    const summary = await getSummary(storeNumber, vendorSlug, dateKey);
    if (!summaryHasCounts(summary.items)) {
        throw new Error('Enter at least one count before submitting.');
    }

    const all = await getStateAll();
    const sk = storeKey(storeNumber);
    const vk = vendorSlugKey(vendorSlug);
    if (!all.stores[sk]?.[vk]?.[dateKey]) {
        throw new Error('No stock count draft to submit.');
    }

    const day = all.stores[sk][vk][dateKey];
    if (day.submittedAt) {
        return { ...summary, submittedAt: day.submittedAt, alreadySubmitted: true };
    }

    day.submittedAt = day.submittedAt || new Date().toISOString();
    day.updatedAt = day.submittedAt;
    stateCache = all;
    await writeStateFile(all);

    return {
        ...summary,
        submittedAt: day.submittedAt,
        payload: summary.items,
    };
}

async function reopenStockCount(storeNumber, vendorSlug, dateKey = melbourneDateKey()) {
    const all = await getStateAll();
    const sk = storeKey(storeNumber);
    const vk = vendorSlugKey(vendorSlug);
    const day = all.stores[sk]?.[vk]?.[dateKey];
    if (!day) throw new Error('No stock count draft to reopen.');
    if (day.mmxSentAt) {
        day.mmxSentAt = null;
    }
    if (!day.submittedAt) {
        return getDraft(storeNumber, vendorSlug, dateKey);
    }
    day.submittedAt = null;
    day.updatedAt = new Date().toISOString();
    stateCache = all;
    await writeStateFile(all);
    return getDraft(storeNumber, vendorSlug, dateKey);
}

async function markMmxSent(storeNumber, vendorSlug, dateKey = melbourneDateKey()) {
    const all = await getStateAll();
    const sk = storeKey(storeNumber);
    const vk = vendorSlugKey(vendorSlug);
    const day = all.stores[sk]?.[vk]?.[dateKey];
    if (!day) throw new Error('No stock count state to mark MMX sent.');
    day.mmxSentAt = new Date().toISOString();
    day.updatedAt = day.mmxSentAt;
    stateCache = all;
    await writeStateFile(all);
    return day.mmxSentAt;
}

/** Create a minimal day record when skip-count ordering completes without a draft. */
async function ensureMmxSentRecord(storeNumber, vendorSlug, dateKey = melbourneDateKey()) {
    const all = await getStateAll();
    const sk = storeKey(storeNumber);
    const vk = vendorSlugKey(vendorSlug);
    if (!all.stores[sk]) all.stores[sk] = {};
    if (!all.stores[sk][vk]) all.stores[sk][vk] = {};
    if (!all.stores[sk][vk][dateKey]) {
        all.stores[sk][vk][dateKey] = { locations: {} };
    }
    const day = all.stores[sk][vk][dateKey];
    day.mmxSentAt = new Date().toISOString();
    day.updatedAt = day.mmxSentAt;
    stateCache = all;
    await writeStateFile(all);
    return day.mmxSentAt;
}

/** Clear mmxSentAt so Send to MMX can run the full pipeline again after a failed attempt. */
async function clearMmxSentForVendorSlugs(storeNumber, vendorSlugs, dateKey = melbourneDateKey()) {
    const slugs = [...new Set((vendorSlugs || []).map((s) => String(s || '').trim()).filter(Boolean))];
    if (!slugs.length) return 0;

    const all = await getStateAll();
    const sk = storeKey(storeNumber);
    const store = all.stores[sk];
    if (!store) return 0;

    let cleared = 0;
    for (const vendorSlug of slugs) {
        const vk = vendorSlugKey(vendorSlug);
        const day = store[vk]?.[dateKey];
        if (!day?.mmxSentAt) continue;
        day.mmxSentAt = null;
        day.updatedAt = new Date().toISOString();
        cleared++;
    }
    if (cleared) {
        stateCache = all;
        await writeStateFile(all);
    }
    return cleared;
}

async function getMmxSentVendorSlugs(storeNumber, dateKey = melbourneDateKey()) {
    const all = await getStateAll();
    const sk = storeKey(storeNumber);
    const store = all.stores[sk];
    if (!store) return [];
    return Object.entries(store)
        .filter(([, days]) => days?.[dateKey]?.mmxSentAt)
        .map(([slug]) => slug)
        .sort();
}

async function getSubmittedVendorSlugs(storeNumber, dateKey = melbourneDateKey()) {
    const all = await getStateAll();
    const sk = storeKey(storeNumber);
    const store = all.stores[sk];
    if (!store) return [];
    return Object.entries(store)
        .filter(([, days]) => days?.[dateKey]?.submittedAt)
        .map(([slug]) => slug)
        .sort();
}

async function clearStockCountDay(storeNumber, options = {}) {
    const vendorSlug = options.vendorSlug != null ? vendorSlugKey(options.vendorSlug) : null;
    const dateKey = options.dateKey || melbourneDateKey();
    const all = await getStateAll();
    const sk = storeKey(storeNumber);
    const store = all.stores[sk];
    if (!store) return { storeNumber: sk, dateKey, cleared: [] };

    const cleared = [];
    const vendorKeys = vendorSlug ? [vendorSlug] : Object.keys(store);

    for (const vk of vendorKeys) {
        if (!store[vk]?.[dateKey]) continue;
        delete store[vk][dateKey];
        cleared.push(vk);
        if (!Object.keys(store[vk]).length) delete store[vk];
    }

    if (!Object.keys(store).length) delete all.stores[sk];

    stateCache = all;
    await writeStateFile(all);

    return { storeNumber: sk, dateKey, cleared };
}

async function getCompletedVendorLabelsForStore(storeNumber, dateKey = melbourneDateKey()) {
    const all = await getStateAll();
    const sk = storeKey(storeNumber);
    const store = all.stores[sk];
    if (!store) return [];

    const labels = [];
    for (const [vendorSlug, days] of Object.entries(store)) {
        const day = days?.[dateKey];
        if (!day?.mmxSentAt) continue;
        const catalog = getVendorCatalog(vendorSlug, { forStockCount: true, storeNumber });
        labels.push(catalog?.label || vendorSlug);
    }
    return labels.sort((a, b) => a.localeCompare(b));
}

function isVendorConfigured(label) {
    const slug = vendorLabelToSlug(label);
    return Boolean(slug && getVendorCatalog(slug, { forStockCount: true }));
}

module.exports = {
    STATE_FILE,
    melbourneDateKey,
    getDraft,
    saveDraftLocation,
    getSummary,
    submitStockCount,
    reopenStockCount,
    markMmxSent,
    clearMmxSentForVendorSlugs,
    ensureMmxSentRecord,
    getMmxSentVendorSlugs,
    getSubmittedVendorSlugs,
    getStockCountQueueStatus,
    clearStockCountDay,
    getCompletedVendorLabelsForStore,
    isVendorConfigured,
    vendorLabelToSlug,
};
