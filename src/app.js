const { loadEnv } = require('./loadEnv');
loadEnv();

const path = require('path');
const express = require('express');
const compression = require('compression');
const paths = require('./paths');
const liveEvents = require('./liveEvents');
const activity = require('./activityTracker');
const jobQueue = require('./jobQueue');
const adminLiveLogs = require('./adminLiveLogs');
const buildToExcel = require('./buildToExcel');
const {
    buildAdminBuildToCatalog,
    filterOverridesForActor,
    readOverridesDoc,
} = require('../vendors/src/buildToAdminCatalog');
const { patchOverrides } = require('../vendors/src/buildToAdminOverrides');
const { listStoresForCoach, coachOwnsStore } = require('../stores/src/coachScope');
const coachSession = require('../stores/src/coachSession');
const fiveAm = require('../dashboard/src/fiveAmReports/fiveAmReportsStore');
const storeEmails = require('../dashboard/src/storeEmails');
const prepGuides = require('../dashboard/src/prepGuides/prepGuides');
const forecastRunner = require('../forecast/src/forecastRunner');
const forecastConfig = require('../forecast/src/forecastConfig');

const app = express();
const PORT = Number(process.env.PORT || 3100);
const ADMIN_TOKEN = String(process.env.ADMIN_HOST_TOKEN || '').trim();

app.use(compression());
app.use(express.json({ limit: '2mb' }));

function requireAdmin(req, res, next) {
    if (!ADMIN_TOKEN) return next();
    const header = String(req.headers['x-admin-token'] || '');
    const query = String(req.query.token || '');
    if (header === ADMIN_TOKEN || query === ADMIN_TOKEN) return next();
    res.status(401).json({ success: false, error: 'Admin token required.' });
}

function coachStores() {
    return listStoresForCoach();
}

function assertOwns(storeNumber, res) {
    if (!coachOwnsStore(storeNumber)) {
        res.status(403).json({ success: false, error: 'Store not in your coach scope.' });
        return false;
    }
    return true;
}

function filterOwned(storeNumbers) {
    const allowed = new Set(coachStores().map((s) => String(s.storeNumber)));
    return (storeNumbers || []).map(String).filter((n) => allowed.has(n));
}

app.use('/api', requireAdmin);

liveEvents.attach(app);

app.use('/styles', express.static(path.join(paths.sharedPublic, 'styles')));
app.use('/styles', express.static(path.join(paths.users.public, 'styles')));
app.use('/scripts', express.static(path.join(paths.sharedPublic, 'scripts')));
app.use('/admin', express.static(path.join(paths.legacy.public, 'admin')));
app.use(express.static(paths.legacy.public));

app.get('/', (_req, res) => {
    res.redirect('/admin/');
});

app.get('/api/health', (_req, res) => {
    res.json({
        success: true,
        app: 'area-coach-tools',
        stores: coachStores().length,
        buildTo: buildToExcel.getStatus(),
    });
});

app.get('/api/admin/activity', (_req, res) => {
    res.json({ success: true, ...activity.list() });
});

app.get('/api/admin/store-scope', (_req, res) => {
    const session = coachSession.maskSession();
    const stores = coachStores().map((s) => ({
        storeNumber: s.storeNumber,
        storeName: s.storeName,
        area: s.area || '',
        timeZone: s.timeZone || process.env.DASHBOARD_TIME_ZONE || 'Australia/Melbourne',
    }));
    res.json({
        success: true,
        session,
        stores,
        areas: [...new Set(stores.map((s) => s.area).filter(Boolean))],
    });
});

// Daily reports — Build-to, Forecast, Prep Guide, Stock warnings, Orders (orders after Build-to)
app.get('/api/admin/five-am-reports/stores', (_req, res) => {
    const listed = coachStores();
    const status =
        typeof fiveAm.buildStatus === 'function'
            ? fiveAm.buildStatus(listed.map((s) => s.storeNumber))
            : { stores: {}, jobs: {}, lastRun: {}, lastRunAt: {} };
    let resultsReader = null;
    try {
        resultsReader = require('../dashboard/src/fiveAmReports/fiveAmReportsResults');
    } catch {
        /* optional */
    }
    const { melbourneDateKey } = require('../dashboard/src/fiveAmReports/checkStockLevels');
    const today = melbourneDateKey();
    const btStatuses = buildToExcel.listStoreStatuses(listed);
    const btByStore = new Map(btStatuses.map((r) => [String(r.storeNumber), r]));
    res.json({
        success: true,
        ...status,
        dateKey: today,
        storeList: listed.map((s) => {
            const storeNumber = String(s.storeNumber);
            const fc = forecastRunner.storeStatusSummary(storeNumber);
            const jobs = fiveAm.getStoreJobFlags(storeNumber);
            const bt = btByStore.get(storeNumber) || {};
            const saved =
                resultsReader && typeof resultsReader.readStoreResult === 'function'
                    ? resultsReader.readStoreResult(today, storeNumber)
                    : null;
            const withOnOrder = saved?.withOnOrder || null;
            const shortfallCount = Number(withOnOrder?.count);
            return {
                storeNumber,
                storeName: s.storeName,
                stockEnabled: jobs.stockEnabled,
                buildToEnabled: jobs.buildToEnabled,
                prepGuideEnabled: jobs.prepGuideEnabled,
                ordersEnabled: jobs.ordersEnabled,
                forecastEnabled: forecastConfig.isAutoSubmitEnabled(storeNumber),
                lastStockRun:
                    status.lastRunAt?.[storeNumber] || status.lastRun?.[storeNumber] || null,
                lastForecastAt: fc.lastForecastAt || null,
                buildToUpdatedAt: bt.buildToUpdatedAt || null,
                mmxOrdersUpdatedAt: bt.mmxOrdersUpdatedAt || null,
                lastPrepEmailAt:
                    typeof prepGuides.lastPrepEmailAt === 'function'
                        ? prepGuides.lastPrepEmailAt(storeNumber)
                        : null,
                shortfallCount: Number.isFinite(shortfallCount) ? shortfallCount : null,
                shortfallsCheckedAt: withOnOrder?.checkedAt || saved?.savedAt || null,
            };
        }),
    });
});

