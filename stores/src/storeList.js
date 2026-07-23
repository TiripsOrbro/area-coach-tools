const fs = require('fs');
const path = require('path');
const paths = require('../../src/paths');

const STORELIST_PATH = paths.stores.storelist;
const STORELIST_EXAMPLE_PATH = path.join(paths.stores.root, '.storelist.example');
const TIME_ZONE = process.env.DASHBOARD_TIME_ZONE || 'Australia/Melbourne';

/** Defaults applied when a store omits hours or none are configured at all. */
const DEFAULT_OPEN_HOUR = 10;
const DEFAULT_CLOSE_HOUR = 22;

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const DAY_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_ALIASES = {
    sun: 0,
    mon: 1,
    tue: 2,
    tues: 2,
    wed: 3,
    weds: 3,
    thu: 4,
    thur: 4,
    thurs: 4,
    fri: 5,
    sat: 6,
};

const {
    normalizeAreaLabel: normalizeCanonicalArea,
    inferAreaFromStore,
} = require('./areasConfig');
const DEFAULT_AREA = 'VIC-1';
const TEST_AREA = 'Test Store';
const PERTH_STORE_NAMES = ['midland', 'ellenbrook', 'canning vale', 'butler'];
const PERTH_STORE_NUMBERS = new Set(['3901', '3902', '3903', '3904']);
/** 375x / 376x - Queensland stores on Macromatix store picker. */
const QLD_STORE_NUMBER_RE = /^37[56]\d{2}$/;

/** Map a weekday word (Monday / Mon / Tues / ...) to a 0=Sunday..6=Saturday index, or -1. */
function dayNameToIndex(name) {
    const n = String(name || '').trim().toLowerCase();
    if (!n) return -1;
    const full = DAY_NAMES.indexOf(n);
    if (full >= 0) return full;
    return n in DAY_ALIASES ? DAY_ALIASES[n] : -1;
}

/**
 * Normalize an (open, close) pair. A close of `0` means midnight (24); closes past
 * midnight (e.g. 25 = 1AM) are allowed. Invalid/degenerate pairs fall back to defaults.
 */
function normalizeHours(open, close) {
    let openHour = Number(open);
    let closeHour = Number(close);
    if (closeHour === 0) closeHour = 24; // midnight written as 0
    if (!Number.isFinite(openHour) || openHour < 0 || openHour > 24) openHour = DEFAULT_OPEN_HOUR;
    if (!Number.isFinite(closeHour) || closeHour <= openHour || closeHour > 30) {
        openHour = DEFAULT_OPEN_HOUR;
        closeHour = DEFAULT_CLOSE_HOUR;
    }
    return { openHour: Math.trunc(openHour), closeHour: Math.trunc(closeHour) };
}

function normalizeArea(value, storeNumber, storeName, timeZone) {
    return inferAreaFromStore(storeNumber, storeName, value, timeZone);
}

function inferStoreTimeZone(storeNumber, storeName, explicit) {
    const fromFile = String(explicit || '').trim();
    if (fromFile) return fromFile;
    const name = String(storeName || '').trim().toLowerCase();
    const num = String(storeNumber || '').trim();
    if (PERTH_STORE_NUMBERS.has(num)) return 'Australia/Perth';
    if (PERTH_STORE_NAMES.some((n) => name.includes(n))) return 'Australia/Perth';
    if (QLD_STORE_NUMBER_RE.test(num)) return 'Australia/Brisbane';
    return TIME_ZONE;
}

function isNumericToken(value) {
    return /^-?\d+(?:\.\d+)?$/.test(String(value || '').trim());
}

/**
 * Parse the store list text into raw store objects:
 *   {
 *     storeNumber, storeName, area, timeZone,
 *     uniform?: {openHour, closeHour},
 *     hoursByDay?: {0..6: {openHour, closeHour}}
 *   }
 *
 * Two line shapes are supported:
 *   `3811 | Chirnside Park | 10 | 22 | Area 22 | Australia/Melbourne`  → uniform + metadata
 *   `3901 | Midland | Area 22 | Australia/Perth`                         → metadata + per-day lines
 *   `3901 | Midland`                                                      → defaults + per-day lines
 *       `Friday | 10 | 24`                 → override just that weekday (indented or not)
 */
function parseStoreList(text) {
    const stores = [];
    const byNumber = new Map();
    let current = null;

    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;

        const parts = line.split('|').map((p) => p.trim());
        const dayIdx = dayNameToIndex(parts[0]);

        if (dayIdx >= 0 && current) {
            const { openHour, closeHour } = normalizeHours(parts[1], parts[2]);
            if (!current.hoursByDay) current.hoursByDay = {};
            current.hoursByDay[dayIdx] = { openHour, closeHour };
            continue;
        }

        const storeNumber = (parts[0] || '').replace(/[^0-9]/g, '');
        if (!storeNumber) continue;

        if (byNumber.has(storeNumber)) {
            // Duplicate header - keep editing the first one (so stray repeats don't double up).
            current = byNumber.get(storeNumber);
            continue;
        }

        const storeName = parts[1] || storeNumber;
        const p2 = parts[2];
        const p3 = parts[3];
        const hasUniformHours = isNumericToken(p2) && isNumericToken(p3);
        const area = hasUniformHours ? parts[4] : parts[2];
        const zone = hasUniformHours ? parts[5] : parts[3];

        current = {
            storeNumber,
            storeName,
            area: normalizeArea(area, storeNumber, storeName, zone),
            timeZone: inferStoreTimeZone(storeNumber, storeName, zone),
        };
        if (hasUniformHours) {
            current.uniform = normalizeHours(p2, p3);
        }
        byNumber.set(storeNumber, current);
        stores.push(current);
    }

    return stores;
}

