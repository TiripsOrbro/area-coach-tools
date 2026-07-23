const path = require('path');
const fs = require('fs');
const { getStoreList, getStoreConfig } = require('../../stores/src/storeList');
const { openMacromatixBrowser, closeBrowserQuietly } = require('./macromatixScraper');
const {
    downloadReports,
    configureDownloadPath,
    flushDeferredDownloadRenames,
    normalizeMacromatixExportsForStore,
} = require('./mmxReports/pipeline-download-reports');
const { isSupplyChainReport } = require('./mmxReports/pipeline-supply-chain-reports');
const { splitSpreadsheetByStoreColumn, resolveStoreReports } = require('../../vendors/src/reportReader');
const {
    ensureDir,
    timestampSlug,
    moveFileResilientSync,
    clearMacromatixDefaultExports,
} = require('./mmxReports/util-files');
const log = require('./mmxReports/util-logging');

/** One store's build-to download at a time — avoids Pi RAM/session contention across stores. */
let reportDownloadChain = Promise.resolve();

function withReportDownloadMutex(fn) {
    const run = reportDownloadChain.then(() => fn());
    reportDownloadChain = run.catch(() => {});
    return run;
}

const paths = require('../../src/paths');
const REPORTS_DIR = paths.vendors.reports;
const PIPELINE_PATH = path.join(paths.mmx.config, 'reports-pipeline.json');

const DEFAULT_OUTPUT_BASENAMES = {
    report1: 'stock-on-hand',
    report2: 'stock-on-order',
    report3: 'inventory-special-event',
};

function loadPipelineConfig() {
    if (!fs.existsSync(PIPELINE_PATH)) {
        throw new Error(
            'Missing config/reports-pipeline.json - copy from config/reports-pipeline.json.example or pull from git.'
        );
    }
    return JSON.parse(fs.readFileSync(PIPELINE_PATH, 'utf8'));
}

function storeSelectorLabel(store) {
    const num = String(store.storeNumber || '').trim();
    const name = String(store.storeName || '').trim();
    if (num && name) return `${num} ${name}`;
    return name || num;
}

function reportsForStore(pipeline, store, reportOverrides = {}) {
    const label = storeSelectorLabel(store);
    return (pipeline.reports || []).map((report) => {
        const scm = isSupplyChainReport(report);
        const override = reportOverrides[report.id] || {};
        return {
            ...report,
            ...override,
            storeNumber: store.storeNumber,
            storeName: label,
            // SCM: check the store row in RadTreeView (input.rtChk / span.rtIn) before Generate.
            scmTreeStoreNumber: scm ? store.storeNumber : undefined,
            skipStoreSelection: !scm,
            storeOptional: false,
            outputBasename: report.outputBasename || DEFAULT_OUTPUT_BASENAMES[report.id] || report.id,
        };
    });
}

function buildSettings(pipeline, storeDir, options = {}) {
    return {
        navTimeoutMs: Number(process.env.MMX_NAV_TIMEOUT_MS || 45000),
        downloadWaitMs: Number(process.env.MMX_DOWNLOAD_WAIT_MS || 120000),
        reportDownloadDir: storeDir,
        pipeline,
        chainReports: options.chainReports,
        resetReportHub: Boolean(options.resetReportHub),
        strictReports: Boolean(options.strictReports),
    };
}

function supplyChainReportsInRun(pipeline, onlyReportIds) {
    let reports = (pipeline.reports || []).filter(isSupplyChainReport);
    if (onlyReportIds.length) {
        reports = reports.filter((r) => onlyReportIds.includes(r.id));
    }
    return reports;
}

function useBulkSupplyChainDownload(stores, onlyReportIds, pipeline) {
    if (process.env.MMX_BULK_SCM === '0') return false;
    const scmReports = supplyChainReportsInRun(pipeline, onlyReportIds);
    if (!scmReports.length) return false;
    // Single/few stores: check RadTreeView checkbox per store (not bulk split).
    const minStores = Number(process.env.MMX_BULK_SCM_MIN_STORES || 2);
    if (stores.length < minStores) {
        log.info(`SCM per-store tree selection for ${stores.length} store(s)`);
        return false;
    }
    return true;
}

