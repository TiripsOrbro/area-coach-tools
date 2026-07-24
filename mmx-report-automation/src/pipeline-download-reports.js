const path = require('path');
const fs = require('fs');
const { GOTO_OPTS } = require('./mmx-browser');
const { withPageContextRetry } = require('./mmx-context-retry');
const {
    ensureDir,
    waitForNewDownload,
    timestampSlug,
    clearMacromatixDefaultExports,
    fileSnapshots,
    isClaimedReportFile,
} = require('./util-files');
const { patchPageWaitForTimeout } = require('./util-delay');
const log = require('./util-logging');
const { navigateToSupplyChainReports } = require('./mmx-navigation');
const { runSupplyChainReport, isSupplyChainReport } = require('./pipeline-supply-chain-reports');
const { runStoreReport, isStoreReport } = require('./pipeline-store-reports');
const { loginMacromatix } = require('./mmx-auth');

const DOWNLOAD_EXTS = ['.xls', '.xlsx', '.csv'];

async function scrapeReportPageDiagnostics(page) {
    try {
        return await page.evaluate(() => {
            const chunks = [];
            for (const el of document.querySelectorAll(
                '.rgErr, .error, .ValidationSummary, [id*="ErrorLabel"], [id*="lblError"]'
            )) {
                const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
                if (t && t.length < 400) chunks.push(t);
            }
            const body = (document.body?.innerText || '').replace(/\s+/g, ' ');
            const m = body.match(/(?:error|failed|unable to|no data|timed out)[^.]{0,180}\./gi);
            if (m) chunks.push(...m.slice(0, 3));
            return [...new Set(chunks)].slice(0, 4).join(' | ') || '';
        });
    } catch {
        return '';
    }
}

async function openIsolatedWorkerPage(browser) {
    // Puppeteer 10: createIncognitoBrowserContext. Newer: createBrowserContext.
    const create =
        typeof browser.createBrowserContext === 'function'
            ? () => browser.createBrowserContext()
            : () => browser.createIncognitoBrowserContext();
    const context = await create();
    const workerPage = patchPageWaitForTimeout(await context.newPage());
    await workerPage.setViewport({ width: 1280, height: 720 }).catch(() => {});
    return { context, workerPage };
}

function reportsConcurrentEnabled() {
    return /^(1|true|yes|on)$/i.test(String(process.env.MMX_REPORTS_CONCURRENT ?? '0').trim());
}

function storeNumberFromReport(report) {
    return String(
        report?.storeNumber ||
            report?.scmTreeStoreNumber ||
            String(report?.storeName || '').match(/\b(\d{3,6})\b/)?.[1] ||
            ''
    ).replace(/\D/g, '');
}

function filterDownloadedScmReport(dest, report) {
    const storeNumber = storeNumberFromReport(report);
    if (!storeNumber || (report.id !== 'report1' && report.id !== 'report2')) return;
    try {
        const { filterSpreadsheetByStoreColumn } = require('../../vendors/src/reportReader');
        const filterResult = filterSpreadsheetByStoreColumn(dest, storeNumber, 2);
        if (filterResult.skipped) {
            log.warn(
                `${report.label || report.id}: no rows for store ${storeNumber} in ${path.basename(dest)}`
            );
        } else if (filterResult.removed) {
            log.info(
                `${report.label || report.id} filtered to store ${storeNumber}: ${filterResult.kept} row(s) kept, ${filterResult.removed} removed`
            );
        } else {
            log.info(
                `${report.label || report.id}: store ${storeNumber} filter OK (${filterResult.kept || 0} row(s))`
            );
        }
    } catch (err) {
        log.warn(`Could not filter ${report.id} to store ${storeNumber}: ${err.message}`);
    }
}

function reportsConfigured(reports) {
    return (reports || []).every((r) => {
        if (isSupplyChainReport(r) || isStoreReport(r)) return Boolean(r.reportName);
        return r.url && !r.url.includes('REPLACE');
    });
}

function getReportDownloadDir(settings) {
    return settings.reportDownloadDir || settings.downloadDir;
}

