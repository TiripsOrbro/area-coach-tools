const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_HOSTNAME = 'tbadashboard.com';
/** Production tunnel for tbadashboard.com — do not fall back to other tunnel names. */
const PREFERRED_TUNNEL_NAME = 'dashboard';
const FALLBACK_TUNNEL_NAME = 'live-dashboard'; // kept for diagnostics only; never used for production hostname
const LOCAL_ORIGIN = 'http://127.0.0.1:3100';
const PID_FILE = path.join(os.homedir(), '.cloudflared', 'live-dashboard-tunnel.pid');
const TOKEN_FILE = path.join(os.homedir(), '.cloudflared', 'live-dashboard-host.token');
const STARTUP_CMD_NAME = 'LiveDashboard-Cloudflared.cmd';
const STARTUP_VBS_NAME = 'LiveDashboard-Cloudflared.vbs';

function cloudflaredCandidates() {
    return [
        process.env.CLOUDFLARED_PATH,
        'C:\\Program Files\\cloudflared\\cloudflared.exe',
        'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
        path.join(process.env.LOCALAPPDATA || '', 'cloudflared', 'cloudflared.exe'),
    ].filter(Boolean);
}

function resolveCloudflared() {
    for (const p of cloudflaredCandidates()) {
        if (fs.existsSync(p)) return p;
    }
    return null;
}

function run(bin, args) {
    return new Promise((resolve, reject) => {
        const child = spawn(bin, args, {
            cwd: os.homedir(),
            env: process.env,
            shell: false,
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
            resolve({ code, stdout, stderr, ok: code === 0 });
        });
    });
}

function cloudflaredDir() {
    return path.join(os.homedir(), '.cloudflared');
}

function hasCert() {
    return fs.existsSync(path.join(cloudflaredDir(), 'cert.pem'));
}

async function ensureLoggedIn(bin, { onProgress, confirm } = {}) {
    if (hasCert()) {
        onProgress?.('Already signed in to Cloudflare on this PC');
        return { ok: true, already: true };
    }

    if (typeof confirm === 'function') {
        const choice = await confirm({
            type: 'info',
            title: 'Step: Cloudflare login',
            message: 'Connect this PC to Cloudflare',
            detail: [
                'tbadashboard.com is published through a Cloudflare Tunnel.',
                '',
                '1. Click Continue — a browser window will open',
                '2. Sign in with the Cloudflare account that owns tbadashboard.com',
                '3. Click Authorize / Allow when Cloudflare asks',
                '4. Return here when the browser says success',
                '',
                'Use the same Cloudflare account as the previous Host.',
            ].join('\n'),
            buttons: ['Continue — open Cloudflare login', 'Skip Cloudflare for now'],
            defaultId: 0,
            cancelId: 1,
        });
        if (choice !== 0) {
            return { ok: false, skipped: true };
        }
    }

    onProgress?.('Opening Cloudflare login in your browser — finish signing in there…');
    const result = await run(bin, ['tunnel', 'login']);
    if (!hasCert()) {
        if (typeof confirm === 'function') {
            const retry = await confirm({
                type: 'warning',
                title: 'Cloudflare login incomplete',
                message: 'Login did not finish',
                detail:
                    (result.stderr || result.stdout || '').trim().slice(0, 400) ||
                    'No Cloudflare certificate was saved. Try again, or skip and set up the tunnel later from the tray.',
                buttons: ['Try login again', 'Skip for now'],
                defaultId: 0,
                cancelId: 1,
            });
            if (retry === 0) {
                return ensureLoggedIn(bin, { onProgress, confirm });
            }
            return { ok: false, skipped: true };
        }
        throw new Error(
            result.stderr ||
                'Cloudflare login did not finish. Complete the browser login, then retry Setup Cloudflare.'
        );
    }
    onProgress?.('Cloudflare login complete');
    return { ok: true, loggedIn: true };
}

async function listTunnels(bin) {
    const result = await run(bin, ['tunnel', 'list']);
    const lines = `${result.stdout}\n${result.stderr}`.split(/\r?\n/);
    const tunnels = [];
    for (const line of lines) {
        const m = line.match(
            /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s+(\S+)/i
        );
        if (m) tunnels.push({ id: m[1], name: m[2] });
    }
    return tunnels;
}

