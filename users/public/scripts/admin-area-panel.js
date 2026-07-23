/**
 * Area totals panel embedded in /Admin/A## - VIC/WA grids + multi-store audits/orders.
 */
(function (global) {
    let cachedPayload = null;
    let cachedKey = '';

    function escapeHtml(text) {
        return String(text ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
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

    function getActualCellClass(actual, forecast) {
        const f = Number(forecast) || 0;
        const a = Number(actual) || 0;
        if (f <= 0) return '';
        const ratio = (a - f) / f;
        if (ratio >= 0) return 'cell-green';
        if (ratio >= -0.1) return 'cell-orange';
        return 'cell-red';
    }

    function getPaceClass(actual, forecast, elapsedProgress) {
        const f = Number(forecast) || 0;
        const a = Number(actual) || 0;
        const p = Number(elapsedProgress) || 0;
        if (f <= 0 || p <= 0) return 'cell-green';
        const expected = f * p;
        if (a >= expected) return 'cell-green';
        if ((expected - a) / expected <= 0.1) return 'cell-orange';
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

    function buildGrid(host, rows, titleText, dash) {
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
            host.appendChild(section);
            return;
        }

        const headerCells = hours
            .map((r, idx) => {
                const isLive = idx === live.index;
                return `<div class="grid-cell header-cell${isLive ? ' area-live-header' : ''}">${fmtHour(r.localHour)}</div>`;
            })
            .join('');
        const forecastCells = hours.map((r, idx) => buildHourCellHtml(r, idx, live, r.forecast)).join('');
        const actualCells = hours.map((r, idx) => buildHourCellHtml(r, idx, live, r.actual)).join('');
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
        </div>`;
        host.appendChild(section);
    }

    function adminStoreHref(storeNumber) {
        const num = String(storeNumber || '').replace(/[^0-9]/g, '');
        if (!num) return global.AppPaths?.overview?.() || '/overview';
        const areaCode = global.AdminStoreTabs?.areaFromPath?.() || '';
        if (areaCode) {
            return (
                global.AppPaths?.adminAreaWithStore?.(areaCode, num) ||
                `/Admin/${encodeURIComponent(areaCode)}?store=${encodeURIComponent(num)}`
            );
        }
        return global.AppPaths?.adminStore?.(num) || `/Admin/${encodeURIComponent(num)}`;
    }

    function renderOutstandingLists(data) {
        const ordersList = document.getElementById('admin-area-orders-list');
        const auditsList = document.getElementById('admin-area-audits-list');
        if (!ordersList || !auditsList) return;

        const orders = data.storesWithOrdersOutstanding || [];
        ordersList.innerHTML = !orders.length
            ? '<div class="pending-vendor-item pending-vendor-item--info"><p class="pending-vendor-monday-note">No stores with orders outstanding.</p></div>'
            : orders
                  .map((s) => {
                      const label = `${s.storeNumber} ${s.storeName} (${s.pendingCount})`;
                      return `<div class="pending-vendor-item"><a class="pending-vendor-chip pending-vendor-chip--link" href="${escapeHtml(adminStoreHref(s.storeNumber))}" aria-label="${escapeHtml(label)}">${escapeHtml(label)}</a></div>`;
                  })
                  .join('');

        const audits = data.storesWithAuditsOutstanding || [];
        auditsList.innerHTML = !audits.length
            ? '<div class="audit-item"><span class="audit-chip" style="cursor: default;">No stores with audits outstanding.</span></div>'
            : audits
                  .map((s) => {
                      const label = `${s.storeNumber} ${s.storeName} (${s.outstandingCount})`;
                      return `<div class="audit-item"><a class="audit-chip" href="${escapeHtml(adminStoreHref(s.storeNumber))}" aria-label="${escapeHtml(label)}">${escapeHtml(label)}</a></div>`;
                  })
                  .join('');
    }

    function syncFooterGridColumns(dashboards) {
        const maxHours = Math.max(
            12,
            ...(dashboards || []).map((d) => (Array.isArray(d?.combinedHourly) ? d.combinedHourly.length : 0))
        );
        document.documentElement.style.setProperty('--grid-hours', String(maxHours));
    }

    function renderPayload(data) {
        const host = document.getElementById('admin-area-grids');
        if (!host || !data) return;
        host.innerHTML = '';
        const dashboards = Array.isArray(data.dashboards) ? data.dashboards : [];
        syncFooterGridColumns(dashboards);
        if (!dashboards.length) {
            buildGrid(host, [], 'Sales Dashboard', {});
        } else {
            for (const dash of dashboards) {
                const label = dash?.state ? `${dash.state} Sales Dashboard` : 'Sales Dashboard';
                buildGrid(host, Array.isArray(dash?.combinedHourly) ? dash.combinedHourly : [], label, dash);
            }
        }
        renderOutstandingLists(data);
    }

    async function fetchAreaPayload(areaCode) {
        const res = await fetch(`/api/area-dashboard?area=${encodeURIComponent(areaCode)}`, {
            credentials: 'include',
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.error || 'Failed to load area dashboard');
        return data;
    }

    async function ensurePayload(areaCode) {
        const key = String(areaCode || '').trim();
        if (cachedPayload && cachedKey === key) return cachedPayload;
        cachedPayload = await fetchAreaPayload(key);
        cachedKey = key;
        return cachedPayload;
    }

    function invalidateCache() {
        cachedPayload = null;
        cachedKey = '';
    }

    async function show(areaCode) {
        const panel = document.getElementById('admin-area-view');
        if (!panel) return;
        const data = await ensurePayload(areaCode);
        renderPayload(data);
        panel.hidden = false;
        document.body.classList.add('admin-showing-area-totals');
        global.AdminStoreTabs?.setViewMode?.('area');
    }

    function hide() {
        const panel = document.getElementById('admin-area-view');
        if (panel) panel.hidden = true;
        document.body.classList.remove('admin-showing-area-totals');
        global.AdminStoreTabs?.setViewMode?.('store');
    }

    function preload(areaCode) {
        ensurePayload(areaCode).catch(() => {});
    }

    global.AdminAreaPanel = { show, hide, preload, renderPayload, invalidateCache };
})(window);