function bulkSupplyChainReports(pipeline, onlyReportIds) {
    return supplyChainReportsInRun(pipeline, onlyReportIds).map((report) => ({
        ...report,
        skipStoreSelection: true,
        storeName: undefined,
        storeNumber: undefined,
        outputBasename: report.outputBasename || DEFAULT_OUTPUT_BASENAMES[report.id] || report.id,
    }));
}

function scmPerStoreFallbackEnabled() {
    return process.env.MMX_SCM_FALLBACK_PER_STORE !== '0';
}

async function retryScmReportPerStore(page, pipeline, store, report, runSlug, storeDir) {
    const label = storeSelectorLabel(store);
    const scmReport = {
        ...report,
        skipStoreSelection: false,
        scmTreeStoreNumber: store.storeNumber,
        storeName: label,
        storeNumber: store.storeNumber,
        outputBasename: report.outputBasename || DEFAULT_OUTPUT_BASENAMES[report.id] || report.id,
    };
    const storePipeline = {
        reportNavigation: pipeline.reportNavigation,
        reports: [scmReport],
    };
    const settings = buildSettings(storePipeline, storeDir);
    await configureDownloadPath(page, storeDir);
    const paths = await downloadReports(page, settings);
    let dest = paths[report.id];
    if (!dest) return null;

    const ext = path.extname(dest);
    const basename = scmReport.outputBasename;
    const target = path.join(storeDir, `${runSlug}-${basename}${ext}`);
    if (path.basename(dest) !== path.basename(target)) {
        if (fs.existsSync(target)) fs.unlinkSync(target);
        moveFileResilientSync(dest, target);
        dest = target;
    }
    return dest;
}

/**
 * Download a store's reports, then retry the missing ones once in the same session
 * instead of just logging and moving on. Set MMX_STORE_DOWNLOAD_RETRY=0 to disable.
 */
async function downloadStoreReportsWithRetry(page, store, reports, settings, results, ctx) {
    const entry = results.stores[store.storeNumber];
    const wantIds = reports.map((r) => r.id);

    let firstError = null;
    try {
        const paths = await downloadReports(page, settings);
        entry.files = { ...entry.files, ...paths };
    } catch (err) {
        firstError = err;
    }

    const missing = wantIds.filter((id) => !entry.files[id] || !fs.existsSync(entry.files[id]));
    if (!missing.length) return;

    if (process.env.MMX_STORE_DOWNLOAD_RETRY === '0') {
        if (firstError) throw firstError;
        throw new Error(`Store ${store.storeNumber}: reports ${missing.join(', ')} not downloaded`);
    }

    log.warn(
        `Store ${store.storeNumber}: report(s) ${missing.join(', ')} missing after first pass` +
            (firstError ? ` (${firstError.message})` : '') +
            ' - retrying once'
    );

    const retryReports = reports.filter((r) => missing.includes(r.id));
    const retryPipeline = {
        reportNavigation: ctx.pipeline.reportNavigation,
        reports: retryReports,
    };
    const retrySettings = buildSettings(retryPipeline, ctx.storeDir, {
        ...ctx.buildSettingsOptions,
        resetReportHub: true,
    });
    if (typeof ctx.buildSettingsOptions?.onReportStep === 'function') {
        retrySettings.onReportStep = ctx.buildSettingsOptions.onReportStep;
    }

    const retryPaths = await downloadReports(page, retrySettings);
    entry.files = { ...entry.files, ...retryPaths };

    const stillMissing = missing.filter((id) => !entry.files[id] || !fs.existsSync(entry.files[id]));
    if (stillMissing.length) {
        throw (
            firstError ||
            new Error(`Store ${store.storeNumber}: reports ${stillMissing.join(', ')} not downloaded after retry`)
        );
    }
    log.info(`Store ${store.storeNumber}: retry recovered ${missing.filter((id) => entry.files[id]).join(', ')}`);
}

