/**
 * Lightweight live-update bus for multi-user Admin/Settings clients.
 * SSE at GET /api/live/events + version stamp at GET /api/live/version.
 */

const clients = new Set();
let version = 1;
let lastEvent = {
    type: 'hello',
    at: Date.now(),
    message: 'live bus ready',
};

function bump(type, detail = {}) {
    version += 1;
    lastEvent = {
        type: String(type || 'updated'),
        at: Date.now(),
        version,
        ...detail,
    };
    const payload = `event: ${lastEvent.type}\ndata: ${JSON.stringify(lastEvent)}\n\n`;
    for (const res of clients) {
        try {
            res.write(payload);
        } catch {
            clients.delete(res);
        }
    }
    return lastEvent;
}

function getVersion() {
    return { version, lastEvent };
}

function attach(app, { requireUser } = {}) {
    const guard = typeof requireUser === 'function' ? requireUser : (_req, _res, next) => next();

    app.get('/api/live/version', guard, (_req, res) => {
        res.json(getVersion());
    });

    app.get('/api/live/events', guard, (req, res) => {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders?.();
        res.write(`event: hello\ndata: ${JSON.stringify({ version, at: Date.now() })}\n\n`);
        clients.add(res);
        const heartbeat = setInterval(() => {
            try {
                res.write(`: ping ${Date.now()}\n\n`);
            } catch {
                clearInterval(heartbeat);
                clients.delete(res);
            }
        }, 25000);
        req.on('close', () => {
            clearInterval(heartbeat);
            clients.delete(res);
        });
    });
}

module.exports = {
    bump,
    getVersion,
    attach,
};
