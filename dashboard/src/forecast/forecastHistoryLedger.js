const fs = require('fs');
const path = require('path');

const { getStoreConfig, parseStoreList, resolveHours, DEFAULT_OPEN_HOUR, DEFAULT_CLOSE_HOUR } = require('../../../stores/src/storeList');
const { trimHourlyToTradingWindow, RAW_BASE_HOUR } = require('../salesProgress');
const { getStoreDateKey } = require('../sssg/sssgWeeklyLedger');

const paths = require('../../../src/paths');
const HISTORY_DIR = path.join(paths.dashboard.data, 'forecast-history');
const HISTORY_DAYS = Number(process.env.FORECAST_HISTORY_DAYS || 35);
const ARCHIVE_DAYS = Math.max(
    HISTORY_DAYS,
    Number(process.env.FORECAST_HISTORY_ARCHIVE_DAYS || 182)
);
const MIN_WEEKDAY_SAMPLES = 3;

function historyFilePath(storeNumber) {
    const key = String(storeNumber || '').replace(/[^0-9a-z]/gi, '');
    return path.join(HISTORY_DIR, `${key || 'unknown'}.json`);
}

function emptyStoreHistory(storeNumber) {
    const cfg = getStoreConfig(storeNumber) || {};
    return {
        storeNumber: String(storeNumber || '').trim(),
        timeZone: String(cfg.timeZone || process.env.DASHBOARD_TIME_ZONE || 'Australia/Melbourne').trim(),
        defaultOpenHour: Number.isFinite(cfg.openHour) ? cfg.openHour : DEFAULT_OPEN_HOUR,
        defaultCloseHour: Number.isFinite(cfg.closeHour) ? cfg.closeHour : DEFAULT_CLOSE_HOUR,
        days: {},
    };
}

function readStoreHistory(storeNumber) {
    const filePath = historyFilePath(storeNumber);
    if (!fs.existsSync(filePath)) return emptyStoreHistory(storeNumber);
    try {
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const base = emptyStoreHistory(storeNumber);
        return {
            ...base,
            ...raw,
            storeNumber: String(raw.storeNumber || storeNumber).trim(),
            days: raw.days && typeof raw.days === 'object' ? raw.days : {},
            archive: raw.archive && typeof raw.archive === 'object' ? raw.archive : {},
        };
    } catch {
        return emptyStoreHistory(storeNumber);
    }
}

