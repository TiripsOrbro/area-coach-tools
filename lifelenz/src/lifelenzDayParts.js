/** LifeLenz day-part labels in sidebar order (5AM–5AM business day). */
const LIFELENZ_DAY_PARTS = [
    { key: 'overnightFirst', label: 'OVERNIGHT', hours: [5] },
    { key: 'breakfast', label: 'BREAKFAST', hours: [6, 7, 8, 9] },
    { key: 'morning', label: 'MORNING', hours: [10, 11] },
    { key: 'lunch', label: 'LUNCH', hours: [12, 13] },
    { key: 'afternoon', label: 'AFTERNOON', hours: [14, 15, 16] },
    { key: 'dinner', label: 'DINNER', hours: [17, 18, 19] },
    { key: 'afterDinner', label: 'AFTER DINNER', hours: [20, 21] },
    { key: 'lateNight', label: 'LATE NIGHT', hours: [22, 23] },
    { key: 'overnightSecond', label: 'OVERNIGHT', hours: [0, 1, 2, 3, 4] },
];

function normalizeHour(hour) {
    const h = Number(hour);
    if (!Number.isFinite(h)) return null;
    return ((h % 24) + 24) % 24;
}

function hourForecastMap(hourly) {
    const map = new Map();
    for (const slot of hourly || []) {
        const hour = normalizeHour(slot.hour);
        if (hour == null) continue;
        const value = Number(slot.forecast);
        map.set(hour, Number.isFinite(value) ? value : 0);
    }
    return map;
}

function sumHours(map, hours) {
    return hours.reduce((sum, hour) => sum + (map.get(hour) || 0), 0);
}

/**
 * Map one forecast plan day (hourly[]) to LifeLenz adjusted day-part totals (whole dollars).
 * @param {{ date?: string, hourly?: Array<{ hour: number, forecast: number }> }} planEntry
 * @returns {Array<{ key: string, label: string, adjusted: number, hours: number[] }>}
 */
function aggregateDayPartsFromHourlyPlan(planEntry) {
    const map = hourForecastMap(planEntry?.hourly);
    return LIFELENZ_DAY_PARTS.map((part) => {
        const raw = sumHours(map, part.hours);
        return {
            key: part.key,
            label: part.label,
            hours: part.hours,
            adjusted: Math.round(raw),
        };
    });
}

function aggregateDayPartsForPlan(plan) {
    return (plan || []).map((day) => ({
        date: day.date,
        weekday: day.weekday,
        forecastTotal: day.forecastTotal,
        dayParts: aggregateDayPartsFromHourlyPlan(day),
        adjustedTotal: aggregateDayPartsFromHourlyPlan(day).reduce((sum, row) => sum + row.adjusted, 0),
    }));
}

module.exports = {
    LIFELENZ_DAY_PARTS,
    aggregateDayPartsFromHourlyPlan,
    aggregateDayPartsForPlan,
};
