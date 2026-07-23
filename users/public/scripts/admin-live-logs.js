(function (global) {
    const SOURCES = [
        { id: 'dashboard', label: 'Dashboard' },
        { id: 'report-download-scheduler', label: 'Report scheduler' },
        { id: 'forecast-scheduler', label: 'Forecast scheduler' },
        { id: 'all', label: 'All processes' },
    ];
    const MAX_DOM_LINES = 2500;

    let pageHost = null;
    let eventSource = null;
    let visibilityObserver = null;
    let activeSource = 'dashboard';
    let paused = false;
    let followTail = true;
    let statusText = 'Open this section to stream Host logs.';

    function escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function getRoot() {
        return pageHost || null;
    }

    function isVisible() {
        return Boolean(pageHost && !pageHost.hidden);
    }

    function setStatus(text, level = '') {
        statusText = String(text || '');
        const el = getRoot()?.querySelector('#admin-live-logs-status');
        if (!el) return;
        el.textContent = statusText;
        el.dataset.level = level || '';
    }

    function logEl() {
        return getRoot()?.querySelector('#admin-live-logs-output');
    }

    function formatLogTime(iso) {
        if (!iso) return '';
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return '';
        try {
            return d.toLocaleTimeString('en-AU', {
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                hour12: false,
            });
        } catch {
            return d.toISOString().slice(11, 19);
        }
    }

    function appendLine({ process: proc, stream, line, historical, at }) {
        if (paused && !historical) return;
        const root = logEl();
        if (!root) return;
        const row = document.createElement('div');
        row.className = `admin-live-logs-line admin-live-logs-line--${stream === 'error' ? 'error' : 'out'}`;
        if (historical) row.classList.add('admin-live-logs-line--hist');
        const time = document.createElement('span');
        time.className = 'admin-live-logs-time';
        const stamp = formatLogTime(at);
        time.textContent = stamp || '—';
        if (at) time.title = at;
        const tag = document.createElement('span');
        tag.className = 'admin-live-logs-tag';
        tag.textContent = `${proc || '?'}${stream === 'error' ? ' · err' : ''}`;
        tag.title =
            stream === 'error'
                ? 'stderr (console.warn / console.error) — not always a hard failure'
                : 'stdout';
        const body = document.createElement('span');
        body.className = 'admin-live-logs-text';
        body.textContent = line ?? '';
        row.appendChild(time);
        row.appendChild(tag);
        row.appendChild(body);
        root.appendChild(row);
        while (root.childElementCount > MAX_DOM_LINES) {
            root.removeChild(root.firstElementChild);
        }
        if (followTail) {
            root.scrollTop = root.scrollHeight;
        }
    }

    function clearOutput() {
        const root = logEl();
        if (root) root.innerHTML = '';
    }

    function filenameFromDisposition(header, fallback) {
        if (!header) return fallback;
        const match = String(header).match(/filename\*?=(?:UTF-8''|")?([^\";]+)/i);
        if (!match) return fallback;
        try {
            return decodeURIComponent(match[1].replace(/"/g, '').trim()) || fallback;
        } catch {
            return match[1].replace(/"/g, '').trim() || fallback;
        }
    }

    async function exportLogs() {
        const btn = getRoot()?.querySelector('[data-live-log-export]');
        if (btn) {
            btn.disabled = true;
            btn.textContent = 'Exporting…';
        }
        setStatus('Preparing log export…', 'info');
        try {
            const res = await fetch(
                `/api/admin/logs/download?source=${encodeURIComponent(activeSource)}`,
                { credentials: 'same-origin' }
            );
            if (!res.ok) {
                let message = `Export failed (${res.status})`;
                try {
                    const data = await res.json();
                    if (data?.error) message = data.error;
                } catch {
                    /* ignore */
                }
                throw new Error(message);
            }
            const blob = await res.blob();
            const fallback = `host-logs-${activeSource}.txt`;
            const filename = filenameFromDisposition(res.headers.get('Content-Disposition'), fallback);
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = filename;
            document.body.appendChild(link);
            link.click();
            link.remove();
            URL.revokeObjectURL(url);
            setStatus(`Exported ${filename}`, 'ok');
        } catch (err) {
            setStatus(err?.message || 'Could not export logs.', 'error');
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.textContent = 'Export';
            }
        }
    }

    function stopStream() {
        if (eventSource) {
            try {
                eventSource.close();
            } catch {
                /* ignore */
            }
            eventSource = null;
        }
    }

    function startStream() {
        if (!isVisible()) return;
        stopStream();
        clearOutput();
        setStatus('Connecting…', 'info');
        const url = `/api/admin/logs/stream?source=${encodeURIComponent(activeSource)}&tail=300`;
        const es = new EventSource(url);
        eventSource = es;

        es.addEventListener('meta', (ev) => {
            try {
                const data = JSON.parse(ev.data);
                const missing = (data.files || []).filter((f) => !f.exists).length;
                const total = (data.files || []).length;
                setStatus(
                    missing === total
                        ? `Connected — no log files yet (${data.logsDir || 'PM2 logs'})`
                        : `Connected — ${data.label || activeSource}`,
                    missing === total ? 'warn' : 'ok'
                );
            } catch {
                setStatus('Connected', 'ok');
            }
        });

        es.addEventListener('line', (ev) => {
            try {
                appendLine(JSON.parse(ev.data));
            } catch {
                /* ignore */
            }
        });

        es.addEventListener('status', (ev) => {
            try {
                const data = JSON.parse(ev.data);
                setStatus(data.message || 'Status update', data.level || '');
            } catch {
                /* ignore */
            }
        });

        es.onerror = () => {
            if (eventSource !== es) return;
            setStatus('Disconnected — retrying…', 'warn');
        };
    }

    function syncStreamToVisibility() {
        if (isVisible()) {
            if (!eventSource) startStream();
        } else {
            stopStream();
            setStatus('Paused while another settings section is open.', 'info');
        }
    }

    function renderSourceTabs() {
        return SOURCES.map(
            (s) =>
                `<button type="button" class="admin-live-logs-source${s.id === activeSource ? ' is-active' : ''}" data-live-log-source="${escapeHtml(s.id)}" aria-pressed="${s.id === activeSource ? 'true' : 'false'}">${escapeHtml(s.label)}</button>`
        ).join('');
    }

    function bindUi() {
        const root = getRoot();
        if (!root || root.dataset.liveLogsBound) return;
        root.dataset.liveLogsBound = '1';

        root.addEventListener('click', (event) => {
            const sourceBtn = event.target.closest('[data-live-log-source]');
            if (sourceBtn) {
                const next = sourceBtn.getAttribute('data-live-log-source') || 'dashboard';
                if (next === activeSource) return;
                activeSource = next;
                root.querySelectorAll('[data-live-log-source]').forEach((btn) => {
                    const on = btn.getAttribute('data-live-log-source') === activeSource;
                    btn.classList.toggle('is-active', on);
                    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
                });
                startStream();
                return;
            }
            if (event.target.closest('[data-live-log-clear]')) {
                clearOutput();
                return;
            }
            if (event.target.closest('[data-live-log-export]')) {
                void exportLogs();
                return;
            }
            if (event.target.closest('[data-live-log-pause]')) {
                paused = !paused;
                const btn = root.querySelector('[data-live-log-pause]');
                if (btn) btn.textContent = paused ? 'Resume' : 'Pause';
                setStatus(paused ? 'Paused' : 'Live', paused ? 'warn' : 'ok');
                return;
            }
            if (event.target.closest('[data-live-log-follow]')) {
                followTail = !followTail;
                const btn = root.querySelector('[data-live-log-follow]');
                if (btn) {
                    btn.classList.toggle('is-active', followTail);
                    btn.setAttribute('aria-pressed', followTail ? 'true' : 'false');
                }
                if (followTail) {
                    const out = logEl();
                    if (out) out.scrollTop = out.scrollHeight;
                }
            }
        });

        logEl()?.addEventListener('scroll', () => {
            const out = logEl();
            if (!out) return;
            const nearBottom = out.scrollHeight - out.scrollTop - out.clientHeight < 48;
            if (!nearBottom && followTail) {
                followTail = false;
                const btn = getRoot()?.querySelector('[data-live-log-follow]');
                if (btn) {
                    btn.classList.remove('is-active');
                    btn.setAttribute('aria-pressed', 'false');
                }
            }
        });
    }

    function watchVisibility() {
        if (!pageHost || visibilityObserver) return;
        visibilityObserver = new MutationObserver(() => syncStreamToVisibility());
        visibilityObserver.observe(pageHost, { attributes: true, attributeFilter: ['hidden'] });
    }

    function renderShell() {
        const root = getRoot();
        if (!root) return;
        root.innerHTML = `
            <div class="admin-modal admin-modal--inline admin-live-logs">
                <div class="admin-section-header">
                    <h2>Live logs</h2>
                    <p class="admin-section-subtitle">Host process output from PM2 (dashboard and schedulers). Updates live while this section is open. Use Export to download log tails for the selected source.</p>
                </div>
                <div class="admin-live-logs-toolbar">
                    <div class="admin-live-logs-sources" role="group" aria-label="Log source">${renderSourceTabs()}</div>
                    <div class="admin-live-logs-actions">
                        <button type="button" class="admin-live-logs-action is-active" data-live-log-follow aria-pressed="true">Follow</button>
                        <button type="button" class="admin-live-logs-action" data-live-log-pause>Pause</button>
                        <button type="button" class="admin-live-logs-action" data-live-log-clear>Clear</button>
                        <button type="button" class="admin-live-logs-action" data-live-log-export title="Download PM2 log tails for the selected source">Export</button>
                    </div>
                </div>
                <p class="admin-live-logs-status" id="admin-live-logs-status" data-level="">${escapeHtml(statusText)}</p>
                <div class="admin-live-logs-output" id="admin-live-logs-output" role="log" aria-live="polite" aria-relevant="additions"></div>
            </div>`;
        delete root.dataset.liveLogsBound;
        bindUi();
        watchVisibility();
    }

    function setInlineHost(host) {
        if (pageHost && pageHost !== host) {
            stopStream();
            visibilityObserver?.disconnect();
            visibilityObserver = null;
        }
        pageHost = host || null;
        if (!pageHost) {
            stopStream();
            return;
        }
        if (!pageHost.querySelector('.admin-live-logs')) {
            paused = false;
            followTail = true;
            renderShell();
        }
        syncStreamToVisibility();
    }

    async function mount(host) {
        setInlineHost(host);
    }

    function unmount() {
        stopStream();
        visibilityObserver?.disconnect();
        visibilityObserver = null;
        pageHost = null;
    }

    global.AdminLiveLogs = { mount, unmount, setInlineHost };
})(window);
