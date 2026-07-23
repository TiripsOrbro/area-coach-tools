const log = require('./mmxReports/util-logging');

/**
 * Wrap an async pipeline stage, logging its wall-clock duration so we can see where
 * time goes (the goal: only the Macromatix report-generation stages should be slow).
 * Returns whatever `fn` resolves to. `onTiming` is best-effort and never throws.
 */
async function timeStage(label, fn, onTiming) {
    const startedAt = Date.now();
    try {
        return await fn();
    } finally {
        const ms = Date.now() - startedAt;
        log.info(`[timing] ${label}: ${ms}ms`);
        if (typeof onTiming === 'function') {
            try {
                onTiming({ label, ms });
            } catch {
                /* timing is diagnostic only - never fail the pipeline over it */
            }
        }
    }
}

/** Pretty one-line summary for a list of {label, ms} timings. */
function formatTimings(timings = []) {
    if (!timings.length) return 'no stages recorded';
    const total = timings.reduce((sum, t) => sum + (Number(t.ms) || 0), 0);
    const parts = timings.map((t) => `${t.label}=${Math.round(Number(t.ms) || 0)}ms`);
    return `${parts.join(', ')} (total ${Math.round(total)}ms)`;
}

module.exports = { timeStage, formatTimings };
