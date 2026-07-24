const fs = require('fs');
const path = require('path');
const os = require('os');

function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
}

function copyFileSafe(src, dest) {
    ensureDir(path.dirname(dest));
    fs.copyFileSync(src, dest);
}

function timestampSlug() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

function listFiles(dir, ext = '.xlsx') {
    if (!fs.existsSync(dir)) return [];
    const want = String(ext || '').toLowerCase();
    return fs
        .readdirSync(dir)
        .filter((f) => f.toLowerCase().endsWith(want))
        .map((f) => path.join(dir, f));
}

/** True for files we already renamed/claimed (must not be reused as the next download). */
function isClaimedReportFile(filePath) {
    const name = path.basename(String(filePath || ''));
    return /^\d{8}-\d{4}-report\d+\./i.test(name);
}

/** Fresh Macromatix browser exports only (not our renamed copies). */
function isMacromatixExportName(filePath) {
    const name = path.basename(String(filePath || ''));
    return /^MMS_Report_/i.test(name) || /^InventorySpecialEvent/i.test(name);
}

/** Include Macromatix fixed export names; exclude already-saved report1/report2/report3 files. */
function listDownloadCandidates(dir, ext = '.xlsx') {
    const want = String(ext || '').toLowerCase();
    const out = [];
    if (!fs.existsSync(dir)) return out;
    for (const name of fs.readdirSync(dir)) {
        const lower = name.toLowerCase();
        if (!lower.endsWith(want)) continue;
        if (isClaimedReportFile(name)) continue;
        out.push(path.join(dir, name));
    }
    return out;
}

function fileSnapshots(dir, ext) {
    const map = new Map();
    for (const f of listDownloadCandidates(dir, ext)) {
        try {
            const st = fs.statSync(f);
            map.set(f, { size: st.size, mtimeMs: st.mtimeMs });
        } catch {
            /* ignore */
        }
    }
    return map;
}

function hasActivePartialDownload(dir, ext) {
    if (!fs.existsSync(dir)) return false;
    const stem = String(ext || '')
        .toLowerCase()
        .replace(/^\./, '');
    for (const name of fs.readdirSync(dir)) {
        const lower = name.toLowerCase();
        if (!lower.endsWith('.crdownload') && !lower.endsWith('.tmp')) continue;
        if (!stem || lower.includes(stem)) return true;
    }
    return false;
}

function fileChangedSince(before, filePath, stat) {
    const prev = before.get(filePath);
    if (!prev) return true;
    if (stat.size !== prev.size) return true;
    return stat.mtimeMs > prev.mtimeMs + 200;
}

/** Windows user Downloads — Edge fallback when CDP downloadPath is ignored. */
function userDownloadsDir() {
    const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
    return path.join(home, 'Downloads');
}

/** Match Macromatix export filenames by report id (when Edge dumps into Downloads). */
function exportNameMatchesReport(reportId, name) {
    const n = String(name || '');
    const id = String(reportId || '').toLowerCase();
    if (id === 'report1' || id.includes('onhand') || id.includes('items on hand')) {
        return /MMS_Report_SupplyChainManagement_2_All/i.test(n) || /Items.?On.?Hand/i.test(n);
    }
    if (id === 'report2' || id.includes('onorder') || id.includes('on order')) {
        return /MMS_Report_SupplyChainManagement_OnOrder/i.test(n) || /On.?Order/i.test(n);
    }
    if (id === 'report3' || id.includes('special') || id.includes('inventory')) {
        return /InventorySpecialEvent/i.test(n);
    }
    return /MMS_Report_|InventorySpecialEvent/i.test(n);
}

/**
 * If CDP failed and the file landed in ~/Downloads, move it into downloadDir.
 * @returns {string|null} destination path
 */
function adoptExportFromUserDownloads(downloadDir, reportId, acceptSinceMs, preferredExt) {
    const found = findFreshExportInDir(userDownloadsDir(), reportId, acceptSinceMs, preferredExt);
    if (!found) return null;
    ensureDir(downloadDir);
    const dest = path.join(downloadDir, path.basename(found));
    if (path.resolve(found) === path.resolve(dest)) return dest;
    try {
        fs.renameSync(found, dest);
    } catch {
        fs.copyFileSync(found, dest);
        try {
            fs.unlinkSync(found);
        } catch {
            /* keep copy if delete fails */
        }
    }
    return dest;
}

