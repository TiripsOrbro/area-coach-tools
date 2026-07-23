/**
 * Near-real-time sync for Admin/Settings pages.
 * Subscribes to SSE /api/live/events with poll fallback on /api/live/version.
 */
(function () {
    const TOAST_ID = 'live-sync-toast';
    let lastVersion = 0;
    let reloadTimer = null;

    function showToast(message) {
        let el = document.getElementById(TOAST_ID);
        if (!el) {
            el = document.createElement('div');
            el.id = TOAST_ID;
            el.setAttribute('role', 'status');
            el.style.cssText =
                'position:fixed;z-index:99999;left:50%;bottom:24px;transform:translateX(-50%);' +
                'background:#1f2937;color:#f9fafb;padding:10px 16px;border-radius:10px;' +
                'font:600 13px/1.4 system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.35);';
            document.body.appendChild(el);
        }
        el.textContent = message;
        el.hidden = false;
        clearTimeout(el._hide);
        el._hide = setTimeout(() => {
            el.hidden = true;
        }, 4000);
    }

    function scheduleReload(reason) {
        if (reloadTimer) return;
        showToast(reason || 'Updated elsewhere — refreshing…');
        reloadTimer = setTimeout(() => {
            window.location.reload();
        }, 1200);
    }

    function onEvent(payload) {
        const type = String(payload && payload.type ? payload.type : '');
        if (!type || type === 'hello') return;
        // Only reload for genuine config changes. sales.updated fires after every
        // scrape (~1/min) and must NOT trigger a full page reload.
        if (/settings|accounts|storelist/i.test(type)) {
            scheduleReload(`Settings updated (${type}) — refreshing…`);
        }
    }

    function connectSse() {
        if (!window.EventSource) return false;
        try {
            const es = new EventSource('/api/live/events');
            es.addEventListener('hello', () => {});
            ['settings.updated', 'accounts.updated', 'storelist.updated', 'message'].forEach(
                (name) => {
                    es.addEventListener(name, (ev) => {
                        try {
                            onEvent(JSON.parse(ev.data || '{}'));
                        } catch {
                            /* ignore */
                        }
                    });
                }
            );
            es.onmessage = (ev) => {
                try {
                    onEvent(JSON.parse(ev.data || '{}'));
                } catch {
                    /* ignore */
                }
            };
            es.onerror = () => {
                /* keep open; browser retries */
            };
            return true;
        } catch {
            return false;
        }
    }

    async function pollVersion() {
        try {
            const res = await fetch('/api/live/version', { credentials: 'same-origin', cache: 'no-store' });
            if (!res.ok) return;
            const body = await res.json();
            const v = Number(body.version || 0);
            if (lastVersion && v > lastVersion) onEvent(body.lastEvent || { type: 'updated' });
            lastVersion = v || lastVersion;
        } catch {
            /* offline */
        }
    }

    function start() {
        const sseOk = connectSse();
        pollVersion();
        if (!sseOk) {
            setInterval(pollVersion, 8000);
        } else {
            setInterval(pollVersion, 30000);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }
})();
