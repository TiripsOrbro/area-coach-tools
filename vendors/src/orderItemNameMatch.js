/** Match MMX order-form item names to ISE / catalog names (codes often differ). */

const { normalizeItemCode } = require('./reportReader');
const { allLookupKeys, canonicalItemCode, findInReportMap } = require('./itemCodes');
const { stockCountDisplayName } = require('./stockCountDisplayNames');

const MIN_NAME_MATCH_SCORE = 25;

function normalizeItemName(name) {
    return String(name || '')
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function extractProductSizeKey(name) {
    const n = normalizeItemName(name);
    const m = n.match(/(\d+(?:\.\d+)?)\s*(kg|g|l|ml|lb|oz|ltr|litres?|liters?)\b/);
    return m ? `${m[1]}${m[2]}` : '';
}

function singularizeToken(token) {
    const t = String(token || '');
    if (t.endsWith('ies') && t.length > 4) return `${t.slice(0, -3)}y`;
    if (t.endsWith('es') && t.length > 4) return t.slice(0, -2);
    if (t.endsWith('s') && t.length > 3 && !t.endsWith('ss')) return t.slice(0, -1);
    return t;
}

function tokensMatch(a, b) {
    if (a === b) return true;
    if (a.includes(b) || b.includes(a)) return true;
    const sa = singularizeToken(a);
    const sb = singularizeToken(b);
    if (sa === sb) return true;
    if (sa.length >= 4 && sb.length >= 4 && (sa.startsWith(sb) || sb.startsWith(sa))) return true;
    return false;
}

function nameMatchScore(leftName, rightName) {
    const left = normalizeItemName(leftName);
    const right = normalizeItemName(rightName);
    if (!left || !right) return 0;
    if (left === right) return 100;

    const leftSize = extractProductSizeKey(leftName);
    const rightSize = extractProductSizeKey(rightName);
    if (leftSize && rightSize && leftSize !== rightSize) return 0;

    if (left.includes(right) || right.includes(left)) {
        return leftSize && rightSize ? 95 : 80;
    }

    const leftTokens = left.split(/\s+/).filter((token) => token.length > 1);
    const rightTokens = right.split(/\s+/).filter((token) => token.length > 1);
    let score = 0;
    for (const lt of leftTokens) {
        for (const rt of rightTokens) {
            if (tokensMatch(lt, rt)) score += lt === rt ? 20 : 10;
        }
    }
    if (leftSize && rightSize && leftSize === rightSize) score += 40;

    // Accept common spelling variant (Corriander / Coriander).
    if (score === 0 && leftTokens.length && rightTokens.length) {
        for (const lt of leftTokens) {
            for (const rt of rightTokens) {
                if (lt.length >= 5 && rt.length >= 5 && levenshtein(lt, rt) <= 1) score += 25;
            }
        }
    }

    if (score > 0 && score < 30 && leftTokens.length <= 2) {
        score = Math.max(score, 30);
    }

    return score;
}

function levenshtein(a, b) {
    const m = a.length;
    const n = b.length;
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
        }
    }
    return dp[m][n];
}

function bestNameMatchScore(gridName, ...candidates) {
    let best = 0;
    for (const candidate of candidates) {
        if (!candidate) continue;
        best = Math.max(best, nameMatchScore(gridName, candidate));
    }
    return best;
}

function catalogLineCodeMatch(catalogCode, lineCode) {
    const cat = normalizeItemCode(catalogCode);
    const line = normalizeItemCode(lineCode);
    if (!cat || !line) return false;
    if (cat === line) return true;
    const keys = new Set(allLookupKeys(cat));
    return allLookupKeys(line).some((k) => keys.has(normalizeItemCode(k)));
}

/** True when a build-to line belongs to a catalog item (code, ISE code, or name). */
function lineCoversCatalogItem(line, catalogItem) {
    if (!line || !catalogItem) return false;
    const code = normalizeItemCode(catalogItem.itemCode);
    if (!code) return false;
    if (catalogLineCodeMatch(code, line.itemCode)) return true;
    if (line.iseItemCode && catalogLineCodeMatch(code, line.iseItemCode)) return true;
    return buildToLineMatchScore(catalogItem.name, line) >= MIN_NAME_MATCH_SCORE;
}

