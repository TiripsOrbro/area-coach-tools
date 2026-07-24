const fs = require('fs');
const path = require('path');
const { normalizeItemCode } = require('./reportReader');

const paths = require('../../src/paths');
const DISPLAY_NAMES_PATH = path.join(paths.vendors.catalogs, '.display-names');
const DISPLAY_NAMES_EXAMPLE = path.join(
    __dirname,
    '..',
    '..',
    'vendors',
    'examples',
    '.display-names.example'
);

let cache = null;

function normalizeNameKey(name) {
    return String(name || '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

function parseDisplayNamesText(text) {
    const byCode = new Map();
    const byName = new Map();

    for (const rawLine of String(text || '').split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;

        const parts = line.split('|').map((p) => p.trim());
        if (parts.length < 2) continue;

        const catalogRef = parts[0];
        const displayLabel = parts.slice(1).join('|').trim();
        if (!catalogRef || !displayLabel) continue;

        const code = normalizeItemCode(catalogRef);
        if (code && /^\d/.test(code)) {
            byCode.set(code, displayLabel);
            continue;
        }

        const nameKey = normalizeNameKey(catalogRef);
        if (nameKey) byName.set(nameKey, displayLabel);
    }

    return { byCode, byName };
}

function loadDisplayNames() {
    if (cache) return cache;
    const file = fs.existsSync(DISPLAY_NAMES_PATH) ? DISPLAY_NAMES_PATH : DISPLAY_NAMES_EXAMPLE;
    if (!fs.existsSync(file)) {
        cache = { byCode: new Map(), byName: new Map(), loaded: false, source: null };
        return cache;
    }
    cache = {
        ...parseDisplayNamesText(fs.readFileSync(file, 'utf8')),
        loaded: true,
        source: path.basename(file),
    };
    return cache;
}

/**
 * Short label for stock-count UI. Catalog name + itemCode stay unchanged for MMX/saves.
 */
function stockCountDisplayName(itemCode, catalogName) {
    const { byCode, byName } = loadDisplayNames();
    const code = normalizeItemCode(itemCode);
    if (code && byCode.has(code)) return byCode.get(code);

    const nameKey = normalizeNameKey(catalogName);
    if (nameKey && byName.has(nameKey)) return byName.get(nameKey);

    return null;
}

function clearDisplayNamesCache() {
    cache = null;
}

/**
 * Set or remove a stock-count display label. Prefers item-code lines for stability.
 */
function upsertDisplayNameEntry({ itemCode, catalogName, displayLabel }) {
    const code = normalizeItemCode(itemCode);
    const label = String(displayLabel || '')
        .replace(/\|/g, '/')
        .replace(/\s+/g, ' ')
        .trim();
    const nameKey = normalizeNameKey(catalogName);

    const file = fs.existsSync(DISPLAY_NAMES_PATH) ? DISPLAY_NAMES_PATH : DISPLAY_NAMES_EXAMPLE;
    if (!fs.existsSync(file)) {
        const header = '# Plain English labels for stock count (edit any line — file is in git)\n# Format: item code | label shown on the count screen\n# Backend still uses the real catalog name + code for Macromatix.\n\n';
        fs.mkdirSync(path.dirname(DISPLAY_NAMES_PATH), { recursive: true });
        fs.writeFileSync(DISPLAY_NAMES_PATH, header, 'utf8');
    }
    const targetFile = fs.existsSync(DISPLAY_NAMES_PATH) ? DISPLAY_NAMES_PATH : file;
    if (!fs.existsSync(targetFile)) {
        throw new Error('Display names file not found.');
    }

    const lines = fs.readFileSync(targetFile, 'utf8').split(/\r?\n/);
    const kept = lines.filter((rawLine) => {
        const trimmed = rawLine.trim();
        if (!trimmed || trimmed.startsWith('#')) return true;
        const parts = trimmed.split('|').map((p) => p.trim());
        if (parts.length < 2) return true;
        const ref = parts[0];
        const refCode = normalizeItemCode(ref);
        if (code && refCode === code) return false;
        if (nameKey && normalizeNameKey(ref) === nameKey) return false;
        return true;
    });

    if (label && code) {
        kept.push(`${code} | ${label}`);
    }

    fs.writeFileSync(targetFile, `${kept.join('\n').replace(/\n*$/, '\n')}`);
    clearDisplayNamesCache();
    return { itemCode: code, displayLabel: label || null };
}

module.exports = {
    loadDisplayNames,
    stockCountDisplayName,
    clearDisplayNamesCache,
    upsertDisplayNameEntry,
    DISPLAY_NAMES_PATH,
    parseDisplayNamesText,
};
