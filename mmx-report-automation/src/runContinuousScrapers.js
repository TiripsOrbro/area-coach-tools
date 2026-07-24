#!/usr/bin/env node
/**
 * Delegates to live-dashboard-app continuous sales workers (replacement for the old scraper).
 *
 *   npm run continuous-scrapers
 */
const path = require('path');
const { spawn } = require('child_process');
const log = require('./util-logging');

const DASHBOARD_ROOT = path.resolve(__dirname, '..', '..', 'live-dashboard-app');
const TEST_SCRIPT = path.join(DASHBOARD_ROOT, 'scripts', 'test-continuous-scrapers.js');

const RUN_SCRIPT = path.join(DASHBOARD_ROOT, 'scripts', 'run-continuous-scrapers.js');

function main() {
    const testMinutes = String(process.env.TEST_DURATION_MINUTES || '').trim();
    const script = testMinutes ? TEST_SCRIPT : RUN_SCRIPT;
    log.info(`Starting live-dashboard continuous scrapers from ${DASHBOARD_ROOT}`);
    const child = spawn(process.execPath, [script], {
        cwd: DASHBOARD_ROOT,
        stdio: 'inherit',
        env: {
            ...process.env,
            SCRAPER_PERSISTENT_SESSIONS: process.env.SCRAPER_PERSISTENT_SESSIONS || '1',
            SCRAPER_CONTINUOUS_WORKERS: process.env.SCRAPER_CONTINUOUS_WORKERS || '1',
            ...(testMinutes ? { TEST_DURATION_MINUTES: testMinutes } : {}),
        },
    });
    child.on('exit', (code) => process.exit(code ?? 1));
    child.on('error', (err) => {
        log.error(`Failed to start dashboard continuous scrapers: ${err.message}`);
        process.exit(1);
    });
}

if (require.main === module) {
    main();
}