function sendShortfallsForStore(req, res) {
    const store = String(req.params.store || '').replace(/\D/g, '');
    if (!store) {
        res.status(400).json({ success: false, error: 'storeNumber required' });
        return;
    }
    if (!coachOwnsStore(store)) {
        res.status(403).json({ success: false, error: 'Store not in your coach scope.' });
        return;
    }
    const { melbourneDateKey } = require('../dashboard/src/fiveAmReports/checkStockLevels');
    const { readStoreResult } = require('../dashboard/src/fiveAmReports/fiveAmReportsResults');
    const dateKey = melbourneDateKey();
    const saved = readStoreResult(dateKey, store);
    const withOnOrder = saved?.withOnOrder || null;
    const onHandOnly = saved?.onHandOnly || null;
    const alerts = Array.isArray(withOnOrder?.alerts)
        ? withOnOrder.alerts
        : Array.isArray(withOnOrder?.items)
          ? withOnOrder.items
          : [];
    res.json({
        success: true,
        storeNumber: store,
        dateKey,
        savedAt: saved?.savedAt || null,
        withOnOrder,
        onHandOnly,
        count: Number(withOnOrder?.count) || alerts.length,
        thresholdDays: withOnOrder?.thresholdDays ?? null,
        items: alerts,
        checked: Boolean(withOnOrder?.checked || saved),
    });
}

app.get('/api/admin/daily-reports/shortfalls/:store', sendShortfallsForStore);
app.get('/api/admin/shortfalls/:store', sendShortfallsForStore);

/** Stock-only shortfall check (does not run Build-to / Forecast / Prep / Orders). */
app.post('/api/admin/shortfalls/run', async (req, res) => {
    const { checkCurrentLevelsForStore } = require('../dashboard/src/fiveAmReports/checkStockLevels');
    let storeNumbers = Array.isArray(req.body?.storeNumbers)
        ? filterOwned(req.body.storeNumbers)
        : req.body?.storeNumber
          ? filterOwned([String(req.body.storeNumber)])
          : coachStores().map((s) => String(s.storeNumber));
    if (!storeNumbers.length) {
        res.status(400).json({ success: false, error: 'No stores in coach scope.' });
        return;
    }

    const stream = wantsNdjson(req);
    const write = stream ? beginNdjson(res) : null;
    write?.({ type: 'log', message: `Queued shortfall check for ${storeNumbers.length} store(s)…` });

    try {
        const results = await Promise.all(
            storeNumbers.map((store) =>
                jobQueue.enqueue(
                    {
                        kind: 'shortfall-check',
                        title: 'Shortfall check',
                        storeNumber: store,
                        detail: 'Queued…',
                        reports: ['SOH', 'SOO', 'ISE', 'Calc'],
                        endsActivity: true,
                    },
                    async ({ progress }) => {
                        progress(`Store ${store}: starting shortfall check…`);
                        try {
                            const row = await checkCurrentLevelsForStore(store, {
                                // Prefer Build-to / on-disk reports; only force refresh when asked.
                                force: Boolean(req.body?.force),
                                onProgress: (message) => {
                                    write?.({ type: 'log', message });
                                    progress(message);
                                },
                            });
                            const count = Number(row?.withOnOrderCount);
                            write?.({
                                type: 'store-done',
                                storeNumber: store,
                                ok: Boolean(row?.ok !== false),
                                withOnOrderCount: Number.isFinite(count) ? count : null,
                                mode: row?.mode || 'shortfall',
                                error: row?.error || null,
                            });
                            return {
                                ok: Boolean(row?.ok !== false),
                                error: row?.error || null,
                                detail: row?.ok === false
                                    ? row?.error || 'Failed'
                                    : Number.isFinite(count)
                                      ? `${count} shortfall(s)`
                                      : 'Complete',
                                row: { ...row, storeNumber: store },
                            };
                        } catch (err) {
                            write?.({
                                type: 'store-done',
                                storeNumber: store,
                                ok: false,
                                error: err.message || String(err),
                            });
                            return {
                                ok: false,
                                error: err.message || String(err),
                                detail: err.message || 'Failed',
                                row: { ok: false, storeNumber: store, error: err.message || String(err) },
                            };
                        }
                    }
                )
            )
        );

        const rows = results.map((r) => r?.row || r).filter(Boolean);
        const ok = rows.every((r) => r.ok);
        const message = ok
            ? `Shortfall check finished for ${rows.length} store(s).`
            : 'Finished with errors — see results.';
        if (stream) {
            write({ type: 'done', success: ok, message, results: rows });
            res.end();
        } else {
            res.status(ok ? 200 : 207).json({ success: ok, message, results: rows });
        }
        liveEvents.bump('daily-reports.updated');
    } catch (err) {
        if (stream) {
            write({ type: 'done', success: false, error: err.message || String(err) });
            res.end();
            return;
        }
        res.status(500).json({ success: false, error: err.message || String(err) });
    }
});

app.put('/api/admin/five-am-reports/stores', (req, res) => {
    const body = req.body || {};
    const updates = Array.isArray(body.stores)
        ? body.stores
        : body.storeNumber || body.store
          ? [
                {
                    storeNumber: body.storeNumber || body.store,
                    stockEnabled: body.stockEnabled ?? body.enabled,
                    forecastEnabled: body.forecastEnabled,
                    buildToEnabled: body.buildToEnabled,
                    prepGuideEnabled: body.prepGuideEnabled,
                    ordersEnabled: body.ordersEnabled,
                },
            ]
          : [];
    const saved = [];
    for (const row of updates) {
        const store = String(row?.storeNumber || '').trim();
        if (!store || !coachOwnsStore(store)) continue;
        if (row.stockEnabled != null || row.enabled != null) {
            fiveAm.setStoreJobFlag(
                store,
                'stockEnabled',
                Boolean(row.stockEnabled ?? row.enabled),
                'area-coach-tools'
            );
        }
        if (row.buildToEnabled != null) {
            fiveAm.setStoreJobFlag(store, 'buildToEnabled', Boolean(row.buildToEnabled), 'area-coach-tools');
        }
        if (row.prepGuideEnabled != null) {
            fiveAm.setStoreJobFlag(
                store,
                'prepGuideEnabled',
                Boolean(row.prepGuideEnabled),
                'area-coach-tools'
            );
        }
        if (row.ordersEnabled != null) {
            fiveAm.setStoreJobFlag(store, 'ordersEnabled', Boolean(row.ordersEnabled), 'area-coach-tools');
        }
        if (row.forecastEnabled != null) {
            forecastConfig.setAutoSubmit(store, Boolean(row.forecastEnabled));
        }
        saved.push({
            storeNumber: store,
            ...fiveAm.getStoreJobFlags(store),
            forecastEnabled: forecastConfig.isAutoSubmitEnabled(store),
        });
    }
    res.json({ success: true, saved });
    liveEvents.bump('daily-reports.updated');
});

