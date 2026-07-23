(function () {
    const sections = [...document.querySelectorAll('main section')];
    const navButtons = [...document.querySelectorAll('nav button[data-section]')];
    let prepWeekday = 'Monday';
    let prepStores = [];
    let logSource = null;

    function money(n) {
        const v = Math.round(Number(n) || 0);
        return `$${v.toLocaleString('en-AU')}`;
    }

    function show(id) {
        sections.forEach((s) => s.classList.toggle('active', s.id === id));
        navButtons.forEach((b) => b.classList.toggle('active', b.dataset.section === id));
        if (id === 'forecast') loadForecast();
        if (id === 'buildto') loadBuildTo();
        if (id === 'daily') loadDaily();
        if (id === 'prep') loadPrep();
    }

    navButtons.forEach((btn) => btn.addEventListener('click', () => show(btn.dataset.section)));

    async function api(url, opts) {
        const res = await fetch(url, {
            headers: { 'Content-Type': 'application/json', ...(opts?.headers || {}) },
            ...opts,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || res.statusText);
        return data;
    }

    function setMsg(id, text, ok) {
        const el = document.getElementById(id);
        if (!el) return;
        el.innerHTML = text ? `<span class="${ok ? 'ok' : 'bad'}">${text}</span>` : '';
    }

    function appendFcLog(lines) {
        const el = document.getElementById('fc-log');
        if (!el) return;
        const stamp = new Date().toLocaleTimeString();
        const block = (Array.isArray(lines) ? lines : [lines])
            .filter(Boolean)
            .map((l) => `[${stamp}] ${l}`)
            .join('\n');
        if (!block) return;
        const prev = el.textContent === 'Backfill / submit logs appear here.' ? '' : el.textContent;
        el.textContent = prev ? `${prev}\n${block}` : block;
        el.scrollTop = el.scrollHeight;
    }

    async function loadForecast() {
        const el = document.getElementById('fc-status');
        try {
            const data = await api('/api/admin/forecast/status');
            const rows = data.stores || [];
            if (!rows.length) {
                el.innerHTML = '<span class="bad">No stores in coach scope. Log in as Ash/Tom and tick stores in Account.</span>';
                return;
            }
            el.innerHTML = `
                <table class="dense">
                    <thead>
                        <tr>
                            <th>Store</th>
                            <th>Week $</th>
                            <th>History</th>
                            <th>This</th>
                            <th>Next</th>
                            <th>After</th>
                            <th></th>
                        </tr>
                    </thead>
                    <tbody>
                        ${rows
                            .map((s) => {
                                const states = s.weekStates || [];
                                const chip = (idx) => {
                                    const w = states[idx];
                                    if (!w) return '—';
                                    return `<span class="chip ${w.state}">${w.state === 'done' ? 'Done' : 'Pending'}</span>`;
                                };
                                return `<tr data-store="${s.storeNumber}">
                                    <td>
                                        <strong>${s.storeNumber}</strong>
                                        <div style="color:var(--muted);font-size:.75rem">${s.storeName || ''} · ${s.historyDays || 0}d · ${s.lastHistoryDate || '—'}</div>
                                    </td>
                                    <td><span class="money">${money(s.weekTotal)}</span></td>
                                    <td>
                                        <span class="${s.historyReady ? 'ok' : 'bad'}">${s.historyReady ? 'Ready' : 'Low'}</span>
                                        <button class="action tiny fc-backfill-one" data-store="${s.storeNumber}">Refresh</button>
                                    </td>
                                    <td>${chip(0)}</td>
                                    <td>${chip(1)}</td>
                                    <td>${chip(2)}</td>
                                    <td>
                                        <button class="action tiny fc-submit-one" data-store="${s.storeNumber}">Submit</button>
                                    </td>
                                </tr>`;
                            })
                            .join('')}
                    </tbody>
                </table>`;
            el.querySelectorAll('.fc-submit-one').forEach((btn) => {
                btn.addEventListener('click', () => runForecastStores([btn.dataset.store]));
            });
            el.querySelectorAll('.fc-backfill-one').forEach((btn) => {
                btn.addEventListener('click', () => backfillStores([btn.dataset.store]));
            });
        } catch (err) {
            el.innerHTML = `<span class="bad">${err.message}</span>`;
        }
    }

    async function runForecastStores(storeNumbers, all) {
        setMsg('fc-msg', 'Submitting…', true);
        appendFcLog(all ? 'Update area — submitting all stores…' : `Submitting store(s): ${(storeNumbers || []).join(', ')}`);
        try {
            const body = all ? { all: true } : { storeNumbers };
            const data = await api('/api/admin/forecast/run', {
                method: 'POST',
                body: JSON.stringify(body),
            });
            const n = (data.results || []).length;
            setMsg('fc-msg', `Submit done (${n} store(s)).`, true);
            appendFcLog(`Submit finished — ${n} store(s).`);
            (data.results || []).forEach((r) => {
                appendFcLog(
                    `${r.storeNumber || '?'}: ${r.state || 'done'}${r.message ? ` — ${r.message}` : ''}`
                );
            });
            loadForecast();
        } catch (err) {
            setMsg('fc-msg', err.message, false);
            appendFcLog(`Submit ERROR: ${err.message}`);
        }
    }

    async function backfillStores(storeNumbers, all) {
        setMsg('fc-msg', 'Backfilling 5 weeks from MMX…', true);
        appendFcLog(
            all
                ? 'Backfill area — scraping last 5 weeks of hourly sales for all stores…'
                : `Backfill store(s) ${(storeNumbers || []).join(', ')} — last 5 weeks…`
        );
        try {
            const body = all ? { all: true } : { storeNumbers };
            const res = await fetch('/api/admin/forecast/backfill', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            const data = await res.json().catch(() => ({}));
            const logs = data.logs || [];
            logs.forEach((line) => appendFcLog(line));
            (data.results || []).forEach((r) => {
                if (!logs.length && r.logs) r.logs.forEach((line) => appendFcLog(line));
                if (r.error && !(r.logs || []).some((l) => String(l).includes(r.error))) {
                    appendFcLog(`${r.storeNumber}: ERROR — ${r.error}`);
                }
            });
            const summary =
                data.message ||
                (data.success
                    ? `Backfill finished — imported ${data.imported || 0} day(s).`
                    : 'Backfill finished with errors.');
            setMsg('fc-msg', summary, Boolean(data.success));
            appendFcLog(summary);
            if (!res.ok && !data.message) throw new Error(data.error || res.statusText);
            loadForecast();
        } catch (err) {
            setMsg('fc-msg', err.message, false);
            appendFcLog(`Backfill ERROR: ${err.message}`);
        }
    }

    document.getElementById('fc-refresh').addEventListener('click', loadForecast);
    document.getElementById('fc-update-area').addEventListener('click', () => runForecastStores([], true));
    document.getElementById('fc-backfill-area').addEventListener('click', () => backfillStores([], true));

    function fmtWhen(iso) {
        if (!iso) return '—';
        try {
            return new Date(iso).toLocaleString();
        } catch {
            return iso;
        }
    }

    async function loadBuildTo() {
        const el = document.getElementById('bt-status');
        const storesEl = document.getElementById('bt-stores');
        try {
            const data = await api('/api/admin/build-to/status');
            const last = data.lastRun;
            el.innerHTML = `
                <p><strong>Workbook</strong><br><code style="font-size:.8rem">${data.workbookPath || '—'}</code>
                ${data.workbookExists ? '<span class="ok"> · ready</span>' : '<span class="bad"> · missing</span>'}
                ${data.workbookSource === 'downloads' ? ' · Downloads master' : ' · fallback copy'}</p>
                <p><strong>Automation</strong> ${
                    data.automationExists
                        ? `<span class="ok">found</span><br><code style="font-size:.75rem">${data.automationDir || ''}</code>`
                        : `<span class="bad">missing</span><br><span class="bad" style="font-size:.85rem">${data.hint || ''}</span>`
                }
                ${data.running ? ' · <span class="chip pending">running</span>' : ''}</p>
                <p><strong>Last run</strong> ${
                    last
                        ? `${last.ok ? '<span class="ok">ok</span>' : '<span class="bad">failed</span>'} · ${last.mode || 'reports'} · ${fmtWhen(last.finishedAt || last.startedAt)}`
                        : '—'
                }</p>
                ${last?.error ? `<p class="bad">${last.error}</p>` : ''}
                ${last?.warnEmailSent ? '<p class="ok">Warn email sent to coach alert address.</p>' : ''}`;

            const rows = data.stores || [];
            if (!rows.length) {
                storesEl.innerHTML = '<span class="bad">No stores in coach scope.</span>';
            } else {
                storesEl.innerHTML = `
                    <table class="dense">
                        <thead>
                            <tr>
                                <th>Store</th>
                                <th>Build-to updated</th>
                                <th>MMX orders updated</th>
                                <th></th>
                            </tr>
                        </thead>
                        <tbody>
                            ${rows
                                .map(
                                    (s) => `<tr>
                                <td><strong>${s.storeNumber}</strong> <span style="color:var(--muted)">${s.storeName || ''}</span>
                                    ${s.lastError ? `<div class="bad" style="font-size:.75rem">${s.lastError}</div>` : ''}
                                </td>
                                <td class="${s.buildToUpdatedAt ? 'ok' : ''}">${fmtWhen(s.buildToUpdatedAt)}</td>
                                <td class="${s.mmxOrdersUpdatedAt ? 'ok' : ''}">${fmtWhen(s.mmxOrdersUpdatedAt)}</td>
                                <td>
                                    <button class="action tiny bt-one-reports" data-store="${s.storeNumber}">Reports</button>
                                    <button class="action tiny bt-one-orders" data-store="${s.storeNumber}">Orders</button>
                                </td>
                            </tr>`
                                )
                                .join('')}
                        </tbody>
                    </table>`;
                storesEl.querySelectorAll('.bt-one-reports').forEach((btn) => {
                    btn.addEventListener('click', () => runBuildTo('reports', [btn.dataset.store]));
                });
                storesEl.querySelectorAll('.bt-one-orders').forEach((btn) => {
                    btn.addEventListener('click', () => runBuildTo('orders', [btn.dataset.store]));
                });
            }
        } catch (err) {
            el.innerHTML = `<span class="bad">${err.message}</span>`;
            if (storesEl) storesEl.innerHTML = '';
        }
    }

    async function runBuildTo(mode, storeNumbers) {
        const el = document.getElementById('bt-status');
        el.insertAdjacentHTML(
            'afterbegin',
            `<p>Starting ${mode === 'orders' ? 'MMX orders' : 'On Hand / On Order / ISE download'}…</p>`
        );
        try {
            const body = storeNumbers?.length ? { mode, storeNumbers } : { mode };
            const data = await api('/api/admin/build-to/run', {
                method: 'POST',
                body: JSON.stringify(body),
            });
            el.insertAdjacentHTML(
                'afterbegin',
                `<p class="${data.ok ? 'ok' : 'bad'}">${data.ok ? 'Finished.' : data.error || 'Failed.'}</p>`
            );
            loadBuildTo();
        } catch (err) {
            el.insertAdjacentHTML('afterbegin', `<p class="bad">${err.message}</p>`);
            loadBuildTo();
        }
    }

    document.getElementById('bt-refresh').addEventListener('click', loadBuildTo);
    document.getElementById('bt-edit').addEventListener('click', async () => {
        const el = document.getElementById('bt-status');
        try {
            const data = await api('/api/admin/build-to/open', { method: 'POST', body: '{}' });
            el.insertAdjacentHTML(
                'afterbegin',
                `<p class="${data.ok ? 'ok' : 'bad'}">${data.ok ? 'Opened in Excel:' : 'Could not open:'} ${data.path || data.error || ''}</p>`
            );
        } catch (err) {
            el.insertAdjacentHTML('afterbegin', `<p class="bad">${err.message}</p>`);
        }
    });
    document.getElementById('bt-run').addEventListener('click', () => runBuildTo('reports'));
    document.getElementById('bt-orders').addEventListener('click', () => runBuildTo('orders'));

    function toggleBtn(on, kind, store) {
        return `<button type="button" class="toggle daily-toggle ${on ? 'on' : ''}" aria-pressed="${on ? 'true' : 'false'}" title="${on ? 'On' : 'Off'} — click to toggle" data-kind="${kind}" data-store="${store}" data-on="${on ? '1' : '0'}"></button>`;
    }

    function formatDailyStamp(value) {
        if (value == null || value === '') return '—';
        if (typeof value === 'object') {
            const iso = value.at || value.checkedAt || value.lastStockRun;
            return iso ? fmtWhen(iso) : '—';
        }
        const s = String(value);
        if (!s || s === 'null' || s === 'undefined') return '—';
        if (/^\d{4}-\d{2}-\d{2}/.test(s)) return fmtWhen(s);
        return s;
    }

    async function setDailyToggle(store, kind, nextOn) {
        const body =
            kind === 'stock'
                ? { stores: [{ storeNumber: store, stockEnabled: nextOn }] }
                : { stores: [{ storeNumber: store, forecastEnabled: nextOn }] };
        await api('/api/admin/five-am-reports/stores', {
            method: 'PUT',
            body: JSON.stringify(body),
        });
        loadDaily();
    }

    async function loadDaily() {
        const el = document.getElementById('daily-list');
        try {
            const data = await api('/api/admin/five-am-reports/stores');
            const rows = data.storeList || [];
            if (!rows.length) {
                el.innerHTML = '<span class="bad">No stores in coach scope.</span>';
                return;
            }
            el.innerHTML = `
                <table class="dense">
                    <thead>
                        <tr>
                            <th>Store</th>
                            <th>Stock levels</th>
                            <th>Forecast</th>
                            <th>Last forecast</th>
                            <th>Last stock run</th>
                            <th></th>
                        </tr>
                    </thead>
                    <tbody>
                        ${rows
                            .map(
                                (s) => `<tr>
                            <td><strong>${s.storeNumber}</strong> <span style="color:var(--muted)">${s.storeName || ''}</span></td>
                            <td>${toggleBtn(Boolean(s.stockEnabled), 'stock', s.storeNumber)}</td>
                            <td>${toggleBtn(Boolean(s.forecastEnabled), 'forecast', s.storeNumber)}</td>
                            <td>${formatDailyStamp(s.lastForecastAt)}</td>
                            <td>${formatDailyStamp(s.lastStockRun)}</td>
                            <td>
                                <button type="button" class="action tiny daily-check-one" data-store="${s.storeNumber}" title="Check current levels for this store">Check</button>
                            </td>
                        </tr>`
                            )
                            .join('')}
                    </tbody>
                </table>`;
            el.querySelectorAll('.daily-toggle').forEach((btn) => {
                btn.addEventListener('click', async () => {
                    const nextOn = btn.dataset.on !== '1';
                    btn.disabled = true;
                    try {
                        await setDailyToggle(btn.dataset.store, btn.dataset.kind, nextOn);
                    } catch (err) {
                        setMsg('daily-msg', err.message, false);
                        btn.disabled = false;
                    }
                });
            });
            el.querySelectorAll('.daily-check-one').forEach((btn) => {
                btn.addEventListener('click', () => checkCurrentLevels([btn.dataset.store], btn));
            });
        } catch (err) {
            el.innerHTML = `<span class="bad">${err.message}</span>`;
        }
    }

    async function checkCurrentLevels(storeNumbers, btn) {
        setMsg('daily-msg', 'Checking current levels…', true);
        if (btn) btn.disabled = true;
        try {
            const body = storeNumbers?.length ? { storeNumbers } : {};
            const data = await api('/api/admin/daily-reports/run', {
                method: 'POST',
                body: JSON.stringify(body),
            });
            const okCount = (data.results || []).filter((r) => r.ok).length;
            const fail = (data.results || []).filter((r) => !r.ok);
            setMsg(
                'daily-msg',
                fail.length
                    ? `Checked ${okCount}; ${fail.length} failed (${fail.map((f) => f.storeNumber).join(', ')}).`
                    : data.message || `Checked ${okCount} store(s).`,
                !fail.length
            );
            loadDaily();
        } catch (err) {
            setMsg('daily-msg', err.message, false);
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    document.getElementById('daily-refresh').addEventListener('click', loadDaily);
    document.getElementById('daily-run').addEventListener('click', () => checkCurrentLevels());

    function renderPrepTabs() {
        const tabs = document.getElementById('pg-tabs');
        const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
        tabs.innerHTML = days
            .map(
                (d) =>
                    `<button type="button" data-day="${d}" class="${d === prepWeekday ? 'active' : ''}">${d.slice(0, 3)}</button>`
            )
            .join('');
        tabs.querySelectorAll('button').forEach((btn) => {
            btn.addEventListener('click', () => {
                prepWeekday = btn.dataset.day;
                renderPrepTabs();
                showPrepPdf();
            });
        });
    }

    function showPrepPdf() {
        const store = document.getElementById('pg-store').value;
        const frame = document.getElementById('pg-frame');
        if (!store) {
            frame.removeAttribute('src');
            return;
        }
        frame.src = `/api/admin/prep-guides/${encodeURIComponent(store)}/${encodeURIComponent(prepWeekday)}.pdf?t=${Date.now()}`;
    }

    async function loadPrep() {
        renderPrepTabs();
        const sel = document.getElementById('pg-store');
        const prev = sel.value;
        try {
            const data = await api('/api/admin/prep-guides');
            prepStores = data.stores || [];
            sel.innerHTML = prepStores
                .map((s) => {
                    const stamp = s.regeneratedAt ? ` · ${new Date(s.regeneratedAt).toLocaleString()}` : ' · not generated';
                    return `<option value="${s.storeNumber}">${s.storeNumber}${stamp}</option>`;
                })
                .join('');
            if (prev && [...sel.options].some((o) => o.value === prev)) sel.value = prev;
            showPrepPdf();
            setMsg('pg-msg', prepStores.length ? '' : 'No stores in coach scope.', false);
        } catch (err) {
            setMsg('pg-msg', err.message, false);
        }
    }

    document.getElementById('pg-store').addEventListener('change', showPrepPdf);
    document.getElementById('pg-refresh').addEventListener('click', loadPrep);
    document.getElementById('pg-regen').addEventListener('click', async () => {
        const store = document.getElementById('pg-store').value;
        setMsg('pg-msg', 'Regenerating (Excel + PDFs)…', true);
        try {
            await api('/api/admin/prep-guides/regenerate', {
                method: 'POST',
                body: JSON.stringify({ storeNumber: store }),
            });
            setMsg('pg-msg', 'Regenerated.', true);
            loadPrep();
        } catch (err) {
            setMsg('pg-msg', err.message, false);
        }
    });
    document.getElementById('pg-email').addEventListener('click', async () => {
        setMsg('pg-msg', 'Sending…', true);
        try {
            const data = await api('/api/admin/prep-guides/email-now', { method: 'POST', body: '{}' });
            setMsg('pg-msg', `Email pass: ${JSON.stringify(data.result?.results || data.result || data)}`, true);
        } catch (err) {
            setMsg('pg-msg', err.message, false);
        }
    });

    document.getElementById('log-connect').addEventListener('click', () => {
        const view = document.getElementById('log-view');
        document.getElementById('log-download').href = '/api/admin/logs/download?source=all';
        if (logSource) logSource.close();
        view.textContent = '';
        logSource = new EventSource('/api/admin/logs/stream?source=all');
        logSource.addEventListener('line', (ev) => {
            try {
                const row = JSON.parse(ev.data);
                view.textContent += `[${row.process}/${row.stream}] ${row.line}\n`;
                view.scrollTop = view.scrollHeight;
            } catch {
                /* ignore */
            }
        });
        logSource.addEventListener('status', (ev) => {
            view.textContent += `* ${ev.data}\n`;
        });
    });

    async function loadCoachBanner() {
        const el = document.getElementById('coach-banner');
        if (!el) return;
        try {
            const data = await api('/api/coach/session');
            const s = data.session || {};
            if (s.displayName || s.userId) {
                const n = (s.enabledStores || []).length;
                el.textContent = `${s.displayName || s.userId} · ${s.region || '?'} · ${n} stores · MMX ${s.mmx?.configured ? 'ok' : 'missing'} · LifeLenz ${s.lifelenz?.configured ? 'ok' : 'missing'}`;
            } else {
                el.textContent = 'No coach session — log in as Ash or Tom in the desktop app.';
            }
        } catch {
            el.textContent = 'Coach session unavailable.';
        }
    }

    show('forecast');
    loadCoachBanner();
})();
