const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const ExcelJS = require('exceljs');
const { copyFileSafe, ensureDir, sleep } = require('./util-files');
const log = require('./util-logging');
const { recalcWorkbook } = require('./util-recalc-workbook');
const { exportWorkbookTabsPdf } = require('./util-export-workbook-tabs-pdf');
const {
    loadSourceWorkbook,
    resolveSourceSheet,
    getSourceCell,
    resolveSourceRange,
    parseCellRef,
} = require('./util-source-workbook');

function workbookPassword() {
    return String(process.env.MMX_BUILDTO_WORKBOOK_PASSWORD || '123456').trim();
}

/** Close / unprotect a Build To workbook held open in Excel so Node can overwrite it. */
function unlockWorkbookFile(filePath) {
    if (process.platform !== 'win32') return false;
    const ps1 = path.join(__dirname, '..', 'scripts', 'unlock-workbook.ps1');
    if (!fs.existsSync(ps1)) return false;
    const password = workbookPassword();
    const args = [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        ps1,
        '-Path',
        path.resolve(filePath),
        '-CloseOnly',
    ];
    if (password) args.push('-Password', password);
    const result = spawnSync('powershell', args, { encoding: 'utf8', timeout: 60000 });
    const out = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
    if (out) log.info(out.split(/\r?\n/).pop());
    return result.status === 0;
}

function unprotectWorkbookInMemory(wb) {
    const password = workbookPassword();
    if (!password || !wb) return;
    try {
        if (typeof wb.unprotect === 'function') wb.unprotect(password);
    } catch {
        /* ignore */
    }
    for (const ws of wb.worksheets || []) {
        try {
            if (ws.protect && typeof ws.unprotect === 'function') ws.unprotect(password);
            else if (typeof ws.unprotect === 'function') ws.unprotect(password);
        } catch {
            /* ignore */
        }
    }
}

async function copyTemplate(settings) {
    const local = settings.templateLocal;
    ensureDir(path.dirname(local));

    if (!fs.existsSync(local)) {
        if (settings.templateSource && fs.existsSync(settings.templateSource)) {
            log.info(`Copying template from ${settings.templateSource}`);
            copyFileSafe(settings.templateSource, local);
        } else {
            throw new Error(
                `Template not found: ${local}\n` +
                    `Set MMX_TEMPLATE_ONEDRIVE / MMX_TEMPLATE_PI / MMX_TEMPLATE_FALLBACK in .env, ` +
                    `or MMX_TEMPLATE_LOCAL with a semicolon-separated list. See .env.example.`
            );
        }
    } else if (settings.templateSource && fs.existsSync(settings.templateSource) && settings.templateAlwaysCopy) {
        log.info(`Refreshing template from ${settings.templateSource}`);
        copyFileSafe(settings.templateSource, local);
    }
    return local;
}

function parseRangeStatic(range) {
    const [a, b] = String(range).split(':');
    const start = parseCellRef(`X!${a}`);
    const end = parseCellRef(`X!${b}`);
    return {
        startCol: start.col,
        startRow: start.row,
        endCol: end.col,
        endRow: end.row,
    };
}

/** Wipe destination tab so leftover rows cannot show stale Macromatix data. */
function clearDestinationBeforePaste(destSheet, destStart, map) {
    if (map.clearBeforePaste === false) return;

    let endRow;
    let endCol;
    if (map.clearRange) {
        const area = parseRangeStatic(map.clearRange);
        endRow = area.endRow;
        endCol = area.endCol;
    } else {
        endRow = Math.max(destSheet.rowCount || 0, 250);
        endCol = Math.max(destSheet.columnCount || 0, 15);
    }

    const startRow = destStart.row;
    const startCol = destStart.col;
    let cleared = 0;

    for (let r = startRow; r <= endRow; r++) {
        for (let c = startCol; c <= endCol; c++) {
            const cell = destSheet.getCell(r, c);
            if (cell.value != null && cell.value !== '') {
                cell.value = null;
                cleared++;
            } else if (cell.formula) {
                cell.value = null;
                cleared++;
            }
        }
    }

    log.info(
        `Cleared "${destSheet.name}" ${map.clearRange || `rows ${startRow}-${endRow}, cols ${startCol}-${endCol}`} (${cleared} cells)`
    );
}

function getTemplateSyncPaths(settings) {
    const local = path.normalize(settings.templateLocal);
    return (settings.templateSyncPaths || []).filter((p) => path.normalize(p) !== local);
}

function syncTemplateCopies(sourcePath, settings) {
    const synced = [];
    for (const target of getTemplateSyncPaths(settings)) {
        try {
            ensureDir(path.dirname(target));
            copyFileSafe(sourcePath, target);
            synced.push(target);
            log.info(`Synced workbook → ${target}`);
        } catch (e) {
            log.warn(`Could not sync to ${target}: ${e.message}`);
        }
    }
    return synced;
}

