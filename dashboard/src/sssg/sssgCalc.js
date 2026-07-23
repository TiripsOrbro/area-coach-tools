const { trimHourlyToTradingWindow, zoneHourMinuteSecond } = require('../salesProgress');
const { getStoreConfig } = require('../../../stores/src/storeList');

/** Macromatix Forecasting LY grid timestamps are fleet (Melbourne); WA stores need +2h. */
function getLyGridOffsetMinutes(storeOrNumber) {
    const cfg =
        typeof storeOrNumber === 'object' && storeOrNumber
            ? storeOrNumber
            : getStoreConfig(storeOrNumber);
    const timeZone = String(cfg?.timeZone || '').trim();
    return timeZone === 'Australia/Perth' ? 120 : 0;
}

/**
 * Sum Last Year sales from store open up to `now`, using 15-minute slots in the
 * store's local timezone (Australia/Perth for WA stores).
 *
 * Macromatix Forecasting grid row times are in fleet (Melbourne) time. For WA
 * stores, `lyGridOffsetMinutes` (+120) shifts the LY cutoff so TY (Perth local)
 * compares to the matching row on the grid.
 *
 * Cutoff rules on the shifted timeline:
 * - First quarter of each hour (minutes 0–14): full hour of LY quarters
 * - Otherwise: every started quarter in full, including the active 15-minute slot
 */
function computeLastYearSalesSoFar(
    slots,
    openHour,
    closeHour,
    timeZone,
    now = new Date(),
    lyGridOffsetMinutes = 0
) {
    if (!Array.isArray(slots) || !slots.length) return 0;

    const { hour, minute, second } = zoneHourMinuteSecond(timeZone, now);
    const nowMinutes = hour * 60 + minute + second / 60;
    const openMinutes = Math.trunc(openHour) * 60;
    const closeMinutes = Math.trunc(closeHour) * 60;
    const lyNowMinutes = Math.min(
        nowMinutes + (Number(lyGridOffsetMinutes) || 0),
        closeMinutes
    );

    if (lyNowMinutes <= openMinutes) return 0;
    if (lyNowMinutes >= closeMinutes) {
        return computeFullDayLyTotal(slots, openHour, closeHour);
    }

    const hourStart = Math.floor(lyNowMinutes / 60) * 60;
    const hourEnd = Math.min(hourStart + 60, closeMinutes);
    const lyMinute = lyNowMinutes % 60;
    const inFirstQuarterOfHour = lyMinute < 15;

    let total = 0;
    for (const slot of slots) {
        if (slot.endMinutes <= openMinutes) continue;
        if (slot.startMinutes >= closeMinutes) continue;
        if (slot.startMinutes >= hourEnd) break;

        if (inFirstQuarterOfHour && slot.startMinutes >= hourStart) {
            total += Number(slot.value) || 0;
            continue;
        }

        if (slot.startMinutes > lyNowMinutes) break;
        total += Number(slot.value) || 0;
    }

    return total;
}

/**
 * Sum actual sales from store open up to `now` using hourly Labour Scheduler data.
 * The Labour Scheduler's current-hour cell already contains only the sales taken
 * so far in that hour, so it is added in full - interpolating it again would
 * double-discount the current hour and understate SSSG.
 */
function computeActualSalesSoFar(actual, forecast, openHour, closeHour, timeZone, now = new Date()) {
    const trimmed = trimHourlyToTradingWindow(actual, forecast, openHour, closeHour);
    const actuals = trimmed.actual;
    if (!actuals.length) return 0;

    const { hour, minute, second } = zoneHourMinuteSecond(timeZone, now);
    const nowHourFloat = hour + minute / 60 + second / 3600;
    const open = Math.trunc(openHour);
    const close = Math.trunc(closeHour);

    if (nowHourFloat < open) return 0;

    if (nowHourFloat >= close) {
        return actuals.reduce((sum, v) => sum + (Number(v) || 0), 0);
    }

    let total = 0;
    for (let i = 0; i < actuals.length; i++) {
        const slotHour = open + i;
        if (slotHour > hour) break;
        total += Number(actuals[i]) || 0;
    }

    return total;
}

/**
 * Sum full trading-day actual sales (no partial-hour interpolation).
 */
function computeFullDayActualTotal(actual, forecast, openHour, closeHour) {
    const trimmed = trimHourlyToTradingWindow(actual, forecast, openHour, closeHour);
    return trimmed.actual.reduce((sum, v) => sum + (Number(v) || 0), 0);
}

/**
 * Sum full trading-day Last Year sales from quarter-hour slots (no interpolation).
 */
function computeFullDayLyTotal(slots, openHour, closeHour) {
    if (!Array.isArray(slots) || !slots.length) return 0;
    const openMinutes = Math.trunc(openHour) * 60;
    const closeMinutes = Math.trunc(closeHour) * 60;
    let total = 0;
    for (const slot of slots) {
        if (slot.endMinutes <= openMinutes) continue;
        if (slot.startMinutes >= closeMinutes) continue;
        total += Number(slot.value) || 0;
    }
    return total;
}

/** SSSG % from dollar totals. */
function computeSssgPercentFromTotals(actualTotal, lyTotal) {
    const ly = Number(lyTotal) || 0;
    const actual = Number(actualTotal) || 0;
    if (ly <= 0) return null;
    return Math.round(((actual - ly) / ly) * 1000) / 10;
}

/**
 * SSSG % = ((actualSoFar - salesLySoFar) / salesLySoFar) * 100
 */
function computeSssgPercent(options = {}) {
    const {
        slots,
        actual,
        forecast,
        openHour,
        closeHour,
        timeZone,
        now = new Date(),
        lyGridOffsetMinutes,
        storeNumber,
    } = options;

    const offset =
        lyGridOffsetMinutes != null
            ? lyGridOffsetMinutes
            : storeNumber != null
              ? getLyGridOffsetMinutes(storeNumber)
              : 0;

    const ly = computeLastYearSalesSoFar(
        slots,
        openHour,
        closeHour,
        timeZone,
        now,
        offset
    );
    if (ly <= 0) return null;

    const actualSoFar = computeActualSalesSoFar(actual, forecast, openHour, closeHour, timeZone, now);
    const pct = ((actualSoFar - ly) / ly) * 100;
    return Math.round(pct * 10) / 10;
}

module.exports = {
    getLyGridOffsetMinutes,
    computeLastYearSalesSoFar,
    computeActualSalesSoFar,
    computeFullDayActualTotal,
    computeFullDayLyTotal,
    computeSssgPercentFromTotals,
    computeSssgPercent,
};
