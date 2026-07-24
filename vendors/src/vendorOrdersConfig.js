const fs = require('fs');
const path = require('path');

const paths = require('../../src/paths');
const CONFIG_PATH = path.join(paths.vendors.config, 'vendor-orders.json');
const EXAMPLE_PATH = path.join(paths.vendors.config, 'vendor-orders.json.example');
const { resolvePiLiveFile } = require('./piLiveDataPaths');

function loadVendorOrdersConfig() {
    const file = resolvePiLiveFile({
        livePath: CONFIG_PATH,
        examplePath: EXAMPLE_PATH,
        label: 'vendor-orders.json',
    });
    if (!file) {
        throw new Error('Missing vendors/config/vendor-orders.json on this server.');
    }
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeVendorOrdersConfig(doc) {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
}

function slugifyOrderId(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

/**
 * Ensure a scheduled-order vendor entry exists for a catalog slug.
 * Updates label when entry already exists; does not duplicate catalogSlug rows.
 */
function upsertVendorOrderForCatalog({ catalogSlug, label, vendorMatch }) {
    const slug = String(catalogSlug || '').trim().toLowerCase();
    const orderLabel = String(label || '').trim();
    if (!slug) throw new Error('Catalog slug is required for MMX order entry.');
    if (!orderLabel) throw new Error('MMX order label is required.');

    const doc = loadVendorOrdersConfig();
    doc.vendors = Array.isArray(doc.vendors) ? doc.vendors : [];
    const match = String(vendorMatch || slug).trim().toLowerCase();
    const existing = doc.vendors.find((v) => String(v.catalogSlug || '').trim().toLowerCase() === slug);

    if (existing) {
        existing.label = orderLabel;
        existing.vendorMatch = match;
        if (existing.orderFromCount == null) existing.orderFromCount = true;
    } else {
        let id = slugifyOrderId(slug);
        const used = new Set(doc.vendors.map((v) => String(v.id || '').trim()).filter(Boolean));
        if (used.has(id)) {
            id = slugifyOrderId(`${slug}-${orderLabel}`) || `${slug}-order`;
            let n = 2;
            while (used.has(id)) {
                id = `${slugifyOrderId(slug)}-${n}`;
                n += 1;
            }
        }
        doc.vendors.push({
            id,
            label: orderLabel,
            vendorMatch: match,
            catalogSlug: slug,
            orderFromCount: true,
        });
    }

    writeVendorOrdersConfig(doc);
    return doc;
}

function removeVendorOrdersForCatalogSlug(catalogSlug) {
    const slug = String(catalogSlug || '').trim().toLowerCase();
    if (!slug) throw new Error('Catalog slug is required.');

    const doc = loadVendorOrdersConfig();
    doc.vendors = Array.isArray(doc.vendors) ? doc.vendors : [];
    const next = doc.vendors.filter(
        (entry) => String(entry.catalogSlug || '').trim().toLowerCase() !== slug
    );
    if (next.length === doc.vendors.length) return doc;

    doc.vendors = next;
    writeVendorOrdersConfig(doc);
    return doc;
}

module.exports = {
    CONFIG_PATH,
    loadVendorOrdersConfig,
    writeVendorOrdersConfig,
    upsertVendorOrderForCatalog,
    removeVendorOrdersForCatalogSlug,
};
