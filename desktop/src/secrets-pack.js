/**
 * Host secrets pack — folder you ship next to the installer.
 *
 * Expected layout (from scripts/export-host-secrets-pack.js):
 *
 *   secrets/
 *     README.txt
 *     .env                 (or env.txt) — encryption keys & SMTP only
 *     store-logins/        — stores/data/store-logins/*.json
 *     accounts/            — users/accounts/** (accounts.users files)
 *     mmx-users/           — users/data/mmx-users/* (optional)
 *     lifelenz-users/      — users/data/lifelenz-users/* (optional)
 *     .storelist           — optional store list
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const SECRET_ENV_KEYS = [
    'STORE_CREDENTIALS_KEY',
    'MMX_USER_CREDENTIALS_KEY',
    'SCRAPER_CREDENTIALS_KEY',
    'DASHBOARD_AUTH_SECRET',
    'DASHBOARD_NOLOGIN_SECRET',
    'DASHBOARD_ALERT_EMAIL',
    'DASHBOARD_SMTP_HOST',
    'DASHBOARD_SMTP_PORT',
    'DASHBOARD_SMTP_USER',
    'DASHBOARD_SMTP_PASS',
    'DASHBOARD_ALERT_WEBHOOK_URL',
];

function existsDir(p) {
    try {
        return Boolean(p) && fs.existsSync(p) && fs.statSync(p).isDirectory();
    } catch {
        return false;
    }
}

function existsFile(p) {
    try {
        return Boolean(p) && fs.existsSync(p) && fs.statSync(p).isFile();
    } catch {
        return false;
    }
}

function parseEnvFile(text) {
    const out = {};
    for (const line of String(text || '').split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq <= 0) continue;
        const key = trimmed.slice(0, eq).trim();
        let val = trimmed.slice(eq + 1).trim();
        if (
            (val.startsWith('"') && val.endsWith('"')) ||
            (val.startsWith("'") && val.endsWith("'"))
        ) {
            val = val.slice(1, -1);
        }
        out[key] = val;
    }
    return out;
}

function formatEnvValue(val) {
    const s = String(val ?? '');
    if (/[\s#"']/.test(s)) return JSON.stringify(s);
    return s;
}

function readSecretsEnv(secretsRoot) {
    const candidates = ['.env', 'env.txt', '.env.secrets', 'secrets.env'];
    for (const name of candidates) {
        const p = path.join(secretsRoot, name);
        if (existsFile(p)) {
            return { path: p, values: parseEnvFile(fs.readFileSync(p, 'utf8')) };
        }
    }
    return null;
}

function looksLikeSecretsPack(dir) {
    if (!existsDir(dir)) return false;
    if (readSecretsEnv(dir)) return true;
    if (existsDir(path.join(dir, 'store-logins'))) return true;
    if (existsDir(path.join(dir, 'accounts'))) return true;
    if (existsDir(path.join(dir, 'stores', 'data', 'store-logins'))) return true;
    if (existsDir(path.join(dir, 'users', 'accounts'))) return true;
    return false;
}

/** Prefer a nested `secrets` folder if the user picked the pack root. */
function resolveSecretsRoot(selectedPath) {
    const selected = String(selectedPath || '').trim();
    if (!selected) return null;
    if (looksLikeSecretsPack(selected)) return selected;
    const nested = path.join(selected, 'secrets');
    if (looksLikeSecretsPack(nested)) return nested;
    return selected;
}

function suggestSecretsFolders() {
    const home = os.homedir();
    const candidates = [
        path.join(home, 'Desktop', 'Taco Bell Dashboard', 'secrets'),
        path.join(home, 'Desktop', 'Taco Bell Dashboard Pack', 'secrets'),
        path.join(home, 'Desktop', 'TacoBellDashboard', 'secrets'),
        path.join(home, 'Downloads', 'Taco Bell Dashboard', 'secrets'),
        path.join(home, 'Downloads', 'Taco Bell Dashboard Pack', 'secrets'),
        path.join(home, 'Documents', 'Taco Bell Dashboard', 'secrets'),
        path.join(process.cwd(), 'secrets'),
        path.join(path.dirname(process.execPath), 'secrets'),
        path.join(path.dirname(process.execPath), '..', 'secrets'),
    ];
    const found = [];
    for (const p of candidates) {
        try {
            const resolved = path.resolve(p);
            if (looksLikeSecretsPack(resolved) && !found.includes(resolved)) {
                found.push(resolved);
            }
        } catch {
            /* ignore */
        }
    }
    return found;
}

function copyFileEnsureDir(src, dest) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
}

function copyDirRecursive(src, dest) {
    if (!existsDir(src)) return 0;
    let count = 0;
    fs.mkdirSync(dest, { recursive: true });
    for (const name of fs.readdirSync(src)) {
        const from = path.join(src, name);
        const to = path.join(dest, name);
        const st = fs.statSync(from);
        if (st.isDirectory()) {
            count += copyDirRecursive(from, to);
        } else if (st.isFile()) {
            copyFileEnsureDir(from, to);
            count += 1;
        }
    }
    return count;
}

