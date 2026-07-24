/** Macromatix order qty: always round up (0.3 → 1, 22.2 → 23). Zero/negative → skip line. */
function ceilOrderQuantity(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.ceil(n - 1e-9);
}

module.exports = { ceilOrderQuantity };
