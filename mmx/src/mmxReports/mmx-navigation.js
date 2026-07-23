const log = require('./util-logging');
const { openReportSelectionPage, setGroupDropdown } = require('./pipeline-supply-chain-reports');

async function navigateToSupplyChainReports(page, reportNav, navTimeoutMs) {
    if (!reportNav || !reportNav.url || reportNav.url.includes('REPLACE')) {
        throw new Error('reportNavigation.url not configured in config/reports-pipeline.json');
    }

    await openReportSelectionPage(page, reportNav, navTimeoutMs);
    if (reportNav.group) {
        await setGroupDropdown(page, reportNav.group);
    }
    log.info('Report Selection open (Supply Chain group)');
}

module.exports = { navigateToSupplyChainReports };
