const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { getConfig, setConfig, DEFAULT_GIT_BRANCH, DEFAULT_GIT_REMOTE } = require('./config');
const host = require('./host-controller');
const cloudflare = require('./cloudflare');
const secretsPack = require('./secrets-pack');

function run(cmd, args, opts = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, {
            cwd: opts.cwd,
            env: { ...process.env, ...(opts.env || {}) },
            shell: opts.shell !== false,
            windowsHide: true,
        });
        let stdout = '';
        let stderr = '';
        child.stdout?.on('data', (d) => {
            stdout += d.toString();
            opts.onData?.(d.toString());
        });
        child.stderr?.on('data', (d) => {
            stderr += d.toString();
            opts.onData?.(d.toString());
        });
        child.on('error', reject);
        child.on('close', (code) => {
            if (code === 0 || opts.allowFail) resolve({ stdout, stderr, code });
            else reject(new Error((stderr || stdout || `${cmd} failed (${code})`).trim().slice(0, 800)));
        });
    });
}

function commandExists(name) {
    return new Promise((resolve) => {
        execFile('where', [name], { windowsHide: true, shell: true }, (err, stdout) => {
            resolve(!err && Boolean(String(stdout || '').trim()));
        });
    });
}

function refreshPathFromMachine() {
    try {
        const { execSync } = require('child_process');
        const machine = execSync(
            'powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable(\'Path\',\'Machine\')"',
            { encoding: 'utf8', windowsHide: true }
        ).trim();
        const user = execSync(
            'powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable(\'Path\',\'User\')"',
            { encoding: 'utf8', windowsHide: true }
        ).trim();
        process.env.Path = [machine, user, process.env.Path || ''].filter(Boolean).join(';');
    } catch {
        /* ignore */
    }
}

async function wingetAvailable() {
    return commandExists('winget');
}

async function wingetInstall(packageId, onProgress) {
    onProgress?.(`Installing ${packageId} (Windows may ask for approval)…`);
    await run(
        'winget',
        [
            'install',
            '--id',
            packageId,
            '-e',
            '--accept-package-agreements',
            '--accept-source-agreements',
            '--disable-interactivity',
        ],
        {
            allowFail: true,
            onData: (chunk) => {
                const line = chunk.trim();
                if (line) onProgress?.(line.slice(0, 160));
            },
        }
    );
    refreshPathFromMachine();
}

function hasBrowser() {
    const candidates = [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    ];
    return candidates.some((p) => fs.existsSync(p));
}

function ensureEnvFile(serverDir, onProgress) {
    const envPath = path.join(serverDir, '.env');
    if (fs.existsSync(envPath)) {
        onProgress?.('.env already present');
        return;
    }
    const src = fs.existsSync(path.join(serverDir, '.env.server16gb.example'))
        ? path.join(serverDir, '.env.server16gb.example')
        : path.join(serverDir, '.env.example');
    if (!fs.existsSync(src)) {
        onProgress?.('No .env template found — you can finish secrets later in Admin');
        return;
    }
    fs.copyFileSync(src, envPath);
    onProgress?.('Created .env from template (Windows high-power defaults)');
}

async function ensurePm2(onProgress) {
    if (await commandExists('pm2')) {
        onProgress?.('PM2 already installed');
        return;
    }
    onProgress?.('Installing PM2…');
    await run('npm', ['install', '-g', 'pm2'], {
        onData: (c) => {
            const t = c.trim();
            if (t) onProgress?.(t.slice(0, 160));
        },
    });
    refreshPathFromMachine();
}

/**
 * Full easy Host bootstrap for non-technical users.
 * Downloads/installs tooling, clones server, starts app + Cloudflare.
 */
