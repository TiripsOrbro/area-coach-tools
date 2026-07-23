const IS_ADMIN_AREA_ROUTE = false;

const areaPathMatch = window.location.pathname.match(/\/area\/([a-z0-9-]+)\/?$/i);
const areaCodeMatch = window.location.pathname.match(/^\/(a\d+)\/?$/i);
const initialAreaKey =
    (areaPathMatch ? areaPathMatch[1] : areaCodeMatch ? areaCodeMatch[1].toUpperCase() : '') ||
    '';
const titleEl = document.getElementById('title');
const areaTabsEl = document.getElementById('area-tabs');
const areaGrids = document.getElementById('area-grids');
const ordersList = document.getElementById('orders-list');
const auditsList = document.getElementById('audits-list');
const timeEl = document.getElementById('time-display');
const updatedEl = document.getElementById('last-updated');
const statusBanner = document.getElementById('status-banner');
let latestDashboards = [];
let latestAreaKey = initialAreaKey;

let areaList = ['VIC-1', 'WA-1', 'QLD-1'];

function areaLabel(name) {
    return global.AreaDisplay?.label?.(name) ?? String(name ?? '').trim();
}
let isAdminView = false;
/** @type {Map<string, object>} */
const areasByKey = new Map();
let areaTabsWired = false;

const AREA_DATA_REFRESH_MS = 60000;

function areaCodeFromName(name) {
    const m = String(name || '').match(/(\d+)/);
    return m ? `A${Number(m[1])}` : '';
}

function areaPathFromName(name) {
    const code = areaCodeFromName(name);
    if (code) return `/${code}`;
    return `/area/${encodeURIComponent(String(name).toLowerCase().replace(/\s+/g, '-'))}`;
}

function normalizeAreaMatchKey(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '');
}

function areaKeyFromPath() {
    const pathMatch = window.location.pathname.match(/\/area\/([a-z0-9-]+)\/?$/i);
    const codeMatch = window.location.pathname.match(/^\/(a\d+)\/?$/i);
    return (pathMatch ? pathMatch[1] : codeMatch ? codeMatch[1].toUpperCase() : '') || '';
}

function cacheAreaPayload(data) {
    if (!data) return;
    const aliases = new Set(
        [
            data.areaKey,
            data.area,
            areaCodeFromName(data.area),
            normalizeAreaMatchKey(data.areaKey),
            normalizeAreaMatchKey(data.area),
            normalizeAreaMatchKey(areaCodeFromName(data.area)),
        ].filter(Boolean)
    );
    for (const alias of aliases) {
        areasByKey.set(alias, data);
    }
}

function resolveAreaPayload(key) {
    const want = normalizeAreaMatchKey(key);
    if (areasByKey.has(want)) return areasByKey.get(want);
    if (areasByKey.has(key)) return areasByKey.get(key);
    for (const data of areasByKey.values()) {
        if (normalizeAreaMatchKey(data.areaKey) === want) return data;
        if (normalizeAreaMatchKey(data.area) === want) return data;
        if (normalizeAreaMatchKey(areaCodeFromName(data.area)) === want) return data;
    }
    return null;
}

function wireAreaTabs() {
    if (!areaTabsEl || areaTabsWired) return;
    areaTabsWired = true;
    areaTabsEl.addEventListener('click', (event) => {
        const btn = event.target.closest('button[data-area-select]');
        if (!btn) return;
        event.preventDefault();
        selectArea(btn.dataset.areaSelect, { pushHistory: true });
    });
}