/** Weekday index (0=Sun..6=Sat) for `date` in the dashboard time zone. */
function timeZoneWeekdayIndex(date, timeZone = TIME_ZONE) {
    const wd = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(date);
    return dayNameToIndex(wd);
}

/** Resolve a parsed store's hours for a given date: per-day override → uniform → defaults. */
function resolveHours(store, date) {
    if (store.hoursByDay) {
        const today = store.hoursByDay[timeZoneWeekdayIndex(date, store.timeZone || TIME_ZONE)];
        if (today) return { openHour: today.openHour, closeHour: today.closeHour };
    }
    if (store.uniform) return { openHour: store.uniform.openHour, closeHour: store.uniform.closeHour };
    return { openHour: DEFAULT_OPEN_HOUR, closeHour: DEFAULT_CLOSE_HOUR };
}

/** Resolve the active store list file: prefer `.storelist`, fall back to `.storelist.example`. */
function resolveStoreListPath() {
    if (fs.existsSync(STORELIST_PATH)) return STORELIST_PATH;
    if (fs.existsSync(STORELIST_EXAMPLE_PATH)) return STORELIST_EXAMPLE_PATH;
    return null;
}

/**
 * Read and parse the store list. This is the single source of truth for which stores
 * are scraped/served and their per-store trading hours. Read fresh each call (tiny file)
 * so edits to `.storelist` apply without a restart. `openHour`/`closeHour` are resolved
 * for the current day in the dashboard time zone; `hoursByDay` is included when a store
 * has a per-day schedule. De-duplicates by store number.
 */
function getStoreList() {
    const filePath = resolveStoreListPath();
    if (!filePath) return [];

    let text;
    try {
        text = fs.readFileSync(filePath, 'utf8');
    } catch {
        return [];
    }

    const now = new Date();
    return parseStoreList(text).map((store) => {
        const { openHour, closeHour } = resolveHours(store, now);
        const out = {
            storeNumber: store.storeNumber,
            storeName: store.storeName,
            area: normalizeArea(store.area, store.storeNumber, store.storeName, store.timeZone),
            timeZone: store.timeZone || inferStoreTimeZone(store.storeNumber, store.storeName),
            openHour,
            closeHour,
        };
        if (store.hoursByDay) out.hoursByDay = store.hoursByDay;
        return out;
    });
}

/** Look up a single store's config (today's resolved hours) by number, or null if not listed. */
function getStoreConfig(storeNumber) {
    const want = String(storeNumber || '').replace(/[^0-9]/g, '');
    if (!want) return null;
    return getStoreList().find((s) => s.storeNumber === want) || null;
}

function readStoreListText() {
    const filePath = resolveStoreListPath();
    if (!filePath) return { filePath: null, text: '' };
    try {
        return { filePath, text: fs.readFileSync(filePath, 'utf8') };
    } catch {
        return { filePath, text: '' };
    }
}

function isDayLine(trimmed) {
    if (!trimmed || trimmed.startsWith('#')) return false;
    const parts = trimmed.split('|').map((p) => p.trim());
    return dayNameToIndex(parts[0]) >= 0;
}

function isStoreHeaderLine(trimmed) {
    if (!trimmed || trimmed.startsWith('#')) return false;
    const parts = trimmed.split('|').map((p) => p.trim());
    if (dayNameToIndex(parts[0]) >= 0) return false;
    const num = (parts[0] || '').replace(/[^0-9]/g, '');
    return Boolean(num);
}

function serializeStoreBlock(store, scheduleType, uniform, hoursByDay) {
    const lines = [];
    const area = store.area || inferAreaFromStore(store.storeNumber, store.storeName, store.area, store.timeZone);
    const timeZone =
        store.timeZone || inferStoreTimeZone(store.storeNumber, store.storeName, store.timeZone);
    if (scheduleType === 'uniform') {
        const { openHour, closeHour } = normalizeHours(uniform.openHour, uniform.closeHour);
        lines.push(
            `${store.storeNumber} | ${store.storeName} | ${openHour} | ${closeHour} | ${area} | ${timeZone}`
        );
        return lines;
    }

    lines.push(`${store.storeNumber} | ${store.storeName} | ${area} | ${timeZone}`);
    for (let i = 0; i < 7; i++) {
        const dayHours = hoursByDay[i];
        if (!dayHours) continue;
        const { openHour, closeHour } = normalizeHours(dayHours.openHour, dayHours.closeHour);
        lines.push(`    ${DAY_LABELS[i].padEnd(9)} | ${openHour} | ${closeHour}`);
    }
    return lines;
}

