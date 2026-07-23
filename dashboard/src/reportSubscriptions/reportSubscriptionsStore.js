const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const paths = require('../../../src/paths');
const { getStoreList } = require('../../../stores/src/storeList');

const SETTINGS_FILE = path.join(paths.dashboard.data, 'report-subscriptions.json');
const TIME_ZONE = String(process.env.DASHBOARD_TIME_ZONE || 'Australia/Melbourne').trim();
const DEFAULT_SCHEDULE_HOUR = (() => {
    const h = Number(process.env.REPORT_SUBSCRIPTIONS_DEFAULT_HOUR ?? 7);
    return Number.isFinite(h) && h >= 0 && h <= 23 ? Math.floor(h) : 7;
})();

function defaultSettings() {
    return {
        subscriptions: [],
        timeZone: TIME_ZONE,
        updatedAt: null,
    };
}

function readSettingsDoc() {
    if (!fs.existsSync(SETTINGS_FILE)) return defaultSettings();
    try {
        const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
        const base = defaultSettings();
        return {
            ...base,
            ...raw,
            subscriptions: Array.isArray(raw.subscriptions) ? raw.subscriptions : [],
        };
    } catch {
        return defaultSettings();
    }
}

function writeSettingsDoc(doc) {
    fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
}

function addDaysToIso(iso, days) {
    const [y, m, d] = String(iso || '').split('-').map(Number);
    if (!y || !m || !d) return '';
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + (Number(days) || 0));
    return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

function melbourneTodayIso() {
    return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(new Date());
}

function resolveDefaultDateRange(dateRange = {}) {
    const endOffsetDays = Number(dateRange.endOffsetDays ?? 1);
    const days = Number(dateRange.days ?? 35);
    const endDate = addDaysToIso(melbourneTodayIso(), -Math.max(0, endOffsetDays));
    const startDate = addDaysToIso(endDate, -(Math.max(1, days) - 1));
    return { startDate, endDate, days: Math.max(1, days), endOffsetDays: Math.max(0, endOffsetDays) };
}

function normalizeIncludedStoreNumbers(scopeType, scopeId, input, existing) {
    if (String(scopeType || '').trim() !== 'area') return null;
    const areaId = String(scopeId || '').trim();
    const raw =
        input.includedStoreNumbers !== undefined ? input.includedStoreNumbers : existing?.includedStoreNumbers;
    if (raw == null) return null;
    if (!Array.isArray(raw)) return null;
    const areaSet = new Set(
        getStoreList()
            .filter((row) => String(row.area || '') === areaId)
            .map((row) => String(row.storeNumber || '').trim())
            .filter(Boolean)
    );
    const filtered = [
        ...new Set(raw.map((value) => String(value || '').trim()).filter((value) => areaSet.has(value))),
    ].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    if (!filtered.length) {
        throw new Error('Select at least one store for the area subscription.');
    }
    if (filtered.length === areaSet.size) return null;
    return filtered;
}

