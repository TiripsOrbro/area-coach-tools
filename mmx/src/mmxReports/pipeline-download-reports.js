const path = require('path');
const fs = require('fs');
const { GOTO_OPTS } = require('./mmx-browser');
const { withPageContextRetry } = require('./mmx-context-retry');
const { ensureDir, waitForNewDownload, timestampSlug, clearMacromatixDefaultExports, moveFileResilient, moveFileResilientSync } = require('./util-files');
const log = require('./util-logging');
const { navigateToSupplyChainReports } = require('./mmx-navigation');
const { refreshScrapePauseTimeout } = require('../mmxResourceGate');
const { runSupplyChainReport, isSupplyChainReport } = require('./pipeline-supply-chain-reports');
const { runStoreReport, isStoreReport } = require('./pipeline-store-reports');
const {
    filterSpreadsheetByStoreColumn,
    logIseSpotCheck,
    parseStockOnHand,
    parseStockOnOrder,
    parseInventorySpecialEventFile,
} = require('../../../vendors/src/reportReader');

const DOWNLOAD_EXTS = ['.xls', '.xlsx', '.csv'];

const DOWNLOAD_ATTEMPT_SUBDIR = '_dl';

function downloadAttemptCount() {
    return Math.max(1, Number(process.env.MMX_REPORT_DOWNLOAD_ATTEMPTS || 2));
}

/**
 * Fresh empty folder per generate attempt: any file Chromium saves there IS the
 * requested report, so no newest-file/regex guessing is needed on the primary path.
 */
function createDownloadAttemptDir(baseDir, reportId, attempt) {
    const dir = path.join(baseDir, DOWNLOAD_ATTEMPT_SUBDIR, `${reportId || 'report'}-a${attempt}-${Date.now()}`);
    fs.rmSync(dir, { recursive: true, force: true });
    ensureDir(dir);
    return dir;
}

function removeDownloadAttemptDir(dir) {
    try {
        fs.rmSync(dir, { recursive: true, force: true });
    } catch {
        /* best effort - stale attempt dirs are swept on the next run */
    }
}

/** Remove leftover attempt folders from earlier runs so they can't feed stale files to fallbacks. */
function sweepStaleDownloadAttemptDirs(baseDir) {
    const root = path.join(baseDir, DOWNLOAD_ATTEMPT_SUBDIR);
    try {
        fs.rmSync(root, { recursive: true, force: true });
    } catch {
        /* ignore */
    }
}

/** Browser/page death is not recoverable by re-running the report config on the same page. */
function isRetryableDownloadError(err) {
    const msg = String(err?.message || err || '');
    return !/Target closed|Session closed|Protocol error|browser has disconnected|detached Frame/i.test(msg);
}

const MMX_DEFAULT_EXPORT_HINTS = {
    report1: { needle: /2_All|On.?Hand/i, ext: '.xls', nameRe: /^MMS_Report_/i },
    report2: { needle: /OnOrder/i, ext: '.xls', nameRe: /^MMS_Report_/i },
    report3: { needle: /InventorySpecialEvent|SpecialEvent/i, ext: '.csv', nameRe: /^InventorySpecialEvent/i },
};

function findFreshMacromatixExport(downloadDir, report, sinceMs) {
    const hint = MMX_DEFAULT_EXPORT_HINTS[report?.id];
    if (!hint || !fs.existsSync(downloadDir)) return null;
    const nameRe = hint.nameRe || /^MMS_Report_/i;
    let best = null;
    for (const name of fs.readdirSync(downloadDir)) {
        if (!nameRe.test(name)) continue;
        if (!hint.needle.test(name)) continue;
        const ext = path.extname(name).toLowerCase();
        if (ext !== hint.ext) continue;
        const filePath = path.join(downloadDir, name);
        let stat;
        try {
            stat = fs.statSync(filePath);
        } catch {
            continue;
        }
        if (!stat.isFile() || stat.size <= 0) continue;
        if (stat.mtimeMs < sinceMs - 5000) continue;
        if (!best || stat.mtimeMs > best.mtimeMs) best = { filePath, mtimeMs: stat.mtimeMs };
    }
    return best?.filePath || null;
}

