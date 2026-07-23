/**
 * Optional scrape-failure alerts via webhook and/or SMTP email.
 * Configure in `.env` - all vars optional; alerts are rate-limited.
 */
const ALERT_COOLDOWN_MS = Number(process.env.DASHBOARD_ALERT_COOLDOWN_MS || 30 * 60 * 1000);
const TIME_ZONE = String(process.env.DASHBOARD_TIME_ZONE || 'Australia/Melbourne').trim();

let lastAlertAt = 0;
let lastAlertMessage = '';
/** @type {Map<string, string>} category+date → sent */
const lastScheduledAlertByKey = new Map();

function alertsEnabled() {
    return Boolean(
        String(process.env.DASHBOARD_ALERT_WEBHOOK_URL || '').trim() ||
            (String(process.env.DASHBOARD_ALERT_EMAIL || '').trim() &&
                String(process.env.DASHBOARD_SMTP_HOST || '').trim())
    );
}

function shouldSendAlert(message) {
    if (!alertsEnabled()) return false;
    const now = Date.now();
    if (now - lastAlertAt < ALERT_COOLDOWN_MS && message === lastAlertMessage) return false;
    lastAlertAt = now;
    lastAlertMessage = message;
    return true;
}

async function postWebhook(message) {
    const url = String(process.env.DASHBOARD_ALERT_WEBHOOK_URL || '').trim();
    if (!url) return;
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            content: message,
            text: message,
        }),
    });
    if (!res.ok) {
        throw new Error(`Webhook alert failed (${res.status})`);
    }
}

function melbourneDateKey(now = new Date()) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(
        now instanceof Date ? now : new Date(now)
    );
}

function shouldSendScheduledAlert(category, dateKey) {
    if (!alertsEnabled()) return false;
    const key = `${String(category || 'scheduled').trim()}:${dateKey}`;
    if (lastScheduledAlertByKey.get(key)) return false;
    lastScheduledAlertByKey.set(key, dateKey);
    if (lastScheduledAlertByKey.size > 64) {
        const keep = [...lastScheduledAlertByKey.keys()].slice(-32);
        for (const oldKey of lastScheduledAlertByKey.keys()) {
            if (!keep.includes(oldKey)) lastScheduledAlertByKey.delete(oldKey);
        }
    }
    return true;
}

async function sendEmail(message, subject = 'TBA Dashboard - scrape failure') {
    const to = String(process.env.DASHBOARD_ALERT_EMAIL || '').trim();
    const host = String(process.env.DASHBOARD_SMTP_HOST || '').trim();
    if (!to || !host) return;

    let nodemailer;
    try {
        nodemailer = require('nodemailer');
    } catch {
        console.warn('[Alert] nodemailer not installed - run npm install to enable email alerts');
        return;
    }

    const port = Number(process.env.DASHBOARD_SMTP_PORT || 587);
    const user = String(process.env.DASHBOARD_SMTP_USER || '').trim();
    const pass = String(process.env.DASHBOARD_SMTP_PASS || '').trim();
    const from = String(process.env.DASHBOARD_SMTP_FROM || user || 'dashboard@localhost').trim();

    const transporter = nodemailer.createTransport({
        host,
        port,
        secure: port === 465,
        auth: user ? { user, pass } : undefined,
    });

    await transporter.sendMail({
        from,
        to,
        subject: String(subject || 'TBA Dashboard alert').trim(),
        text: message,
    });
}

async function notifyScrapeFailure(error, context = 'background refresh') {
    const msg = `[TBA Dashboard] Scrape failed (${context}): ${error?.message || String(error)}`;
    if (!shouldSendAlert(msg)) return;

    console.warn('[Alert] Sending scrape failure notification');
    const tasks = [];
    if (process.env.DASHBOARD_ALERT_WEBHOOK_URL) {
        tasks.push(postWebhook(msg).catch((e) => console.warn('[Alert] Webhook failed:', e.message)));
    }
    if (process.env.DASHBOARD_ALERT_EMAIL && process.env.DASHBOARD_SMTP_HOST) {
        tasks.push(sendEmail(msg).catch((e) => console.warn('[Alert] Email failed:', e.message)));
    }
    await Promise.all(tasks);
}

/**
 * Email/webhook digest when a scheduled 7 AM job fails (report subscriptions, daily stock reports, etc.).
 * @param {string} category - e.g. report-subscriptions, daily-stock-reports
 * @param {Array<{label: string, error: string}>} failures
 * @param {{ title?: string, dateKey?: string }} [options]
 */
async function notifyScheduledJobFailures(category, failures, options = {}) {
    const rows = (failures || []).filter((row) => row?.label && row?.error);
    if (!rows.length) return;

    const dateKey = options.dateKey || melbourneDateKey();
    if (!shouldSendScheduledAlert(category, dateKey)) return;

    const title = options.title || `Scheduled job failures (${category})`;
    const lines = rows.map((row) => `- ${row.label}: ${row.error}`).join('\n');
    const message = `[TBA Dashboard] ${title}\nDate: ${dateKey}\n\n${lines}`;
    const subject = `TBA Dashboard — ${title} (${dateKey})`;

    console.warn(`[Alert] Sending ${rows.length} scheduled failure(s) for ${category}`);
    const tasks = [];
    if (process.env.DASHBOARD_ALERT_WEBHOOK_URL) {
        tasks.push(postWebhook(message).catch((e) => console.warn('[Alert] Webhook failed:', e.message)));
    }
    if (process.env.DASHBOARD_ALERT_EMAIL && process.env.DASHBOARD_SMTP_HOST) {
        tasks.push(sendEmail(message, subject).catch((e) => console.warn('[Alert] Email failed:', e.message)));
    }
    await Promise.all(tasks);
}

module.exports = {
    alertsEnabled,
    notifyScrapeFailure,
    notifyScheduledJobFailures,
    shouldSendScheduledAlert,
    sendAlertEmail: sendEmail,
    postAlertWebhook: postWebhook,
};