async function getTunnelToken(bin, tunnelNameOrId) {
    const result = await run(bin, ['tunnel', 'token', String(tunnelNameOrId)]);
    const token = `${result.stdout}`
        .trim()
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter((s) => s.length > 40 && !/\s/.test(s))
        .pop();
    if (!token) throw new Error(result.stderr || 'Could not read tunnel token');
    return token;
}

function queryService() {
    return new Promise((resolve) => {
        execFile('sc.exe', ['query', 'cloudflared'], { windowsHide: true }, (err, stdout) => {
            const text = String(stdout || '');
            resolve({
                installed: !err && /SERVICE_NAME:\s*cloudflared/i.test(text),
                running: /STATE\s*:\s*\d+\s+RUNNING/i.test(text),
                raw: text,
            });
        });
    });
}

function startService() {
    return new Promise((resolve) => {
        execFile('sc.exe', ['start', 'cloudflared'], { windowsHide: true }, (err, stdout, stderr) => {
            const text = `${stdout || ''}\n${stderr || ''}`;
            resolve({ ok: !err || /already|RUNNING/i.test(text), text: text.trim() });
        });
    });
}

function stopService() {
    return new Promise((resolve) => {
        execFile('sc.exe', ['stop', 'cloudflared'], { windowsHide: true }, (err, stdout, stderr) => {
            const text = `${stdout || ''}\n${stderr || ''}`;
            resolve({ ok: !err || /STOPPED|not been started|does not exist/i.test(text), text: text.trim() });
        });
    });
}

async function uninstallService(bin) {
    await run(bin, ['service', 'uninstall']);
}

async function installServiceWithToken(bin, token) {
    await uninstallService(bin);
    const result = await run(bin, ['service', 'install', token]);
    if (!result.ok) {
        throw new Error(
            (result.stderr || result.stdout || '').trim() ||
                'cloudflared service install failed (needs Administrator once).'
        );
    }
}

/**
 * Install + start cloudflared Windows service via a UAC-elevated PowerShell script.
 * Required because the tray app is usually not running as Administrator.
 */
async function installServiceElevated(bin, token, { onProgress } = {}) {
    const dir = path.join(os.tmpdir(), 'live-dashboard-cloudflared');
    fs.mkdirSync(dir, { recursive: true });
    const tokenFile = path.join(dir, 'tunnel.token');
    const scriptFile = path.join(dir, 'install-service.ps1');
    const resultFile = path.join(dir, 'install-result.txt');

    fs.writeFileSync(tokenFile, String(token).trim(), 'utf8');
    try {
        fs.unlinkSync(resultFile);
    } catch {
        /* ignore */
    }

    const ps = [
        "$ErrorActionPreference = 'Stop'",
        `Set-Content -Path '${resultFile.replace(/'/g, "''")}' -Value 'started'`,
        `$bin = '${String(bin).replace(/'/g, "''")}'`,
        `$token = (Get-Content -Raw '${tokenFile.replace(/'/g, "''")}').Trim()`,
        'try {',
        '  & $bin service uninstall 2>$null | Out-Null',
        '} catch {}',
        'Start-Sleep -Milliseconds 500',
        '& $bin service install $token',
        'if ($LASTEXITCODE -ne 0) { throw "cloudflared service install exit $LASTEXITCODE" }',
        'Start-Sleep -Milliseconds 800',
        'try { Start-Service -Name cloudflared -ErrorAction Stop } catch {',
        '  & sc.exe start cloudflared | Out-Null',
        '}',
        `Set-Content -Path '${resultFile.replace(/'/g, "''")}' -Value 'ok'`,
        `Remove-Item -Force '${tokenFile.replace(/'/g, "''")}' -ErrorAction SilentlyContinue`,
    ].join('\r\n');
    fs.writeFileSync(scriptFile, ps, 'utf8');

    onProgress?.('Windows will ask for Administrator permission — click Yes…');

    const elevate = await new Promise((resolve) => {
        const child = spawn(
            'powershell.exe',
            [
                '-NoProfile',
                '-ExecutionPolicy',
                'Bypass',
                '-Command',
                `Start-Process -FilePath powershell.exe -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File','${scriptFile.replace(
                    /'/g,
                    "''"
                )}')`,
            ],
            { windowsHide: true }
        );
        let stderr = '';
        child.stderr?.on('data', (d) => {
            stderr += d.toString();
        });
        child.on('error', (err) => resolve({ ok: false, error: String(err.message || err) }));
        child.on('close', (code) => {
            resolve({ ok: code === 0, code, stderr: stderr.trim() });
        });
    });

    let resultText = '';
    try {
        resultText = fs.readFileSync(resultFile, 'utf8').trim();
    } catch {
        resultText = '';
    }

    // Clean token file even if elevate failed
    try {
        fs.unlinkSync(tokenFile);
    } catch {
        /* ignore */
    }

    if (!elevate.ok || resultText !== 'ok') {
        const service = await queryService();
        if (service.installed && service.running) {
            return { ok: true, elevated: true, service };
        }
        throw new Error(
            elevate.stderr ||
                (resultText === 'started'
                    ? 'Administrator approval was cancelled or the elevated install did not finish.'
                    : 'Could not install Cloudflare Windows service as Administrator.')
        );
    }

    await new Promise((r) => setTimeout(r, 1000));
    const service = await queryService();
    if (!service.running) {
        await startService();
    }
    return { ok: true, elevated: true, service: await queryService() };
}