app.post('/api/admin/daily-reports/run', async (req, res) => {
    const dailyRunner = require('../dashboard/src/dailyReports/areaCoachDailyRunner');
    let storeNumbers = Array.isArray(req.body?.storeNumbers)
        ? filterOwned(req.body.storeNumbers)
        : req.body?.storeNumber
          ? filterOwned([String(req.body.storeNumber)])
          : coachStores().map((s) => String(s.storeNumber));
    if (!storeNumbers.length) {
        res.status(400).json({ success: false, error: 'No stores in coach scope.' });
        return;
    }

    const listed = coachStores();
    const byNum = new Map(listed.map((s) => [String(s.storeNumber), s]));
    const stores = storeNumbers.map((n) => ({
        storeNumber: n,
        storeName: byNum.get(String(n))?.storeName || '',
    }));

    const stream = wantsNdjson(req);
    const write = stream ? beginNdjson(res) : null;
    write?.({ type: 'log', message: `Queued ${stores.length} store check(s)…` });

    // Each store is a separate queue slot so Activity shows Queued → Running one at a time
    // (also serializes when the UI fires many parallel /run requests).
    try {
        const results = await Promise.all(
            stores.map((store) =>
                jobQueue.enqueue(
                    {
                        kind: 'daily-check',
                        title: 'Daily reports',
                        storeNumber: store.storeNumber,
                        detail: 'Queued…',
                        reports: ['Build-to', 'Forecast', 'Prep', 'Stock', 'Orders'],
                        endsActivity: true,
                    },
                    async ({ progress }) => {
                        progress(`Store ${store.storeNumber}: starting daily reports…`);
                        const row = await dailyRunner.runDailyJobsForStore(store, {
                            onProgress: (message) => {
                                write?.({ type: 'log', message });
                                progress(message);
                            },
                        });
                        write?.({
                            type: 'store-done',
                            storeNumber: row.storeNumber,
                            ok: Boolean(row.ok || row.skipped),
                            error: row.error || null,
                            mode: 'daily',
                            steps: row.steps || [],
                            withOnOrderCount: (row.steps || []).find((s) => s.id === 'stock')?.result
                                ?.withOnOrderCount,
                        });
                        const stockStep = (row.steps || []).find((s) => s.id === 'stock' && s.ok);
                        const shortfalls = stockStep?.result?.withOnOrderCount;
                        return {
                            ok: Boolean(row.ok || row.skipped),
                            error: row.ok || row.skipped ? null : row.error || null,
                            detail: row.skipped
                                ? 'No jobs enabled'
                                : row.ok
                                  ? shortfalls != null
                                      ? `${shortfalls} shortfall(s)`
                                      : 'Complete'
                                  : row.error || 'Failed',
                            row,
                        };
                    }
                )
            )
        );

        const rows = results.map((r) => r?.row || r).filter(Boolean);
        const ok = rows.every((r) => r.ok || r.skipped);
        const message = ok
            ? `Daily reports finished for ${rows.length} store(s).`
            : 'Finished with errors — see results.';
        if (stream) {
            write({ type: 'done', success: ok, message, results: rows });
            res.end();
        } else {
            res.status(ok ? 200 : 207).json({ success: ok, message, results: rows });
        }
        liveEvents.bump('daily-reports.updated');
    } catch (err) {
        if (stream) {
            write({ type: 'done', success: false, error: err.message || String(err) });
            res.end();
            return;
        }
        res.status(500).json({ success: false, error: err.message || String(err) });
    }
});

// Store emails (prep guides)
app.get('/api/admin/store-emails', (_req, res) => {
    const all = storeEmails.readAll();
    const scoped = {};
    for (const s of coachStores()) {
        const key = String(s.storeNumber);
        scoped[key] = all[key] || '';
    }
    res.json({ success: true, emails: scoped });
});

app.put('/api/admin/store-emails', (req, res) => {
    const body = req.body?.emails && typeof req.body.emails === 'object' ? req.body.emails : {};
    const all = storeEmails.readAll();
    for (const [store, email] of Object.entries(body)) {
        if (!coachOwnsStore(store)) continue;
        const trimmed = String(email || '').trim();
        if (trimmed) all[String(store)] = trimmed;
        else delete all[String(store)];
    }
    res.json({ success: true, emails: storeEmails.writeAll(all) });
});

// Prep Guides
function wantsNdjson(req) {
    return (
        String(req.headers.accept || '').includes('application/x-ndjson') ||
        req.body?.stream === true ||
        req.query?.stream === '1'
    );
}

function beginNdjson(res) {
    res.status(200);
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    return (payload) => {
        try {
            res.write(`${JSON.stringify(payload)}\n`);
            if (typeof res.flush === 'function') res.flush();
        } catch {
            /* client gone */
        }
    };
}

app.get('/api/admin/prep-guides', (_req, res) => {
    const listed = coachStores();
    res.json({
        success: true,
        weekdays: prepGuides.WEEKDAYS,
        areaLabel: coachSession.maskSession()?.region || coachSession.maskSession()?.displayName || 'Area',
        stores: prepGuides.listStoreStatus(listed.map((s) => s.storeNumber)),
        template: prepGuides.ensureTemplate(),
    });
});

function trackNdjsonJob({ kind, title, storeNumber, reports }, req, res, work) {
    const stream = wantsNdjson(req);
    const write = stream ? beginNdjson(res) : null;
    write?.({ type: 'log', message: 'Queued…' });
    return jobQueue.enqueue(
        {
            kind,
            title,
            storeNumber,
            detail: 'Queued…',
            reports: reports || [],
            endsActivity: true,
        },
        async ({ progress }) => {
            const onProgress = (message) => {
                write?.({ type: 'log', message });
                progress(message);
            };
            const outcome = await work({ onProgress, write, stream });
            return {
                ok: outcome?.ok !== false,
                error: outcome?.error || null,
                detail: outcome?.detail || (outcome?.ok !== false ? 'Done' : 'Failed'),
                outcome,
            };
        }
    ).then((wrapped) => wrapped?.outcome ?? wrapped);
}

