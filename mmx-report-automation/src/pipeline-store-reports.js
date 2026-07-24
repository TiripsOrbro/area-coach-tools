const { withPageContextRetry } = require('./mmx-context-retry');
const { resolveReportDate } = require('./util-dates');
const {
    openReportSelectionPage,
    setGroupDropdown,
    selectReportInList,
    setReportFormat,
    setStartDate,
    selectStore,
    clickGenerate,
} = require('./pipeline-supply-chain-reports');

function dateOpts(report) {
    return { timeZone: report.timeZone, dateOnly: Boolean(report.dateOnly) };
}

async function configureAndGenerateStoreReport(page, report, reportNav) {
    await openReportSelectionPage(page, reportNav, report.navTimeoutMs || 45000);
    await setGroupDropdown(page, report.group || 'Store Reports');
    await selectReportInList(page, report.reportName, { loose: true });
    await page.waitForTimeout(2000);
    await setReportFormat(page, report.format || 'CSV');
    await page.waitForTimeout(1000);

    const startDate = resolveReportDate(report.startDate || 'yesterday', dateOpts(report));
    await setStartDate(page, startDate);

    if (report.storeName) {
        await selectStore(page, report.storeName, {
            waitMs: 1500,
            optional: Boolean(report.storeOptional),
        });
    }

    await clickGenerate(page, report.generateButtonText || 'Generate');
}

async function runStoreReport(page, report, settings) {
    const reportNav = settings.pipeline.reportNavigation;
    if (!reportNav?.url) {
        throw new Error('pipeline.reportNavigation.url is required');
    }

    const cfg = {
        ...report,
        navTimeoutMs: settings.navTimeoutMs,
    };

    await withPageContextRetry(page, `store report ${report.id}`, async () => {
        await configureAndGenerateStoreReport(page, cfg, reportNav);
    });
}

function isStoreReport(report) {
    return report.type === 'storeReports';
}

module.exports = {
    configureAndGenerateStoreReport,
    runStoreReport,
    isStoreReport,
};
