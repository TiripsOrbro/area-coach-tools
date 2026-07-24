const fs = require('fs');
const path = require('path');
const { platformEnvSuffix } = require('./util-platform');

const ROOT = path.join(__dirname, '..');

function loadJson(relPath, required = true) {
    const p = path.join(ROOT, relPath);
    if (!fs.existsSync(p)) {
        if (required) {
            throw new Error(
                `Missing ${relPath}. Copy from ${relPath.replace('.json', '.json.example')} and fill in discovery values.`
            );
        }
        return null;
    }
    return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function loadEnvFile(name, { override = false } = {}) {
    const p = path.join(ROOT, name);
    if (fs.existsSync(p)) {
        require('dotenv').config({ path: p, override });
    }
}

/** Shared → platform overlay (.env.windows / .env.pi) → production. Machine readable paths stay out of git. */
function loadEnv() {
    loadEnvFile('.env');
    loadEnvFile(`.env.${platformEnvSuffix()}`, { override: true });
    loadEnvFile('.env.production', { override: true });
}

/** Resolve env path: absolute/UNC as-is; relative paths from `baseDir` (repo root by default). */
function resolveConfigPath(raw, baseDir = ROOT) {
    const trimmed = String(raw || '').trim();
    if (!trimmed) return null;
    if (path.isAbsolute(trimmed) || trimmed.startsWith('\\\\')) {
        return path.normalize(trimmed);
    }
    return path.resolve(baseDir, trimmed);
}

/**
 * Build ordered workbook candidates. First existing file wins on each machine.
 * Preferred:
 * - MMX_BUILD_TO_DIR — semicolon-separated list of folders
 * - Or: MMX_BUILD_TO_DIR_ONEDRIVE, MMX_BUILD_TO_DIR_PI, MMX_BUILD_TO_DIR_FALLBACK
 * - MMX_BUILD_TO_FILENAME — workbook name inside the chosen folder
 *
 * Backward compatible:
 * - MMX_TEMPLATE_LOCAL — semicolon-separated list (overrides named vars when set)
 * - Or: MMX_TEMPLATE_ONEDRIVE, MMX_TEMPLATE_PI, MMX_TEMPLATE_FALLBACK (one path per line)
 */
function splitConfigPathList(raw) {
    return String(raw || '')
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean);
}

function splitDelimitedList(raw) {
    return String(raw || '')
        .split(/[;,\n]/)
        .map((s) => s.trim())
        .filter(Boolean);
}

function parseBoolean(raw, defaultValue = false) {
    const text = String(raw ?? '').trim();
    if (!text) return Boolean(defaultValue);
    return /^(1|true|yes|on)$/i.test(text);
}

function parsePositiveInt(raw, fallback) {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.floor(n);
}

function buildToFilename() {
    return String(process.env.MMX_BUILD_TO_FILENAME || 'Build To.xlsx').trim();
}

function buildBuildToDirCandidates(workDir, baseDir = ROOT) {
    const explicitList = splitConfigPathList(process.env.MMX_BUILD_TO_DIR);
    if (explicitList.length) {
        return explicitList.map((p) => resolveConfigPath(p, baseDir));
    }

    const named = [
        process.env.MMX_BUILD_TO_DIR_ONEDRIVE,
        process.env.MMX_BUILD_TO_DIR_PI,
        process.env.MMX_BUILD_TO_DIR_FALLBACK,
    ]
        .map((s) => String(s || '').trim())
        .filter(Boolean)
        .map((p) => resolveConfigPath(p, baseDir));

    if (named.length) return named;

    return [resolveConfigPath(path.join(workDir, 'workbooks'), baseDir)];
}

function buildTemplateLocalCandidates(workDir, baseDir = ROOT) {
    const explicitList = splitConfigPathList(process.env.MMX_TEMPLATE_LOCAL);

    if (explicitList.length) {
        return explicitList.map((p) => resolveConfigPath(p, baseDir));
    }

    const buildToDirs = buildBuildToDirCandidates(workDir, baseDir);
    const filename = buildToFilename();
    if (
        process.env.MMX_BUILD_TO_DIR ||
        process.env.MMX_BUILD_TO_DIR_ONEDRIVE ||
        process.env.MMX_BUILD_TO_DIR_PI ||
        process.env.MMX_BUILD_TO_DIR_FALLBACK ||
        process.env.MMX_BUILD_TO_FILENAME
    ) {
        return buildToDirs.map((dir) => path.join(dir, filename));
    }

    const named = [
        process.env.MMX_TEMPLATE_ONEDRIVE,
        process.env.MMX_TEMPLATE_PI,
        process.env.MMX_TEMPLATE_FALLBACK,
    ]
        .map((s) => String(s || '').trim())
        .filter(Boolean)
        .map((p) => resolveConfigPath(p, baseDir));

    if (named.length) return named;

    return [resolveConfigPath(path.join(workDir, 'workbooks', 'Build To JS.xlsx'), baseDir)];
}