/** Find a fresh Macromatix export in a folder (non-recursive). */
function findFreshExportInDir(dir, reportId, acceptSinceMs, preferredExt) {
    if (!dir || !fs.existsSync(dir)) return null;
    const since = Number(acceptSinceMs) || 0;
    const prefer = String(preferredExt || '').toLowerCase();
    let best = null;
    for (const name of fs.readdirSync(dir)) {
        const lower = name.toLowerCase();
        if (lower.endsWith('.crdownload') || lower.endsWith('.tmp') || lower.endsWith('.partial')) continue;
        if (isClaimedReportFile(name)) continue;
        if (reportId && !exportNameMatchesReport(reportId, name)) continue;
        if (!reportId && !isMacromatixExportName(name)) continue;
        if (prefer && !lower.endsWith(prefer)) continue;
        const full = path.join(dir, name);
        try {
            const st = fs.statSync(full);
            if (!st.isFile() || st.size < 1) continue;
            if (since && st.mtimeMs + 5000 < since) continue;
            if (!best || st.mtimeMs > best.mtimeMs) {
                best = { full, mtimeMs: st.mtimeMs };
            }
        } catch {
            /* skip */
        }
    }
    return best ? best.full : null;
}

/** Walk immediate child folders (e.g. report1/report3/_shared) for a mis-routed export. */
function findFreshExportNearby(rootDir, reportId, acceptSinceMs, preferredExt) {
    if (!rootDir || !fs.existsSync(rootDir)) return null;
    const direct = findFreshExportInDir(rootDir, reportId, acceptSinceMs, preferredExt);
    if (direct) return direct;
    let best = null;
    let bestMtime = 0;
    for (const name of fs.readdirSync(rootDir)) {
        const full = path.join(rootDir, name);
        try {
            if (!fs.statSync(full).isDirectory()) continue;
        } catch {
            continue;
        }
        const found = findFreshExportInDir(full, reportId, acceptSinceMs, preferredExt);
        if (!found) continue;
        try {
            const mtime = fs.statSync(found).mtimeMs;
            if (!best || mtime > bestMtime) {
                best = found;
                bestMtime = mtime;
            }
        } catch {
            /* skip */
        }
    }
    return best;
}

/**
 * Wait until a new or updated file matching ext appears (size stabilizes).
 * Macromatix reuses MMS_Report_*.xls — overwrites must count as a new download.
 * Also polls ~/Downloads when Edge ignores CDP downloadPath (common on mapped drives).
 */
async function waitForNewDownload(dir, opts = {}) {
    const ext = opts.ext || '.xlsx';
    const timeoutMs = opts.timeoutMs || 120000;
    const pollMs = opts.pollMs || 500;
    const before = opts.beforeSnapshots || fileSnapshots(dir, ext);
    const start = Date.now();
    const acceptSinceMs = Number(opts.acceptSinceMs || 0);
    const reportId = String(opts.reportId || '').trim();
    const alsoCheckUserDownloads = opts.alsoCheckUserDownloads !== false;

    while (Date.now() - start < timeoutMs) {
        if (hasActivePartialDownload(dir, ext)) {
            await sleep(pollMs);
            continue;
        }

        const now = listDownloadCandidates(dir, ext);
        for (const f of now) {
            if (isClaimedReportFile(f)) continue;
            if (reportId && isMacromatixExportName(f) && !exportNameMatchesReport(reportId, path.basename(f))) {
                continue;
            }
            let stat1;
            try {
                stat1 = fs.statSync(f);
            } catch {
                continue;
            }
            if (stat1.size === 0) continue;
            // Same-name overwrite detection only for Macromatix default filenames —
            // never treat a prior *-report1.xls as the next report's download.
            const freshSinceGenerate =
                acceptSinceMs > 0 &&
                isMacromatixExportName(f) &&
                stat1.mtimeMs >= acceptSinceMs - 5000;
            if (!fileChangedSince(before, f, stat1) && !freshSinceGenerate) continue;

            await sleep(pollMs);
            let stat2;
            try {
                stat2 = fs.statSync(f);
            } catch {
                continue;
            }
            if (stat2.size === stat1.size && stat2.size > 0 && !hasActivePartialDownload(dir, ext)) {
                return f;
            }
        }

        if (alsoCheckUserDownloads && reportId) {
            const adopted = adoptExportFromUserDownloads(dir, reportId, acceptSinceMs, ext);
            if (adopted) {
                try {
                    require('./util-logging').info(
                        `Adopted export from Downloads → ${path.basename(adopted)} (${reportId})`
                    );
                } catch {
                    /* logging optional */
                }
                return adopted;
            }
        }

        // Concurrent tabs: Browser.setDownloadBehavior is last-writer-wins — file may land nearby.
        const scanRoot = opts.scanRoot || path.dirname(dir);
        if (reportId && scanRoot) {
            const orphan = findFreshExportNearby(scanRoot, reportId, acceptSinceMs, ext);
            if (orphan && path.resolve(path.dirname(orphan)) !== path.resolve(dir)) {
                ensureDir(dir);
                const dest = path.join(dir, path.basename(orphan));
                try {
                    fs.renameSync(orphan, dest);
                } catch {
                    fs.copyFileSync(orphan, dest);
                    try {
                        fs.unlinkSync(orphan);
                    } catch {
                        /* keep */
                    }
                }
                try {
                    require('./util-logging').info(
                        `Adopted mis-routed export → ${path.basename(dest)} (${reportId})`
                    );
                } catch {
                    /* optional */
                }
                return dest;
            }
        }

        await sleep(pollMs);
    }
    const dlHint = alsoCheckUserDownloads && reportId ? `; also checked ${userDownloadsDir()}` : '';
    throw new Error(`Timed out waiting for download in ${dir} (${timeoutMs}ms)${dlHint}`);
}