app.post('/api/admin/prep-guides/update-sales', async (req, res) => {
    const store = String(req.body?.storeNumber || '').trim();
    if (!store) {
        res.status(400).json({ success: false, error: 'storeNumber required' });
        return;
    }
    if (!assertOwns(store, res)) return;
    try {
        const outcome = await trackNdjsonJob(
            { kind: 'prep-sales', title: 'Update sales history', storeNumber: store, reports: ['Sales'] },
            req,
            res,
            async ({ onProgress, write, stream }) => {
                const result = await prepGuides.updateSalesHistory(store, { force: true, onProgress });
                if (stream) {
                    write({ type: 'done', success: Boolean(result.ok), result });
                    res.end();
                } else {
                    res.status(result.ok ? 200 : 500).json({ success: Boolean(result.ok), result });
                }
                return { ok: Boolean(result.ok), detail: result.ok ? 'Sales updated' : 'Sales update failed' };
            }
        );
        return outcome;
    } catch (err) {
        if (wantsNdjson(req) && !res.headersSent) {
            beginNdjson(res)({ type: 'done', success: false, error: err.message || String(err) });
            res.end();
            return;
        }
        if (!res.headersSent) {
            res.status(500).json({ success: false, error: err.message || String(err) });
        }
    }
});

app.post('/api/admin/prep-guides/update-ise', async (req, res) => {
    const store = String(req.body?.storeNumber || '').trim();
    if (!store) {
        res.status(400).json({ success: false, error: 'storeNumber required' });
        return;
    }
    if (!assertOwns(store, res)) return;
    try {
        await trackNdjsonJob(
            { kind: 'prep-ise', title: 'Update ISE', storeNumber: store, reports: ['ISE'] },
            req,
            res,
            async ({ onProgress, write, stream }) => {
                const result = await prepGuides.updateIse(store, { force: true, onProgress });
                if (stream) {
                    write({ type: 'done', success: Boolean(result.ok), result });
                    res.end();
                } else {
                    res.status(result.ok ? 200 : 500).json({ success: Boolean(result.ok), result });
                }
                return { ok: Boolean(result.ok), detail: result.ok ? 'ISE updated' : 'ISE update failed' };
            }
        );
    } catch (err) {
        if (wantsNdjson(req) && !res.headersSent) {
            beginNdjson(res)({ type: 'done', success: false, error: err.message || String(err) });
            res.end();
            return;
        }
        if (!res.headersSent) {
            res.status(500).json({ success: false, error: err.message || String(err) });
        }
    }
});

app.post('/api/admin/prep-guides/update-forecast', async (req, res) => {
    const store = String(req.body?.storeNumber || '').trim();
    if (!store) {
        res.status(400).json({ success: false, error: 'storeNumber required' });
        return;
    }
    if (!assertOwns(store, res)) return;
    try {
        await trackNdjsonJob(
            { kind: 'prep-forecast', title: 'Update forecast workbook', storeNumber: store, reports: ['Forecast'] },
            req,
            res,
            async ({ onProgress, write, stream }) => {
                const result = await prepGuides.updateForecastWorkbook(store, { onProgress });
                if (stream) {
                    write({ type: 'done', success: Boolean(result.ok), result });
                    res.end();
                } else {
                    res.json({ success: true, result });
                }
                return { ok: Boolean(result.ok), detail: result.ok ? 'Forecast updated' : 'Forecast update failed' };
            }
        );
    } catch (err) {
        if (wantsNdjson(req) && !res.headersSent) {
            beginNdjson(res)({ type: 'done', success: false, error: err.message || String(err) });
            res.end();
            return;
        }
        if (!res.headersSent) {
            res.status(500).json({ success: false, error: err.message || String(err) });
        }
    }
});

app.post('/api/admin/prep-guides/regenerate', async (req, res) => {
    const store = String(req.body?.storeNumber || '').trim();
    if (!store) {
        res.status(400).json({ success: false, error: 'storeNumber required' });
        return;
    }
    if (!assertOwns(store, res)) return;
    // Always force ISE download before PDF build (required for accurate prep data).
    const fetchMissing = req.body?.fetchMissing !== false;
    try {
        await trackNdjsonJob(
            { kind: 'prep-pdf', title: 'Build Prep Guide PDFs', storeNumber: store, reports: ['ISE', 'Prep'] },
            req,
            res,
            async ({ onProgress, write, stream }) => {
                try {
                    const meta = await prepGuides.regenerateStore(store, { fetchMissing, onProgress });
                    if (stream) {
                        write({ type: 'done', success: true, meta });
                        res.end();
                    } else {
                        res.json({ success: true, meta });
                    }
                    return { ok: true, detail: 'PDFs ready' };
                } catch (err) {
                    const logs = Array.isArray(err.logs) ? err.logs : [];
                    if (stream) {
                        logs.forEach((message) => write({ type: 'log', message }));
                        write({
                            type: 'done',
                            success: false,
                            error: err.message || String(err),
                            logs,
                        });
                        res.end();
                    } else if (!res.headersSent) {
                        res.status(500).json({
                            success: false,
                            error: err.message || String(err),
                            logs,
                        });
                    }
                    return { ok: false, error: err.message || String(err), detail: err.message || 'Failed' };
                }
            }
        );
    } catch (err) {
        if (!res.headersSent) {
            res.status(500).json({ success: false, error: err.message || String(err) });
        }
    }
});

app.get('/api/admin/prep-guides/:storeNumber/:weekday.pdf', (req, res) => {
    const store = String(req.params.storeNumber || '').trim();
    if (!assertOwns(store, res)) return;
    const file = prepGuides.pdfPath(store, req.params.weekday);
    if (!file) {
        res.status(404).json({ success: false, error: 'PDF not found. Regenerate first.' });
        return;
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.sendFile(path.resolve(file));
});

app.post('/api/admin/prep-guides/open', async (req, res) => {
    const store = String(req.body?.storeNumber || req.body?.store || '').replace(/\D/g, '');
    if (!store) {
        res.status(400).json({ success: false, error: 'storeNumber required.' });
        return;
    }
    if (!assertOwns(store, res)) return;
    const result = await prepGuides.openWorkbook(store);
    res.status(result.ok ? 200 : 500).json({ success: result.ok, ...result });
});

app.post('/api/admin/prep-guides/email-now', async (req, res) => {
    try {
        const result = await prepGuides.runFiveAmEmailPass();
        res.json({ success: true, result });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message || String(err) });
    }
});

// Live logs — default all
app.get('/api/admin/logs/sources', (_req, res) => {
    res.json({ success: true, sources: adminLiveLogs.listSources() });
});

