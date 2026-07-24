#!/usr/bin/env node
/**
 * Excel-only: merge sample reports into Build To JS.xlsx — no Macromatix login.
 *
 *   npm run excel-only
 *   npm run excel-only -- path/to/report1.xlsx path/to/report2.xlsx
 */
const path = require('path');
const fs = require('fs');
const { getSettings, ROOT, loadJson, logTemplateLocalChoice } = require('./config');
const { runExcelTransform } = require('./pipeline-excel-transform');
const { copyFileSafe, ensureDir, timestampSlug } = require('./util-files');
const log = require('./util-logging');

function resolveSampleReports(settings, cliPaths) {
    if (cliPaths.length) {
        const out = {};
        cliPaths.forEach((p, i) => {
            const abs = path.resolve(p);
            if (!fs.existsSync(abs)) throw new Error(`File not found: ${abs}`);
            const id = i === 0 ? 'report1' : i === 1 ? 'report2' : `report${i + 1}`;
            out[id] = abs;
        });
        return out;
    }

    const samplesDir = path.join(settings.downloadDir, 'samples');
    const pairs = [
        ['report1', 'Stock On Hand.xls'],
        ['report2', 'Stock On Order.xls'],
        ['report1', 'report1.xlsx'],
        ['report2', 'report2.xlsx'],
    ];
    const out = {};
    for (const [id, name] of pairs) {
        if (out[id]) continue;
        const p = path.join(samplesDir, name);
        if (fs.existsSync(p)) out[id] = p;
    }
    if (!out.report1 || !out.report2) {
        throw new Error(
            `Place sample exports in ${samplesDir}:\n` +
                `  Stock On Hand.xls + Stock On Order.xls\n` +
                `  (or report1.xlsx + report2.xlsx)\n` +
                `Or: npm run excel-only -- <file1> <file2>`
        );
    }
    return out;
}

function backupWorkbook(templatePath, outDir) {
    if (!fs.existsSync(templatePath)) {
        throw new Error(
            `Template not found: ${templatePath}\n` +
                `Set MMX_TEMPLATE_ONEDRIVE / MMX_TEMPLATE_PI / MMX_TEMPLATE_FALLBACK in .env (see .env.example).`
        );
    }
    ensureDir(outDir);
    const backup = path.join(outDir, `Build To JS-${timestampSlug()}.xlsx`);
    copyFileSafe(templatePath, backup);
    log.info(`Backup before merge: ${backup}`);
}

async function main() {
    const cliPaths = process.argv.slice(2).filter((a) => !a.startsWith('-'));
    loadJson('config/excel-mapping.json');

    const settings = getSettings();
    settings.templateAlwaysCopy = false;
    settings.templateSource = null;
    settings.templatePublish = null;

    logTemplateLocalChoice(settings);

    const templatePath = settings.templateLocal;
    backupWorkbook(templatePath, settings.outDir);

    const reportPaths = resolveSampleReports(settings, cliPaths);
    log.info('Source reports:', reportPaths);

    const result = await runExcelTransform(settings, reportPaths);
    log.info('');
    log.info('=== Open in Excel (mmx-report-automation) ===');
    log.info(result.templatePath);
    if (result.syncedPaths?.length) {
        log.info('Extra copies (MMX_TEMPLATE_SYNC):');
        result.syncedPaths.forEach((p) => log.info(`  ${p}`));
    }
    if (result.exportedPdfTabs?.length) {
        log.info('Exported tab PDFs:');
        result.exportedPdfTabs.forEach((item) => log.info(`  ${item.tabName}: ${item.pdfPath}`));
    }
    log.info('Paste payload (for later MMX step):', result.pasteValuesPath);
    process.exit(0);
}

main().catch((err) => {
    log.error(err.message, err.stack);
    process.exit(1);
});
