/**
 * In-memory activity registry for Admin UI (bottom-right tracker).
 * Tracks long-running report downloads / checks across coach tools.
 */

const liveEvents = require('./liveEvents');

let seq = 0;
const active = new Map();
const recent = [];
const RECENT_TTL_MS = 3 * 60_000;
const RECENT_MAX = 12;
const LOG_MAX = 80;

const REPORT_HINTS = [
    { re: /\b(inventory[-\s]?special[-\s]?event|\bise\b|report3)\b/i, label: 'ISE' },
    { re: /\b(stock[-\s]?on[-\s]?hand|\bsoh\b)\b/i, label: 'SOH' },
    { re: /\b(stock[-\s]?on[-\s]?order|\bsoo\b)\b/i, label: 'SOO' },
    { re: /\b(sales|lifelenz|hourly)\b/i, label: 'Sales' },
    { re: /\b(forecast)\b/i, label: 'Forecast' },
    { re: /\b(build[-\s]?to|orders)\b/i, label: 'Build-to' },
    { re: /\b(prep\s*guide|pdf)\b/i, label: 'Prep' },
    { re: /\b(mmx|browser|puppeteer)\b/i, label: 'MMX' },
    { re: /\b(calc|shortfall|pipeline)\b/i, label: 'Calc' },
];

/** Ordered steps + typical duration for progress estimates (weights sum doesn't need to be 100). */
const KIND_PROFILES = {
    // Concurrent SOH/SOO/ISE — one "Reports" step filled by download completions, not by first log hit.
    'build-to-update': {
        typicalMs: 2.5 * 60 * 1000,
        steps: [
            {
                id: 'MMX',
                label: 'Login',
                weight: 12,
                re: /\b(login|browser slot|selectstore|credentials|macromatix|queued)\b/i,
            },
            {
                id: 'Downloads',
                label: 'Reports',
                weight: 58,
                re: /\b(download|concurrent|report[123]|soh|soo|ise|scm|stock on|inventory special|store tree|generate)\b/i,
            },
            {
                id: 'Excel',
                label: 'Excel',
                weight: 30,
                re: /\b(excel|workbook|mapped report|recalculat|updated working template|build-to reports update|paste payload|unlocked workbook)\b/i,
            },
        ],
    },
    'build-to-orders': {
        typicalMs: 4 * 60 * 1000,
        steps: [
            { id: 'MMX', label: 'MMX', weight: 40, re: /\b(mmx|login|browser)\b/i },
            { id: 'Build-to', label: 'Build-to', weight: 25, re: /\b(build[-\s]?to|workbook)\b/i },
            { id: 'Orders', label: 'Orders', weight: 35, re: /\b(order|vendor|submit)\b/i },
        ],
    },
    'daily-check': {
        typicalMs: 4 * 60 * 1000,
        steps: [
            { id: 'MMX', label: 'MMX', weight: 15, re: /\b(mmx|browser|queued|slot)\b/i },
            { id: 'ISE', label: 'ISE', weight: 25, re: /\b(ise|inventory|report3)\b/i },
            { id: 'SOH', label: 'SOH', weight: 25, re: /\b(soh|stock[-\s]?on[-\s]?hand)\b/i },
            { id: 'SOO', label: 'SOO', weight: 15, re: /\b(soo|stock[-\s]?on[-\s]?order)\b/i },
            { id: 'Calc', label: 'Calc', weight: 20, re: /\b(calc|shortfall|pipeline|on-hand-only|with on-order)\b/i },
        ],
    },
    'forecast-run': {
        typicalMs: 3 * 60 * 1000,
        steps: [
            { id: 'Sales', label: 'Sales', weight: 30, re: /\b(sales|lifelenz|history)\b/i },
            { id: 'Forecast', label: 'Forecast', weight: 40, re: /\b(forecast|preview|week)\b/i },
            { id: 'MMX', label: 'MMX', weight: 30, re: /\b(mmx|submit|browser)\b/i },
        ],
    },
    'forecast-backfill': {
        typicalMs: 5 * 60 * 1000,
        steps: [
            { id: 'MMX', label: 'MMX', weight: 40, re: /\b(mmx|browser|scrape)\b/i },
            { id: 'Sales', label: 'Sales', weight: 60, re: /\b(sales|import|day|backfill|history)\b/i },
        ],
    },
    'prep-ise': {
        typicalMs: 2.5 * 60 * 1000,
        steps: [{ id: 'ISE', label: 'ISE', weight: 100, re: /\b(ise|inventory)\b/i }],
    },
    'prep-sales': {
        typicalMs: 2.5 * 60 * 1000,
        steps: [{ id: 'Sales', label: 'Sales', weight: 100, re: /\b(sales|lifelenz|history)\b/i }],
    },
    'prep-forecast': {
        typicalMs: 2 * 60 * 1000,
        steps: [{ id: 'Forecast', label: 'Forecast', weight: 100, re: /\b(forecast)\b/i }],
    },
    'prep-pdf': {
        typicalMs: 3 * 60 * 1000,
        steps: [
            { id: 'ISE', label: 'ISE', weight: 40, re: /\b(ise|inventory)\b/i },
            { id: 'Prep', label: 'Prep', weight: 60, re: /\b(prep|pdf|build)\b/i },
        ],
    },
    'shortfall-check': {
        typicalMs: 3 * 60 * 1000,
        steps: [
            { id: 'MMX', label: 'MMX', weight: 15, re: /\b(mmx|browser|queued|slot|login)\b/i },
            { id: 'SOH', label: 'SOH', weight: 25, re: /\b(soh|stock[-\s]?on[-\s]?hand|report1)\b/i },
            { id: 'SOO', label: 'SOO', weight: 20, re: /\b(soo|stock[-\s]?on[-\s]?order|report2)\b/i },
            { id: 'ISE', label: 'ISE', weight: 20, re: /\b(ise|inventory|report3)\b/i },
            { id: 'Calc', label: 'Calc', weight: 20, re: /\b(calc|shortfall|alert|pipeline|complete)\b/i },
        ],
    },
};