app.get('/api/admin/logs/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    adminLiveLogs.streamLogs(res, {
        source: req.query.source || 'all',
        tail: Number(req.query.tail || 200),
    });
});

app.get('/api/admin/logs/download', (req, res) => {
    const pack = adminLiveLogs.downloadLogs(req.query.source || 'all');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${pack.filename}"`);
    res.send(pack.body);
});

// Area Overview — at-a-glance Build-to / Forecast / Orders per coach store
app.get('/api/admin/area-overview', (_req, res) => {
    const listed = coachStores().map((s) => ({
        storeNumber: String(s.storeNumber),
        storeName: s.storeName || '',
    }));
    const btByStore = new Map(
        buildToExcel.listStoreStatuses(listed).map((row) => [String(row.storeNumber), row])
    );
    const { melbourneDateKey } = require('../dashboard/src/fiveAmReports/checkStockLevels');
    const { readStoreResult } = require('../dashboard/src/fiveAmReports/fiveAmReportsResults');
    const { getLastRunAt, getLastEmailAt } = require('../dashboard/src/fiveAmReports/fiveAmReportsStore');
    const today = melbourneDateKey();
    const stores = listed.map((s) => {
        const bt = btByStore.get(s.storeNumber) || {};
        const fc = forecastRunner.storeStatusSummary(s.storeNumber);
        const saved = readStoreResult(today, s.storeNumber);
        const withOnOrder = saved?.withOnOrder || null;
        const shortfallsCheckedAt =
            withOnOrder?.checkedAt || saved?.savedAt || getLastRunAt(s.storeNumber) || null;
        return {
            storeNumber: s.storeNumber,
            storeName: s.storeName,
            buildToUpdatedAt: bt.buildToUpdatedAt || null,
            ordersUpdatedAt: bt.mmxOrdersUpdatedAt || null,
            forecastUpdatedAt: fc.lastForecastAt || null,
            prepGuidesSentAt: prepGuides.lastPrepEmailAt(s.storeNumber),
            shortfallsCheckedAt,
            shortfallsEmailedAt: getLastEmailAt(s.storeNumber),
            shortfallCount: Number.isFinite(Number(withOnOrder?.count))
                ? Number(withOnOrder.count)
                : null,
            forecastWeekStates: fc.weekStates || [],
            historyReady: Boolean(fc.historyReady),
            lastHistoryDate: fc.lastHistoryDate || null,
            weekTotal: fc.weekTotal || 0,
            lastError: bt.lastError || null,
        };
    });
    res.json({ success: true, stores });
});

// Build-to Excel
app.get('/api/admin/build-to/status', (_req, res) => {
    const stores = coachStores().map((s) => ({
        storeNumber: s.storeNumber,
        storeName: s.storeName || '',
    }));
    res.json({
        success: true,
        ...buildToExcel.getStatus(stores),
        running: buildToExcel.isRunning(),
    });
});

app.post('/api/admin/build-to/open', async (req, res) => {
    const store = String(req.body?.storeNumber || req.body?.store || '').replace(/\D/g, '');
    if (!store) {
        res.status(400).json({
            success: false,
            error: 'storeNumber required (opens Downloads\\{store} - Build To.xlsx).',
        });
        return;
    }
    if (!coachOwnsStore(store)) {
        res.status(403).json({ success: false, error: 'Store not in your coach scope.' });
        return;
    }
    const result = await buildToExcel.openWorkbook(store);
    res.status(result.ok ? 200 : 500).json({ success: result.ok, ...result });
});

app.post('/api/admin/build-to/run', async (req, res) => {
    const mode = String(req.body?.mode || 'reports').toLowerCase() === 'orders' ? 'orders' : 'reports';
    let stores = [];
    if (Array.isArray(req.body?.storeNumbers) && req.body.storeNumbers.length) {
        stores = filterOwned(req.body.storeNumbers).map((n) => {
            const row = coachStores().find((s) => String(s.storeNumber) === String(n));
            return { storeNumber: String(n), storeName: row?.storeName || '' };
        });
    } else if (req.body?.store) {
        const store = String(req.body.store).trim();
        if (!coachOwnsStore(store)) {
            res.status(403).json({ success: false, error: 'Store not in your coach scope.' });
            return;
        }
        const row = coachStores().find((s) => String(s.storeNumber) === store);
        stores = [{ storeNumber: store, storeName: row?.storeName || '' }];
    } else {
        // Prefer explicit storeNumbers from UI — area-wide still allowed for Update.
        stores = coachStores().map((s) => ({
            storeNumber: String(s.storeNumber),
            storeName: s.storeName || '',
        }));
    }
    if (!stores.length) {
        res.status(400).json({ success: false, error: 'No stores in coach scope.' });
        return;
    }

    const free = stores.filter((s) => !buildToExcel.isStoreRunning(s.storeNumber));
    const busy = stores.filter((s) => buildToExcel.isStoreRunning(s.storeNumber));
    if (!free.length) {
        res.status(409).json({
            success: false,
            error:
                busy.length === 1
                    ? `Build-to already running for store ${busy[0].storeNumber}.`
                    : 'Build-to already running for all selected stores.',
            runningStores: buildToExcel.listRunning(),
            stores: busy.map((s) => ({
                storeNumber: s.storeNumber,
                ok: false,
                skipped: true,
                error: `Already running.`,
            })),
        });
        return;
    }

    if (mode === 'orders' && free.length === 1) {
        const st = buildToExcel.listStoreStatuses(free)[0];
        if (!st?.canPlaceOrders) {
            res.status(400).json({
                success: false,
                error: 'Update Build-to first today before placing orders.',
                storeNumber: free[0].storeNumber,
            });
            return;
        }
    }

    // One queued activity entry per store (global job queue — one at a time by default).
    try {
        const storeResults = await Promise.all(
            free.map((s) =>
                jobQueue.enqueue(
                    {
                        kind: mode === 'orders' ? 'build-to-orders' : 'build-to-update',
                        title: mode === 'orders' ? 'Place MMX orders' : 'Update Build-to',
                        storeNumber: String(s.storeNumber),
                        stores: [String(s.storeNumber)],
                        detail: 'Queued…',
                        reports:
                            mode === 'orders' ? ['Build-to', 'MMX'] : ['SOH', 'SOO', 'ISE', 'Build-to'],
                        endsActivity: true,
                    },
                    async ({ progress }) => {
                        const result = await buildToExcel.runExcelBuildTo({
                            mode,
                            stores: [s],
                            onProgress: (message) => progress(message),
                        });
                        const row = (result.stores || [])[0] || {
                            storeNumber: s.storeNumber,
                            ok: Boolean(result.ok),
                            error: result.error || null,
                        };
                        return {
                            ok: Boolean(row.ok),
                            error: row.error || null,
                            detail: row.ok ? 'Done' : row.error || 'Failed',
                            row,
                        };
                    }
                )
            )
        );

        const rows = storeResults.map((r) => r?.row || r).filter(Boolean);
        const ok = rows.length > 0 && rows.every((r) => r.ok);
        const payload = {
            success: ok,
            ok,
            stores: rows,
            skipped: busy.map((s) => String(s.storeNumber)),
            runningStores: buildToExcel.listRunning(),
        };
        res.status(ok ? 200 : 500).json(payload);
        liveEvents.bump('build-to.updated');
    } catch (err) {
        throw err;
    }
});

