const fs = require('fs');
const path = require('path');
const paths = require('../../src/paths');

const CONFIG_FILE = path.join(paths.forecast.data, 'config.json');

function defaultConfig() {
    return {
        autoSubmit: {},
        adjustments: {},
        protectedDates: [],
        scheduleEnabled: false,
        updatedAt: null,
    };
}

function readConfig() {
    if (!fs.existsSync(CONFIG_FILE)) return defaultConfig();
    try {
        const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        return {
            ...defaultConfig(),
            ...raw,
            autoSubmit: raw.autoSubmit && typeof raw.autoSubmit === 'object' ? raw.autoSubmit : {},
            adjustments: raw.adjustments && typeof raw.adjustments === 'object' ? raw.adjustments : {},
            protectedDates: Array.isArray(raw.protectedDates) ? raw.protectedDates : [],
        };
    } catch {
        return defaultConfig();
    }
}

function writeConfig(doc) {
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
    const next = { ...doc, updatedAt: new Date().toISOString() };
    fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    return next;
}

function isAutoSubmitEnabled(storeNumber) {
    return Boolean(readConfig().autoSubmit[String(storeNumber)]);
}

function setAutoSubmit(storeNumber, enabled) {
    const doc = readConfig();
    doc.autoSubmit[String(storeNumber)] = Boolean(enabled);
    return writeConfig(doc);
}

function setAdjustment(dateKey, percent) {
    const doc = readConfig();
    if (percent == null || percent === '') {
        delete doc.adjustments[String(dateKey)];
    } else {
        doc.adjustments[String(dateKey)] = Number(percent);
    }
    return writeConfig(doc);
}

function setProtectedDates(dates) {
    const doc = readConfig();
    doc.protectedDates = [...new Set((dates || []).map(String).filter(Boolean))].sort();
    return writeConfig(doc);
}

module.exports = {
    readConfig,
    writeConfig,
    isAutoSubmitEnabled,
    setAutoSubmit,
    setAdjustment,
    setProtectedDates,
};