async function configureDownloadPath(page, downloadDir) {
    const abs = path.resolve(downloadDir);
    ensureDir(abs);
    const client = await page.target().createCDPSession();
    // Browser-level is last-writer-wins across tabs — callers must share one path when concurrent.
    try {
        await client.send('Browser.setDownloadBehavior', {
            behavior: 'allow',
            downloadPath: abs,
            eventsEnabled: true,
        });
    } catch {
        /* Page-level fallback below */
    }
    try {
        await client.send('Page.setDownloadBehavior', {
            behavior: 'allow',
            downloadPath: abs,
        });
    } catch {
        /* Browser-level may have been enough */
    }
}

async function clickExportExcelDataOnly(page, report) {
    if (report.exportButtonSelector) {
        await page.waitForSelector(report.exportButtonSelector, { timeout: 30000 });
        await page.click(report.exportButtonSelector);
        await page.waitForTimeout(400);
    }

    if (report.exportLinkText) {
        const clicked = await page.evaluate((text) => {
            const want = String(text).toLowerCase();
            for (const el of document.querySelectorAll('a, button, input, span')) {
                const label = (el.textContent || el.value || '').trim().toLowerCase();
                if (label.includes(want) || label === want) {
                    el.click();
                    return true;
                }
            }
            return false;
        }, report.exportLinkText);
        if (!clicked) {
            log.warn(`Export link "${report.exportLinkText}" not found; trying generic Excel link`);
            await page.evaluate(() => {
                for (const el of document.querySelectorAll('a')) {
                    const t = (el.textContent || '').toLowerCase();
                    if (t.includes('excel') && (t.includes('data') || t.includes('only'))) {
                        el.click();
                        return;
                    }
                }
            });
        }
    }
}

async function validateReportHeaders(filePath, expectedHeaders) {
    if (!expectedHeaders || !expectedHeaders.length) return;
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.xls') {
        log.info(`Skipping header validation for .xls (${path.basename(filePath)})`);
        return;
    }
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(filePath);
    const sheet = wb.worksheets[0];
    if (!sheet) throw new Error(`No sheet in ${filePath}`);
    const row = sheet.getRow(1);
    const headers = [];
    row.eachCell({ includeEmpty: true }, (cell, col) => {
        headers[col - 1] = String(cell.value || '').trim();
    });
    for (const h of expectedHeaders) {
        const found = headers.some((x) => x.toLowerCase() === String(h).toLowerCase());
        if (!found) {
            throw new Error(`Expected header "${h}" not found in ${path.basename(filePath)}. Got: ${headers.join(', ')}`);
        }
    }
}

async function waitForReportDownload(downloadDir, timeoutMs, preferredExt, opts = {}) {
    const order = preferredExt
        ? [preferredExt, ...DOWNLOAD_EXTS.filter((e) => e !== preferredExt)]
        : DOWNLOAD_EXTS;
    const budget = Math.max(15_000, Number(timeoutMs) || 120_000);
    const started = Date.now();
    let lastError = null;
    for (let i = 0; i < order.length; i++) {
        const ext = order[i];
        const elapsed = Date.now() - started;
        const remaining = budget - elapsed;
        if (remaining < 1500) break;
        // Keep almost all budget on the preferred extension — short fallbacks only.
        const attemptMs = i === 0 ? remaining : Math.min(6000, remaining);
        try {
            return await waitForNewDownload(downloadDir, {
                timeoutMs: attemptMs,
                ext,
                acceptSinceMs: opts.acceptSinceMs,
                beforeSnapshots: opts.beforeSnapshots?.[ext],
                reportId: opts.reportId,
                scanRoot: opts.scanRoot,
            });
        } catch (e) {
            lastError = e;
        }
    }
    let listing = '';
    try {
        listing = fs.existsSync(downloadDir)
            ? fs.readdirSync(downloadDir).join(', ') || '(empty)'
            : '(missing folder)';
    } catch {
        listing = '(unreadable)';
    }
    const primary = lastError?.message || 'No download received';
    throw new Error(`${primary} [dir: ${downloadDir}; files: ${listing}]`);
}

