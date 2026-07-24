const fs = require('fs');
const path = require('path');

const paths = require('../../src/paths');
const CONVERT_TO_BOX_PATH = path.join(paths.vendors.catalogs, '.ConvertToBox');
const CONVERT_TO_BOX_EXAMPLE = path.join(paths.vendors.root, 'examples', '.ConvertToBox.example');

let cache = null;

function normalizeItemCode(code) {
    return String(code || '')
        .trim()
        .toUpperCase()
        .replace(/^0+/, '');
}

function normalizeUnitKey(unit) {
    const raw = String(unit || '').trim().toUpperCase();
    if (!raw) return '';
    if (raw === 'EA') return 'EACH';
    if (raw === 'KGS') return 'KG';
    if (raw === 'LTR' || raw === 'LITRES') return 'LITRE';
    return raw;
}

function parseConvertToBoxText(text) {
    const byCode = new Map();
    for (const rawLine of String(text || '').split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const parts = line.split('|').map((p) => p.trim());
        if (parts.length < 3) continue;

        // Supports both:
        // 1) Code | Unit | QtyPerBox
        // 2) Code | Name | Unit | QtyPerBox
        const hasNameColumn = parts.length >= 4;
        const itemCode = normalizeItemCode(parts[0]);
        const unit = normalizeUnitKey(hasNameColumn ? parts[2] : parts[1]);
        const qtyPerBox = Number(hasNameColumn ? parts[3] : parts[2]);
        if (!itemCode || !unit || !Number.isFinite(qtyPerBox) || qtyPerBox <= 0) continue;

        if (!byCode.has(itemCode)) byCode.set(itemCode, new Map());
        byCode.get(itemCode).set(unit, qtyPerBox);
    }
    return byCode;
}

function loadConvertToBoxMap() {
    if (cache) return cache;
    const file = fs.existsSync(CONVERT_TO_BOX_PATH) ? CONVERT_TO_BOX_PATH : CONVERT_TO_BOX_EXAMPLE;
    if (!fs.existsSync(file)) {
        cache = new Map();
        return cache;
    }
    cache = parseConvertToBoxText(fs.readFileSync(file, 'utf8'));
    return cache;
}

function qtyPerBoxForItem(itemCode, reportUnit) {
    const code = normalizeItemCode(itemCode);
    const unit = normalizeUnitKey(reportUnit);
    if (!code || !unit) return null;
    const byUnit = loadConvertToBoxMap().get(code);
    if (!byUnit) return null;
    return byUnit.get(unit) ?? byUnit.get('ANY') ?? null;
}

function clearConvertToBoxCache() {
    cache = null;
}

module.exports = {
    loadConvertToBoxMap,
    qtyPerBoxForItem,
    clearConvertToBoxCache,
    CONVERT_TO_BOX_PATH,
};