function findWrongFormatMacromatixExport(downloadDir, report, sinceMs) {
    const hint = MMX_DEFAULT_EXPORT_HINTS[report?.id];
    if (!hint || !fs.existsSync(downloadDir)) return null;
    for (const name of fs.readdirSync(downloadDir)) {
        if (!/^MMS_Report_/i.test(name)) continue;
        if (!hint.needle.test(name)) continue;
        const ext = path.extname(name).toLowerCase();
        if (ext === hint.ext) continue;
        const filePath = path.join(downloadDir, name);
        try {
            const stat = fs.statSync(filePath);
            if (stat.isFile() && stat.size > 0 && stat.mtimeMs >= sinceMs - 5000) {
                return filePath;
            }
        } catch {
            /* ignore */
        }
    }
    return null;
}

/**
 * Rename any fresh MMS_Report_* exports to timestamped stock-on-hand / stock-on-order files.
 */
function normalizeMacromatixExportsForStore(storeDir, reportIds = [], options = {}) {
    const wantIds = new Set(reportIds.length ? reportIds : Object.keys(MMX_DEFAULT_EXPORT_HINTS));
    const adopted = {};
    const maxAgeMs = Number(options.maxAgeMs || 6 * 60 * 60 * 1000);
    const sinceMs = Date.now() - maxAgeMs;
    const storeNumber = String(options.storeNumber || '').trim();
    for (const reportId of wantIds) {
        const hint = MMX_DEFAULT_EXPORT_HINTS[reportId];
        if (!hint) continue;
        const basename =
            reportId === 'report1'
                ? 'stock-on-hand'
                : reportId === 'report2'
                  ? 'stock-on-order'
                  : reportId === 'report3'
                    ? 'inventory-special-event'
                    : null;
        if (!basename) continue;
        const source = findFreshMacromatixExport(storeDir, { id: reportId }, sinceMs);
        if (!source) continue;
        const dest = path.join(storeDir, `${timestampSlug()}-${basename}${hint.ext}`);
        if (path.basename(source) !== path.basename(dest)) {
            if (fs.existsSync(dest)) fs.unlinkSync(dest);
            moveFileResilientSync(source, dest);
        } else {
            continue;
        }
        if (storeNumber && (reportId === 'report1' || reportId === 'report2')) {
            const filterResult = filterSpreadsheetByStoreColumn(dest, storeNumber, 2);
            if (filterResult.removed) {
                log.info(
                    `${reportId} filtered to store ${storeNumber}: ${filterResult.kept} row(s) kept, ${filterResult.removed} removed`
                );
            }
        }
        adopted[reportId] = dest;
    }
    return adopted;
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
    ensureDir(downloadDir);
    const client = await page.target().createCDPSession();
    await client.send('Page.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: downloadDir,
    });
}

async function clickExportExcelDataOnly(page, report = {}) {
    if (report.exportButtonSelector) {
        await page.waitForSelector(report.exportButtonSelector, { timeout: 30000 });
        await page.click(report.exportButtonSelector);
        await page.waitForTimeout(Number(process.env.MMX_EXPORT_MENU_SETTLE_MS || 200));
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

function listStrayMmxExports(downloadDir, report) {
    if (!fs.existsSync(downloadDir)) return [];
    const wantExt = String(report?.downloadExt || '.xls').toLowerCase();
    return fs
        .readdirSync(downloadDir)
        .filter((name) => /^MMS_Report_/i.test(name))
        .map((name) => path.join(downloadDir, name))
        .filter((filePath) => {
            const ext = path.extname(filePath).toLowerCase();
            return ext !== wantExt;
        });
}

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
            const m = body.match(
                /(?:error|failed|unable to|no data|timed out)[^.]{0,180}\./gi
            );
            if (m) chunks.push(...m.slice(0, 3));
            return [...new Set(chunks)].slice(0, 4).join(' | ') || '';
        });
    } catch {
        return '';
    }
}

