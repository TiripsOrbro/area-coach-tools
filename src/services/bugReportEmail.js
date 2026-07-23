const BUG_REPORT_EMAIL_TO = String(process.env.BUG_REPORT_EMAIL_TO || 'TacoBellAudits@gmail.com').trim();

function emailFromAddress() {
    return (
        String(process.env.TACAUDIT_EMAIL_FROM || '').trim() ||
        String(process.env.DASHBOARD_SMTP_FROM || '').trim() ||
        String(process.env.DASHBOARD_SMTP_USER || '').trim() ||
        'noreply@example.com'
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

async function sendBugReportEmail({ bug, reporterName, reporterUsername, photoAttachments = [] }) {
    if (!BUG_REPORT_EMAIL_TO) {
        console.info('[BugReports] No report email configured; notification skipped.');
        return { ok: false, skipped: true };
    }
    const transporter = buildTransporter();
    if (!transporter) {
        console.info('[BugReports] SMTP not configured; report email not sent.');
        return { ok: false, skipped: true };
    }

    const title = String(bug?.title || 'Bug report').trim();
    const details = String(bug?.details || '').trim();
    const lines = [
        'A new bug was reported on the TBA Dashboard.',
        '',
        `Title: ${title}`,
        `Reported by: ${reporterName || reporterUsername || 'Unknown'}`,
        reporterUsername ? `Username: ${reporterUsername}` : '',
        `Bug id: ${bug?.id || ''}`,
        `Upvotes: ${Number(bug?.upvoteCount) || 0}`,
        '',
        details ? `Details:\n${details}` : '(No additional details)',
        '',
        'View and manage bugs in Settings → Report bug.',
    ].filter(Boolean);

    const attachments = (photoAttachments || []).map((row) => ({
        filename: row.filename,
        content: row.content,
        contentType: row.contentType,
    }));

    await transporter.sendMail({
        from: emailFromAddress(),
        to: BUG_REPORT_EMAIL_TO,
        subject: `[Bug report] ${title.slice(0, 120)}`,
        text: lines.join('\n'),
        attachments,
    });
    return { ok: true };
}

async function sendFeatureRequestEmail({ request, reporterName, reporterUsername }) {
    if (!BUG_REPORT_EMAIL_TO) {
        console.info('[FeatureRequests] No report email configured; notification skipped.');
        return { ok: false, skipped: true };
    }
    const transporter = buildTransporter();
    if (!transporter) {
        console.info('[FeatureRequests] SMTP not configured; feature request email not sent.');
        return { ok: false, skipped: true };
    }

    const title = String(request?.text || 'Feature request').trim();
    const details = String(request?.details || '').trim();
    const lines = [
        'A new feature request was submitted on the TBA Dashboard.',
        '',
        `Title: ${title}`,
        `Reported by: ${reporterName || reporterUsername || 'Unknown'}`,
        reporterUsername ? `Username: ${reporterUsername}` : '',
        `Request id: ${request?.id || ''}`,
        request?.category ? `Category: ${request.category}` : '',
        '',
        details ? `Details:\n${details}` : '(No additional details)',
        '',
        'View and vote on requests in Settings → Feature requests.',
    ].filter(Boolean);

    await transporter.sendMail({
        from: emailFromAddress(),
        to: BUG_REPORT_EMAIL_TO,
        subject: `[Feature request] ${title.slice(0, 120)}`,
        text: lines.join('\n'),
    });
    return { ok: true };
}

module.exports = {
    BUG_REPORT_EMAIL_TO,
    sendBugReportEmail,
    sendFeatureRequestEmail,
};