function normalizeSubscription(input = {}, existing = null) {
    const reportType = String(input.reportType || existing?.reportType || 'historical-hourly-sales').trim();
    const scopeType = String(input.scopeType || existing?.scopeType || 'store').trim();
    const scopeId = String(input.scopeId || existing?.scopeId || '').trim();
    if (!scopeId) throw new Error('scopeId is required.');

    const recipients = Array.isArray(input.recipients)
        ? input.recipients.map((r) => String(r || '').trim()).filter(Boolean)
        : Array.isArray(existing?.recipients)
          ? existing.recipients
          : [];
    if (!recipients.length) throw new Error('At least one recipient email is required.');

    const isIseReport = reportType === 'ise-trimmed-average';
    let dateRangePayload;
    if (isIseReport) {
        const weeksRaw = input.dateRange?.weeks ?? existing?.dateRange?.weeks ?? 5;
        const weeks = Number.isFinite(Number(weeksRaw))
            ? Math.min(12, Math.max(1, Math.floor(Number(weeksRaw))))
            : 5;
        dateRangePayload = {
            mode: 'ise-weeks',
            weeks,
            endOffsetDays: 1,
        };
    } else {
        const dateRange = resolveDefaultDateRange({
            ...(existing?.dateRange || {}),
            ...(input.dateRange || {}),
        });
        if (input.dateRange?.startDate) dateRange.startDate = String(input.dateRange.startDate).trim();
        if (input.dateRange?.endDate) dateRange.endDate = String(input.dateRange.endDate).trim();
        dateRangePayload = {
            mode: String(input.dateRange?.mode || existing?.dateRange?.mode || 'rolling').trim(),
            days: dateRange.days,
            endOffsetDays: dateRange.endOffsetDays,
            startDate: dateRange.startDate,
            endDate: dateRange.endDate,
        };
    }

    const scheduleHour = Number.isFinite(Number(input.scheduleHour))
        ? Math.min(23, Math.max(0, Math.floor(Number(input.scheduleHour))))
        : Number.isFinite(Number(existing?.scheduleHour))
          ? existing.scheduleHour
          : DEFAULT_SCHEDULE_HOUR;

    const frequencyRaw = String(input.frequency ?? existing?.frequency ?? 'daily').trim().toLowerCase();
    const frequency = frequencyRaw === 'weekly' ? 'weekly' : 'daily';

    const scheduleDayOfWeek = (() => {
        const raw = input.scheduleDayOfWeek ?? existing?.scheduleDayOfWeek;
        const n = Number(raw);
        if (Number.isFinite(n)) return Math.min(6, Math.max(0, Math.floor(n)));
        return 1;
    })();

    const enabled =
        input.enabled === undefined
            ? existing?.enabled !== false
            : !(input.enabled === false || input.enabled === 0 || input.enabled === '0');

    const ownerUsername = (() => {
        if (input.ownerUsername !== undefined) return String(input.ownerUsername || '').trim();
        if (existing?.ownerUsername) return String(existing.ownerUsername).trim();
        return '';
    })();

    const includedStoreNumbers = normalizeIncludedStoreNumbers(scopeType, scopeId, input, existing);

    return {
        id: existing?.id || crypto.randomUUID(),
        ownerUsername,
        reportType,
        scopeType,
        scopeId,
        recipients,
        dateRange: dateRangePayload,
        enabled,
        frequency,
        scheduleHour,
        scheduleDayOfWeek: frequency === 'weekly' ? scheduleDayOfWeek : null,
        includedStoreNumbers,
        lastSentDate: existing?.lastSentDate || null,
        createdAt: existing?.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        updatedBy: input.updatedBy ? String(input.updatedBy).trim() : existing?.updatedBy || null,
    };
}

function findSubscriptionForOwner(ownerUsername, scopeType, scopeId, reportType, excludeId = null) {
    const owner = String(ownerUsername || '').trim();
    const type = String(scopeType || 'store').trim();
    const id = String(scopeId || '').trim();
    const report = String(reportType || '').trim();
    if (!owner || !id || !report) return null;
    return (
        listSubscriptions().find(
            (row) =>
                row.id !== excludeId &&
                String(row.ownerUsername || '').trim() === owner &&
                String(row.scopeType || 'store').trim() === type &&
                String(row.scopeId || '').trim() === id &&
                String(row.reportType || '').trim() === report
        ) || null
    );
}

function listSubscriptions() {
    return readSettingsDoc().subscriptions;
}

function getSubscription(id) {
    const key = String(id || '').trim();
    return listSubscriptions().find((row) => row.id === key) || null;
}

function createSubscription(input) {
    const ownerUsername = String(input?.ownerUsername || '').trim();
    if (!ownerUsername) throw new Error('ownerUsername is required.');
    const scopeType = String(input?.scopeType || 'store').trim();
    const scopeId = String(input?.scopeId || '').trim();
    const reportType = String(input?.reportType || 'historical-hourly-sales').trim();
    if (
        findSubscriptionForOwner(ownerUsername, scopeType, scopeId, reportType)
    ) {
        throw new Error('You already have a subscription for this store, area, and report type.');
    }
    const doc = readSettingsDoc();
    const sub = normalizeSubscription({ ...input, ownerUsername });
    doc.subscriptions.push(sub);
    doc.updatedAt = sub.updatedAt;
    writeSettingsDoc(doc);
    return sub;
}

