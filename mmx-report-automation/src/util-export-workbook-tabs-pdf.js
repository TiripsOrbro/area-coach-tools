const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const ExcelJS = require('exceljs');
const { ensureDir } = require('./util-files');
const log = require('./util-logging');

const ROOT = path.join(__dirname, '..');

function sanitizeFilePart(value) {
    return String(value || '')
        .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
        .replace(/\s+/g, ' ')
        .trim();
}

function dedupe(values) {
    return [...new Set(values)];
}

function cloneStyle(style) {
    return style ? JSON.parse(JSON.stringify(style)) : {};
}

function copyWorksheetToWorkbook(sourceSheet, targetWb) {
    const targetSheet = targetWb.addWorksheet(sourceSheet.name, {
        properties: { ...sourceSheet.properties },
        pageSetup: { ...sourceSheet.pageSetup },
        headerFooter: { ...sourceSheet.headerFooter },
        state: sourceSheet.state || 'visible',
        views: Array.isArray(sourceSheet.views) ? sourceSheet.views.map((v) => ({ ...v })) : undefined,
    });

    sourceSheet.columns.forEach((sourceCol, idx) => {
        const targetCol = targetSheet.getColumn(idx + 1);
        targetCol.width = sourceCol.width;
        targetCol.hidden = sourceCol.hidden;
        targetCol.outlineLevel = sourceCol.outlineLevel;
        targetCol.style = cloneStyle(sourceCol.style);
    });

    sourceSheet.eachRow({ includeEmpty: true }, (sourceRow, rowNumber) => {
        const targetRow = targetSheet.getRow(rowNumber);
        targetRow.height = sourceRow.height;
        targetRow.hidden = sourceRow.hidden;
        targetRow.outlineLevel = sourceRow.outlineLevel;

        sourceRow.eachCell({ includeEmpty: true }, (sourceCell, colNumber) => {
            const targetCell = targetRow.getCell(colNumber);
            targetCell.value = sourceCell.value;
            targetCell.style = cloneStyle(sourceCell.style);
        });

        targetRow.commit();
    });

    for (const mergeRef of sourceSheet.model?.merges || []) {
        targetSheet.mergeCells(mergeRef);
    }

    // Keep every tab export one-page wide for easier emailing/printing.
    targetSheet.pageSetup = {
        ...targetSheet.pageSetup,
        fitToPage: true,
        fitToWidth: 1,
        fitToHeight: 0,
        orientation: 'landscape',
    };

    return targetSheet;
}

function resolveLibreOfficeBinary() {
    if (process.env.LIBREOFFICE_BIN && String(process.env.LIBREOFFICE_BIN).trim()) {
        return String(process.env.LIBREOFFICE_BIN).trim();
    }
    const checks = process.platform === 'win32' ? ['soffice.exe', 'libreoffice.exe'] : ['soffice', 'libreoffice'];
    for (const bin of checks) {
        const cmd = process.platform === 'win32' ? 'where' : 'which';
        const res = spawnSync(cmd, [bin], { encoding: 'utf8', timeout: 10000 });
        if (res.status === 0) return bin;
    }
    return null;
}

function runWindowsSheetExport(workbookPath, tabName, outputPath) {
    const scriptPath = path.join(ROOT, 'scripts', 'export-sheet-pdf.ps1');
    if (!fs.existsSync(scriptPath)) {
        throw new Error(`Missing PDF export script: ${scriptPath}`);
    }
    const result = spawnSync(
        'powershell',
        [
            '-NoProfile',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            scriptPath,
            '-Path',
            workbookPath,
            '-Sheet',
            tabName,
            '-OutputPath',
            outputPath,
        ],
        { encoding: 'utf8', timeout: 180000 }
    );
    if (result.status !== 0) {
        const msg = (result.stderr || result.stdout || '').trim();
        throw new Error(msg || `Excel PDF export failed for tab "${tabName}"`);
    }
}

async function runLibreOfficeSingleTabExport(workbookPath, tabName, outputPath) {
    const libreOfficeBin = resolveLibreOfficeBinary();
    if (!libreOfficeBin) {
        throw new Error('LibreOffice not found — install libreoffice-calc or set LIBREOFFICE_BIN');
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmx-tab-pdf-'));
    const safeTab = sanitizeFilePart(tabName) || 'Sheet';
    const tempXlsx = path.join(tmpDir, `${safeTab}.xlsx`);
    const tempPdf = path.join(tmpDir, `${safeTab}.pdf`);

    try {
        const src = new ExcelJS.Workbook();
        await src.xlsx.readFile(workbookPath);
        const sourceSheet = src.getWorksheet(tabName);
        if (!sourceSheet) {
            throw new Error(`Tab "${tabName}" not found in workbook`);
        }

        const single = new ExcelJS.Workbook();
        copyWorksheetToWorkbook(sourceSheet, single);
        await single.xlsx.writeFile(tempXlsx);

        const convert = spawnSync(
            libreOfficeBin,
            ['--headless', '--norestore', '--nologo', '--nodefault', '--nofirststartwizard', '--convert-to', 'pdf', '--outdir', tmpDir, tempXlsx],
            { encoding: 'utf8', timeout: 240000 }
        );
        if (convert.status !== 0) {
            const msg = (convert.stderr || convert.stdout || '').trim();
            throw new Error(msg || `LibreOffice PDF export failed for tab "${tabName}"`);
        }
        if (!fs.existsSync(tempPdf)) {
            throw new Error(`Expected PDF was not generated for tab "${tabName}"`);
        }
        fs.copyFileSync(tempPdf, outputPath);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
}

async function exportWorkbookTabsPdf({ workbookPath, tabs, outDir }) {
    const absWorkbookPath = path.resolve(workbookPath);
    if (!fs.existsSync(absWorkbookPath)) {
        throw new Error(`Workbook not found for PDF export: ${absWorkbookPath}`);
    }

    const normalizedTabs = dedupe((tabs || []).map((s) => String(s || '').trim()).filter(Boolean));
    if (!normalizedTabs.length) {
        throw new Error('PDF export is enabled but no tabs were configured (MMX_PDF_EXPORT_TABS)');
    }

    ensureDir(outDir);
    const absOutDir = path.resolve(outDir);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(absWorkbookPath);
    const existingNames = wb.worksheets.map((ws) => ws.name);
    const missing = normalizedTabs.filter((name) => !wb.getWorksheet(name));
    if (missing.length) {
        throw new Error(
            `Configured PDF tabs not found: ${missing.join(', ')}. Available tabs: ${existingNames.join(', ')}`
        );
    }

    const exported = [];
    for (const tabName of normalizedTabs) {
        const safe = sanitizeFilePart(tabName) || 'Sheet';
        const pdfPath = path.join(absOutDir, `${safe}.pdf`);
        log.info(`Exporting tab PDF: "${tabName}" → ${pdfPath}`);
        if (process.platform === 'win32') {
            runWindowsSheetExport(absWorkbookPath, tabName, pdfPath);
        } else {
            await runLibreOfficeSingleTabExport(absWorkbookPath, tabName, pdfPath);
        }
        exported.push({ tabName, pdfPath });
    }

    return exported;
}

module.exports = { exportWorkbookTabsPdf };