function finalizeStoreResults(results, stores, options = {}) {
    if (options.skipIseHistoryCapture) return;
    const invalidStores = [];
    for (const store of stores) {
        const entry = results.stores[store.storeNumber];
        const files = resolveStoreReports(store.storeNumber, REPORTS_DIR);
        const validation = require('../../vendors/src/reportReader').validateStoreReports(store.storeNumber, files);
        if (!validation.valid) {
            entry.success = false;
            entry.missingReports = validation.issues;
            log.error(`Store ${store.storeNumber}: ${validation.issues.join('; ')}`);
            invalidStores.push({ storeNumber: store.storeNumber, issues: validation.issues });
        }
        try {
            const isePath = files.inventorySpecialEvent;
            if (isePath && require('fs').existsSync(isePath)) {
                const { recordIseSnapshotFromFile, addDaysToIso, melbourneTodayIso } = require('../../dashboard/src/reportSubscriptions/iseHistoryLedger');
                recordIseSnapshotFromFile(store.storeNumber, isePath, {
                    date: addDaysToIso(melbourneTodayIso(), -1),
                });
            }
        } catch (err) {
            log.warn(`Store ${store.storeNumber}: ISE history capture failed: ${err.message}`);
        }
    }
    if (options.strictReports && invalidStores.length) {
        const summary = invalidStores
            .map((row) => `Store ${row.storeNumber}: ${row.issues.join('; ')}`)
            .join(' | ');
        throw new Error(summary);
    }
}

/**
 * Log into Macromatix and download the three build-to reports for each store in `.storelist`.
 * Full multi-store runs download on-hand + on-order once, then split by store column.
 * SCM flat reports skip MMX store tree; scope is applied via bulk split or post-download filter.
 * Files land in `Reports/{storeNumber}/` with timestamped names.
 */