function buildDownloadDest(report, settings, downloaded) {
    const ext = path.extname(downloaded) || report.downloadExt || '.xls';
    const dir = getReportDownloadDir(settings);
    const slug = timestampSlug();
    const base = report.outputBasename || report.id || 'report';
    return path.join(dir, `${slug}-${base}${ext}`);
}

async function adoptDownloadedReport(report, settings, downloaded) {
    const dest = buildDownloadDest(report, settings, downloaded);
    if (downloaded === dest) return dest;

    if (settings.deferDownloadRename) {
        settings.pendingDownloadRenames = settings.pendingDownloadRenames || [];
        settings.pendingDownloadRenames.push({ report, downloaded, dest });
        return downloaded;
    }

    await moveFileResilient(downloaded, dest);

    if (report.storeNumber && (report.id === 'report1' || report.id === 'report2')) {
        const filterResult = filterSpreadsheetByStoreColumn(dest, report.storeNumber, 2);
        if (filterResult.skipped) {
            log.warn(`${report.label || report.id}: no rows for store ${report.storeNumber} in ${path.basename(dest)}`);
        } else if (filterResult.removed) {
            log.info(
                `${report.label || report.id} filtered to store ${report.storeNumber}: ${filterResult.kept} row(s) kept, ${filterResult.removed} removed`
            );
        }
    }

    return dest;
}

async function flushDeferredDownloadRenames(settings) {
    const pending = settings.pendingDownloadRenames || [];
    settings.pendingDownloadRenames = [];
    const paths = {};
    for (const entry of pending) {
        const { report, downloaded, dest } = entry;
        await moveFileResilient(downloaded, dest);

        if (report.storeNumber && (report.id === 'report1' || report.id === 'report2')) {
            const filterResult = filterSpreadsheetByStoreColumn(dest, report.storeNumber, 2);
            if (filterResult.skipped) {
                log.warn(`${report.label || report.id}: no rows for store ${report.storeNumber} in ${path.basename(dest)}`);
            } else if (filterResult.removed) {
                log.info(
                    `${report.label || report.id} filtered to store ${report.storeNumber}: ${filterResult.kept} row(s) kept, ${filterResult.removed} removed`
                );
            }
        }

        paths[report.id] = dest;
        log.info(`Saved ${report.id} → ${path.basename(dest)}`);
    }
    return paths;
}

async function waitForReportDownload(downloadDir, timeoutMs, preferredExt, pollHooks = {}) {
    const acceptSinceMs = Number(pollHooks.acceptSinceMs || 0);
    const order = preferredExt
        ? [preferredExt, ...DOWNLOAD_EXTS.filter((e) => e !== preferredExt)]
        : DOWNLOAD_EXTS;
    let lastError = null;
    for (let i = 0; i < order.length; i++) {
        const ext = order[i];
        const attemptMs = i === 0 ? timeoutMs : Math.min(15000, Math.floor(timeoutMs / 4));
        try {
            return await waitForNewDownload(downloadDir, {
                timeoutMs: attemptMs,
                ext,
                acceptSinceMs,
                touchEveryMs: Number(process.env.MMX_DOWNLOAD_EXPORT_RETRY_MS || 0) || 0,
                onPoll: async () => {
                    refreshScrapePauseTimeout();
                    if (typeof pollHooks.onPoll === 'function') {
                        await pollHooks.onPoll();
                    }
                },
            });
        } catch (e) {
            lastError = e;
            if (i === order.length - 1) break;
        }
    }
    if (lastError && timeoutMs > 15000) {
        throw new Error(
            `${String(lastError.message || lastError).replace(/\(\d+ms\)\.?$/i, '')} (waited ${timeoutMs}ms for ${preferredExt || order[0]})`
        );
    }
    throw lastError || new Error('No download received');
}

/**
 * Sanity-check a downloaded report before adopting it, so a wrong or truncated
 * file fails fast (and triggers a retry) instead of poisoning the build-to calc.
 * Returns null when OK, otherwise a reason string.
 */