/** Remove Macromatix default export names so the next Generate's overwrite is detectable. */
function clearMacromatixDefaultExports(dir, reportId = '') {
    if (!fs.existsSync(dir)) return [];
    const removed = [];
    for (const name of fs.readdirSync(dir)) {
        if (!/^MMS_Report_/i.test(name) && !/^InventorySpecialEvent/i.test(name)) continue;
        if (reportId && !exportNameMatchesReport(reportId, name)) continue;
        const filePath = path.join(dir, name);
        try {
            if (!fs.statSync(filePath).isFile()) continue;
            fs.unlinkSync(filePath);
            removed.push(name);
        } catch {
            /* ignore */
        }
    }
    return removed;
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function archiveFile(filePath, archiveDir) {
    ensureDir(archiveDir);
    const base = path.basename(filePath);
    const dest = path.join(archiveDir, `${timestampSlug()}-${base}`);
    fs.renameSync(filePath, dest);
    return dest;
}

const CHROME_PROFILE_LOCK_FILES = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'];

/**
 * Temp folder for Macromatix exports during a run. Cleared after Excel merge.
 * Prefer local disk (os.tmpdir) — Edge/Chromium often ignores CDP downloadPath
 * when it points at a network/mapped drive (e.g. Y:\...).
 */
function createReportDownloadDir(workDir) {
    const forceWorkDir = /^(1|true|yes|on)$/i.test(String(process.env.MMX_DOWNLOAD_USE_WORKDIR || '').trim());
    const root = forceWorkDir
        ? path.join(workDir, 'out', 'tmp-report-downloads')
        : path.join(os.tmpdir(), 'act-mmx-report-downloads');
    const dir = path.resolve(path.join(root, timestampSlug()));
    ensureDir(dir);
    return dir;
}

/** Delete downloaded report files and optionally remove the whole temp download directory. */
function cleanupReportDownloads(reportPaths, downloadDir) {
    let removed = 0;
    for (const p of Object.values(reportPaths || {})) {
        try {
            if (p && fs.existsSync(p)) {
                fs.unlinkSync(p);
                removed++;
            }
        } catch (e) {
            // File may already be gone or locked briefly during browser shutdown.
        }
    }
    if (downloadDir && fs.existsSync(downloadDir)) {
        try {
            fs.rmSync(downloadDir, { recursive: true, force: true });
        } catch (e) {
            // Best effort — individual files were already unlinked.
        }
    }
    return removed;
}

function clearChromeProfileSingletonLocks(userDataDir) {
    if (!userDataDir) return [];
    const removed = [];
    for (const name of CHROME_PROFILE_LOCK_FILES) {
        const lockPath = path.join(userDataDir, name);
        try {
            if (fs.existsSync(lockPath)) {
                fs.unlinkSync(lockPath);
                removed.push(name);
            }
        } catch {
            /* profile may be in use by another live Chromium */
        }
    }
    return removed;
}

module.exports = {
    ensureDir,
    copyFileSafe,
    timestampSlug,
    listFiles,
    waitForNewDownload,
    sleep,
    archiveFile,
    clearChromeProfileSingletonLocks,
    createReportDownloadDir,
    cleanupReportDownloads,
    userDownloadsDir,
    adoptExportFromUserDownloads,
    exportNameMatchesReport,
    findFreshExportInDir,
    findFreshExportNearby,
    clearMacromatixDefaultExports,
    fileSnapshots,
    isClaimedReportFile,
    isMacromatixExportName,
};
