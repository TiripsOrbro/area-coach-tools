const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const log = require('./util-logging');

const ROOT = path.join(__dirname, '..');

function shouldSkipRecalc() {
    return /^(1|true|yes|on)$/i.test(String(process.env.MMX_SKIP_WORKBOOK_RECALC ?? '').trim());
}

function recalcWorkbook(templatePath) {
    if (shouldSkipRecalc()) {
        log.info('Workbook recalc skipped (MMX_SKIP_WORKBOOK_RECALC)');
        return { ok: false, skipped: true };
    }

    const abs = path.resolve(templatePath);
    if (!fs.existsSync(abs)) {
        throw new Error(`Workbook not found for recalc: ${abs}`);
    }

    const password = String(process.env.MMX_BUILDTO_WORKBOOK_PASSWORD || '123456').trim();

    if (process.platform === 'win32') {
        const ps1 = path.join(ROOT, 'scripts', 'recalc-workbook.ps1');
        if (!fs.existsSync(ps1)) {
            log.warn('recalc-workbook.ps1 not found — formulas may be stale');
            return { ok: false, skipped: true };
        }
        log.info('Recalculating workbook via Excel (Windows)…');
        const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1, '-Path', abs];
        if (password) args.push('-Password', password);
        const result = spawnSync('powershell', args, { encoding: 'utf8', timeout: 120000 });
        if (result.status !== 0) {
            const msg = (result.stderr || result.stdout || '').trim();
            throw new Error(msg || `Excel recalc failed (exit ${result.status})`);
        }
        log.info((result.stdout || '').trim() || `Recalculated: ${abs}`);
        return { ok: true, engine: 'excel-com' };
    }

    const sh = path.join(ROOT, 'scripts', 'recalc-workbook.sh');
    if (!fs.existsSync(sh)) {
        log.warn('recalc-workbook.sh not found — formulas may be stale');
        return { ok: false, skipped: true };
    }

    log.info('Recalculating workbook via LibreOffice (Linux/Pi)…');
    const result = spawnSync('bash', [sh, abs], { encoding: 'utf8', timeout: 180000 });
    if (result.status !== 0) {
        const msg = (result.stderr || result.stdout || '').trim();
        if (/LibreOffice not found/i.test(msg)) {
            log.warn(`${msg} — order quantities may be wrong until LibreOffice is installed`);
            return { ok: false, skipped: true, reason: 'libreoffice-missing' };
        }
        throw new Error(msg || `LibreOffice recalc failed (exit ${result.status})`);
    }
    log.info((result.stdout || '').trim() || `Recalculated: ${abs}`);
    return { ok: true, engine: 'libreoffice' };
}

module.exports = { recalcWorkbook, shouldSkipRecalc };