function validateDownloadedReportFile(downloaded, report) {
    let stat;
    try {
        stat = fs.statSync(downloaded);
    } catch (err) {
        return `not readable (${err.message})`;
    }
    if (!stat.size) return 'file is empty';

    const storeNumber = report.storeNumber ? String(report.storeNumber).trim() : '';
    try {
        if (report.id === 'report1') {
            const rows = parseStockOnHand(downloaded, storeNumber);
            const minRows = Number(process.env.MMX_REPORT_MIN_SOH_ROWS || 10);
            if (storeNumber && rows.size < minRows) {
                return `stock-on-hand has only ${rows.size} row(s) for store ${storeNumber}`;
            }
        } else if (report.id === 'report2') {
            // Zero on-order rows is legitimate - only require a parseable spreadsheet.
            parseStockOnOrder(downloaded, storeNumber);
        } else if (report.id === 'report3') {
            const { items } = parseInventorySpecialEventFile(downloaded);
            if (!items || items.size === 0) return 'inventory-special-event parsed 0 items';
        }
    } catch (err) {
        return `unreadable (${err.message})`;
    }
    return null;
}

async function reportTimeoutDiagnostics(page, report, downloadDir, err) {
    const diag = await scrapeReportPageDiagnostics(page);
    if (diag) {
        log.warn(`${report.label || report.id}: page diagnostics after timeout: ${diag}`);
    }
    log.warn(`${report.label || report.id}: page URL at timeout: ${page.url()}`);
    const stray = listStrayMmxExports(downloadDir, report);
    if (stray.length) {
        log.warn(
            `${report.label || report.id}: files in download dir: ${stray.map((f) => path.basename(f)).join(', ')}`
        );
    }
    const hint = diag ? ` Macromatix page: ${diag}` : '';
    return new Error(`${err.message}.${hint}`);
}

/**
 * One generate+download attempt into a fresh empty attempt dir. The attempt dir is
 * exclusive to this report, so whatever Chromium saves there IS the requested report.
 */
async function downloadReportAttempt(page, report, settings, attemptDir, runReport) {
    await configureDownloadPath(page, attemptDir);

    const downloadStartedAt = Date.now();
    await runReport();

    if (typeof settings.onReportStep === 'function') {
        const reportLabel = report.label || report.reportName || report.id || 'report';
        await settings.onReportStep(`${reportLabel}: waiting for file download…`);
    }

    const downloadWaitMs = Number(report.downloadWaitMs || settings.downloadWaitMs);
    let downloaded;
    try {
        downloaded = await waitForReportDownload(attemptDir, downloadWaitMs, report.downloadExt, {
            acceptSinceMs: downloadStartedAt,
        });
    } catch (err) {
        const wrongFormat = findWrongFormatMacromatixExport(attemptDir, report, downloadStartedAt);
        if (wrongFormat) {
            throw new Error(
                `Macromatix saved ${path.basename(wrongFormat)} but ${report.downloadExt || '.xls'} was required - confirm "${report.format || 'Excel Data Only'}" is selected before Generate`
            );
        }
        // Last-resort recovery: the export may have landed in the main store dir if the
        // browser ignored the per-attempt download path.
        const mainDir = getReportDownloadDir(settings);
        const fallback = findFreshMacromatixExport(mainDir, report, downloadStartedAt);
        if (fallback) {
            log.info(
                `${report.label || report.id}: adopting Macromatix default export ${path.basename(fallback)} from ${mainDir}`
            );
            downloaded = fallback;
        } else {
            throw await reportTimeoutDiagnostics(page, report, attemptDir, err);
        }
    }

    const wantExt = String(report.downloadExt || path.extname(downloaded) || '.xls').toLowerCase();
    const gotExt = path.extname(downloaded).toLowerCase();
    if (wantExt && gotExt && gotExt !== wantExt) {
        throw new Error(
            `Macromatix saved ${path.basename(downloaded)} (${gotExt}) but ${wantExt} was required`
        );
    }

    const invalid = validateDownloadedReportFile(downloaded, report);
    if (invalid) {
        throw new Error(
            `${report.label || report.id}: downloaded ${path.basename(downloaded)} failed validation - ${invalid}`
        );
    }

    return adoptDownloadedReport(report, settings, downloaded);
}

