const fs = require('fs');
const path = require('path');
const paths = require('../../src/paths');
const { normalizeAreaLabel: normalizeCanonicalAreaLabel, getAreaIds } = require('./areasConfig');

const MARKETS_PATH = path.join(paths.stores.config, 'markets.json');
const MARKETS_EXAMPLE_PATH = path.join(paths.stores.config, 'markets.json.example');

let marketsCache = null;
let marketsCacheMtime = 0;

function normalizeMarketLabel(value) {
    const raw = String(value || '').trim();
    const m = raw.match(/^market\s*(\d+)$/i);
    if (m) return `Market ${Number(m[1])}`;
    return raw;
}

function normalizeAreaLabel(value) {
    return normalizeCanonicalAreaLabel(value);
}

function loadMarketsConfig() {
    const filePath = fs.existsSync(MARKETS_PATH) ? MARKETS_PATH : MARKETS_EXAMPLE_PATH;
    if (!fs.existsSync(filePath)) {
        return { 'Market 1': getAreaIds() };
    }
    try {
        const stat = fs.statSync(filePath);
        if (marketsCache && marketsCacheMtime === stat.mtimeMs) {
            return marketsCache;
        }
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        marketsCache = parsed && typeof parsed === 'object' ? parsed : {};
        marketsCacheMtime = stat.mtimeMs;
        return marketsCache;
    } catch {
        return { 'Market 1': getAreaIds() };
    }
}

function getAreasForMarket(marketLabel) {
    const label = normalizeMarketLabel(marketLabel);
    const config = loadMarketsConfig();
    const areas = config[label];
    return Array.isArray(areas) ? areas.map(normalizeAreaLabel).filter(Boolean) : [];
}

function getAllMarketLabels() {
    return Object.keys(loadMarketsConfig()).map(normalizeMarketLabel).filter(Boolean);
}

function getMarketForArea(areaLabel) {
    const area = normalizeAreaLabel(areaLabel);
    if (!area) return '';
    for (const market of getAllMarketLabels()) {
        if (getAreasForMarket(market).some((row) => normalizeAreaLabel(row) === area)) {
            return normalizeMarketLabel(market);
        }
    }
    return '';
}

function invalidateMarketsCache() {
    marketsCache = null;
    marketsCacheMtime = 0;
}

module.exports = {
    normalizeMarketLabel,
    normalizeAreaLabel,
    loadMarketsConfig,
    getAreasForMarket,
    getAllMarketLabels,
    getMarketForArea,
    invalidateMarketsCache,
};
