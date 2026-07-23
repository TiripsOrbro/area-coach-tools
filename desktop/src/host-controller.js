const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { getConfig, setConfig, DEFAULT_GIT_BRANCH, DEFAULT_GIT_REMOTE } = require('./config');

function run(cmd, args, opts = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, {
            cwd: opts.cwd,
            env: { ...process.env, ...(opts.env || {}) },
            shell: true,
            windowsHide: true,
        });
        let stdout = '';
        let stderr = '';
        child.stdout?.on('data', (d) => {
            stdout += d.toString();
        });
        child.stderr?.on('data', (d) => {
            stderr += d.toString();
        });
        child.on('error', reject);
        child.on('close', (code) => {
            if (code === 0) resolve({ stdout, stderr, code });
            else reject(new Error(`${cmd} ${args.join(' ')} failed (${code}): ${stderr || stdout}`));
        });
    });
}

function whichPm2() {
    return new Promise((resolve) => {
        execFile('where', ['pm2'], { windowsHide: true }, (err, stdout) => {
            if (err || !stdout) return resolve(null);
            const first = String(stdout)
                .split(/\r?\n/)
                .map((s) => s.trim())
                .find(Boolean);
            resolve(first || null);
        });
    });
}

function defaultServerDir() {
    const base = process.env.LOCALAPPDATA || process.env.USERPROFILE || '';
    return path.join(base, 'AdminHost', 'server');
}

async function ensureServerDir(cfg = getConfig()) {
    let serverDir = cfg.serverDir || defaultServerDir();
    if (!fs.existsSync(serverDir)) {
        fs.mkdirSync(path.dirname(serverDir), { recursive: true });
        const remote = cfg.gitRemote || DEFAULT_GIT_REMOTE;
        const branch = cfg.gitBranch || DEFAULT_GIT_BRANCH;
        await run('git', ['clone', '--branch', branch, '--single-branch', remote, serverDir]);
        setConfig({ serverDir });
    } else {
        setConfig({ serverDir });
    }
    return serverDir;
}

async function npmInstall(serverDir) {
    await run('npm', ['install', '--omit=dev'], { cwd: serverDir });
}

async function startServer() {
    const cfg = getConfig();
    if (cfg.mode !== 'host') {
        throw new Error('Start server is only available in Host mode');
    }
    const serverDir = await ensureServerDir(cfg);
    const ecosystem = path.join(serverDir, 'ecosystem.config.cjs');
    if (!fs.existsSync(ecosystem)) {
        throw new Error(`Missing ecosystem.config.cjs in ${serverDir}`);
    }
    if (!fs.existsSync(path.join(serverDir, 'node_modules'))) {
        await npmInstall(serverDir);
    }
    const pm2 = await whichPm2();
    if (pm2) {
        try {
            await run('pm2', ['describe', 'dashboard'], { cwd: serverDir });
            await run('pm2', ['restart', 'dashboard', 'report-download-scheduler', 'forecast-scheduler'], {
                cwd: serverDir,
            });
        } catch {
            await run('pm2', ['start', 'ecosystem.config.cjs'], { cwd: serverDir });
        }
        await run('pm2', ['save'], { cwd: serverDir }).catch(() => {});
    } else {
        // Fallback: node child — track pid file
        const pidFile = path.join(serverDir, '.desktop-server.pid');
        if (fs.existsSync(pidFile)) {
            const oldPid = Number(fs.readFileSync(pidFile, 'utf8'));
            try {
                process.kill(oldPid, 0);
                setConfig({ lastHostStatus: 'running' });
                return { serverDir, via: 'node', pid: oldPid, already: true };
            } catch {
                /* not running */
            }
        }
        const child = spawn('node', ['src/app.js'], {
            cwd: serverDir,
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
            env: { ...process.env, NODE_ENV: 'production' },
        });
        child.unref();
        fs.writeFileSync(pidFile, String(child.pid), 'utf8');
        setConfig({ lastHostStatus: 'running' });
        return { serverDir, via: 'node', pid: child.pid };
    }
    setConfig({ lastHostStatus: 'running' });
    return { serverDir, via: 'pm2' };
}

