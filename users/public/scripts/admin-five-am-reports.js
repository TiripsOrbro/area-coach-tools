(function (global) {
    const DAILY_REPORT_JOBS = [
        {
            id: 'stock-levels',
            label: 'Stock levels',
            title: 'Run the stock-levels check (on hand, and on hand + on order)',
            dataAttr: 'data-daily-stock-store',
            readEnabled: (store, state) => Boolean(state.stockPayload?.stores?.[store]),
            writeEnabled: async (store, enabled) => {
                const res = await fetch('/api/admin/five-am-reports/stores', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'same-origin',
                    body: JSON.stringify({ store, enabled }),
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok || !data.success) {
                    throw new Error(data.error || 'Could not save stock levels setting.');
                }
                return data;
            },
        },
        {
            id: 'forecast-auto-submit',
            label: 'Forecast',
            title: 'Auto-submit the next 3 weeks of forecasts for this store',
            dataAttr: 'data-daily-forecast-store',
            readEnabled: (store, state) => Boolean(state.forecastPayload?.stores?.[store]),
            writeEnabled: async (store, enabled) => {
                const res = await fetch('/api/admin/forecast/store-auto-submit', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'same-origin',
                    body: JSON.stringify({ store, enabled }),
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok || !data.success) {
                    throw new Error(data.error || 'Could not save forecast setting.');
                }
                return data;
            },
        },
    ];

    const AREA_STORAGE_KEY = 'admin-five-am-area';

    let pageHost = null;
    let stockPayload = null;
    let forecastPayload = null;
    let storesPayload = [];
    let canManage = false;
    let activeArea = '';
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

    function pageState() {
        return { stockPayload, forecastPayload };
    }

    function areaChipLabel(areaId) {
        const fromDisplay = global.AreaDisplay?.label?.(areaId);
        if (fromDisplay) return fromDisplay;
        const raw = String(areaId ?? '');
        return raw.replace(/-1$/i, '') || raw;
    }

    function visibleStores() {
        const enabledMap = stockPayload?.stores || {};
        return storesPayload
            .filter((s) => Object.prototype.hasOwnProperty.call(enabledMap, String(s.storeNumber)))
            .sort((a, b) =>
                String(a.storeNumber).localeCompare(String(b.storeNumber), undefined, { numeric: true })
            );
    }

    function orderedAreas() {
        const canonical = ['VIC-1', 'WA-1', 'QLD-1'];
        const areas = [...new Set(visibleStores().map((s) => String(s.area || '').trim()).filter(Boolean))];
        const picked = canonical.filter((id) => areas.includes(id));
        const rest = areas.filter((id) => !canonical.includes(id)).sort();
        return picked.length ? [...picked, ...rest] : rest;
    }

    function storesInActiveArea() {
        if (!activeArea) return visibleStores();
        return visibleStores().filter((s) => String(s.area || '').trim() === activeArea);
    }

    function pickDefaultArea() {
        const areas = orderedAreas();
        const saved = sessionStorage.getItem(AREA_STORAGE_KEY);
        if (saved && areas.includes(saved)) return saved;
        return areas[0] || '';
    }

    function renderAreaTabs() {
        return orderedAreas()
            .map((area) => {
                const isActive = area === activeArea;
                return `<button type="button" class="admin-accounts-scope-chip${isActive ? ' is-active' : ''}" role="tab" aria-selected="${isActive ? 'true' : 'false'}" data-daily-report-area="${escapeHtml(area)}">${escapeHtml(areaChipLabel(area))}</button>`;
            })
            .join('');
    }

    async function fetchProfile() {
        try {
            const res = await fetch('/api/me', { credentials: 'same-origin' });
            const data = await res.json().catch(() => ({}));
            return res.ok && data.success ? data : {};
        } catch {
            return {};
        }
    }

    async function fetchStores() {
        try {
            const res = await fetch('/api/stores', { credentials: 'same-origin' });
            const data = await res.json().catch(() => ({}));
            return res.ok && data.success && Array.isArray(data.stores) ? data.stores : [];
        } catch {
            return [];
        }
    }

    async function fetchStockStatus() {
        const res = await fetch('/api/admin/five-am-reports/stores', { credentials: 'same-origin' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) {
            throw new Error(data.error || 'Could not load daily reports settings.');
        }
        return data;
    }

    async function fetchForecastStatus() {
        const res = await fetch('/api/admin/forecast/auto-submit', { credentials: 'same-origin' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) {
            throw new Error(data.error || 'Could not load forecast auto-submit settings.');
        }
        return data;
    }

    function formatShortDateTimeNoYear(iso) {
        if (!iso) return '-';
        const dateKeyMatch = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})$/);
        const d = dateKeyMatch
            ? new Date(`${dateKeyMatch[1]}-${dateKeyMatch[2]}-${dateKeyMatch[3]}T12:00:00`)
            : new Date(iso);
        if (Number.isNaN(d.getTime())) return escapeHtml(String(iso));
        const date = new Intl.DateTimeFormat('en-AU', { day: 'numeric', month: 'short' }).format(d);
        if (dateKeyMatch) return escapeHtml(date);
        const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
        return escapeHtml(`${date} ${time}`);
    }

    function renderJobToggle(job, store, enabled) {
        if (!canManage) {
            return `<span class="admin-accounts-meta">${enabled ? 'On' : 'Off'}</span>`;
        }
        return `<label class="mic-toggle-switch" title="${escapeHtml(job.title)}">
            <input type="checkbox" role="switch" aria-label="${escapeHtml(job.label)} for store ${escapeHtml(store)}" ${job.dataAttr}="${escapeHtml(store)}" data-daily-job="${escapeHtml(job.id)}"${enabled ? ' checked' : ''} />
            <span class="mic-toggle-slider" aria-hidden="true"></span>
        </label>`;
    }

    function renderRows() {
        const lastRunAt = stockPayload?.lastRunAt || {};
        const lastRun = stockPayload?.lastRun || {};
        const lastForecastUpdate = forecastPayload?.lastForecastUpdate || {};
        const rows = storesInActiveArea();
        if (!rows.length) {
            return `<p class="admin-accounts-meta">No stores in ${escapeHtml(areaChipLabel(activeArea) || 'this area')}.</p>`;
        }
        const jobHeaders = DAILY_REPORT_JOBS.map(
            (job) => `<th scope="col" class="admin-five-am-col-job">${escapeHtml(job.label)}</th>`
        ).join('');
        const state = pageState();
        const body = rows
            .map((s) => {
                const store = String(s.storeNumber);
                const jobCells = DAILY_REPORT_JOBS.map((job) => {
                    const enabled = job.readEnabled(store, state);
                    return `<td class="admin-five-am-col-job">${renderJobToggle(job, store, enabled)}</td>`;
                }).join('');
                const stockRunAt = lastRunAt[store] || lastRun[store];
                const stockRunLabel = formatShortDateTimeNoYear(stockRunAt);
                const forecastUpdateLabel = formatShortDateTimeNoYear(lastForecastUpdate[store]);
                return `<tr>
                    <td class="admin-five-am-col-store">${escapeHtml(store)}<span class="admin-accounts-meta">${escapeHtml(s.storeName || '')}</span></td>
                    ${jobCells}
                    <td class="admin-five-am-col-last-forecast"><span class="admin-accounts-meta">${forecastUpdateLabel}</span></td>
                    <td class="admin-five-am-col-last-stock"><span class="admin-accounts-meta">${stockRunLabel}</span></td>
                </tr>`;
            })
            .join('');
        return `
            <table class="admin-table admin-five-am-table">
                <colgroup>
                    <col class="admin-five-am-col-store" />
                    ${DAILY_REPORT_JOBS.map(() => '<col class="admin-five-am-col-job" />').join('')}
                    <col class="admin-five-am-col-last-forecast" />
                    <col class="admin-five-am-col-last-stock" />
                </colgroup>
                <thead>
                    <tr>
                        <th scope="col" class="admin-five-am-col-store">Store</th>
                        ${jobHeaders}
                        <th scope="col" class="admin-five-am-col-last-forecast">Last forecast update</th>
                        <th scope="col" class="admin-five-am-col-last-stock">Last stock run</th>
                    </tr>
                </thead>
                <tbody>${body}</tbody>
            </table>`;
    }

    function refreshTable() {
        const root = getRoot();
        const body = root?.querySelector('#admin-five-am-body');
        if (!body) return;
        body.innerHTML = renderRows();
        bindRows();
    }

    function selectArea(area) {
        if (!area || area === activeArea) return;
        activeArea = area;
        sessionStorage.setItem(AREA_STORAGE_KEY, activeArea);
        const nav = getRoot()?.querySelector('#admin-five-am-area-tabs');
        if (nav) {
            nav.innerHTML = renderAreaTabs();
        }
        refreshTable();
    }

    function bindNavigation() {
        const root = getRoot();
        if (!root || root.dataset.dailyReportsNavBound) return;
        root.dataset.dailyReportsNavBound = '1';
        root.addEventListener('click', (event) => {
            const tab = event.target.closest('[data-daily-report-area]');
            if (!tab) return;
            selectArea(tab.getAttribute('data-daily-report-area') || '');
        });
    }

    function render() {
        const root = getRoot();
        if (!root) return;
        const areaCount = Math.max(orderedAreas().length, 1);
        root.innerHTML = `
            <div class="admin-modal admin-modal--inline admin-five-am-reports">
                <h2>Daily reports</h2>
                <p class="admin-modal-error" id="admin-five-am-error" role="alert"></p>
                <div class="admin-settings-segmented-tabs admin-accounts-browse-scope admin-accounts-org-nav admin-report-sub-area-nav">
                    <div class="admin-accounts-scope-row-wrap">
                        <span class="admin-accounts-scope-row-label">Area</span>
                        <nav class="admin-accounts-scope-row admin-accounts-scope-row--equal admin-report-sub-area-tabs" id="admin-five-am-area-tabs" role="tablist" aria-label="Select area" style="--scope-cols: ${areaCount}">${renderAreaTabs()}</nav>
                    </div>
                </div>
                <div id="admin-five-am-body">${renderRows()}</div>
            </div>`;
        bindNavigation();
        bindRows();
    }

    function bindRows() {
        const root = getRoot();
        if (!root) return;
        root.querySelectorAll('[data-daily-job]').forEach((input) => {
            input.addEventListener('change', (event) => {
                const jobId = event.target.getAttribute('data-daily-job');
                const job = DAILY_REPORT_JOBS.find((row) => row.id === jobId);
                if (!job) return;
                const store = event.target.getAttribute(job.dataAttr) || '';
                if (!store) return;
                void saveJob(store, job, event.target.checked, event.target);
            });
        });
    }

    async function saveJob(storeNumber, job, enabled, inputEl) {
        const root = getRoot();
        const errEl = root?.querySelector('#admin-five-am-error');
        if (errEl) errEl.textContent = '';
        try {
            const data = await job.writeEnabled(storeNumber, enabled);
            if (job.id === 'stock-levels') {
                if (stockPayload?.stores) stockPayload.stores[storeNumber] = Boolean(enabled);
            } else if (job.id === 'forecast-auto-submit') {
                if (forecastPayload?.stores) forecastPayload.stores[storeNumber] = Boolean(enabled);
            }
        } catch (err) {
            if (inputEl) inputEl.checked = !enabled;
            if (errEl) errEl.textContent = err.message || 'Could not save setting.';
        }
    }

    async function open() {
        const root = getRoot();
        if (root) {
            root.innerHTML = '<p class="admin-accounts-meta">Loading daily reports…</p>';
        }
        try {
            const [profile, stores, stockStatus, forecastStatus] = await Promise.all([
                fetchProfile(),
                fetchStores(),
                fetchStockStatus(),
                fetchForecastStatus(),
            ]);
            canManage = Boolean(profile.canEditGlobalBuildTo);
            storesPayload = stores;
            stockPayload = stockStatus;
            forecastPayload = forecastStatus;
            activeArea = pickDefaultArea();
            if (activeArea) sessionStorage.setItem(AREA_STORAGE_KEY, activeArea);
            render();
        } catch (err) {
            if (root) {
                root.innerHTML = `<p class="admin-modal-error" role="alert">${escapeHtml(err.message || 'Could not load daily reports.')}</p>`;
            }
        }
    }

    function mount(host) {
        pageHost = host;
        return open();
    }

    function setInlineHost(host) {
        pageHost = host || null;
    }

    function unmount() {
        pageHost = null;
        stockPayload = null;
        forecastPayload = null;
        storesPayload = [];
        activeArea = '';
    }

    global.AdminFiveAmReports = { mount, setInlineHost, unmount, open };
})(window);
