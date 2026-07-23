const scrapeMacromatix = require('./macromatixScraper');

/**
 * Macromatix hourly forecast and actual sales for the dashboard grid - one entry per store.
 */
async function scrapeData(options = {}) {
    const mm = await scrapeMacromatix(options);

    return {
        success: true,
        message: 'Macromatix',
        timestamp: mm.timestamp,
        stores: Array.isArray(mm.stores) ? mm.stores : [],
        scrapeSkipped: Boolean(mm.scrapeSkipped),
    };
}

async function scrapeVendorsData(options = {}) {
    const mm = await scrapeMacromatix.scrapeMacromatixVendorsOnly(options);
    return {
        success: true,
        message: 'Macromatix vendors',
        timestamp: mm.timestamp,
        stores: Array.isArray(mm.stores) ? mm.stores : [],
        scrapeSkipped: Boolean(mm.scrapeSkipped),
    };
}

module.exports = scrapeData;
module.exports.scrapeVendorsData = scrapeVendorsData;
