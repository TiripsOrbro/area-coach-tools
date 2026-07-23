const { getStoreList, getStoreConfig, resolveHours, DEFAULT_OPEN_HOUR, DEFAULT_CLOSE_HOUR } = require('../../stores/src/storeList');

const TIME_ZONE = process.env.DASHBOARD_TIME_ZONE || 'Australia/Melbourne';
const PRE_OPEN_HOURS = Number(process.env.SCRAPE_PRE_OPEN_HOURS || 2);
/** Hours after close to keep serving last sales totals (default 2). */
const POST_CLOSE_RETAIN_HOURS = Number(process.env.SCRAPE_POST_CLOSE_RETAIN_HOURS || 2);

function wallClockInZone(now = new Date(), timeZone = TIME_ZONE) {
    const parts = new Intl.DateTimeFormat('en-AU', {
        timeZone,
        hour: 'numeric',
        minute: 'numeric',
        hour12: false,
    }).formatToParts(now);
    const get = (type) => Number(parts.find((p) => p.type === type)?.value || 0);
    const hour = get('hour');
    const minute = get('minute');
    return { hour, minute, minuteOfDay: hour * 60 + minute };
}

function melbourneWallClock(now = new Date()) {
    return wallClockInZone(now, TIME_ZONE);
}

function storeWallClock(store, now = new Date()) {
    const zone = String(store?.timeZone || '').trim() || TIME_ZONE;
    return wallClockInZone(now, zone);
}

function resolveStoreHoursForSchedule(store, now = new Date()) {
    if (store?.hoursByDay) {
        return resolveHours(store, now);
    }
    if (Number.isFinite(store?.openHour) && Number.isFinite(store?.closeHour)) {
        return { openHour: store.openHour, closeHour: store.closeHour };
    }
    const cfg = getStoreConfig(store?.storeNumber);
    if (cfg) {
        return {
            openHour: cfg.openHour,
            closeHour: cfg.closeHour,
        };
    }
    return { openHour: DEFAULT_OPEN_HOUR, closeHour: DEFAULT_CLOSE_HOUR };
}

/**
 * Scrape lifecycle for a store (Melbourne wall clock, from `.storelist` hours):
 * - active: PRE_OPEN_HOURS before open → closeHour (scrape Macromatix)
 * - retain: closeHour → closeHour + POST_CLOSE_RETAIN_HOURS (serve last data, no scrape; default 2h)
 * - idle: otherwise (empty dashboard data until next active window)
 */
function getStoreScrapePhase(store, now = new Date()) {
    const { openHour, closeHour } = resolveStoreHoursForSchedule(store, now);
    const { minuteOfDay: t } = storeWallClock(store, now);
    const preOpen = Number.isFinite(PRE_OPEN_HOURS) && PRE_OPEN_HOURS >= 0 ? PRE_OPEN_HOURS : 2;
    const postRetain =
        Number.isFinite(POST_CLOSE_RETAIN_HOURS) && POST_CLOSE_RETAIN_HOURS >= 0 ? POST_CLOSE_RETAIN_HOURS : 2;

    const startMin = (openHour - preOpen) * 60;
    const closeMin = closeHour * 60;
    const retainEndMin = closeMin + postRetain * 60;
    const dayMinutes = 24 * 60;

    // Close after midnight (e.g. closeHour 25 = 1:00 AM next calendar day).
    if (closeHour > 24) {
        const closeNextMin = (closeHour - 24) * 60;
        const retainNextMin = closeNextMin + postRetain * 60;
        const dayStartMin = Math.max(0, startMin);
        if (t >= dayStartMin || t < closeNextMin) return 'active';
        if (t >= closeNextMin && t < retainNextMin) return 'retain';
        return 'idle';
    }

    // Pre-open window starts the previous evening (rare).
    if (startMin < 0) {
        const startPrevMin = dayMinutes + startMin;
        if (t >= startPrevMin || t < closeMin) return 'active';
        if (t >= closeMin && t < retainEndMin) return 'retain';
        return 'idle';
    }

    if (t >= startMin && t < closeMin) return 'active';

    // Post-close retain (may cross midnight, e.g. close 23:00 + 2h → 01:00).
    if (retainEndMin <= dayMinutes) {
        if (t >= closeMin && t < retainEndMin) return 'retain';
    } else if (t >= closeMin || t < retainEndMin - dayMinutes) {
        return 'retain';
    }

    return 'idle';
}

function getStoreScrapePhaseByNumber(storeNumber, now = new Date()) {
    const cfg = getStoreConfig(storeNumber);
    if (!cfg) return 'idle';
    return getStoreScrapePhase(cfg, now);
}

function storesInActiveScrapeWindow(now = new Date()) {
    return getStoreList().filter((store) => getStoreScrapePhase(store, now) === 'active');
}

function anyStoreInActiveScrapeWindow(now = new Date()) {
    return storesInActiveScrapeWindow(now).length > 0;
}

/** True during the post-close window - serve last sales totals, do not scrape. */
function isPostCloseSalesGrace(store, now = new Date()) {
    return getStoreScrapePhase(store, now) === 'retain';
}

function formatScrapeWindow(store, now = new Date()) {
    const { openHour, closeHour } = resolveStoreHoursForSchedule(store, now);
    const preOpen = Number.isFinite(PRE_OPEN_HOURS) && PRE_OPEN_HOURS >= 0 ? PRE_OPEN_HOURS : 2;
    const postRetain =
        Number.isFinite(POST_CLOSE_RETAIN_HOURS) && POST_CLOSE_RETAIN_HOURS >= 0 ? POST_CLOSE_RETAIN_HOURS : 2;
    const startHour = openHour - preOpen;
    const retainEnd = closeHour + postRetain;
    return `${startHour}:00–${closeHour}:00 scrape, retain until ${retainEnd}:00`;
}

module.exports = {
    getStoreScrapePhase,
    getStoreScrapePhaseByNumber,
    storesInActiveScrapeWindow,
    anyStoreInActiveScrapeWindow,
    isPostCloseSalesGrace,
    formatScrapeWindow,
    melbourneWallClock,
    storeWallClock,
    PRE_OPEN_HOURS,
    POST_CLOSE_RETAIN_HOURS,
};
