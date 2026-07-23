const fs = require('fs');
const path = require('path');
const paths = require('../../src/paths');
const { getVendorDefinition, listAllVendorDefinitions } = require('./vendorCatalog');
const { loadVendorOrdersConfig } = require('./vendorOrdersConfig');

const CACHE_PATH =
    process.env.EXISTING_VENDORS_PATH || path.join(paths.vendors.config, 'existing-vendors.json');

function normalizeLabel(raw) {
    return String(raw || '')
        .replace(/\s+/g, ' ')
        .trim();
}

function readCacheDoc() {
    try {
        if (!fs.existsSync(CACHE_PATH)) return { labels: [] };
        const raw = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
        const labels = Array.isArray(raw.labels) ? raw.labels.map(normalizeLabel).filter(Boolean) : [];
        return { labels: [...new Set(labels)].sort((a, b) => a.localeCompare(b)) };
    } catch {
        return { labels: [] };
    }
}

function writeCacheDoc(doc) {
    fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
    const labels = [...new Set((doc.labels || []).map(normalizeLabel).filter(Boolean))].sort((a, b) =>
        a.localeCompare(b)
    );
    fs.writeFileSync(
        CACHE_PATH,
        `${JSON.stringify({ labels, updatedAt: new Date().toISOString() }, null, 2)}\n`,
        'utf8'
    );
    return { labels };
}

/**
 * Merge MMX scheduled-order vendor labels seen while scraping stores.
 * @param {string[]} labels Raw vendor column text from Macromatix
 * @param {string} [storeNumber]
 */
function recordExistingVendorLabels(labels, storeNumber) {
    const incoming = (Array.isArray(labels) ? labels : []).map(normalizeLabel).filter(Boolean);
    if (!incoming.length) return readCacheDoc();

    const doc = readCacheDoc();
    const merged = new Set(doc.labels);
    for (const label of incoming) merged.add(label);
    return writeCacheDoc({ labels: [...merged] });
}

function listCachedExistingVendorLabels() {
    return readCacheDoc().labels;
}

function resolveExistingVendorCopyTarget(mmxLabel) {
    const label = normalizeLabel(mmxLabel);
    if (!label) return null;

    const orders = loadVendorOrdersConfig().vendors || [];
    const orderMatch = orders.find((v) => normalizeLabel(v.label) === label);
    if (orderMatch?.catalogSlug) {
        const def = getVendorDefinition(String(orderMatch.catalogSlug).trim().toLowerCase());
        if (def) {
            return {
                label,
                catalogSlug: def.slug,
                mmxLabel: normalizeLabel(orderMatch.label) || label,
            };
        }
    }

    for (const def of listAllVendorDefinitions()) {
        if (normalizeLabel(def.label).toLowerCase() === label.toLowerCase()) {
            return { label, catalogSlug: def.slug, mmxLabel: label };
        }
    }

    const slugGuess = String(orderMatch?.catalogSlug || '').trim().toLowerCase();
    if (slugGuess && getVendorDefinition(slugGuess)) {
        return { label, catalogSlug: slugGuess, mmxLabel: label };
    }

    return { label, catalogSlug: null, mmxLabel: label };
}

/**
 * Labels for the admin copy-vendor picker: scraped MMX names plus configured order labels.
 */
function listExistingVendorsForCopy() {
    const out = new Map();

    for (const label of listCachedExistingVendorLabels()) {
        const resolved = resolveExistingVendorCopyTarget(label);
        if (resolved) out.set(resolved.label, resolved);
    }

    for (const entry of loadVendorOrdersConfig().vendors || []) {
        const label = normalizeLabel(entry.label);
        if (!label || out.has(label)) continue;
        const resolved = resolveExistingVendorCopyTarget(label);
        if (resolved) out.set(resolved.label, resolved);
    }

    return [...out.values()].sort((a, b) => a.label.localeCompare(b.label));
}

module.exports = {
    CACHE_PATH,
    recordExistingVendorLabels,
    listCachedExistingVendorLabels,
    listExistingVendorsForCopy,
    resolveExistingVendorCopyTarget,
};
