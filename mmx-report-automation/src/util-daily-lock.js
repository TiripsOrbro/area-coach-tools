const fs = require('fs');
const path = require('path');

function resolveTimeZone(timeZone) {
    return timeZone || process.env.MMX_TIME_ZONE || process.env.DASHBOARD_TIME_ZONE || 'Australia/Melbourne';
}

function todayKey(timeZone, date = new Date()) {
    const tz = resolveTimeZone(timeZone);
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
        date
    );
}

function localHourMinute(timeZone, date = new Date()) {
    const tz = resolveTimeZone(timeZone);
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric',
        hour12: false,
    }).formatToParts(date);
    const map = Object.fromEntries(parts.filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]));
    return {
        hour: parseInt(map.hour, 10),
        minute: parseInt(map.minute, 10),
        second: parseInt(map.second, 10),
    };
}

/** Milliseconds until the store calendar date rolls over (next local midnight). */
function msUntilNextCalendarDay(timeZone) {
    const tz = resolveTimeZone(timeZone);
    const now = Date.now();
    const today = todayKey(tz);

    for (let h = 1; h <= 30; h++) {
        const candidate = now + h * 3600000;
        if (todayKey(tz, new Date(candidate)) !== today) {
            let lo = now + (h - 1) * 3600000;
            let hi = candidate;
            while (hi - lo > 60000) {
                const mid = Math.floor((lo + hi) / 2);
                if (todayKey(tz, new Date(mid)) === today) lo = mid;
                else hi = mid;
            }
            return Math.max(60000, hi - now);
        }
    }
    return 24 * 3600000;
}

/**
 * When the full pipeline already completed today, how long until gate-watch should resume
 * (next calendar day at schedule start hour).
 */
function msUntilNextGateSession(workDir, { timeZone, startHour = 9 } = {}) {
    if (!isPipelineDoneToday(workDir, timeZone)) return null;

    const tz = resolveTimeZone(timeZone);
    let ms = msUntilNextCalendarDay(tz);
    const target = new Date(Date.now() + ms);
    const { hour, minute, second } = localHourMinute(tz, target);

    if (hour < startHour) {
        ms += (startHour - hour) * 3600000 - minute * 60000 - second * 1000;
    }
    return Math.max(60000, ms);
}

function lockPath(workDir) {
    return path.join(workDir, 'out', 'pipeline-complete-today.json');
}

function isPipelineDoneToday(workDir, timeZone) {
    const p = lockPath(workDir);
    if (!fs.existsSync(p)) return false;
    try {
        const data = JSON.parse(fs.readFileSync(p, 'utf8'));
        return data.date === todayKey(timeZone);
    } catch {
        return false;
    }
}

function markPipelineDoneToday(workDir, meta = {}, timeZone) {
    const p = lockPath(workDir);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(
        p,
        JSON.stringify(
            {
                date: todayKey(timeZone),
                completedAt: new Date().toISOString(),
                ...meta,
            },
            null,
            2
        ),
        'utf8'
    );
}

function clearPipelineDoneToday(workDir) {
    const p = lockPath(workDir);
    if (fs.existsSync(p)) fs.unlinkSync(p);
}

module.exports = {
    todayKey,
    resolveTimeZone,
    localHourMinute,
    lockPath,
    isPipelineDoneToday,
    markPipelineDoneToday,
    clearPipelineDoneToday,
    msUntilNextCalendarDay,
    msUntilNextGateSession,
};
