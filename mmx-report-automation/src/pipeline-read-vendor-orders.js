const ExcelJS = require('exceljs');
const { colLettersToNum } = require('./util-source-workbook');
const { ceilOrderQuantity } = require('./util-quantity');
const log = require('./util-logging');

function cellPlainValue(cell) {
    if (!cell || cell.value == null) return null;
    let v = cell.value;
    if (typeof v === 'object') {
        if (v.result !== undefined && v.result !== null) v = v.result;
        else if (v.text) v = v.text;
        else if (v.formula) return null;
        else if (v.error) return null;
    }
    return v;
}

function cellString(cell) {
    const v = cellPlainValue(cell);
    if (v == null) return '';
    return String(v).trim();
}

function readSheetOrderLines(ws, excelCfg) {
    const codeCol = colLettersToNum(excelCfg.itemCodeColumn || 'L');
    const qtyCol = colLettersToNum(excelCfg.quantityColumn || 'K');
    const startRow = Number(excelCfg.dataStartRow) || 6;
    const minQty = Number(excelCfg.minQuantity) || 0.001;
    const lines = [];

    for (let r = startRow; r <= (ws.rowCount || 0); r++) {
        const code = cellString(ws.getCell(r, codeCol));
        if (!code || code === 'MMX item codes' || /^#/.test(code)) continue;

        const qtyRaw = cellPlainValue(ws.getCell(r, qtyCol));
        const qty = ceilOrderQuantity(qtyRaw);
        if (qty < minQty) continue;

        const name = cellString(ws.getCell(r, colLettersToNum('E'))) || cellString(ws.getCell(r, colLettersToNum('B')));
        lines.push({
            itemCode: code,
            quantity: qty,
            itemName: name,
            sheet: ws.name,
            row: r,
        });
    }
    return lines;
}

async function readVendorOrderLines(templatePath, vendorOrdersCfg, vendorId) {
    const vendor = (vendorOrdersCfg.vendors || []).find((v) => v.id === vendorId);
    if (!vendor) throw new Error(`Unknown vendor id: ${vendorId}`);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(templatePath);

    const excelCfg = vendorOrdersCfg.excel || {};
    const lines = [];

    for (const sheetName of vendor.excelSheets || []) {
        const ws = wb.getWorksheet(sheetName);
        if (!ws) {
            log.warn(`Sheet not found: "${sheetName}" (vendor ${vendor.id})`);
            continue;
        }
        const sheetLines = readSheetOrderLines(ws, excelCfg);
        log.info(`Sheet "${sheetName}": ${sheetLines.length} order line(s) with qty > 0`);
        lines.push(...sheetLines);
    }

    return { vendor, lines };
}

async function readAllVendorOrderLines(templatePath, vendorOrdersCfg) {
    const out = {};
    for (const vendor of vendorOrdersCfg.vendors || []) {
        const { lines } = await readVendorOrderLines(templatePath, vendorOrdersCfg, vendor.id);
        if (lines.length) out[vendor.id] = { vendor, lines };
    }
    return out;
}

module.exports = {
    readVendorOrderLines,
    readAllVendorOrderLines,
    readSheetOrderLines,
    cellPlainValue,
};
