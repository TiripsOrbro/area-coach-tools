const fs = require('fs');
const path = require('path');
const paths = require('../../src/paths');

const FILE = path.join(paths.dashboard.data, 'store-emails.json');

function readAll() {
    if (!fs.existsSync(FILE)) return {};
    try {
        const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
        return raw && typeof raw === 'object' ? raw : {};
    } catch {
        return {};
    }
}

function writeAll(map) {
    const next = {};
    for (const [k, v] of Object.entries(map || {})) {
        const email = String(v || '').trim();
        if (email) next[String(k)] = email;
    }
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    return next;
}

function getEmail(storeNumber) {
    return readAll()[String(storeNumber || '').trim()] || '';
}

module.exports = { FILE, readAll, writeAll, getEmail };