async function downloadReportsForStores(options = {}) {
    const pipeline = loadPipelineConfig();
    const onlyReportIds = Array.isArray(options.onlyReportIds)
        ? options.onlyReportIds
        : String(options.onlyReports || '')
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean);
    let stores = getStoreList();
    if (!stores.length) {
        throw new Error('No stores in .storelist - add stores before downloading reports.');
    }

    const only = String(options.storeNumber || '').trim();
    const onlyNumbers = Array.isArray(options.storeNumbers)
        ? options.storeNumbers.map((s) => String(s).trim()).filter(Boolean)
        : String(options.storeNumbers || '')
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean);

    if (onlyNumbers.length) {
        stores = stores.filter((s) => onlyNumbers.includes(s.storeNumber));
        for (const num of onlyNumbers) {
            if (!stores.some((s) => s.storeNumber === num)) {
                const cfg = getStoreConfig(num);
                if (cfg) stores.push(cfg);
            }
        }
        stores = [...new Map(stores.map((s) => [s.storeNumber, s])).values()];
        if (!stores.length) {
            throw new Error(`No matching stores in .storelist for: ${onlyNumbers.join(', ')}`);
        }
    } else if (only) {
        stores = stores.filter((s) => s.storeNumber === only);
        if (!stores.length) {
            const cfg = getStoreConfig(only);
            if (cfg) stores = [cfg];
            else throw new Error(`Store ${only} not found in .storelist`);
        }
    }

    const runSlug = timestampSlug();
    const reportOverrides = options.reportOverrides && typeof options.reportOverrides === 'object'
        ? options.reportOverrides
        : {};
    const results = { runSlug, reportsDir: REPORTS_DIR, bulkSupplyChain: false, stores: {} };
    const storeNumbers = stores.map((s) => s.storeNumber);
    const useBulk = useBulkSupplyChainDownload(stores, onlyReportIds, pipeline);

    for (const store of stores) {
        results.stores[store.storeNumber] = { success: true, files: {} };
    }

    let browser = options.browser || null;
    let ownsBrowser = false;
    let page = options.page || null;

    try {
        if (!page) {
            const session = await openMacromatixBrowser(options);
            browser = session.browser;
            page = session.page;
            ownsBrowser = true;
        }

        if (useBulk) {
            results.bulkSupplyChain = true;
            const bulkDir = path.join(REPORTS_DIR, '_bulk');
            ensureDir(bulkDir);

            const bulkReports = bulkSupplyChainReports(pipeline, onlyReportIds);
            const bulkPipeline = {
                reportNavigation: pipeline.reportNavigation,
                reports: bulkReports,
            };
            const bulkSettings = buildSettings(bulkPipeline, bulkDir);

            log.info(
                `Bulk supply-chain download (${bulkReports.map((r) => r.id).join(', ')}) for ${stores.length} stores`
            );

            await configureDownloadPath(page, bulkDir);
            const bulkPaths = await downloadReports(page, bulkSettings);
            const bulkSplitMisses = [];

            for (const report of bulkReports) {
                const sourcePath = bulkPaths[report.id];
                if (!sourcePath) continue;

                const split = splitSpreadsheetByStoreColumn(sourcePath, {
                    colIndex: 2,
                    storeNumbers,
                    runSlug,
                    outputBasename: report.outputBasename,
                    reportsRoot: REPORTS_DIR,
                });

                log.info(
                    `${report.label || report.id}: split ${split.totalRows} row(s) → ${Object.keys(split.stores).length} store file(s)` +
                        (split.storeColumnIndex != null ? ` (store column ${split.storeColumnIndex})` : '')
                );

                for (const [storeNum, info] of Object.entries(split.stores)) {
                    if (!results.stores[storeNum]) continue;
                    results.stores[storeNum].files[report.id] = info.path;
                    log.info(`  store ${storeNum}: ${info.kept} row(s) → ${path.basename(info.path)}`);
                }

                for (const storeNum of storeNumbers) {
                    if (!split.stores[storeNum]) {
                        bulkSplitMisses.push({ report, storeNum });
                        const inFile = (split.storesInFile || []).join(', ') || 'none';
                        const samples = (split.sampleRows || []).map((s) => `  ${s}`).join('\n');
                        const bulkFilterHint =
                            split.totalRows > 0 && split.totalRows < 300
                                ? '\n  Hint: Export looks area-filtered (~100 rows). Per-store SCM fallback will run when enabled.'
                                : '';
                        log.warn(
                            `${report.label || report.id}: no rows for store ${storeNum} in bulk export (stores in file: ${inFile})` +
                                (samples ? `\n${samples}` : '') +
                                bulkFilterHint
                        );
                    }
                }
            }

            if (scmPerStoreFallbackEnabled() && bulkSplitMisses.length) {
                for (const { report, storeNum } of bulkSplitMisses) {
                    if (results.stores[storeNum]?.files[report.id]) continue;
                    const store = stores.find((s) => s.storeNumber === storeNum);
                    if (!store) continue;

                    log.info(
                        `Bulk split missed store ${storeNum} - retrying ${report.label || report.id} with per-store selection`
                    );
                    const storeDir = path.join(REPORTS_DIR, storeNum);
                    ensureDir(storeDir);
                    try {
                        const dest = await retryScmReportPerStore(
                            page,
                            pipeline,
                            store,
                            report,
                            runSlug,
                            storeDir
                        );
                        if (dest) {
                            results.stores[storeNum].files[report.id] = dest;
                            log.info(`  store ${storeNum}: per-store SCM → ${path.basename(dest)}`);
                        }
                    } catch (err) {
                        log.error(`Per-store SCM fallback for ${storeNum} ${report.id}:`, err.message);
                    }
                }
            }
        }

        for (const store of stores) {
            const storeDir =
                options.reportDownloadDir || path.join(REPORTS_DIR, store.storeNumber);
            ensureDir(storeDir);

            let reports = reportsForStore(pipeline, store, reportOverrides);
            if (onlyReportIds.length) {
                reports = reports.filter((r) => onlyReportIds.includes(r.id));
            }
            if (useBulk) {
                reports = reports.filter((r) => !isSupplyChainReport(r));
            }
            if (!reports.length) continue;

            const storePipeline = {
                reportNavigation: pipeline.reportNavigation,
                reports,
            };
            const settings = buildSettings(storePipeline, storeDir, {
                chainReports: options.chainReports,
                resetReportHub: options.resetReportHub,
                strictReports: options.strictReports,
            });
            if (typeof options.onReportStep === 'function') {
                settings.onReportStep = options.onReportStep;
            }

            log.info(`Store ${store.storeNumber} (${store.storeName}) → ${storeDir}`);

            try {
                await configureDownloadPath(page, storeDir);
                await downloadStoreReportsWithRetry(page, store, reports, settings, results, {
                    pipeline,
                    storeDir,
                    buildSettingsOptions: {
                        chainReports: options.chainReports,
                        resetReportHub: options.resetReportHub,
                        strictReports: options.strictReports,
                        onReportStep: settings.onReportStep,
                    },
                });
            } catch (err) {
                log.error(`Store ${store.storeNumber} failed:`, err.message);
                results.stores[store.storeNumber].success = false;
                results.stores[store.storeNumber].error = err.message;
                if (options.strictReports) throw err;
            }
        }
    } finally {
        if (ownsBrowser) {
            await closeBrowserQuietly(browser, 'report download');
        }
    }

    finalizeStoreResults(results, stores, options);
    return results;
}

