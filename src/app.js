const { loadEnv } = require('./loadEnv');
loadEnv();

const path = require('path');
const express = require('express');
const compression = require('compression');
const paths = require('./paths');
const liveEvents = require('./liveEvents');
const adminLiveLogs = require('./adminLiveLogs');
const buildToExcel = require('./buildToExcel');
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

// Daily reports — stock (five-am) + forecast auto-submit dual toggles
app.get('/api/admin/five-am-reports/stores', (_req, res) => {
    const listed = coachStores();
    const status =
        typeof fiveAm.buildStatus === 'function'
            ? fiveAm.buildStatus(listed.map((s) => s.storeNumber))
            : { stores: {}, lastRun: {}, lastRunAt: {} };
    res.json({
        success: true,
        ...status,
        storeList: listed.map((s) => {
            const storeNumber = String(s.storeNumber);
            const fc = forecastRunner.storeStatusSummary(storeNumber);
            return {
                storeNumber,
                storeName: s.storeName,
                stockEnabled: fiveAm.isStoreEnabled(storeNumber),
                forecastEnabled: forecastConfig.isAutoSubmitEnabled(storeNumber),
                lastStockRun: status.lastRun?.[storeNumber] || status.lastRunAt?.[storeNumber] || null,
                lastForecastAt: fc.lastForecastAt || null,
            };
        }),
    });
});

app.put('/api/admin/five-am-reports/stores', (req, res) => {
    const updates = Array.isArray(req.body?.stores) ? req.body.stores : [];
    for (const row of updates) {
        const store = String(row?.storeNumber || '').trim();
        if (!store || !coachOwnsStore(store)) continue;
        if (row.stockEnabled != null || row.enabled != null) {
            fiveAm.setStoreEnabled(store, Boolean(row.stockEnabled ?? row.enabled), 'area-coach-tools');
        }
        if (row.forecastEnabled != null) {
            forecastConfig.setAutoSubmit(store, Boolean(row.forecastEnabled));
        }
    }
    res.json({ success: true });
    liveEvents.bump('daily-reports.updated');
});

app.post('/api/admin/daily-reports/run', async (req, res) => {
    try {
        const orchestrator = require('../dashboard/src/dailyReports/dailyReportsOrchestrator');
        if (typeof orchestrator.runDailyReports !== 'function') {
            res.status(501).json({ success: false, error: 'Daily reports orchestrator not available.' });
            return;
        }
        let storeNumbers = Array.isArray(req.body?.storeNumbers)
            ? filterOwned(req.body.storeNumbers)
            : coachStores().map((s) => String(s.storeNumber));
        const result = await orchestrator.runDailyReports({
            reason: 'manual',
            storeNumbers,
        });
        res.json({ success: true, result });
    } catch (err) {
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
app.get('/api/admin/prep-guides', (_req, res) => {
    res.json({
        success: true,
        weekdays: prepGuides.WEEKDAYS,
        stores: prepGuides.listStoreStatus(coachStores().map((s) => s.storeNumber)),
        template: prepGuides.ensureTemplate(),
    });
});

app.post('/api/admin/prep-guides/regenerate', async (req, res) => {
    const store = String(req.body?.storeNumber || '').trim();
    if (!store) {
        res.status(400).json({ success: false, error: 'storeNumber required' });
        return;
    }
    if (!assertOwns(store, res)) return;
    try {
        const meta = await prepGuides.regenerateStore(store);
        res.json({ success: true, meta });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message || String(err) });
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

app.post('/api/admin/build-to/open', async (_req, res) => {
    const result = await buildToExcel.openWorkbook();
    res.status(result.ok ? 200 : 500).json({ success: result.ok, ...result });
});

app.post('/api/admin/build-to/run', async (req, res) => {
    if (buildToExcel.isRunning()) {
        res.status(409).json({ success: false, error: 'Build-to run already in progress.' });
        return;
    }
    const mode = String(req.body?.mode || 'reports').toLowerCase() === 'orders' ? 'orders' : 'reports';
    let stores = [];
    if (Array.isArray(req.body?.storeNumbers) && req.body.storeNumbers.length) {
        stores = filterOwned(req.body.storeNumbers).map((n) => {
            const row = coachStores().find((s) => String(s.storeNumber) === String(n));
            return { storeNumber: n, storeName: row?.storeName || '' };
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
        stores = coachStores().map((s) => ({
            storeNumber: String(s.storeNumber),
            storeName: s.storeName || '',
        }));
    }
    if (!stores.length) {
        res.status(400).json({ success: false, error: 'No stores in coach scope.' });
        return;
    }
    const result = await buildToExcel.runExcelBuildTo({ mode, stores });
    res.status(result.ok ? 200 : 500).json({ success: result.ok, ...result });
    liveEvents.bump('build-to.updated');
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
    try {
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
        const results = await forecastRunner.runForecastForStores(stores, {
            mmx: req.body?.mmx !== false,
            lifelenz: req.body?.lifelenz !== false,
            weeks: forecastRunner.SUBMIT_WEEKS,
        });
        res.json({ success: true, results });
        liveEvents.bump('forecast.updated');
    } catch (err) {
        res.status(500).json({ success: false, error: err.message || String(err) });
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
    // Always backfill 5 weeks of hourly sales history
    const days = forecastRunner.BACKFILL_DAYS;
    const results = await forecastRunner.backfillStores(stores, days);
    const logs = results.flatMap((r) => r.logs || []);
    const ok = results.every((r) => r.ok);
    const imported = results.reduce((s, r) => s + (Number(r.imported) || 0), 0);
    res.status(ok ? 200 : 207).json({
        success: ok,
        days,
        imported,
        message: ok
            ? `Backfill finished — ${imported} day(s) imported across ${results.length} store(s).`
            : `Backfill finished with errors — check logs.`,
        logs,
        results,
    });
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