function updateSubscription(id, input) {
    const key = String(id || '').trim();
    const doc = readSettingsDoc();
    const idx = doc.subscriptions.findIndex((row) => row.id === key);
    if (idx < 0) throw new Error('Subscription not found.');
    const sub = normalizeSubscription(input, doc.subscriptions[idx]);
    doc.subscriptions[idx] = sub;
    doc.updatedAt = sub.updatedAt;
    writeSettingsDoc(doc);
    return sub;
}

function deleteSubscription(id) {
    const key = String(id || '').trim();
    const doc = readSettingsDoc();
    const before = doc.subscriptions.length;
    doc.subscriptions = doc.subscriptions.filter((row) => row.id !== key);
    if (doc.subscriptions.length === before) throw new Error('Subscription not found.');
    doc.updatedAt = new Date().toISOString();
    writeSettingsDoc(doc);
    return true;
}

function markSubscriptionSent(id, dateKey) {
    const key = String(id || '').trim();
    const doc = readSettingsDoc();
    const row = doc.subscriptions.find((s) => s.id === key);
    if (!row) return null;
    row.lastSentDate = String(dateKey || melbourneTodayIso()).trim();
    row.updatedAt = new Date().toISOString();
    writeSettingsDoc(doc);
    return row;
}

function setSubscriptionEnabled(id, enabled, updatedBy = null) {
    const key = String(id || '').trim();
    const doc = readSettingsDoc();
    const row = doc.subscriptions.find((s) => s.id === key);
    if (!row) throw new Error('Subscription not found.');
    row.enabled = !(enabled === false || enabled === 0 || enabled === '0');
    row.updatedAt = new Date().toISOString();
    if (updatedBy) row.updatedBy = String(updatedBy).trim();
    writeSettingsDoc(doc);
    return row;
}

function listEnabledSubscriptionsDue(now = new Date(), { force = false } = {}) {
    const today = melbourneTodayIso();
    const instant = now instanceof Date ? now : new Date(now);
    return listSubscriptions().filter((sub) => {
        if (!sub.enabled) return false;
        if (!force && sub.lastSentDate === today) return false;
        const frequency = String(sub.frequency || 'daily').trim().toLowerCase();
        if (frequency === 'weekly') {
            const dayOfWeek = localDayOfWeekInTimeZone(instant, TIME_ZONE);
            const scheduledDay = Number.isFinite(Number(sub.scheduleDayOfWeek))
                ? Number(sub.scheduleDayOfWeek)
                : 1;
            if (dayOfWeek !== scheduledDay) return false;
        }
        if (force) return true;
        const hour = localHourInTimeZone(instant, TIME_ZONE);
        return hour >= Number(sub.scheduleHour ?? DEFAULT_SCHEDULE_HOUR);
    });
}

function localPartsInTimeZone(now, timeZone, options = {}) {
    return new Intl.DateTimeFormat('en-AU', {
        timeZone,
        ...options,
    }).formatToParts(now instanceof Date ? now : new Date(now));
}

function localHourInTimeZone(now, timeZone) {
    const parts = localPartsInTimeZone(now, timeZone, { hour: 'numeric', hour12: false });
    return Number(parts.find((p) => p.type === 'hour')?.value || 0);
}

function localDayOfWeekInTimeZone(now, timeZone) {
    const parts = localPartsInTimeZone(now, timeZone, { weekday: 'short' });
    const weekday = parts.find((p) => p.type === 'weekday')?.value || '';
    const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    return map[weekday] ?? 0;
}

function isReportSubscriptionsEnabled() {
    return /^(1|true|yes|on)$/i.test(String(process.env.REPORT_SUBSCRIPTIONS_ENABLED ?? '1').trim());
}

module.exports = {
    SETTINGS_FILE,
    DEFAULT_SCHEDULE_HOUR,
    TIME_ZONE,
    readSettingsDoc,
    listSubscriptions,
    getSubscription,
    findSubscriptionForOwner,
    createSubscription,
    updateSubscription,
    deleteSubscription,
    setSubscriptionEnabled,
    markSubscriptionSent,
    listEnabledSubscriptionsDue,
    resolveDefaultDateRange,
    melbourneTodayIso,
    addDaysToIso,
    localDayOfWeekInTimeZone,
    isReportSubscriptionsEnabled,
};
