/**
 * Key items shown on the ISE Average report (prep / cooked product focus).
 * Matched on description, case-insensitive.
 */
const ISE_AVERAGE_ITEM_DESCRIPTIONS = [
    'MEAT BEEF COOKED',
    'MEAT CHICKEN COOKED',
    'BEANS BLACK COOKED',
    'SAUCE NACHO CHEESE',
    'TB MEXICAN RICE (FINISHED PRODUCT)',
    'TORTILLA FLOUR 12INCH',
    'TORTILLA FLOUR 10.25INCH',
    'TORTILLA FLOUR 6.5INCH',
    'FLATBREAD',
    'TORTILLA CORN 6 INCH',
    'CHIP NACHO CORN',
    'TB TACO SHELLS (FINISHED PRODUCT)',
    'TB TOSTADA (FINISHED PRODUCT)',
    'CINNAMON TWISTS',
    'TB FIESTA SALSA (FINISHED PRODUCT)',
    'TB GUACAMOLE (FINISHED PRODUCT)',
    'CREAM SOUR LIGHT',
    'SAUCE ZESTY RANCH 1',
    'SAUCE CHIPOTLE MAYO 1',
    'LAVA SAUCE',
    'SAUCE CREAMY JALAPENO',
    'SAUCE CHILLI MILD',
    'SAUCE FIRE 10X1KG',
];

function normalizeIseDescription(value) {
    return String(value || '')
        .trim()
        .toUpperCase()
        .replace(/\s+/g, ' ');
}

const ISE_AVERAGE_ALLOWLIST = new Set(ISE_AVERAGE_ITEM_DESCRIPTIONS.map(normalizeIseDescription));

function isIseAverageItem(itemOrDescription) {
    const description =
        typeof itemOrDescription === 'string'
            ? itemOrDescription
            : itemOrDescription?.description || '';
    return ISE_AVERAGE_ALLOWLIST.has(normalizeIseDescription(description));
}

/** Stable report order: allowlist sequence, then any extras alphabetically. */
function sortIseAverageItems(items) {
    const order = new Map(ISE_AVERAGE_ITEM_DESCRIPTIONS.map((d, i) => [normalizeIseDescription(d), i]));
    return [...(items || [])].sort((a, b) => {
        const da = normalizeIseDescription(a?.description);
        const db = normalizeIseDescription(b?.description);
        const ia = order.has(da) ? order.get(da) : 1000;
        const ib = order.has(db) ? order.get(db) : 1000;
        if (ia !== ib) return ia - ib;
        return da.localeCompare(db) || String(a?.itemCode || '').localeCompare(String(b?.itemCode || ''));
    });
}

module.exports = {
    ISE_AVERAGE_ITEM_DESCRIPTIONS,
    normalizeIseDescription,
    isIseAverageItem,
    sortIseAverageItems,
};