app.get('/api/admin/build-to/catalog', (req, res) => {
    try {
        const store = String(req.query.store || '').trim();
        if (store) {
            if (!assertOwns(store, res)) return;
            res.json({
                success: true,
                ...buildAdminBuildToCatalog({ storeNumber: store, level: 'store' }),
            });
            return;
        }
        res.json({ success: true, ...buildAdminBuildToCatalog({ level: 'global' }) });
    } catch (err) {
        console.error('[build-to catalog]', err);
        res.status(500).json({
            success: false,
            error: err.message || 'Could not load build-to catalog.',
        });
    }
});

app.get('/api/admin/build-to/overrides', (_req, res) => {
    try {
        const doc = readOverridesDoc();
        const stores = coachStores().map((s) => String(s.storeNumber));
        res.json({
            success: true,
            overrides: filterOverridesForActor(doc, stores, true, []),
        });
    } catch (err) {
        console.error('[build-to overrides get]', err);
        res.status(500).json({
            success: false,
            error: err.message || 'Could not load build-to overrides.',
        });
    }
});

app.put('/api/admin/build-to/overrides', (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const patch = {};

    if (body.settings && typeof body.settings === 'object') {
        patch.settings = body.settings;
    }
    if (body.global && typeof body.global === 'object') {
        patch.global = body.global;
    }
    if (body.stores && typeof body.stores === 'object') {
        patch.stores = {};
        for (const [storeNumber, storePatch] of Object.entries(body.stores)) {
            const store = String(storeNumber || '').replace(/\D/g, '');
            if (!store) continue;
            if (!coachOwnsStore(store)) {
                res.status(403).json({
                    success: false,
                    error: `Store ${storeNumber} is outside your coach scope.`,
                });
                return;
            }
            patch.stores[store] = storePatch;
        }
    }

    if (!patch.global && !patch.stores && !patch.settings) {
        res.status(400).json({ success: false, error: 'No build-to changes to save.' });
        return;
    }

    try {
        // Area coaches may edit configure fields (codes, Outer/Inner/Unit, pack sizes).
        patchOverrides(patch);
        liveEvents.bump('build-to.updated');
        res.json({ success: true });
    } catch (err) {
        console.error('[build-to overrides put]', err);
        res.status(400).json({
            success: false,
            error: err.message || 'Could not save build-to changes.',
        });
    }
});

// Forecast
app.get('/api/admin/forecast/status', (_req, res) => {
    const numbers = coachStores().map((s) => String(s.storeNumber));
    res.json({
        success: true,
        stores: forecastRunner.listStoreStatuses(numbers),
        config: forecastConfig.readConfig(),
        runs: forecastRunner.listRecentRuns(10),
    });
});

app.get('/api/admin/forecast/history', (req, res) => {
    try {
        const store = String(req.query.storeNumber || '').trim();
        if (!store) {
            res.status(400).json({ success: false, error: 'storeNumber required' });
            return;
        }
        if (!assertOwns(store, res)) return;
        const historyStore = require('../forecast/src/historyStore');
        const limit = Number(req.query.limit || 70) || 70;
        const days = historyStore.listHistoryDays(store, { limit });
        const ignoredCount = days.filter((d) => d.ignored).length;
        res.json({
            success: true,
            storeNumber: store,
            days,
            totalDays: days.length,
            ignoredCount,
            updatedAt: historyStore.readHistory(store).updatedAt,
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message || String(err) });
    }
});

app.get('/api/admin/forecast/deep-dive', (req, res) => {
    try {
        const store = String(req.query.store || req.query.storeNumber || '').trim();
        if (!store) {
            res.status(400).json({ success: false, error: 'store required' });
            return;
        }
        if (!assertOwns(store, res)) return;
        const planEngine = require('../forecast/src/planEngine');
        const weekdayRaw = req.query.weekday;
        const weekday =
            weekdayRaw === undefined || weekdayRaw === '' || weekdayRaw === null
                ? undefined
                : Number(weekdayRaw);
        if (weekday !== undefined && (!Number.isFinite(weekday) || weekday < 0 || weekday > 6)) {
            res.status(400).json({ success: false, error: 'weekday must be 0–6 (Sun–Sat)' });
            return;
        }
        const payload = planEngine.explainWeekdayHourly({
            storeNumber: store,
            weekday,
            historyDays: Number(req.query.historyDays) || undefined,
        });
        res.json({ success: true, ...payload });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message || String(err) });
    }
});

app.put('/api/admin/forecast/history/day', (req, res) => {
    try {
        const store = String(req.body?.storeNumber || '').trim();
        const dateKey = String(req.body?.dateKey || '').trim();
        if (!store || !dateKey) {
            res.status(400).json({ success: false, error: 'storeNumber and dateKey required' });
            return;
        }
        if (!assertOwns(store, res)) return;
        const historyStore = require('../forecast/src/historyStore');
        const actual = Array.isArray(req.body?.actual)
            ? req.body.actual.map((n) => Number(n) || 0)
            : null;
        if (!actual) {
            res.status(400).json({ success: false, error: 'actual hourly array required' });
            return;
        }
        const meta = { source: 'manual-edit' };
        if (Object.prototype.hasOwnProperty.call(req.body || {}, 'ignored')) {
            meta.ignored = Boolean(req.body.ignored);
        }
        if (req.body?.note != null) meta.note = req.body.note;
        historyStore.upsertDay(store, dateKey, actual, meta);
        liveEvents.bump('forecast.updated', { storeNumber: store, dateKey });
        res.json({
            success: true,
            day: historyStore.getHistoryDay(store, dateKey),
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message || String(err) });
    }
});

