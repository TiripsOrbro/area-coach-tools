#!/usr/bin/env node
/**
 * Automatic Orders — scheduled gate checks (8 AM–before 11 PM store time).
 * When the key-item gate is READY and today's pipeline has not run yet,
 * starts the full pipeline (reports → Excel → vendor order entry) once per day.
 * Restarts never run immediately — always wait for the next schedule slot.
 *
 *   npm run automatic-orders
 *
 * Env: MMX_GATE_SCHEDULE_START=8, MMX_GATE_SCHEDULE_END=23 (exclusive — dormant from 11 PM),
 *      MMX_GATE_CHECK_INTERVAL_MINUTES=15, MMX_TIME_ZONE=Australia/Melbourne
 */
const path = require('path');
const { spawn } = require('child_process');
const { ROOT, getSettings } = require('./config');
const { isPipelineDoneToday, msUntilNextGateSession } = require('./util-daily-lock');
const log = require('./util-logging');

const TZ = process.env.MMX_TIME_ZONE || process.env.DASHBOARD_TIME_ZONE || 'Australia/Melbourne';
const START_HOUR = Number(process.env.MMX_GATE_SCHEDULE_START ?? 8);
/** First hour when dormant (exclusive). 23 = active through 10:59 PM, dormant from 11 PM. */
const END_HOUR = Number(process.env.MMX_GATE_SCHEDULE_END ?? 23);
const CHECK_INTERVAL_MINUTES = Math.min(
    60,
    Math.max(1, Number(process.env.MMX_GATE_CHECK_INTERVAL_MINUTES ?? 15) || 15)
);
const GATE_READY_EXIT = 10;

function localHourMinute(now = new Date()) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: TZ,
        hour: 'numeric',
        minute: 'numeric',
        hour12: false,
    }).formatToParts(now);
    const map = Object.fromEntries(parts.filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]));
    return { hour: parseInt(map.hour, 10), minute: parseInt(map.minute, 10) };
}

function isWithinWindow(now = new Date()) {
    const { hour } = localHourMinute(now);
    return hour >= START_HOUR && hour < END_HOUR;
}

function msUntilLocalHour(targetHour, now = new Date()) {
    const { hour, minute } = localHourMinute(now);
    const msIntoMinute = now.getSeconds() * 1000 + now.getMilliseconds();
    if (hour < targetHour) {
        return targetHour * 3600000 - (hour * 3600000 + minute * 60000 + msIntoMinute);
    }
    return (24 - hour + targetHour) * 3600000 - minute * 60000 - msIntoMinute;
}

function msUntilNextWindowOpen(now = new Date()) {
    return Math.max(1000, msUntilLocalHour(START_HOUR, now));
}

function msUntilNextIntervalBoundary(now = new Date()) {
    const { minute } = localHourMinute(now);
    const msIntoMinute = now.getSeconds() * 1000 + now.getMilliseconds();

    if (CHECK_INTERVAL_MINUTES >= 60) {
        if (minute === 0 && msIntoMinute < 5000) return 0;
        return Math.max(1000, (60 - minute) * 60000 - msIntoMinute);
    }

    const slotStart = Math.floor(minute / CHECK_INTERVAL_MINUTES) * CHECK_INTERVAL_MINUTES;
    if (minute === slotStart && msIntoMinute < 5000) return 0;

    const nextMinute = slotStart + CHECK_INTERVAL_MINUTES;
    if (nextMinute >= 60) {
        return Math.max(1000, (60 - minute) * 60000 - msIntoMinute);
    }
    return Math.max(1000, (nextMinute - minute) * 60000 - msIntoMinute);
}

function msUntilNextScheduledCheck(now = new Date()) {
    if (!isWithinWindow(now)) {
        return msUntilNextWindowOpen(now);
    }

    const wait = msUntilNextIntervalBoundary(now);
    const nextAt = new Date(now.getTime() + wait);
    if (!isWithinWindow(nextAt)) {
        return msUntilNextWindowOpen(now);
    }
    return wait;
}

function formatMs(ms) {
    const m = Math.ceil(ms / 60000);
    if (m < 60) return `${m} min`;
    const h = Math.floor(m / 60);
    const rm = m % 60;
    return rm ? `${h}h ${rm}m` : `${h}h`;
}