async function runHostBootstrap({
    onProgress,
    setupCloudflare = true,
    secretsPath = null,
    confirm = null,
    guidedCloudflare = true,
    onOpenAdminSettings = null,
} = {}) {
    const progress = (msg) => {
        onProgress?.(String(msg || ''));
    };
    const steps = [];

    progress('Checking this PC…');
    const hasWinget = await wingetAvailable();
    if (!hasWinget) {
        throw new Error(
            'Windows Package Manager (winget) is required for automatic setup. Update Windows, then try again.'
        );
    }

    // Node
    if (!(await commandExists('node'))) {
        progress('Node.js is missing — installing (approve if Windows asks)…');
        await wingetInstall('OpenJS.NodeJS.LTS', progress);
        if (!(await commandExists('node'))) {
            throw new Error('Node.js install finished but node is still not on PATH. Restart the PC and open Live Dashboard again.');
        }
        steps.push('node');
    } else {
        progress('Node.js found');
    }

    // Git
    if (!(await commandExists('git'))) {
        progress('Git is missing — installing…');
        await wingetInstall('Git.Git', progress);
        if (!(await commandExists('git'))) {
            throw new Error('Git install finished but git is still not on PATH. Restart the PC and try again.');
        }
        steps.push('git');
    } else {
        progress('Git found');
    }

    // cloudflared
    let cfPath = cloudflare.resolveCloudflared();
    if (!cfPath) {
        progress('Cloudflare Tunnel is missing — installing…');
        await wingetInstall('Cloudflare.cloudflared', progress);
        cfPath = cloudflare.resolveCloudflared();
        if (!cfPath) {
            progress('cloudflared may need a sign-out/sign-in for PATH — continuing');
        }
        steps.push('cloudflared');
    } else {
        progress('Cloudflare Tunnel found');
    }

    if (!hasBrowser()) {
        progress('Installing Microsoft Edge (needed for headless scraping)…');
        await wingetInstall('Microsoft.Edge', progress);
        steps.push('edge');
    } else {
        progress('Chrome/Edge found');
    }

    const cfg = getConfig();
    const serverDir = cfg.serverDir || host.defaultServerDir();
    setConfig({ serverDir, mode: 'host' });

    progress(`Preparing server folder…\n${serverDir}`);
    if (!fs.existsSync(path.join(serverDir, 'package.json'))) {
        if (fs.existsSync(serverDir) && fs.readdirSync(serverDir).length) {
            // Non-empty but not a repo — use sibling path
            const alt = path.join(path.dirname(serverDir), `server-${Date.now()}`);
            setConfig({ serverDir: alt });
            progress(`Folder busy — using ${alt}`);
        }
        const dir = getConfig().serverDir;
        fs.mkdirSync(path.dirname(dir), { recursive: true });
        if (fs.existsSync(dir)) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
        progress('Downloading Live Dashboard server from GitHub (branch 16gb)…');
        await run(
            'git',
            [
                'clone',
                '--branch',
                cfg.gitBranch || DEFAULT_GIT_BRANCH,
                '--single-branch',
                cfg.gitRemote || DEFAULT_GIT_REMOTE,
                dir,
            ],
            {
                onData: (c) => {
                    const t = c.trim();
                    if (t) progress(t.slice(0, 160));
                },
            }
        );
        steps.push('clone');
    } else {
        progress('Server files already on this PC');
    }

    const finalDir = getConfig().serverDir;
    ensureEnvFile(finalDir, progress);

    if (secretsPath) {
        progress('Importing Host secrets pack…');
        secretsPack.importSecretsPack(secretsPath, finalDir, { onProgress: progress });
    } else {
        progress('No secrets folder selected — configure store logins later in Admin if needed');
    }

    progress('Installing server packages (first time can take a few minutes)…');
    await run('npm', ['install', '--omit=dev'], {
        cwd: finalDir,
        onData: (c) => {
            const t = c.trim();
            if (t && /added|removed|audited|packages/i.test(t)) progress(t.slice(0, 160));
        },
    });
    steps.push('npm');

    try {
        await ensurePm2(progress);
        steps.push('pm2');
    } catch (err) {
        progress(`PM2 optional install skipped: ${err.message || err}`);
    }

    progress('Starting the dashboard server…');
    await host.startServer();
    steps.push('server');

    let cloudflareResult = null;
    if (setupCloudflare) {
        progress('—— Cloudflare tunnel ——');
        progress('A short walkthrough will guide login and tunnel connection…');
        try {
            cloudflareResult = await cloudflare.setupCloudflareTunnel({
                hostname: 'tbadashboard.com',
                onProgress: progress,
                confirm: typeof confirm === 'function' ? confirm : undefined,
                guided: guidedCloudflare && typeof confirm === 'function',
                onOpenAdminSettings:
                    typeof onOpenAdminSettings === 'function' ? onOpenAdminSettings : undefined,
            });
            if (cloudflareResult.skipped) {
                progress('Cloudflare skipped — use tray → Setup Cloudflare tunnel when ready');
            } else if (cloudflareResult.via === 'user-process' || cloudflareResult.running) {
                progress('Cloudflare tunnel started (user mode + Startup for reboot)');
            } else if (cloudflareResult.elevated) {
                progress('Cloudflare Windows service installed');
            } else if (cloudflareResult.ok) {
                progress('Cloudflare tunnel started');
            }
            steps.push('cloudflare');
        } catch (err) {
            progress(`Cloudflare needs attention: ${err.message || err}`);
            cloudflareResult = { ok: false, error: String(err.message || err) };
            if (typeof confirm === 'function') {
                await confirm({
                    type: 'error',
                    title: 'Cloudflare setup failed',
                    message: 'Tunnel could not be set up',
                    detail: [
                        String(err.message || err),
                        '',
                        'Admin Settings will still open on this PC.',
                        'Fix the tunnel later with tray → Setup Cloudflare tunnel…',
                    ].join('\n'),
                    buttons: ['Continue to Admin'],
                    defaultId: 0,
                });
            }
        }
    }

    progress('Waiting for local server on port 3100…');
    let health = await host.probeLocalHealth(3000);
    if (!health.ok) {
        const ensured = await host.ensureServerRunning({ waitMs: 45000 });
        health = ensured.health || health;
    }
    if (!health.ok) {
        progress('Local server still not responding — Admin will open on localhost once it is up; use tray → Start server if needed');
    } else {
        progress('Local server is healthy');
    }

    return {
        ok: true,
        serverDir: finalDir,
        steps,
        cloudflare: cloudflareResult,
        health,
    };
}

async function runClientBootstrap({ onProgress } = {}) {
    onProgress?.('Saving Client settings…');
    setConfig({
        mode: 'client',
        serverUrl: 'https://tbadashboard.com',
        openAtLogin: true,
        setupComplete: true,
    });
    onProgress?.('Done — opening Settings');
    return { ok: true, mode: 'client' };
}

module.exports = {
    runHostBootstrap,
    runClientBootstrap,
    commandExists,
    hasBrowser,
};