function writeStoreHistory(doc) {
    const storeNumber = String(doc?.storeNumber || '').trim();
    if (!storeNumber) throw new Error('storeNumber is required');
    fs.mkdirSync(HISTORY_DIR, { recursive: true });
    fs.writeFileSync(historyFilePath(storeNumber), `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
    return doc;
}

function addDaysToIso(iso, days) {
    const [y, m, d] = String(iso || '').split('-').map(Number);
    if (!y || !m || !d) return '';
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + (Number(days) || 0));
    return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

function weekdayForIso(iso, timeZone) {
    const wd = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(
        new Date(`${iso}T12:00:00`)
    );
    const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    return map[wd] ?? 0;
}

function sumHourly(values) {
    if (!Array.isArray(values)) return 0;
    return values.reduce((sum, v) => sum + (Number(v) || 0), 0);
}

function getHistoryDayEntry(doc, dateKey) {
    const date = String(dateKey || '').trim();
    if (!date || !doc) return null;
    return doc.days?.[date] || doc.archive?.[date] || null;
}

function compactHistoryDayForArchive(day) {
    if (!day) return null;
    return {
        date: day.date,
        weekday: day.weekday,
        openHour: day.openHour,
        closeHour: day.closeHour,
        actual: Array.isArray(day.actual) ? day.actual : [],
        actualTotal: day.actualTotal,
        finalized: day.finalized !== false,
        source: day.source,
        archivedAt: new Date().toISOString(),
    };
}

function pruneArchive(doc) {
    if (!doc?.archive || ARCHIVE_DAYS <= HISTORY_DAYS) return doc;
    const timeZone = String(doc.timeZone || process.env.DASHBOARD_TIME_ZONE || 'Australia/Melbourne').trim();
    const asOfIso = new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date());
    const oldestArchive = addDaysToIso(asOfIso, -(ARCHIVE_DAYS - 1));
    for (const key of Object.keys(doc.archive)) {
        if (key < oldestArchive) delete doc.archive[key];
    }
    if (!Object.keys(doc.archive).length) delete doc.archive;
    return doc;
}

function pruneOldDays(doc, keepDays = HISTORY_DAYS) {
    const keys = Object.keys(doc.days || {}).sort();
    while (keys.length > keepDays) {
        const oldest = keys.shift();
        if (ARCHIVE_DAYS > HISTORY_DAYS) {
            const day = doc.days[oldest];
            if (day) {
                if (!doc.archive) doc.archive = {};
                doc.archive[oldest] = compactHistoryDayForArchive(day);
            }
        }
        delete doc.days[oldest];
    }
    pruneArchive(doc);
    return doc;
}

function normalizeHourlyEntry(entry = {}, storeDefaults = {}) {
    const openHour = Number.isFinite(entry.openHour) ? entry.openHour : storeDefaults.defaultOpenHour;
    const closeHour = Number.isFinite(entry.closeHour) ? entry.closeHour : storeDefaults.defaultCloseHour;
    let actual = Array.isArray(entry.actual) ? entry.actual.map((v) => Number(v) || 0) : [];
    let actualRaw = Array.isArray(entry.actualRaw) ? entry.actualRaw.map((v) => Number(v) || 0) : null;

    if (entry.actualFormat === 'raw-mmx' || (actualRaw && actualRaw.length && !actual.length)) {
        actualRaw = actualRaw || actual;
        const trimmed = trimHourlyToTradingWindow(actualRaw, [], openHour, closeHour);
        actual = trimmed.actual;
    } else if (actual.length > closeHour - openHour + 2) {
        const trimmed = trimHourlyToTradingWindow(actual, [], openHour, closeHour);
        actual = trimmed.actual;
    }

    const actualTotal =
        Number.isFinite(entry.actualTotal) && entry.actualTotal >= 0
            ? Math.round(entry.actualTotal * 100) / 100
            : Math.round(sumHourly(actual) * 100) / 100;

    return {
        openHour,
        closeHour,
        actual,
        actualRaw: actualRaw || undefined,
        actualTotal,
    };
}

function recordForecastHistoryDay(storeNumber, dateKey, entry, options = {}) {
    const store = String(storeNumber || '').trim();
    const date = String(dateKey || '').trim();
    if (!store || !date) return null;

    const doc = readStoreHistory(store);
    const normalized = normalizeHourlyEntry(entry, doc);
    if (normalized.actualTotal <= 0 && !options.force) return null;

    const timeZone = String(entry.timeZone || doc.timeZone || '').trim() || doc.timeZone;
    doc.days[date] = {
        date,
        weekday: weekdayForIso(date, timeZone),
        openHour: normalized.openHour,
        closeHour: normalized.closeHour,
        actual: normalized.actual,
        ...(normalized.actualRaw ? { actualRaw: normalized.actualRaw } : {}),
        actualTotal: normalized.actualTotal,
        finalized: options.finalized !== false,
        capturedAt: new Date().toISOString(),
        source: String(options.source || 'live').trim(),
    };
    if (doc.archive?.[date]) delete doc.archive[date];
    pruneOldDays(doc);
    writeStoreHistory(doc);
    return doc.days[date];
}

function recordForecastHistoryFromStore(store, dateKey, options = {}) {
    if (!store?.storeNumber || !Array.isArray(store.actual)) return null;
    if (sumHourly(store.actual) <= 0 && !options.force) return null;

    const cfg = getStoreConfig(store.storeNumber) || {};
    const openHour = Number.isFinite(store.openHour) ? store.openHour : cfg.openHour ?? DEFAULT_OPEN_HOUR;
    const closeHour = Number.isFinite(store.closeHour) ? store.closeHour : cfg.closeHour ?? DEFAULT_CLOSE_HOUR;
    const trimmed = trimHourlyToTradingWindow(store.actual, store.forecast || [], openHour, closeHour);
    const day =
        dateKey ||
        getStoreDateKey(
            { storeNumber: store.storeNumber, timeZone: store.timeZone || cfg.timeZone },
            options.now || new Date()
        );

    return recordForecastHistoryDay(
        store.storeNumber,
        day,
        {
            openHour: trimmed.openHour,
            closeHour: trimmed.closeHour,
            actual: trimmed.actual,
            actualRaw: store.actual,
            actualFormat: 'raw-mmx',
            timeZone: store.timeZone || cfg.timeZone,
        },
        { ...options, source: options.source || 'live-scrape' }
    );
}

function listHistoryDays(storeNumber, maxDays = HISTORY_DAYS) {
    const doc = readStoreHistory(storeNumber);
    return Object.keys(doc.days || {})
        .sort()
        .slice(-maxDays)
        .map((date) => doc.days[date])
        .filter(Boolean);
}

function dailyRowsFromHistory(storeNumber, maxDays = HISTORY_DAYS) {
    return listHistoryDays(storeNumber, maxDays).map((day) => ({
        date: day.date,
        weekday: day.weekday,
        total: day.actualTotal,
        openHour: day.openHour,
        closeHour: day.closeHour,
        actual: day.actual,
    }));
}

function assessHistoryReadiness(storeNumber, options = {}) {
    const minSamples = Number(options.minWeekdaySamples) || MIN_WEEKDAY_SAMPLES;
    const days = listHistoryDays(storeNumber, HISTORY_DAYS);
    const byWeekday = new Map();
    for (const day of days) {
        if (!day.finalized || day.actualTotal <= 0) continue;
        const w = Number(day.weekday);
        if (!byWeekday.has(w)) byWeekday.set(w, []);
        byWeekday.get(w).push(day);
    }

    const weekdayGaps = [];
    for (let w = 0; w <= 6; w += 1) {
        const count = byWeekday.get(w)?.length || 0;
        if (count < minSamples) weekdayGaps.push(w);
    }

    const weekdayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    return {
        storeNumber: String(storeNumber),
        daysRecorded: days.filter((d) => d.finalized && d.actualTotal > 0).length,
        daysRequired: HISTORY_DAYS,
        minWeekdaySamples: minSamples,
        ready: weekdayGaps.length === 0 && days.length >= minSamples * 7,
        weekdayGaps: weekdayGaps.map((w) => weekdayLabels[w] || String(w)),
        oldestDate: days[0]?.date || null,
        newestDate: days[days.length - 1]?.date || null,
    };
}

function shouldOverwriteHistoryDay(existing, newTotal) {
    if (!existing) return true;
    if (String(existing.source || '').trim() === 'manual-ui') return false;
    const oldTotal = Number(existing.actualTotal) || 0;
    const nextTotal = Number(newTotal) || 0;
    if (!existing.finalized) return true;
    return nextTotal > oldTotal + 0.009;
}

function finalizeForecastHistoryFromSnapshot(storeNumber, dateKey, snapshot, options = {}) {
    const store = String(storeNumber || '').trim();
    const date = String(dateKey || snapshot?.dateKey || '').trim();
    if (!store || !date || !snapshot || !Array.isArray(snapshot.actual)) return null;

    const doc = readStoreHistory(store);
    const existing = doc.days?.[date];
    const cfg = getStoreConfig(store) || {};
    const openHour = Number.isFinite(snapshot.openHour)
        ? snapshot.openHour
        : Number.isFinite(existing?.openHour)
          ? existing.openHour
          : doc.defaultOpenHour;
    const closeHour = Number.isFinite(snapshot.closeHour)
        ? snapshot.closeHour
        : Number.isFinite(existing?.closeHour)
          ? existing.closeHour
          : doc.defaultCloseHour;
    const normalized = normalizeHourlyEntry(
        {
            openHour,
            closeHour,
            actual: snapshot.actual,
            actualRaw: snapshot.actualRaw,
            actualFormat: snapshot.actualFormat,
        },
        doc
    );
    if (normalized.actualTotal <= 0 && !options.force) return null;
    if (!shouldOverwriteHistoryDay(existing, normalized.actualTotal)) return existing;

    return recordForecastHistoryDay(
        store,
        date,
        {
            openHour: normalized.openHour,
            closeHour: normalized.closeHour,
            actual: normalized.actual,
            actualRaw: normalized.actualRaw,
            timeZone: cfg.timeZone || doc.timeZone,
        },
        {
            finalized: true,
            source: options.source || 'live-scrape',
            force: options.force,
        }
    );
}

function assessHistoryCaptureHealth(storeNumber, options = {}) {
    const base = assessHistoryReadiness(storeNumber, options);
    const doc = readStoreHistory(storeNumber);
    const timeZone = String(doc.timeZone || process.env.DASHBOARD_TIME_ZONE || 'Australia/Melbourne').trim();
    const now = options.now || new Date();
    const today = new Intl.DateTimeFormat('en-CA', { timeZone }).format(now);
    const yesterday = addDaysToIso(today, -1);

    const finalizedDates = Object.values(doc.days || {})
        .filter((day) => day.finalized && Number(day.actualTotal) > 0)
        .map((day) => day.date)
        .sort();

    const finalizedSet = new Set(finalizedDates);
    const missingRecentDays = [];
    for (let i = 0; i < 7; i += 1) {
        const iso = addDaysToIso(today, -i);
        if (!finalizedSet.has(iso)) missingRecentDays.push(iso);
    }

    return {
        ...base,
        newestFinalizedDate: finalizedDates[finalizedDates.length - 1] || null,
        yesterdayCaptured: finalizedSet.has(yesterday),
        missingRecentDays,
    };
}

function sweepForecastHistoryFromSnapshots(snapshotDir, storeNumbers) {
    if (!snapshotDir || !fs.existsSync(snapshotDir)) return { imported: 0, stores: [] };
    const allow = storeNumbers ? new Set(storeNumbers.map(String)) : null;
    let imported = 0;
    const storesTouched = new Set();

    for (const file of fs.readdirSync(snapshotDir)) {
        if (!file.endsWith('.json')) continue;
        const storeNumber = file.replace(/\.json$/i, '');
        if (allow && !allow.has(storeNumber)) continue;
        const filePath = path.join(snapshotDir, file);
        let snap;
        try {
            snap = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        } catch {
            continue;
        }
        if (!snap?.actual?.length) continue;
        const cfg = getStoreConfig(storeNumber) || {};
        const dateKey =
            snap.dateKey ||
            (snap.capturedAt
                ? getStoreDateKey({ storeNumber, timeZone: cfg.timeZone }, new Date(snap.capturedAt))
                : null);
        if (!dateKey) continue;
        const row = finalizeForecastHistoryFromSnapshot(storeNumber, dateKey, {
            ...snap,
            openHour: snap.openHour,
            closeHour: snap.closeHour,
        });
        if (row) {
            imported += 1;
            storesTouched.add(storeNumber);
        }
    }

    return { imported, stores: [...storesTouched] };
}

function buildHistoryCoverageForStores(storeNumbers, options = {}) {
    const stores = {};
    for (const storeNumber of storeNumbers || []) {
        stores[String(storeNumber)] = assessHistoryCaptureHealth(storeNumber, options);
    }
    return { historyDays: HISTORY_DAYS, stores };
}

/**
 * Import bulk history. Accepts:
 * - { days: { "2026-05-01": { "3811": { actual: [...] } } } }
 * - { stores: { "3811": { days: { "2026-05-01": { actual: [...] } } } } }
 */
function loadParsedStore(storeNumber) {
    try {
        const storeListPath = fs.existsSync(path.join(paths.stores.root, '.storelist'))
            ? path.join(paths.stores.root, '.storelist')
            : path.join(paths.stores.root, '.storelist.example');
        if (!fs.existsSync(storeListPath)) return null;
        return parseStoreList(fs.readFileSync(storeListPath, 'utf8')).find((s) => s.storeNumber === storeNumber) || null;
    } catch {
        return null;
    }
}

function weekStartingMondayFromDate(isoDate, timeZone) {
    const wd = weekdayForIso(isoDate, timeZone);
    const daysFromMonday = (wd + 6) % 7;
    return addDaysToIso(isoDate, -daysFromMonday);
}

const WEEKDAY_OFFSET_FROM_MONDAY = [6, 0, 1, 2, 3, 4, 5];
const WEEKDAY_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function calendarDateForWeekdayIndex(weekStartingMonday, weekdayIndex) {
    const offset = WEEKDAY_OFFSET_FROM_MONDAY[Number(weekdayIndex)];
    if (offset === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(String(weekStartingMonday || ''))) return '';
    return addDaysToIso(weekStartingMonday, offset);
}

function weekColumnLabel(weeksAgo) {
    if (weeksAgo === 0) return 'Current week';
    if (weeksAgo === 1) return 'Last week';
    return `${weeksAgo + 1} weeks ago`;
}

function formatHourLabel(hour) {
    const h = Number(hour);
    if (!Number.isFinite(h)) return '';
    const end = h + 1;
    const fmt = (v) => {
        if (v === 0 || v === 24) return '12am';
        if (v === 12) return '12pm';
        if (v < 12) return `${v}am`;
        return `${v - 12}pm`;
    };
    return `${fmt(h)}–${fmt(end)}`;
}

/**
 * Hourly sales grid for one store and weekday: columns = weeks ago (oldest first), rows = trading hours.
 */
function buildHistoryHourGrid(storeNumber, options = {}) {
    const store = String(storeNumber || '').trim();
    const maxWeeks = Math.max(1, Math.min(8, Number(options.maxWeeks) || 5));
    const weekday = Number(options.weekday);
    const weekdayIndex =
        Number.isFinite(weekday) && weekday >= 0 && weekday <= 6
            ? weekday
            : weekdayForIso(
                  new Intl.DateTimeFormat('en-CA', {
                      timeZone: options.timeZone || 'Australia/Melbourne',
                  }).format(options.asOf || new Date()),
                  options.timeZone || 'Australia/Melbourne'
              );

    const doc = readStoreHistory(store);
    const cfg = getStoreConfig(store) || {};
    const timeZone = String(options.timeZone || doc.timeZone || cfg.timeZone || 'Australia/Melbourne').trim();
    const asOfIso =
        options.asOfIso ||
        new Intl.DateTimeFormat('en-CA', { timeZone }).format(options.asOf || new Date());
    const currentWeekStart = weekStartingMondayFromDate(asOfIso, timeZone);

    const refDate = new Date(`${calendarDateForWeekdayIndex(currentWeekStart, weekdayIndex) || asOfIso}T12:00:00`);
    const parsedStore = loadParsedStore(store);
    const hoursResolved = parsedStore
        ? resolveHours(parsedStore, refDate)
        : {
              openHour: Number.isFinite(cfg.openHour) ? cfg.openHour : DEFAULT_OPEN_HOUR,
              closeHour: Number.isFinite(cfg.closeHour) ? cfg.closeHour : DEFAULT_CLOSE_HOUR,
          };
    const open = hoursResolved.openHour;
    const close = hoursResolved.closeHour;

    const columns = [];
    for (let weeksAgo = maxWeeks - 1; weeksAgo >= 0; weeksAgo -= 1) {
        const weekStart = addDaysToIso(currentWeekStart, -7 * weeksAgo);
        const date = calendarDateForWeekdayIndex(weekStart, weekdayIndex);
        const day = date ? getHistoryDayEntry(doc, date) : null;
        const hourly = [];
        if (day?.actual?.length) {
            for (let h = open; h < close; h += 1) {
                const idx = h - (Number.isFinite(day.openHour) ? day.openHour : open);
                hourly.push({
                    hour: h,
                    label: formatHourLabel(h),
                    sales: idx >= 0 && idx < day.actual.length ? Math.round((Number(day.actual[idx]) || 0) * 100) / 100 : 0,
                });
            }
        } else {
            for (let h = open; h < close; h += 1) {
                hourly.push({ hour: h, label: formatHourLabel(h), sales: null });
            }
        }
        columns.push({
            weeksAgo,
            label: weekColumnLabel(weeksAgo),
            weekStart,
            date: date || null,
            dayTotal: day?.actualTotal != null ? day.actualTotal : null,
            hasData: Boolean(day?.actual?.length),
            source: day?.source || null,
            hourly,
        });
    }

    const rowHours = [];
    for (let h = open; h < close; h += 1) {
        rowHours.push({
            hour: h,
            label: formatHourLabel(h),
            values: columns.map((col) => {
                const cell = col.hourly.find((r) => r.hour === h);
                return cell?.sales ?? null;
            }),
        });
    }

    const dayTotals = columns.map((col) => col.dayTotal);

    return {
        storeNumber: store,
        storeName: cfg.storeName || parsedStore?.storeName || store,
        timeZone,
        weekday: weekdayIndex,
        weekdayLabel: WEEKDAY_LABELS[weekdayIndex] || String(weekdayIndex),
        asOf: asOfIso,
        currentWeekStart,
        openHour: open,
        closeHour: close,
        maxWeeks,
        columns: columns.map(({ weeksAgo, label, weekStart, date, dayTotal, hasData, source }) => ({
            weeksAgo,
            label,
            weekStart,
            date,
            dayTotal,
            hasData,
            source,
        })),
        rows: rowHours,
        dayTotals,
    };
}

/**
 * Seven-day history grid: rows = calendar days, columns = trading hours.
 * weekStart may be any date; loads 7 consecutive days from that date.
 */
function buildHistoryWeekGrid(storeNumber, options = {}) {
    const store = String(storeNumber || '').trim();
    const doc = readStoreHistory(store);
    const cfg = getStoreConfig(store) || {};
    const parsedStore = loadParsedStore(store);
    const timeZone = String(options.timeZone || doc.timeZone || cfg.timeZone || 'Australia/Melbourne').trim();
    const asOfIso =
        options.asOfIso ||
        new Intl.DateTimeFormat('en-CA', { timeZone }).format(options.asOf || new Date());

    let weekStart = String(options.weekStart || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
        weekStart = weekStartingMondayFromDate(asOfIso, timeZone);
    }
    const weekEnd = addDaysToIso(weekStart, 6);

    const defaultOpen = Number.isFinite(cfg.openHour) ? cfg.openHour : DEFAULT_OPEN_HOUR;
    const defaultClose = Number.isFinite(cfg.closeHour) ? cfg.closeHour : DEFAULT_CLOSE_HOUR;

    const dayRows = [];
    let minOpen = Infinity;
    let maxClose = -Infinity;

    for (let offset = 0; offset < 7; offset += 1) {
        const date = addDaysToIso(weekStart, offset);
        const day = getHistoryDayEntry(doc, date) || null;
        const refDate = new Date(`${date}T12:00:00`);
        const hoursResolved = parsedStore
            ? resolveHours(parsedStore, refDate)
            : {
                  openHour: Number.isFinite(day?.openHour) ? day.openHour : defaultOpen,
                  closeHour: Number.isFinite(day?.closeHour) ? day.closeHour : defaultClose,
              };
        const open = hoursResolved.openHour;
        const close = hoursResolved.closeHour;
        if (open < minOpen) minOpen = open;
        if (close > maxClose) maxClose = close;

        const weekday = weekdayForIso(date, timeZone);
        const hourlyMap = new Map();
        if (day?.actual?.length) {
            const dayOpen = Number.isFinite(day.openHour) ? day.openHour : open;
            for (let h = open; h < close; h += 1) {
                const idx = h - dayOpen;
                hourlyMap.set(
                    h,
                    idx >= 0 && idx < day.actual.length
                        ? Math.round((Number(day.actual[idx]) || 0) * 100) / 100
                        : 0
                );
            }
        }

        dayRows.push({
            date,
            weekday,
            weekdayLabel: WEEKDAY_LABELS[weekday] || String(weekday),
            openHour: open,
            closeHour: close,
            dayTotal: day?.actualTotal != null ? day.actualTotal : null,
            hasData: Boolean(day?.actual?.length),
            source: day?.source || null,
            hourlyMap,
        });
    }

    if (!Number.isFinite(minOpen)) {
        minOpen = defaultOpen;
        maxClose = defaultClose;
    }

    const hourColumns = [];
    for (let h = minOpen; h < maxClose; h += 1) {
        hourColumns.push({ hour: h, label: formatHourLabel(h) });
    }

    const rows = dayRows.map((day) => ({
        date: day.date,
        weekday: day.weekday,
        weekdayLabel: day.weekdayLabel,
        openHour: day.openHour,
        closeHour: day.closeHour,
        dayTotal: day.dayTotal,
        hasData: day.hasData,
        source: day.source,
        values: hourColumns.map((col) => {
            if (col.hour < day.openHour || col.hour >= day.closeHour) return null;
            if (day.hourlyMap.has(col.hour)) return day.hourlyMap.get(col.hour);
            return day.hasData ? 0 : null;
        }),
    }));

    return {
        storeNumber: store,
        storeName: cfg.storeName || parsedStore?.storeName || store,
        timeZone,
        asOf: asOfIso,
        weekStart,
        weekEnd,
        openHour: minOpen,
        closeHour: maxClose,
        hourColumns,
        rows,
        dayTotals: rows.map((r) => r.dayTotal),
        gridType: 'week',
    };
}

function importForecastHistory(payload, options = {}) {
    const force = Boolean(options.force);
    let imported = 0;
    const storesTouched = new Set();

    const importDay = (storeNumber, dateKey, entry) => {
        const existing = readStoreHistory(storeNumber).days?.[dateKey];
        if (existing?.finalized && !force) return;
        const row = recordForecastHistoryDay(storeNumber, dateKey, entry, {
            force,
            finalized: true,
            source: options.source || 'import',
        });
        if (row) {
            imported += 1;
            storesTouched.add(String(storeNumber));
        }
    };

    if (payload?.days && typeof payload.days === 'object') {
        for (const [dateKey, storesMap] of Object.entries(payload.days)) {
            if (!storesMap || typeof storesMap !== 'object') continue;
            for (const [storeNumber, entry] of Object.entries(storesMap)) {
                importDay(storeNumber, dateKey, entry);
            }
        }
    }

    if (payload?.stores && typeof payload.stores === 'object') {
        for (const [storeNumber, storeBlock] of Object.entries(payload.stores)) {
            const days = storeBlock?.days;
            if (!days || typeof days !== 'object') continue;
            const defaults = {
                openHour: storeBlock.openHour,
                closeHour: storeBlock.closeHour,
                timeZone: storeBlock.timeZone,
            };
            for (const [dateKey, entry] of Object.entries(days)) {
                importDay(storeNumber, dateKey, { ...defaults, ...entry });
            }
        }
    }

    return {
        imported,
        stores: [...storesTouched].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
    };
}

function trimWeekdayDayRows(rows) {
    if (!rows?.length || rows.length < 3) return [];
    const sorted = [...rows].sort((a, b) => (Number(a.total) || 0) - (Number(b.total) || 0));
    return sorted.length >= 5 ? sorted.slice(1, -1) : sorted;
}

function hourlySharesForWeekday(storeNumber, weekday, excludeDate) {
    const rows = dailyRowsFromHistory(storeNumber).filter(
        (row) => row.weekday === weekday && row.date !== excludeDate && Array.isArray(row.actual) && row.actual.length
    );
    const trimmed = trimWeekdayDayRows(rows);
    if (!trimmed.length) return null;

    const hourCount = Math.max(...trimmed.map((r) => r.actual.length));
    const shareSums = new Array(hourCount).fill(0);
    let used = 0;
    for (const day of trimmed) {
        const total = Number(day.total) || sumHourly(day.actual);
        if (total <= 0) continue;
        used += 1;
        for (let i = 0; i < day.actual.length; i += 1) {
            shareSums[i] += (Number(day.actual[i]) || 0) / total;
        }
    }
    if (!used) return null;

    let shares = shareSums.map((s) => s / used);
    const shareTotal = shares.reduce((sum, v) => sum + v, 0) || 1;
    shares = shares.map((s) => s / shareTotal);
    const ref = trimmed[0];
    return {
        openHour: ref.openHour,
        closeHour: ref.closeHour,
        shares,
    };
}

function distributeDayTotalToHourly(total, weekday, storeNumber, options = {}) {
    const doc = readStoreHistory(storeNumber);
    const openHour = Number.isFinite(options.openHour) ? options.openHour : doc.defaultOpenHour;
    const closeHour = Number.isFinite(options.closeHour) ? options.closeHour : doc.defaultCloseHour;
    const hourCount = closeHour - openHour;
    if (hourCount <= 0) throw new Error('Invalid trading hours.');

    const mix = hourlySharesForWeekday(storeNumber, weekday, options.excludeDate);
    const shares = mix?.shares?.length === hourCount ? mix.shares : new Array(hourCount).fill(1 / hourCount);
    const resolvedOpen = mix?.openHour ?? openHour;
    const resolvedClose = mix?.closeHour ?? closeHour;

    const actual = shares.map((share) => Math.round(total * share * 100) / 100);
    const shaped = Math.round(sumHourly(actual) * 100) / 100;
    const remainder = Math.round((total - shaped) * 100) / 100;
    if (actual.length && Math.abs(remainder) >= 0.01) {
        actual[actual.length - 1] = Math.round((actual[actual.length - 1] + remainder) * 100) / 100;
    }

    return {
        openHour: resolvedOpen,
        closeHour: resolvedClose,
        actual,
        actualTotal: Math.round(total * 100) / 100,
    };
}

function historyDateBounds(timeZone) {
    const asOfIso = new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date());
    const retentionDays = ARCHIVE_DAYS > HISTORY_DAYS ? ARCHIVE_DAYS : HISTORY_DAYS;
    const oldest = addDaysToIso(asOfIso, -(retentionDays - 1));
    return {
        asOfIso,
        oldest,
        newest: asOfIso,
        hotDays: HISTORY_DAYS,
        archiveDays: ARCHIVE_DAYS,
    };
}

function validateHistoryDate(dateKey, storeNumber) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateKey || ''))) {
        throw new Error('date must be YYYY-MM-DD.');
    }
    const doc = readStoreHistory(storeNumber);
    const { oldest, newest, hotDays, archiveDays } = historyDateBounds(doc.timeZone);
    if (dateKey < oldest || dateKey > newest) {
        const windowLabel =
            archiveDays > hotDays
                ? `the last ${archiveDays} days (${oldest} to ${newest})`
                : `the last ${hotDays} days (${oldest} to ${newest})`;
        throw new Error(`date must be within ${windowLabel}.`);
    }
    return doc;
}

function upsertManualHistoryDay(storeNumber, dateKey, payload = {}, options = {}) {
    const store = String(storeNumber || '').trim();
    const date = String(dateKey || '').trim();
    const doc = validateHistoryDate(date, store);
    const timeZone = doc.timeZone;
    const weekday = weekdayForIso(date, timeZone);

    let entry = { ...payload };
    const hasHourly = Array.isArray(payload.actual) && payload.actual.length;
    const hasTotal = Number.isFinite(Number(payload.actualTotal)) && payload.actualTotal >= 0;

    if (!hasHourly && hasTotal) {
        const distributed = distributeDayTotalToHourly(Number(payload.actualTotal), weekday, store, {
            openHour: payload.openHour,
            closeHour: payload.closeHour,
            excludeDate: date,
        });
        entry = { ...distributed, ...payload, actual: distributed.actual };
    } else if (!hasHourly && !hasTotal) {
        throw new Error('actualTotal or actual hourly array is required.');
    }

    const force = Boolean(options.force || payload.force);
    const row = recordForecastHistoryDay(store, date, { ...entry, timeZone }, {
        force,
        finalized: true,
        source: options.source || 'manual-ui',
    });
    if (!row) throw new Error('Could not save history day (total must be greater than zero).');
    return row;
}

function buildHistoryDayEntry(storeNumber, dateKey) {
    const store = String(storeNumber || '').trim();
    const doc = readStoreHistory(store);
    const cfg = getStoreConfig(store) || {};
    const timeZone = String(doc.timeZone || cfg.timeZone || 'Australia/Melbourne').trim();
    const bounds = historyDateBounds(timeZone);
    const date = String(dateKey || bounds.newest || '').trim();
    if (!date) throw new Error('date is required.');

    validateHistoryDate(date, store);

    const parsedStore = loadParsedStore(store);
    const refDate = new Date(`${date}T12:00:00`);
    const hoursResolved = parsedStore
        ? resolveHours(parsedStore, refDate)
        : {
              openHour: Number.isFinite(cfg.openHour) ? cfg.openHour : doc.defaultOpenHour,
              closeHour: Number.isFinite(cfg.closeHour) ? cfg.closeHour : doc.defaultCloseHour,
          };
    const openHour = hoursResolved.openHour;
    const closeHour = hoursResolved.closeHour;
    const existing = getHistoryDayEntry(doc, date);
    const dayOpen = Number.isFinite(existing?.openHour) ? existing.openHour : openHour;

    const hours = [];
    for (let h = openHour; h < closeHour; h += 1) {
        const idx = h - dayOpen;
        hours.push({
            hour: h,
            label: formatHourLabel(h),
            value:
                existing?.actual && idx >= 0 && idx < existing.actual.length
                    ? Math.round((Number(existing.actual[idx]) || 0) * 100) / 100
                    : null,
        });
    }

    return {
        storeNumber: store,
        storeName: cfg.storeName || parsedStore?.storeName || store,
        date,
        timeZone,
        dateBounds: bounds,
        openHour,
        closeHour,
        hours,
        actualTotal: existing?.actualTotal ?? null,
        source: existing?.source ?? null,
        hasExisting: Boolean(existing),
    };
}

function deleteHistoryDay(storeNumber, dateKey, options = {}) {
    const store = String(storeNumber || '').trim();
    const date = String(dateKey || '').trim();
    if (!store || !date) throw new Error('store and date are required.');

    const doc = readStoreHistory(store);
    const existing = doc.days?.[date];
    if (!existing) throw new Error('History day not found.');

    const source = String(existing.source || '').trim();
    if (source === 'live-scrape' && !options.force) {
        throw new Error('Live-scraped days cannot be deleted without confirmation.');
    }

    delete doc.days[date];
    writeStoreHistory(doc);
    return { storeNumber: store, date, removed: true };
}

module.exports = {
    HISTORY_DIR,
    HISTORY_DAYS,
    ARCHIVE_DAYS,
    RAW_BASE_HOUR,
    historyFilePath,
    readStoreHistory,
    writeStoreHistory,
    getHistoryDayEntry,
    recordForecastHistoryDay,
    recordForecastHistoryFromStore,
    listHistoryDays,
    dailyRowsFromHistory,
    assessHistoryReadiness,
    buildHistoryCoverageForStores,
    buildHistoryHourGrid,
    buildHistoryWeekGrid,
    weekStartingMondayFromDate,
    importForecastHistory,
    normalizeHourlyEntry,
    weekdayForIso,
    addDaysToIso,
    sumHourly,
    WEEKDAY_LABELS,
    weekColumnLabel,
    formatHourLabel,
    distributeDayTotalToHourly,
    upsertManualHistoryDay,
    deleteHistoryDay,
    buildHistoryDayEntry,
    historyDateBounds,
    validateHistoryDate,
    finalizeForecastHistoryFromSnapshot,
    assessHistoryCaptureHealth,
    sweepForecastHistoryFromSnapshots,
    shouldOverwriteHistoryDay,
};