/** Generate+download with retries; each attempt gets a fresh empty download dir. */
async function downloadReportWithRetries(page, report, settings, runReport) {
    const baseDir = getReportDownloadDir(settings);
    const cleared = clearMacromatixDefaultExports(baseDir);
    if (cleared.length) {
        log.info(
            `${report.label || report.id}: cleared ${cleared.length} stale Macromatix export file(s) before download`
        );
    }

    const maxAttempts = downloadAttemptCount();
    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const attemptDir = createDownloadAttemptDir(baseDir, report.id, attempt);
        try {
            const dest = await downloadReportAttempt(page, report, settings, attemptDir, runReport);
            if (attempt > 1) {
                log.info(`${report.label || report.id}: succeeded on attempt ${attempt}/${maxAttempts}`);
            }
            report.downloadAttempts = attempt;
            return dest;
        } catch (err) {
            lastError = err;
            removeDownloadAttemptDir(attemptDir);
            if (attempt >= maxAttempts || !isRetryableDownloadError(err)) break;
            log.warn(
                `${report.label || report.id}: attempt ${attempt}/${maxAttempts} failed (${err.message}) - regenerating with a fresh download dir`
            );
            if (typeof settings.onReportStep === 'function') {
                const reportLabel = report.label || report.reportName || report.id || 'report';
                await settings.onReportStep(`${reportLabel}: retrying download (attempt ${attempt + 1}/${maxAttempts})…`);
            }
            // Force a full re-open of Report Selection so the retry starts from known state.
            if (settings.chainSession) {
                settings.chainSession.hubOpen = false;
                settings.chainSession.lastGroup = null;
            }
        }
    }
    throw lastError || new Error(`${report.label || report.id}: download failed`);
}

async function downloadSupplyChainReport(page, report, settings) {
    const scope = report.scmTreeStoreNumber
        ? ` (tree checkbox: ${report.scmTreeStoreNumber})`
        : report.skipStoreSelection
          ? ' (no store tree; split/filter after download)'
          : '';

    const dest = await downloadReportWithRetries(page, report, settings, async () => {
        log.info(`Downloading: ${report.label || report.id} (${report.reportName})${scope}`);
        await runSupplyChainReport(page, report, settings);
    });

    log.info(`Saved ${report.id} → ${path.basename(dest)}`);
    if (typeof settings.onReportStep === 'function') {
        const reportLabel = report.label || report.reportName || report.id || 'report';
        await settings.onReportStep(`Downloaded ${reportLabel} → ${path.basename(dest)}`);
    }
    if (settings.chainSession) {
        settings.chainSession.hubOpen = false;
    }
    refreshScrapePauseTimeout();
    return dest;
}

async function downloadStoreReport(page, report, settings) {
    const dest = await downloadReportWithRetries(
        page,
        { ...report, downloadExt: report.downloadExt || '.csv' },
        settings,
        async () => {
            log.info(`Downloading: ${report.label || report.id} (${report.reportName})`);
            await runStoreReport(page, report, settings);
        }
    );

    log.info(`Saved ${report.id} → ${path.basename(dest)}`);
    if (report.id === 'report3' && report.storeNumber) {
        logIseSpotCheck(dest, ['37876', '37909', '37609'], (msg) => log.info(msg));
    }
    if (typeof settings.onReportStep === 'function') {
        const reportLabel = report.label || report.reportName || report.id || 'report';
        await settings.onReportStep(`Downloaded ${reportLabel} → ${path.basename(dest)}`);
    }
    refreshScrapePauseTimeout();
    return dest;
}

async function openReportsHub(page, settings) {
    const reportNav = settings.pipeline.reportNavigation;
    if (!reportNav) {
        throw new Error('Missing reportNavigation in config/reports-pipeline.json');
    }
    await navigateToSupplyChainReports(page, reportNav, settings.navTimeoutMs);
}

function chainReportsEnabled(settings) {
    if (settings?.chainReports === false) return false;
    return process.env.MMX_CHAIN_REPORT_DOWNLOAD !== '0';
}

