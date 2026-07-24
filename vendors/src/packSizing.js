function parseWeightToken(raw, suffix) {
    let n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return null;
    const suf = String(suffix || '').toUpperCase();
    if (suf === 'G' || suf === 'GM') n /= 1000;
    return n;
}

/**
 * Infer Each/KGs per inner pack and packs per outer box from item description and unit column.
 * @param {string} name Item description
 * @param {string} unitLabel Unit column label (Each, KGs, …)
 * @param {number|null|undefined} filePacksPerBox Catalog trailing number (innerPerCarton)
 */
function inferPackSizing(name, unitLabel, filePacksPerBox) {
    const text = String(name || '').trim();
    const unit = String(unitLabel || '').trim().toLowerCase();
    const isKg = unit.includes('kg');
    const isEach = unit.includes('each') || unit === 'ea';
    const filePacks =
        filePacksPerBox != null && Number.isFinite(Number(filePacksPerBox)) && Number(filePacksPerBox) > 0
            ? Number(filePacksPerBox)
            : null;

    const cross = text.match(/(\d+(?:\.\d+)?)\s*[xX×]\s*(\d+(?:\.\d+)?)\s*(KG|KGS|G|GM|EA|EACH)?/i);
    if (cross) {
        const packs = Number(cross[1]);
        const perPack = parseWeightToken(cross[2], cross[3]);
        if (Number.isFinite(packs) && packs > 0 && perPack != null) {
            return {
                packsPerBox: filePacks != null ? filePacks : packs,
                unitsPerPack: perPack,
            };
        }
    }

    const eaCount = text.match(/(\d+(?:\.\d+)?)\s*(EA|EACH)\b/i);
    if (eaCount && isEach) {
        const perPack = Number(eaCount[1]);
        if (Number.isFinite(perPack) && perPack > 0) {
            return {
                packsPerBox: filePacks != null ? filePacks : 1,
                unitsPerPack: perPack,
            };
        }
    }

    const wt = text.match(/(\d+(?:\.\d+)?)\s*(KG|KGS|G|GM)\b/i);
    if (wt && isKg) {
        const perPack = parseWeightToken(wt[1], wt[2]);
        if (perPack != null) {
            return {
                packsPerBox: filePacks,
                unitsPerPack: perPack,
            };
        }
    }

    return {
        packsPerBox: filePacks != null ? filePacks : isEach ? 1 : null,
        unitsPerPack: isEach ? 1 : isKg ? 1 : 1,
    };
}

function effectiveUnitLabel(units) {
    const list = Array.isArray(units) ? units : [];
    for (let i = list.length - 1; i >= 0; i--) {
        const label = String(list[i] || '').trim();
        if (label && !/^n\s*\/\s*a$/i.test(label)) return label;
    }
    return '';
}

module.exports = {
    inferPackSizing,
    effectiveUnitLabel,
};