function parallelReportDownloadEnabled(options = {}) {
    if (options.parallelReportDownload === false) return false;
    if (process.env.MMX_PARALLEL_BUILD_TO_REPORTS === '0') return false;
    // Concurrent download (one browser per report) is the default for build-to.
    // Single-report passes naturally fall back to one browser (no concurrency to gain).
    // Set MMX_PARALLEL_BUILD_TO_REPORTS=0 to force the legacy sequential single-browser path.
    return true;
}

const CHAINED_SCM_REPORT_IDS = new Set(['report1', 'report2']);

function partitionParallelReportIds(onlyReportIds) {
    const scm = onlyReportIds.filter((id) => CHAINED_SCM_REPORT_IDS.has(id));
    const rest = onlyReportIds.filter((id) => !CHAINED_SCM_REPORT_IDS.has(id));
    return { scm, rest };
}

/**
 * SOH + SOO share one Macromatix session (store tree + Report Selection). Running them in
 * separate parallel browsers often breaks the SCM tree on the Pi (same login, context loss).
 */
async function downloadChainedScmBuildToReportsForStore(store, reportIds, options = {}) {
    const pipeline = loadPipelineConfig();
    const order = ['report1', 'report2'];
    const ids = [...reportIds].sort((a, b) => order.indexOf(a) - order.indexOf(b));
    const allReports = reportsForStore(pipeline, store).filter((r) => ids.includes(r.id));
    if (!allReports.length) return {};

    const mainDir = path.join(REPORTS_DIR, store.storeNumber);
    const scmWorkDir = path.join(mainDir, '_parallel', '_scm');
    ensureDir(scmWorkDir);

    log.info(
        `[parallel] Store ${store.storeNumber}: one browser for chained SCM (${ids.join(', ')})`
    );

    let browser;
    let page;
    const files = {};
    const chainSession = {
        hubOpen: false,
        lastGroup: null,
        lastFormat: null,
        lastStartDate: null,
        lastEndDate: null,
    };

    try {
        ({ browser, page } = await openMacromatixBrowser({ ...options, storeNumber: store.storeNumber }));
        await configureDownloadPath(page, scmWorkDir);

        for (let i = 0; i < ids.length; i++) {
            const reportId = ids[i];
            const report = allReports.find((r) => r.id === reportId);
            if (!report) continue;

            const label = report.label || reportId;
            const reportDir = path.join(mainDir, '_parallel', reportId);
            ensureDir(reportDir);

            if (i === 0) {
                const cleared = clearMacromatixDefaultExports(scmWorkDir);
                if (cleared.length) {
                    log.info(
                        `[parallel] Store ${store.storeNumber} SCM: cleared ${cleared.length} stale export file(s)`
                    );
                }
            } else {
                // Drop any leftover MMS default export name before the next generate.
                clearMacromatixDefaultExports(scmWorkDir);
            }

            const storePipeline = {
                reportNavigation: pipeline.reportNavigation,
                reports: [report],
            };
            const settings = buildSettings(storePipeline, scmWorkDir);
            settings.downloadWaitMs = Number(report.downloadWaitMs || settings.downloadWaitMs);
            settings.chainReports = i > 0;
            settings.chainSession = chainSession;
            settings.deferDownloadRename = false;
            if (typeof options.onReportStep === 'function') {
                settings.onReportStep = (step) => options.onReportStep(reportId, step);
            }

            log.info(
                `[parallel] Store ${store.storeNumber}: SCM step ${i + 1}/${ids.length} — ${label}`
            );
            const paths = await downloadReports(page, settings);
            let filePath = paths[reportId];

            if (!filePath || !fs.existsSync(filePath)) {
                const adopted = normalizeMacromatixExportsForStore(scmWorkDir, [reportId], {
                    storeNumber: store.storeNumber,
                    maxAgeMs: Number(process.env.MMX_PARALLEL_RECOVERY_AGE_MS || 15 * 60 * 1000),
                });
                filePath = adopted[reportId] || filePath;
            }

            if (!filePath || !fs.existsSync(filePath)) {
                throw new Error(`${label} did not produce a file in ${scmWorkDir}`);
            }

            const dest = path.join(reportDir, path.basename(filePath));
            if (path.resolve(filePath) !== path.resolve(dest)) {
                if (fs.existsSync(dest)) fs.unlinkSync(dest);
                moveFileResilientSync(filePath, dest);
                filePath = dest;
            }
            files[reportId] = filePath;
            log.info(`[parallel] Store ${store.storeNumber}: ${label} → ${path.basename(filePath)}`);
        }
    } finally {
        await closeBrowserQuietly(browser, 'chained SCM');
    }
    return files;
}

