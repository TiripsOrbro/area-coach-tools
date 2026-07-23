/** Short area labels for UI (VIC-1 → VIC). Canonical ids stay on data attributes / APIs. */
(function (global) {
    function areaDisplayLabel(value) {
        if (value && typeof value === 'object') {
            const fromRow = value.displayName || value.label;
            if (fromRow) return String(fromRow).trim();
            value = value.name || value.id || '';
        }
        const raw = String(value ?? '').trim();
        if (!raw) return '';
        return raw.replace(/-1$/i, '') || raw;
    }

    global.AreaDisplay = { label: areaDisplayLabel };
})(window);