function renderAreaTabs(currentAreaName) {
    if (!areaTabsEl) return;
    if (!isAdminView) {
        areaTabsEl.hidden = true;
        areaTabsEl.innerHTML = '';
        return;
    }
    areaTabsEl.hidden = false;
    const currentKey = normalizeAreaMatchKey(currentAreaName || latestAreaKey);
    const parts = [];
    areaList.forEach((name, idx) => {
        const tabKey = areaCodeFromName(name) || normalizeAreaMatchKey(name);
        const active =
            normalizeAreaMatchKey(name) === currentKey ||
            normalizeAreaMatchKey(areaCodeFromName(name)) === currentKey ||
            normalizeAreaMatchKey(latestAreaKey) === normalizeAreaMatchKey(tabKey);
        if (active) {
            parts.push(
                `<span class="admin-area-tab is-active" role="tab" aria-selected="true">${escapeHtml(areaLabel(name))}</span>`
            );
        } else {
            parts.push(
                `<button type="button" class="admin-area-tab" role="tab" data-area-select="${tabKey}" aria-selected="false">${escapeHtml(areaLabel(name))}</button>`
            );
        }
        if (idx < areaList.length - 1) {
            parts.push('<span class="admin-area-tab-pipe" aria-hidden="true"> |</span>');
        }
    });
    areaTabsEl.innerHTML = parts.join('');
    wireAreaTabs();
}