/** Pick first existing candidate, or first in list (create/copy target) if none exist yet. */
function resolveTemplateLocal(workDir, baseDir = ROOT) {
    const candidates = buildTemplateLocalCandidates(workDir, baseDir);
    const existing = candidates.find((p) => fs.existsSync(p));
    return {
        path: existing || candidates[0],
        candidates,
        exists: Boolean(existing),
    };
}

function logTemplateLocalChoice(settings) {
    const log = require('./util-logging');
    const status = settings.templateLocalExists ? 'using existing' : 'target (not found yet)';
    log.info(`Build To workbook (${status}): ${settings.templateLocal}`);
    if (settings.templateLocalCandidates.length > 1) {
        const checked = settings.templateLocalCandidates
            .map((p) => `${p}${fs.existsSync(p) ? ' ✓' : ''}`)
            .join('\n  ');
        log.info(`  Paths checked (first ✓ wins):\n  ${checked}`);
    }
    log.info(`Report downloads: temporary folder (removed after merge): ${settings.reportDownloadDir}`);
}

function resolveDownloadDir(templatePath, baseDir = ROOT) {
    const raw = String(process.env.MMX_DOWNLOAD_DIR || '').trim();
    if (!raw || /^same-as-workbook$/i.test(raw)) {
        return path.dirname(templatePath);
    }
    return resolveConfigPath(raw, baseDir);
}

/** Macromatix exports land here briefly, then are deleted after merge (not the Build To folder). */
function resolveReportDownloadDir(workDir, baseDir = ROOT) {
    const raw = String(process.env.MMX_DOWNLOAD_DIR || '').trim();
    if (raw && !/^same-as-workbook$/i.test(raw)) {
        return resolveConfigPath(raw, baseDir);
    }
    const { createReportDownloadDir } = require('./util-files');
    return createReportDownloadDir(workDir);
}

function augmentPipeline(pipeline) {
    const next = { ...pipeline, gate: { ...(pipeline.gate || {}) } };
    const gateUrl = String(process.env.MMX_GATE_URL || '').trim();
    if (gateUrl) next.gate.url = gateUrl;

    // Area Coach Tools sets MMX_STORE_NAME per store — that must win over
    // pipeline.json defaults (historically "Chirnside Park").
    const envStore = String(process.env.MMX_STORE_NAME || '').trim();
    const fallbackStore = envStore || '3811 Chirnside Park';
    const storeLabel = envStore || fallbackStore;
    const storeNumber = String(storeLabel.match(/\b(\d{3,6})\b/)?.[1] || '').trim();
    next.reports = (pipeline.reports || []).map((r) => {
        const storeName = envStore || r.storeName || fallbackStore;
        const num =
            String(r.storeNumber || '').replace(/\D/g, '') ||
            String(storeName.match(/\b(\d{3,6})\b/)?.[1] || storeNumber || '').trim();
        const scm = String(r.type || '').toLowerCase() === 'supplychain';
        return {
            ...r,
            storeName,
            storeNumber: num || undefined,
            // SCM Flat Zone Filter must check this store — SelectStore login alone is not enough.
            scmTreeStoreNumber: scm && num ? num : r.scmTreeStoreNumber,
            skipStoreTree: scm ? false : r.skipStoreTree,
        };
    });

    return next;
}

