/**
 * Env-driven limited parallelism for store jobs (daily reports, forecast, backfill).
 * Defaults stay at 1 so Pi / 4gb profiles remain sequential unless overridden.
 */

function envConcurrency(name, fallback = 1) {
    const n = Number(process.env[name]);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
    const fb = Number(fallback);
    return Math.max(1, Number.isFinite(fb) && fb > 0 ? Math.floor(fb) : 1);
}

/**
 * Map `items` with at most `concurrency` async workers. Preserves input order in the result array.
 * @template T, R
 * @param {T[]} items
 * @param {number} concurrency
 * @param {(item: T, index: number) => Promise<R>} mapper
 * @returns {Promise<R[]>}
 */
async function mapWithConcurrency(items, concurrency, mapper) {
    const list = Array.isArray(items) ? items : [];
    if (!list.length) return [];
    const limit = Math.max(1, Math.min(Math.floor(Number(concurrency)) || 1, list.length));
    const results = new Array(list.length);
    let next = 0;

    async function worker() {
        for (;;) {
            const i = next;
            next += 1;
            if (i >= list.length) return;
            results[i] = await mapper(list[i], i);
        }
    }

    await Promise.all(Array.from({ length: limit }, () => worker()));
    return results;
}

module.exports = {
    envConcurrency,
    mapWithConcurrency,
};