function profileForKind(kind) {
    return (
        KIND_PROFILES[kind] || {
            typicalMs: 3 * 60 * 1000,
            steps: [{ id: 'Work', label: 'Working', weight: 100, re: /./ }],
        }
    );
}

function inferReports(message) {
    const text = String(message || '');
    const out = [];
    for (const hint of REPORT_HINTS) {
        if (hint.re.test(text) && !out.includes(hint.label)) out.push(hint.label);
    }
    return out;
}

function pruneRecent() {
    const cutoff = Date.now() - RECENT_TTL_MS;
    while (recent.length && recent[0].endedAt < cutoff) recent.shift();
    while (recent.length > RECENT_MAX) recent.shift();
}

let publishTimer = null;
let publishQueued = false;

function publish(immediate = false) {
    pruneRecent();
    if (immediate) {
        if (publishTimer) {
            clearTimeout(publishTimer);
            publishTimer = null;
        }
        publishQueued = false;
        liveEvents.bump('activity.updated', { count: active.size });
        return;
    }
    if (publishTimer) {
        publishQueued = true;
        return;
    }
    liveEvents.bump('activity.updated', { count: active.size });
    publishTimer = setTimeout(() => {
        publishTimer = null;
        if (publishQueued) {
            publishQueued = false;
            liveEvents.bump('activity.updated', { count: active.size });
        }
    }, 400);
}

function advanceStepFromMessage(entry, message) {
    const text = String(message || '');
    if (!text || !entry.steps?.length) return;
    const current = entry.stepIndex || 0;

    // Explicit Excel-complete / pipeline-complete may jump to last step.
    if (/\b(build-to reports update complete|pipeline finished successfully)\b/i.test(text)) {
        const last = entry.steps.length - 1;
        if (last > current) {
            entry.stepIndex = last;
            entry.stepStartedAt = Date.now();
        }
        return;
    }

    let matched = -1;
    for (let i = 0; i < entry.steps.length; i++) {
        const step = entry.steps[i];
        if (step.re && step.re.test(text)) matched = i;
    }
    if (matched < 0) return;

    // Only advance one step per log line — concurrent SOH/SOO/ISE logs used to
    // jump straight to the last matching step (~80%) immediately.
    const nextIndex = Math.min(matched, current + 1);
    if (nextIndex > current) {
        entry.stepIndex = nextIndex;
        entry.stepStartedAt = Date.now();
    }
}

