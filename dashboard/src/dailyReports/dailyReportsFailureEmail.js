const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function formatDateShort(isoDate) {
    const m = String(isoDate || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return String(isoDate || '');
    return `${m[3]}/${m[2]}/${m[1].slice(-2)}`;
}

function weekdayName(isoDate) {
    const dt = new Date(`${isoDate}T12:00:00`);
    if (Number.isNaN(dt.getTime())) return '';
    return WEEKDAY_NAMES[dt.getDay()] || '';
}

function formatHourLabel(label) {
    const raw = String(label || '').trim();
    if (!raw) return '';
    const match = raw.match(/^(\d{1,2}):00\s*(AM|PM)$/i);
    if (match) return `${match[1]}${match[2].toUpperCase()}`;
    return raw.replace(/\s+/g, ' ');
}

/**
 * @param {Array<{ storeNumber: string, storeName?: string, stockError?: string|null, forecastLines?: string[], iseError?: string|null, subscriptionErrors?: string[] }>} storeFailures
 */
function formatFailedAutomatedReportsBody(storeFailures) {
    const blocks = [];
    for (const row of storeFailures || []) {
        const storeLabel = `${row.storeName || 'Store'} ${row.storeNumber}`.trim();
        const lines = [`Store Name: ${storeLabel}`];
        if (row.stockError) lines.push('Stock levels report failed to download');
        if (row.iseError) lines.push('ISE report failed to download');
        for (const subErr of row.subscriptionErrors || []) {
            lines.push(subErr);
        }
        const forecastLines = row.forecastLines || [];
        if (forecastLines.length) {
            lines.push('Forecasting failed for the following dates and times');
            lines.push(...forecastLines);
        } else if (row.forecastError) {
            lines.push('Forecasting failed for the following dates and times');
            lines.push(row.forecastError);
        }
        if (lines.length > 1) blocks.push(lines.join('\n'));
    }
    return blocks.join('\n\n');
}

function extractForecastFailureLines(combinedResult) {
    const lines = [];
    const mmx = combinedResult?.mmxResults?.[0];
    const ll = combinedResult?.lifelenzResults?.[0];

    const pushFromError = (error) => {
        const text = String(error || '').trim();
        if (!text) return;
        const dateMatch = text.match(/for (\d{4}-\d{2}-\d{2})/i);
        const hourMatches = [...text.matchAll(/(\d{1,2}:\d{2}\s*[AP]M)/gi)].map((m) => m[1]);
        if (dateMatch) {
            const iso = dateMatch[1];
            const day = weekdayName(iso);
            const short = formatDateShort(iso);
            if (hourMatches.length === 1) {
                lines.push(`${day} ${short} ${formatHourLabel(hourMatches[0])}`);
            } else if (hourMatches.length > 1) {
                for (const hour of hourMatches) {
                    lines.push(`${day} ${short} ${formatHourLabel(hour)}`);
                }
            } else {
                lines.push(`${day} ${short} full day`);
            }
            return;
        }
        lines.push(text);
    };

    if (mmx && mmx.ok === false) pushFromError(mmx.error);
    if (ll && ll.ok === false) pushFromError(ll.error);

    if (!lines.length && combinedResult && storeRunFailed(combinedResult)) {
        lines.push('Forecast auto-submit failed');
    }
    return [...new Set(lines)];
}

function storeRunFailed(row) {
    const mmxOk = (row.mmxResults || []).length > 0 && (row.mmxResults || []).every((r) => r.ok);
    const llResults = row.lifelenzResults || [];
    const llOk = row.lifelenzSkipped === true || (llResults.length > 0 && llResults.every((r) => r.ok));
    return !mmxOk || !llOk;
}

async function sendFailedAutomatedReportsEmail(storeFailures, { dateKey, sendEmail, postWebhook, alertsEnabled }) {
    const failures = (storeFailures || []).filter(
        (row) =>
            row.stockError ||
            row.iseError ||
            row.forecastError ||
            (row.forecastLines && row.forecastLines.length) ||
            (row.subscriptionErrors && row.subscriptionErrors.length)
    );
    if (!failures.length) return { sent: false, reason: 'no-failures' };
    if (!alertsEnabled()) return { sent: false, reason: 'alerts-disabled' };

    const body = formatFailedAutomatedReportsBody(failures);
    const subject = 'Failed Automated Reports';
    const message = `[TBA Dashboard] Failed Automated Reports\nDate: ${dateKey}\n\n${body}`;
    const tasks = [];
    if (postWebhook) {
        tasks.push(postWebhook(message).catch(() => {}));
    }
    if (sendEmail) {
        tasks.push(sendEmail(message, subject).catch(() => {}));
    }
    await Promise.all(tasks);
    return { sent: true, failureCount: failures.length };
}

module.exports = {
    formatFailedAutomatedReportsBody,
    extractForecastFailureLines,
    storeRunFailed,
    sendFailedAutomatedReportsEmail,
    formatDateShort,
    weekdayName,
    formatHourLabel,
};
