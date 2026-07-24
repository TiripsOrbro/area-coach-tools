/**
 * Global admin job queue — Activity shows items as queued until a slot opens.
 * Default concurrency 1 (MMX / Excel contention). Override with ADMIN_JOB_CONCURRENCY.
 */

const activity = require('./activityTracker');
const { envConcurrency } = require('./shared/concurrency');

const concurrency = envConcurrency('ADMIN_JOB_CONCURRENCY', 1);

/** @type {{ id: string, work: Function, resolve: Function, reject: Function }[]} */
const pending = [];
let running = 0;

function queueDepth() {
    return pending.length + running;
}

/**
 * Create a queued activity entry and run `work` when a slot is free.
 * `work({ id, progress, update })` should call activity.end itself, or return
 * `{ ok, detail, error }` for the queue to end the entry.
 *
 * @param {object} meta activity.start meta (kind, title, storeNumber, …)
 * @param {(ctx: { id: string, progress: Function, update: Function }) => Promise<any>} work
 */
function enqueue(meta, work) {
    const id = activity.start({
        ...meta,
        status: 'queued',
        detail: meta.detail != null ? String(meta.detail) : 'Queued…',
    });

    return new Promise((resolve, reject) => {
        pending.push({
            id,
            work,
            resolve,
            reject,
            endsActivity: meta.endsActivity !== false,
        });
        pump();
    });
}

function pump() {
    while (running < concurrency && pending.length) {
        const job = pending.shift();
        running += 1;
        activity.markRunning(job.id, 'Starting…');

        Promise.resolve()
            .then(() =>
                job.work({
                    id: job.id,
                    progress: (message) => activity.progress(job.id, message),
                    update: (patch) => activity.update(job.id, patch),
                })
            )
            .then((outcome) => {
                if (job.endsActivity && activity.get(job.id)) {
                    const ok = outcome?.ok !== false;
                    activity.end(job.id, {
                        ok,
                        error: outcome?.error || null,
                        detail: outcome?.detail || (ok ? 'Done' : 'Failed'),
                    });
                }
                job.resolve(outcome);
            })
            .catch((err) => {
                if (job.endsActivity && activity.get(job.id)) {
                    activity.end(job.id, {
                        ok: false,
                        error: err.message || String(err),
                        detail: err.message || 'Failed',
                    });
                }
                job.reject(err);
            })
            .finally(() => {
                running -= 1;
                pump();
            });
    }
}

module.exports = {
    enqueue,
    queueDepth,
    concurrency,
};