function expectedDownloadCount(entry) {
    const fromReports = (entry.reports || []).filter((r) =>
        /^(SOH|SOO|ISE|report[123])$/i.test(String(r))
    ).length;
    if (fromReports > 0) return fromReports;
    return 3;
}

function downloadCompletionsFromLogs(entry) {
    const seen = new Set();
    for (const row of entry.logs || []) {
        const m = String(row.message || '');
        const hit = m.match(/\bDownloaded\s+(report[123])\b/i);
        if (hit) {
            seen.add(hit[1].toLowerCase());
            continue;
        }
        // Concurrent workers may log the filtered/saved line without "Downloaded reportN".
        if (/\breport1\b/i.test(m) && /\b(filter OK|→\s*\S*report1)\b/i.test(m)) seen.add('report1');
        if (/\breport2\b/i.test(m) && /\b(filter OK|→\s*\S*report2)\b/i.test(m)) seen.add('report2');
        if (/\breport3\b/i.test(m) && /\b(→\s*\S*report3|Downloaded report3)\b/i.test(m)) {
            seen.add('report3');
        }
    }
    return seen.size;
}

function estimateProgress(entry, now = Date.now()) {
    const steps = Array.isArray(entry.steps) ? entry.steps : [];
    const typicalMs = Number(entry.typicalMs) > 0 ? Number(entry.typicalMs) : 3 * 60 * 1000;

    if (entry.status === 'queued') {
        return {
            progressPct: 0,
            etaMs: null,
            etaLabel: 'Queued',
            stepIndex: 0,
            stepLabel: 'Queued',
            stepsDone: [],
        };
    }
    if (entry.status === 'done') {
        return {
            progressPct: 100,
            etaMs: 0,
            etaLabel: 'Done',
            stepIndex: Math.max(0, steps.length - 1),
            stepLabel: steps[steps.length - 1]?.label || 'Done',
            stepsDone: steps.map((s) => s.id),
        };
    }
    if (entry.status === 'failed') {
        const pct = Math.min(99, Math.max(0, Number(entry.progressPct) || 0));
        return {
            progressPct: pct,
            etaMs: null,
            etaLabel: 'Failed',
            stepIndex: entry.stepIndex || 0,
            stepLabel: steps[entry.stepIndex || 0]?.label || 'Failed',
            stepsDone: steps.slice(0, entry.stepIndex || 0).map((s) => s.id),
        };
    }

    const totalWeight = steps.reduce((sum, s) => sum + (Number(s.weight) || 1), 0) || 1;
    const stepIndex = Math.min(Math.max(0, entry.stepIndex || 0), Math.max(0, steps.length - 1));
    let completedWeight = 0;
    for (let i = 0; i < stepIndex; i++) completedWeight += Number(steps[i]?.weight) || 1;

    const step = steps[stepIndex];
    const stepWeight = Number(step?.weight) || 1;
    const stepStarted = entry.stepStartedAt || entry.startedAt || now;
    const typicalStepMs = Math.max(8_000, typicalMs * (stepWeight / totalWeight));

    let inStepFrac;
    if (step?.id === 'Downloads') {
        const expected = expectedDownloadCount(entry);
        const done = downloadCompletionsFromLogs(entry);
        // Completions drive the bar; a little time crawl so it isn't frozen between finishes.
        const timeFrac = Math.min(0.2, Math.max(0, (now - stepStarted) / typicalStepMs) * 0.2);
        inStepFrac = Math.min(0.92, done / Math.max(1, expected) + timeFrac);
    } else {
        inStepFrac = Math.min(0.85, Math.max(0, (now - stepStarted) / typicalStepMs));
    }

    const pctFromSteps = ((completedWeight + inStepFrac * stepWeight) / totalWeight) * 100;

    const elapsed = Math.max(0, now - (entry.startedAt || now));
    // Soft time floor only — never let clock alone pull the bar near completion early.
    const pctFromTime = Math.min(35, (elapsed / typicalMs) * 40);

    let pct = Math.max(pctFromSteps, pctFromTime, 3);
    pct = Math.min(96, pct);

    const etaMs =
        pct >= 8 ? Math.round(Math.max(0, (elapsed / pct) * (100 - pct))) : Math.round(Math.max(0, typicalMs - elapsed));

    return {
        progressPct: Math.round(pct),
        etaMs,
        etaLabel: formatEta(etaMs),
        stepIndex,
        stepLabel: step?.label || 'Working',
        stepsDone: steps.slice(0, stepIndex).map((s) => s.id),
    };
}