function escapeHtml(text) {
    return String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function adminStoreHref(storeNumber) {
    const num = String(storeNumber || '').replace(/[^0-9]/g, '');
    return num
        ? window.AppPaths?.adminStore?.(num) || `/Admin/${encodeURIComponent(num)}`
        : window.AppPaths?.overview?.() || '/overview';
}

function syncFooterGridColumns(dashboards) {
    const maxHours = Math.max(
        12,
        ...(dashboards || []).map((d) => (Array.isArray(d?.combinedHourly) ? d.combinedHourly.length : 0))
    );
    document.documentElement.style.setProperty('--grid-hours', String(maxHours));
}

function renderOutstandingLists(data) {
    if (!ordersList || !auditsList) return;

    const orders = data.storesWithOrdersOutstanding || [];
    if (!orders.length) {
        ordersList.innerHTML =
            '<div class="pending-vendor-item pending-vendor-item--info"><p class="pending-vendor-monday-note">No stores with orders outstanding.</p></div>';
    } else {
        ordersList.innerHTML = orders
            .map((s) => {
                const label = `${s.storeNumber} ${s.storeName} (${s.pendingCount})`;
                const href = adminStoreHref(s.storeNumber);
                return `<div class="pending-vendor-item"><a class="pending-vendor-chip pending-vendor-chip--link" href="${escapeHtml(href)}" aria-label="${escapeHtml(label)}">${escapeHtml(label)}</a></div>`;
            })
            .join('');
    }

    const audits = data.storesWithAuditsOutstanding || [];
    if (!audits.length) {
        auditsList.innerHTML =
            '<div class="audit-item"><span class="audit-chip" style="cursor: default;">No stores with audits outstanding.</span></div>';
    } else {
        auditsList.innerHTML = audits
            .map((s) => {
                const label = `${s.storeNumber} ${s.storeName} (${s.outstandingCount})`;
                const href = adminStoreHref(s.storeNumber);
                return `<div class="audit-item"><a class="audit-chip" href="${escapeHtml(href)}" aria-label="${escapeHtml(label)}">${escapeHtml(label)}</a></div>`;
            })
            .join('');
    }
}

function fmtHour(hour) {
    const h = (((Math.trunc(hour) % 24) + 24) % 24);
    const period = h < 12 ? 'AM' : 'PM';
    const display = h % 12 === 0 ? 12 : h % 12;
    return `${display}${period}`;
}

function fmtCurrency(value) {
    const n = Number(value || 0);
    return `$${Math.round(n).toLocaleString()}`;
}

function sum(rows, key) {
    return (rows || []).reduce((acc, row) => acc + (Number(row[key]) || 0), 0);
}

function zoneHourMinuteSecond(timeZone) {
    const parts = new Intl.DateTimeFormat('en-AU', {
        timeZone: String(timeZone || 'Australia/Melbourne'),
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
    }).formatToParts(new Date());
    const get = (type) => Number(parts.find((p) => p.type === type)?.value);
    return { hour: get('hour'), minute: get('minute'), second: get('second') };
}

function liveHourState(hours, timeZone) {
    if (!Array.isArray(hours) || !hours.length) return { index: -1, progressPct: 0 };
    const { hour, minute, second } = zoneHourMinuteSecond(timeZone);
    const index = hours.findIndex((r) => Math.trunc(r.localHour) === hour);
    if (index < 0) return { index: -1, progressPct: 0 };
    const progressPct = Math.max(0, Math.min(100, ((minute * 60 + second) / 3600) * 100));
    return { index, progressPct };
}

function getPaceClass(actual, forecast, elapsedProgress) {
    const f = Number(forecast) || 0;
    const a = Number(actual) || 0;
    const p = Number(elapsedProgress) || 0;
    if (f <= 0 || p <= 0) return 'cell-green';

    const expected = f * p;
    if (a >= expected) return 'cell-green';

    const shortfall = (expected - a) / expected;
    if (shortfall <= 0.1) return 'cell-orange';
    return 'cell-red';
}

function getActualCellClass(actual, forecast) {
    const f = Number(forecast) || 0;
    const a = Number(actual) || 0;
    if (f <= 0) return '';
    const ratio = (a - f) / f;
    if (ratio >= 0) return 'cell-green';
    if (ratio >= -0.1) return 'cell-orange';
    return 'cell-red';
}

const paceFillMap = {
    'cell-green': 'var(--good)',
    'cell-orange': 'var(--near)',
    'cell-red': 'var(--bad)',
};

const paceBorderMap = {
    'cell-green': 'var(--good-border)',
    'cell-orange': 'var(--near-border)',
    'cell-red': 'var(--bad-border)',
};

function buildLiveProgressLayersHtml(timeFillPercent, outcomeClass, paceClass) {
    const p = Math.max(0, Math.min(100, timeFillPercent));
    const mainBg = paceFillMap[outcomeClass] || 'var(--blank)';
    const paceBg = paceFillMap[paceClass] || 'var(--bad)';
    return `<div class="grid-cell-live-layers" aria-hidden="true">
        <div class="grid-cell-live-main-frame">
            <div class="grid-cell-live-main-fill" style="width: ${p}%; background-color: ${mainBg};"></div>
        </div>
        <div class="grid-cell-live-pace-row">
            <div class="grid-cell-live-pace-grow" style="width: ${p}%;">
                <div class="grid-cell-live-pace-bar" style="border-top: var(--cell-border) ${paceBg}; background-color: ${paceBg};"></div>
            </div>
        </div>
    </div>`;
}

function buildHourCellHtml(row, idx, live, displayValue) {
    const isFuture = live.index >= 0 && idx > live.index;
    if (isFuture) {
        return `<div class="grid-cell">${fmtCurrency(displayValue)}</div>`;
    }

    const forecast = Number(row.forecast) || 0;
    const actual = Number(row.actual) || 0;
    const isCurrentHour = live.index >= 0 && idx === live.index;

    if (!isCurrentHour) {
        const cellClass = getActualCellClass(actual, forecast);
        return `<div class="grid-cell${cellClass ? ` ${cellClass}` : ''}">${fmtCurrency(displayValue)}</div>`;
    }

    const progress = live.progressPct / 100;
    const paceClass = getPaceClass(actual, forecast, progress);
    const outcomeClass = getActualCellClass(actual, forecast);
    const progressPct = Math.round(progress * 1000) / 10;
    const layers = buildLiveProgressLayersHtml(progressPct, outcomeClass, paceClass);
    const outcomeBorder = paceBorderMap[outcomeClass] || 'var(--blank-border)';
    return `<div class="grid-cell grid-cell--live-hour" style="border: var(--cell-border) ${outcomeBorder};">${layers}<span class="grid-cell-live-value">${fmtCurrency(displayValue)}</span></div>`;
}

function buildDayPartCharcoalCellHtml(actualTotal, forecastTotal) {
    let statusClass = 'cell-green';
    const dayForecast = Number(forecastTotal) || 0;
    const dayActual = Number(actualTotal) || 0;
    if (dayForecast > 0) {
        statusClass = getActualCellClass(dayActual, dayForecast);
    }
    const barBg = paceFillMap[statusClass] || paceFillMap['cell-green'];
    return `<div class="grid-label meal-period-label meal-period-day-sales-total" role="region" aria-label="Day sales total">
        <div class="meal-period-day-sales-stack">
            <div class="meal-period-day-sales-figures">
                <div class="meal-period-day-sales-line">A${fmtCurrency(dayActual)}</div>
                <div class="meal-period-day-sales-line">F${fmtCurrency(dayForecast)}</div>
            </div>
        </div>
        <div class="meal-period-day-sales-fullbar" style="background-color: ${barBg}"></div>
    </div>`;
}

function buildGrid(rows, titleText = '', dash = {}) {
    if (!areaGrids) return;
    const hours = rows || [];
    const live = liveHourState(hours, dash?.timeZone);
    const section = document.createElement('section');
    section.className = 'area-grid-section';
    const heading = document.createElement('h3');
    heading.className = 'area-grid-heading';
    heading.textContent = titleText || 'Sales Dashboard';
    section.appendChild(heading);

    const grid = document.createElement('div');
    grid.className = 'dashboard-grid';
    grid.style.setProperty('--grid-hours', String(Math.max(hours.length, 1)));
    section.appendChild(grid);

    if (!hours.length) {
        grid.innerHTML = '<div class="grid-error">No combined hourly sales loaded yet.</div>';
        areaGrids.appendChild(section);
        return;
    }

    const headerCells = hours
        .map((r, idx) => {
            const isLive = idx === live.index;
            return `<div class="grid-cell header-cell${isLive ? ' area-live-header' : ''}">${fmtHour(r.localHour)}</div>`;
        })
        .join('');
    const forecastCells = hours
        .map((r, idx) => buildHourCellHtml(r, idx, live, r.forecast))
        .join('');
    const actualCells = hours
        .map((r, idx) => buildHourCellHtml(r, idx, live, r.actual))
        .join('');
    const forecastTotal = sum(hours, 'forecast');
    const actualTotal = sum(hours, 'actual');
    const dayStatusClass =
        forecastTotal > 0 ? getActualCellClass(actualTotal, forecastTotal) : 'cell-green';
    const dayOutcomeBorder = paceBorderMap[dayStatusClass] || 'var(--blank-border)';
    grid.innerHTML = `
        <div class="grid-label header-label">Time</div>
        ${headerCells}
        <div class="grid-label">Forecast</div>
        ${forecastCells}
        <div class="grid-label">Actual</div>
        ${actualCells}
        ${buildDayPartCharcoalCellHtml(actualTotal, forecastTotal)}
        <div class="grid-cell meal-period-cell ${dayStatusClass}" style="grid-column: span ${hours.length}; border: var(--cell-border) ${dayOutcomeBorder};">
            <div class="meal-period-body">
                <div class="meal-period-stats">
                    <span class="meal-period-line"><span class="meal-period-k">Actual</span> <span class="meal-period-value">${fmtCurrency(actualTotal)}</span></span>
                    <span class="meal-period-line"><span class="meal-period-k">Forecast</span> <span class="meal-period-value">${fmtCurrency(forecastTotal)}</span></span>
                </div>
            </div>
        </div>
    `;
    areaGrids.appendChild(section);
}

function renderDashboards(dashboards) {
    if (areaGrids) areaGrids.innerHTML = '';
    syncFooterGridColumns(dashboards);
    if (!dashboards.length) {
        buildGrid([], 'Sales Dashboard');
        return;
    }
    for (const dash of dashboards) {
        const label = dash?.state ? `${dash.state} Sales Dashboard` : 'Sales Dashboard';
        buildGrid(Array.isArray(dash?.combinedHourly) ? dash.combinedHourly : [], label, dash);
    }
}

function updateClock() {
    if (!timeEl) return;
    timeEl.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function setStatus(message) {
    if (!statusBanner) return;
    if (!message) {
        statusBanner.hidden = true;
        statusBanner.textContent = '';
        return;
    }
    statusBanner.hidden = false;
    statusBanner.textContent = message;
}

function applyAreaView(data) {
    if (!data) return;
    titleEl.textContent = 'SALES DASHBOARD';
    latestAreaKey = areaCodeFromName(data.area) || data.areaKey || latestAreaKey;
    isAdminView = Boolean(data.isAdmin);
    if (Array.isArray(data.areas) && data.areas.length) areaList = data.areas;
    renderAreaTabs(data.area);
    if (updatedEl && data.timestamp) {
        updatedEl.textContent = new Date(data.timestamp).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
        });
    }
    const dashboards = Array.isArray(data.dashboards) ? data.dashboards : [];
    latestDashboards = dashboards;
    const hasAnyRows = dashboards.some((d) => Array.isArray(d.combinedHourly) && d.combinedHourly.length);
    if (!hasAnyRows) {
        setStatus('No combined hourly sales loaded yet. Data appears after a successful sales scrape.');
    } else {
        setStatus('');
    }
    renderDashboards(dashboards);

    renderOutstandingLists(data);
}