function stopPidFileProcess() {
    try {
        if (!fs.existsSync(PID_FILE)) return;
        const pid = Number(fs.readFileSync(PID_FILE, 'utf8'));
        if (pid) {
            try {
                process.kill(pid);
            } catch {
                /* ignore */
            }
        }
        fs.unlinkSync(PID_FILE);
    } catch {
        /* ignore */
    }
}

async function killAllCloudflaredProcesses() {
    return new Promise((resolve) => {
        execFile('taskkill', ['/IM', 'cloudflared.exe', '/F'], { windowsHide: true }, () => resolve());
    });
}

async function startTokenProcess(bin, token) {
    stopPidFileProcess();
    // Must finish taskkill before spawn — fire-and-forget taskkill was killing the new connector.
    await killAllCloudflaredProcesses();
    await new Promise((r) => setTimeout(r, 400));
    const child = spawn(bin, ['tunnel', 'run', '--token', token], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: process.env,
    });
    child.unref();
    fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });
    fs.writeFileSync(PID_FILE, String(child.pid), 'utf8');
    return child.pid;
}

async function waitForTunnelPid(pid, { timeoutMs = 5000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (isPidRunning(pid)) return true;
        await new Promise((r) => setTimeout(r, 300));
    }
    return isPidRunning(pid);
}

function saveHostTunnelToken(token) {
    fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
    fs.writeFileSync(TOKEN_FILE, String(token).trim(), 'utf8');
    return TOKEN_FILE;
}

function readHostTunnelToken() {
    try {
        if (!fs.existsSync(TOKEN_FILE)) return null;
        const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
        return t.length > 40 ? t : null;
    } catch {
        return null;
    }
}

function startupDir() {
    return path.join(
        process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
        'Microsoft',
        'Windows',
        'Start Menu',
        'Programs',
        'Startup'
    );
}

function startupCmdPath() {
    return path.join(startupDir(), STARTUP_CMD_NAME);
}

function startupVbsPath() {
    return path.join(startupDir(), STARTUP_VBS_NAME);
}