async function downloadReports(page, settings) {
    const reports = settings.pipeline.reports || [];
    const paths = {};

    if (!reports.length) {
        throw new Error('No reports configured in config/reports-pipeline.json');
    }

    if (!reportsConfigured(reports)) {
        log.warn('Reports not fully configured - opening Report Selection only');
        await openReportsHub(page, settings);
        return paths;
    }

    sweepStaleDownloadAttemptDirs(getReportDownloadDir(settings));
    await configureDownloadPath(page, getReportDownloadDir(settings));

    if (chainReportsEnabled(settings) && !settings.chainSession) {
        settings.chainSession = {
            hubOpen: false,
            lastGroup: null,
            lastFormat: null,
            lastStartDate: null,
            lastEndDate: null,
        };
    }

    const failures = [];

    for (const report of reports) {
        if (report.skip) continue;

        try {
            if (typeof settings.onReportStep === 'function') {
                const reportLabel = report.label || report.reportName || report.id || 'report';
                const mmxName = report.reportName ? ` (${report.reportName})` : '';
                await settings.onReportStep(`Downloading ${reportLabel}${mmxName}…`);
            }
            if (isSupplyChainReport(report)) {
                paths[report.id] = await downloadSupplyChainReport(page, report, settings);
                if (settings.deferDownloadRename && settings.pendingDownloadRenames?.length) {
                    const adopted = await flushDeferredDownloadRenames(settings);
                    if (adopted[report.id]) {
                        paths[report.id] = adopted[report.id];
                    }
                }
                refreshScrapePauseTimeout();
                continue;
            }

            if (isStoreReport(report)) {
                paths[report.id] = await downloadStoreReport(page, report, settings);
                refreshScrapePauseTimeout();
                continue;
            }

            if (!report.url || report.url.includes('REPLACE')) {
                throw new Error(`Report "${report.id || report.label}" URL not configured`);
            }

            log.info(`Downloading: ${report.label || report.id}`);
            await page.goto(report.url, { ...GOTO_OPTS, timeout: settings.navTimeoutMs });
            if (report.waitAfterNavigateMs) {
                await page.waitForTimeout(report.waitAfterNavigateMs);
            }

            const exportStartedAt = Date.now();
            await withPageContextRetry(page, `export ${report.id}`, async () => {
                await clickExportExcelDataOnly(page, report);
            });

            const downloaded = await waitForReportDownload(getReportDownloadDir(settings), settings.downloadWaitMs, null, {
                acceptSinceMs: exportStartedAt,
            });
            const dest = await adoptDownloadedReport(
                { ...report, outputBasename: report.outputBasename || report.id },
                settings,
                downloaded
            );
            paths[report.id] = dest;
            log.info(`Saved ${report.id} → ${path.basename(dest)}`);
        } catch (err) {
            failures.push({ id: report.id, label: report.label || report.id, error: err.message });
            log.error(`Report ${report.id} (${report.label || report.id}) failed: ${err.message}`);
            if (settings.strictReports || report.id === 'report1') {
                break;
            }
        }
    }

    if (failures.length) {
        const summary = failures.map((f) => `${f.id}: ${f.error}`).join('; ');
        if (settings.strictReports) {
            throw new Error(`Reports incomplete (${Object.keys(paths).length} saved): ${summary}`);
        }
        log.warn(`Reports incomplete (${Object.keys(paths).length} saved): ${summary}`);
        const adopted = normalizeMacromatixExportsForStore(
            getReportDownloadDir(settings),
            failures.map((f) => f.id),
            { storeNumber: settings.pipeline?.reports?.[0]?.storeNumber }
        );
        for (const [reportId, dest] of Object.entries(adopted)) {
            if (!paths[reportId]) {
                paths[reportId] = dest;
                log.info(`Recovered ${reportId} from Macromatix default export → ${path.basename(dest)}`);
            }
        }
    }

    return paths;
}

module.exports = {
    downloadReports,
    openReportsHub,
    reportsConfigured,
    configureDownloadPath,
    clickExportExcelDataOnly,
    waitForReportDownload,
    findFreshMacromatixExport,
    normalizeMacromatixExportsForStore,
    flushDeferredDownloadRenames,
    downloadReportWithRetries,
    validateDownloadedReportFile,
};