function formatEta(ms) {
    if (ms == null || !Number.isFinite(ms)) return '';
    if (ms < 5_000) return '~now';
    const sec = Math.round(ms / 1000);
    if (sec < 60) return `~${sec}s`;
    const min = Math.floor(sec / 60);
    const rem = sec % 60;
    if (min < 10) return rem ? `~${min}m ${rem}s` : `~${min}m`;
    return `~${min}m`;
}

function appendLog(entry, message, level = 'info') {
    const text = String(message || '').replace(/\s+/g, ' ').trim();
    if (!text) return;
    if (!Array.isArray(entry.logs)) entry.logs = [];
    const last = entry.logs[entry.logs.length - 1];
    if (last && last.message === text) {
        last.at = Date.now();
        last.repeats = (last.repeats || 1) + 1;
        return;
    }
    entry.logs.push({
        at: Date.now(),
        message: text.slice(0, 500),
        level: level === 'error' || level === 'warn' ? level : 'info',
        repeats: 1,
    });
    if (entry.logs.length > LOG_MAX) {
        entry.logs.splice(0, entry.logs.length - LOG_MAX);
    }
}

function snapshot(entry) {
    const est = estimateProgress(entry);
    const stepIds = (entry.steps || []).map((s) => s.id);
    return {
        id: entry.id,
        kind: entry.kind,
        title: entry.title,
        storeNumber: entry.storeNumber || '',
        stores: Array.isArray(entry.stores) ? entry.stores : [],
        detail: entry.detail || '',
        reports: stepIds.length ? stepIds : Array.isArray(entry.reports) ? entry.reports : [],
        currentStep: est.stepLabel,
        stepsDone: est.stepsDone,
        progressPct: est.progressPct,
        etaMs: est.etaMs,
        etaLabel: est.etaLabel,
        logs: Array.isArray(entry.logs) ? entry.logs.slice(-40) : [],
        status: entry.status || 'running',
        ok: entry.ok,
        error: entry.error || null,
        startedAt: entry.startedAt,
        updatedAt: entry.updatedAt,
        endedAt: entry.endedAt || null,
    };
}

function start(meta = {}) {
    seq += 1;
    const id = `act-${Date.now().toString(36)}-${seq}`;
    const now = Date.now();
    const kind = String(meta.kind || 'job');
    const profile = profileForKind(kind);
    const steps = Array.isArray(meta.steps) && meta.steps.length
        ? meta.steps.map((s, i) => ({
              id: s.id || s.label || `step-${i}`,
              label: s.label || s.id || `Step ${i + 1}`,
              weight: Number(s.weight) || 1,
              re: s.re || null,
          }))
        : profile.steps.map((s) => ({ ...s }));

    const status = meta.status === 'queued' ? 'queued' : 'running';
    const entry = {
        id,
        kind,
        title: String(meta.title || 'Working…'),
        storeNumber: meta.storeNumber ? String(meta.storeNumber) : '',
        stores: Array.isArray(meta.stores) ? meta.stores.map(String) : [],
        detail: String(meta.detail || (status === 'queued' ? 'Queued…' : 'Starting…')),
        reports: Array.isArray(meta.reports) ? [...meta.reports] : steps.map((s) => s.id),
        steps,
        stepIndex: 0,
        stepStartedAt: now,
        typicalMs: Number(meta.typicalMs) > 0 ? Number(meta.typicalMs) : profile.typicalMs,
        logs: [],
        status,
        ok: null,
        error: null,
        startedAt: now,
        updatedAt: now,
        endedAt: null,
        queuedAt: status === 'queued' ? now : null,
    };
    appendLog(entry, entry.detail || (status === 'queued' ? 'Queued…' : 'Starting…'));
    active.set(id, entry);
    publish(true);
    return id;
}

function get(id) {
    const entry = active.get(id);
    return entry ? snapshot(entry) : null;
}

/** Move a queued entry into the running state (job queue slot opened). */
function markRunning(id, detail = 'Starting…') {
    const entry = active.get(id);
    if (!entry) return null;
    const now = Date.now();
    entry.status = 'running';
    entry.detail = String(detail || 'Starting…');
    entry.stepIndex = 0;
    entry.stepStartedAt = now;
    entry.startedAt = now;
    entry.updatedAt = now;
    appendLog(entry, entry.detail);
    publish(true);
    return snapshot(entry);
}

