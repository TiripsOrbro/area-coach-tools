(function () {
    const sections = [...document.querySelectorAll('main section')];
    const navButtons = [...document.querySelectorAll('nav button[data-section]')];
    let prepWeekday = 'Monday';
    let prepStores = [];
    let logSource = null;
    /** Concurrent daily Check runs — one log panel per store. */
    const activeDailyChecks = new Map();
    let dailyLogRunSeq = 0;

    function money(n) {
        const v = Math.round(Number(n) || 0);
        return `$${v.toLocaleString('en-AU')}`;
    }

    const HISTORY_ICON_SVG =
        '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 3v18h18"/><path d="M7 14l3-3 3 2 5-6"/></svg>';

    function show(id) {
        sections.forEach((s) => s.classList.toggle('active', s.id === id));
        navButtons.forEach((b) => b.classList.toggle('active', b.dataset.section === id));
        if (id === 'overview') {
            loadOverview();
            startOverviewLive();
        } else {
            stopOverviewLive();
        }
        if (id === 'forecast') loadForecast();
        if (id === 'buildto') loadBuildTo();
        if (id === 'daily') loadDaily();
        if (id === 'shortfalls') loadShortfalls();
        if (id === 'prep') loadPrep();
    }

    navButtons.forEach((btn) => btn.addEventListener('click', () => show(btn.dataset.section)));

    function coachDesktopApi() {
        return window.coachApi || null;
    }

    function bindCoachNavFooter() {
        const footer = document.getElementById('coach-nav-footer');
        if (!footer) return;

        // Account / View / Update / Exit need the Electron desktop bridge.
        if (!coachDesktopApi()) {
            footer.hidden = true;
            return;
        }

        footer.querySelectorAll('.nav-submenu-toggle').forEach((toggle) => {
            toggle.addEventListener('click', () => {
                const submenu = toggle.closest('.nav-submenu');
                if (!submenu) return;
                const open = !submenu.classList.contains('is-open');
                footer.querySelectorAll('.nav-submenu.is-open').forEach((el) => {
                    if (el !== submenu) {
                        el.classList.remove('is-open');
                        el.querySelector('.nav-submenu-toggle')?.setAttribute('aria-expanded', 'false');
                    }
                });
                submenu.classList.toggle('is-open', open);
                toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
            });
        });

        footer.addEventListener('click', async (event) => {
            const btn = event.target.closest('[data-coach-action]');
            if (!btn || !footer.contains(btn)) return;
            const action = btn.getAttribute('data-coach-action');
            const api = coachDesktopApi();
            if (!api) return;
            try {
                if (action === 'account-settings') await api.openAccount();
                else if (action === 'switch-user') await api.logout();
                else if (action === 'reload') await api.reload();
                else if (action === 'toggle-devtools') await api.toggleDevTools();
                else if (action === 'open-in-browser') await api.openInBrowser();
                else if (action === 'update') await api.updateAndRestart();
                else if (action === 'exit') await api.exit();
            } catch (err) {
                console.error('[coach-nav]', action, err);
            }
        });
    }

    bindCoachNavFooter();

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

    function fmtRelative(iso) {
        if (!iso) return { text: 'Never', fresh: false };
        const t = new Date(iso).getTime();
        if (!Number.isFinite(t)) return { text: String(iso), fresh: false };
        const diffMs = Date.now() - t;
        const abs = Math.abs(diffMs);
        const mins = Math.round(abs / 60000);
        let text;
        if (mins < 1) text = 'just now';
        else if (mins < 60) text = `${mins}m ago`;
        else if (mins < 60 * 24) text = `${Math.round(mins / 60)}h ago`;
        else if (mins < 60 * 24 * 14) text = `${Math.round(mins / (60 * 24))}d ago`;
        else {
            try {
                text = new Date(iso).toLocaleString();
            } catch {
                text = String(iso);
            }
        }
        // Fresh within 36 hours
        return { text, fresh: diffMs >= 0 && abs <= 36 * 60 * 60 * 1000 };
    }

    function overviewWhenCell(iso) {
        const when = fmtRelative(iso);
        const title = iso
            ? (() => {
                  try {
                      return new Date(iso).toLocaleString();
                  } catch {
                      return String(iso);
                  }
              })()
            : 'Never';
        return `<td class="ov-when ${when.fresh ? 'ok' : 'bad'}" data-iso="${iso ? String(iso).replace(/"/g, '') : ''}" title="${title}"><span class="ov-status-pip" aria-hidden="true"></span><span class="ov-when-text">${when.text}</span></td>`;
    }

    const overviewLive = {
        stores: [],
        lastFetchedAt: 0,
        refreshTimer: null,
        tickTimer: null,
        focusTimer: null,
        focusIndex: 0,
        loading: false,
        esBound: false,
    };

    function overviewIsActive() {
        return document.getElementById('overview')?.classList.contains('active');
    }

    function paintOverviewClock() {
        const el = document.getElementById('ov-live-clock');
        if (!el) return;
        try {
            el.textContent = new Date().toLocaleTimeString('en-AU', {
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
            });
        } catch {
            el.textContent = new Date().toLocaleTimeString();
        }
    }

    function paintOverviewUpdated() {
        const el = document.getElementById('ov-live-updated');
        if (!el) return;
        if (!overviewLive.lastFetchedAt) {
            el.textContent = 'Waiting…';
            return;
        }
        const secs = Math.max(0, Math.round((Date.now() - overviewLive.lastFetchedAt) / 1000));
        if (secs < 5) el.textContent = 'Updated just now';
        else if (secs < 60) el.textContent = `Updated ${secs}s ago`;
        else el.textContent = `Updated ${Math.round(secs / 60)}m ago`;
    }

    function paintOverviewSummary(stores, { animate = false } = {}) {
        const host = document.getElementById('ov-summary');
        if (!host) return;
        const rows = Array.isArray(stores) ? stores : [];
        if (!rows.length) {
            host.hidden = true;
            host.innerHTML = '';
            return;
        }
        const fields = [
            'buildToUpdatedAt',
            'ordersUpdatedAt',
            'forecastUpdatedAt',
            'prepGuidesSentAt',
            'shortfallsCheckedAt',
            'shortfallsEmailedAt',
        ];
        let freshCells = 0;
        let staleCells = 0;
        let storesNeedingAttention = 0;
        for (const s of rows) {
            let storeStale = false;
            for (const f of fields) {
                const fresh = fmtRelative(s[f]).fresh;
                if (fresh) freshCells += 1;
                else {
                    staleCells += 1;
                    storeStale = true;
                }
            }
            if (storeStale) storesNeedingAttention += 1;
        }
        const allOk = storesNeedingAttention === 0;
        const fullyUp = rows.length - storesNeedingAttention;
        const totalCells = freshCells + staleCells;
        const next = {
            stores: String(rows.length),
            fully: String(fullyUp),
            attention: String(storesNeedingAttention),
            fresh: `${freshCells} / ${totalCells}`,
            allOk,
            needsAttention: storesNeedingAttention > 0,
        };

        host.hidden = false;
        const existing = host.querySelectorAll('.ov-stat');
        if (existing.length === 4 && !animate) {
            const [elStores, elFully, elAtt, elFresh] = existing;
            const setVal = (el, text) => {
                const v = el.querySelector('.ov-stat-value');
                if (v && v.childNodes[0]?.nodeType === Node.TEXT_NODE) {
                    if (v.childNodes[0].textContent !== text) v.childNodes[0].textContent = text;
                } else if (v && v.textContent !== text) {
                    v.textContent = text;
                }
            };
            setVal(elStores, next.stores);
            setVal(elFully, next.fully);
            setVal(elAtt, next.attention);
            const freshVal = elFresh.querySelector('.ov-stat-value');
            if (freshVal) {
                const label = `<span style="font-size:.7rem;color:var(--muted);font-weight:500"> / ${totalCells}</span>`;
                const desired = `${freshCells}${label}`;
                if (freshVal.dataset.freshKey !== `${freshCells}/${totalCells}`) {
                    freshVal.dataset.freshKey = `${freshCells}/${totalCells}`;
                    freshVal.innerHTML = desired;
                }
            }
            elFully.classList.toggle('ok', next.allOk);
            elFully.classList.toggle('warn', !next.allOk);
            elAtt.classList.toggle('bad', next.needsAttention);
            elAtt.classList.toggle('ok', !next.needsAttention);
            return;
        }

        host.innerHTML = `
            <div class="ov-stat${animate ? ' ov-stat-enter' : ''}">
                <span class="ov-stat-label">Stores</span>
                <span class="ov-stat-value">${next.stores}</span>
            </div>
            <div class="ov-stat ${next.allOk ? 'ok' : 'warn'}${animate ? ' ov-stat-enter' : ''}">
                <span class="ov-stat-label">Fully up to date</span>
                <span class="ov-stat-value">${next.fully}</span>
            </div>
            <div class="ov-stat ${next.needsAttention ? 'bad' : 'ok'}${animate ? ' ov-stat-enter' : ''}">
                <span class="ov-stat-label">Need attention</span>
                <span class="ov-stat-value">${next.attention}</span>
            </div>
            <div class="ov-stat ok${animate ? ' ov-stat-enter' : ''}">
                <span class="ov-stat-label">Fresh timestamps</span>
                <span class="ov-stat-value" data-fresh-key="${freshCells}/${totalCells}">${freshCells}<span style="font-size:.7rem;color:var(--muted);font-weight:500"> / ${totalCells}</span></span>
            </div>`;
    }

    function renderOverviewTable(stores) {
        const el = document.getElementById('ov-grid');
        if (!el) return;
        const rows = Array.isArray(stores) ? stores : [];
        if (!rows.length) {
            el.innerHTML =
                '<span class="bad">No stores in coach scope. Log in as WA / VIC / Taco Bell and tick stores in Account.</span>';
            return;
        }
        el.innerHTML = `
            <table class="dense ov-table">
                <thead>
                    <tr>
                        <th>Store Name</th>
                        <th>Build Tos Updated</th>
                        <th>Orders Placed</th>
                        <th>Forecast Updated</th>
                        <th>Prep Guides Sent</th>
                        <th>Shortfalls Checked</th>
                        <th>Shortfalls Emailed</th>
                    </tr>
                </thead>
                <tbody>
                    ${rows
                        .map((s, idx) => {
                            const name = `${s.storeNumber}${s.storeName ? ` ${s.storeName}` : ''}`;
                            const focus =
                                overviewLive.focusIndex % rows.length === idx ? ' ov-row-focus' : '';
                            return `<tr class="${focus.trim()}" data-ov-idx="${idx}">
                        <td><strong>${name}</strong></td>
                        ${overviewWhenCell(s.buildToUpdatedAt)}
                        ${overviewWhenCell(s.ordersUpdatedAt)}
                        ${overviewWhenCell(s.forecastUpdatedAt)}
                        ${overviewWhenCell(s.prepGuidesSentAt)}
                        ${overviewWhenCell(s.shortfallsCheckedAt)}
                        ${overviewWhenCell(s.shortfallsEmailedAt)}
                    </tr>`;
                        })
                        .join('')}
                </tbody>
            </table>`;
    }

    function refreshOverviewRelativeTimes() {
        document.querySelectorAll('#ov-grid td.ov-when[data-iso]').forEach((td) => {
            const iso = td.getAttribute('data-iso');
            const when = fmtRelative(iso || null);
            td.classList.toggle('ok', when.fresh);
            td.classList.toggle('bad', !when.fresh);
            // Update label text only — keep the pip node so CSS animations don't restart
            let label = td.querySelector('.ov-when-text');
            if (!label) {
                const pip = td.querySelector('.ov-status-pip');
                label = document.createElement('span');
                label.className = 'ov-when-text';
                // Clear leftover text nodes after pip
                [...td.childNodes].forEach((n) => {
                    if (n !== pip) td.removeChild(n);
                });
                if (!pip) {
                    td.innerHTML = `<span class="ov-status-pip" aria-hidden="true"></span>`;
                }
                td.appendChild(label);
            }
            if (label.textContent !== when.text) label.textContent = when.text;
        });
        paintOverviewSummary(overviewLive.stores, { animate: false });
        paintOverviewUpdated();
        paintOverviewClock();
    }

    function advanceOverviewFocus() {
        const rows = [...document.querySelectorAll('#ov-grid table.ov-table tbody tr')];
        if (!rows.length) return;
        rows.forEach((r) => r.classList.remove('ov-row-focus'));
        overviewLive.focusIndex = (overviewLive.focusIndex + 1) % rows.length;
        const next = rows[overviewLive.focusIndex];
        if (next) next.classList.add('ov-row-focus');
    }

    function stopOverviewLive() {
        if (overviewLive.refreshTimer) {
            clearInterval(overviewLive.refreshTimer);
            overviewLive.refreshTimer = null;
        }
        if (overviewLive.tickTimer) {
            clearInterval(overviewLive.tickTimer);
            overviewLive.tickTimer = null;
        }
        if (overviewLive.focusTimer) {
            clearInterval(overviewLive.focusTimer);
            overviewLive.focusTimer = null;
        }
    }

    function startOverviewLive() {
        stopOverviewLive();
        paintOverviewClock();
        paintOverviewUpdated();
        overviewLive.tickTimer = setInterval(() => {
            if (!overviewIsActive()) return;
            refreshOverviewRelativeTimes();
        }, 1000);
        overviewLive.focusTimer = setInterval(() => {
            if (!overviewIsActive()) return;
            advanceOverviewFocus();
        }, 4500);
        overviewLive.refreshTimer = setInterval(() => {
            if (!overviewIsActive() || document.hidden) return;
            loadOverview({ silent: true });
        }, 30_000);
    }

    function bindOverviewLiveEvents() {
        if (overviewLive.esBound) return;
        overviewLive.esBound = true;
        const bump = () => {
            if (overviewIsActive() && !document.hidden) loadOverview({ silent: true });
        };
        try {
            const es = new EventSource('/api/live/events');
            [
                'activity.updated',
                'daily-reports.updated',
                'build-to.updated',
                'forecast.updated',
                'hello',
            ].forEach((ev) => es.addEventListener(ev, bump));
        } catch {
            /* polling covers it */
        }
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden && overviewIsActive()) loadOverview({ silent: true });
        });
    }

    async function loadOverview(options = {}) {
        const el = document.getElementById('ov-grid');
        if (!el) return;
        if (overviewLive.loading) return;
        overviewLive.loading = true;
        const silent = Boolean(options.silent);
        try {
            const data = await api('/api/admin/area-overview');
            const rows = data.stores || [];
            overviewLive.stores = rows;
            overviewLive.lastFetchedAt = Date.now();
            if (!rows.length) {
                el.innerHTML =
                    '<span class="bad">No stores in coach scope. Log in as WA / VIC / Taco Bell and tick stores in Account.</span>';
                const summary = document.getElementById('ov-summary');
                if (summary) {
                    summary.hidden = true;
                    summary.innerHTML = '';
                }
                setMsg('ov-msg', '', true);
                paintOverviewUpdated();
                return;
            }
            if (overviewLive.focusIndex >= rows.length) overviewLive.focusIndex = 0;
            renderOverviewTable(rows);
            paintOverviewSummary(rows, { animate: !silent });
            paintOverviewUpdated();
            paintOverviewClock();
            if (!silent) setMsg('ov-msg', `${rows.length} store(s) · live`, true);
            startOverviewLive();
            bindOverviewLiveEvents();
        } catch (err) {
            if (!silent) {
                el.innerHTML = `<span class="bad">${err.message}</span>`;
                setMsg('ov-msg', err.message, false);
            }
        } finally {
            overviewLive.loading = false;
        }
    }

    document.getElementById('ov-refresh')?.addEventListener('click', () => loadOverview({ silent: false }));

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
                el.innerHTML = '<span class="bad">No stores in coach scope. Log in as WA / VIC / Taco Bell and tick stores in Account.</span>';
                return;
            }
            el.innerHTML = `
                <table class="dense fc-table">
                    <thead>
                        <tr>
                            <th>Store</th>
                            <th>Week $</th>
                            <th>History</th>
                            <th>This Week</th>
                            <th>Next Week</th>
                            <th>Week after</th>
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
                                const missingHistory = !s.historyReady;
                                const nameColor = missingHistory ? 'var(--bad)' : 'var(--muted)';
                                return `<tr data-store="${s.storeNumber}">
                                    <td>
                                        <strong class="${missingHistory ? 'bad' : ''}" title="${missingHistory ? 'Missing sales history - open History icon or Backfill area' : ''}">${s.storeNumber}</strong>
                                        <div style="color:${nameColor};font-size:.75rem">${s.storeName || ''}${missingHistory ? ' · needs history' : ` · ${s.historyDays || 0}d · ${s.lastHistoryDate || '-'}`}</div>
                                    </td>
                                    <td><span class="money">${money(s.weekTotal)}</span></td>
                                    <td>
                                        <button type="button" class="icon-btn fc-history-one" data-store="${s.storeNumber}" title="View / edit sales history" aria-label="View history for ${s.storeNumber}">${HISTORY_ICON_SVG}</button>
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
            el.querySelectorAll('.fc-history-one').forEach((btn) => {
                btn.addEventListener('click', () => openForecastHistory(btn.dataset.store));
            });
        } catch (err) {
            el.innerHTML = `<span class="bad">${err.message}</span>`;
        }
    }

    let historyStoreNumber = null;
    let historyDaysCache = [];

    function weekdayLabel(iso) {
        try {
            return new Intl.DateTimeFormat('en-AU', {
                timeZone: 'Australia/Melbourne',
                weekday: 'short',
            }).format(new Date(`${iso}T12:00:00`));
        } catch {
            return '';
        }
    }

    function setHistoryMsg(text, ok) {
        const el = document.getElementById('fc-history-msg');
        if (!el) return;
        el.innerHTML = text ? `<span class="${ok ? 'ok' : 'bad'}">${text}</span>` : '';
    }

    function closeForecastHistory() {
        const backdrop = document.getElementById('fc-history-backdrop');
        if (backdrop) {
            backdrop.classList.remove('open');
            backdrop.setAttribute('aria-hidden', 'true');
        }
        historyStoreNumber = null;
        historyDaysCache = [];
        const edit = document.getElementById('fc-history-edit');
        if (edit) {
            edit.hidden = true;
            edit.innerHTML = '';
        }
        setHistoryMsg('', true);
    }

    function renderHistoryTable(days) {
        const body = document.getElementById('fc-history-body');
        if (!body) return;
        if (!days.length) {
            body.innerHTML = '<p class="bad">No history days yet. Run Backfill first.</p>';
            return;
        }
        const ignoredCount = days.filter((d) => d.ignored).length;
        body.innerHTML = `
            <p style="margin:0 0 10px;color:var(--muted);font-size:.82rem">
                ${days.length} day(s) shown · ${ignoredCount} ignored (excluded from forecast averages)
            </p>
            <table class="dense">
                <thead>
                    <tr>
                        <th>Date</th>
                        <th>Day</th>
                        <th>Sales</th>
                        <th>Source</th>
                        <th>Ignore</th>
                        <th></th>
                    </tr>
                </thead>
                <tbody>
                    ${days
                        .map((d) => {
                            const ignored = Boolean(d.ignored);
                            return `<tr class="history-day-row ${ignored ? 'ignored' : ''}" data-date="${d.dateKey}">
                                <td>${d.dateKey}</td>
                                <td>${weekdayLabel(d.dateKey)}</td>
                                <td><span class="money">${money(d.total)}</span></td>
                                <td style="color:var(--muted);font-size:.75rem">${d.source || '-'}</td>
                                <td>
                                    <button type="button" class="toggle ${ignored ? 'on' : ''} fc-hist-ignore" data-date="${d.dateKey}" data-on="${ignored ? '1' : '0'}" title="${ignored ? 'Ignored - click to include' : 'Click to ignore this day'}" aria-pressed="${ignored ? 'true' : 'false'}"></button>
                                </td>
                                <td>
                                    <button type="button" class="action tiny fc-hist-edit" data-date="${d.dateKey}">Edit</button>
                                </td>
                            </tr>`;
                        })
                        .join('')}
                </tbody>
            </table>`;
        body.querySelectorAll('.fc-hist-ignore').forEach((btn) => {
            btn.addEventListener('click', () => toggleHistoryIgnore(btn.dataset.date, btn.dataset.on !== '1'));
        });
        body.querySelectorAll('.fc-hist-edit').forEach((btn) => {
            btn.addEventListener('click', () => openHistoryDayEditor(btn.dataset.date));
        });
    }

    function hourLabel(index) {
        const hour = (5 + index) % 24;
        const ampm = hour >= 12 ? 'PM' : 'AM';
        const h12 = hour % 12 || 12;
        return `${h12}${ampm}`;
    }

    function openHistoryDayEditor(dateKey) {
        const day = historyDaysCache.find((d) => d.dateKey === dateKey);
        const edit = document.getElementById('fc-history-edit');
        if (!day || !edit) return;
        const actual = Array.isArray(day.actual) ? day.actual.slice() : [];
        while (actual.length < 18) actual.push(0);
        edit.hidden = false;
        edit.innerHTML = `
            <strong>Edit ${dateKey} (${weekdayLabel(dateKey)})</strong>
            <p style="margin:4px 0 8px;color:var(--muted);font-size:.8rem">Hourly values feed weekday averages. Ignored days are skipped when planning.</p>
            <label style="display:inline-flex;align-items:center;gap:8px;margin-bottom:8px;font-size:.85rem">
                <button type="button" class="toggle ${day.ignored ? 'on' : ''}" id="fc-hist-edit-ignore" data-on="${day.ignored ? '1' : '0'}" aria-pressed="${day.ignored ? 'true' : 'false'}"></button>
                Ignore this day
            </label>
            <div class="history-hours" id="fc-hist-hours">
                ${actual
                    .map(
                        (v, i) => `<label>${hourLabel(i)}
                            <input type="number" step="0.01" min="0" data-hour="${i}" value="${Number(v) || 0}">
                        </label>`
                    )
                    .join('')}
            </div>
            <div class="row">
                <button type="button" class="action" id="fc-hist-save">Save day</button>
                <button type="button" class="action" id="fc-hist-cancel-edit">Cancel</button>
                <button type="button" class="action" id="fc-hist-delete" style="border-color:rgba(253,164,175,.45)">Delete day</button>
            </div>`;
        const ignoreBtn = document.getElementById('fc-hist-edit-ignore');
        ignoreBtn?.addEventListener('click', () => {
            const on = ignoreBtn.dataset.on !== '1';
            ignoreBtn.dataset.on = on ? '1' : '0';
            ignoreBtn.classList.toggle('on', on);
            ignoreBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
        document.getElementById('fc-hist-cancel-edit')?.addEventListener('click', () => {
            edit.hidden = true;
            edit.innerHTML = '';
        });
        document.getElementById('fc-hist-save')?.addEventListener('click', async () => {
            const inputs = [...edit.querySelectorAll('#fc-hist-hours input')];
            const nextActual = inputs.map((inp) => Number(inp.value) || 0);
            const ignored = document.getElementById('fc-hist-edit-ignore')?.dataset.on === '1';
            try {
                setHistoryMsg('Saving...', true);
                await api('/api/admin/forecast/history/day', {
                    method: 'PUT',
                    body: JSON.stringify({
                        storeNumber: historyStoreNumber,
                        dateKey,
                        actual: nextActual,
                        ignored,
                    }),
                });
                setHistoryMsg(`Saved ${dateKey}.`, true);
                edit.hidden = true;
                edit.innerHTML = '';
                await reloadForecastHistory();
                loadForecast();
            } catch (err) {
                setHistoryMsg(err.message, false);
            }
        });
        document.getElementById('fc-hist-delete')?.addEventListener('click', async () => {
            if (!confirm(`Delete history for ${dateKey}?`)) return;
            try {
                await api('/api/admin/forecast/history/day', {
                    method: 'DELETE',
                    body: JSON.stringify({ storeNumber: historyStoreNumber, dateKey }),
                });
                setHistoryMsg(`Deleted ${dateKey}.`, true);
                edit.hidden = true;
                edit.innerHTML = '';
                await reloadForecastHistory();
                loadForecast();
            } catch (err) {
                setHistoryMsg(err.message, false);
            }
        });
        edit.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    async function toggleHistoryIgnore(dateKey, ignored) {
        try {
            setHistoryMsg(ignored ? `Ignoring ${dateKey}...` : `Including ${dateKey}...`, true);
            await api('/api/admin/forecast/history/ignore', {
                method: 'PUT',
                body: JSON.stringify({
                    storeNumber: historyStoreNumber,
                    dateKey,
                    ignored: Boolean(ignored),
                }),
            });
            setHistoryMsg(
                ignored
                    ? `${dateKey} ignored - excluded from forecast averages.`
                    : `${dateKey} included again.`,
                true
            );
            await reloadForecastHistory();
            loadForecast();
        } catch (err) {
            setHistoryMsg(err.message, false);
        }
    }

    async function reloadForecastHistory() {
        if (!historyStoreNumber) return;
        const data = await api(
            `/api/admin/forecast/history?storeNumber=${encodeURIComponent(historyStoreNumber)}&limit=70`
        );
        historyDaysCache = data.days || [];
        const title = document.getElementById('fc-history-title');
        const sub = document.getElementById('fc-history-sub');
        if (title) title.textContent = `Sales history - ${historyStoreNumber}`;
        if (sub) {
            sub.textContent = `${data.totalDays || 0} day(s) · ${data.ignoredCount || 0} ignored · Ignore PH / outage / odd days so they do not skew averages.`;
        }
        renderHistoryTable(historyDaysCache);
    }

    async function openForecastHistory(storeNumber) {
        const store = String(storeNumber || '').trim();
        if (!store) return;
        historyStoreNumber = store;
        const backdrop = document.getElementById('fc-history-backdrop');
        const body = document.getElementById('fc-history-body');
        if (backdrop) {
            backdrop.classList.add('open');
            backdrop.setAttribute('aria-hidden', 'false');
        }
        if (body) body.textContent = 'Loading history...';
        setHistoryMsg('', true);
        try {
            await reloadForecastHistory();
        } catch (err) {
            if (body) body.innerHTML = `<span class="bad">${err.message}</span>`;
            setHistoryMsg(err.message, false);
        }
    }

    document.getElementById('fc-history-close')?.addEventListener('click', closeForecastHistory);
    document.getElementById('fc-history-backdrop')?.addEventListener('click', (ev) => {
        if (ev.target && ev.target.id === 'fc-history-backdrop') closeForecastHistory();
    });
    document.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape') closeForecastHistory();
    });

    async function runForecastStores(storeNumbers, all) {
        setMsg('fc-msg', 'Submitting…', true);
        appendFcLog(all ? 'Update all stores — submitting…' : `Submitting store(s): ${(storeNumbers || []).join(', ')}`);
        try {
            let targets = storeNumbers || [];
            if (all) {
                // Resolve from current status table so the progress modal has store ids immediately
                targets = [...document.querySelectorAll('#fc-status .fc-submit-one')]
                    .map((btn) => String(btn.dataset.store || '').trim())
                    .filter(Boolean);
            }
            if (!window.FcProgress) {
                throw new Error('Forecast progress UI failed to load. Hard-refresh and try again.');
            }
            const data = await window.FcProgress.run(targets, { all: Boolean(all) });
            const results = data.results || [];
            const n = results.length;
            const failed = results.filter((r) => r.state === 'error' || r.ok === false);
            const cancelled = Boolean(data.cancelled);
            setMsg(
                'fc-msg',
                cancelled
                    ? 'Submit cancelled.'
                    : failed.length
                      ? `Submit finished with ${failed.length} error(s) of ${n}.`
                      : `Submit done (${n || targets.length} store(s)).`,
                !cancelled && !failed.length
            );
            appendFcLog(
                cancelled
                    ? 'Submit cancelled.'
                    : `Submit finished — ${n} store(s)${failed.length ? `, ${failed.length} failed` : ''}.`
            );
            results.forEach((r) => {
                appendFcLog(
                    `${r.storeNumber || '?'}: ${r.state || 'done'}${r.message ? ` — ${r.message}` : ''}`
                );
                const mmx = r.submit?.mmx;
                const lz = r.submit?.lifelenz;
                if (mmx?.error) appendFcLog(`  MMX error: ${mmx.error}`);
                else if (mmx?.planOnly && mmx?.message) appendFcLog(`  MMX: ${mmx.message}`);
                else if (mmx?.forecastDays != null) appendFcLog(`  MMX: ${mmx.forecastDays} day(s) written`);
                if (lz?.error) appendFcLog(`  LifeLenz error: ${lz.error}`);
                else if (lz?.planOnly && lz?.message) appendFcLog(`  LifeLenz: ${lz.message}`);
                else if (lz?.forecastDays != null) appendFcLog(`  LifeLenz: ${lz.forecastDays} day(s) written`);
            });
            if (data.error && !results.length) appendFcLog(`Submit ERROR: ${data.error}`);
            loadForecast();
        } catch (err) {
            setMsg('fc-msg', err.message, false);
            appendFcLog(`Submit ERROR: ${err.message}`);
        }
    }

    async function backfillStores(storeNumbers, all) {
        setMsg('fc-msg', 'Backfilling 5 weeks from MMX...', true);
        appendFcLog(
            all
                ? 'Backfill all stores — scraping last 5 weeks of hourly sales…'
                : `Backfill store(s) ${(storeNumbers || []).join(', ')} - last 5 weeks...`
        );
        try {
            const body = all ? { all: true, stream: true } : { storeNumbers, stream: true };
            const res = await fetch('/api/admin/forecast/backfill', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/x-ndjson',
                },
                body: JSON.stringify(body),
            });
            if (!res.ok && !res.body) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data.error || res.statusText);
            }

            const reader = res.body && res.body.getReader ? res.body.getReader() : null;
            if (!reader) {
                const data = await res.json().catch(() => ({}));
                (data.logs || []).forEach((line) => appendFcLog(line));
                const summary = data.message || 'Backfill finished.';
                setMsg('fc-msg', summary, Boolean(data.success));
                appendFcLog(summary);
                loadForecast();
                return;
            }

            const decoder = new TextDecoder();
            let buffer = '';
            let final = null;
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                let nl;
                while ((nl = buffer.indexOf('\n')) >= 0) {
                    const raw = buffer.slice(0, nl).trim();
                    buffer = buffer.slice(nl + 1);
                    if (!raw) continue;
                    let ev;
                    try {
                        ev = JSON.parse(raw);
                    } catch {
                        appendFcLog(raw);
                        continue;
                    }
                    if (ev.type === 'log' && ev.message) {
                        appendFcLog(ev.message);
                        setMsg('fc-msg', ev.message, true);
                    } else if (ev.type === 'store-done') {
                        appendFcLog(
                            ev.ok
                                ? `${ev.storeNumber}: store complete (${ev.imported || 0} day(s) imported).`
                                : `${ev.storeNumber}: ERROR - ${ev.error || 'failed'}`
                        );
                    } else if (ev.type === 'done') {
                        final = ev;
                    }
                }
            }

            const summary =
                (final && final.message) ||
                (final && final.success
                    ? `Backfill finished - imported ${final.imported || 0} day(s).`
                    : 'Backfill finished with errors.');
            setMsg('fc-msg', summary, Boolean(final && final.success));
            if (!(final && final.message)) appendFcLog(summary);
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

    const btEditor = {
        open: false,
        tab: 'master',
        storeNumber: '',
        storeName: '',
        items: [],
        unitLabelOptions: [],
    };

    const BT_DEFAULT_UNIT_LABELS = [
        'Boxes',
        'Cartons',
        'Crates',
        'Bags',
        'Packs',
        'Rolls',
        'KGs',
        'Each',
        'Bottles',
        'Cans',
        'Tubs',
    ];

    function btEscape(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function btFlattenCatalog(data) {
        const items = [];
        for (const vendor of data?.vendors || []) {
            for (const item of vendor.items || []) {
                items.push({
                    ...item,
                    vendorLabel: vendor.label || vendor.slug || item.vendorLabel || '',
                    vendorSlug: item.vendorSlug || vendor.slug || '',
                });
            }
        }
        return items;
    }

    function btRuleType(item) {
        if (item?.onHandOnly || item?.ruleType === 'on-hand') return 'on-hand';
        if (item?.buildToManual || item?.ruleType === 'manual') return 'manual';
        return 'days';
    }

    function btItemLabel(item) {
        return String(item.displayName || item.name || item.itemCode || '').trim();
    }

    function btUnitsFromItem(item) {
        if (Array.isArray(item?.units) && item.units.length === 3) return item.units.map(String);
        if (Array.isArray(item?.fileUnits) && item.fileUnits.length === 3) {
            return item.fileUnits.map(String);
        }
        return ['N/a', 'N/a', 'N/a'];
    }

    function btUnitOptionsHtml(selected) {
        const sel = String(selected || 'N/a').trim() || 'N/a';
        const base = btEditor.unitLabelOptions.length
            ? btEditor.unitLabelOptions
            : BT_DEFAULT_UNIT_LABELS;
        const options = ['N/a', ...base];
        if (sel && !options.some((o) => String(o).toLowerCase() === sel.toLowerCase())) {
            options.push(sel);
        }
        const seen = new Set();
        return options
            .filter((label) => {
                const key = String(label).toLowerCase();
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            })
            .map((label) => {
                const value = btEscape(label);
                const selectedAttr =
                    String(label).toLowerCase() === sel.toLowerCase() ? ' selected' : '';
                return `<option value="${value}"${selectedAttr}>${value}</option>`;
            })
            .join('');
    }

    function btSameUnits(a, b) {
        const left = Array.isArray(a) ? a : [];
        const right = Array.isArray(b) ? b : [];
        if (left.length !== 3 || right.length !== 3) return false;
        return left.every(
            (val, i) => String(val).trim().toLowerCase() === String(right[i]).trim().toLowerCase()
        );
    }

    function btReadUnitsFromRow(row) {
        return [0, 1, 2].map((i) => {
            const raw = String(row.querySelector(`[data-field="unit${i}"]`)?.value || 'N/a').trim();
            return raw || 'N/a';
        });
    }

    function renderBtEditorRows() {
        const body = document.getElementById('bt-editor-body');
        if (!body) return;
        const q = String(document.getElementById('bt-editor-search')?.value || '')
            .trim()
            .toLowerCase();
        const items = (btEditor.items || []).filter((item) => {
            if (!q) return true;
            return (
                String(item.itemCode || '')
                    .toLowerCase()
                    .includes(q) ||
                String(item.mmxCode || '')
                    .toLowerCase()
                    .includes(q) ||
                String(item.vendorCode || '')
                    .toLowerCase()
                    .includes(q) ||
                String(item.name || '')
                    .toLowerCase()
                    .includes(q) ||
                String(item.displayName || '')
                    .toLowerCase()
                    .includes(q) ||
                String(item.vendorLabel || '')
                    .toLowerCase()
                    .includes(q)
            );
        });
        if (!items.length) {
            body.innerHTML = '<p style="color:var(--muted);margin:0">No items match.</p>';
            return;
        }
        body.innerHTML = `
            <table class="bt-rules">
                <thead>
                    <tr>
                        <th>Item</th>
                        <th>Item code</th>
                        <th>Alt code</th>
                        <th>Vendor</th>
                        <th>Outer</th>
                        <th>Inner</th>
                        <th>Unit</th>
                        <th>Packs/box</th>
                        <th>Each/Kgs</th>
                        <th>Type</th>
                        <th>Count</th>
                        <th>Daily</th>
                        <th>Days</th>
                        <th>+Buffer</th>
                        <th>Fixed</th>
                        <th>Warn</th>
                        <th>Exclude shortfall</th>
                    </tr>
                </thead>
                <tbody>
                    ${items
                        .map((item) => {
                            const ruleType = btRuleType(item);
                            const defaultWarn = item.defaultStockWarningDays ?? 5;
                            const warnValue =
                                item.stockWarningDays != null ? item.stockWarningDays : defaultWarn;
                            const parentExclude = Boolean(item.globalExcludeFromShortfallOverride);
                            const fileMmx = item.fileMmxCode || item.itemCode || '';
                            const fileVendor = item.fileVendorCode || item.itemCode || '';
                            const mmxValue = item.mmxCode || fileMmx;
                            const vendorValue = item.vendorCode || fileVendor;
                            const scopeMmx =
                                item.scopeMmxCode != null && String(item.scopeMmxCode).trim() !== ''
                                    ? String(item.scopeMmxCode).trim()
                                    : '';
                            const scopeVendor =
                                item.scopeVendorCode != null && String(item.scopeVendorCode).trim() !== ''
                                    ? String(item.scopeVendorCode).trim()
                                    : '';
                            const units = btUnitsFromItem(item);
                            const fileUnits =
                                Array.isArray(item.fileUnits) && item.fileUnits.length === 3
                                    ? item.fileUnits.map(String)
                                    : units;
                            const innerPerCarton =
                                item.innerPerCarton != null ? item.innerPerCarton : '';
                            const unitsPerPack =
                                item.unitsPerPack != null ? item.unitsPerPack : '';
                            const fileInner =
                                item.fileInnerPerCarton != null ? item.fileInnerPerCarton : '';
                            const fileUnitsPerPack =
                                item.fileUnitsPerPack != null ? item.fileUnitsPerPack : '';
                            const scopeUnits = Array.isArray(item.scopeUnits) ? item.scopeUnits : null;
                            const scopeInner =
                                item.scopeInnerPerCarton != null ? item.scopeInnerPerCarton : '';
                            const scopeUnitsPerPack =
                                item.scopeUnitsPerPack != null ? item.scopeUnitsPerPack : '';
                            return `<tr data-item-code="${btEscape(item.itemCode)}"
                                data-catalog-needs-count="${item.catalogNeedsCount ? '1' : '0'}"
                                data-catalog-include-daily="${item.catalogIncludeDaily ? '1' : '0'}"
                                data-store-skip-override="${item.storeSkipStockCountOverride != null ? '1' : '0'}"
                                data-store-include-daily-override="${item.storeIncludeDailyOverride != null ? '1' : '0'}"
                                data-default-stock-warning="${btEscape(defaultWarn)}"
                                data-initial-stock-warning="${item.stockWarningDays != null ? btEscape(item.stockWarningDays) : ''}"
                                data-initial-rule-type="${btEscape(ruleType)}"
                                data-parent-exclude="${parentExclude ? '1' : '0'}"
                                data-had-store-exclude="${item.storeExcludeFromShortfallOverride != null ? '1' : '0'}"
                                data-had-global-exclude="${item.globalExcludeFromShortfallOverride != null ? '1' : '0'}"
                                data-initial-exclude="${item.excludeFromShortfall ? '1' : '0'}"
                                data-file-mmx="${btEscape(fileMmx)}"
                                data-file-vendor="${btEscape(fileVendor)}"
                                data-initial-mmx="${btEscape(scopeMmx)}"
                                data-initial-vendor="${btEscape(scopeVendor)}"
                                data-file-units="${btEscape(JSON.stringify(fileUnits))}"
                                data-loaded-units="${btEscape(JSON.stringify(units))}"
                                data-initial-units="${scopeUnits ? btEscape(JSON.stringify(scopeUnits)) : ''}"
                                data-file-inner="${fileInner !== '' ? btEscape(fileInner) : ''}"
                                data-loaded-inner="${innerPerCarton !== '' ? btEscape(innerPerCarton) : ''}"
                                data-initial-inner="${scopeInner !== '' ? btEscape(scopeInner) : ''}"
                                data-file-units-per-pack="${fileUnitsPerPack !== '' ? btEscape(fileUnitsPerPack) : ''}"
                                data-loaded-units-per-pack="${unitsPerPack !== '' ? btEscape(unitsPerPack) : ''}"
                                data-initial-units-per-pack="${scopeUnitsPerPack !== '' ? btEscape(scopeUnitsPerPack) : ''}">
                                <td>${btEscape(btItemLabel(item))}</td>
                                <td><input type="text" class="bt-code" data-field="mmxCode" value="${btEscape(mmxValue)}" title="Primary / MMX item code" autocomplete="off" /></td>
                                <td><input type="text" class="bt-code" data-field="vendorCode" value="${btEscape(vendorValue)}" title="Alternate / order-form item code" autocomplete="off" /></td>
                                <td>${btEscape(item.vendorLabel || item.vendorSlug || '')}</td>
                                <td><select class="bt-unit" data-field="unit0" title="Outer count column (Boxes, Cartons…)">${btUnitOptionsHtml(units[0])}</select></td>
                                <td><select class="bt-unit" data-field="unit1" title="Inner count column, or N/a">${btUnitOptionsHtml(units[1])}</select></td>
                                <td><select class="bt-unit" data-field="unit2" title="Unit count column (KGs, Each…), or N/a">${btUnitOptionsHtml(units[2])}</select></td>
                                <td><input type="number" min="0" step="any" class="bt-pack" data-field="innerPerCarton" value="${innerPerCarton !== '' ? btEscape(innerPerCarton) : ''}" placeholder="-" title="Inner packs per outer box" /></td>
                                <td><input type="number" min="0" step="any" class="bt-pack" data-field="unitsPerPack" value="${unitsPerPack !== '' ? btEscape(unitsPerPack) : ''}" placeholder="-" title="Each or KGs in one inner pack" /></td>
                                <td>
                                    <select data-field="ruleType">
                                        <option value="days" ${ruleType === 'days' ? 'selected' : ''}>Days</option>
                                        <option value="on-hand" ${ruleType === 'on-hand' ? 'selected' : ''}>On hand</option>
                                        <option value="manual" ${ruleType === 'manual' ? 'selected' : ''}>Manual</option>
                                    </select>
                                </td>
                                <td class="check"><input type="checkbox" data-field="needsCount" ${item.needsCount ? 'checked' : ''} title="Include in weekly stock count" /></td>
                                <td class="check"><input type="checkbox" data-field="includeDaily" ${item.includeDaily ? 'checked' : ''} title="Include in daily count" /></td>
                                <td><input type="number" min="0" max="31" data-field="buildToDays" value="${item.buildToDays != null ? btEscape(item.buildToDays) : ''}" /></td>
                                <td><input type="number" min="0" max="99" data-field="buildToAdd" value="${btEscape(item.buildToAdd || 0)}" /></td>
                                <td><input type="number" min="0" max="999" data-field="buildToFixed" value="${item.buildToFixed != null ? btEscape(item.buildToFixed) : ''}" /></td>
                                <td><input type="number" min="1" max="31" data-field="stockWarningDays" value="${btEscape(warnValue)}" title="Low stock warning threshold (days)" /></td>
                                <td class="check"><input type="checkbox" data-field="excludeFromShortfall" ${item.excludeFromShortfall ? 'checked' : ''} title="Skip this item in Daily Reports shortfalls" /></td>
                            </tr>`;
                        })
                        .join('')}
                </tbody>
            </table>`;
    }

    function collectBtEditorPatch() {
        const body = document.getElementById('bt-editor-body');
        const patch = {};
        const editingStore = btEditor.tab === 'store';
        body?.querySelectorAll('tbody tr[data-item-code]').forEach((row) => {
            const code = row.getAttribute('data-item-code');
            const rule = {};
            const ruleType = row.querySelector('[data-field="ruleType"]')?.value || 'days';
            const days = row.querySelector('[data-field="buildToDays"]')?.value;
            const add = row.querySelector('[data-field="buildToAdd"]')?.value;
            const fixed = row.querySelector('[data-field="buildToFixed"]')?.value;
            const needsCount = Boolean(row.querySelector('[data-field="needsCount"]')?.checked);
            const includeDaily = Boolean(row.querySelector('[data-field="includeDaily"]')?.checked);
            const exclude = Boolean(row.querySelector('[data-field="excludeFromShortfall"]')?.checked);
            const warnDays = row.querySelector('[data-field="stockWarningDays"]')?.value;
            const initialWarn = row.dataset.initialStockWarning || '';
            const initialRuleType = row.dataset.initialRuleType || 'days';
            const catalogNeedsCount = row.dataset.catalogNeedsCount === '1';
            const catalogIncludeDaily = row.dataset.catalogIncludeDaily === '1';
            const hadSkipOverride = row.dataset.storeSkipOverride === '1';
            const hadIncludeDailyOverride = row.dataset.storeIncludeDailyOverride === '1';

            if (ruleType === 'days') {
                if (days !== '') rule.buildToDays = Number(days);
                if (add !== '') rule.buildToAdd = Number(add);
                if (initialRuleType !== 'days') {
                    rule.buildToFixed = null;
                    rule.buildToManual = null;
                }
            } else if (ruleType === 'on-hand') {
                if (days !== '') rule.buildToDays = Number(days);
                if (add !== '') rule.buildToAdd = Number(add);
                rule.buildToFixed = null;
                if (initialRuleType !== 'on-hand') {
                    rule.buildToManual = null;
                    rule.skipKeyItemCount = true;
                }
            } else if (ruleType === 'manual') {
                if (fixed !== '') rule.buildToFixed = Number(fixed);
                else if (initialRuleType === 'manual') rule.buildToFixed = null;
                if (initialRuleType !== 'manual') {
                    rule.buildToDays = null;
                    rule.buildToAdd = null;
                    rule.buildToManual = true;
                }
            }

            if (needsCount !== catalogNeedsCount) {
                rule.skipStockCount = !needsCount;
            } else if (editingStore && hadSkipOverride) {
                rule.skipStockCount = null;
            }

            if (includeDaily !== catalogIncludeDaily) {
                rule.includeDaily = includeDaily;
            } else if (editingStore && hadIncludeDailyOverride) {
                rule.includeDaily = null;
            }

            const defaultWarn = row.dataset.defaultStockWarning || '5';
            const effectiveWarn = warnDays !== '' ? String(warnDays) : defaultWarn;
            if (initialWarn !== '') {
                if (effectiveWarn !== initialWarn) {
                    rule.stockWarningDays = effectiveWarn === defaultWarn ? null : Number(effectiveWarn);
                }
            } else if (effectiveWarn !== defaultWarn) {
                rule.stockWarningDays = Number(effectiveWarn);
            }

            if (editingStore) {
                const parentExclude = row.dataset.parentExclude === '1';
                const hadStoreExclude = row.dataset.hadStoreExclude === '1';
                if (exclude !== parentExclude) rule.excludeFromShortfall = exclude;
                else if (hadStoreExclude) rule.excludeFromShortfall = null;
            } else {
                const hadGlobalExclude = row.dataset.hadGlobalExclude === '1';
                const initialExclude = row.dataset.initialExclude === '1';
                if (exclude) rule.excludeFromShortfall = true;
                else if (hadGlobalExclude || initialExclude) rule.excludeFromShortfall = null;
            }

            const mmxVal = String(row.querySelector('[data-field="mmxCode"]')?.value || '')
                .trim()
                .toUpperCase();
            const vendorVal = String(row.querySelector('[data-field="vendorCode"]')?.value || '')
                .trim()
                .toUpperCase();
            const fileMmx = String(row.dataset.fileMmx || code || '')
                .trim()
                .toUpperCase();
            const fileVendor = String(row.dataset.fileVendor || code || '')
                .trim()
                .toUpperCase();
            const hadMmx = String(row.dataset.initialMmx || '').trim() !== '';
            const hadVendor = String(row.dataset.initialVendor || '').trim() !== '';
            if (mmxVal && mmxVal !== fileMmx) rule.mmxCode = mmxVal;
            else if (hadMmx) rule.mmxCode = null;
            if (vendorVal && vendorVal !== fileVendor) rule.vendorCode = vendorVal;
            else if (hadVendor) rule.vendorCode = null;

            let loadedUnits = ['N/a', 'N/a', 'N/a'];
            let fileUnits = loadedUnits;
            try {
                loadedUnits = JSON.parse(row.dataset.loadedUnits || '["N/a","N/a","N/a"]');
            } catch {
                /* keep default */
            }
            try {
                fileUnits = JSON.parse(row.dataset.fileUnits || '["N/a","N/a","N/a"]');
            } catch {
                fileUnits = loadedUnits;
            }
            const units = btReadUnitsFromRow(row);
            const hadUnitsOverride = String(row.dataset.initialUnits || '').trim() !== '';
            if (!btSameUnits(units, loadedUnits)) {
                rule.units = btSameUnits(units, fileUnits) ? null : units;
            } else if (hadUnitsOverride && btSameUnits(units, fileUnits)) {
                rule.units = null;
            }

            const innerRaw = row.querySelector('[data-field="innerPerCarton"]')?.value;
            const unitsPerPackRaw = row.querySelector('[data-field="unitsPerPack"]')?.value;
            const innerValue = innerRaw !== '' && innerRaw != null ? String(innerRaw).trim() : '';
            const loadedInnerStr = row.dataset.loadedInner || '';
            const fileInner = row.dataset.fileInner || '';
            const fileInnerNum = fileInner !== '' ? Number(fileInner) : null;
            const effectiveInner = innerValue !== '' ? Number(innerValue) : null;
            const hadInnerOverride = String(row.dataset.initialInner || '').trim() !== '';
            if (innerValue !== loadedInnerStr) {
                if (effectiveInner != null && Number.isFinite(effectiveInner)) {
                    rule.innerPerCarton =
                        fileInnerNum != null && effectiveInner === fileInnerNum
                            ? null
                            : effectiveInner;
                } else if (fileInnerNum != null || hadInnerOverride) {
                    rule.innerPerCarton = null;
                }
            } else if (hadInnerOverride && innerValue === fileInner) {
                rule.innerPerCarton = null;
            }

            const unitsPerPackValue =
                unitsPerPackRaw !== '' && unitsPerPackRaw != null
                    ? String(unitsPerPackRaw).trim()
                    : '';
            const loadedUnitsPerPackStr = row.dataset.loadedUnitsPerPack || '';
            const fileUnitsPerPack = row.dataset.fileUnitsPerPack || '';
            const fileUnitsPerPackNum = fileUnitsPerPack !== '' ? Number(fileUnitsPerPack) : null;
            const effectiveUnitsPerPack =
                unitsPerPackValue !== '' ? Number(unitsPerPackValue) : null;
            const hadUnitsPerPackOverride =
                String(row.dataset.initialUnitsPerPack || '').trim() !== '';
            if (unitsPerPackValue !== loadedUnitsPerPackStr) {
                if (effectiveUnitsPerPack != null && Number.isFinite(effectiveUnitsPerPack)) {
                    rule.unitsPerPack =
                        fileUnitsPerPackNum != null &&
                        effectiveUnitsPerPack === fileUnitsPerPackNum
                            ? null
                            : effectiveUnitsPerPack;
                } else if (fileUnitsPerPackNum != null || hadUnitsPerPackOverride) {
                    rule.unitsPerPack = null;
                }
            } else if (hadUnitsPerPackOverride && unitsPerPackValue === fileUnitsPerPack) {
                rule.unitsPerPack = null;
            }

            if (Object.keys(rule).length) patch[code] = rule;
        });
        return patch;
    }

    function syncBtEditorChrome() {
        const panel = document.getElementById('bt-editor');
        const title = document.getElementById('bt-editor-title');
        const storeTab = document.getElementById('bt-editor-tab-store');
        const tabs = document.getElementById('bt-editor-tabs');
        if (!panel) return;
        panel.hidden = !btEditor.open;
        if (!btEditor.open) return;
        const storeLabel = btEditor.storeNumber
            ? `${btEditor.storeNumber}${btEditor.storeName ? ` ${btEditor.storeName}` : ''}`
            : '';
        title.textContent =
            btEditor.tab === 'store' && btEditor.storeNumber
                ? `Build-to items — ${storeLabel}`
                : 'Build-to items — Master rules';
        if (storeTab) {
            storeTab.hidden = !btEditor.storeNumber;
            storeTab.textContent = btEditor.storeNumber ? `Store ${btEditor.storeNumber}` : 'This store';
        }
        tabs?.querySelectorAll('button[data-tab]').forEach((btn) => {
            btn.classList.toggle('active', btn.dataset.tab === btEditor.tab);
        });
    }

    async function loadBtEditorCatalog() {
        const body = document.getElementById('bt-editor-body');
        setMsg('bt-editor-msg', '', true);
        if (body) body.innerHTML = '<p style="color:var(--muted);margin:0">Loading…</p>';
        syncBtEditorChrome();
        try {
            const qs =
                btEditor.tab === 'store' && btEditor.storeNumber
                    ? `?store=${encodeURIComponent(btEditor.storeNumber)}`
                    : '';
            const data = await api(`/api/admin/build-to/catalog${qs}`);
            btEditor.unitLabelOptions = Array.isArray(data.unitLabelOptions)
                ? data.unitLabelOptions
                : [];
            btEditor.items = btFlattenCatalog(data);
            renderBtEditorRows();
        } catch (err) {
            if (body) body.innerHTML = '';
            setMsg('bt-editor-msg', err.message || 'Could not load catalog.', false);
        }
    }

    async function openBtEditor({ tab = 'master', storeNumber = '', storeName = '' } = {}) {
        btEditor.open = true;
        btEditor.tab = tab === 'store' && storeNumber ? 'store' : 'master';
        btEditor.storeNumber = String(storeNumber || '').trim();
        btEditor.storeName = String(storeName || '').trim();
        const search = document.getElementById('bt-editor-search');
        if (search) search.value = '';
        await loadBtEditorCatalog();
        document.getElementById('bt-editor')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    function closeBtEditor() {
        btEditor.open = false;
        btEditor.items = [];
        syncBtEditorChrome();
        setMsg('bt-editor-msg', '', true);
    }

    async function saveBtEditor() {
        const saveBtn = document.getElementById('bt-editor-save');
        const patch = collectBtEditorPatch();
        if (!Object.keys(patch).length) {
            setMsg('bt-editor-msg', 'No changes to save.', true);
            return;
        }
        if (saveBtn) {
            saveBtn.disabled = true;
            saveBtn.textContent = 'Saving…';
        }
        setMsg('bt-editor-msg', '', true);
        try {
            const body =
                btEditor.tab === 'store' && btEditor.storeNumber
                    ? { stores: { [btEditor.storeNumber]: patch } }
                    : { global: patch };
            await api('/api/admin/build-to/overrides', {
                method: 'PUT',
                body: JSON.stringify(body),
            });
            setMsg(
                'bt-editor-msg',
                'Saved. Stock count columns and shortfall checks will use these rules on the next run.',
                true
            );
            await loadBtEditorCatalog();
        } catch (err) {
            setMsg('bt-editor-msg', err.message || 'Save failed.', false);
        } finally {
            if (saveBtn) {
                saveBtn.disabled = false;
                saveBtn.textContent = 'Save changes';
            }
        }
    }

    async function loadBuildTo() {
        const storesEl = document.getElementById('bt-stores');
        try {
            const data = await api('/api/admin/build-to/status');
            if (!data.automationExists) {
                setMsg('bt-msg', data.hint || 'Build-to package missing. Re-run the installer.', false);
            } else if (!data.templateExists) {
                setMsg(
                    'bt-msg',
                    'No Build-to template found. Place "Build To Master File.xlsx" in Downloads (used once to create each store file).',
                    false
                );
            } else if (data.running) {
                setMsg('bt-msg', 'Build-to is running...', true);
            } else {
                setMsg('bt-msg', '', true);
            }

            const rows = data.stores || [];
            if (!rows.length) {
                storesEl.innerHTML = '<span class="bad">No stores in coach scope.</span>';
            } else {
                storesEl.innerHTML = `
                    <table class="dense">
                        <thead>
                            <tr>
                                <th>Store</th>
                                <th>Workbook</th>
                                <th>Build-to updated</th>
                                <th>Orders placed</th>
                                <th></th>
                            </tr>
                        </thead>
                        <tbody>
                            ${rows
                                .map((s) => {
                                    const running = Boolean(s.running);
                                    const ordersDisabled = running || !s.canPlaceOrders ? ' disabled' : '';
                                    const ordersTitle = running
                                        ? 'Build-to is updating…'
                                        : s.canPlaceOrders
                                          ? 'Place MMX orders from this store workbook'
                                          : 'Update Build-to first today';
                                    const updateDisabled = running ? ' disabled' : '';
                                    return `<tr data-store="${s.storeNumber}" class="${running ? 'bt-row-running' : ''}">
                                <td class="bt-store">
                                    <strong>${s.storeNumber}</strong> <span style="color:var(--muted)">${s.storeName || ''}</span>
                                    ${running ? `<span class="bt-store-status ok">Updating${s.runningMode === 'orders' ? ' orders' : ''}…</span>` : ''}
                                    ${!running && s.lastError ? `<span class="bt-store-status bad">${s.lastError}</span>` : ''}
                                </td>
                                <td style="font-size:.8rem;color:var(--muted)">${s.workbookName || ''}${s.workbookExists ? '' : ' <span class="bad">(new)</span>'}</td>
                                <td class="${s.buildToUpdatedAt ? 'ok' : ''}">${fmtWhen(s.buildToUpdatedAt)}</td>
                                <td class="${s.mmxOrdersUpdatedAt ? 'ok' : ''}">${fmtWhen(s.mmxOrdersUpdatedAt)}</td>
                                <td>
                                    <div class="bt-actions">
                                        <button class="action tiny bt-update" data-store="${s.storeNumber}"${updateDisabled}>${running && s.runningMode !== 'orders' ? 'Updating…' : 'Update Build to'}</button>
                                        <button class="action tiny bt-orders" data-store="${s.storeNumber}" title="${ordersTitle}"${ordersDisabled}>${running && s.runningMode === 'orders' ? 'Ordering…' : 'Place orders'}</button>
                                        <button class="action tiny bt-open" data-store="${s.storeNumber}">Open build to</button>
                                        <button class="action tiny bt-edit" data-store="${s.storeNumber}" data-name="${btEscape(s.storeName || '')}">Edit items</button>
                                    </div>
                                </td>
                            </tr>`;
                                })
                                .join('')}
                        </tbody>
                    </table>`;
                storesEl.querySelectorAll('.bt-update').forEach((btn) => {
                    btn.addEventListener('click', () => runBuildTo('reports', [btn.dataset.store], btn));
                });
                storesEl.querySelectorAll('.bt-orders').forEach((btn) => {
                    btn.addEventListener('click', () => runBuildTo('orders', [btn.dataset.store], btn));
                });
                storesEl.querySelectorAll('.bt-open').forEach((btn) => {
                    btn.addEventListener('click', () => openBuildTo(btn.dataset.store, btn));
                });
                storesEl.querySelectorAll('.bt-edit').forEach((btn) => {
                    btn.addEventListener('click', () =>
                        openBtEditor({
                            tab: 'store',
                            storeNumber: btn.dataset.store,
                            storeName: btn.dataset.name || '',
                        })
                    );
                });
                const runningCount = rows.filter((s) => s.running).length;
                if (runningCount > 0) {
                    setMsg('bt-msg', `${runningCount} Build-to update(s) running — you can start more stores.`, true);
                    if (!window.__btStatusPoll) {
                        window.__btStatusPoll = setInterval(() => {
                            const section = document.getElementById('buildto');
                            if (!section?.classList.contains('active')) return;
                            loadBuildTo();
                        }, 3000);
                    }
                } else if (window.__btStatusPoll) {
                    clearInterval(window.__btStatusPoll);
                    window.__btStatusPoll = null;
                }
            }
        } catch (err) {
            setMsg('bt-msg', err.message, false);
            if (storesEl) storesEl.innerHTML = '';
        }
    }

    async function runBuildTo(mode, storeNumbers, btn) {
        const label = mode === 'orders' ? 'Place orders' : 'Update Build to';
        const stores = (storeNumbers || []).map(String).filter(Boolean);
        setMsg(
            'bt-msg',
            stores.length > 1
                ? `Queued ${label} for ${stores.length} stores — watch Activity…`
                : `Started ${label} for ${stores.join(', ') || 'area'}…`,
            true
        );
        if (btn) {
            btn.disabled = true;
            btn.textContent = mode === 'orders' ? 'Ordering…' : 'Updating…';
        }
        // Refresh table so other store buttons stay clickable while this runs.
        loadBuildTo();
        try {
            const body = stores.length ? { mode, storeNumbers: stores } : { mode };
            const data = await api('/api/admin/build-to/run', {
                method: 'POST',
                body: JSON.stringify(body),
            });
            const fail = (data.stores || []).filter((r) => !r.ok);
            const doneCount = (data.stores || []).filter((r) => r.ok).length;
            setMsg(
                'bt-msg',
                data.ok || data.success
                    ? `${label} finished${stores.length > 1 ? ` (${doneCount}/${stores.length})` : ` for ${stores.join(', ')}`}.`
                    : data.error || fail.map((f) => `${f.storeNumber}: ${f.error}`).join('; ') || 'Failed.',
                Boolean(data.ok || data.success)
            );
            loadBuildTo();
        } catch (err) {
            setMsg('bt-msg', err.message, false);
            loadBuildTo();
        }
    }

    async function openBuildTo(storeNumber, btn) {
        if (btn) btn.disabled = true;
        try {
            const data = await api('/api/admin/build-to/open', {
                method: 'POST',
                body: JSON.stringify({ storeNumber }),
            });
            setMsg(
                'bt-msg',
                data.ok
                    ? `Opened ${data.path || `${storeNumber} - Build To.xlsx`}`
                    : data.error || 'Could not open workbook.',
                Boolean(data.ok)
            );
        } catch (err) {
            setMsg('bt-msg', err.message, false);
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    document.getElementById('bt-refresh')?.addEventListener('click', loadBuildTo);
    document.getElementById('bt-update-all')?.addEventListener('click', () => {
        const stores = [...document.querySelectorAll('#bt-stores .bt-update')]
            .map((btn) => String(btn.dataset.store || '').trim())
            .filter(Boolean);
        if (!stores.length) {
            setMsg('bt-msg', 'No stores to update.', false);
            return;
        }
        runBuildTo('reports', stores);
    });
    document.getElementById('bt-orders-all')?.addEventListener('click', () => {
        const stores = [...document.querySelectorAll('#bt-stores .bt-orders:not([disabled])')]
            .map((btn) => String(btn.dataset.store || '').trim())
            .filter(Boolean);
        if (!stores.length) {
            setMsg(
                'bt-msg',
                'No stores ready for orders (update Build-to first today).',
                false
            );
            return;
        }
        runBuildTo('orders', stores);
    });
    document.getElementById('bt-edit-master')?.addEventListener('click', () => openBtEditor({ tab: 'master' }));
    document.getElementById('bt-editor-close')?.addEventListener('click', closeBtEditor);
    document.getElementById('bt-editor-save')?.addEventListener('click', saveBtEditor);
    document.getElementById('bt-editor-search')?.addEventListener('input', () => renderBtEditorRows());
    document.getElementById('bt-editor-tabs')?.addEventListener('click', (ev) => {
        const btn = ev.target.closest('button[data-tab]');
        if (!btn || btn.hidden) return;
        const tab = btn.dataset.tab;
        if (tab === 'store' && !btEditor.storeNumber) return;
        btEditor.tab = tab;
        loadBtEditorCatalog();
    });

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
        const key =
            kind === 'stock'
                ? 'stockEnabled'
                : kind === 'forecast'
                  ? 'forecastEnabled'
                  : kind === 'buildTo'
                    ? 'buildToEnabled'
                    : kind === 'prepGuide'
                      ? 'prepGuideEnabled'
                      : kind === 'orders'
                        ? 'ordersEnabled'
                        : null;
        if (!key) throw new Error(`Unknown daily toggle: ${kind}`);
        await api('/api/admin/five-am-reports/stores', {
            method: 'PUT',
            body: JSON.stringify({ stores: [{ storeNumber: store, [key]: nextOn }] }),
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
                <table class="dense daily-table">
                    <thead>
                        <tr>
                            <th>Store</th>
                            <th title="Update Build-to workbook (SOH / SOO / ISE)">Build-to</th>
                            <th title="Auto-submit next 3 weeks of forecast">Forecast</th>
                            <th title="Regenerate Prep Guide PDF and email">Prep Guide</th>
                            <th title="Include stock level check in the daily run (view results on Shortfalls)">Stock</th>
                            <th title="Place MMX orders — only after Build-to is updated today">Orders</th>
                            <th></th>
                        </tr>
                    </thead>
                    <tbody>
                        ${rows
                            .map(
                                (s) => `<tr>
                            <td><strong>${s.storeNumber}</strong> <span style="color:var(--muted)">${s.storeName || ''}</span></td>
                            <td>${toggleBtn(Boolean(s.buildToEnabled), 'buildTo', s.storeNumber)}</td>
                            <td>${toggleBtn(Boolean(s.forecastEnabled), 'forecast', s.storeNumber)}</td>
                            <td>${toggleBtn(Boolean(s.prepGuideEnabled), 'prepGuide', s.storeNumber)}</td>
                            <td>${toggleBtn(Boolean(s.stockEnabled), 'stock', s.storeNumber)}</td>
                            <td>${toggleBtn(Boolean(s.ordersEnabled), 'orders', s.storeNumber)}</td>
                            <td>
                                <div class="daily-actions">
                                    <button type="button" class="action tiny daily-check-one" data-store="${s.storeNumber}" title="Run enabled daily jobs for this store">Run</button>
                                </div>
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
                const store = String(btn.dataset.store || '');
                if (activeDailyChecks.has(store)) btn.disabled = true;
                btn.addEventListener('click', () => {
                    const name =
                        btn.closest('tr')?.querySelector('span')?.textContent?.trim() || '';
                    startDailyCheckForStore(store, name || store, btn);
                });
            });
        } catch (err) {
            el.innerHTML = `<span class="bad">${err.message}</span>`;
        }
    }

    /** @type {Map<string, any>} panels persist after a check finishes */
    const dailyPanelsByStore = new Map();
    // activeDailyChecks + dailyLogRunSeq declared at top of IIFE

    function appendToDailyPanel(panelState, lines) {
        if (!panelState?.pre) return;
        const stamp = new Date().toLocaleTimeString();
        const block = (Array.isArray(lines) ? lines : [lines])
            .filter(Boolean)
            .map((l) => `[${stamp}] ${l}`)
            .join('\n');
        if (!block) return;
        const prev = panelState.pre.textContent || '';
        panelState.pre.textContent = prev ? `${prev}\n${block}` : block;
        panelState.pre.scrollTop = panelState.pre.scrollHeight;
    }

    function renderShortfallsHtml(data) {
        const items = Array.isArray(data?.items) ? data.items : [];
        const count = Number(data?.count) || items.length;
        if (!data?.checked && !items.length) {
            return '<span class="bad">No shortfall check yet. Run Check first.</span>';
        }
        if (!items.length) {
            return `<span class="ok">No shortfalls${
                data.thresholdDays != null ? ` under ${data.thresholdDays} days` : ''
            } (on hand + on order).</span>`;
        }
        const rows = items
            .map(
                (it) => `<tr>
                <td>${it.itemCode || it.iseItemCode || ''}</td>
                <td>${it.displayName || it.description || ''}</td>
                <td>${Number(it.onHandCartons) || 0}</td>
                <td>${Number(it.onOrderCartons) || 0}</td>
                <td>${Number(it.daysOfStock).toFixed(1)}</td>
                <td>${it.thresholdDays != null ? it.thresholdDays : ''}</td>
            </tr>`
            )
            .join('');
        return `
            <div style="margin-bottom:8px;color:var(--muted)">
                ${count} shortfall${count === 1 ? '' : 's'}
                ${data.thresholdDays != null ? `(under ${data.thresholdDays} days)` : ''}
                · on hand + on order
                ${data.savedAt || data.withOnOrder?.checkedAt ? ` · ${fmtWhen(data.savedAt || data.withOnOrder.checkedAt)}` : ''}
            </div>
            <table>
                <thead>
                    <tr>
                        <th>Code</th>
                        <th>Item</th>
                        <th>On hand</th>
                        <th>On order</th>
                        <th>Days</th>
                        <th>Warn</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>`;
    }

    /** Reuse existing log panel for a store, or create one. */
    function ensureDailyPanel(storeNumber, storeLabel, { clearLogs = false } = {}) {
        const host = document.getElementById('daily-logs');
        if (!host) return null;
        const key = String(storeNumber);
        const existing = dailyPanelsByStore.get(key);
        if (existing?.panel?.isConnected) {
            if (storeLabel && existing.title) existing.title.textContent = storeLabel;
            if (clearLogs && existing.pre) existing.pre.textContent = '';
            existing.panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            return existing;
        }

        dailyLogRunSeq += 1;
        const runId = `${key}-${dailyLogRunSeq}-${Date.now()}`;

        const panel = document.createElement('div');
        panel.className = 'daily-log-panel';
        panel.dataset.store = key;
        panel.dataset.runId = runId;

        const head = document.createElement('div');
        head.className = 'daily-log-panel-head';
        const title = document.createElement('strong');
        title.textContent = storeLabel || `Store ${key}`;
        const status = document.createElement('span');
        status.className = 'daily-log-status';
        status.style.color = 'var(--muted)';
        status.textContent = 'Idle';
        head.appendChild(title);
        head.appendChild(status);

        const pre = document.createElement('pre');
        pre.textContent = '';

        panel.appendChild(head);
        panel.appendChild(pre);
        host.appendChild(panel);
        panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

        const state = {
            store: key,
            panel,
            pre,
            status,
            title,
            runId,
        };
        dailyPanelsByStore.set(key, state);
        return state;
    }

    function createDailyLogPanel(storeNumber, storeLabel) {
        const state = ensureDailyPanel(storeNumber, storeLabel, { clearLogs: true });
        if (!state) return null;
        if (state.status) {
            state.status.textContent = 'Running…';
            state.status.style.color = 'var(--ok)';
        }
        activeDailyChecks.set(String(storeNumber), state);
        return state;
    }

    function finishDailyLogPanel(storeNumber, ok, summary) {
        const key = String(storeNumber);
        const state = dailyPanelsByStore.get(key) || activeDailyChecks.get(key);
        if (state?.status) {
            state.status.textContent = ok ? 'Done' : 'Failed';
            state.status.style.color = ok ? 'var(--ok)' : 'var(--bad)';
        }
        if (summary) appendToDailyPanel(state, summary);
        activeDailyChecks.delete(key);
        document
            .querySelectorAll(`.daily-check-one[data-store="${key}"]`)
            .forEach((b) => {
                b.disabled = false;
            });
        syncDailyAreaRunButton();
    }

    function syncDailyAreaRunButton() {
        const runBtn = document.getElementById('daily-run');
        if (!runBtn) return;
        runBtn.disabled = false;
        const n = activeDailyChecks.size;
        if (n > 0) {
            setMsg('daily-msg', `Checking ${n} store(s) in separate panels…`, true);
        }
    }

    async function startDailyCheckForStore(storeNumber, storeLabel, btn) {
        const store = String(storeNumber || '').trim();
        if (!store) return;
        if (activeDailyChecks.has(store)) {
            setMsg('daily-msg', `Store ${store} is already checking — see its panel below.`, true);
            activeDailyChecks.get(store)?.panel?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            return;
        }

        const label = storeLabel || `Store ${store}`;
        const panel = createDailyLogPanel(store, label);
        if (!panel) {
            setMsg('daily-msg', 'Could not create log panel.', false);
            return;
        }
        if (btn) btn.disabled = true;
        syncDailyAreaRunButton();
        appendToDailyPanel(panel, `Daily reports started — panel for ${label}`);

        try {
            const res = await fetch('/api/admin/daily-reports/run', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/x-ndjson',
                },
                body: JSON.stringify({ storeNumbers: [store], stream: true }),
            });
            if (!res.ok && !res.body) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data.error || res.statusText);
            }

            const final = await readNdjsonStream(res, (ev) => {
                if (ev?.type === 'log' && ev.message) {
                    appendToDailyPanel(panel, ev.message);
                    if (panel.status) panel.status.textContent = 'Running…';
                } else if (ev?.type === 'store-done') {
                    appendToDailyPanel(
                        panel,
                        ev.ok
                            ? `ok${ev.mode ? ` (${ev.mode})` : ''}${
                                  ev.withOnOrderCount != null
                                      ? ` — ${ev.withOnOrderCount} shortfall(s)`
                                      : ''
                              }`
                            : `FAILED — ${ev.error || 'unknown error'}`
                    );
                }
            });

            if (!final) throw new Error('Check ended with no response');
            if (final.success === false && final.error) throw new Error(final.error);

            const row = (final.results || []).find((r) => String(r.storeNumber) === store);
            const ok = row ? Boolean(row.ok) : Boolean(final.success);
            const summary = ok
                ? final.message || `Store ${store} checked.`
                : row?.error || final.error || `Store ${store} failed.`;
            finishDailyLogPanel(store, ok, summary);
            loadDaily();
        } catch (err) {
            appendToDailyPanel(panel, `ERROR: ${err.message}`);
            finishDailyLogPanel(store, false, null);
            setMsg('daily-msg', err.message, false);
        }
    }

    async function checkCurrentLevelsArea() {
        const rows = [...document.querySelectorAll('#daily-list .daily-check-one')];
        const targets = rows
            .map((btn) => {
                const store = String(btn.dataset.store || '');
                const name = btn.closest('tr')?.querySelector('span')?.textContent?.trim() || '';
                return { store, name, btn };
            })
            .filter((t) => t.store && !activeDailyChecks.has(t.store));

        if (!targets.length) {
            setMsg(
                'daily-msg',
                activeDailyChecks.size
                    ? 'All stores are already checking (see panels below).'
                    : 'No stores to check.',
                Boolean(activeDailyChecks.size)
            );
            return;
        }

        setMsg(
            'daily-msg',
            `Queued ${targets.length} store check(s) — watch Activity (bottom right)…`,
            true
        );
        await Promise.allSettled(
            targets.map((t) => startDailyCheckForStore(t.store, `${t.store} ${t.name}`.trim(), t.btn))
        );
    }

    document.getElementById('daily-refresh').addEventListener('click', loadDaily);
    document.getElementById('daily-run').addEventListener('click', () => checkCurrentLevelsArea());

    // —— Shortfalls page (stock-only checks) ——
    let sfStores = [];
    let sfSelectedStore = '';
    const activeShortfallChecks = new Set();

    function appendSfLog(lines) {
        const el = document.getElementById('sf-detail-log');
        if (!el) return;
        el.hidden = false;
        const stamp = new Date().toLocaleTimeString();
        const block = (Array.isArray(lines) ? lines : [lines])
            .filter(Boolean)
            .map((l) => `[${stamp}] ${l}`)
            .join('\n');
        if (!block) return;
        el.textContent = el.textContent ? `${el.textContent}\n${block}` : block;
        el.scrollTop = el.scrollHeight;
    }

    function closeShortfallDetail() {
        sfSelectedStore = '';
        const detail = document.getElementById('sf-detail');
        if (detail) detail.hidden = true;
        document.querySelectorAll('#sf-list tr.sf-row-active').forEach((r) => r.classList.remove('sf-row-active'));
    }

    async function loadShortfallDetailBody(store) {
        const body = document.getElementById('sf-detail-body');
        if (!body) return;
        body.innerHTML = '<span style="color:var(--muted)">Loading shortfalls…</span>';
        try {
            const data = await api(`/api/admin/shortfalls/${encodeURIComponent(store)}`);
            body.innerHTML = renderShortfallsHtml(data);
            return data;
        } catch (err) {
            body.innerHTML = `<span class="bad">${err.message}</span>`;
            return null;
        }
    }

    async function openShortfallDetail(storeNumber, storeLabel) {
        const store = String(storeNumber || '').trim();
        if (!store) return;
        sfSelectedStore = store;
        const detail = document.getElementById('sf-detail');
        const title = document.getElementById('sf-detail-title');
        const log = document.getElementById('sf-detail-log');
        if (title) title.textContent = storeLabel || `Store ${store}`;
        if (log) {
            log.textContent = '';
            log.hidden = true;
        }
        if (detail) {
            detail.hidden = false;
            detail.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
        document.querySelectorAll('#sf-list tr[data-store]').forEach((r) => {
            r.classList.toggle('sf-row-active', r.dataset.store === store);
        });
        await loadShortfallDetailBody(store);
        setMsg('sf-msg', `Shortfalls for ${storeLabel || store}`, true);
    }

    async function runShortfallCheck(storeNumbers, { openDetail = true } = {}) {
        const stores = (storeNumbers || []).map(String).filter(Boolean);
        if (!stores.length) {
            setMsg('sf-msg', 'No stores to check.', false);
            return;
        }
        const multi = stores.length > 1;
        setMsg(
            'sf-msg',
            multi
                ? `Queued shortfall check for ${stores.length} stores — watch Activity…`
                : `Queued shortfall check for ${stores[0]}…`,
            true
        );
        if (openDetail && !multi) {
            const row = sfStores.find((s) => String(s.storeNumber) === stores[0]);
            await openShortfallDetail(
                stores[0],
                row ? `${row.storeNumber} ${row.storeName || ''}`.trim() : stores[0]
            );
            appendSfLog(`Shortfall check started for ${stores[0]}`);
        }

        stores.forEach((s) => activeShortfallChecks.add(s));
        try {
            const res = await fetch('/api/admin/shortfalls/run', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/x-ndjson',
                },
                body: JSON.stringify({ storeNumbers: stores, stream: true }),
            });
            if (!res.ok && !res.body) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data.error || res.statusText);
            }

            const final = await readNdjsonStream(res, (ev) => {
                if (ev?.type === 'log' && ev.message) {
                    if (!multi || (sfSelectedStore && String(ev.message).includes(sfSelectedStore))) {
                        appendSfLog(ev.message);
                    }
                } else if (ev?.type === 'store-done') {
                    const st = String(ev.storeNumber || '');
                    const line = ev.ok
                        ? `${st}: ${ev.withOnOrderCount != null ? `${ev.withOnOrderCount} shortfall(s)` : 'ok'}`
                        : `${st}: FAILED — ${ev.error || 'error'}`;
                    if (!multi || st === sfSelectedStore) appendSfLog(line);
                }
            });

            if (!final || final.success === false) {
                throw new Error(final?.error || 'Shortfall check failed');
            }
            const results = final.results || [];
            const failed = results.filter((r) => !r.ok).length;
            const ok = results.length - failed;
            setMsg(
                'sf-msg',
                failed
                    ? `Shortfall check: ${ok} ok, ${failed} failed.`
                    : final.message || `Checked ${ok} store(s).`,
                failed === 0
            );
            await loadShortfalls();
            if (sfSelectedStore && stores.includes(sfSelectedStore)) {
                await loadShortfallDetailBody(sfSelectedStore);
            }
        } catch (err) {
            setMsg('sf-msg', err.message, false);
            appendSfLog(`ERROR: ${err.message}`);
        } finally {
            stores.forEach((s) => activeShortfallChecks.delete(s));
        }
    }

    async function loadShortfalls() {
        const el = document.getElementById('sf-list');
        if (!el) return;
        try {
            const data = await api('/api/admin/five-am-reports/stores');
            sfStores = data.storeList || [];
            if (!sfStores.length) {
                el.innerHTML = '<span class="bad">No stores in coach scope.</span>';
                return;
            }
            el.innerHTML = `
                <table class="dense">
                    <thead>
                        <tr>
                            <th>Store</th>
                            <th>Shortfalls</th>
                            <th>Last checked</th>
                            <th></th>
                        </tr>
                    </thead>
                    <tbody>
                        ${sfStores
                            .map((s) => {
                                const count = s.shortfallCount;
                                const countHtml =
                                    count == null
                                        ? '<span style="color:var(--muted)">—</span>'
                                        : count === 0
                                          ? `<span class="sf-count-ok">0</span>`
                                          : `<span class="sf-count-bad">${count}</span>`;
                                const checking = activeShortfallChecks.has(String(s.storeNumber));
                                return `<tr data-store="${s.storeNumber}" class="${
                                    sfSelectedStore === String(s.storeNumber) ? 'sf-row-active' : ''
                                }">
                            <td><strong>${s.storeNumber}</strong> <span style="color:var(--muted)">${s.storeName || ''}</span></td>
                            <td>${countHtml}</td>
                            <td>${s.shortfallsCheckedAt ? fmtWhen(s.shortfallsCheckedAt) : '—'}</td>
                            <td>
                                <div class="daily-actions">
                                    <button type="button" class="action tiny sf-view" data-store="${s.storeNumber}">View</button>
                                    <button type="button" class="action tiny sf-check" data-store="${s.storeNumber}"${
                                        checking ? ' disabled' : ''
                                    }>${checking ? 'Checking…' : 'Check'}</button>
                                </div>
                            </td>
                        </tr>`;
                            })
                            .join('')}
                    </tbody>
                </table>`;
            el.querySelectorAll('.sf-view').forEach((btn) => {
                btn.addEventListener('click', () => {
                    const store = String(btn.dataset.store || '');
                    const name =
                        btn.closest('tr')?.querySelector('span')?.textContent?.trim() || '';
                    openShortfallDetail(store, `${store} ${name}`.trim());
                });
            });
            el.querySelectorAll('.sf-check').forEach((btn) => {
                btn.addEventListener('click', () => {
                    const store = String(btn.dataset.store || '');
                    runShortfallCheck([store], { openDetail: true });
                });
            });
            if (sfSelectedStore) {
                const still = sfStores.some((s) => String(s.storeNumber) === sfSelectedStore);
                if (!still) closeShortfallDetail();
            }
        } catch (err) {
            el.innerHTML = `<span class="bad">${err.message}</span>`;
        }
    }

    document.getElementById('sf-refresh')?.addEventListener('click', loadShortfalls);
    document.getElementById('sf-check-all')?.addEventListener('click', () => {
        const stores = sfStores.map((s) => String(s.storeNumber)).filter(Boolean);
        runShortfallCheck(stores, { openDetail: false });
    });
    document.getElementById('sf-detail-close')?.addEventListener('click', closeShortfallDetail);
    document.getElementById('sf-detail-check')?.addEventListener('click', () => {
        if (sfSelectedStore) runShortfallCheck([sfSelectedStore], { openDetail: true });
    });

    function appendPgLog(lines) {
        const el = document.getElementById('pg-log');
        if (!el) return;
        const stamp = new Date().toLocaleTimeString();
        const block = (Array.isArray(lines) ? lines : [lines])
            .filter(Boolean)
            .map((l) => `[${stamp}] ${l}`)
            .join('\n');
        if (!block) return;
        const prev = el.textContent === 'Prep Guide logs appear here.' ? '' : el.textContent;
        el.textContent = prev ? `${prev}\n${block}` : block;
        el.scrollTop = el.scrollHeight;
    }

    async function readNdjsonStream(res, onEvent) {
        const reader = res.body && res.body.getReader ? res.body.getReader() : null;
        if (!reader) {
            const data = await res.json().catch(() => ({}));
            onEvent?.(data?.type ? data : { type: 'done', ...data });
            return data;
        }
        const decoder = new TextDecoder();
        let buffer = '';
        let final = null;
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let nl;
            while ((nl = buffer.indexOf('\n')) >= 0) {
                const raw = buffer.slice(0, nl).trim();
                buffer = buffer.slice(nl + 1);
                if (!raw) continue;
                let ev;
                try {
                    ev = JSON.parse(raw);
                } catch {
                    onEvent?.({ type: 'log', message: raw });
                    continue;
                }
                onEvent?.(ev);
                if (ev.type === 'done') final = ev;
            }
        }
        return final;
    }

    async function runPrepAction(url, storeNumber, label, options = {}) {
        setMsg('pg-msg', `${label} for ${storeNumber}...`, true);
        appendPgLog(`${label} - store ${storeNumber}`);
        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/x-ndjson',
                },
                body: JSON.stringify({ storeNumber, stream: true }),
            });
            const final = await readNdjsonStream(res, (ev) => {
                if (ev?.type === 'log' && ev.message) {
                    appendPgLog(`[${storeNumber}] ${ev.message}`);
                    if (!options.quietMsg) setMsg('pg-msg', ev.message, true);
                }
            });
            if (!final || final.success === false) {
                throw new Error(final?.error || `${label} failed`);
            }
            const summary =
                final.message ||
                (final.meta
                    ? `${label} finished.`
                    : final.result
                      ? `${label} finished.`
                      : `${label} done.`);
            if (!options.quietMsg) setMsg('pg-msg', summary, true);
            appendPgLog(`[${storeNumber}] ${summary}`);
            if (!options.skipReload) await loadPrep();
            return final;
        } catch (err) {
            if (!options.quietMsg) setMsg('pg-msg', err.message, false);
            appendPgLog(`[${storeNumber}] ERROR: ${err.message}`);
            throw err;
        }
    }

    async function runPrepActionAll(url, label) {
        const stores = (Array.isArray(prepStores) ? prepStores : [])
            .map((s) => String(s.storeNumber || '').trim())
            .filter(Boolean);
        if (!stores.length) {
            setMsg('pg-msg', 'No stores in coach scope.', false);
            return;
        }
        setMsg(
            'pg-msg',
            `Queued ${label} for ${stores.length} store(s) — watch Activity…`,
            true
        );
        appendPgLog(`${label} (all) — ${stores.length} store(s)`);
        const results = await Promise.allSettled(
            stores.map((store) =>
                runPrepAction(url, store, label, { skipReload: true, quietMsg: true })
            )
        );
        const failed = results.filter((r) => r.status === 'rejected').length;
        const ok = stores.length - failed;
        const summary =
            failed === 0
                ? `${label} finished for all ${ok} store(s).`
                : `${label}: ${ok} ok, ${failed} failed.`;
        setMsg('pg-msg', summary, failed === 0);
        appendPgLog(summary);
        await loadPrep();
    }

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

    function renderPrepArea(stores) {
        const el = document.getElementById('pg-area');
        if (!el) return;
        if (!stores.length) {
            el.innerHTML = '<span class="bad">No stores in coach scope.</span>';
            return;
        }
        el.innerHTML = `
            <table class="dense">
                <thead>
                    <tr>
                        <th>Store</th>
                        <th>Sales</th>
                        <th>ISE</th>
                        <th>Forecast $</th>
                        <th>PDFs</th>
                        <th>Actions</th>
                    </tr>
                </thead>
                <tbody>
                    ${stores
                        .map((s) => {
                            const salesCls = s.historyReady ? 'ok' : 'bad';
                            const iseCls = s.iseReady ? 'ok' : 'bad';
                            const pdfCls = (s.pdfCount || 0) >= 7 ? 'ok' : 'bad';
                            return `<tr data-store="${s.storeNumber}">
                                <td>
                                    <strong>${s.storeNumber}</strong>
                                    <span class="pg-store-meta">${s.storeName || ''}${s.regeneratedAt ? ` · ${fmtWhen(s.regeneratedAt)}` : ' · not built'}</span>
                                </td>
                                <td class="${salesCls}">${s.historyDays || 0}d</td>
                                <td class="${iseCls}">${s.iseSnapshots || 0}s</td>
                                <td><span class="money">${money(s.weekTotal)}</span></td>
                                <td class="${pdfCls}">${s.pdfCount || 0}/7</td>
                                <td>
                                    <div class="pg-actions">
                                        <button type="button" class="action tiny pg-sales" data-store="${s.storeNumber}">Sales</button>
                                        <button type="button" class="action tiny pg-ise" data-store="${s.storeNumber}">ISE</button>
                                        <button type="button" class="action tiny pg-forecast" data-store="${s.storeNumber}">Forecast</button>
                                        <button type="button" class="action tiny pg-build" data-store="${s.storeNumber}">Build PDFs</button>
                                        <button type="button" class="action tiny pg-excel" data-store="${s.storeNumber}" title="Open {store} - Prep Guide.xlsx">View In Excel</button>
                                    </div>
                                </td>
                            </tr>`;
                        })
                        .join('')}
                </tbody>
            </table>`;
        el.querySelectorAll('.pg-sales').forEach((btn) => {
            btn.addEventListener('click', () =>
                runPrepAction('/api/admin/prep-guides/update-sales', btn.dataset.store, 'Update Sales')
            );
        });
        el.querySelectorAll('.pg-ise').forEach((btn) => {
            btn.addEventListener('click', () =>
                runPrepAction('/api/admin/prep-guides/update-ise', btn.dataset.store, 'Update ISE')
            );
        });
        el.querySelectorAll('.pg-forecast').forEach((btn) => {
            btn.addEventListener('click', () =>
                runPrepAction('/api/admin/prep-guides/update-forecast', btn.dataset.store, 'Update Forecast')
            );
        });
        el.querySelectorAll('.pg-build').forEach((btn) => {
            btn.addEventListener('click', async () => {
                const store = btn.dataset.store;
                const sel = document.getElementById('pg-store');
                if (sel) sel.value = store;
                await runPrepAction('/api/admin/prep-guides/regenerate', store, 'Build PDFs');
                showPrepPdf();
            });
        });
        el.querySelectorAll('.pg-excel').forEach((btn) => {
            btn.addEventListener('click', () => openPrepExcel(btn.dataset.store, btn));
        });
    }

    async function openPrepExcel(storeNumber, btn) {
        const store = String(storeNumber || '').replace(/\D/g, '');
        if (!store) return;
        if (btn) btn.disabled = true;
        try {
            const data = await api('/api/admin/prep-guides/open', {
                method: 'POST',
                body: JSON.stringify({ storeNumber: store }),
            });
            setMsg(
                'pg-msg',
                data.ok
                    ? `Opened ${data.path || `Prep-Guide.xlsx for ${store}`}`
                    : data.error || 'Could not open workbook.',
                Boolean(data.ok)
            );
            if (data.ok) appendPgLog(`Opened Excel: ${data.path || store}`);
            else appendPgLog(`Excel open failed (${store}): ${data.error || 'unknown'}`);
        } catch (err) {
            setMsg('pg-msg', err.message, false);
            appendPgLog(`Excel open failed (${store}): ${err.message}`);
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    async function loadPrep() {
        renderPrepTabs();
        const sel = document.getElementById('pg-store');
        const prev = sel.value;
        try {
            const data = await api('/api/admin/prep-guides');
            prepStores = data.stores || [];
            const area = data.areaLabel || 'Area';
            const sub = document.getElementById('pg-sub');
            if (sub) {
                sub.textContent = `${area} · Build PDFs force-downloads ISE first · Emails 5:00 Melbourne`;
            }
            renderPrepArea(prepStores);
            sel.innerHTML = prepStores
                .map((s) => {
                    const stamp = s.regeneratedAt ? ` · ${fmtWhen(s.regeneratedAt)}` : ' · not generated';
                    return `<option value="${s.storeNumber}">${s.storeLabel || s.storeNumber}${stamp}</option>`;
                })
                .join('');
            if (prev && [...sel.options].some((o) => o.value === prev)) sel.value = prev;
            showPrepPdf();
            setMsg('pg-msg', prepStores.length ? '' : 'No stores in coach scope.', false);
        } catch (err) {
            setMsg('pg-msg', err.message, false);
            const areaEl = document.getElementById('pg-area');
            if (areaEl) areaEl.innerHTML = `<span class="bad">${err.message}</span>`;
        }
    }

    document.getElementById('pg-store').addEventListener('change', showPrepPdf);
    document.getElementById('pg-refresh').addEventListener('click', loadPrep);
    document.getElementById('pg-sales-all')?.addEventListener('click', () => {
        runPrepActionAll('/api/admin/prep-guides/update-sales', 'Update sales');
    });
    document.getElementById('pg-ise-all')?.addEventListener('click', () => {
        runPrepActionAll('/api/admin/prep-guides/update-ise', 'Update ISE');
    });
    document.getElementById('pg-forecast-all')?.addEventListener('click', () => {
        runPrepActionAll('/api/admin/prep-guides/update-forecast', 'Update Forecast');
    });
    document.getElementById('pg-build-all')?.addEventListener('click', () => {
        runPrepActionAll('/api/admin/prep-guides/regenerate', 'Build PDFs');
    });
    document.getElementById('pg-email').addEventListener('click', async () => {
        setMsg('pg-msg', 'Sending...', true);
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
                el.textContent = 'No coach session — log in as WA, VIC, or Taco Bell in the desktop app.';
            }
        } catch {
            el.textContent = 'Coach session unavailable.';
        }
    }

    const activityUi = {
        collapsed: localStorage.getItem('act-activity-collapsed') !== '0',
        lastJson: '',
        pollTimer: null,
        es: null,
        width: 360,
        height: 280,
    };

    function activityStoreLabel(item) {
        if (item.storeNumber) return `Store ${item.storeNumber}`;
        if (Array.isArray(item.stores) && item.stores.length === 1) return `Store ${item.stores[0]}`;
        if (Array.isArray(item.stores) && item.stores.length > 1) return `${item.stores.length} stores`;
        return '';
    }

    function activityCurrentReports(item) {
        const reports = Array.isArray(item.reports) ? item.reports : [];
        const done = new Set(Array.isArray(item.stepsDone) ? item.stepsDone : []);
        const current = item.currentStep || '';
        return { all: reports, done, current };
    }

    function escapeActivityHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function renderActivityItem(item) {
        const store = activityStoreLabel(item);
        const { all, done, current } = activityCurrentReports(item);
        const statusClass =
            item.status === 'failed'
                ? 'failed'
                : item.status === 'done'
                  ? 'done'
                  : item.status === 'queued'
                    ? 'queued'
                    : '';
        const pct =
            item.status === 'done'
                ? 100
                : item.status === 'queued'
                  ? 0
                  : Math.max(0, Math.min(100, Number(item.progressPct) || 0));
        const eta =
            item.status === 'done'
                ? 'Done'
                : item.status === 'failed'
                  ? 'Failed'
                  : item.status === 'queued'
                    ? 'Queued'
                    : item.etaLabel || '';
        const chips = all.length
            ? `<div class="activity-reports">${all
                  .map((r) => {
                      const cls = done.has(r)
                          ? ' done'
                          : item.status === 'running' && r === current
                            ? ' active'
                            : '';
                      return `<span class="activity-report-chip${cls}">${escapeActivityHtml(r)}</span>`;
                  })
                  .join('')}</div>`
            : '';
        const statusLabel =
            item.status === 'queued'
                ? 'Queued'
                : item.status === 'running'
                  ? 'Running'
                  : item.status || '';
        return `<div class="activity-item ${statusClass}" data-activity-id="${escapeActivityHtml(item.id)}">
            <div class="activity-item-top">
                <strong>${escapeActivityHtml(item.title || item.kind || 'Job')}</strong>
                <span class="activity-item-store">${escapeActivityHtml(store || statusLabel)}</span>
            </div>
            <div class="activity-item-detail">${escapeActivityHtml(item.detail || '')}${item.error ? ` — ${escapeActivityHtml(item.error)}` : ''}</div>
            <div class="activity-progress-row" title="Estimated progress">
                <div class="activity-progress-track" aria-hidden="true">
                    <div class="activity-progress-fill" style="width:${pct}%"></div>
                </div>
                <span class="activity-progress-meta">${item.status === 'queued' ? '—' : `${pct}%`}</span>
            </div>
            <div class="activity-eta">${
                item.status === 'queued'
                    ? 'Waiting in queue'
                    : current && item.status === 'running'
                      ? `${escapeActivityHtml(current)} · `
                      : ''
            }${item.status === 'queued' ? '' : eta ? `ETA ${escapeActivityHtml(eta)}` : item.status === 'running' ? 'Estimating…' : escapeActivityHtml(eta)}</div>
            ${chips}
        </div>`;
    }

    function setActivityCollapsed(collapsed) {
        activityUi.collapsed = Boolean(collapsed);
        localStorage.setItem('act-activity-collapsed', activityUi.collapsed ? '1' : '0');
        const root = document.getElementById('activity-tracker');
        const toggle = document.getElementById('activity-tracker-toggle');
        const head = document.getElementById('activity-tracker-head');
        if (!root) return;
        root.classList.toggle('collapsed', activityUi.collapsed);
        if (activityUi.collapsed) {
            root.style.width = '';
            root.style.height = '';
        } else {
            applyActivitySize();
        }
        if (toggle) {
            toggle.textContent = activityUi.collapsed ? 'Expand' : 'Collapse';
            toggle.setAttribute('aria-expanded', activityUi.collapsed ? 'false' : 'true');
        }
        if (head) head.title = activityUi.collapsed ? 'Show activity' : 'Hide activity';
    }

    function paintActivity(data) {
        const root = document.getElementById('activity-tracker');
        const body = document.getElementById('activity-tracker-body');
        const title = document.getElementById('activity-tracker-title');
        const countEl = document.getElementById('activity-tracker-count');
        if (!root || !body) return;

        const active = Array.isArray(data?.active) ? data.active : [];
        const count = active.length;
        const running = active.filter((a) => a.status === 'running').length;
        const queued = active.filter((a) => a.status === 'queued').length;
        // Only show while something is actively running or queued.
        const visible = count > 0;
        root.hidden = !visible;
        root.setAttribute('aria-hidden', visible ? 'false' : 'true');
        root.classList.toggle('has-active', running > 0);
        root.classList.toggle('has-queued', queued > 0 && running === 0);
        if (!visible) {
            body.innerHTML = '';
            activityUi.lastJson = '';
            if (countEl) countEl.textContent = '0';
            if (title) title.textContent = 'Activity';
            return;
        }
        if (countEl) countEl.textContent = String(count);
        if (title) {
            if (queued && running) {
                title.textContent = `${running} running · ${queued} queued`;
            } else if (queued && !running) {
                title.textContent = queued === 1 ? '1 queued' : `${queued} queued`;
            } else if (count === 1) {
                title.textContent = active[0].title || 'Activity';
            } else {
                title.textContent = `${count} updates running`;
            }
        }

        const json = JSON.stringify(
            active.map((a) => [a.id, a.progressPct, a.etaLabel, a.currentStep, a.detail, a.status])
        );
        if (json === activityUi.lastJson) return;
        activityUi.lastJson = json;
        body.innerHTML = active.map(renderActivityItem).join('');
    }

    function isBuildToActivity(item) {
        return item?.kind === 'build-to-update' || item?.kind === 'build-to-orders';
    }

    function paintBtLog(data) {
        const el = document.getElementById('bt-log');
        if (!el) return;
        const active = (Array.isArray(data?.active) ? data.active : []).filter(isBuildToActivity);
        const recent = (Array.isArray(data?.recent) ? data.recent : []).filter(isBuildToActivity);
        const items = active.length ? active : recent;
        if (!items.length) return;

        const lines = [];
        for (const item of items) {
            const store = item.storeNumber || '';
            const label = store ? `Store ${store}` : item.title || 'Build-to';
            const st =
                item.status === 'running' ? 'running' : item.status === 'failed' ? 'failed' : 'done';
            lines.push(`—— ${item.title || 'Build-to'} · ${label} (${st}) ——`);
            for (const log of item.logs || []) {
                const t = new Date(log.at || Date.now()).toLocaleTimeString();
                const rep = log.repeats > 1 ? ` (×${log.repeats})` : '';
                const lvl = log.level === 'error' ? 'ERROR ' : log.level === 'warn' ? 'WARN ' : '';
                lines.push(`[${t}] ${lvl}${log.message || ''}${rep}`);
            }
            lines.push('');
        }
        const text = lines.join('\n').trimEnd();
        if (!text || text === el.dataset.lastBt) return;
        el.dataset.lastBt = text;
        const stick = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        el.textContent = text;
        if (stick) el.scrollTop = el.scrollHeight;
    }

    async function refreshActivity() {
        try {
            const data = await api('/api/admin/activity');
            paintActivity(data);
            paintBtLog(data);
        } catch {
            /* ignore transient poll errors */
        }
    }

    function connectActivityLive() {
        if (activityUi.es) {
            try {
                activityUi.es.close();
            } catch {
                /* ignore */
            }
        }
        try {
            const es = new EventSource('/api/live/events');
            activityUi.es = es;
            const onBump = () => refreshActivity();
            es.addEventListener('activity.updated', onBump);
            es.addEventListener('daily-reports.updated', onBump);
            es.addEventListener('build-to.updated', onBump);
            es.addEventListener('forecast.updated', onBump);
            es.addEventListener('hello', onBump);
            es.onerror = () => {
                /* browser will retry EventSource */
            };
        } catch {
            /* SSE unavailable — polling still covers it */
        }
    }

    function applyActivitySize() {
        const root = document.getElementById('activity-tracker');
        if (!root || activityUi.collapsed) return;
        const w = Number(activityUi.width) || 360;
        const h = Number(activityUi.height) || 280;
        root.style.width = `${Math.max(260, Math.min(w, window.innerWidth - 24))}px`;
        root.style.height = `${Math.max(160, Math.min(h, window.innerHeight - 24))}px`;
    }

    function initActivityResize(root) {
        if (!root) return;
        const handles = root.querySelectorAll('.activity-resize[data-resize]');
        if (!handles.length) return;
        let drag = null;

        const onMove = (ev) => {
            if (!drag) return;
            // Anchored bottom-right: drag left/up edges outward to grow.
            let nextW = drag.startW;
            let nextH = drag.startH;
            if (drag.mode === 'left' || drag.mode === 'corner') {
                nextW = Math.max(260, Math.min(window.innerWidth - 24, drag.startW + (drag.startX - ev.clientX)));
            }
            if (drag.mode === 'top' || drag.mode === 'corner') {
                nextH = Math.max(160, Math.min(window.innerHeight - 24, drag.startH + (drag.startY - ev.clientY)));
            }
            activityUi.width = Math.round(nextW);
            activityUi.height = Math.round(nextH);
            applyActivitySize();
        };

        const onUp = () => {
            if (!drag) return;
            drag = null;
            document.body.style.userSelect = '';
            document.body.style.cursor = '';
            try {
                localStorage.setItem(
                    'act-activity-size',
                    JSON.stringify({ width: activityUi.width, height: activityUi.height })
                );
            } catch {
                /* ignore */
            }
        };

        handles.forEach((handle) => {
            handle.addEventListener('pointerdown', (ev) => {
                if (activityUi.collapsed || root.hidden) return;
                ev.preventDefault();
                ev.stopPropagation();
                const rect = root.getBoundingClientRect();
                drag = {
                    mode: handle.dataset.resize || 'corner',
                    startX: ev.clientX,
                    startY: ev.clientY,
                    startW: rect.width,
                    startH: rect.height,
                };
                handle.setPointerCapture?.(ev.pointerId);
                document.body.style.userSelect = 'none';
                document.body.style.cursor = getComputedStyle(handle).cursor;
            });
            handle.addEventListener('pointermove', onMove);
            handle.addEventListener('pointerup', onUp);
            handle.addEventListener('pointercancel', onUp);
        });

        window.addEventListener('resize', () => applyActivitySize());
    }

    function initActivityTracker() {
        const root = document.getElementById('activity-tracker');
        const head = document.getElementById('activity-tracker-head');
        const toggle = document.getElementById('activity-tracker-toggle');
        if (!root || !head) return;

        try {
            const saved = JSON.parse(localStorage.getItem('act-activity-size') || '{}');
            if (Number(saved.width) > 0) activityUi.width = Number(saved.width);
            if (Number(saved.height) > 0) activityUi.height = Number(saved.height);
        } catch {
            /* ignore */
        }
        if (!activityUi.width) activityUi.width = 360;
        if (!activityUi.height) activityUi.height = 280;

        setActivityCollapsed(activityUi.collapsed);
        applyActivitySize();
        initActivityResize(root);

        head.addEventListener('click', (ev) => {
            if (ev.target === toggle || ev.target?.closest?.('.activity-resize')) return;
            setActivityCollapsed(!activityUi.collapsed);
            if (!activityUi.collapsed) applyActivitySize();
        });
        toggle?.addEventListener('click', (ev) => {
            ev.stopPropagation();
            setActivityCollapsed(!activityUi.collapsed);
            if (!activityUi.collapsed) applyActivitySize();
        });
        refreshActivity();
        connectActivityLive();
        activityUi.pollTimer = setInterval(refreshActivity, 2000);
    }

    show('overview');
    loadCoachBanner();
    initActivityTracker();
})();