async function downloadSupplyChainReport(page, report, settings) {
    log.info(`Downloading: ${report.label || report.id} (${report.reportName})`);
    const downloadDir = getReportDownloadDir(settings);
    await configureDownloadPath(page, downloadDir);
    const cleared = clearMacromatixDefaultExports(downloadDir, report.id);
    if (cleared.length) {
        log.info(`Cleared prior Macromatix export(s): ${cleared.join(', ')}`);
    }
    const acceptSinceMs = Date.now();
    const beforeSnapshots = {
        '.xls': fileSnapshots(downloadDir, '.xls'),
        '.xlsx': fileSnapshots(downloadDir, '.xlsx'),
        '.csv': fileSnapshots(downloadDir, '.csv'),
    };
    const waitOpts = {
        acceptSinceMs,
        beforeSnapshots,
        reportId: report.id,
        scanRoot: settings.downloadScanRoot || path.dirname(downloadDir),
    };

    // Poll while Generate runs — cover long SCM configure + export.
    // Do NOT call configureDownloadPath after Generate (path switch cancels Edge downloads).
    const configureBufferMs = Number(process.env.MMX_REPORT_CONFIGURE_BUFFER_MS || 180000);
    const waitPromise = waitForReportDownload(
        downloadDir,
        (Number(settings.downloadWaitMs) || 120000) + configureBufferMs,
        report.downloadExt || '.xls',
        waitOpts
    );
    try {
        await runSupplyChainReport(page, report, settings);
    } catch (err) {
        waitPromise.catch(() => {});
        throw err;
    }

    let downloaded;
    try {
        downloaded = await waitPromise;
    } catch (err) {
        const diag = await scrapeReportPageDiagnostics(page);
        if (diag) log.error(`${report.id} page after Generate: ${diag}`);
        throw err;
    }
    if (isClaimedReportFile(downloaded)) {
        throw new Error(
            `Download waiter returned already-saved file ${path.basename(downloaded)} for ${report.id}`
        );
    }
    const ext = path.extname(downloaded) || report.downloadExt || '.xls';
    const slug = timestampSlug();
    const dest = path.join(downloadDir, `${slug}-${report.id || 'report'}${ext}`);
    if (downloaded !== dest) {
        fs.renameSync(downloaded, dest);
    }
    await validateReportHeaders(dest, report.expectedHeaders);
    filterDownloadedScmReport(dest, report);
    log.info(`Downloaded ${report.id} → ${path.basename(dest)}`);
    return dest;
}

async function downloadStoreReport(page, report, settings) {
    log.info(`Downloading: ${report.label || report.id} (${report.reportName})`);
    const downloadDir = getReportDownloadDir(settings);
    await configureDownloadPath(page, downloadDir);
    clearMacromatixDefaultExports(downloadDir, report.id);
    const acceptSinceMs = Date.now();
    const beforeSnapshots = {
        '.xls': fileSnapshots(downloadDir, '.xls'),
        '.xlsx': fileSnapshots(downloadDir, '.xlsx'),
        '.csv': fileSnapshots(downloadDir, '.csv'),
    };
    const waitOpts = {
        acceptSinceMs,
        beforeSnapshots,
        reportId: report.id,
        scanRoot: settings.downloadScanRoot || path.dirname(downloadDir),
    };

    const configureBufferMs = Number(process.env.MMX_REPORT_CONFIGURE_BUFFER_MS || 120000);
    const waitPromise = waitForReportDownload(
        downloadDir,
        (Number(settings.downloadWaitMs) || 120000) + configureBufferMs,
        report.downloadExt || '.csv',
        waitOpts
    );
    try {
        await runStoreReport(page, report, settings);
    } catch (err) {
        waitPromise.catch(() => {});
        throw err;
    }

    const downloaded = await waitPromise;
    if (isClaimedReportFile(downloaded)) {
        throw new Error(
            `Download waiter returned already-saved file ${path.basename(downloaded)} for ${report.id}`
        );
    }
    const ext = path.extname(downloaded) || report.downloadExt || '.csv';
    const slug = timestampSlug();
    const dest = path.join(downloadDir, `${slug}-${report.id || 'report'}${ext}`);
    if (downloaded !== dest) {
        fs.renameSync(downloaded, dest);
    }
    await validateReportHeaders(dest, report.expectedHeaders);
    log.info(`Downloaded ${report.id} → ${path.basename(dest)}`);
    return dest;
}

