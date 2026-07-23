/**
 * Tail PM2 process logs for Admin → Live logs (SSE).
 * Process names match area-coach-tools ecosystem.config.cjs
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const SOURCES = {
    'area-coach-tools': {
        id: 'area-coach-tools',
        label: 'Area Coach Tools',
        processes: ['area-coach-tools'],
    },
    'forecast-scheduler': {
        id: 'forecast-scheduler',
        label: 'Forecast scheduler',
        processes: ['forecast-scheduler'],
    },
    'report-download-scheduler': {
        id: 'report-download-scheduler',
        label: 'Report scheduler',
        processes: ['report-download-scheduler'],
    },
    all: {
        id: 'all',
        label: 'All Host processes',
        processes: ['area-coach-tools', 'forecast-scheduler', 'report-download-scheduler'],
    },
};

function pm2LogsDir() {
    const home = process.env.PM2_HOME || path.join(os.homedir(), '.pm2');
    return path.join(home, 'logs');
}

function listSources() {
    return Object.values(SOURCES).map(({ id, label, processes }) => ({ id, label, processes }));
}

function resolveSource(raw) {
    const key = String(raw || 'all').trim().toLowerCase();
    return SOURCES[key] || SOURCES.all;
}

function logFilesForSource(source) {
    const dir = pm2LogsDir();
    const files = [];
    for (const name of source.processes) {
        files.push({ process: name, stream: 'out', path: path.join(dir, `${name}-out.log`) });
        files.push({ process: name, stream: 'error', path: path.join(dir, `${name}-error.log`) });
    }
    return files;
}

function readFileTail(filePath, maxBytes = 96 * 1024) {
    if (!fs.existsSync(filePath)) return { exists: false, size: 0, text: '' };
    const stat = fs.statSync(filePath);
    const size = stat.size;
    if (size <= 0) return { exists: true, size: 0, text: '' };
    const start = Math.max(0, size - maxBytes);
    const fd = fs.openSync(filePath, 'r');
    try {
        const len = size - start;
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, start);
        let text = buf.toString('utf8');
        if (start > 0) {
            const nl = text.indexOf('\n');
            if (nl >= 0 && nl < text.length - 1) text = text.slice(nl + 1);
        }
        return { exists: true, size, text };
    } finally {
        fs.closeSync(fd);
    }
}

function splitLines(text) {
    return String(text || '')
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .split('\n')
        .filter((line, idx, arr) => line.length > 0 || idx < arr.length - 1);
}

function takeLastLines(text, maxLines) {
    const lines = splitLines(text);
    if (!maxLines || lines.length <= maxLines) return lines;
    return lines.slice(-maxLines);
}

function parseLogLine(raw, fallbackIso) {
    const text = String(raw ?? '');
    const match = text.match(
        /^(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:\s*[+-]\d{2}:?\d{2}|Z)?)\s*[:|]?\s*(.*)$/
    );
    if (match) {
        const stamp = match[1].replace(' ', 'T');
        const parsed = Date.parse(stamp);
        return {
            at: Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallbackIso || null,
            line: match[2],
        };
    }
    return { at: fallbackIso || null, line: text };
}

function writeSse(res, event, data) {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function emitLogLine(res, file, rawLine, { historical, fallbackIso }) {
    const { at, line } = parseLogLine(rawLine, fallbackIso);
    writeSse(res, 'line', {
        process: file.process,
        stream: file.stream,
        line,
        at,
        historical: Boolean(historical),
    });
}

function streamLogs(res, { source: sourceKey = 'area-coach-tools', tail = 200 } = {}) {
    const source = resolveSource(sourceKey);
    const maxTail = Math.min(2000, Math.max(50, Number(tail) || 200));
    const files = logFilesForSource(source);
    const offsets = new Map();

    writeSse(res, 'meta', {
        source: source.id,
        label: source.label,
        logsDir: pm2LogsDir(),
        files: files.map((f) => ({
            process: f.process,
            stream: f.stream,
            path: f.path,
            exists: fs.existsSync(f.path),
        })),
    });

    let anyExists = false;
    for (const file of files) {
        const snap = readFileTail(file.path);
        offsets.set(file.path, snap.size);
        if (!snap.exists) continue;
        anyExists = true;
        for (const line of takeLastLines(snap.text, maxTail)) {
            emitLogLine(res, file, line, { historical: true, fallbackIso: null });
        }
    }

    writeSse(res, 'status', {
        level: anyExists ? 'ok' : 'warn',
        message: anyExists
            ? `Tailing ${source.label}…`
            : `No PM2 log files under ${pm2LogsDir()}. Start with PM2 or the tray Host.`,
    });

    let closed = false;
    const poll = setInterval(() => {
        if (closed) return;
        for (const file of files) {
            try {
                if (!fs.existsSync(file.path)) continue;
                const size = fs.statSync(file.path).size;
                const prev = offsets.get(file.path) || 0;
                if (size < prev) offsets.set(file.path, 0);
                const from = offsets.get(file.path) || 0;
                if (size <= from) continue;
                const fd = fs.openSync(file.path, 'r');
                try {
                    const len = size - from;
                    const buf = Buffer.alloc(len);
                    fs.readSync(fd, buf, 0, len, from);
                    offsets.set(file.path, size);
                    const nowIso = new Date().toISOString();
                    for (const line of splitLines(buf.toString('utf8'))) {
                        if (!line) continue;
                        emitLogLine(res, file, line, { historical: false, fallbackIso: nowIso });
                    }
                } finally {
                    fs.closeSync(fd);
                }
            } catch (err) {
                writeSse(res, 'status', {
                    level: 'warn',
                    message: `Could not read ${path.basename(file.path)}: ${err.message || err}`,
                });
            }
        }
    }, 750);

    const heartbeat = setInterval(() => {
        if (!closed) {
            try {
                res.write(`: ping ${Date.now()}\n\n`);
            } catch {
                /* ignore */
            }
        }
    }, 15000);

    const cleanup = () => {
        closed = true;
        clearInterval(poll);
        clearInterval(heartbeat);
    };
    res.on('close', cleanup);
    return cleanup;
}

function downloadLogs(sourceKey = 'area-coach-tools', maxBytes = 2 * 1024 * 1024) {
    const source = resolveSource(sourceKey);
    const parts = [];
    for (const file of logFilesForSource(source)) {
        const snap = readFileTail(file.path, maxBytes);
        parts.push(`===== ${file.process}-${file.stream} (${file.path}) =====\n`);
        parts.push(snap.exists ? snap.text : '(missing)\n');
        parts.push('\n');
    }
    return {
        filename: `${source.id}-logs.txt`,
        body: parts.join(''),
    };
}

module.exports = {
    listSources,
    streamLogs,
    downloadLogs,
    pm2LogsDir,
};
