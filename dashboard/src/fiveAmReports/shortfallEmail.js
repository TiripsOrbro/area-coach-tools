/**
 * Email stock shortfall summary to the store's configured address.
 */
const storeEmails = require('../storeEmails');
const { setLastEmail } = require('./fiveAmReportsStore');

function buildShortfallBody(storeNumber, withOnOrder) {
    const count = Number(withOnOrder?.count) || 0;
    const threshold = withOnOrder?.thresholdDays;
    const alerts = Array.isArray(withOnOrder?.alerts)
        ? withOnOrder.alerts
        : Array.isArray(withOnOrder?.items)
          ? withOnOrder.items
          : [];
    const lines = [
        `Stock shortfalls for store ${storeNumber}`,
        threshold != null ? `Threshold: under ${threshold} days (on hand + on order)` : null,
        `Total: ${count}`,
        '',
    ].filter((l) => l != null);

    if (!alerts.length) {
        lines.push('No shortfalls.');
    } else {
        for (const it of alerts) {
            const code = it.itemCode || it.iseItemCode || '';
            const name = it.displayName || it.description || '';
            const days = Number(it.daysOfStock);
            const daysLabel = Number.isFinite(days) ? `${days.toFixed(1)} days` : '? days';
            const oh = Number(it.onHandCartons) || 0;
            const oo = Number(it.onOrderCartons) || 0;
            lines.push(`- ${code} ${name} — OH ${oh} / OO ${oo} / ${daysLabel}`);
        }
    }
    return lines.join('\n');
}

async function sendShortfallEmail(storeNumber, withOnOrder, options = {}) {
    const store = String(storeNumber || '').trim();
    const to = String(options.to || storeEmails.getEmail(store) || '').trim();
    if (!to) return { ok: false, skipped: true, reason: 'no email' };

    const host = process.env.DASHBOARD_SMTP_HOST;
    if (!host) return { ok: false, skipped: true, reason: 'SMTP not configured' };

    const count = Number(withOnOrder?.count) || 0;
    const nodemailer = require('nodemailer');
    const transport = nodemailer.createTransport({
        host,
        port: Number(process.env.DASHBOARD_SMTP_PORT || 587),
        secure: false,
        auth: process.env.DASHBOARD_SMTP_USER
            ? { user: process.env.DASHBOARD_SMTP_USER, pass: process.env.DASHBOARD_SMTP_PASS }
            : undefined,
    });

    await transport.sendMail({
        from: process.env.DASHBOARD_SMTP_USER || to,
        to,
        subject: `Stock shortfalls — Store ${store} (${count})`,
        text: buildShortfallBody(store, withOnOrder),
    });

    const at = new Date().toISOString();
    setLastEmail(store, at, { to, count });
    return { ok: true, to, storeNumber: store, count, at };
}

module.exports = {
    sendShortfallEmail,
    buildShortfallBody,
};