function mergeEnvSecrets(serverDir, secretValues, onProgress) {
    const envPath = path.join(serverDir, '.env');
    const existing = existsFile(envPath) ? parseEnvFile(fs.readFileSync(envPath, 'utf8')) : {};
    const merged = { ...existing };
    let applied = 0;
    for (const [key, val] of Object.entries(secretValues || {})) {
        if (!key) continue;
        // Prefer known secret keys; also allow any key from a dedicated secrets .env
        // that is not a Windows scrape-tuning key already set locally for 16gb.
        const isKnown = SECRET_ENV_KEYS.includes(key);
        const isTuning = /^(SCRAPER_|SCRAPE_|PM2_|MMX_PARALLEL|MMX_FAST|MORNING_|DAILY_REPORTS_CONCURRENCY|FORECAST_STORE_CONCURRENCY|BACKFILL_)/.test(
            key
        );
        if (!isKnown && isTuning && existing[key]) continue;
        if (val === undefined || val === null || val === '') continue;
        if (merged[key] !== val) {
            merged[key] = val;
            applied += 1;
        }
    }
    const lines = Object.entries(merged).map(([k, v]) => `${k}=${formatEnvValue(v)}`);
    fs.writeFileSync(envPath, `${lines.join('\n')}\n`, 'utf8');
    onProgress?.(
        applied
            ? `Merged ${applied} secret value(s) into server .env`
            : 'Server .env already had matching secrets'
    );
    return applied;
}

/**
 * Import a secrets pack into an existing server checkout.
 * @returns {{ ok: boolean, root: string, imported: object, warnings: string[] }}
 */
function importSecretsPack(secretsPath, serverDir, { onProgress } = {}) {
    const root = resolveSecretsRoot(secretsPath);
    const warnings = [];
    const imported = {
        envKeys: 0,
        storeLogins: 0,
        accounts: 0,
        mmxUsers: 0,
        lifelenzUsers: 0,
        storelist: false,
    };

    if (!root || !existsDir(root)) {
        throw new Error('Secrets folder not found. Pick the "secrets" folder from your install pack.');
    }
    if (!existsDir(serverDir)) {
        throw new Error(`Server folder missing: ${serverDir}`);
    }

    onProgress?.(`Importing secrets from:\n${root}`);

    const envPack = readSecretsEnv(root);
    if (envPack) {
        imported.envKeys = mergeEnvSecrets(serverDir, envPack.values, onProgress);
    } else {
        warnings.push('No .env / env.txt in secrets folder — set STORE_CREDENTIALS_KEY manually if store logins are encrypted.');
        onProgress?.(warnings[warnings.length - 1]);
    }

    const storeLoginSrc = existsDir(path.join(root, 'store-logins'))
        ? path.join(root, 'store-logins')
        : existsDir(path.join(root, 'stores', 'data', 'store-logins'))
          ? path.join(root, 'stores', 'data', 'store-logins')
          : null;
    if (storeLoginSrc) {
        const dest = path.join(serverDir, 'stores', 'data', 'store-logins');
        imported.storeLogins = copyDirRecursive(storeLoginSrc, dest);
        onProgress?.(`Copied ${imported.storeLogins} store login file(s)`);
    }

    const accountsSrc = existsDir(path.join(root, 'accounts'))
        ? path.join(root, 'accounts')
        : existsDir(path.join(root, 'users', 'accounts'))
          ? path.join(root, 'users', 'accounts')
          : null;
    if (accountsSrc) {
        const dest = path.join(serverDir, 'users', 'accounts');
        imported.accounts = copyDirRecursive(accountsSrc, dest);
        onProgress?.(`Copied ${imported.accounts} account file(s)`);
    }

    const mmxSrc = existsDir(path.join(root, 'mmx-users'))
        ? path.join(root, 'mmx-users')
        : existsDir(path.join(root, 'users', 'data', 'mmx-users'))
          ? path.join(root, 'users', 'data', 'mmx-users')
          : null;
    if (mmxSrc) {
        const dest = path.join(serverDir, 'users', 'data', 'mmx-users');
        imported.mmxUsers = copyDirRecursive(mmxSrc, dest);
        onProgress?.(`Copied ${imported.mmxUsers} MMX user credential file(s)`);
    }

    const llSrc = existsDir(path.join(root, 'lifelenz-users'))
        ? path.join(root, 'lifelenz-users')
        : existsDir(path.join(root, 'users', 'data', 'lifelenz-users'))
          ? path.join(root, 'users', 'data', 'lifelenz-users')
          : null;
    if (llSrc) {
        const dest = path.join(serverDir, 'users', 'data', 'lifelenz-users');
        imported.lifelenzUsers = copyDirRecursive(llSrc, dest);
        onProgress?.(`Copied ${imported.lifelenzUsers} LifeLenz credential file(s)`);
    }

    const storelistSrc = [
        path.join(root, '.storelist'),
        path.join(root, 'storelist.txt'),
        path.join(root, 'stores', '.storelist'),
    ].find((p) => existsFile(p));
    if (storelistSrc) {
        copyFileEnsureDir(storelistSrc, path.join(serverDir, 'stores', '.storelist'));
        imported.storelist = true;
        onProgress?.('Copied store list');
    }

    const total =
        imported.envKeys +
        imported.storeLogins +
        imported.accounts +
        imported.mmxUsers +
        imported.lifelenzUsers +
        (imported.storelist ? 1 : 0);
    if (!total) {
        throw new Error(
            'That folder does not look like a secrets pack. Export one on the old Host, or pick the "secrets" folder next to the installer.'
        );
    }

    onProgress?.('Secrets import complete');
    return { ok: true, root, imported, warnings };
}