function update(id, patch = {}) {
    const entry = active.get(id);
    if (!entry) return null;
    if (patch.title != null) entry.title = String(patch.title);
    if (patch.detail != null) {
        entry.detail = String(patch.detail);
        advanceStepFromMessage(entry, patch.detail);
        const inferred = inferReports(patch.detail);
        if (inferred.length) {
            const merged = new Set([...(entry.reports || []), ...inferred]);
            entry.reports = [...merged];
        }
        if (patch.log !== false) {
            appendLog(entry, patch.detail, patch.level || 'info');
        }
    }
    if (Array.isArray(patch.reports)) entry.reports = [...patch.reports];
    if (patch.storeNumber != null) entry.storeNumber = String(patch.storeNumber);
    if (Array.isArray(patch.stores)) entry.stores = patch.stores.map(String);
    if (patch.stepIndex != null && Number.isFinite(Number(patch.stepIndex))) {
        entry.stepIndex = Math.max(0, Math.min(entry.steps.length - 1, Number(patch.stepIndex)));
        entry.stepStartedAt = Date.now();
    }
    if (patch.logMessage != null) {
        appendLog(entry, patch.logMessage, patch.level || 'info');
    }
    entry.updatedAt = Date.now();
    publish();
    return snapshot(entry);
}

function progress(id, message) {
    return update(id, { detail: String(message || '') });
}

function log(id, message, level = 'info') {
    const entry = active.get(id);
    if (!entry) return null;
    appendLog(entry, message, level);
    entry.updatedAt = Date.now();
    publish();
    return snapshot(entry);
}

function end(id, result = {}) {
    const entry = active.get(id);
    if (!entry) return null;
    active.delete(id);
    entry.status = result.ok === false ? 'failed' : 'done';
    entry.ok = result.ok !== false;
    entry.error = result.error ? String(result.error) : null;
    if (result.detail != null) entry.detail = String(result.detail);
    appendLog(
        entry,
        result.detail || (entry.ok ? 'Done' : entry.error || 'Failed'),
        entry.ok ? 'info' : 'error'
    );
    if (entry.ok) {
        entry.stepIndex = Math.max(0, (entry.steps || []).length - 1);
    }
    entry.endedAt = Date.now();
    entry.updatedAt = entry.endedAt;
    recent.push(snapshot(entry));
    pruneRecent();
    publish(true);
    return snapshot(entry);
}

function endWhere(predicate) {
    const ids = [];
    for (const [id, entry] of active) {
        if (predicate(entry)) ids.push(id);
    }
    for (const id of ids) end(id, { ok: true });
    return ids.length;
}

function find(predicate) {
    for (const entry of active.values()) {
        if (predicate(entry)) return snapshot(entry);
    }
    return null;
}

function list() {
    pruneRecent();
    const now = Date.now();
    // Refresh estimates on read so the bar moves between events.
    // Running first, then queued (FIFO). Active work stays at the top of Activity.
    const statusRank = (s) => (s === 'running' ? 0 : s === 'queued' ? 1 : 2);
    return {
        active: [...active.values()]
            .map((e) => {
                e.updatedAt = now;
                return snapshot(e);
            })
            .sort((a, b) => {
                const sr = statusRank(a.status) - statusRank(b.status);
                if (sr) return sr;
                return (a.startedAt || 0) - (b.startedAt || 0);
            }),
        recent: [...recent].sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0)),
        count: active.size,
        at: now,
    };
}

/** Run async work under an activity entry; progress(message) updates detail/reports. */
async function run(meta, work) {
    const id = start(meta);
    try {
        const result = await work({
            id,
            progress: (message) => progress(id, message),
            update: (patch) => update(id, patch),
        });
        end(id, { ok: true, detail: meta.doneDetail || 'Done' });
        return result;
    } catch (err) {
        end(id, { ok: false, error: err.message || String(err), detail: err.message || 'Failed' });
        throw err;
    }
}

module.exports = {
    start,
    get,
    markRunning,
    update,
    progress,
    log,
    end,
    endWhere,
    find,
    list,
    run,
    inferReports,
    estimateProgress,
    formatEta,
    KIND_PROFILES,
};