function getSettings() {
    loadEnv();
    const workDir = resolveConfigPath(process.env.MMX_WORK_DIR || './data', ROOT);
    const ephemeralBrowser = /^(1|true|yes|on)$/i.test(String(process.env.MMX_EPHEMERAL_BROWSER ?? '').trim());
    const userDataDirRaw = String(process.env.MMX_USER_DATA_DIR ?? '').trim();
    const userDataDir = ephemeralBrowser
        ? null
        : userDataDirRaw
          ? resolveConfigPath(userDataDirRaw, ROOT)
          : path.join(workDir, 'browser-profile');
    const template = resolveTemplateLocal(workDir, ROOT);
    const pdfTabs = splitDelimitedList(process.env.MMX_PDF_EXPORT_TABS);
    const pdfExportEnabled = parseBoolean(process.env.MMX_PDF_EXPORT_ENABLED, false);
    const pdfExportDir = process.env.MMX_PDF_EXPORT_DIR
        ? resolveConfigPath(process.env.MMX_PDF_EXPORT_DIR, ROOT)
        : path.join(workDir, 'out', 'pdfs');
    const emailTo = splitDelimitedList(process.env.MMX_EMAIL_TO);
    const emailCc = splitDelimitedList(process.env.MMX_EMAIL_CC);
    const labourStores = splitDelimitedList(process.env.MMX_LABOUR_STORES);
    const defaultLabourStores = labourStores.length ? labourStores : [String(process.env.MMX_STORE_NAME || '').trim()].filter(Boolean);
    const labourRefreshMinutes = parsePositiveInt(process.env.MMX_LABOUR_REFRESH_MINUTES || 2, 2);
    const salesIntervalMinutes = parsePositiveInt(
        process.env.MMX_SALES_INTERVAL_MINUTES || labourRefreshMinutes,
        labourRefreshMinutes
    );
    const workerRetryBackoffSeconds = parsePositiveInt(process.env.MMX_WORKER_RETRY_BACKOFF_SECONDS || 30, 30);
    const workerMaxRetryBackoffSeconds = parsePositiveInt(process.env.MMX_WORKER_MAX_RETRY_BACKOFF_SECONDS || 300, 300);
    return {
        root: ROOT,
        workDir,
        downloadDir: resolveDownloadDir(template.path, ROOT),
        reportDownloadDir: resolveReportDownloadDir(workDir, ROOT),
        templateLocal: template.path,
        templateLocalCandidates: template.candidates,
        templateLocalExists: template.exists,
        templateSource: process.env.MMX_TEMPLATE_SOURCE
            ? resolveConfigPath(process.env.MMX_TEMPLATE_SOURCE, ROOT)
            : null,
        templatePublish: process.env.MMX_TEMPLATE_PUBLISH
            ? resolveConfigPath(process.env.MMX_TEMPLATE_PUBLISH, ROOT)
            : null,
        templateAlwaysCopy: !/^(0|false|no|off)$/i.test(
            String(process.env.MMX_TEMPLATE_ALWAYS_COPY ?? 'false').trim()
        ),
        templateSyncPaths: (process.env.MMX_TEMPLATE_SYNC || '')
            .split(';')
            .map((s) => s.trim())
            .filter(Boolean)
            .map((p) => resolveConfigPath(p, ROOT)),
        userDataDir,
        ephemeralBrowser,
        loginSuccessUrlPart: process.env.MMX_LOGIN_SUCCESS_URL_PART || '/MMS_',
        navTimeoutMs: Number(process.env.MMX_NAV_TIMEOUT_MS || 45000),
        downloadWaitMs: Number(process.env.MMX_DOWNLOAD_WAIT_MS || 120000),
        loginWaitMs: Number(process.env.MMX_LOGIN_WAIT_MS || 300000),
        outDir: path.join(workDir, 'out'),
        storeName: String(process.env.MMX_STORE_NAME || '3811 Chirnside Park').trim(),
        pipeline: augmentPipeline(loadJson('config/pipeline.json')),
        excelMapping: loadJson('config/excel-mapping.json'),
        vendorOrders: loadJson('config/vendor-orders.json', false),
        pdfExport: {
            enabled: pdfExportEnabled,
            tabs: pdfTabs,
            outDir: pdfExportDir,
        },
        email: {
            enabled: parseBoolean(process.env.MMX_EMAIL_ENABLED, false),
            sendOnDryRun: parseBoolean(process.env.MMX_EMAIL_SEND_ON_DRY_RUN, true),
            smtpHost: String(process.env.MMX_EMAIL_SMTP_HOST || '').trim(),
            smtpPort: Number(process.env.MMX_EMAIL_SMTP_PORT || 587),
            smtpSecure: parseBoolean(process.env.MMX_EMAIL_SMTP_SECURE, false),
            smtpUser: String(process.env.MMX_EMAIL_SMTP_USER || '').trim(),
            smtpPass: String(process.env.MMX_EMAIL_SMTP_PASS || '').trim(),
            from: String(process.env.MMX_EMAIL_FROM || '').trim(),
            to: emailTo,
            cc: emailCc,
            subjectPrefix: String(process.env.MMX_EMAIL_SUBJECT_PREFIX || '3811 Build To PDFs').trim(),
            body: String(
                process.env.MMX_EMAIL_BODY ||
                    'Attached are the latest Build To PDF exports generated by mmx-report-automation.'
            ).trim(),
        },
        continuousScrapers: {
            requirePersistentProfile: parseBoolean(process.env.MMX_CONTINUOUS_REQUIRE_PERSISTENT_PROFILE, true),
            sales: {
                intervalMs: salesIntervalMinutes * 60000,
                reportUrl: String(process.env.MMX_SALES_REPORT_URL || '').trim(),
                readySelector: String(process.env.MMX_SALES_READY_SELECTOR || '').trim(),
            },
            labour: {
                stores: defaultLabourStores,
                refreshMs: labourRefreshMinutes * 60000,
                schedulerUrl: String(
                    process.env.MMX_LABOUR_SCHEDULER_URL ||
                        'https://tacobellau.macromatix.net/MMS_Stores_LabourScheduler.aspx?MenuCustomItemID=249'
                ).trim(),
                dayViewSelector: String(process.env.MMX_LABOUR_DAY_VIEW_SELECTOR || '').trim(),
                storeInputSelector: String(process.env.MMX_LABOUR_STORE_INPUT_SELECTOR || '').trim(),
                storeApplySelector: String(process.env.MMX_LABOUR_STORE_APPLY_SELECTOR || '').trim(),
                readySelector: String(process.env.MMX_LABOUR_READY_SELECTOR || '').trim(),
            },
            worker: {
                retryBackoffMs: workerRetryBackoffSeconds * 1000,
                maxRetryBackoffMs: workerMaxRetryBackoffSeconds * 1000,
            },
        },
    };
}

module.exports = {
    ROOT,
    loadEnv,
    loadEnvFile,
    getSettings,
    loadJson,
    resolveConfigPath,
    buildTemplateLocalCandidates,
    resolveTemplateLocal,
    logTemplateLocalChoice,
};