function buildSecretsEnvFromServerEnv(serverEnvText) {
    const all = parseEnvFile(serverEnvText);
    const lines = ['# Host secrets only — safe to keep next to the installer (treat as confidential)', ''];
    for (const key of SECRET_ENV_KEYS) {
        if (all[key] === undefined || all[key] === '') continue;
        lines.push(`${key}=${formatEnvValue(all[key])}`);
    }
    return `${lines.join('\n')}\n`;
}

/**
 * Export a Host secrets pack from a server checkout (tray / desktop use).
 * @returns {{ ok: boolean, outRoot: string, counts: object }}
 */
function exportSecretsPack(serverDir, outRoot) {
    const root = path.resolve(String(serverDir || ''));
    const dest = path.resolve(
        String(outRoot || '').trim() ||
            path.join(os.homedir(), 'Desktop', 'Taco Bell Dashboard Pack', 'secrets')
    );
    if (!existsDir(root)) {
        throw new Error(`Server folder not found: ${root}`);
    }

    fs.mkdirSync(dest, { recursive: true });
    const counts = {
        env: false,
        storeLogins: 0,
        accounts: 0,
        mmxUsers: 0,
        lifelenzUsers: 0,
        storelist: false,
    };

    const envPath = path.join(root, '.env');
    if (existsFile(envPath)) {
        const secretsEnv = buildSecretsEnvFromServerEnv(fs.readFileSync(envPath, 'utf8'));
        fs.writeFileSync(path.join(dest, '.env'), secretsEnv, 'utf8');
        fs.writeFileSync(path.join(dest, 'env.txt'), secretsEnv, 'utf8');
        counts.env = true;
    }

    counts.storeLogins = copyDirRecursive(
        path.join(root, 'stores', 'data', 'store-logins'),
        path.join(dest, 'store-logins')
    );
    counts.accounts = copyDirRecursive(path.join(root, 'users', 'accounts'), path.join(dest, 'accounts'));
    counts.mmxUsers = copyDirRecursive(
        path.join(root, 'users', 'data', 'mmx-users'),
        path.join(dest, 'mmx-users')
    );
    counts.lifelenzUsers = copyDirRecursive(
        path.join(root, 'users', 'data', 'lifelenz-users'),
        path.join(dest, 'lifelenz-users')
    );

    const storelist = path.join(root, 'stores', '.storelist');
    if (existsFile(storelist)) {
        copyFileEnsureDir(storelist, path.join(dest, '.storelist'));
        copyFileEnsureDir(storelist, path.join(dest, 'storelist.txt'));
        counts.storelist = true;
    }

    fs.writeFileSync(
        path.join(dest, 'README.txt'),
        [
            'Taco Bell Dashboard — Host secrets pack',
            '',
            'Keep this folder private. Put it next to the installer:',
            '',
            '  Taco Bell Dashboard Pack\\',
            '    Taco Bell Dashboard Installer.exe',
            '    secrets\\          ← this folder',
            '',
            'On the new Host PC: run the installer (or tray → Become Host…),',
            'then browse to this secrets folder when asked.',
            '',
            'Do not commit this folder to git or email it unencrypted.',
            '',
        ].join('\n'),
        'utf8'
    );

    const total =
        (counts.env ? 1 : 0) +
        counts.storeLogins +
        counts.accounts +
        counts.mmxUsers +
        counts.lifelenzUsers +
        (counts.storelist ? 1 : 0);
    if (!total) {
        throw new Error('Nothing to export — server folder has no .env, store logins, or accounts yet.');
    }

    return { ok: true, outRoot: dest, counts };
}

module.exports = {
    SECRET_ENV_KEYS,
    looksLikeSecretsPack,
    resolveSecretsRoot,
    suggestSecretsFolders,
    importSecretsPack,
    exportSecretsPack,
    buildSecretsEnvFromServerEnv,
    parseEnvFile,
    readSecretsEnv,
};