async function openReportsHub(page, settings) {
    const reportNav = settings.pipeline.reportNavigation;
    if (!reportNav) {
        throw new Error('Missing reportNavigation in config/pipeline.json');
    }
    await navigateToSupplyChainReports(page, reportNav, settings.navTimeoutMs);
}

async function downloadOneReport(page, report, settings) {
    if (isSupplyChainReport(report)) {
        return downloadSupplyChainReport(page, report, settings);
    }
    if (isStoreReport(report)) {
        return downloadStoreReport(page, report, settings);
    }
    if (!report.url || report.url.includes('REPLACE')) {
        throw new Error(`Report "${report.id || report.label}" URL not configured`);
    }

    log.info(`Downloading: ${report.label || report.id}`);
    const downloadDir = getReportDownloadDir(settings);
    await configureDownloadPath(page, downloadDir);
    clearMacromatixDefaultExports(downloadDir);
    const acceptSinceMs = Date.now();
    const beforeSnapshots = {
        '.xls': fileSnapshots(downloadDir, '.xls'),
        '.xlsx': fileSnapshots(downloadDir, '.xlsx'),
        '.csv': fileSnapshots(downloadDir, '.csv'),
    };

    await page.goto(report.url, { ...GOTO_OPTS, timeout: settings.navTimeoutMs });
    if (report.waitAfterNavigateMs) {
        await page.waitForTimeout(report.waitAfterNavigateMs);
    }

    await withPageContextRetry(page, `export ${report.id}`, async () => {
        await clickExportExcelDataOnly(page, report);
    });

    const downloaded = await waitForReportDownload(downloadDir, settings.downloadWaitMs, null, {
        acceptSinceMs,
        beforeSnapshots,
        reportId: report.id,
    });
    if (isClaimedReportFile(downloaded)) {
        throw new Error(
            `Download waiter returned already-saved file ${path.basename(downloaded)} for ${report.id}`
        );
    }
    const ext = path.extname(downloaded) || '.xlsx';
    const slug = timestampSlug();
    const dest = path.join(downloadDir, `${slug}-${report.id || 'report'}${ext}`);
    if (downloaded !== dest) {
        fs.renameSync(downloaded, dest);
    }
    await validateReportHeaders(dest, report.expectedHeaders);
    log.info(`Downloaded ${report.id} → ${path.basename(dest)}`);
    return dest;
}

async function downloadReportsSequential(page, settings, reports) {
    const paths = {};
    await configureDownloadPath(page, getReportDownloadDir(settings));
    for (const report of reports) {
        const reportDir = path.join(getReportDownloadDir(settings), String(report.id || 'report'));
        ensureDir(reportDir);
        paths[report.id] = await downloadOneReport(page, report, {
            ...settings,
            reportDownloadDir: reportDir,
            chainSession: undefined,
            chainReports: false,
        });
    }
    return paths;
}

async function downloadReportListOnPage(page, settings, reports, baseDir, { shared = false } = {}) {
    const paths = {};
    for (const report of reports) {
        const reportDir = shared ? baseDir : path.join(baseDir, String(report.id || 'report'));
        ensureDir(reportDir);
        paths[report.id] = await downloadOneReport(page, report, {
            ...settings,
            reportDownloadDir: reportDir,
            downloadScanRoot: settings.downloadScanRoot || baseDir,
            chainSession: undefined,
            chainReports: false,
        });
    }
    return paths;
}

/**
 * Parallelise safely:
 * - SCM Flat (SOH/SOO) stay sequential on one tab — two concurrent Generates fight Macromatix.
 * - Store reports (ISE) run on a second tab at the same time as the SCM chain.
 * - ISE MUST use an isolated browser context + its own login. A second tab in the same
 *   ASP.NET session corrupts report ViewState — Generate "succeeds" but no .xls is emitted.
 * - Both contexts share one CDP download directory (Browser.setDownloadBehavior is browser-wide).
 */
