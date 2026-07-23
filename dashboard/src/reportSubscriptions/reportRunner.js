const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const paths = require('../../../src/paths');
const REPORTS_DIR = paths.vendors.reports;
const { getStoreList } = require('../../../stores/src/storeList');
const { recordForecastHistoryDay, sumHourly, addDaysToIso, assessHistoryReadiness, HISTORY_DAYS } = require('../forecast/forecastHistoryLedger');
const { downloadReportsForStores } = require('../../../mmx/src/mmxReportDownloader');
const { recordIseSnapshotFromFile, writeStoreIseHistory, assessIseCoverage, resolveCoverageEndDate, weeklySnapshotAnchorDates, resolveIseWeeksDateRange } = require('./iseHistoryLedger');
const { isoToMacromatixDate } = require('../../../mmx/src/mmxReports/util-dates');
const { buildHistoricalHourlySalesCsv, assessHourlySalesCoverage, datesInRange } = require('./historicalHourlySalesCsv');
const { buildIseTrimmedAverageCsv, buildCombinedIseTrimmedAverageCsv } = require('./iseTrimmedAverage');
const { sendReportEmail } = require('./reportEmailService');
const {
    markSubscriptionSent,
    melbourneTodayIso,
    resolveDefaultDateRange,
} = require('./reportSubscriptionsStore');
const { envConcurrency, mapWithConcurrency } = require('../../../src/shared/concurrency');

const LABOUR_URL =
    'https://tacobellau.macromatix.net/MMS_Stores_LabourScheduler.aspx?MenuCustomItemID=249';

