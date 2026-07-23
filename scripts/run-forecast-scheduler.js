const { loadEnv } = require('../src/loadEnv');
loadEnv();

const { getStoreList } = require('../stores/src/storeList');
const { isAutoSubmitEnabled, readConfig } = require('../forecast/src/forecastConfig');
const { runForecastForStore } = require('../forecast/src/forecastRunner');

const TIME_ZONE = process.env.DASHBOARD_TIME_ZONE || 'Australia/Melbourne';
const HOUR = Number(process.env.FORECAST_SCHEDULE_HOUR || 7);
const WINDOW_MIN = Number(process.env.FORECAST_SCHEDULE_WINDOW_MIN || 30);

function localHourMinute(now = new Date()) {
    const parts = new Intl.DateTimeFormat('en-AU', {
        timeZone: TIME_ZONE,
        hour: 'numeric',
        minute: 'numeric',
        hour12: false,
    }).formatToParts(now);
    const get = (t) => Number(parts.find((p) => p.type === t)?.value || 0);
    return { hour: get('hour'), minute: get('minute') };
}

function localDateKey(now = new Date()) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(now);
}

let lastRunDate = null;

async function tick() {
    const cfg = readConfig();
    const enabled = /^(1|true|yes|on)$/i.test(String(process.env.FORECAST_SCHEDULE_ENABLED || '')) || cfg.scheduleEnabled;
    if (!enabled) return;

    const { hour, minute } = localHourMinute();
    if (hour !== HOUR || minute > WINDOW_MIN) return;

    const today = localDateKey();
    if (lastRunDate === today) return;

    const stores = getStoreList()
        .map((s) => String(s.storeNumber))
        .filter((n) => isAutoSubmitEnabled(n));
    if (!stores.length) {
        console.log('[forecast-scheduler] No auto-submit stores — skipping');
        lastRunDate = today;
        return;
    }

    console.log(`[forecast-scheduler] Running for ${stores.length} store(s)`);
    lastRunDate = today;
    for (const store of stores) {
        try {
            const result = await runForecastForStore(store);
            console.log(`[forecast-scheduler] ${store}: ${result.state}`);
        } catch (err) {
            console.error(`[forecast-scheduler] ${store} failed:`, err.message || err);
        }
    }
}

console.log('[forecast-scheduler] started');
setInterval(() => {
    tick().catch((err) => console.error('[forecast-scheduler]', err.message || err));
}, 60 * 1000);
tick().catch(() => {});
