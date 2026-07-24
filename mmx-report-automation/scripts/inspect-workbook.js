#!/usr/bin/env node
/** List sheets and first-row headers for .xlsx or .xls (discovery helper). */
const path = require('path');
const ExcelJS = require('exceljs');
const XLSX = require('xlsx');

const file = process.argv[2] || path.join(__dirname, '../data/workbooks/Build To JS.xlsx');

function previewGrid(grid, label) {
    const r1 = grid[0] || [];
    const r2 = grid[1] || [];
    const parts = r1.slice(0, 20).map((v, i) => `${i + 1}:${String(v ?? '')}`);
    if (parts.length) console.log(`  ${label} 1:`, parts.join(' | '));
    const s2 = r2.slice(0, 10).map((v) => String(v ?? ''));
    if (s2.length) console.log(`  ${label} 2:`, s2.join(' | '));
}

async function inspectXlsx(filePath) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(filePath);
    console.log('File:', filePath, '(xlsx)');
    for (const ws of wb.worksheets) {
        console.log(`\nSheet: "${ws.name}" (${ws.rowCount} rows x ${ws.columnCount} cols)`);
        const row = ws.getRow(1);
        const parts = [];
        row.eachCell({ includeEmpty: false }, (cell, col) => {
            if (col <= 20) parts.push(`${col}:${String(cell.value ?? '')}`);
        });
        if (parts.length) console.log('  Row 1:', parts.join(' | '));
        const sample = ws.getRow(2);
        const s2 = [];
        sample.eachCell({ includeEmpty: false }, (cell, col) => {
            if (col <= 10) s2.push(String(cell.value ?? ''));
        });
        if (s2.length) console.log('  Row 2:', s2.join(' | '));
    }
}

function inspectXls(filePath) {
    const wb = XLSX.readFile(filePath, { cellDates: true });
    console.log('File:', filePath, '(xls)');
    for (const name of wb.SheetNames) {
        const grid = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '' });
        console.log(`\nSheet: "${name}" (${grid.length} rows)`);
        previewGrid(grid, 'Row');
    }
}

(async () => {
    const ext = path.extname(file).toLowerCase();
    if (ext === '.xls') inspectXls(file);
    else await inspectXlsx(file);
})().catch((e) => {
    console.error(e.message);
    process.exit(1);
});