function vbsQuote(s) {
    return String(s).replace(/"/g, '""');
}

/**
 * Persist tunnel across reboot via Startup folder (runs as the logged-in user).
 * Uses a .vbs launcher with WindowStyle 0 so no console window appears.
 * Waits for the local dashboard on :3000 before starting cloudflared so startup
 * does not spam "Unable to reach the origin service" while PM2 is still booting.
 */
function installTunnelAutostart(bin, token) {
    saveHostTunnelToken(token);
    const dir = startupDir();
    fs.mkdirSync(dir, { recursive: true });
    const vbsPath = startupVbsPath();
    const tokenPath = TOKEN_FILE;
    const body = [
        "' Live Dashboard Host — Cloudflare tunnel (hidden; waits for local server)",
        'Option Explicit',
        'Dim fso, sh, bin, tokenFile, token, f, rc',
        'Set fso = CreateObject("Scripting.FileSystemObject")',
        'Set sh = CreateObject("WScript.Shell")',
        `bin = "${vbsQuote(bin)}"`,
        `tokenFile = "${vbsQuote(tokenPath)}"`,
        'If Not fso.FileExists(tokenFile) Then WScript.Quit 0',
        'Set f = fso.OpenTextFile(tokenFile, 1)',
        'token = Trim(f.ReadAll)',
        'f.Close',
        'If Len(token) < 40 Then WScript.Quit 0',
        "' Wait up to ~90s for http://127.0.0.1:3100 before connecting the tunnel",
        'rc = sh.Run("powershell.exe -NoProfile -WindowStyle Hidden -Command ""$d=(Get-Date).AddSeconds(90); do { try { $r=Invoke-WebRequest -UseBasicParsing http://127.0.0.1:3100/api/health -TimeoutSec 2; if ($r.StatusCode -eq 200) { exit 0 } } catch {} Start-Sleep -Seconds 2 } while ((Get-Date) -lt $d); exit 1""", 0, True)',
        'sh.Run """" & bin & """ tunnel run --token " & token, 0, False',
        '',
    ].join('\r\n');
    fs.writeFileSync(vbsPath, body, 'utf8');
    // Remove legacy visible .cmd if present
    try {
        const cmdPath = startupCmdPath();
        if (fs.existsSync(cmdPath)) fs.unlinkSync(cmdPath);
    } catch {
        /* ignore */
    }
    return { cmdPath: vbsPath, tokenFile: TOKEN_FILE };
}

function removeTunnelAutostart() {
    for (const p of [startupCmdPath(), startupVbsPath()]) {
        try {
            if (fs.existsSync(p)) fs.unlinkSync(p);
        } catch {
            /* ignore */
        }
    }
    try {
        if (fs.existsSync(TOKEN_FILE)) fs.unlinkSync(TOKEN_FILE);
    } catch {
        /* ignore */
    }
}

/**
 * Disable LocalSystem Cloudflared service — on this Host it returned 503 while
 * the same token run as the logged-in user worked.
 */
async function disableSystemCloudflaredService({ onProgress } = {}) {
    const dir = path.join(os.tmpdir(), 'live-dashboard-cloudflared');
    fs.mkdirSync(dir, { recursive: true });
    const scriptFile = path.join(dir, 'disable-cloudflared-service.ps1');
    const resultFile = path.join(dir, 'disable-cloudflared-result.txt');
    try {
        fs.unlinkSync(resultFile);
    } catch {
        /* ignore */
    }
    const ps = [
        "$ErrorActionPreference = 'Continue'",
        `Set-Content -Path '${resultFile.replace(/'/g, "''")}' -Value 'started'`,
        "foreach ($name in @('Cloudflared','cloudflared')) {",
        '  try { Stop-Service $name -Force -ErrorAction SilentlyContinue } catch {}',
        '  try { sc.exe stop $name | Out-Null } catch {}',
        '  try { sc.exe config $name start= disabled | Out-Null } catch {}',
        '}',
        'Start-Sleep -Seconds 1',
        'Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue',
        `Set-Content -Path '${resultFile.replace(/'/g, "''")}' -Value 'ok'`,
    ].join('\r\n');
    fs.writeFileSync(scriptFile, ps, 'utf8');
    onProgress?.('Disabling LocalSystem Cloudflare service (approve Admin if asked)…');

    await new Promise((resolve) => {
        const child = spawn(
            'powershell.exe',
            [
                '-NoProfile',
                '-ExecutionPolicy',
                'Bypass',
                '-Command',
                `Start-Process -FilePath powershell.exe -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File','${scriptFile.replace(
                    /'/g,
                    "''"
                )}')`,
            ],
            { windowsHide: true }
        );
        child.on('error', () => resolve());
        child.on('close', () => resolve());
    });

    let result = '';
    try {
        result = fs.readFileSync(resultFile, 'utf8').trim();
    } catch {
        result = '';
    }
    return { ok: result === 'ok', result };
}

function isPidRunning(pid) {
    if (!pid) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

function writeHelperConfig(tunnel, hostname) {
    const dir = cloudflaredDir();
    fs.mkdirSync(dir, { recursive: true });
    const configPath = path.join(dir, 'config.yml');
    const body = [
        `# Managed by Live Dashboard Host setup`,
        `# Production uses tunnel token for "${tunnel.name}" run as the logged-in Windows user.`,
        `# Do not point tbadashboard.com at other tunnels (e.g. live-dashboard).`,
        `tunnel: ${tunnel.id}`,
        `ingress:`,
        `  - hostname: ${hostname}`,
        `    service: ${LOCAL_ORIGIN}`,
        `  - service: http_status:404`,
        '',
    ].join('\n');
    fs.writeFileSync(configPath, body, 'utf8');
    return configPath;
}

async function pickTunnel(bin) {
    const tunnels = await listTunnels(bin);
    const preferred = tunnels.find((t) => t.name === PREFERRED_TUNNEL_NAME);
    if (preferred) return preferred;
    return null;
}

/**
 * Ensure the Host user-mode Cloudflare tunnel is running (install path + tray launch).
 * forceRestart kills the current connector first — used by the watchdog when the
 * pid is alive but the public hostname is unreachable (zombie connector / 530).
 */
async function ensureHostTunnelRunning({ onProgress, token: tokenArg, forceRestart = false } = {}) {
    const progress = (msg) => onProgress?.(String(msg || ''));
    const bin = resolveCloudflared();
    if (!bin) throw new Error('cloudflared is not installed');

    const status = await getCloudflareStatus();
    if (status.pidRunning && !forceRestart) {
        progress('Cloudflare tunnel already running');
        return { ok: true, already: true, via: 'user-process', status };
    }
    if (status.pidRunning && forceRestart) {
        progress('Force-restarting Cloudflare tunnel…');
        // startTokenProcess below kills existing connectors before spawning.
    }

    let token = tokenArg || readHostTunnelToken();
    if (!token) {
        // Prefer production tunnel name only
        if (!hasCert()) {
            throw new Error('Cloudflare is not signed in on this PC. Use tray → Setup Cloudflare tunnel…');
        }
        progress('Fetching production tunnel token…');
        token = await getTunnelToken(bin, PREFERRED_TUNNEL_NAME);
        saveHostTunnelToken(token);
        installTunnelAutostart(bin, token);
    }

    progress('Starting Cloudflare tunnel…');
    // Prefer origin up first so cloudflared does not log a burst of refused connections.
    try {
        const deadline = Date.now() + 90000;
        while (Date.now() < deadline) {
            try {
                const res = await fetch('http://127.0.0.1:3100/api/health', {
                    signal: AbortSignal.timeout(2000),
                });
                if (res.ok) break;
            } catch {
                /* wait */
            }
            await new Promise((r) => setTimeout(r, 2000));
        }
    } catch {
        /* still start tunnel — public may 502 briefly */
    }
    let pid = await startTokenProcess(bin, token);
    let alive = await waitForTunnelPid(pid);
    if (!alive) {
        progress('Tunnel exited immediately — retrying once…');
        pid = await startTokenProcess(bin, token);
        alive = await waitForTunnelPid(pid);
    }
    if (!alive) {
        throw new Error(
            'Cloudflare tunnel process exited right after start. Run tray → Setup Cloudflare tunnel… or check cloudflared is installed.'
        );
    }
    await new Promise((r) => setTimeout(r, 1500));
    return {
        ok: true,
        already: false,
        via: 'user-process',
        pid,
        status: await getCloudflareStatus(),
    };
}

/**
 * Host Cloudflare cutover for tbadashboard.com.
 * Uses the production "dashboard" tunnel token as the logged-in Windows user
 * (LocalSystem Windows service returned 503 on this Host hardware).
 * Persists via Startup folder so reboot + auto-login restores the tunnel.
 *
 * @param {{ hostname?: string, onProgress?: Function, confirm?: Function, guided?: boolean }} opts
 */
async function setupCloudflareTunnel({
    hostname = DEFAULT_HOSTNAME,
    onProgress,
    confirm,
    guided = false,
    onOpenAdminSettings,
} = {}) {
    const progress = (msg) => onProgress?.(String(msg || ''));
    const ask = async (opts) => {
        if (typeof confirm !== 'function') return 0;
        return confirm(opts);
    };

    const bin = resolveCloudflared();
    if (!bin) {
        throw new Error(
            'cloudflared is not installed. Install Cloudflare Tunnel, then use tray → Setup Cloudflare tunnel.'
        );
    }
    const steps = [];

    if (guided) {
        const start = await ask({
            type: 'info',
            title: 'Cloudflare tunnel setup',
            message: 'Publish tbadashboard.com from this PC',
            detail: [
                'This walkthrough will:',
                '• Sign you into Cloudflare (browser)',
                '• Connect the production “dashboard” tunnel',
                '• Start the tunnel as your Windows user (reliable on this Host)',
                '• Install a Startup entry so it returns after reboot when you log in',
                '',
                'When it finishes, Admin Settings will open on this PC.',
            ].join('\n'),
            buttons: ['Start Cloudflare setup', 'Skip for now'],
            defaultId: 0,
            cancelId: 1,
        });
        if (start !== 0) {
            progress('Cloudflare setup skipped — you can run it later from the tray');
            return { ok: false, skipped: true, hostname };
        }
    }

    const ver = await run(bin, ['--version']);
    steps.push({ step: 'detect', ok: true, detail: (ver.stdout || ver.stderr).trim() });
    progress(`Found cloudflared: ${(ver.stdout || ver.stderr).trim().slice(0, 80)}`);

    const login = await ensureLoggedIn(bin, {
        onProgress: progress,
        confirm: guided ? confirm : undefined,
    });
    if (login.skipped) {
        return { ok: false, skipped: true, hostname, steps };
    }
    steps.push({ step: 'login', ok: true, detail: login.already ? 'already' : 'fresh' });

    progress('Looking up the production “dashboard” tunnel…');
    const tunnel = await pickTunnel(bin);
    if (!tunnel) {
        throw new Error(
            'Production tunnel “dashboard” was not found on this Cloudflare account. Sign in with the account that owns tbadashboard.com (do not create a new live-dashboard tunnel for production).'
        );
    }
    if (tunnel.name !== PREFERRED_TUNNEL_NAME) {
        throw new Error(`Expected tunnel “${PREFERRED_TUNNEL_NAME}”, got “${tunnel.name}”`);
    }
    steps.push({ step: 'tunnel', ok: true, detail: `${tunnel.name} (${tunnel.id})` });
    progress(`Using production tunnel “${tunnel.name}”`);

    if (guided) {
        await ask({
            type: 'info',
            title: 'Step: Connect tunnel',
            message: `Connect “${tunnel.name}” to this PC`,
            detail: [
                `${hostname} → ${LOCAL_ORIGIN}`,
                '',
                'Only one Host should run this tunnel at a time.',
                'The tunnel runs as your Windows user (not LocalSystem), which is required for a reliable public site on this PC.',
            ].join('\n'),
            buttons: ['Connect tunnel'],
            defaultId: 0,
        });
    }

    progress('Fetching tunnel token…');
    const token = await getTunnelToken(bin, tunnel.name);
    steps.push({ step: 'token', ok: true });
    saveHostTunnelToken(token);

    writeHelperConfig(tunnel, hostname);
    steps.push({ step: 'config', ok: true });

    // Disable LocalSystem service so it cannot fight the user-mode connector / return 503.
    try {
        const disabled = await disableSystemCloudflaredService({ onProgress: progress });
        steps.push({ step: 'disable-system-service', ok: disabled.ok });
    } catch (err) {
        steps.push({
            step: 'disable-system-service',
            ok: false,
            detail: String(err && err.message ? err.message : err),
        });
        progress('Could not disable LocalSystem Cloudflare service — continuing with user tunnel');
    }

    progress('Installing Startup entry so the tunnel returns after reboot…');
    const autostart = installTunnelAutostart(bin, token);
    steps.push({ step: 'autostart', ok: true, detail: autostart.cmdPath });

    progress('Starting Cloudflare tunnel…');
    let pid = await startTokenProcess(bin, token);
    let alive = await waitForTunnelPid(pid);
    if (!alive) {
        progress('Tunnel exited immediately — retrying once…');
        pid = await startTokenProcess(bin, token);
        alive = await waitForTunnelPid(pid);
    }
    steps.push({ step: 'tunnel-run', ok: alive, detail: alive ? `pid ${pid}` : 'process exited' });

    progress('Waiting for Cloudflare connector…');
    await new Promise((r) => setTimeout(r, 1500));
    const status = await getCloudflareStatus();

    if (guided) {
        await ask({
            type: status.running ? 'info' : 'warning',
            title: 'Cloudflare setup finished',
            message: status.running ? 'Tunnel is connected' : 'Tunnel start needs a moment',
            detail: [
                `${hostname} → ${LOCAL_ORIGIN}`,
                `Tunnel: ${tunnel.name}`,
                'Mode: your Windows user + Startup (survives reboot after login)',
                '',
                status.running
                    ? 'Opening Admin Settings on this PC so you can sign in.'
                    : 'Admin Settings will open — if the tunnel stays stopped, run Setup Cloudflare tunnel again from the tray.',
            ].join('\n'),
            buttons: ['Open Admin Settings'],
            defaultId: 0,
        });
        if (typeof onOpenAdminSettings === 'function') {
            try {
                await onOpenAdminSettings();
            } catch (err) {
                console.warn('[cloudflare] onOpenAdminSettings', err);
            }
        }
    }

    return {
        ok: true,
        hostname,
        tunnel,
        localOrigin: LOCAL_ORIGIN,
        service: status.service,
        pidRunning: status.pidRunning,
        running: status.running,
        autostart,
        steps,
        bin,
        elevated: false,
        via: 'user-process',
    };
}

async function getCloudflareStatus() {
    const service = await queryService();
    let pidRunning = false;
    let pid = null;
    try {
        if (fs.existsSync(PID_FILE)) {
            pid = Number(fs.readFileSync(PID_FILE, 'utf8'));
            pidRunning = isPidRunning(pid);
        }
    } catch {
        /* ignore */
    }
    const startupInstalled =
        fs.existsSync(startupVbsPath()) || fs.existsSync(startupCmdPath());
    const hasToken = Boolean(readHostTunnelToken());
    return {
        cloudflaredPath: resolveCloudflared(),
        hasCert: hasCert(),
        service,
        pid,
        pidRunning,
        startupInstalled,
        hasToken,
        // Prefer user-mode pid; LocalSystem service alone is not considered healthy on this Host.
        running: Boolean(pidRunning),
        configPath: path.join(cloudflaredDir(), 'config.yml'),
        pidFile: PID_FILE,
    };
}

/**
 * Stop local Cloudflare connector so another Host can own the tunnel.
 */
async function stopCloudflareTunnel() {
    const steps = [];
    stopPidFileProcess();
    removeTunnelAutostart();
    steps.push({ step: 'pid-file-and-autostart', ok: true });

    const stopped = await stopService();
    steps.push({ step: 'service-stop', ok: stopped.ok, detail: stopped.text });

    const bin = resolveCloudflared();
    if (bin) {
        try {
            await uninstallService(bin);
            steps.push({ step: 'service-uninstall', ok: true });
        } catch (err) {
            steps.push({
                step: 'service-uninstall',
                ok: false,
                detail: String(err && err.message ? err.message : err),
            });
        }
    }

    try {
        await new Promise((resolve) => {
            execFile('taskkill', ['/IM', 'cloudflared.exe', '/F'], { windowsHide: true }, () => resolve());
        });
        steps.push({ step: 'taskkill', ok: true });
    } catch {
        steps.push({ step: 'taskkill', ok: false });
    }

    return { ok: true, steps };
}

module.exports = {
    DEFAULT_HOSTNAME,
    PREFERRED_TUNNEL_NAME,
    FALLBACK_TUNNEL_NAME,
    LOCAL_ORIGIN,
    resolveCloudflared,
    setupCloudflareTunnel,
    stopCloudflareTunnel,
    ensureHostTunnelRunning,
    getCloudflareStatus,
    queryService,
    installTunnelAutostart,
};