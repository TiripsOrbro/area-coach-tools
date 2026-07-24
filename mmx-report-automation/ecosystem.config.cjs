/**
 * PM2 — Automatic Orders (gate watch + full pipeline when ready).
 *
 *   pm2 start ecosystem.config.cjs
 *   pm2 save
 *   pm2 startup   # follow the printed command so it survives Pi reboot
 */
const path = require('path');
const fs = require('fs');
const { platformEnvSuffix } = require('./src/util-platform');

const ROOT = __dirname;

function loadEnvFile(name) {
    const p = path.join(ROOT, name);
    if (!fs.existsSync(p)) return {};
    const out = {};
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq <= 0) continue;
        const key = trimmed.slice(0, eq).trim();
        let val = trimmed.slice(eq + 1).trim();
        if (
            (val.startsWith('"') && val.endsWith('"')) ||
            (val.startsWith("'") && val.endsWith("'"))
        ) {
            val = val.slice(1, -1);
        }
        out[key] = val;
    }
    return out;
}

const env = {
    ...loadEnvFile('.env'),
    ...loadEnvFile(`.env.${platformEnvSuffix()}`),
    ...loadEnvFile('.env.production'),
    NODE_ENV: 'production',
};

module.exports = {
    apps: [
        {
            name: 'automatic-orders',
            cwd: ROOT,
            script: 'src/runGateScheduler.js',
            interpreter: 'node',
            autorestart: true,
            max_restarts: 100,
            min_uptime: '10s',
            restart_delay: 15000,
            exp_backoff_restart_delay: 1000,
            kill_timeout: 60000,
            env,
        },
    ],
};