function selectArea(key, { pushHistory = false } = {}) {
    const data = resolveAreaPayload(key);
    if (!data) return false;
    applyAreaView(data);
    if (pushHistory) {
        const path = areaPathFromName(data.area);
        if (window.location.pathname !== path) {
            history.pushState({ areaKey: areaCodeFromName(data.area) || data.areaKey }, '', path);
        }
    }
    return true;
}

function ingestBulkPayload(bulk) {
    areasByKey.clear();
    for (const data of Object.values(bulk.byArea || {})) {
        cacheAreaPayload(data);
    }
    isAdminView = Boolean(bulk.isAdmin);
    if (Array.isArray(bulk.areas) && bulk.areas.length) areaList = bulk.areas;
}

function ingestSinglePayload(data) {
    cacheAreaPayload(data);
    isAdminView = Boolean(data.isAdmin);
    if (Array.isArray(data.areas) && data.areas.length) areaList = data.areas;
}

async function fetchAllAreas() {
    const res = await fetch('/api/area-dashboard/all', { credentials: 'include' });
    if (!res.ok) return null;
    const bulk = await res.json();
    if (!bulk.success) throw new Error(bulk.error || 'Failed to load area dashboards');
    return bulk;
}

async function fetchSingleArea(key) {
    const res = await fetch(`/api/area-dashboard?area=${encodeURIComponent(key)}`, {
        credentials: 'include',
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'Failed to load area dashboard');
    return data;
}

async function loadAreas({ silent = false } = {}) {
    if (!silent) setStatus('Loading area data…');

    try {
        const bulk = await fetchAllAreas();
        if (bulk) {
            ingestBulkPayload(bulk);
            const pick =
                initialAreaKey ||
                areaCodeFromName(areaList[0]) ||
                normalizeAreaMatchKey(areaList[0]) ||
                Object.keys(bulk.byArea || {})[0];
            if (!selectArea(pick, { pushHistory: false })) {
                const first = Object.values(bulk.byArea || {})[0];
                if (first) applyAreaView(first);
            } else if (initialAreaKey) {
                const data = resolveAreaPayload(initialAreaKey);
                if (data) {
                    const path = areaPathFromName(data.area);
                    history.replaceState(
                        { areaKey: areaCodeFromName(data.area) || data.areaKey },
                        '',
                        path
                    );
                }
            }
            if (!silent) setStatus('');
            return;
        }
    } catch {
        /* fall through to single-area fetch */
    }

    const key = initialAreaKey || areaCodeFromName(areaList[0]) || areaList[0];
    const data = await fetchSingleArea(key);
    ingestSinglePayload(data);
    applyAreaView(data);
    if (!silent) setStatus('');
}

applyDashboardScale();
window.addEventListener('resize', applyDashboardScale, { passive: true });

loadAreas().catch((err) => {
    setStatus(err.message || 'Unable to refresh area data. If issue persists, contact Ash.');
});

window.addEventListener('popstate', () => {
    const key = history.state?.areaKey || areaKeyFromPath();
    if (key) selectArea(key, { pushHistory: false });
});

updateClock();
setInterval(updateClock, 1000);
const GRID_PROGRESS_REFRESH_MS = 10000;
setInterval(() => {
    if (latestDashboards.length) renderDashboards(latestDashboards);
}, GRID_PROGRESS_REFRESH_MS);
setInterval(() => {
    loadAreas({ silent: true })
        .then(() => {
            const key = history.state?.areaKey || latestAreaKey || areaKeyFromPath();
            selectArea(key, { pushHistory: false });
        })
        .catch(() => {});
}, AREA_DATA_REFRESH_MS);