async function applyMapping(wb, reportPaths, mapping) {
    for (const map of mapping.mappings || []) {
        const srcPath = reportPaths[map.fromReport];
        if (!srcPath) {
            log.info(`Skipping mapping for ${map.fromReport} (not in this run)`);
            continue;
        }
        const srcLoaded = await loadSourceWorkbook(srcPath);
        const srcSheet = resolveSourceSheet(srcLoaded, map.fromSheet);
        if (!srcSheet) throw new Error(`Sheet "${map.fromSheet}" not found in ${srcPath}`);

        const destSheetName = map.toSheet || mapping.templateSheet || 'Data';
        let destSheet = wb.getWorksheet(destSheetName);
        if (!destSheet) {
            destSheet = wb.addWorksheet(destSheetName);
        }

        const range = resolveSourceRange(srcSheet, map.fromRange);
        const destStart = parseCellRef(`${destSheetName}!${map.toStartCell}`);

        clearDestinationBeforePaste(destSheet, destStart, map);

        const pastedRows = range.endRow - range.startRow + 1;
        const pastedCols = range.endCol - range.startCol + 1;

        let dr = destStart.row;
        for (let r = range.startRow; r <= range.endRow; r++) {
            let dc = destStart.col;
            for (let c = range.startCol; c <= range.endCol; c++) {
                const val = getSourceCell(srcSheet, r, c);
                destSheet.getCell(dr, dc).value = val;
                dc++;
            }
            dr++;
        }
        log.info(
            `Mapped ${map.fromReport} ${map.fromRange} (${pastedRows}x${pastedCols}) → ${destSheetName}!${map.toStartCell}`
        );
    }
}

async function extractValuesForPaste(wb, mapping) {
    const out = {};
    for (const item of mapping.extractForMacromatix || []) {
        const { sheet, col, row } = parseCellRef(item.cell);
        const ws = wb.getWorksheet(sheet) || wb.worksheets[0];
        const cell = ws.getCell(row, col);
        let v = cell.value;
        if (v && typeof v === 'object' && v.result !== undefined) v = v.result;
        if (v && typeof v === 'object' && v.text) v = v.text;
        out[item.key] = v == null ? '' : String(v);
    }
    return out;
}

async function runExcelTransform(settings, reportPaths) {
    const templatePath = await copyTemplate(settings);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(templatePath);
    unprotectWorkbookInMemory(wb);

    await applyMapping(wb, reportPaths, settings.excelMapping);
    await writeWorkbookWithRetry(wb, templatePath);
    log.info(`Updated working template: ${templatePath}`);

    const recalc = recalcWorkbook(templatePath);
    if (recalc.ok) {
        await wb.xlsx.readFile(templatePath);
    } else if (!recalc.skipped) {
        log.warn('Workbook recalc did not run — vendor order quantities may be stale');
    }

    let exportedPdfTabs = [];
    const pdfExport = settings.pdfExport || {};
    if (pdfExport.enabled) {
        if (!recalc.ok) {
            const reason = recalc.reason ? ` (${recalc.reason})` : '';
            throw new Error(
                `PDF export requires successful workbook recalc; recalc did not complete${reason}. ` +
                    `Check LibreOffice/Excel availability and MMX_SKIP_WORKBOOK_RECALC.`
            );
        }
        exportedPdfTabs = await exportWorkbookTabsPdf({
            workbookPath: templatePath,
            tabs: pdfExport.tabs,
            outDir: pdfExport.outDir,
        });
        log.info(`Exported ${exportedPdfTabs.length} tab PDF(s) to ${pdfExport.outDir}`);
    }

    const syncedPaths = getTemplateSyncPaths(settings).length
        ? syncTemplateCopies(templatePath, settings)
        : [];

    const pasteValues = await extractValuesForPaste(wb, settings.excelMapping);

    if (settings.templatePublish && settings.templatePublish !== settings.templateLocal) {
        try {
            copyFileSafe(templatePath, settings.templatePublish);
            log.info(`Published template to ${settings.templatePublish}`);
        } catch (e) {
            log.warn(`Could not publish to server (file locked?): ${e.message}`);
        }
    }

    const outPath = path.join(settings.outDir, `paste-values-${Date.now()}.json`);
    ensureDir(settings.outDir);
    fs.writeFileSync(outPath, JSON.stringify(pasteValues, null, 2));
    log.info(`Paste payload written: ${outPath}`);

    return { templatePath, pasteValues, pasteValuesPath: outPath, syncedPaths, exportedPdfTabs };
}

async function writeWorkbookWithRetry(wb, filePath, attempts = 12, delayMs = 5000) {
    unprotectWorkbookInMemory(wb);
    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            await wb.xlsx.writeFile(filePath);
            return;
        } catch (err) {
            const locked = err && (err.code === 'EBUSY' || /EBUSY|EPERM|resource busy|locked/i.test(String(err.message)));
            if (!locked || attempt >= attempts) throw err;
            log.warn(`Build To workbook is locked — retrying save (${attempt}/${attempts})…`);
            if (attempt === 1 || attempt === 4 || attempt === 8) {
                log.info('Trying to close/unlock workbook in Excel…');
                unlockWorkbookFile(filePath);
            }
            await sleep(delayMs);
        }
    }
}

module.exports = { runExcelTransform, copyTemplate, writeWorkbookWithRetry };