app.put('/api/admin/forecast/history/ignore', (req, res) => {
    try {
        const store = String(req.body?.storeNumber || '').trim();
        const dateKey = String(req.body?.dateKey || '').trim();
        if (!store || !dateKey) {
            res.status(400).json({ success: false, error: 'storeNumber and dateKey required' });
            return;
        }
        if (!assertOwns(store, res)) return;
        const historyStore = require('../forecast/src/historyStore');
        historyStore.setDayIgnored(store, dateKey, Boolean(req.body?.ignored));
        liveEvents.bump('forecast.updated', { storeNumber: store, dateKey, ignored: Boolean(req.body?.ignored) });
        res.json({
            success: true,
            day: historyStore.getHistoryDay(store, dateKey),
        });
    } catch (err) {
        res.status(400).json({ success: false, error: err.message || String(err) });
    }
});

app.delete('/api/admin/forecast/history/day', (req, res) => {
    try {
        const store = String(req.body?.storeNumber || req.query?.storeNumber || '').trim();
        const dateKey = String(req.body?.dateKey || req.query?.dateKey || '').trim();
        if (!store || !dateKey) {
            res.status(400).json({ success: false, error: 'storeNumber and dateKey required' });
            return;
        }
        if (!assertOwns(store, res)) return;
        const historyStore = require('../forecast/src/historyStore');
        const result = historyStore.deleteDay(store, dateKey);
        liveEvents.bump('forecast.updated', { storeNumber: store, dateKey, deleted: true });
        res.json({ success: Boolean(result.ok), missing: Boolean(result.missing) });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message || String(err) });
    }
});

app.put('/api/admin/forecast/auto-submit', (req, res) => {
    const store = String(req.body?.storeNumber || '').trim();
    if (!store) {
        res.status(400).json({ success: false, error: 'storeNumber required' });
        return;
    }
    if (!assertOwns(store, res)) return;
    forecastConfig.setAutoSubmit(store, Boolean(req.body?.enabled));
    res.json({ success: true, config: forecastConfig.readConfig() });
});

app.put('/api/admin/forecast/adjustments', (req, res) => {
    forecastConfig.setAdjustment(req.body?.dateKey, req.body?.percent);
    res.json({ success: true, config: forecastConfig.readConfig() });
});

app.put('/api/admin/forecast/protected-dates', (req, res) => {
    forecastConfig.setProtectedDates(req.body?.dates || []);
    res.json({ success: true, config: forecastConfig.readConfig() });
});

app.post('/api/admin/forecast/preview', async (req, res) => {
    try {
        const store = String(req.body?.storeNumber || '').trim();
        if (!assertOwns(store, res)) return;
        const result = await forecastRunner.runForecastForStore(store, {
            previewOnly: true,
            weeks: forecastRunner.SUBMIT_WEEKS,
        });
        res.json({ success: true, result });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message || String(err) });
    }
});

app.post('/api/admin/forecast/run', async (req, res) => {
    let stores = Array.isArray(req.body?.storeNumbers)
        ? filterOwned(req.body.storeNumbers)
        : filterOwned([String(req.body?.storeNumber || '').trim()].filter(Boolean));
    if (!stores.length && req.body?.all) {
        stores = coachStores().map((s) => String(s.storeNumber));
    }
    if (!stores.length) {
        res.status(400).json({ success: false, error: 'storeNumber(s) required' });
        return;
    }

    const streamProgress =
        req.body?.streamProgress === true ||
        String(req.headers.accept || '').includes('text/event-stream');

    const writeSse = (event, data) => {
        if (!streamProgress) return;
        if (res.writableEnded || res.destroyed) return;
        try {
            res.write(`event: ${event}\n`);
            res.write(`data: ${JSON.stringify(data)}\n\n`);
        } catch {
            /* client gone */
        }
    };

    let runCancelled = false;
    let heartbeatTimer = null;

    if (streamProgress) {
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders?.();
        writeSse('started', { storeNumbers: stores });
        heartbeatTimer = setInterval(() => writeSse('ping', { at: Date.now() }), 10_000);
        if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();
        res.on('close', () => {
            if (res.writableEnded) return;
            runCancelled = true;
            console.warn('[Forecast] Client disconnected — cancelling for', stores.join(', '));
            try {
                const { closeAllTrackedBrowsers } = require('../mmx/src/macromatixScraper');
                closeAllTrackedBrowsers('forecast-run-cancelled-by-client').catch(() => {});
            } catch {
                /* optional */
            }
        });
    }

    const actId = activity.start({
        kind: 'forecast-run',
        title: 'Submit forecast',
        stores,
        storeNumber: stores.length === 1 ? stores[0] : '',
        detail: `${stores.length} store(s)…`,
        reports: ['Forecast', 'MMX', 'LifeLenz'],
    });

    try {
        if (streamProgress) {
            writeSse('progress', { type: 'status', label: 'Starting forecast submit…' });
            writeSse('platform-started', { platform: 'mmx', storeNumbers: stores });
            writeSse('platform-started', { platform: 'lifelenz', storeNumbers: stores });
        }

        const results = await forecastRunner.runForecastForStores(stores, {
            mmx: req.body?.mmx !== false,
            lifelenz: req.body?.lifelenz !== false,
            weeks: forecastRunner.SUBMIT_WEEKS,
            shouldAbort: () => runCancelled,
            onProgress: (payload) => {
                writeSse('progress', payload);
                if (payload?.type === 'lifelenz-phase-start') {
                    writeSse('lifelenz-started', {
                        storeNumbers: stores,
                        storeNumber: payload.storeNumber || null,
                    });
                }
            },
        });

        const cancelled = runCancelled || (results || []).some((r) => r?.cancelled);
        const ok =
            !cancelled &&
            (results || []).every((r) => r?.ok !== false && r?.state !== 'error');
        const errDetail = (results || [])
            .filter((r) => r?.state === 'error' || r?.ok === false)
            .map((r) => `${r.storeNumber}: ${r.message || 'error'}`)
            .slice(0, 3)
            .join(' · ');

        activity.end(actId, {
            ok: ok && !cancelled,
            detail: cancelled
                ? 'Cancelled'
                : ok
                  ? 'Forecast submitted'
                  : errDetail || 'Finished with errors',
        });

        const payload = {
            success: true,
            ok,
            cancelled,
            results,
            partialFailure: !ok && !cancelled && (results || []).some((r) => r?.ok !== false),
        };

        if (streamProgress) {
            writeSse('complete', payload);
            if (heartbeatTimer) clearInterval(heartbeatTimer);
            if (!res.writableEnded) res.end();
        } else {
            res.json(payload);
        }
        liveEvents.bump('forecast.updated');
    } catch (err) {
        const message = err.message || String(err);
        activity.end(actId, { ok: false, error: message });
        if (streamProgress) {
            writeSse('error', { success: false, error: message });
            if (heartbeatTimer) clearInterval(heartbeatTimer);
            if (!res.writableEnded) res.end();
        } else {
            res.status(500).json({ success: false, error: message });
        }
    }
});