function formatResumeTime(ms) {
    try {
        return new Date(Date.now() + ms).toLocaleString('en-AU', { timeZone: TZ });
    } catch {
        return formatMs(ms);
    }
}

function windowLabel() {
    const endDisplay = END_HOUR <= 12 ? `${END_HOUR} AM` : END_HOUR === 24 ? 'midnight' : `${END_HOUR - 12} PM`;
    return `${START_HOUR}:00–before ${endDisplay} (${TZ})`;
}

async function sleepUntilNextGateSession(workDir) {
    const wait = msUntilNextGateSession(workDir, { timeZone: TZ, startHour: START_HOUR });
    if (wait == null) return false;
    log.info(
        `Automatic orders already completed today — dormant until tomorrow ~${formatResumeTime(wait)} (${windowLabel()})`
    );
    await sleep(wait);
    return true;
}

function spawnNode(args, label) {
    return new Promise((resolve) => {
        log.info(`Starting ${label}…`);
        const child = spawn(process.execPath, args, {
            cwd: ROOT,
            stdio: 'inherit',
            env: { ...process.env, MMX_KEEP_BROWSER_OPEN: 'false' },
        });
        child.on('exit', (code) => resolve(code ?? 1));
        child.on('error', (err) => {
            log.error(`${label} failed to start: ${err.message}`);
            resolve(1);
        });
    });
}

function runGateCheck() {
    return spawnNode([path.join(ROOT, 'src/run.js'), '--gate-only'], 'gate check');
}

function runFullPipeline() {
    return spawnNode([path.join(ROOT, 'src/run.js')], 'full pipeline (reports → Excel → vendor orders)');
}

async function maybeRunPipelineAfterGate(workDir, gateExitCode) {
    if (gateExitCode !== GATE_READY_EXIT) {
        if (gateExitCode === 0) {
            log.info('Gate not ready yet — will check again on next scheduled interval');
        } else {
            log.warn(`Gate check exited with code ${gateExitCode}`);
        }
        return;
    }
    if (isPipelineDoneToday(workDir, TZ)) {
        log.info('Gate ready but pipeline already completed today — skipping');
        return;
    }
    log.info('Gate READY — launching automatic orders pipeline (once per day)');
    const pipelineCode = await runFullPipeline();
    if (pipelineCode === 0) {
        log.info('Automatic orders pipeline finished successfully — no further runs until tomorrow');
    } else {
        log.warn(`Automatic orders pipeline exited with code ${pipelineCode} — will retry on a later gate check`);
    }
}

async function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

async function main() {
    const { workDir } = getSettings();
    const intervalLabel =
        CHECK_INTERVAL_MINUTES >= 60 ? 'hourly' : `every ${CHECK_INTERVAL_MINUTES} min`;
    log.info(
        `Automatic Orders: ${intervalLabel} gate checks, ${windowLabel()}; full pipeline once per day when gate is READY.`
    );

    // Never run on startup/restart — wait for the next scheduled interval so a
    // mid-day process restart (git pull, crash recovery, reboot) cannot trigger
    // the daily pipeline early.
    if (await sleepUntilNextGateSession(workDir)) {
        // resumed next day
    }

    // eslint-disable-next-line no-constant-condition
    while (true) {
        if (await sleepUntilNextGateSession(workDir)) {
            continue;
        }

        const wait = msUntilNextScheduledCheck();
        const { hour, minute } = localHourMinute();
        if (isWithinWindow()) {
            log.info(
                `Next gate check ~${formatMs(wait)} (local ${hour}:${String(minute).padStart(2, '0')}, every ${CHECK_INTERVAL_MINUTES} min)`
            );
        } else {
            log.info(
                `Outside active window — dormant until ~${formatResumeTime(wait)} (${windowLabel()})`
            );
        }
        await sleep(wait);

        if (await sleepUntilNextGateSession(workDir)) {
            continue;
        }

        if (!isWithinWindow()) {
            continue;
        }

        const gateCode = await runGateCheck();
        await maybeRunPipelineAfterGate(workDir, gateCode);
    }
}

main().catch((err) => {
    log.error(err.message, err.stack);
    process.exit(1);
});
