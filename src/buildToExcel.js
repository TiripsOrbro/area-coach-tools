/**
 * Build To via Excel master workbook + sibling mmx-report-automation.
 */
const { spawn, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const paths = require('./paths');

const STATE_FILE = path.join(paths.dashboard.data, 'build-to-excel-state.json');
const WORKBOOK_DIR = path.join(paths.root, 'data', 'workbooks');
const WORKBOOK_PATH = path.join(WORKBOOK_DIR, 'Build-To-Master.xlsx');
const SOURCE_DOWNLOAD = path.join(
    process.env.USERPROFILE || '',
    'Downloads',
    'Build To Master File.xlsx'
);

function automationRoot() {
    return path.resolve(paths.mmxReportAutomation);
}

function ensureWorkbook() {
    fs.mkdirSync(WORKBOOK_DIR, { recursive: true });
    if (fs.existsSync(WORKBOOK_PATH)) return WORKBOOK_PATH;
    if (fs.existsSync(SOURCE_DOWNLOAD)) {
        fs.copyFileSync(SOURCE_DOWNLOAD, WORKBOOK_PATH);
        // Best-effort: add Settings sheet via xlsx
        try {
            const xlsx = require('xlsx');
            const wb = xlsx.readFile(WORKBOOK_PATH);
            if (!wb.SheetNames.includes('Settings')) {
                const sheet = xlsx.utils.aoa_to_sheet([
                    ['ITEM', 'VENDOR', 'TYPE', 'COUNT', 'DAILY', 'DAYS', 'BUFFER', 'FIXED', 'WARN'],
                    ['Example item', 'Americold', 'Days', 'TRUE', 'FALSE', 10, 0, '', 5],
                ]);
                xlsx.utils.book_append_sheet(wb, sheet, 'Settings');
                xlsx.writeFile(wb, WORKBOOK_PATH);
            }
        } catch (err) {
            console.warn('[build-to] Could not add Settings sheet:', err.message);
        }
        return WORKBOOK_PATH;
    }
    // Create minimal workbook if download missing
    try {
        const xlsx = require('xlsx');
        const wb = xlsx.utils.book_new();
        const settings = xlsx.utils.aoa_to_sheet([
            ['ITEM', 'VENDOR', 'TYPE', 'COUNT', 'DAILY', 'DAYS', 'BUFFER', 'FIXED', 'WARN'],
        ]);
        xlsx.utils.book_append_sheet(wb, settings, 'Settings');
        xlsx.writeFile(wb, WORKBOOK_PATH);
    } catch (err) {
        console.warn('[build-to] Could not create workbook:', err.message);
    }
    return WORKBOOK_PATH;
}

function workbookPath() {
    return ensureWorkbook();
}

function openWorkbook() {
    const file = ensureWorkbook();
    return new Promise((resolve) => {
        if (process.platform === 'win32') {
            exec(`start "" "${file}"`, (err) => {
                resolve({ ok: !err, path: file, error: err?.message || null });
            });
        } else {
            exec(`open "${file}"`, (err) => {
                resolve({ ok: !err, path: file, error: err?.message || null });
            });
        }
    });
}

function readState() {
    if (!fs.existsSync(STATE_FILE)) return { lastRun: null, history: [] };
    try {
        return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    } catch {
        return { lastRun: null, history: [] };
    }
}

function writeState(state) {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

function getStatus() {
    const root = automationRoot();
    const state = readState();
    const wb = ensureWorkbook();
    return {
        automationDir: root,
        automationExists: fs.existsSync(root),
        packageJson: fs.existsSync(path.join(root, 'package.json')),
        workbookPath: wb,
        workbookExists: fs.existsSync(wb),
        lastRun: state.lastRun,
        history: (state.history || []).slice(0, 10),
    };
}

let inFlight = null;

async function maybeSendWarnEmails(result) {
    const text = `${result.stdout || ''}\n${result.stderr || ''}`;
    if (!/WARN|warning threshold|below warn/i.test(text)) return;
    try {
        const { readSession } = require('../stores/src/coachSession');
        const session = readSession();
        const to = String(session.alertEmail || '').trim();
        if (!to) return;
        const nodemailer = require('nodemailer');
        const host = process.env.DASHBOARD_SMTP_HOST;
        if (!host) return;
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
            subject: `Build-to warning — ${session.displayName || session.userId || 'coach'}`,
            text: `A build-to warn threshold was triggered.\n\n${text.slice(-4000)}`,
        });
        result.warnEmailSent = true;
    } catch (err) {
        result.warnEmailError = err.message;
    }
}

function runExcelBuildTo(options = {}) {
    if (inFlight) return inFlight;

    const root = automationRoot();
    const workbook = ensureWorkbook();
    if (!fs.existsSync(path.join(root, 'package.json'))) {
        return Promise.resolve({
            ok: false,
            error: `mmx-report-automation not found at ${root}. Set MMX_REPORT_AUTOMATION_DIR.`,
        });
    }

    const startedAt = new Date().toISOString();
    const args = ['run', 'excel-only', '--'];
    args.push(`--workbook=${workbook}`);
    if (options.store) args.push(`--store=${options.store}`);

    inFlight = new Promise((resolve) => {
        const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
            cwd: root,
            env: {
                ...process.env,
                BUILD_TO_WORKBOOK: workbook,
            },
            windowsHide: true,
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => {
            stdout += chunk.toString();
        });
        child.stderr.on('data', (chunk) => {
            stderr += chunk.toString();
        });
        child.on('close', async (code) => {
            const result = {
                ok: code === 0,
                code,
                startedAt,
                finishedAt: new Date().toISOString(),
                store: options.store || null,
                workbook,
                stdout: stdout.slice(-8000),
                stderr: stderr.slice(-8000),
                error: code === 0 ? null : `excel-only exited with code ${code}`,
            };
            await maybeSendWarnEmails(result);
            const state = readState();
            state.lastRun = result;
            state.history = [result, ...(state.history || [])].slice(0, 20);
            writeState(state);
            inFlight = null;
            resolve(result);
        });
        child.on('error', (err) => {
            const result = {
                ok: false,
                startedAt,
                finishedAt: new Date().toISOString(),
                error: err.message || String(err),
            };
            const state = readState();
            state.lastRun = result;
            state.history = [result, ...(state.history || [])].slice(0, 20);
            writeState(state);
            inFlight = null;
            resolve(result);
        });
    });

    return inFlight;
}

function isRunning() {
    return Boolean(inFlight);
}

module.exports = {
    getStatus,
    runExcelBuildTo,
    openWorkbook,
    workbookPath,
    isRunning,
    automationRoot,
    ensureWorkbook,
};
