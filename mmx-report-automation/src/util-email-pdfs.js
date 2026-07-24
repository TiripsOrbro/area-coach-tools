const path = require('path');
const nodemailer = require('nodemailer');
const log = require('./util-logging');

function validateEmailSettings(email) {
    const missing = [];
    if (!email.smtpHost) missing.push('MMX_EMAIL_SMTP_HOST');
    if (!email.smtpPort || !Number.isFinite(email.smtpPort)) missing.push('MMX_EMAIL_SMTP_PORT');
    if (!email.smtpUser) missing.push('MMX_EMAIL_SMTP_USER');
    if (!email.smtpPass) missing.push('MMX_EMAIL_SMTP_PASS');
    if (!email.from) missing.push('MMX_EMAIL_FROM');
    if (!Array.isArray(email.to) || email.to.length === 0) missing.push('MMX_EMAIL_TO');
    return missing;
}

async function sendPdfEmail({ email, pdfExports, workbookAttachments = [], templatePath, isDryRun }) {
    if (!email?.enabled) return { sent: false, skipped: 'email-disabled' };
    if (isDryRun && !email.sendOnDryRun) {
        log.info('Email skipped during dry-run (MMX_EMAIL_SEND_ON_DRY_RUN=false)');
        return { sent: false, skipped: 'dry-run-disabled' };
    }
    if (!Array.isArray(pdfExports) || pdfExports.length === 0) {
        log.warn('Email enabled but no PDFs were exported; skipping email send');
        return { sent: false, skipped: 'no-attachments' };
    }

    const missing = validateEmailSettings(email);
    if (missing.length) {
        throw new Error(`Email is enabled but missing settings: ${missing.join(', ')}`);
    }

    const transporter = nodemailer.createTransport({
        host: email.smtpHost,
        port: email.smtpPort,
        secure: Boolean(email.smtpSecure),
        auth: {
            user: email.smtpUser,
            pass: email.smtpPass,
        },
    });

    const today = new Date().toLocaleDateString('en-AU', {
        year: 'numeric',
        month: 'short',
        day: '2-digit',
    });
    const subject = `${email.subjectPrefix} - ${today}`;
    const pdfAttachments = pdfExports.map((item) => ({
        filename: path.basename(item.pdfPath),
        path: item.pdfPath,
    }));
    const workbookFileAttachments = (workbookAttachments || []).map((filePath) => ({
        filename: path.basename(filePath),
        path: filePath,
    }));
    const attachments = [...pdfAttachments, ...workbookFileAttachments];

    const bodyLines = [
        email.body,
        '',
        `Workbook: ${templatePath}`,
        `Generated PDFs: ${pdfExports.map((p) => p.tabName).join(', ')}`,
    ];

    await transporter.sendMail({
        from: email.from,
        to: email.to.join(', '),
        cc: email.cc?.length ? email.cc.join(', ') : undefined,
        subject,
        text: bodyLines.join('\n'),
        attachments,
    });

    log.info(
        `Sent PDF email to ${email.to.join(', ')} (${pdfAttachments.length} PDF(s), ${workbookFileAttachments.length} workbook(s))`
    );
    return { sent: true, attachments: attachments.length };
}

module.exports = { sendPdfEmail };