/** ISE usage row for a catalog item - code/alias first, then name match. */
function findIseRowForCatalogItem(catalogItem, usage, usedIseCodes = new Set()) {
    if (!catalogItem || !usage) return null;
    const code = normalizeItemCode(catalogItem.itemCode);
    if (code) {
        for (const key of allLookupKeys(code)) {
            const hit = usage.get(normalizeItemCode(key));
            if (hit) {
                return {
                    reportItemCode: normalizeItemCode(key),
                    ise: hit,
                    matchSource: 'code',
                    matchScore: 100,
                };
            }
        }
        const target = code;
        for (const [reportItemCode, ise] of usage.entries()) {
            const canon = canonicalItemCode(reportItemCode) || normalizeItemCode(reportItemCode);
            if (canon === target) {
                return { reportItemCode, ise, matchSource: 'code', matchScore: 100 };
            }
        }
    }

    let best = null;
    let bestScore = 0;
    for (const [reportItemCode, ise] of usage.entries()) {
        if (usedIseCodes.has(reportItemCode)) continue;
        const score = buildToLineMatchScore(catalogItem.name, ise);
        if (score > bestScore) {
            bestScore = score;
            best = { reportItemCode, ise, matchSource: 'name', matchScore: score };
        }
    }
    if (best && bestScore >= MIN_NAME_MATCH_SCORE) return best;
    return null;
}

/**
 * Catalog item for an ISE report row - canonical code first, then name match.
 * Used when .item-codes has no alias for the ISE item code.
 */
function resolveCatalogItemForIseRow(iseEntry, reportItemCode, catalogItems) {
    const canon = canonicalItemCode(reportItemCode) || normalizeItemCode(reportItemCode);
    if (canon) {
        const byCode = (catalogItems || []).find(
            (item) => normalizeItemCode(item.itemCode) === canon
        );
        if (byCode) {
            return { item: byCode, matchSource: 'code', matchScore: 100 };
        }
        for (const item of catalogItems || []) {
            if (catalogLineCodeMatch(item.itemCode, canon)) {
                return { item, matchSource: 'code', matchScore: 100 };
            }
        }
    }

    let best = null;
    let bestScore = 0;
    for (const item of catalogItems || []) {
        if (item.buildToManual && !item.buildToOrderManual) continue;
        const score = buildToLineMatchScore(item.name, iseEntry);
        if (score > bestScore) {
            bestScore = score;
            best = item;
        }
    }
    if (best && bestScore >= MIN_NAME_MATCH_SCORE) {
        return { item: best, matchSource: 'name', matchScore: bestScore };
    }
    return null;
}

/** SOH/SOO row - code/alias first, then name match against catalog label. */
function findInReportMapWithNameFallback(itemCode, itemName, reportMap, storeNumber) {
    const codeHit = findInReportMap(reportMap, itemCode, storeNumber);
    if (codeHit) return { ...codeHit, matchSource: 'code', matchScore: 100 };
    if (!itemName || !reportMap) return null;

    let bestKey = null;
    let bestRow = null;
    let bestScore = 0;
    for (const [key, row] of reportMap.entries()) {
        const score = nameMatchScore(itemName, row.description);
        if (score > bestScore) {
            bestScore = score;
            bestKey = key;
            bestRow = row;
        }
    }
    if (bestRow && bestScore >= MIN_NAME_MATCH_SCORE) {
        return { key: bestKey, row: bestRow, matchSource: 'name', matchScore: bestScore };
    }
    return null;
}

function buildToLineMatchScore(catalogName, line) {
    let score = nameMatchScore(catalogName, line.description);
    const desc = String(line.description || '').toUpperCase();
    if (desc.includes('FINISHED PRODUCT')) score -= 20;
    if (/\bTB\b/.test(desc)) score -= 5;
    return score;
}

/**
 * ISE build-to lines that belong to a vendor catalog (matched by item name, not code).
 * Each catalog item picks at most one ISE line; each ISE line used at most once.
 */
function buildBuildToEntriesForVendor(vendorCfg, buildToLines, catalogItems, itemMatchesVendorConfig) {
    const entries = [];
    const usedIse = new Set();

    const items = [...(catalogItems || [])].sort((a, b) => {
        if (Boolean(a.skipVendorOrder) !== Boolean(b.skipVendorOrder)) {
            return a.skipVendorOrder ? 1 : -1;
        }
        return 0;
    });

    for (const item of items) {
        if (vendorCfg && itemMatchesVendorConfig && !itemMatchesVendorConfig(item, vendorCfg)) continue;
        if (item.buildToManual || item.buildToOrderManual || item.skipVendorOrder) continue;

        const catalogCode = normalizeItemCode(item.itemCode);
        let bestLine = null;
        let bestScore = 0;

        for (const line of buildToLines || []) {
            const iseKey = String(line.iseItemCode || line.itemCode || '')
                .trim()
                .toUpperCase();
            if (usedIse.has(iseKey)) continue;
            if (line.buildToManual) continue;
            if (catalogLineCodeMatch(catalogCode, line.itemCode)) {
                bestLine = line;
                bestScore = 100;
                break;
            }
            if (line.iseItemCode && catalogLineCodeMatch(catalogCode, line.iseItemCode)) {
                bestLine = line;
                bestScore = 100;
                break;
            }
        }

        if (!bestLine) {
            for (const line of buildToLines || []) {
                const iseKey = String(line.iseItemCode || line.itemCode || '')
                    .trim()
                    .toUpperCase();
                if (usedIse.has(iseKey)) continue;
                if (line.buildToManual) continue;
                const score = buildToLineMatchScore(item.name, line);
                if (score > bestScore) {
                    bestScore = score;
                    bestLine = line;
                }
            }
        }

        if (!bestLine || bestScore < MIN_NAME_MATCH_SCORE) continue;

        const iseKey = String(bestLine.iseItemCode || bestLine.itemCode || '')
            .trim()
            .toUpperCase();
        usedIse.add(iseKey);
        entries.push({
            catalogName: item.name,
            catalogItemCode: item.itemCode,
            description: bestLine.description || '',
            orderQty: bestLine.orderQty,
            iseItemCode: bestLine.iseItemCode || bestLine.itemCode,
            matchScore: bestScore,
            matchSource: bestScore >= 100 ? 'code' : 'name',
        });
    }

    return entries;
}

