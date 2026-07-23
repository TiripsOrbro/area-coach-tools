function emailFromAddress() {
    return (
        String(process.env.TACAUDIT_EMAIL_FROM || '').trim() ||
        String(process.env.DASHBOARD_SMTP_FROM || '').trim() ||
        String(process.env.DASHBOARD_SMTP_USER || '').trim() ||
        'TacoBellAudits@gmail.com'
    );
}

function buildTransporter() {
    let nodemailer;
    try {
        nodemailer = require('nodemailer');
    } catch {
        return null;
    }
    const host = String(process.env.DASHBOARD_SMTP_HOST || '').trim();
    if (!host) return null;
    const port = Number(process.env.DASHBOARD_SMTP_PORT || 587);
    const user = String(process.env.DASHBOARD_SMTP_USER || '').trim();
    const pass = String(process.env.DASHBOARD_SMTP_PASS || '').trim();
    const allowSelfSigned = /^(1|true|yes|on)$/i.test(
        String(process.env.DASHBOARD_SMTP_ALLOW_SELF_SIGNED ?? '').trim()
    );
    return nodemailer.createTransport({
        host,
        port,
        secure: port === 465,
        auth: user ? { user, pass } : undefined,
        tls: allowSelfSigned ? { rejectUnauthorized: false } : undefined,
    });
}

/**
 * @param {{ to: string|string[], subject: string, body?: string, attachments?: Array<{filename:string, content:Buffer|string, contentType?:string}> }} opts
 */
async function sendReportEmail(opts = {}) {
    const recipients = (Array.isArray(opts.to) ? opts.to : [opts.to])
        .map((r) => String(r || '').trim())
        .filter(Boolean);
    if (!recipients.length) {
        return { ok: false, skipped: true, reason: 'no-recipients' };
    }
    const transporter = buildTransporter();
    if (!transporter) {
        console.info('[ReportSubscriptions] SMTP not configured; email not sent.');
        return { ok: false, skipped: true, reason: 'no-smtp' };
    }

    const from = emailFromAddress();
    const attachments = (opts.attachments || []).map((a) => ({
        filename: a.filename,
        content: a.content,
        contentType: a.contentType || 'application/octet-stream',
    }));

    await transporter.sendMail({
        from,
        to: recipients.join(', '),
        subject: String(opts.subject || 'Dashboard report').trim(),
        text: String(opts.body || '').trim() || 'Report attached.',
        attachments,
    });

    return { ok: true, sent: true, to: recipients, from };
}

module.exports = {
    emailFromAddress,
    buildTransporter,
    sendReportEmail,
};