async function downloadOneBuildToReportForStore(store, reportId, options = {}) {
    const pipeline = loadPipelineConfig();
    const reports = reportsForStore(pipeline, store).filter((r) => r.id === reportId);
    if (!reports.length) {
        throw new Error(`Report ${reportId} is not configured in reports-pipeline.json`);
    }

    const report = reports[0];
    const storeDir =
        options.reportDownloadDir || path.join(REPORTS_DIR, store.storeNumber, '_parallel', reportId);
    ensureDir(storeDir);
    const cleared = clearMacromatixDefaultExports(storeDir);
    if (cleared.length) {
        log.info(
            `[parallel] Store ${store.storeNumber} ${reportId}: cleared ${cleared.length} stale export file(s) in ${storeDir}`
        );
    }

    const label = report.label || reportId;
    let browser;
    let page;
    let settings;
    try {
        log.info(`[parallel] Store ${store.storeNumber}: opening browser for ${label}`);
        ({ browser, page } = await openMacromatixBrowser({ ...options, storeNumber: store.storeNumber }));
        const storePipeline = {
            reportNavigation: pipeline.reportNavigation,
            reports,
        };
        settings = buildSettings(storePipeline, storeDir);
        settings.downloadWaitMs = Number(report.downloadWaitMs || settings.downloadWaitMs);
        settings.chainReports = false;
        settings.deferDownloadRename = true;
        if (typeof options.onReportStep === 'function') {
            settings.onReportStep = (step) => options.onReportStep(reportId, step);
        }
        await configureDownloadPath(page, storeDir);
        const paths = await downloadReports(page, settings);
        let filePath = paths[reportId];

        // Rename while the browser still holds the download session — closing Chromium first
        // often leaves MMS_Report_*.xls locked or missing on Windows (EBUSY / "did not produce a file").
        if (settings?.pendingDownloadRenames?.length) {
            const adopted = await flushDeferredDownloadRenames(settings);
            filePath = adopted[reportId] || filePath;
        }

        if (!filePath || !fs.existsSync(filePath)) {
            const adopted = normalizeMacromatixExportsForStore(storeDir, [reportId], {
                storeNumber: store.storeNumber,
                maxAgeMs: Number(process.env.MMX_PARALLEL_RECOVERY_AGE_MS || 15 * 60 * 1000),
            });
            filePath = adopted[reportId] || filePath;
        }

        if (!filePath || !fs.existsSync(filePath)) {
            throw new Error(`${label} did not produce a file in ${storeDir}`);
        }
        return { reportId, filePath, storeDir, storeNumber: store.storeNumber, label };
    } finally {
        await closeBrowserQuietly(browser, `parallel ${reportId}`);
    }
}