function backfillStoreConcurrency(storeCount) {
    return Math.min(envConcurrency('BACKFILL_STORE_CONCURRENCY', 1), Math.max(1, storeCount || 1));
}
function hashFile(filePath) {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function emitProgress(options, event) {
    if (typeof options?.onProgress !== 'function') return;
    try {
        options.onProgress({
            ts: new Date().toISOString(),
            ...event,
        });
    } catch {
        /* ignore progress handler errors */
    }
}

const HOURLY_BACKFILL_LOG_SKIP_TYPES = new Set(['day-saved', 'day-read', 'day-batch-start']);

function enrichHourlyBackfillProgress(store, event = {}) {
    const type = String(event.type || '').trim();
    const date = String(event.date || '').trim();
    const enriched = { storeNumber: store, ...event };
    if (type === 'day-start' && date) {
        enriched.message = `Store ${store}: filling ${date}…`;
    }
    return enriched;
}

function shouldEmitHourlyBackfillLog(event = {}) {
    return !HOURLY_BACKFILL_LOG_SKIP_TYPES.has(String(event.type || '').trim());
}

function formatHourlyStoreDoneMessage(store, coverage, forecastReadiness, skippedDays = []) {
    const missing = [...(coverage?.missingDays || [])];
    const incomplete = [...new Set([...missing, ...skippedDays.map((d) => String(d || '').trim()).filter(Boolean)])].sort();
    if (incomplete.length) {
        return `Store ${store}: incomplete — ${incomplete.join(', ')}`;
    }
    if (forecastReadiness?.ready) {
        return `Store ${store}: complete.`;
    }
    const gaps = forecastReadiness?.weekdayGaps?.length
        ? ` (forecast needs ${forecastReadiness.weekdayGaps.join(', ')})`
        : ' (forecast history still needed)';
    return `Store ${store}: report data complete${gaps}`;
}

function resolveStoresForScope(scopeType, scopeId, { includedStoreNumbers = null } = {}) {
    const type = String(scopeType || 'store').trim();
    const id = String(scopeId || '').trim();
    const stores = getStoreList();
    let matched;
    if (type === 'area') matched = stores.filter((s) => String(s.area || '') === id);
    else matched = stores.filter((s) => String(s.storeNumber) === id);

    if (type === 'area' && Array.isArray(includedStoreNumbers) && includedStoreNumbers.length) {
        const allowed = new Set(includedStoreNumbers.map((s) => String(s || '').trim()).filter(Boolean));
        matched = matched.filter((s) => allowed.has(String(s.storeNumber)));
    }
    return matched;
}

function resolveScopeStoreFilter(options = {}) {
    const fromSubscription = options.subscription?.includedStoreNumbers;
    if (Array.isArray(fromSubscription) && fromSubscription.length) return fromSubscription;
    if (Array.isArray(options.includedStoreNumbers) && options.includedStoreNumbers.length) {
        return options.includedStoreNumbers;
    }
    return null;
}

function resolveHourlyBackfillDateRange(dateRange = {}) {
    const forecastRange = resolveDefaultDateRange({
        days: HISTORY_DAYS,
        endOffsetDays: dateRange.endOffsetDays ?? 1,
    });
    const subStart = String(dateRange.startDate || '').trim();
    const subEnd = String(dateRange.endDate || '').trim();
    if (!subStart || !subEnd) return forecastRange;

    const allDates = new Set([
        ...datesInRange(forecastRange.startDate, forecastRange.endDate),
        ...datesInRange(subStart, subEnd),
    ]);
    const sorted = [...allDates].sort();
    if (!sorted.length) return forecastRange;
    return {
        startDate: sorted[0],
        endDate: sorted[sorted.length - 1],
        forecastRange,
        reportRange: { startDate: subStart, endDate: subEnd },
    };
}

async function backfillMissingHourlySales(storeNumber, dateRange = {}, options = {}) {
    const backfillRange = resolveHourlyBackfillDateRange(dateRange);
    const coverage = assessHourlySalesCoverage(storeNumber, backfillRange);
    const forecastReadiness = assessHistoryReadiness(storeNumber);
    if (coverage.ready && forecastReadiness.ready && !options.force) {
        emitProgress(options, {
            type: 'info',
            storeNumber,
            message: `Store ${storeNumber}: report and forecast history ready (${coverage.presentDays}/${coverage.totalDays} days).`,
            forecastReadiness,
        });
        return {
            ...assessHourlySalesCoverage(storeNumber, dateRange),
            forecastReadiness,
            backfillRange,
            skipped: true,
        };
    }

    const missing = coverage.missingDays || [];
    const allDatesInRange = datesInRange(backfillRange.startDate, backfillRange.endDate);
    const datesToScrape = options.force ? allDatesInRange : missing;
    if (!datesToScrape.length && !options.force) {
        return {
            ...assessHourlySalesCoverage(storeNumber, dateRange),
            forecastReadiness: assessHistoryReadiness(storeNumber),
            backfillRange,
        };
    }

    const scraper = require('../../../mmx/src/macromatixScraper');
    const { acquireMmxResource, releaseMmxResource } = require('../../../mmx/src/mmxResourceGate');
    const store = String(storeNumber || '').trim();
    const credentials = scraper.resolveMacromatixCredentialsForStore(store);
    if (!credentials?.username) throw new Error(`No Macromatix credentials for store ${store}`);

    emitProgress(options, {
        type: 'store-start',
        storeNumber: store,
        message: `Store ${store}: ${options.force ? 'refreshing' : 'backfilling'} ${datesToScrape.length} day(s) from MMX…`,
        missingCount: datesToScrape.length,
    });

    let browser;
    const skippedDays = [];
    acquireMmxResource(`report hourly backfill store ${store}`);
    try {
        emitProgress(options, {
            type: 'info',
            storeNumber: store,
            message: `Store ${store}: logging into Macromatix and opening labour scheduler…`,
        });
        const opened = await scraper.openMacromatixBrowser({
            storeNumber: store,
            mmxUsername: credentials.username,
            mmxPassword: credentials.password,
            launchOptions: { headless: true },
        });
        browser = opened.browser;
        const { page } = opened;
        await page.goto(LABOUR_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await scraper.selectStoreOnPage(page, store);

        const scraped = await scraper.scrapeMissingHistoricalDays(page, datesToScrape, {
            timeZone: process.env.DASHBOARD_TIME_ZONE || 'Australia/Melbourne',
            onProgress: (ev) => {
                const enriched = enrichHourlyBackfillProgress(store, ev);
                if (shouldEmitHourlyBackfillLog(enriched)) {
                    emitProgress(options, enriched);
                }
            },
        });
        for (const data of scraped) {
            const iso = data.dateIso;
            if (!iso) continue;
            const actualRaw = data.actual || [];
            const total = sumHourly(actualRaw);
            if (total <= 0) {
                skippedDays.push(iso);
                emitProgress(options, {
                    type: 'day-skipped',
                    storeNumber: store,
                    date: iso,
                    message: `Store ${store}: ${iso} — no sales data.`,
                });
                continue;
            }
            recordForecastHistoryDay(
                store,
                iso,
                { actualRaw, actualFormat: 'raw-mmx' },
                { source: 'mmx-report-backfill', finalized: true, force: Boolean(options.force) }
            );
        }
    } finally {
        await scraper.closeBrowserQuietly(browser, 'report hourly backfill');
        releaseMmxResource(`report hourly backfill store ${store}`);
    }

    const finalCoverage = assessHourlySalesCoverage(storeNumber, dateRange);
    const finalForecast = assessHistoryReadiness(storeNumber);
    emitProgress(options, {
        type: 'store-done',
        storeNumber: store,
        coverage: finalCoverage,
        forecastReadiness: finalForecast,
        skippedDays,
        message: formatHourlyStoreDoneMessage(store, finalCoverage, finalForecast, skippedDays),
    });
    return { ...finalCoverage, forecastReadiness: finalForecast, backfillRange };
}

async function ensureIseHistory(storeNumber, options = {}) {
    const dateRange = options.dateRange || {};
    let coverage = assessIseCoverage(storeNumber, dateRange);
    if (coverage.ready && !options.force) {
        emitProgress(options, {
            type: 'info',
            storeNumber,
            message: `Store ${storeNumber}: ISE history ready (${coverage.snapshotCount} snapshots).`,
        });
        return coverage;
    }

    const coverageEndDate = resolveCoverageEndDate(dateRange);
    const anchorsToFetch = options.force
        ? weeklySnapshotAnchorDates(coverageEndDate)
        : coverage.missingSnapshotDates || [];
    if (!anchorsToFetch.length) {
        return coverage;
    }

    emitProgress(options, {
        type: 'store-start',
        storeNumber,
        message: `Store ${storeNumber}: downloading ${anchorsToFetch.length} ISE report(s) from MMX…`,
        missingCount: anchorsToFetch.length,
    });

    const scraper = require('../../../mmx/src/macromatixScraper');
    const { acquireMmxResource, releaseMmxResource } = require('../../../mmx/src/mmxResourceGate');
    const store = String(storeNumber || '').trim();
    const credentials = scraper.resolveMacromatixCredentialsForStore(store);
    if (!credentials?.username) throw new Error(`No Macromatix credentials for store ${store}`);

    let browser;
    acquireMmxResource(`ISE backfill store ${store}`);
    try {
        emitProgress(options, {
            type: 'info',
            storeNumber: store,
            message: `Store ${store}: logging into Macromatix…`,
        });
        const opened = await scraper.openMacromatixBrowser({
            storeNumber: store,
            mmxUsername: credentials.username,
            mmxPassword: credentials.password,
            launchOptions: { headless: true },
        });
        browser = opened.browser;
        const { page } = opened;

        if (options.force) {
            writeStoreIseHistory({ storeNumber: store, snapshots: [], updatedAt: new Date().toISOString() });
        }

        let lastDownloadHash = null;

        for (const anchorDate of anchorsToFetch) {
            const mmxStartDate = isoToMacromatixDate(anchorDate);
            emitProgress(options, {
                type: 'info',
                storeNumber: store,
                message: `Store ${store}: downloading ISE report for week starting ${anchorDate} (MMX ${mmxStartDate})…`,
            });
            const anchorDownloadDir = path.join(REPORTS_DIR, store, '_ise-backfill', anchorDate);
            fs.mkdirSync(anchorDownloadDir, { recursive: true });
            const result = await downloadReportsForStores({
                storeNumber: store,
                onlyReportIds: ['report3'],
                parallelReportDownload: false,
                browser,
                page,
                skipIseHistoryCapture: true,
                chainReports: false,
                resetReportHub: true,
                reportDownloadDir: anchorDownloadDir,
                reportOverrides: {
                    report3: { startDate: mmxStartDate },
                },
            });
            const files = result?.stores?.[store]?.files || {};
            const isePath = files.report3 || files['inventory-special-event'];
            if (isePath && fs.existsSync(isePath)) {
                const fileHash = hashFile(isePath);
                if (fileHash === lastDownloadHash) {
                    emitProgress(options, {
                        type: 'warn',
                        storeNumber,
                        message: `Store ${storeNumber}: ISE file for ${anchorDate} is identical to the previous download — skipping snapshot.`,
                    });
                    continue;
                }
                lastDownloadHash = fileHash;
                try {
                    recordIseSnapshotFromFile(storeNumber, isePath, { date: anchorDate });
                    emitProgress(options, {
                        type: 'info',
                        storeNumber,
                        message: `Store ${storeNumber}: ISE snapshot saved for ${anchorDate} from ${path.basename(isePath)}.`,
                    });
                } catch (err) {
                    emitProgress(options, {
                        type: 'warn',
                        storeNumber,
                        message: `Store ${storeNumber}: ${err.message || 'Could not save ISE snapshot.'}`,
                    });
                }
            } else {
                emitProgress(options, {
                    type: 'warn',
                    storeNumber,
                    message: `Store ${storeNumber}: ISE download for ${anchorDate} did not produce a file.`,
                });
            }
        }
    } finally {
        await scraper.closeBrowserQuietly(browser, 'ISE history backfill');
        releaseMmxResource(`ISE backfill store ${store}`);
    }

    coverage = assessIseCoverage(storeNumber, dateRange);
    emitProgress(options, {
        type: 'store-done',
        storeNumber,
        coverage,
        message: `Store ${storeNumber}: ${coverage.snapshotCount}/${coverage.weeksNeeded || 5} ISE snapshots.`,
    });
    return coverage;
}

function buildAttachmentFilename(reportType, storeNumber, ext = 'csv') {
    const date = melbourneTodayIso();
    const slug = String(reportType || 'report').replace(/[^a-z0-9]+/gi, '-');
    return `${slug}-store-${storeNumber}-${date}.${ext}`;
}

function buildScopeAttachmentFilename(reportType, scopeType, scopeId, ext = 'csv') {
    const date = melbourneTodayIso();
    const slug = String(reportType || 'report').replace(/[^a-z0-9]+/gi, '-');
    const scope = String(scopeId || scopeType || 'all').replace(/[^a-z0-9]+/gi, '-');
    return `${slug}-${scope}-${date}.${ext}`;
}

async function buildZipBuffer(files) {
    let ZipArchive;
    try {
        ({ ZipArchive } = require('archiver'));
    } catch (err) {
        console.warn('[ReportRunner] ZIP build failed:', err.message);
        return null;
    }
    return new Promise((resolve, reject) => {
        const chunks = [];
        const archive = new ZipArchive({ zlib: { level: 9 } });
        archive.on('data', (chunk) => chunks.push(chunk));
        archive.on('error', reject);
        archive.on('end', () => resolve(Buffer.concat(chunks)));
        for (const file of files) {
            archive.append(file.content, { name: file.filename });
        }
        archive.finalize();
    }).catch((err) => {
        console.warn('[ReportRunner] ZIP build failed:', err.message);
        return null;
    });
}

async function generateReportForStore(reportType, storeNumber, dateRange = {}, options = {}) {
    const store = String(storeNumber || '').trim();
    if (reportType === 'historical-hourly-sales') {
        if (options.backfill !== false) {
            await backfillMissingHourlySales(store, dateRange, options);
        }
        emitProgress(options, {
            type: 'info',
            storeNumber: store,
            message: `Store ${store}: building hourly sales CSV…`,
        });
        const csv = buildHistoricalHourlySalesCsv(store, dateRange);
        return {
            storeNumber: store,
            reportType,
            filename: buildAttachmentFilename(reportType, store, 'csv'),
            content: Buffer.from(csv, 'utf8'),
            contentType: 'text/csv',
        };
    }
    if (reportType === 'ise-trimmed-average') {
        if (options.backfill !== false) {
            await ensureIseHistory(store, { dateRange, force: options.force, onProgress: options.onProgress });
        }
        emitProgress(options, {
            type: 'info',
            storeNumber: store,
            message: `Store ${store}: building Usage Average (ISE) CSV…`,
        });
        const csv = buildIseTrimmedAverageCsv(store, dateRange);
        return {
            storeNumber: store,
            reportType,
            filename: buildAttachmentFilename(reportType, store, 'csv'),
            content: Buffer.from(csv, 'utf8'),
            contentType: 'text/csv',
        };
    }
    throw new Error(`Unknown report type: ${reportType}`);
}

async function generateReportBundle({ reportType, scopeType, scopeId, dateRange = {}, options = {} }) {
    const stores = resolveStoresForScope(scopeType, scopeId, {
        includedStoreNumbers: resolveScopeStoreFilter(options),
    });
    if (!stores.length) throw new Error('No stores matched the selected scope.');

    const concurrency = backfillStoreConcurrency(stores.length);
    if (concurrency > 1) {
        console.log(
            `[ReportRunner] Generating ${reportType} for ${stores.length} store(s) with concurrency ${concurrency}`
        );
    }

    const generated = await mapWithConcurrency(stores, concurrency, async (row) => {
        const file = await generateReportForStore(reportType, row.storeNumber, dateRange, options);
        return {
            file,
            status: {
                storeNumber: row.storeNumber,
                reportType,
                coverage:
                    reportType === 'historical-hourly-sales'
                        ? assessHourlySalesCoverage(row.storeNumber, dateRange)
                        : assessIseCoverage(row.storeNumber, dateRange),
            },
        };
    });

    const attachments = generated.map((row) => row.file);
    const statuses = generated.map((row) => row.status);

    if (reportType === 'ise-trimmed-average' && attachments.length > 1) {
        const storeNumbers = stores.map((row) => row.storeNumber);
        const csv = buildCombinedIseTrimmedAverageCsv(storeNumbers, dateRange);
        return {
            attachments: [
                {
                    filename: buildScopeAttachmentFilename(reportType, scopeType, scopeId, 'csv'),
                    content: Buffer.from(csv, 'utf8'),
                    contentType: 'text/csv',
                },
            ],
            statuses,
            zip: null,
        };
    }

    if (attachments.length === 1) {
        return { attachments, statuses, zip: null };
    }

    const zipBuffer = await buildZipBuffer(
        attachments.map((a) => ({ filename: a.filename, content: a.content }))
    );
    if (zipBuffer) {
        return {
            attachments: [
                {
                    filename: buildAttachmentFilename(reportType, scopeId, 'zip'),
                    content: zipBuffer,
                    contentType: 'application/zip',
                },
            ],
            statuses,
            zip: true,
        };
    }

    return { attachments, statuses, zip: false };
}

function reportTypeLabel(reportType) {
    if (reportType === 'historical-hourly-sales') return 'Historical Hourly Sales Data';
    if (reportType === 'ise-trimmed-average') return 'Usage Average (ISE)';
    return reportType;
}

function resolveSubscriptionDateRange(subscription) {
    const dr = subscription?.dateRange || {};
    if (subscription?.reportType === 'ise-trimmed-average' || String(dr.mode || '').trim() === 'ise-weeks') {
        return resolveIseWeeksDateRange(dr);
    }
    if (String(dr.mode || '').trim() === 'rolling') {
        return resolveDefaultDateRange(dr);
    }
    return {
        startDate: String(dr.startDate || '').trim(),
        endDate: String(dr.endDate || '').trim(),
        days: dr.days,
        endOffsetDays: dr.endOffsetDays,
    };
}

function subscriptionRangeLabel(subscription, dateRange) {
    if (subscription?.reportType === 'ise-trimmed-average') {
        const weeks = Number(dateRange?.weeks ?? subscription?.dateRange?.weeks ?? 5);
        return `${weeks} week${weeks === 1 ? '' : 's'} from yesterday`;
    }
    return `${dateRange.startDate} to ${dateRange.endDate}`;
}

function formatScopeDoneMessage({ reportType, storeCount, statuses, ready, forecastReady }) {
    if (!ready) {
        return 'Backfill finished. Some stores still need data.';
    }
    const partialForecast = reportType === 'historical-hourly-sales' && !forecastReady;
    if (storeCount === 1) {
        const row = statuses[0] || {};
        const storeNumber = String(row.storeNumber || '').trim();
        const storeName = String(row.storeName || '').trim();
        const label = storeName ? `Store ${storeNumber} (${storeName})` : `Store ${storeNumber}`;
        if (partialForecast) {
            return `${label}: report data ready; forecast history still needed.`;
        }
        return `${label} ready.`;
    }
    if (partialForecast) {
        return 'Report data ready. Some stores still need forecast history (see log).';
    }
    return 'All stores ready.';
}

async function backfillScopeData({ reportType, scopeType, scopeId, dateRange = {}, options = {} }) {
    const stores = resolveStoresForScope(scopeType, scopeId, {
        includedStoreNumbers: resolveScopeStoreFilter(options),
    });
    if (!stores.length) throw new Error('No stores matched the selected scope.');
    const concurrency = backfillStoreConcurrency(stores.length);
    emitProgress(options, {
        type: 'scope-start',
        scopeType,
        scopeId,
        storeCount: stores.length,
        message: `Starting backfill for ${stores.length} store(s)${concurrency > 1 ? ` (concurrency ${concurrency})` : ''}…`,
    });
    const statuses = await mapWithConcurrency(stores, concurrency, async (row) => {
        const coverage =
            reportType === 'ise-trimmed-average'
                ? await ensureIseHistory(row.storeNumber, {
                      dateRange,
                      force: options.force,
                      onProgress: options.onProgress,
                  })
                : await backfillMissingHourlySales(row.storeNumber, dateRange, options);
        return {
            storeNumber: row.storeNumber,
            storeName: row.storeName,
            coverage,
        };
    });
    const ready = statuses.length > 0 && statuses.every((r) => r.coverage.ready);
    const forecastReady =
        reportType === 'historical-hourly-sales' &&
        statuses.length > 0 &&
        statuses.every((r) => r.coverage.forecastReadiness?.ready);
    const message = formatScopeDoneMessage({
        reportType,
        storeCount: stores.length,
        statuses,
        ready,
        forecastReady,
    });
    emitProgress(options, {
        type: 'scope-done',
        ready,
        forecastReady,
        message,
    });
    return { ready, forecastReady, stores: statuses, dateRange, message };
}

async function runReportActionStream({ action, reportType, scopeType, scopeId, dateRange = {}, options = {} }) {
    const act = String(action || 'download').trim();
    const onProgress = options.onProgress;

    emitProgress({ onProgress }, {
        type: 'action-start',
        action: act,
        reportType,
        scopeType,
        scopeId,
        message: `Starting ${act}…`,
    });

    if (act === 'backfill') {
        const result = await backfillScopeData({
            reportType,
            scopeType,
            scopeId,
            dateRange,
            options: { ...options, onProgress },
        });
        return { action: act, ...result };
    }

    if (act === 'download') {
        const bundle = await generateReportBundle({
            reportType,
            scopeType,
            scopeId,
            dateRange,
            options: { ...options, onProgress, backfill: options.backfill !== false },
        });
        const attachment = bundle.attachments?.[0];
        if (!attachment) throw new Error('Report generation produced no file.');
        emitProgress({ onProgress }, {
            type: 'file-ready',
            filename: attachment.filename,
            contentType: attachment.contentType || 'application/octet-stream',
            message: `Report ready: ${attachment.filename}`,
        });
        return {
            action: act,
            filename: attachment.filename,
            contentType: attachment.contentType,
            contentBase64: attachment.content.toString('base64'),
            statuses: bundle.statuses,
            zip: bundle.zip,
        };
    }

    if (act === 'send') {
        const subscription = options.subscription;
        if (!subscription?.id) throw new Error('Subscription is required for send action.');
        const result = await sendSubscriptionReport(subscription, {
            backfill: options.backfill !== false,
            force: Boolean(options.force),
            onProgress,
            recipients: options.recipients,
        });
        emitProgress({ onProgress }, {
            type: 'email-result',
            sent: Boolean(result.email?.sent),
            reason: result.email?.reason || null,
            message: result.email?.sent
                ? 'Email sent successfully.'
                : `Email not sent${result.email?.reason ? ` (${result.email.reason})` : ''}.`,
        });
        return { action: act, ...result };
    }

    throw new Error(`Unknown report action: ${act}`);
}

async function sendSubscriptionReport(subscription, options = {}) {
    const dateRange = resolveSubscriptionDateRange(subscription);
    emitProgress(options, {
        type: 'info',
        message: `Generating ${reportTypeLabel(subscription.reportType)} for ${subscription.scopeType} ${subscription.scopeId}…`,
    });
    const bundle = await generateReportBundle({
        reportType: subscription.reportType,
        scopeType: subscription.scopeType,
        scopeId: subscription.scopeId,
        dateRange,
        options: {
            backfill: options.backfill !== false,
            force: Boolean(options.force),
            onProgress: options.onProgress,
            subscription,
        },
    });

    if (options.downloadOnly) {
        return { ok: true, downloadOnly: true, ...bundle };
    }

    const recipients = (() => {
        if (Array.isArray(options.recipients) && options.recipients.length) {
            return options.recipients.map((r) => String(r || '').trim()).filter(Boolean);
        }
        return Array.isArray(subscription.recipients)
            ? subscription.recipients.map((r) => String(r || '').trim()).filter(Boolean)
            : [];
    })();
    if (!recipients.length) throw new Error('At least one recipient email is required.');

    const label = reportTypeLabel(subscription.reportType);
    const scopeLabel =
        subscription.scopeType === 'area'
            ? `Area ${subscription.scopeId}`
            : `Store ${subscription.scopeId}`;
    const rangeLabel = subscriptionRangeLabel(subscription, dateRange);

    emitProgress(options, {
        type: 'info',
        message: `Sending email to ${recipients.join(', ')}…`,
    });

    const emailResult = await sendReportEmail({
        to: recipients,
        subject: `${label} — ${scopeLabel} (${rangeLabel})`,
        body: `Attached: ${label} for ${scopeLabel}.\nPeriod: ${rangeLabel}.`,
        attachments: bundle.attachments.map((a) => ({
            filename: a.filename,
            content: a.content,
            contentType: a.contentType,
        })),
    });

    if (emailResult.sent && subscription.id) {
        markSubscriptionSent(subscription.id, melbourneTodayIso());
    }

    return { ok: emailResult.ok !== false, email: emailResult, ...bundle };
}

function assessDataStatusForScope({ reportType, scopeType, scopeId, dateRange = {}, includedStoreNumbers = null }) {
    const stores = resolveStoresForScope(scopeType, scopeId, { includedStoreNumbers });
    const perStore = stores.map((row) => {
        const coverage =
            reportType === 'ise-trimmed-average'
                ? assessIseCoverage(row.storeNumber, dateRange)
                : assessHourlySalesCoverage(row.storeNumber, dateRange);
        const forecastReadiness =
            reportType === 'historical-hourly-sales' ? assessHistoryReadiness(row.storeNumber) : null;
        return {
            storeNumber: row.storeNumber,
            storeName: row.storeName,
            coverage,
            forecastReadiness,
        };
    });
    const ready = perStore.length > 0 && perStore.every((r) => r.coverage.ready);
    const forecastReady =
        reportType === 'historical-hourly-sales' &&
        perStore.length > 0 &&
        perStore.every((r) => r.forecastReadiness?.ready);
    return {
        ready,
        forecastReady,
        stores: perStore,
        dateRange,
        totalDays: datesInRange(dateRange.startDate, dateRange.endDate).length,
    };
}

async function backfillForecastHistoryForStores(storeNumbers, options = {}) {
    const stores = [...new Set((storeNumbers || []).map((s) => String(s || '').trim()).filter(Boolean))];
    if (!stores.length) throw new Error('No stores selected.');

    const concurrency = backfillStoreConcurrency(stores.length);
    emitProgress(options, {
        type: 'scope-start',
        storeCount: stores.length,
        message: `Backfilling forecast history for ${stores.length} store(s) from MMX${concurrency > 1 ? ` (concurrency ${concurrency})` : ''}…`,
    });

    const statuses = await mapWithConcurrency(stores, concurrency, async (storeNumber) => {
        const coverage = await backfillMissingHourlySales(storeNumber, {}, options);
        return { storeNumber, coverage };
    });

    const ready = statuses.length > 0 && statuses.every((r) => r.coverage.ready);
    const forecastReady =
        statuses.length > 0 && statuses.every((r) => r.coverage.forecastReadiness?.ready);
    const skipped = statuses.length > 0 && statuses.every((r) => r.coverage.skipped);
    const worked = statuses.some((r) => !r.coverage.skipped);
    const message = skipped
        ? stores.length === 1
            ? `Store ${stores[0]} already has complete history. Use Refresh to re-download from MMX.`
            : 'All selected stores already have complete history. Use Refresh to re-download from MMX.'
        : stores.length === 1
          ? forecastReady
              ? `Store ${stores[0]} ready.`
              : ready
                ? `Store ${stores[0]}: report data ready; forecast history still needed.`
                : 'Backfill finished. Some stores still need data.'
          : forecastReady
            ? 'Forecast history backfill complete. All stores ready.'
            : ready
              ? 'Backfill finished. Some stores still need more weekday history (see log).'
              : 'Backfill finished. Some stores still need data.';
    emitProgress(options, {
        type: 'scope-done',
        ready,
        forecastReady,
        skipped,
        worked,
        message,
    });
    return { ready, forecastReady, skipped, worked, stores: statuses, message };
}

module.exports = {
    resolveStoresForScope,
    resolveSubscriptionDateRange,
    resolveHourlyBackfillDateRange,
    backfillMissingHourlySales,
    ensureIseHistory,
    backfillScopeData,
    backfillForecastHistoryForStores,
    runReportActionStream,
    generateReportForStore,
    generateReportBundle,
    sendSubscriptionReport,
    assessDataStatusForScope,
    reportTypeLabel,
};