app.post('/api/admin/forecast/backfill', async (req, res) => {
    let stores = Array.isArray(req.body?.storeNumbers)
        ? filterOwned(req.body.storeNumbers)
        : filterOwned([String(req.body?.storeNumber || '').trim()].filter(Boolean));
    if (!stores.length && req.body?.all) {
        stores = coachStores().map((s) => String(s.storeNumber));
    }
    if (!stores.length) {
        res.status(400).json({ success: false, error: 'storeNumber(s) required' });
        return;
    }
    // Always backfill 5 weeks of hourly sales history.
    // Stream NDJSON so the Forecast live log updates while MMX is scraping.
    const days = forecastRunner.BACKFILL_DAYS;
    const wantsStream = String(req.headers.accept || '').includes('application/x-ndjson')
        || req.body?.stream === true
        || req.query?.stream === '1';
    const actId = activity.start({
        kind: 'forecast-backfill',
        title: 'Forecast sales backfill',
        stores,
        storeNumber: stores.length === 1 ? stores[0] : '',
        detail: `${stores.length} store(s), ${days} day(s)…`,
        reports: ['Sales', 'MMX'],
    });

    if (!wantsStream) {
        try {
            const results = await forecastRunner.backfillStores(stores, days);
            const logs = results.flatMap((r) => r.logs || []);
            const ok = results.every((r) => r.ok);
            const imported = results.reduce((s, r) => s + (Number(r.imported) || 0), 0);
            activity.end(actId, {
                ok,
                detail: ok
                    ? `${imported} day(s) imported`
                    : 'Backfill finished with errors',
            });
            res.status(ok ? 200 : 207).json({
                success: ok,
                days,
                imported,
                message: ok
                    ? `Backfill finished - ${imported} day(s) imported across ${results.length} store(s).`
                    : 'Backfill finished with errors - check logs.',
                logs,
                results,
            });
        } catch (err) {
            activity.end(actId, { ok: false, error: err.message || String(err) });
            throw err;
        }
        return;
    }

    res.status(200);
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const writeEvent = (payload) => {
        try {
            res.write(`${JSON.stringify(payload)}\n`);
        } catch {
            /* client gone */
        }
    };
    writeEvent({
        type: 'log',
        message: `Backfill started for ${stores.length} store(s), ${days} day(s) each.`,
    });

    const results = [];
    try {
    for (const store of stores) {
        activity.update(actId, { storeNumber: store, detail: `Store ${store}…` });
        writeEvent({ type: 'log', message: `--- Store ${store} ---` });
        const result = await forecastRunner.backfillHistoryFromMmx(store, days, {
            onLog: (message) => {
                writeEvent({ type: 'log', message, storeNumber: store });
                activity.progress(actId, message);
            },
        });
        results.push(result);
        writeEvent({
            type: 'store-done',
            storeNumber: store,
            ok: Boolean(result.ok),
            imported: result.imported || 0,
            error: result.error || null,
        });
    }

    const ok = results.every((r) => r.ok);
    const imported = results.reduce((s, r) => s + (Number(r.imported) || 0), 0);
    const message = ok
        ? `Backfill finished - ${imported} day(s) imported across ${results.length} store(s).`
        : 'Backfill finished with errors - check logs.';
    activity.end(actId, {
        ok,
        detail: ok ? `${imported} day(s) imported` : 'Backfill finished with errors',
    });
    writeEvent({
        type: 'done',
        success: ok,
        days,
        imported,
        message,
        results: results.map((r) => ({
            storeNumber: r.storeNumber,
            ok: r.ok,
            imported: r.imported || 0,
            localDays: r.localDays,
            error: r.error || null,
        })),
    });
    res.end();
    } catch (err) {
        activity.end(actId, { ok: false, error: err.message || String(err) });
        writeEvent({ type: 'done', success: false, error: err.message || String(err) });
        res.end();
    }
});

app.get('/api/coach/session', (_req, res) => {
    res.json({ success: true, session: coachSession.maskSession() });
});

app.put('/api/coach/session', (req, res) => {
    try {
        const body = req.body || {};
        const session = coachSession.writeSession({
            userId: body.userId,
            displayName: body.displayName,
            region: body.region,
            enabledStores: body.enabledStores,
            alertEmail: body.alertEmail,
            downloadFolder: body.downloadFolder,
            mmx: body.mmx,
            lifelenz: body.lifelenz,
        });
        liveEvents.bump('coach.session', { userId: session.userId });
        res.json({ success: true, session });
    } catch (err) {
        res.status(400).json({ success: false, error: err.message || String(err) });
    }
});

app.delete('/api/coach/session', (_req, res) => {
    coachSession.clearSession();
    res.json({ success: true });
});

app.use((req, res) => {
    if (req.path.startsWith('/api/')) {
        res.status(404).json({ success: false, error: 'Not found.' });
        return;
    }
    res.status(404).send('Not found');
});

function startServer(listenPort = PORT) {
    return new Promise((resolve) => {
        const server = app.listen(listenPort, '0.0.0.0', () => {
            console.log(`[Area Coach Tools] listening on http://0.0.0.0:${listenPort}`);
            console.log(`[Area Coach Tools] Excel automation: ${buildToExcel.automationRoot()}`);
            console.log(`[Area Coach Tools] coach stores: ${coachStores().length}`);
            try {
                buildToExcel.ensureWorkbook();
                prepGuides.ensureTemplate();
                prepGuides.startFiveAmScheduler();
                const dailyRunner = require('../dashboard/src/dailyReports/areaCoachDailyRunner');
                dailyRunner.startDailyReportsScheduler(() => coachStores());
            } catch (err) {
                console.warn('[Area Coach Tools] init warn:', err.message);
            }
            resolve(server);
        });
    });
}

if (require.main === module) {
    startServer();
}

module.exports = { app, startServer, PORT };