function replaceStoreBlockInText(text, storeNumber, newBlockLines) {
    const lines = text.split(/\r?\n/);
    const result = [];
    let i = 0;
    let replaced = false;

    while (i < lines.length) {
        const trimmed = lines[i].trim();
        if (isStoreHeaderLine(trimmed)) {
            const num = (trimmed.split('|')[0] || '').trim().replace(/[^0-9]/g, '');
            if (num === storeNumber && !replaced) {
                i++;
                while (i < lines.length) {
                    const nextTrim = lines[i].trim();
                    if (!nextTrim || nextTrim.startsWith('#')) break;
                    if (isDayLine(nextTrim)) {
                        i++;
                        continue;
                    }
                    if (isStoreHeaderLine(nextTrim)) break;
                    i++;
                }
                result.push(...newBlockLines);
                replaced = true;
                continue;
            }
        }
        result.push(lines[i]);
        i++;
    }

    if (!replaced) {
        throw new Error(`Store ${storeNumber} not found in .storelist.`);
    }
    return result.join('\n');
}

/** Full hours config for one store (uniform or per-day), for admin editing. */
function getStoreHoursConfig(storeNumber) {
    const want = String(storeNumber || '').replace(/[^0-9]/g, '');
    if (!want) return null;

    const { text } = readStoreListText();
    if (!text) return null;

    const store = parseStoreList(text).find((s) => s.storeNumber === want);
    if (!store) return null;

    const scheduleType = store.hoursByDay ? 'per-day' : 'uniform';
    const uniform = store.uniform
        ? { openHour: store.uniform.openHour, closeHour: store.uniform.closeHour }
        : { openHour: DEFAULT_OPEN_HOUR, closeHour: DEFAULT_CLOSE_HOUR };
    let hoursByDay = null;
    if (store.hoursByDay) {
        hoursByDay = {};
        for (const [dayIdx, hours] of Object.entries(store.hoursByDay)) {
            hoursByDay[String(dayIdx)] = {
                openHour: hours.openHour,
                closeHour: hours.closeHour,
            };
        }
    }

    const { openHour, closeHour } = resolveHours(store, new Date());
    return {
        storeNumber: store.storeNumber,
        storeName: store.storeName,
        area: store.area,
        timeZone: store.timeZone || inferStoreTimeZone(store.storeNumber, store.storeName),
        scheduleType,
        uniform,
        hoursByDay,
        openHour,
        closeHour,
        defaultOpenHour: DEFAULT_OPEN_HOUR,
        defaultCloseHour: DEFAULT_CLOSE_HOUR,
    };
}

function normalizeHoursByDayInput(raw = {}) {
    const hoursByDay = {};
    for (let i = 0; i < 7; i++) {
        const dayHours = raw[String(i)] ?? raw[i];
        if (!dayHours) {
            throw new Error(`Missing hours for ${DAY_LABELS[i]}.`);
        }
        hoursByDay[i] = normalizeHours(dayHours.openHour, dayHours.closeHour);
    }
    return hoursByDay;
}

/** Persist updated trading hours for one store back to `.storelist`. */
function updateStoreHours(storeNumber, payload = {}) {
    if (!fs.existsSync(STORELIST_PATH)) {
        throw new Error('.storelist file not found. Create it before editing store hours.');
    }

    const want = String(storeNumber || '').replace(/[^0-9]/g, '');
    if (!want) throw new Error('Store number is required.');

    const text = fs.readFileSync(STORELIST_PATH, 'utf8');
    const store = parseStoreList(text).find((s) => s.storeNumber === want);
    if (!store) throw new Error(`Store ${want} not found in .storelist.`);

    const scheduleType = payload.scheduleType === 'per-day' ? 'per-day' : 'uniform';
    let uniform = null;
    let hoursByDay = null;
    if (scheduleType === 'uniform') {
        uniform = normalizeHours(payload.uniform?.openHour, payload.uniform?.closeHour);
    } else {
        hoursByDay = normalizeHoursByDayInput(payload.hoursByDay || {});
    }

    const newBlock = serializeStoreBlock(store, scheduleType, uniform, hoursByDay);
    const newText = replaceStoreBlockInText(text, want, newBlock);
    fs.writeFileSync(STORELIST_PATH, newText, 'utf8');

    const resolved = resolveHours(
        {
            uniform,
            hoursByDay,
            timeZone: store.timeZone,
        },
        new Date()
    );

    return {
        storeNumber: want,
        scheduleType,
        uniform,
        hoursByDay: hoursByDay
            ? Object.fromEntries(
                  Object.entries(hoursByDay).map(([dayIdx, hours]) => [String(dayIdx), { ...hours }])
              )
            : null,
        openHour: resolved.openHour,
        closeHour: resolved.closeHour,
    };
}

module.exports = {
    getStoreList,
    getStoreConfig,
    getStoreHoursConfig,
    updateStoreHours,
    parseStoreList,
    resolveHours,
    DEFAULT_OPEN_HOUR,
    DEFAULT_CLOSE_HOUR,
};