/**
 * Map build-to entries onto MMX order grid rows by name.
 * When several grid rows match the same entry, fill the second row (index 1).
 */
function orderGridNameCandidates(entry) {
    const names = [];
    const catalogName = String(entry.catalogName || '').trim();
    const description = String(entry.description || '').trim();
    if (catalogName) names.push(catalogName);
    if (description && description !== catalogName) names.push(description);
    const displayName = stockCountDisplayName(entry.catalogItemCode, catalogName || description);
    if (displayName && !names.includes(displayName)) names.push(displayName);
    return names;
}

function entryAllowsOrderGridNameFallback(entry) {
    if (entry.matchSource === 'code' || Number(entry.matchScore) >= 100) return true;
    if (Number(entry.orderQty) <= 0) return false;
    return Number(entry.matchScore || 0) >= MIN_NAME_MATCH_SCORE;
}

function linesFromOrderGridByName(grid, buildToEntries) {
    const usedInputIds = new Set();
    const lines = [];
    const rows = grid.rows || [];
    const byCode = new Map();

    for (const row of rows) {
        const rowCode = normalizeItemCode(row.itemCode);
        if (!rowCode) continue;
        byCode.set(rowCode, row);
    }

    for (const entry of buildToEntries || []) {
        if (entry.orderQty <= 0) continue;

        // 1) Prefer exact code/alias match (most reliable, expected in MMX grids).
        const lookupCodes = allLookupKeys(entry.catalogItemCode || entry.iseItemCode || '');
        let codeRow = null;
        for (const code of lookupCodes) {
            const row = byCode.get(normalizeItemCode(code));
            if (row && row.inputId && !usedInputIds.has(row.inputId)) {
                codeRow = row;
                break;
            }
        }
        if (codeRow) {
            usedInputIds.add(codeRow.inputId);
            lines.push({
                itemCode: codeRow.itemCode,
                itemName: codeRow.itemName || codeRow.itemCode,
                quantity: entry.orderQty,
                matchedFrom: `code:${entry.iseItemCode || entry.catalogItemCode || ''}`,
            });
            continue;
        }

        // 2) Name fallback when MMX grid code differs (e.g. Chocettes shown as "CHOC CHIPS").
        if (!entryAllowsOrderGridNameFallback(entry)) continue;

        const nameCandidates = orderGridNameCandidates(entry);
        const matches = rows
            .map((row, idx) => ({
                row,
                idx,
                score: bestNameMatchScore(row.itemName || row.itemCode, ...nameCandidates),
            }))
            .filter((m) => m.score >= MIN_NAME_MATCH_SCORE && !usedInputIds.has(m.row.inputId))
            .sort((a, b) => b.score - a.score || a.idx - b.idx);

        if (!matches.length) continue;

        const topScore = matches[0].score;
        const tied = matches.filter((m) => m.score >= topScore - 1);
        const pick = tied.length >= 2 ? tied[1] : tied[0];

        usedInputIds.add(pick.row.inputId);
        lines.push({
            itemCode: pick.row.itemCode,
            itemName: pick.row.itemName || pick.row.itemCode,
            quantity: entry.orderQty,
            matchedFrom: `name:${nameCandidates[0] || entry.catalogName || ''}`,
        });
    }

    return lines;
}

module.exports = {
    MIN_NAME_MATCH_SCORE,
    normalizeItemName,
    nameMatchScore,
    bestNameMatchScore,
    catalogLineCodeMatch,
    lineCoversCatalogItem,
    findIseRowForCatalogItem,
    resolveCatalogItemForIseRow,
    findInReportMapWithNameFallback,
    buildToLineMatchScore,
    buildBuildToEntriesForVendor,
    linesFromOrderGridByName,
    orderGridNameCandidates,
    entryAllowsOrderGridNameFallback,
};
