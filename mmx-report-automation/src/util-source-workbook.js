const path = require('path');
const ExcelJS = require('exceljs');
const XLSX = require('xlsx');

/**
 * Load a Macromatix export (.xls or .xlsx) for read-only mapping into the template.
 * @returns {{ type: 'grid'|'exceljs', name: string, grid?: any[][], wb?: ExcelJS.Workbook }}
 */
async function loadSourceWorkbook(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.csv') {
        const wb = XLSX.readFile(filePath, { type: 'file', raw: false });
        const sheetName = wb.SheetNames[0];
        const sheet = wb.Sheets[sheetName];
        const grid = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, raw: true });
        return { type: 'grid', name: sheetName, grid, sheetNames: wb.SheetNames };
    }
    if (ext === '.xls') {
        const wb = XLSX.readFile(filePath, { cellDates: true });
        const sheetName = wb.SheetNames[0];
        const sheet = wb.Sheets[sheetName];
        const grid = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, raw: true });
        return { type: 'grid', name: sheetName, grid, sheetNames: wb.SheetNames };
    }

    const wb = new ExcelJS.Workbook();
    if (ext === '.xlsx' || ext === '.xlsm') {
        await wb.xlsx.readFile(filePath);
    } else {
        throw new Error(`Unsupported source format: ${ext} (${filePath})`);
    }
    return { type: 'exceljs', wb, sheetNames: wb.worksheets.map((w) => w.name) };
}

function resolveSourceSheet(source, sheetName) {
    if (source.type === 'grid') {
        if (sheetName && sheetName !== source.name && !source.sheetNames.includes(sheetName)) {
            throw new Error(`Sheet "${sheetName}" not found in source (has: ${source.sheetNames.join(', ')})`);
        }
        return { type: 'grid', grid: source.grid };
    }

    const ws =
        source.wb.getWorksheet(sheetName) ||
        source.wb.worksheets.find((w) => w.name === sheetName) ||
        source.wb.worksheets[0];
    if (!ws) throw new Error(`No worksheets in source`);
    return { type: 'exceljs', ws };
}

function getSourceCell(sourceSheet, row, col) {
    let val;
    if (sourceSheet.type === 'grid') {
        const r = sourceSheet.grid[row - 1];
        if (!r) return null;
        val = r[col - 1] ?? null;
    } else {
        val = sourceSheet.ws.getCell(row, col).value;
        if (val && typeof val === 'object' && val.result !== undefined) val = val.result;
        else if (val && typeof val === 'object' && val.text) val = val.text;
    }
    return normalizePasteCellValue(val);
}

/**
 * Coerce report values to Excel-friendly types so pasted cells stay numeric (no leading ' text prefix).
 */
function normalizePasteCellValue(val) {
    if (val == null || val === '') return null;
    if (val instanceof Date) return val;
    if (typeof val === 'number' && Number.isFinite(val)) return val;
    if (typeof val === 'boolean') return val;

    if (typeof val === 'string') {
        let s = val.trim();
        if (s.startsWith("'")) s = s.slice(1).trim();
        if (s === '') return null;

        const plainNum = /^-?(?:\d+\.?\d*|\.\d+)$/;
        if (plainNum.test(s)) return Number(s);

        const currencyNum = /^\$?\s*-?(?:\d{1,3}(?:,\d{3})*|\d+)(?:\.\d+)?$/;
        if (currencyNum.test(s)) {
            const n = Number(s.replace(/[$,\s]/g, ''));
            if (Number.isFinite(n)) return n;
        }

        return s;
    }

    return val;
}

function gridUsedBounds(grid) {
    let endRow = 0;
    let endCol = 0;
    for (let r = 0; r < grid.length; r++) {
        const row = grid[r] || [];
        for (let c = 0; c < row.length; c++) {
            const v = row[c];
            if (v !== null && v !== undefined && v !== '') {
                endRow = Math.max(endRow, r + 1);
                endCol = Math.max(endCol, c + 1);
            }
        }
    }
    return { endRow: endRow || 1, endCol: endCol || 1 };
}

function resolveSourceRange(sourceSheet, fromRange) {
    if (fromRange !== 'auto') return parseRangeStatic(fromRange);
    if (sourceSheet.type !== 'grid') return parseRangeStatic('A1:ZZ500');
    const { endRow, endCol } = gridUsedBounds(sourceSheet.grid);
    return {
        startCol: 1,
        startRow: 1,
        endCol,
        endRow,
    };
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

function parseCellRef(ref) {
    const m = String(ref).match(/^([^!]+)!([A-Z]+)(\d+)$/i);
    if (!m) {
        const m2 = String(ref).match(/^([A-Z]+)(\d+)$/i);
        if (!m2) throw new Error(`Invalid cell ref: ${ref}`);
        return { sheet: null, col: colLettersToNum(m2[1]), row: parseInt(m2[2], 10) };
    }
    return { sheet: m[1], col: colLettersToNum(m[2]), row: parseInt(m[3], 10) };
}

function colLettersToNum(letters) {
    let n = 0;
    const s = letters.toUpperCase();
    for (let i = 0; i < s.length; i++) {
        n = n * 26 + (s.charCodeAt(i) - 64);
    }
    return n;
}

module.exports = {
    loadSourceWorkbook,
    resolveSourceSheet,
    getSourceCell,
    normalizePasteCellValue,
    resolveSourceRange,
    parseCellRef,
    colLettersToNum,
};