async function stopServer() {
    const cfg = getConfig();
    const serverDir = cfg.serverDir || defaultServerDir();
    const pm2 = await whichPm2();
    if (pm2) {
        await run('pm2', ['stop', 'dashboard', 'report-download-scheduler', 'forecast-scheduler'], {
            cwd: serverDir,
        }).catch(() => {});
    }
    const pidFile = path.join(serverDir, '.desktop-server.pid');
    if (fs.existsSync(pidFile)) {
        const pid = Number(fs.readFileSync(pidFile, 'utf8'));
        try {
            process.kill(pid);
        } catch {
            /* ignore */
        }
        fs.unlinkSync(pidFile);
    }
    setConfig({ lastHostStatus: 'stopped' });
    return { ok: true };
}

async function restartServer() {
    await stopServer().catch(() => {});
    return startServer();
}

async function gitRev(serverDir, ref) {
    const { stdout } = await run('git', ['rev-parse', ref], { cwd: serverDir });
    return String(stdout || '').trim();
}

/**
 * Fetch + fast-forward the Host server clone when origin is ahead.
 * Used on Host launch so a restart picks up the latest dashboard without a reinstall.
 */
async function syncFromGitIfBehind({ force = false, onProgress } = {}) {
    const progress = (msg) => onProgress?.(String(msg || ''));
    const cfg = getConfig();
    if (cfg.mode !== 'host') {
        throw new Error('Git sync is only available in Host mode');
    }
    const serverDir = await ensureServerDir(cfg);
    const branch = cfg.gitBranch || DEFAULT_GIT_BRANCH;
    progress('Checking Git for updates…');
    await run('git', ['fetch', 'origin', branch], { cwd: serverDir });
    progress(`On branch ${branch} — comparing with GitHub…`);
    await run('git', ['checkout', branch], { cwd: serverDir });

    const local = await gitRev(serverDir, 'HEAD');
    const remote = await gitRev(serverDir, `origin/${branch}`);
    if (!force && local && remote && local === remote) {
        progress('Server is already up to date');
        return { serverDir, branch, updated: false, local, remote };
    }

    const alreadyCurrent = local && remote && local === remote;
    progress(alreadyCurrent ? 'Already current — refreshing install…' : 'Pulling latest server code…');
    // --autostash: Host runtime edits (ISE history, local experiments) must not block updates
    await run('git', ['pull', '--ff-only', '--autostash', 'origin', branch], { cwd: serverDir });
    progress('Installing packages…');
    await npmInstall(serverDir);
    progress('Restarting server…');
    const result = await restartServer();
    return { ...result, branch, updated: !alreadyCurrent, local, remote };
}

async function updateFromGit(opts = {}) {
    return syncFromGitIfBehind({ force: true, ...opts });
}

async function probeLocalHealth(port = 3100) {
    try {
        const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
            signal: AbortSignal.timeout(3000),
        });
        if (!res.ok) return { ok: false, status: res.status };
        const body = await res.json();
        return { ok: true, body };
    } catch (err) {
        return { ok: false, error: String(err && err.message ? err.message : err) };
    }
}

async function getHostStatus() {
    const cfg = getConfig();
    const health = await probeLocalHealth();
    return {
        mode: cfg.mode,
        serverDir: cfg.serverDir || defaultServerDir(),
        lastHostStatus: health.ok ? 'running' : cfg.lastHostStatus,
        localHealthy: health.ok,
        health,
    };
}

/** Best-effort PM2 revive-on-boot (often needs Admin; failures are ignored). */
async function tryConfigurePm2Startup(serverDir) {
    const pm2 = await whichPm2();
    if (!pm2) return { ok: false, skipped: true };
    try {
        await run('pm2', ['save'], { cwd: serverDir }).catch(() => {});
        await run('pm2', ['startup'], { cwd: serverDir }).catch(() => {});
        return { ok: true };
    } catch {
        return { ok: false };
    }
}

/**
 * If local health is down, start the server and wait briefly for readiness.
 */
async function ensureServerRunning({ waitMs = 12000 } = {}) {
    const health = await probeLocalHealth();
    if (health.ok) {
        return { already: true, started: false, health };
    }
    const result = await startServer();
    const deadline = Date.now() + waitMs;
    let last = health;
    while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1500));
        last = await probeLocalHealth();
        if (last.ok) break;
    }
    if (result.via === 'pm2') {
        await tryConfigurePm2Startup(result.serverDir || defaultServerDir()).catch(() => {});
    }
    return { already: false, started: true, health: last, start: result };
}

module.exports = {
    defaultServerDir,
    ensureServerDir,
    startServer,
    stopServer,
    restartServer,
    updateFromGit,
    syncFromGitIfBehind,
    getHostStatus,
    probeLocalHealth,
    ensureServerRunning,
    tryConfigurePm2Startup,
};
