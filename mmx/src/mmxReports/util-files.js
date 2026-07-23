const fs = require('fs');
const path = require('path');

function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
}

function copyFileSafe(src, dest) {
    ensureDir(path.dirname(dest));
    fs.copyFileSync(src, dest);
}

const MOVE_RETRY_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);

function moveFileResilientSync(source, dest) {
    if (path.resolve(source) === path.resolve(dest)) return dest;
    ensureDir(path.dirname(dest));
    if (fs.existsSync(dest)) fs.unlinkSync(dest);
    try {
        fs.renameSync(source, dest);
        return dest;
    } catch (err) {
        if (!MOVE_RETRY_CODES.has(err?.code)) throw err;
        copyFileSafe(source, dest);
        try {
            fs.unlinkSync(source);
        } catch {
            /* dest is valid */
        }
        return dest;
    }
}

/**
 * Rename a freshly downloaded report file. On Windows, Chromium may still hold the
 * file handle briefly — retry with backoff and fall back to copy+unlink.
 */
async function moveFileResilient(source, dest, options = {}) {
    if (!source || !dest) {
        throw new Error('moveFileResilient requires source and dest paths');
    }
    if (path.resolve(source) === path.resolve(dest)) return dest;

    ensureDir(path.dirname(dest));
    if (fs.existsSync(dest)) fs.unlinkSync(dest);

    const maxAttempts = Number(options.maxAttempts || 16);
    const delayMs = Number(options.delayMs || 200);
    let lastError;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            fs.renameSync(source, dest);
            return dest;
        } catch (err) {
            lastError = err;
            const code = err?.code;
            if (!MOVE_RETRY_CODES.has(code) && attempt === 1) break;
            if (attempt < maxAttempts) await sleep(delayMs * Math.min(attempt, 6));
        }
    }

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            fs.copyFileSync(source, dest);
            try {
                fs.unlinkSync(source);
            } catch {
                /* dest is valid even if the browser still has source open */
            }
            return dest;
        } catch (err) {
            lastError = err;
            if (attempt < maxAttempts) await sleep(delayMs * Math.min(attempt, 6));
        }
    }

    throw lastError || new Error(`Could not move ${source} → ${dest}`);
}

function timestampSlug() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

function listFiles(dir, ext = '.xlsx') {
    if (!fs.existsSync(dir)) return [];
    return fs
        .readdirSync(dir)
        .filter((f) => f.toLowerCase().endsWith(ext))
        .map((f) => path.join(dir, f));
}

/** Macromatix SCM exports use fixed MMS_Report_* names in addition to browser default names. */
function listDownloadCandidates(dir, ext = '.xlsx') {
    const want = String(ext || '').toLowerCase();
    const out = new Set(listFiles(dir, want));
    if (!fs.existsSync(dir)) return [];
    for (const name of fs.readdirSync(dir)) {
        const lower = name.toLowerCase();
        if (!lower.endsWith(want)) continue;
        if (/^MMS_Report_/i.test(name) || /^InventorySpecialEvent/i.test(name)) {
            out.add(path.join(dir, name));
        }
    }
    return [...out];
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
    const stem = String(ext || '').toLowerCase().replace(/^\./, '');
    for (const name of fs.readdirSync(dir)) {
        const lower = name.toLowerCase();
        if (!lower.endsWith('.crdownload')) continue;
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

/**
 * Wait until a new or updated file matching ext appears in dir (size stabilizes).
 * Macromatix often reuses the same export filename (e.g. MMS_Report_*.xls).
 */
async function waitForNewDownload(dir, opts = {}) {
    const ext = opts.ext || '.xlsx';
    const timeoutMs = opts.timeoutMs || 120000;
    const pollMs = opts.pollMs || 500;
    const before = fileSnapshots(dir, ext);
    const start = Date.now();
    const acceptSinceMs = Number(opts.acceptSinceMs || 0);
    const touchEveryMs = Number(opts.touchEveryMs || 0);
    let lastTouch = start;

    while (Date.now() - start < timeoutMs) {
        if (touchEveryMs > 0 && typeof opts.onPoll === 'function' && Date.now() - lastTouch >= touchEveryMs) {
            try {
                await opts.onPoll();
            } catch {
                /* ignore */
            }
            lastTouch = Date.now();
        }

        if (hasActivePartialDownload(dir, ext)) {
            await sleep(pollMs);
            continue;
        }

        const now = listDownloadCandidates(dir, ext);
        for (const f of now) {
            let stat1;
            try {
                stat1 = fs.statSync(f);
            } catch {
                continue;
            }
            if (stat1.size === 0) continue;
            const freshSinceGenerate =
                acceptSinceMs > 0 && stat1.mtimeMs >= acceptSinceMs - 5000;
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
        await sleep(pollMs);
    }
    throw new Error(`Timed out waiting for download in ${dir} (${timeoutMs}ms)`);
}

/** Remove Macromatix default export names so overwrite detection stays reliable. */
function clearMacromatixDefaultExports(dir) {
    if (!fs.existsSync(dir)) return [];
    const removed = [];
    for (const name of fs.readdirSync(dir)) {
        if (!/^MMS_Report_/i.test(name) && !/^InventorySpecialEvent/i.test(name)) continue;
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

/** Remove stale Chromium lock files (e.g. after crash, scp copy, or interrupted login). */
/** Ephemeral folder for Macromatix report downloads (removed after merge). */
function createReportDownloadDir(workDir) {
    const dir = path.join(workDir, 'out', 'tmp-report-downloads', timestampSlug());
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
            // Best effort - individual files were already unlinked.
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
    moveFileResilient,
    moveFileResilientSync,
    timestampSlug,
    listFiles,
    listDownloadCandidates,
    fileSnapshots,
    waitForNewDownload,
    clearMacromatixDefaultExports,
    sleep,
    archiveFile,
    clearChromeProfileSingletonLocks,
    createReportDownloadDir,
    cleanupReportDownloads,
};