async function downloadReportsConcurrent(page, settings, reports) {
    const browser = typeof page.browser === 'function' ? page.browser() : null;
    if (!browser) {
        log.warn('No browser handle for concurrent downloads — falling back to sequential');
        return downloadReportsSequential(page, settings, reports);
    }

    const baseDir = getReportDownloadDir(settings);
    const sharedDir = path.join(baseDir, '_shared');
    ensureDir(sharedDir);
    await configureDownloadPath(page, sharedDir);
    log.info(`Concurrent CDP download path (shared): ${sharedDir}`);

    const scmReports = reports.filter((r) => isSupplyChainReport(r));
    const otherReports = reports.filter((r) => !isSupplyChainReport(r));
    const sharedSettings = { ...settings, downloadScanRoot: baseDir };

    if (!otherReports.length) {
        log.info('Only SCM reports — downloading sequentially (Macromatix cannot Generate two SCM exports at once)');
        return downloadReportListOnPage(page, sharedSettings, reports, sharedDir, { shared: true });
    }
    if (!scmReports.length) {
        return downloadReportListOnPage(page, sharedSettings, reports, sharedDir, { shared: true });
    }

    log.info(
        `Downloading in parallel: SCM [${scmReports.map((r) => r.id).join(', ')}] on main session; ` +
            `[${otherReports.map((r) => r.id).join(', ')}] on isolated session`
    );

    const scmTask = (async () => {
        try {
            return await downloadReportListOnPage(page, sharedSettings, scmReports, sharedDir, {
                shared: true,
            });
        } catch (err) {
            log.error(`SCM download chain failed: ${err.message || err}`);
            throw err;
        }
    })();

    const otherTask = (async () => {
        let context;
        let workerPage;
        try {
            ({ context, workerPage } = await openIsolatedWorkerPage(browser));
            await workerPage.waitForTimeout(Number(process.env.MMX_REPORTS_CONCURRENT_STAGGER_MS || 400));
            await configureDownloadPath(workerPage, sharedDir);
            log.info('ISE session: logging into Macromatix on isolated context…');
            await loginMacromatix(workerPage, {
                navTimeoutMs: settings.navTimeoutMs,
                loginWaitMs: settings.loginWaitMs,
                loginSuccessUrlPart: settings.loginSuccessUrlPart,
            });
            return await downloadReportListOnPage(workerPage, sharedSettings, otherReports, sharedDir, {
                shared: true,
            });
        } catch (err) {
            log.error(`Store-report download failed: ${err.message || err}`);
            throw err;
        } finally {
            await workerPage?.close().catch(() => {});
            await context?.close().catch(() => {});
        }
    })();

    // Wait for both — do not cancel the other tab when one fails mid-run.
    const settled = await Promise.allSettled([scmTask, otherTask]);
    const paths = {};
    const errors = [];
    for (const result of settled) {
        if (result.status === 'fulfilled') {
            Object.assign(paths, result.value);
        } else {
            errors.push(result.reason?.message || String(result.reason || 'download failed'));
        }
    }
    if (errors.length) {
        throw new Error(
            `Report download failed (${Object.keys(paths).join(', ') || 'none'} ok): ${errors.join(' | ')}`
        );
    }
    log.info(`Parallel downloads complete: ${Object.keys(paths).join(', ')}`);
    return paths;
}

async function downloadReports(page, settings) {
    const reports = (settings.pipeline.reports || []).filter((r) => !r.skip);

    if (!reports.length) {
        throw new Error('No reports configured in config/pipeline.json');
    }

    if (!reportsConfigured(reports)) {
        log.warn('Reports not fully configured — opening Report Selection only');
        await openReportsHub(page, settings);
        return {};
    }

    if (reportsConcurrentEnabled() && reports.length > 1) {
        return downloadReportsConcurrent(page, settings, reports);
    }
    return downloadReportsSequential(page, settings, reports);
}

module.exports = {
    downloadReports,
    openReportsHub,
    reportsConfigured,
    configureDownloadPath,
    reportsConcurrentEnabled,
};