async function finalizeParallelDownloadResult(result) {
    const { reportId, storeDir, storeNumber, label, filePath } = result;
    if (!filePath || !fs.existsSync(filePath)) {
        throw new Error(`${label || reportId} did not produce a file in ${storeDir}`);
    }
    log.info(`[parallel] Store ${storeNumber || '?'}: ${label || reportId} → ${path.basename(filePath)}`);
    return { reportId, filePath, storeDir };
}

function promoteParallelFile(mainDir, filePath) {
    if (!filePath || !fs.existsSync(filePath)) return null;
    ensureDir(mainDir);
    const dest = path.join(mainDir, path.basename(filePath));
    if (path.resolve(filePath) === path.resolve(dest)) return dest;
    if (fs.existsSync(dest)) fs.unlinkSync(dest);
    moveFileResilientSync(filePath, dest);
    return dest;
}

/**
 * Download build-to reports: SCM (SOH+SOO) chained in one browser, ISE in a second when needed.
 * Avoids three concurrent Macromatix logins fighting over the SCM store tree.
 */
async function downloadBuildToReportsParallel(storeNumber, options = {}) {
    return withReportDownloadMutex(() => downloadBuildToReportsParallelWork(storeNumber, options));
}

async function downloadBuildToReportsParallelWork(storeNumber, options = {}) {
    const num = String(storeNumber).replace(/\D/g, '');
    const cfg = getStoreConfig(num);
    const store = cfg || { storeNumber: num, storeName: num };
    const onlyReportIds = Array.isArray(options.onlyReportIds) && options.onlyReportIds.length
        ? options.onlyReportIds
        : ['report1', 'report2', 'report3'];

    const mainDir = path.join(REPORTS_DIR, num);
    ensureDir(mainDir);

    const { scm, rest } = partitionParallelReportIds(onlyReportIds);
    const browserCount = (scm.length ? 1 : 0) + rest.length;
    log.info(
        `Store ${num}: parallel build-to download — ${browserCount} browser(s) for ${onlyReportIds.join(', ')}` +
            (scm.length ? ` (SCM chained: ${scm.join(', ')})` : '')
    );

    const files = {};
    const errors = [];

    const scmTask =
        scm.length > 0
            ? downloadChainedScmBuildToReportsForStore(store, scm, options)
                  .then((scmFiles) => {
                      for (const [reportId, filePath] of Object.entries(scmFiles)) {
                          const promoted = promoteParallelFile(mainDir, filePath);
                          if (promoted) files[reportId] = promoted;
                      }
                  })
                  .catch((err) => {
                      errors.push(`SCM (${scm.join(', ')}): ${err.message || err}`);
                  })
            : Promise.resolve();

    const restTasks = rest.map((reportId) => {
        const workDir = path.join(mainDir, '_parallel', reportId);
        ensureDir(workDir);
        return downloadOneBuildToReportForStore(store, reportId, {
            ...options,
            reportDownloadDir: workDir,
        })
            .then(finalizeParallelDownloadResult)
            .then((result) => {
                const promoted = promoteParallelFile(mainDir, result.filePath);
                if (promoted) files[reportId] = promoted;
            })
            .catch((err) => {
                errors.push(`${reportId}: ${err.message || err}`);
            });
    });

    await Promise.all([scmTask, ...restTasks]);

    if (errors.length) {
        throw new Error(`Parallel report download failed for store ${num}: ${errors.join('; ')}`);
    }

    return { storeNumber: num, files, reportsDir: mainDir, parallel: true };
}

module.exports = {
    downloadReportsForStores,
    downloadBuildToReportsParallel,
    downloadOneBuildToReportForStore,
    loadPipelineConfig,
    REPORTS_DIR,
    DEFAULT_OUTPUT_BASENAMES,
    parallelReportDownloadEnabled,
};
