/** Known Macromatix day-part subtotal row indices (combined totals - exclude from sums). */
const EXCLUDED_ROW_INDICES = new Set([37, 63]);

const SUBTOTAL_LABEL_RE = /\b(total|breakfast|lunch|dinner|daypart|subtotal|combined)\b/i;

/**
 * Parse 12-hour clock label (e.g. "10:15 AM") to minutes since midnight.
 */
function parseTime12hLabel(label) {
    const text = String(label || '').replace(/\s+/g, ' ').trim();
    if (!text || SUBTOTAL_LABEL_RE.test(text)) return null;

    const match = text.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
    if (!match) return null;

    let hour = parseInt(match[1], 10);
    const minute = parseInt(match[2], 10);
    const isPm = /pm/i.test(match[3]);
    if (isPm && hour !== 12) hour += 12;
    if (!isPm && hour === 12) hour = 0;
    return hour * 60 + minute;
}

/**
 * Parse a range label (e.g. "10:00 - 10:15") into start/end minutes.
 */
function parseQuarterHourRangeLabel(label) {
    const text = String(label || '').replace(/\s+/g, ' ').trim();
    if (!text) return null;

    const rangeMatch = text.match(/(\d{1,2})(?::(\d{2}))?\s*-\s*(\d{1,2}):(\d{2})/i);
    if (!rangeMatch) return null;

    const startHour = parseInt(rangeMatch[1], 10);
    const startMin = rangeMatch[2] != null ? parseInt(rangeMatch[2], 10) : 0;
    const endHour = parseInt(rangeMatch[3], 10);
    const endMin = parseInt(rangeMatch[4], 10);
    const startMinutes = startHour * 60 + startMin;
    const endMinutes = endHour * 60 + endMin;
    if (endMinutes <= startMinutes) return null;
    return { startMinutes, endMinutes };
}

/**
 * Classify one row using Macromatix grid conventions:
 * - Row 37/63 (and empty labels): day-part subtotals
 * - Duplicate "H:00 AM/PM" pair: first = hourly total (skip), second = 10:00–10:15 quarter
 * - ":15", ":30", ":45" labels: 15-minute quarters
 */
function classifyGridRow(row, nextRow, prevRow) {
    const rowIndex = Number(row?.rowIndex);
    if (Number.isFinite(rowIndex) && EXCLUDED_ROW_INDICES.has(rowIndex)) {
        return { include: false, reason: 'excluded-index' };
    }

    const labelText = String(row?.labelText || '').trim();
    if (!labelText) {
        return { include: false, reason: 'empty-label' };
    }

    const range = parseQuarterHourRangeLabel(labelText);
    if (range) {
        return { include: true, ...range };
    }

    const startMinutes = parseTime12hLabel(labelText);
    if (startMinutes == null) {
        return { include: false, reason: 'unparseable' };
    }

    const minute = startMinutes % 60;
    const nextLabel = String(nextRow?.labelText || '').trim();
    const prevLabel = String(prevRow?.labelText || '').trim();
    const sameLabelNext = nextLabel && nextLabel === labelText;
    const sameLabelPrev = prevLabel && prevLabel === labelText;

    // First of duplicate :00 pair is the hourly aggregate.
    if (minute === 0 && sameLabelNext) {
        return { include: false, reason: 'hourly-aggregate' };
    }

    // Second :00 in pair is the first 15-minute slot of the hour.
    if (minute === 0 && sameLabelPrev) {
        return { include: true, startMinutes, endMinutes: startMinutes + 15 };
    }

    // Lone :00 without a duplicate partner is an hourly-only row.
    if (minute === 0) {
        return { include: false, reason: 'hourly-only' };
    }

    // :15 / :30 / :45 quarter rows.
    return {
        include: true,
        startMinutes,
        endMinutes: startMinutes + 15,
    };
}

/**
 * Convert raw DOM scrape rows into sorted 15-minute Last Year slots.
 * @param {Array<{ rowIndex: number, labelText: string, value: number }>} rawRows
 * @returns {Array<{ startMinutes: number, endMinutes: number, value: number, rowIndex: number }>}
 */
function parseLastYearGridRows(rawRows) {
    const sorted = [...(rawRows || [])].sort((a, b) => a.rowIndex - b.rowIndex);
    const slots = [];

    for (let i = 0; i < sorted.length; i++) {
        const row = sorted[i];
        const value = Number(row?.value);
        if (!Number.isFinite(value)) continue;

        const classified = classifyGridRow(row, sorted[i + 1], sorted[i - 1]);
        if (!classified.include) continue;

        slots.push({
            startMinutes: classified.startMinutes,
            endMinutes: classified.endMinutes,
            value,
            rowIndex: row.rowIndex,
        });
    }

    slots.sort((a, b) => a.startMinutes - b.startMinutes || a.rowIndex - b.rowIndex);
    return slots;
}

module.exports = {
    EXCLUDED_ROW_INDICES,
    parseTime12hLabel,
    parseQuarterHourRangeLabel,
    classifyGridRow,
    parseLastYearGridRows,
};
