function shellPathname() {
    const raw = window.__SHELL_ROUTE__?.pathname ?? window.location.pathname;
    return String(raw).split('?')[0].split('#')[0];
}

function isMicOverviewPath() {
    return /^\/overview\/?$/i.test(shellPathname());
}

function canMaintainMicStoreOverview() {
    if (!isMicOverviewPath()) return false;
    if (window.__APP_SHELL__ && window.AppShell?.matchRoute) {
        return window.AppShell.matchRoute(shellPathname())?.id === 'overview';
    }
    return true;
}

let STORE_NUMBER = (shellPathname().match(/^\/MIC\/(teststore|\d{3,6})\/?$/i) || [])[1] || '';

function getAppRoot() {
    return document.getElementById('app');
}

const app = getAppRoot();
const REFRESH_MS = 2 * 60 * 1000;
const SCRAPE_POLL_MS = 15 * 1000;
const TIME_ZONE = 'Australia/Melbourne';
const MULTIPLIER_NOTHING_LABEL = 'Nothing Yet...';

let micData = null;
let pickerOpen = false;
let pickerEscHandler = null;
let micCanViewAdminAuditSummary = false;
const STOCK_LEVELS_MODE_KEY = 'stockLevelsCheckMode';
let stockLevelsCheckMode = (() => {
    try {
        const saved = sessionStorage.getItem(STOCK_LEVELS_MODE_KEY);
        return saved === 'on-hand-only' ? 'on-hand-only' : 'with-on-order';
    } catch {
        return 'with-on-order';
    }
})();

function formatSalesScrapeHint(status) {
    if (!status) return { text: '', title: '' };
    const tz = status.timeZone || TIME_ZONE;
    const parts = [];
    if (status.credentialedStores != null) {
        parts.push(`${status.storesWithSalesData ?? 0}/${status.credentialedStores} stores with live sales`);
    }
    if (status.deferred) parts.push('MMX busy, scrape queued');
    if (status.inFlight) parts.push('Scrape in progress');
    if (status.salesUpdatedAt) {
        try {
            const when = new Date(status.salesUpdatedAt).toLocaleString('en-AU', {
                timeZone: tz,
                hour: '2-digit',
                minute: '2-digit',
                hour12: false,
            });
            parts.push(`Last scrape ${when}`);
        } catch {
            parts.push(`Last scrape ${status.salesUpdatedAt}`);
        }
    } else if (!status.inFlight) {
        parts.push('No successful scrape yet today');
    }
    const title = parts.join(' · ');
    if (status.inFlight) return { text: 'Sales · updating', title };
    if (!status.salesUpdatedAt) return { text: 'Sales · n/a', title };
    try {
        const time = new Date(status.salesUpdatedAt).toLocaleTimeString('en-AU', {
            timeZone: tz,
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
        });
        return { text: `Sales · ${time}`, title };
    } catch {
        return { text: 'Sales · n/a', title };
    }
}

function updateSalesScrapeHint(status) {
    const el = document.getElementById('mic-sales-scrape-hint');
    if (!el) return;
    const { text, title } = formatSalesScrapeHint(status);
    el.textContent = text;
    el.title = title;
    el.hidden = !text;
    el.classList.toggle('is-updating', Boolean(status?.inFlight));
}

async function pollSalesScrapeStatus() {
    if (!canMaintainMicStoreOverview()) return;
    try {
        const res = await fetch('/api/admin/overview/status', { credentials: 'same-origin' });
        const data = await res.json();
        if (!res.ok || !data.success) return;
        updateSalesScrapeHint(data);
    } catch {
        /* ignore */
    }
}

const MIC_LAST_STORE_KEY = 'mic-last-store';
const MIC_OVERVIEW_SCOPE_NAV_KEY = 'mic-overview-show-scope-nav';

const MOS = () => window.MicOverviewShell;
const MOT = () => window.MicOverviewTiles;

const VOC_PLACEHOLDER = MOT()?.VOC_PLACEHOLDER ?? { count: 'TBD', osatPercent: null, accuracyPercent: null };

function formatVocDisplay(voc = {}) {
    return MOT()?.formatVocDisplay?.(voc) ?? voc;
}

function formatMoney(value) {
    return MOT()?.formatMoney?.(value) ?? `$${Number(value) || 0}`;
}

function escapeHtml(value) {
    return MOS()?.escapeHtml?.(value) ?? String(value ?? '');
}

function formatTime(date) {
    return MOS()?.formatTime?.(date) ?? date.toLocaleTimeString();
}

function applyDashboardScale() {
    window.MicOverviewScale?.apply?.();
}

function formatSssgDisplay(value) {
    return MOT()?.formatSssgDisplay?.(value) ?? { text: '-', toneClass: 'mic-sssg--na' };
}

function renderPromoBanner() {
    return MOS()?.renderPromoBanner?.() ?? '';
}

function renderShell() {
    if (!canMaintainMicStoreOverview()) return;
    MOS()?.mountShell?.(app, {
        subtitle: STORE_NUMBER ? `Store ${STORE_NUMBER}` : 'Overview',
        promoBannerHtml: renderPromoBanner(),
    });
}

function isMicMobileView() {
    return MOS()?.isMicMobileView?.() ?? window.matchMedia('(max-width: 900px)').matches;
}

function syncMicLayoutMode() {
    return MOS()?.syncMicLayoutMode?.() ?? isMicMobileView();
}

function renderMicTabPanel(tabId, content) {
    return MOT()?.renderMicTabPanel?.(tabId, content) ?? content;
}

function renderSssgTile(sales = {}, options = {}) {
    return MOT()?.renderSssgTile?.(sales, options) ?? '';
}

function renderVocTile(voc, options = {}) {
    return MOT()?.renderVocTile?.(voc, options) ?? '';
}

function applyMicOverviewTab(tabId) {
    MOS()?.applyMicOverviewTab?.(tabId);
}

function syncSalesHourlyScroll() {
    MOS()?.syncSalesHourlyScroll?.();
}

function syncMicOverviewTabs(mobile) {
    MOS()?.syncMicOverviewTabs?.(mobile);
}

function renderBlankTile(options = {}) {
    return MOT()?.renderBlankTile?.(options) ?? '';
}

function renderAdminLabelTile(options = {}) {
    return MOT()?.renderAdminLabelTile?.(options) ?? '';
}

function renderEqualWidthRow(tileHtmlList, options = {}) {
    return MOT()?.renderEqualWidthRow?.(tileHtmlList, options) ?? tileHtmlList.filter(Boolean).join('');
}

let micSalesFetchInFlight = false;
let salesWaitPollTimer = null;
let micOverviewIntervals = [];
let micOverviewResizeHandler = null;

function stopMicStoreOverviewLoops() {
    for (const id of micOverviewIntervals) {
        window.clearInterval(id);
    }
    micOverviewIntervals = [];
    if (salesWaitPollTimer) {
        window.clearInterval(salesWaitPollTimer);
        salesWaitPollTimer = null;
    }
    if (micOverviewResizeHandler) {
        window.removeEventListener('resize', micOverviewResizeHandler);
        micOverviewResizeHandler = null;
    }
}

function signalLoginPreloadReady(phase) {
    window.DashboardPreloadBridge?.signalReady?.(phase);
}

function salesHasMeaningfulTable(sales = {}) {
    if (!sales || typeof sales !== 'object') return false;
    const resolved = window.MicMiniDashboard?.resolveHourly?.(sales);
    if (resolved?.actuals?.length || resolved?.forecasts?.length) {
        const actualSum = (resolved.actuals || []).reduce((sum, v) => sum + (Number(v) || 0), 0);
        const forecastSum = (resolved.forecasts || []).reduce((sum, v) => sum + (Number(v) || 0), 0);
        return actualSum > 0 || forecastSum > 0;
    }
    return Number(sales.actual) > 0 || Number(sales.forecast) > 0;
}

function salesPlaceholderState(sales = {}) {
    if (micSalesFetchInFlight || sales.pending) return { show: true, animated: true };
    if (salesHasMeaningfulTable(sales)) return null;
    return { show: true, animated: true };
}

function renderSalesTileLoadingBody() {
    if (window.LoadingDots?.tileBody) {
        return window.LoadingDots.tileBody({ animated: true });
    }
    return `<div class="mic-sales-tile-loading" role="status" aria-live="polite" aria-busy="true">
        <div class="loading-dots loading-dots--md mic-sales-tile-loading__dots" aria-hidden="true">
            <span class="loading-dots__dot" aria-hidden="true"></span>
            <span class="loading-dots__dot" aria-hidden="true"></span>
            <span class="loading-dots__dot" aria-hidden="true"></span>
        </div>
        <p class="mic-sales-tile-loading__message">Waiting for sales data</p>
    </div>`;
}

function syncSalesWaitPolling() {
    const waiting = salesPlaceholderState(micData?.salesToday)?.show;
    if (waiting && !salesWaitPollTimer) {
        salesWaitPollTimer = window.setInterval(() => {
            if (!salesPlaceholderState(micData?.salesToday)?.show) {
                window.clearInterval(salesWaitPollTimer);
                salesWaitPollTimer = null;
                return;
            }
            void loadMicData();
        }, SCRAPE_POLL_MS);
    } else if (!waiting && salesWaitPollTimer) {
        window.clearInterval(salesWaitPollTimer);
        salesWaitPollTimer = null;
    }
}

function renderSalesStack(sales) {
    if (salesPlaceholderState(sales)?.show) {
        return '<div class="mic-store-lead-sales-stack mic-store-lead-sales-stack--pending" aria-hidden="true"></div>';
    }
    const actual = Number(sales?.actual) || 0;
    const forecast = Number(sales?.forecast) || 0;
    const progress = sales?.progress || {};
    const paceClass = progress.paceClass || 'cell-green';
    const outcomeClass = progress.outcomeClass || paceClass;
    const timeFill = window.SalesProgress?.paceFillPercentFromProgress?.(progress) ?? 0;
    const layers =
        window.SalesProgress?.buildLiveProgressLayersHtml?.(timeFill, outcomeClass, paceClass) ||
        window.SalesProgress?.buildPaceStripHtml?.(timeFill, paceClass) ||
        '';
    const amounts =
        sales?.hours > 0
            ? `${formatMoney(actual)} / ${formatMoney(forecast)}`
            : 'Waiting for sales data';
    return `
        <div class="mic-store-lead-sales-stack">
            <div class="mic-store-lead-pace-band mic-store-lead-pace-band--with-amounts">
                ${layers}
                <span class="mic-store-lead-pace-amounts">${escapeHtml(amounts)}</span>
            </div>
        </div>
    `;
}

function renderSssgInlineBlock(sales = {}) {
    const today = formatSssgDisplay(sales.sssgPercent);
    const wtd = formatSssgDisplay(sales.sssgWtdPercent);
    const hasData = today.text !== '-' || wtd.text !== '-';
    return `
        <div class="mic-sssg-inline${hasData ? '' : ' mic-sssg-inline--future'}" aria-label="Same store sales growth">
            <div class="mic-sssg-inline-label">Today SSSG</div>
            <div class="mic-sssg-value ${today.toneClass}">${escapeHtml(today.text)}</div>
            <div class="mic-sssg-wtd ${wtd.toneClass}">WTD ${escapeHtml(wtd.text)}</div>
        </div>
    `;
}

/*
function renderMultiplierBlock(data) {
    const rules =
        data?.dailyItemMultipliers || (data?.dailyItemMultiplier ? [data.dailyItemMultiplier] : []);
    const hasRules = rules.length > 0;
    const rule = hasRules ? rules[0] : null;
    const pts = rule
        ? (Number(rule.basePoints) || 0) * (Number(rule.multiplier) || 3)
        : 0;
    const soldCount = rule?.soldCount;
    const soldHtml = hasRules
        ? `<div class="mic-multiplier-pick-sold"><span class="mic-multiplier-pick-sold-num">${soldCount == null ? '-' : soldCount}</span><span class="mic-multiplier-pick-sold-label">sold today</span></div>`
        : '';

    return `
        <button type="button" class="mic-multiplier-pick${hasRules ? ' mic-multiplier-pick--active' : ''}" id="mic-multiplier-tile">
            <span class="mic-multiplier-pick-kicker">Daily item multipliers</span>
            <span class="mic-multiplier-pick-body">
                ${
                    hasRules
                        ? `<span class="mic-multiplier-pick-item">${escapeHtml(rule.itemLabel)}</span>
                           <span class="mic-multiplier-pick-badge">${rule.multiplier}× · ${pts} pts</span>
                           ${soldHtml}`
                        : `<span class="mic-multiplier-pick-idle">${escapeHtml(micData?.multiplierNothingLabel || MULTIPLIER_NOTHING_LABEL)}</span>
                           <span class="mic-multiplier-pick-hint">Tap to choose today's 3× item</span>`
                }
            </span>
            <span class="mic-multiplier-pick-action">${hasRules ? 'Tap to change' : 'Tap to choose'}</span>
        </button>
    `;
}
*/

function salesShellForMiniGrid(sales = {}) {
    if (!salesPlaceholderState(sales)?.show) return sales;
    const resolved = window.MicMiniDashboard?.resolveHourly?.(sales);
    if (resolved?.actuals?.length || resolved?.forecasts?.length) return sales;
    const openHour = Number.isFinite(sales.openHour) ? sales.openHour : 10;
    const closeHour = Number.isFinite(sales.closeHour) ? sales.closeHour : 22;
    const hourCount = Math.max(0, closeHour - openHour);
    if (!hourCount) return sales;
    const zeros = Array(hourCount).fill(0);
    return {
        ...sales,
        openHour,
        closeHour,
        hours: hourCount,
        actualHourly:
            Array.isArray(sales.actualHourly) && sales.actualHourly.length ? sales.actualHourly : zeros,
        forecastHourly:
            Array.isArray(sales.forecastHourly) && sales.forecastHourly.length ? sales.forecastHourly : zeros,
    };
}

function renderMiniDashboard(sales) {
    const shellSales = salesShellForMiniGrid(sales);
    const mobile = isMicMobileView();
    if (mobile) {
        const totalsHtml = window.MicMiniDashboard?.renderMobileMealTotals?.(shellSales) || '';
        const hourlyHtml =
            window.MicMiniDashboard?.renderMobileHourlyWindow?.(shellSales, { allHours: true }) || '';
        if (!totalsHtml && !hourlyHtml && salesPlaceholderState(sales)?.show) {
            return `<div class="mic-mini-dashboard mic-mini-dashboard--loading">${renderSalesTileLoadingBody()}</div>`;
        }
        return `
            <div class="mic-mini-dashboard mic-mini-dashboard--mobile">
                ${totalsHtml}
                ${hourlyHtml}
                <a class="mic-store-lead-dashboard-link mic-store-lead-dashboard-link--plain mic-meal-dashboard-link" href="${escapeHtml(window.AppPaths?.micStore?.(STORE_NUMBER) || `/MIC/${STORE_NUMBER}`)}">View full dashboard →</a>
            </div>
        `;
    }
    const gridHtml = window.MicMiniDashboard?.renderPortraitGrid?.(shellSales) || '';
    if ((!gridHtml || gridHtml.includes('mic-mini-dashboard-empty')) && salesPlaceholderState(sales)?.show) {
        return `<div class="mic-mini-dashboard mic-mini-dashboard--loading">${renderSalesTileLoadingBody()}</div>`;
    }
    const hourCount = window.MicMiniDashboard?.getTradingHourCount?.(shellSales) ?? 12;
    return `
        <div class="mic-mini-dashboard">
            <div
                class="dashboard-grid dashboard-grid--portrait dashboard-grid--mic-fill"
                style="--mic-hour-count: ${hourCount}"
                role="region"
                aria-label="Today's sales by hour"
            >
                ${gridHtml}
            </div>
        </div>
    `;
}

function refreshMiniDashboard() {
    if (!canMaintainMicStoreOverview()) return;
    if (!micData?.salesToday || salesPlaceholderState(micData.salesToday)?.show) return;
    const host = document.querySelector('.mic-mini-dashboard');
    if (!host) return;
    host.outerHTML = renderMiniDashboard(micData.salesToday);
    requestAnimationFrame(syncSalesHourlyScroll);
}

function renderMobileStoreLeadHeader(_sales, storeLabelHtml) {
    return `<div class="mic-store-lead-store-label mic-store-lead-store-label--mobile">${storeLabelHtml}</div>`;
}

function renderStoreSalesTile(data, { tabbed = false } = {}) {
    const sales = data?.salesToday || { actual: 0, forecast: 0 };
    const storeName = escapeHtml(data?.storeName || STORE_NUMBER);
    const storeLabel = data?.storeName && data.storeName !== STORE_NUMBER
        ? `${storeName} · ${escapeHtml(STORE_NUMBER)}`
        : storeName;
    const mobile = tabbed || isMicMobileView();
    const leadHeader = mobile
        ? renderMobileStoreLeadHeader(sales, storeLabel)
        : `<div class="mic-store-lead-store-label">${storeLabel}</div>`;
    const posClass = tabbed ? '' : ' mic-tile--pos-store-sales';
    return `
        <article class="mic-tile mic-tile--store-leaderboard${posClass}">
            <div class="mic-store-lead mic-store-lead--purple${mobile ? ' mic-store-lead--mobile' : ''}">
                ${leadHeader}
                <div class="mic-store-lead-sales">${renderSalesStack(sales)}</div>
            </div>
            <div class="mic-store-lead-list mic-store-lead-list--dashboard">
                ${renderMiniDashboard(sales)}
                ${mobile ? '' : `<a class="mic-store-lead-dashboard-link mic-store-lead-dashboard-link--plain" href="${escapeHtml(window.AppPaths?.micStore?.(STORE_NUMBER) || `/MIC/${STORE_NUMBER}`)}">Open full dashboard →</a>`}
            </div>
            ${mobile ? '' : renderSssgInlineBlock(sales)}
        </article>
    `;
}

function shouldShowDfscTile(data) {
    const dfsc = data?.dfsc;
    if (!dfsc) return false;
    return !(dfsc.amCompleted && dfsc.pmCompleted);
}

function shouldShowOrdersTile(data) {
    const sc = data?.stockCount || {};
    return Number(sc.pendingCount) > 0;
}

const PSI_AUDIT_LABEL = 'Period Safety Inspection';

function storeWeeklyAuditsForTiles(data) {
    const tiles = data?.weeklyAudits?.auditTiles;
    const list = Array.isArray(tiles) && tiles.length ? tiles : weeklyAuditFallbackTiles();
    const due = list.filter((audit) => !audit.done);
    const psi = list.find((audit) => audit.label === PSI_AUDIT_LABEL);
    if (psi && !due.some((audit) => audit.label === PSI_AUDIT_LABEL)) {
        return [...due, psi];
    }
    return due;
}

function dueSquareOneTiles(data) {
    const tiles = data?.squareOneTiles;
    if (!Array.isArray(tiles)) return [];
    return tiles.filter((tile) => !tile.done);
}

function renderSquareOneTile(tile, { tabbed = false } = {}) {
    const label = escapeHtml(tile?.tileLabel || tile?.label || 'Square One');
    const sub = escapeHtml(tile?.sub || (tile?.done ? 'Complete' : 'Due this week'));
    const adminHref = tacauditAdminHrefForAudit(tile?.label, tile?.areaId);
    const href =
        adminHref ||
        tile?.href ||
        (tile?.areaId && STORE_NUMBER ? `/${STORE_NUMBER}/square-one?area=${encodeURIComponent(tile.areaId)}` : '');
    const doneClass = tile?.done ? ' mic-tile--audit-complete' : ' mic-tile--audit-due';
    const body = `
            <div class="mic-tile-body">
                <div class="mic-tile-label">${label}</div>
                <div class="mic-tile-sub">${sub}</div>
            </div>`;
    if (href) {
        return `
        <a
            class="mic-tile mic-tile--link mic-tile--weekly-audit mic-tile--square-one${doneClass}"
            href="${escapeHtml(href)}"
            aria-label="${escapeHtml(`${tile?.label || label} - ${sub}`)}"
        >${body}
        </a>`;
    }
    return `<article class="mic-tile mic-tile--weekly-audit mic-tile--square-one${doneClass}">${body}</article>`;
}

function countMicContentRows(data) {
    let rows = 2;
    if (hasStoreMiddleExtras(data)) rows += 1;
    if (
        storeWeeklyAuditsForTiles(data).length > 0 ||
        dueSquareOneTiles(data).length > 0 ||
        tacauditStoreHubHref()
    ) {
        rows += 1;
    }
    return rows;
}

function tacauditStoreHubHref() {
    if (!STORE_NUMBER) return '';
    return window.AppPaths?.tacaudit?.(STORE_NUMBER) || `/${STORE_NUMBER}/tacaudit`;
}

function renderTacauditHubLink({ tabbed = false } = {}) {
    const href = tacauditStoreHubHref();
    if (!href) return '';
    const tabbedClass = tabbed ? ' mic-tacaudit-hub-link--tabbed' : '';
    return `<a class="mic-tacaudit-hub-link${tabbedClass}" href="${escapeHtml(href)}" aria-label="Go to TacAudit landing page">Go to TacAudit</a>`;
}

function renderDfscTile(data, { tabbed = false, inRow = false } = {}) {
    const dfsc = data?.dfsc;
    if (!dfsc || !shouldShowDfscTile(data)) return '';
    const adminHref =
        micCanViewAdminAuditSummary &&
        window.AppPaths?.tacauditAdminHub?.({ area: tacauditAdminAreaQuery() });
    const href = adminHref || dfsc.href || `/${STORE_NUMBER}/dfsc`;
    const sub = dfsc.subtext || 'AM pending · PM pending';
    const posClass = tabbed || inRow ? '' : ' mic-tile--pos-dfsc';
    return `
        <a
            class="mic-tile mic-tile--link${posClass}"
            href="${escapeHtml(href)}"
            aria-label="Daily Food Safety Check"
        >
            <div class="mic-tile-body">
                <div class="mic-tile-label">DFSC</div>
                <div class="mic-tile-sub">${escapeHtml(sub)}</div>
            </div>
        </a>
    `;
}

function ordersStoreDetail(entry) {
    const count = Number(entry?.pendingCount) || 0;
    if (count > 0) {
        return `${count} vendor${count === 1 ? '' : 's'} to count`;
    }
    return entry?.message || 'Open stock count';
}

const WEEKLY_AUDIT_FORM_ROUTES = {
    'Pest Walk': (store) => `/${store}/pest-walk`,
    'RGM Cleaning Checklist': (store) => `/${store}/rgm-cleaning`,
    'RGM cleaning': (store) => `/${store}/rgm-cleaning`,
    'Period Safety Inspection': (store) => `/${store}/psi`,
    PSI: (store) => `/${store}/psi`,
};

function tacauditAdminAreaQuery() {
    const fromPayload = String(micData?.areaName || '').trim();
    if (fromPayload) return fromPayload;
    const areas = micData?.accessibleAreas;
    if (Array.isArray(areas) && areas.length === 1) return String(areas[0]).trim();
    return '';
}

function tacauditAdminHrefForAudit() {
    if (!micCanViewAdminAuditSummary) return '';
    return window.AppPaths?.tacauditAdminHub?.({ area: tacauditAdminAreaQuery() }) || '';
}

function weeklyAuditHref(audit) {
    const label = String(audit?.label || audit?.tileLabel || '').trim();
    const adminHref = tacauditAdminHrefForAudit(label);
    if (adminHref) return adminHref;
    if (audit?.href) return String(audit.href);
    const route = WEEKLY_AUDIT_FORM_ROUTES[label];
    return route && STORE_NUMBER ? route(STORE_NUMBER) : '';
}

function weeklyAuditFallbackTiles() {
    return [
        { label: 'Pest Walk', tileLabel: 'Pest Walk', sub: 'Due this week', done: false },
        { label: 'RGM Cleaning Checklist', tileLabel: 'RGM cleaning', sub: 'Due this week', done: false },
        { label: 'Period Safety Inspection', tileLabel: 'PSI', sub: 'Due this week', done: false },
    ];
}

function renderWeeklyAuditTile(audit, index, { tabbed = false } = {}) {
    const label = escapeHtml(audit?.tileLabel || audit?.label || 'Audit');
    const sub = escapeHtml(audit?.sub || (audit?.done ? 'Complete' : 'Due this week'));
    const href = weeklyAuditHref(audit);
    const doneClass = audit?.done ? ' mic-tile--audit-complete' : ' mic-tile--audit-due';
    const body = `
            <div class="mic-tile-body">
                <div class="mic-tile-label">${label}</div>
                <div class="mic-tile-sub">${sub}</div>
            </div>`;
    if (href) {
        return `
        <a
            class="mic-tile mic-tile--link mic-tile--weekly-audit${doneClass}"
            href="${escapeHtml(href)}"
            aria-label="${escapeHtml(`${audit?.label || label} - ${sub}`)}"
        >${body}
        </a>`;
    }
    return `<article class="mic-tile mic-tile--weekly-audit${doneClass}">${body}</article>`;
}

function renderWeeklyAuditTiles(data, { tabbed = false, rowNum = 2, includeHub = false } = {}) {
    const squareDue = dueSquareOneTiles(data);
    const weekly = storeWeeklyAuditsForTiles(data);
    const tiles = [
        ...squareDue.slice(0, 2).map((tile) => renderSquareOneTile(tile, { tabbed })),
        ...weekly.map((audit, index) => renderWeeklyAuditTile(audit, index, { tabbed })),
    ];
    const hub = includeHub ? renderTacauditHubLink({ tabbed }) : '';
    if (!tiles.length && !hub) return '';
    if (tabbed) {
        const row = tiles.length ? renderEqualWidthRow(tiles, { tabbed: true }) : '';
        return `${row}${hub}`;
    }
    if (includeHub) {
        const colCount = tiles.length || 1;
        const auditRow = tiles.length
            ? `<div class="mic-tacaudit-access-audits mic-grid-equal-row mic-grid-equal-row--cols-${colCount}">${tiles.join('')}</div>`
            : '';
        return `<div class="mic-tacaudit-access mic-grid-equal-row--row-${rowNum} mic-tile--pos-weekly-audit-row">${auditRow}${hub}</div>`;
    }
    if (!tiles.length) return '';
    return renderEqualWidthRow(tiles, {
        rowNum,
        extraClass: 'mic-tile--pos-weekly-audit-row',
    });
}

function renderOrdersToPlaceTile(data, { tabbed = false, inRow = false } = {}) {
    const sc = data?.stockCount || {};
    const active = Boolean(sc.active);
    const ordersSub = active ? ordersStoreDetail(sc) : 'All orders are placed for today';
    const href = active ? sc.href || window.AppPaths?.micStore?.(STORE_NUMBER) || `/MIC/${STORE_NUMBER}` : '';
    const posClass = tabbed || inRow ? '' : ' mic-tile--pos-orders';
    const body = `
            <div class="mic-tile-body">
                <div class="mic-tile-label">Orders to place</div>
                <div class="mic-tile-sub">${escapeHtml(ordersSub)}</div>
            </div>`;
    if (href) {
        return `
        <a
            class="mic-tile mic-tile--link mic-tile--orders-to-place${posClass}"
            href="${escapeHtml(href)}"
            aria-label="${escapeHtml(`Orders to place - ${ordersSub}`)}"
        >${body}
        </a>`;
    }
    return `<article class="mic-tile mic-tile--orders-to-place${posClass}">${body}</article>`;
}

function formatStockDaysLeft(days) {
    const n = Number(days);
    if (!Number.isFinite(n)) return '-';
    return n < 10 ? `${n}d` : `${Math.round(n)}d`;
}

function buildMicStockShortfallListHtml(items) {
    const list = Array.isArray(items) ? items : [];
    if (!list.length) return '';
    const rows = list
        .map(
            (item) => `
        <li class="mic-tile-stock-item">
            <span class="mic-tile-stock-item-name" title="${escapeHtml(item.displayName || item.description || item.itemCode || '')}">${escapeHtml(item.displayName || item.description || item.itemCode || 'Item')}</span>
            <span class="mic-tile-stock-item-meta">${escapeHtml(formatStockDaysLeft(item.daysOfStock))}</span>
        </li>`
        )
        .join('');
    return `<ul class="mic-tile-stock-list" aria-label="Stock shortfalls">${rows}</ul>`;
}

function buildStockCheckTabsHtml(mode) {
    const tabs = [
        { id: 'with-on-order', label: 'On hand + on order' },
        { id: 'on-hand-only', label: 'Current on hand' },
    ];
    const buttons = tabs
        .map((tab) => {
            const active = mode === tab.id ? ' is-active' : '';
            const ariaSelected = mode === tab.id ? 'true' : 'false';
            return `<button type="button" class="app-tab${active}" data-stock-check-mode="${tab.id}" role="tab" aria-selected="${ariaSelected}">${escapeHtml(tab.label)}</button>`;
        })
        .join('');
    return `<div class="app-tabs mic-tile-stock-check-tabs" role="tablist" aria-label="Stock levels view">${buttons}</div>`;
}

function renderStockLevelsTile(data, { tabbed = false, inRow = false } = {}) {
    const sc = data?.stockCount || {};
    const shortfallItems = Array.isArray(sc.lowStockItems) ? sc.lowStockItems : [];
    const hasShortfalls = Number(sc.lowStockCount) > 0;
    const stockSub =
        sc.stockLevelsSub ||
        (hasShortfalls
            ? `${sc.lowStockCount} item${sc.lowStockCount === 1 ? '' : 's'} under stock warning`
            : sc.stockLevelsChecked
              ? 'No stock shortfalls'
              : 'Stock levels not checked today');
    const href = sc.stockLevelsHref || (STORE_NUMBER ? `/${STORE_NUMBER}/stock-count/levels` : '');
    const warnClass = hasShortfalls ? ' mic-tile--stock-warn' : sc.stockLevelsChecked ? ' mic-tile--stock-ok' : '';
    const listClass = hasShortfalls && shortfallItems.length ? ' mic-tile--has-stock-list' : '';
    const posClass = tabbed || inRow ? '' : ' mic-tile--pos-stock-levels';
    const checkMode = stockLevelsCheckMode;
    const shortfallListHtml = hasShortfalls ? buildMicStockShortfallListHtml(shortfallItems) : '';
    const viewLink =
        sc.stockLevelsChecked && href
            ? `<a class="mic-tile-stock-view" href="${escapeHtml(href)}">${escapeHtml(hasShortfalls ? 'View shortfalls' : 'View stock levels')}</a>`
            : '';
    return `
        <article class="mic-tile mic-tile--stock-levels${warnClass}${listClass}${posClass}">
            <div class="mic-tile-body">
                <div class="mic-tile-label">Stock levels</div>
                <div class="mic-tile-sub">${escapeHtml(stockSub)}</div>
                ${shortfallListHtml}
            </div>
            ${buildStockCheckTabsHtml(checkMode)}
            ${viewLink}
        </article>`;
}

// Switch the tile between the two pre-computed stock-levels results (no Macromatix download).
// The daily stock-levels job computes both modes; this just fetches the already-computed summary for the mode.
async function switchStockLevelsMode(mode) {
    const next = mode === 'on-hand-only' ? 'on-hand-only' : 'with-on-order';
    if (next === stockLevelsCheckMode) return;
    stockLevelsCheckMode = next;
    try {
        sessionStorage.setItem(STOCK_LEVELS_MODE_KEY, stockLevelsCheckMode);
    } catch {
        /* ignore */
    }
    await patchStockLevelsForMode();
    if (micData) renderTiles(micData);
}

function bindStockLevelsCheck() {
    document.querySelectorAll('[data-stock-check-mode]').forEach((btn) => {
        btn.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            const mode = btn.getAttribute('data-stock-check-mode');
            if (!mode) return;
            void switchStockLevelsMode(mode);
        });
    });
}

async function patchStockLevelsForMode() {
    if (!STORE_NUMBER || !micData?.stockCount) return;
    const onHandOnly = stockLevelsCheckMode === 'on-hand-only';
    try {
        const res = await fetch(
            `/api/stock-count/low-stock-summary?store=${encodeURIComponent(STORE_NUMBER)}&onHandOnly=${onHandOnly ? '1' : '0'}`,
            { credentials: 'same-origin', headers: { Accept: 'application/json' } }
        );
        const summary = await res.json().catch(() => ({}));
        if (!res.ok || !summary.success) return;
        micData.stockCount = {
            ...micData.stockCount,
            lowStockCount: summary.lowStockCount,
            lowStockItems: summary.lowStockAlerts || summary.lowStockItems || [],
            stockLevelsChecked: summary.stockLevelsChecked,
            stockLevelsCheckedAt: summary.stockLevelsCheckedAt,
            stockLevelsSub: summary.stockLevelsSub,
            stockLevelsOnHandOnly: Boolean(summary.onHandOnly),
        };
    } catch {
        /* keep overview defaults */
    }
}

function renderDailyCountTile(data, { tabbed = false, inRow = false } = {}) {
    const dc = data?.dailyStockCount || {};
    if (!dc.configured) return '';
    const sub = dc.sub || dc.message || 'Open daily count';
    const href = dc.href || `/${STORE_NUMBER}/daily-stock-count`;
    const posClass = tabbed || inRow ? '' : ' mic-tile--pos-daily-count';
    const body = `
            <div class="mic-tile-body">
                <div class="mic-tile-label">Daily count</div>
                <div class="mic-tile-sub">${escapeHtml(sub)}</div>
            </div>`;
    if (dc.clickable && href) {
        return `
        <a
            class="mic-tile mic-tile--link mic-tile--daily-count${posClass}"
            href="${escapeHtml(href)}"
            aria-label="${escapeHtml(`Daily count - ${sub}`)}"
        >${body}
        </a>`;
    }
    return `<article class="mic-tile mic-tile--daily-count${posClass}">${body}</article>`;
}

function renderSquareOneMiddleTile(data, { inRow = false } = {}) {
    const due = dueSquareOneTiles(data);
    if (due.length >= 2) return '';
    if (due.length === 1) return renderSquareOneTile(due[0], { tabbed: false });
    const all = data?.squareOneTiles || [];
    if (all.length && all.every((t) => t.done)) {
        return renderAdminLabelTile({
            label: 'Square One',
            sub: 'Complete this week',
            posClass: 'mic-tile--pos-square-one',
            inRow,
        });
    }
    const squareHref =
        tacauditAdminHrefForAudit('Square One') || (STORE_NUMBER ? `/${STORE_NUMBER}/square-one` : '');
    return renderAdminLabelTile({
        label: 'Square One',
        sub: 'Due this week',
        posClass: 'mic-tile--pos-square-one',
        inRow,
        href: squareHref,
    });
}

function renderOpenActionsTile(data, { tabbed = false, inRow = false } = {}) {
    const hub = tacauditStoreHubHref();
    if (!hub || !STORE_NUMBER) return '';
    const summary = data?.actionsSummary || { open: 0, overdue: 0, dueSoon: 0 };
    const open = Number(summary.open) || 0;
    const overdue = Number(summary.overdue) || 0;
    const href = `${hub}/actions`;
    const posClass = tabbed || inRow ? '' : ' mic-tile--pos-open-actions';
    const alertClass = overdue > 0 ? ' mic-tile--actions-overdue' : '';
    const sub =
        open === 0 ? 'All complete' : overdue > 0 ? `${overdue} overdue` : `${summary.dueSoon || 0} due soon`;
    const body = `
            <div class="mic-tile-body">
                <div class="mic-tile-label">Open actions</div>
                <div class="mic-tile-metric">${open}</div>
                <div class="mic-tile-sub">${escapeHtml(sub)}</div>
            </div>`;
    return `<a class="mic-tile mic-tile--link${posClass}${alertClass}" href="${escapeHtml(href)}" aria-label="Open actions - ${open}">${body}</a>`;
}

function renderCoreCountdownTile({ tabbed = false, inRow = false } = {}) {
    return window.CoreCountdown?.renderTileHtml?.({ tabbed, inRow }) || '';
}

function hasStoreMiddleExtras(data) {
    const voc = formatVocDisplay(data?.voc || {});
    if (shouldShowDfscTile(data) && renderVocTile(voc, { inRow: true })) return true;
    if (renderOpenActionsTile(data, { inRow: true })) return true;
    if (renderSquareOneMiddleTile(data, { inRow: true })) return true;
    if (shouldShowOrdersTile(data)) return true;
    return false;
}

function renderStoreQuadGrid(data) {
    const voc = formatVocDisplay(data?.voc || {});
    const leftTop = renderDfscTile(data, { inRow: true }) || renderVocTile(voc, { inRow: true });
    const leftBottom = renderCoreCountdownTile({ inRow: true });
    const right = renderStockLevelsTile(data, { inRow: true });
    if (!leftTop && !leftBottom && !right) return '';
    const slot = (className, html) => (html ? `<div class="mic-store-quad-grid__slot ${className}">${html}</div>` : '');
    return `
        <div class="mic-store-quad-grid" aria-label="Store overview tiles">
            ${slot('mic-store-quad-grid__slot--left-top', leftTop)}
            ${slot('mic-store-quad-grid__slot--left-bottom', leftBottom)}
            ${slot('mic-store-quad-grid__slot--right', right)}
        </div>`;
}

function renderDesktopMiddleRow(data) {
    const tiles = [];
    const voc = formatVocDisplay(data?.voc || {});
    if (shouldShowDfscTile(data)) {
        const vocTile = renderVocTile(voc, { inRow: true });
        if (vocTile) tiles.push(vocTile);
    }
    tiles.push(renderOpenActionsTile(data, { inRow: true }), renderSquareOneMiddleTile(data, { inRow: true }));
    if (shouldShowOrdersTile(data)) {
        tiles.push(renderOrdersToPlaceTile(data, { inRow: true }));
    }
    const filtered = tiles.filter(Boolean);
    if (!filtered.length) return '';
    return renderEqualWidthRow(filtered, { rowNum: 'extras', extraClass: 'mic-tile--pos-middle-row' });
}

function renderMobileOrdersTab(data) {
    const tiles = [];
    if (shouldShowOrdersTile(data)) {
        tiles.push(renderOrdersToPlaceTile(data, { tabbed: true }));
    }
    tiles.push(renderStockLevelsTile(data, { tabbed: true }));
    return renderEqualWidthRow(tiles, { tabbed: true });
}

function renderMobileAuditsTab(data) {
    const parts = [];
    const actionsHtml = renderOpenActionsTile(data, { tabbed: true });
    if (actionsHtml) parts.push(actionsHtml);
    const dfscHtml = renderDfscTile(data, { tabbed: true });
    if (dfscHtml) parts.push(dfscHtml);
    parts.push(renderWeeklyAuditTiles(data, { tabbed: true, includeHub: true }));
    return parts.filter(Boolean).join('');
}

function renderDesktopTiles(data) {
    const extras = hasStoreMiddleExtras(data);
    return `
        ${renderStoreSalesTile(data)}
        ${renderStoreQuadGrid(data)}
        ${renderDesktopMiddleRow(data)}
        ${renderWeeklyAuditTiles(data, { includeHub: true, rowNum: extras ? 3 : 2 })}
    `;
}

function renderMobileTabbedTiles(data) {
    const voc = formatVocDisplay(data?.voc || {});
    const tabbed = true;
    return `
        ${renderMicTabPanel('sales', renderStoreSalesTile(data, { tabbed }))}
        ${renderMicTabPanel(
            'results',
            `
            ${renderVocTile(voc, { tabbed })}
            ${renderCoreCountdownTile({ tabbed: true })}
            ${renderSssgTile(data?.salesToday || {}, { tabbed })}
        `
        )}
        ${renderMicTabPanel('orders', renderMobileOrdersTab(data))}
        ${renderMicTabPanel('audits', renderMobileAuditsTab(data))}
    `;
}

function renderTiles(data) {
    const grid = document.getElementById('mic-grid');
    if (!grid) return;
    const mobile = isMicMobileView();

    syncMicOverviewTabs(mobile);
    grid.classList.toggle('mic-grid--tabbed', mobile);
    if (!mobile) {
        grid.style.setProperty('--mic-content-rows', String(countMicContentRows(data)));
    } else {
        grid.style.removeProperty('--mic-content-rows');
    }
    grid.innerHTML = mobile ? renderMobileTabbedTiles(data) : renderDesktopTiles(data);
    window.CoreCountdown?.refreshTiles?.();
    window.CoreCountdown?.startTick?.();

    bindStockLevelsCheck();

    if (mobile) {
        applyMicOverviewTab(MOS()?.getActiveTab?.() || 'sales');
        requestAnimationFrame(syncSalesHourlyScroll);
    }

    /*
    const multiplierTile = document.getElementById('mic-multiplier-tile');
    if (multiplierTile) {
        multiplierTile.addEventListener('click', openItemPicker);
    }
    */
}

/*
function pickerItems() {
    return (micData?.items || []).filter((item) => !/\bbox\b/i.test(String(item?.label || '')));
}

function openItemPicker() {
    if (pickerOpen) return;
    pickerOpen = true;
    const picker = document.getElementById('mic-item-picker');
    const list = document.getElementById('mic-item-list');
    if (!picker || !list) return;
    const items = pickerItems();
    const nothingOption = `
        <button type="button" class="mic-item-option mic-item-option--none" data-clear="true">
            Nothing
            <span class="mic-item-option-points">No multiplier today</span>
        </button>
    `;
    list.innerHTML = items.length
        ? `${nothingOption}${items
              .map(
                  (item) => `
            <button type="button" class="mic-item-option" data-item="${encodeURIComponent(item.label)}">
                ${escapeHtml(item.label)}
                <span class="mic-item-option-points">${item.basePoints} pts normally</span>
            </button>
        `
              )
              .join('')}`
        : `${nothingOption}<p class="mic-tile-sub">No upsell items configured in .points yet.</p>`;
    picker.hidden = false;
    list.querySelectorAll('.mic-item-option').forEach((button) => {
        button.addEventListener('click', async () => {
            if (button.dataset.clear === 'true') {
                await clearDailyMultiplier();
            } else {
                const itemLabel = decodeURIComponent(button.dataset.item || '');
                await setDailyMultiplier(itemLabel);
            }
            closeItemPicker();
        });
    });
    pickerEscHandler = (e) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            closeItemPicker();
        }
    };
    document.addEventListener('keydown', pickerEscHandler);
}

function closeItemPicker() {
    const picker = document.getElementById('mic-item-picker');
    if (!picker) return;
    if (pickerEscHandler) {
        document.removeEventListener('keydown', pickerEscHandler);
        pickerEscHandler = null;
    }
    picker.classList.add('is-closing');
    window.setTimeout(() => {
        picker.hidden = true;
        picker.classList.remove('is-closing');
        pickerOpen = false;
    }, 350);
}

async function setDailyMultiplier(itemLabel) {
    const res = await fetch('/api/mic/daily-item-multiplier', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ store: STORE_NUMBER, itemLabel }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success) {
        throw new Error(data.error || 'Could not set multiplier.');
    }
    await loadMicData();
}

async function clearDailyMultiplier() {
    const res = await fetch('/api/mic/daily-item-multiplier', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ store: STORE_NUMBER, clear: true }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success) {
        throw new Error(data.error || 'Could not clear multiplier.');
    }
    await loadMicData();
}
*/

async function enrichMicSalesHourly(data) {
    const sales = data?.salesToday || {};
    const resolved = window.MicMiniDashboard?.resolveHourly?.(sales);
    if (resolved?.forecasts?.length || resolved?.actuals?.length) {
        if (!sales.actualHourly?.length && !sales.forecastHourly?.length) {
            data.salesToday = {
                ...sales,
                actualHourly: resolved.actuals,
                forecastHourly: resolved.forecasts,
                hours: Math.max(resolved.actuals.length, resolved.forecasts.length) || sales.hours,
            };
        }
        return data;
    }

    const trim = window.MicMiniDashboard?.trimHourlyToTradingWindow;
    const rawActual = Array.isArray(sales.rawActual) ? sales.rawActual : [];
    const rawForecast = Array.isArray(sales.rawForecast) ? sales.rawForecast : [];
    if (trim && (rawActual.length || rawForecast.length)) {
        const trimmed = trim(
            rawActual,
            rawForecast,
            sales.openHour,
            sales.closeHour
        );
        if (trimmed.actual.length || trimmed.forecast.length) {
            data.salesToday = {
                ...sales,
                rawActual,
                rawForecast,
                actualHourly: trimmed.actual,
                forecastHourly: trimmed.forecast,
                hours: Math.max(trimmed.actual.length, trimmed.forecast.length) || sales.hours,
            };
            return data;
        }
    }

    try {
        const res = await fetch(`/api/sales?store=${encodeURIComponent(STORE_NUMBER)}`, {
            credentials: 'same-origin',
        });
        const slice = await res.json();
        if (!res.ok || !slice.success) return data;
        const trim = window.MicMiniDashboard?.trimHourlyToTradingWindow;
        const trimmed = trim
            ? trim(slice.actual, slice.forecast, slice.openHour ?? sales.openHour, slice.closeHour ?? sales.closeHour)
            : { actual: [], forecast: [] };
        if (!trimmed.actual.length && !trimmed.forecast.length) return data;
        data.salesToday = {
            ...sales,
            openHour: slice.openHour ?? sales.openHour,
            closeHour: slice.closeHour ?? sales.closeHour,
            timeZone: slice.timeZone ?? sales.timeZone,
            rawActual: slice.actual,
            rawForecast: slice.forecast,
            actualHourly: trimmed.actual,
            forecastHourly: trimmed.forecast,
            hours: Math.max(trimmed.actual.length, trimmed.forecast.length) || sales.hours,
        };
    } catch {
        /* keep totals-only payload */
    }
    return data;
}

function buildPlaceholderMicData() {
    const openHour = 10;
    const closeHour = 22;
    const hourCount = closeHour - openHour;
    const zeros = Array(hourCount).fill(0);
    return {
        success: true,
        storeNumber: STORE_NUMBER,
        storeName: micData?.storeName || '',
        salesToday: {
            actual: 0,
            forecast: 0,
            hours: hourCount,
            openHour,
            closeHour,
            actualHourly: zeros,
            forecastHourly: zeros,
            pending: true,
        },
        voc: { placeholder: true, ...VOC_PLACEHOLDER },
        stockCount: {
            active: false,
            message: 'All orders are placed for today',
            stockLevelsSub: 'Stock levels not checked today',
        },
        dailyStockCount: { configured: false, message: 'No daily items tagged yet' },
        weeklyAudits: { auditTiles: weeklyAuditFallbackTiles() },
        squareOneTiles: [{ label: 'Square One', tileLabel: 'Square One', done: false, sub: 'Due this week' }],
        actionsSummary: { open: 0, overdue: 0, dueSoon: 0 },
    };
}

function renderPlaceholderTiles() {
    if (!canMaintainMicStoreOverview()) return;
    if (!document.getElementById('mic-grid')) renderShell();
    micData = buildPlaceholderMicData();
    const label = document.getElementById('mic-store-label');
    if (label) {
        label.textContent = micData.storeName
            ? `${micData.storeName} · ${STORE_NUMBER}`
            : `Store ${STORE_NUMBER}`;
    }
    const grid = document.getElementById('mic-grid');
    if (grid) grid.classList.remove('mic-grid--loading');
    renderTiles(micData);
    syncSalesWaitPolling();
}

function bindMicStoreSettings(me) {
    window.MicSettings?.bind?.({
        getViewAccountsOptions: () => ({ storeNumber: STORE_NUMBER }),
        storeNumber: STORE_NUMBER || '',
        resolveAdminMenuVisibility: false,
        onReportEmailSaved: (email) => {
            if (micData) micData.reportEmail = email;
        },
    });
    window.AdminMenu?.bind?.({
        getViewAccountsOptions: () => ({ storeNumber: STORE_NUMBER }),
    });
    window.AdminAccounts?.maybeOpenFromQuery?.();
    window.MicSettings?.initPreferences?.();
}

function persistMicOverview(data) {
    if (!STORE_NUMBER || !data?.success) return;
    window.DashboardDataCache?.writeOverview?.(STORE_NUMBER, data);
    try {
        sessionStorage.setItem(MIC_LAST_STORE_KEY, STORE_NUMBER);
    } catch {
        /* ignore */
    }
}

function restoreCachedMicOverview() {
    if (!canMaintainMicStoreOverview()) return false;
    if (!STORE_NUMBER) return false;
    const entry = window.DashboardDataCache?.readOverview?.(STORE_NUMBER);
    if (!entry?.data || !window.DashboardDataCache?.hasMeaningfulMicOverview?.(entry.data)) return false;

    micData = entry.data;
    const label = document.getElementById('mic-store-label');
    if (label) {
        label.textContent = micData.storeName
            ? `${micData.storeName} · ${STORE_NUMBER}`
            : `Store ${STORE_NUMBER}`;
    }
    if (!document.getElementById('mic-grid')) renderShell();
    renderTiles(micData);
    updateSalesScrapeHint({
        inFlight: true,
        salesUpdatedAt: entry.data.salesToday?.updatedAt || entry.data.timestamp || null,
        timeZone: entry.data.salesToday?.timeZone || TIME_ZONE,
    });
    signalLoginPreloadReady('content');
    return true;
}

let micDataLoadPromise = null;

async function loadMicData() {
    if (!canMaintainMicStoreOverview()) return null;
    if (micDataLoadPromise) return micDataLoadPromise;
    micDataLoadPromise = loadMicDataInner().finally(() => {
        micDataLoadPromise = null;
    });
    return micDataLoadPromise;
}

async function loadMicDataInner() {
    if (!canMaintainMicStoreOverview()) return;
    const storeParam = STORE_NUMBER ? `?store=${encodeURIComponent(STORE_NUMBER)}` : '';
    const showingMeaningfulSales = salesHasMeaningfulTable(micData?.salesToday);
    micSalesFetchInFlight = true;
    try {
        if (!showingMeaningfulSales) {
            micData = {
                ...(micData || buildPlaceholderMicData()),
                salesToday: {
                    ...(micData?.salesToday || {}),
                    actual: 0,
                    forecast: 0,
                    hours: 0,
                    pending: true,
                },
            };
            if (!document.getElementById('mic-grid')) renderShell();
            renderTiles(micData);
        }
        const res = await fetch(`/api/overview${storeParam}`, {
            credentials: 'same-origin',
        });
        if (!canMaintainMicStoreOverview()) return;
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) {
            if (!micData && canMaintainMicStoreOverview()) {
                app.textContent = data.error || 'Could not load MIC overview.';
            }
            return;
        }
        micData = await enrichMicSalesHourly(data);
        if (!canMaintainMicStoreOverview()) return;
        if (micData.salesToday && 'pending' in micData.salesToday) {
            const { pending, ...salesToday } = micData.salesToday;
            micData.salesToday = salesToday;
        }
        persistMicOverview(micData);
        updateSalesScrapeHint(data.salesScrapeStatus);
        window.MicSettings?.setStoreContext?.({
            storeNumber: STORE_NUMBER || '',
            reportEmail: micData.reportEmail || '',
        });
        const label = document.getElementById('mic-store-label');
        if (label) {
            label.textContent = micData.storeName
                ? `${micData.storeName} · ${STORE_NUMBER}`
                : `Store ${STORE_NUMBER}`;
        }
        if (!document.getElementById('mic-grid')) renderShell();
        const grid = document.getElementById('mic-grid');
        if (grid) grid.classList.remove('mic-grid--loading');
        renderTiles(micData);
        if (salesHasMeaningfulTable(micData?.salesToday)) {
            signalLoginPreloadReady('content');
        }
        void patchStockLevelsForMode().then(() => {
            if (canMaintainMicStoreOverview() && micData) renderTiles(micData);
        });
    } finally {
        micSalesFetchInFlight = false;
        syncSalesWaitPolling();
        if (salesPlaceholderState(micData?.salesToday)?.show && canMaintainMicStoreOverview()) {
            renderTiles(micData);
        }
    }
}

async function resolveMicStoreNumber() {
    if (STORE_NUMBER) return STORE_NUMBER;
    if (!isMicOverviewPath()) return '';
    try {
        const res = await fetch('/api/me', { credentials: 'same-origin' });
        if (!res.ok) return '';
        const me = await res.json();
        const stores = me.stores === '*' ? [] : Array.isArray(me.stores) ? me.stores.map(String) : [];
        if (stores.length === 1) return stores[0].toLowerCase();
        const fromUser = String(me.username || '').match(/(\d{3,6})/);
        if (fromUser) return fromUser[1].toLowerCase();
    } catch {
        /* ignore */
    }
    return '';
}

async function fetchMeProfile() {
    try {
        const controller = new AbortController();
        const timeoutId = window.setTimeout(() => controller.abort(), 15000);
        const res = await fetch('/api/me', {
            credentials: 'same-origin',
            signal: controller.signal,
        });
        window.clearTimeout(timeoutId);
        if (!res.ok) return null;
        const data = await res.json();
        return data.success !== false ? data : null;
    } catch (err) {
        console.error('[MIC overview] Could not load profile:', err);
        return null;
    }
}

function clearBrokenStoreViewMode() {
    try {
        sessionStorage.removeItem('admin-view-as-store-enabled');
        sessionStorage.removeItem('admin-view-as-store');
    } catch {
        /* ignore */
    }
}

function readMicLastStore() {
    try {
        return String(sessionStorage.getItem(MIC_LAST_STORE_KEY) || '').toLowerCase();
    } catch {
        return '';
    }
}

/** @returns {boolean|null} true = area/market, false = store, null = unknown */
function readOverviewScopeNavHint() {
    try {
        const value = sessionStorage.getItem(MIC_OVERVIEW_SCOPE_NAV_KEY);
        if (value === null || value === '') return null;
        return value === '1';
    } catch {
        return null;
    }
}

function writeOverviewScopeNavHint(showScopeNav) {
    try {
        sessionStorage.setItem(MIC_OVERVIEW_SCOPE_NAV_KEY, showScopeNav ? '1' : '0');
    } catch {
        /* ignore */
    }
}

function isAdminViewAsStoreActive() {
    try {
        if (sessionStorage.getItem('admin-view-as-store-enabled') !== '1') return false;
        return Boolean(String(sessionStorage.getItem('admin-view-as-store') || '').trim());
    } catch {
        return false;
    }
}

function resolveEarlyStoreNumber() {
    if (isAdminViewAsStoreActive()) {
        try {
            return String(sessionStorage.getItem('admin-view-as-store') || '').toLowerCase();
        } catch {
            return '';
        }
    }
    return readMicLastStore();
}

function shouldPaintSingleStoreEarly() {
    if (isAdminViewAsStoreActive()) return true;
    const scopeHint = readOverviewScopeNavHint();
    if (scopeHint === true) return false;
    if (scopeHint === false) return Boolean(readMicLastStore());
    return false;
}

function shouldPaintMultiStoreEarly() {
    if (isAdminViewAsStoreActive()) return false;
    const scopeHint = readOverviewScopeNavHint();
    if (scopeHint === false) return false;
    return true;
}

function resolveStoreForUserProfile(me) {
    const viewAs = window.AdminStoreView?.resolveStoreForOverview?.(me) || '';
    if (viewAs) return String(viewAs).toLowerCase();
    const scope = me?.overviewScope || 'store';
    if (scope !== 'store') return '';
    const stores = me.stores === '*' ? [] : Array.isArray(me.stores) ? me.stores.map(String) : [];
    if (stores.length === 1) return stores[0].toLowerCase();
    const fromUser = String(me.username || '').match(/(\d{3,6})/);
    if (fromUser) return fromUser[1].toLowerCase();
    return '';
}

function paintOverviewShellEarly() {
    if (!app || !isMicOverviewPath()) return false;
    if (!shouldPaintSingleStoreEarly()) return false;
    const earlyStore = resolveEarlyStoreNumber();
    if (!earlyStore) return false;
    STORE_NUMBER = earlyStore;
    app.classList.remove('app-boot-loading');
    app.removeAttribute('aria-busy');
    renderShell();
    if (!restoreCachedMicOverview()) renderPlaceholderTiles();
    void loadMicData();
    signalLoginPreloadReady('shell');
    return true;
}

/** Paint multi-store chrome before /api/me returns (admins / area managers). */
function paintMultiOverviewShellEarly() {
    if (!app || !isMicOverviewPath()) return false;
    if (!shouldPaintMultiStoreEarly()) return false;
    if (document.getElementById('mic-grid')) return true;
    if (!window.MicOverviewShell?.mountShell) return false;
    window.MicOverviewShell.mountShell(app, {
        subtitle: 'Overview',
        promoBannerHtml: window.MicOverviewShell.renderPromoBanner?.() || '',
    });
    window.MicOverviewMulti?.paintCachedOrLoadingGrid?.();
    signalLoginPreloadReady('shell');
    return true;
}

function prefetchOverviewPayload() {
    return fetch('/api/overview', { credentials: 'same-origin' })
        .then(async (res) => {
            const data = await res.json().catch(() => null);
            if (!res.ok || !data?.success) return null;
            return data;
        })
        .catch(() => null);
}

async function initStoreOverview(me, { skipShell = false } = {}) {
    if (!STORE_NUMBER && isMicOverviewPath()) {
        STORE_NUMBER = await resolveMicStoreNumber();
    }
    if (!STORE_NUMBER) {
        if (!canMaintainMicStoreOverview()) return;
        app.textContent = 'Invalid store.';
        return;
    }
    window.MicOverviewScale?.bind?.();
    MOS()?.setOnMobileLayoutChange?.(() => {
        if (micData) renderTiles(micData);
    });
    if (!skipShell) {
        renderShell();
        signalLoginPreloadReady('shell');
        bindMicStoreSettings(me);
        const hadCachedOverview = restoreCachedMicOverview();
        if (!hadCachedOverview) renderPlaceholderTiles();
    }
    syncMicLayoutMode();
    if (!micCanViewAdminAuditSummary) {
        const profile = me || (await fetchMeProfile());
        micCanViewAdminAuditSummary = Boolean(profile?.canViewCrossStoreAccounts);
        me = profile;
    }
    if (skipShell) {
        bindMicStoreSettings(me);
    }
    window.AdminStoreView?.afterShellRendered?.(me);
    if (!skipShell || !micDataLoadPromise) {
        loadMicData();
    }
    void window.CoreCountdown?.init?.();
    stopMicStoreOverviewLoops();
    micOverviewIntervals.push(
        window.setInterval(() => {
            if (!canMaintainMicStoreOverview()) return;
            const clock = document.getElementById('mic-clock');
            if (clock) clock.textContent = formatTime(new Date());
        }, 1000)
    );
    micOverviewIntervals.push(window.setInterval(refreshMiniDashboard, 60 * 1000));
    micOverviewIntervals.push(window.setInterval(loadMicData, REFRESH_MS));
    micOverviewIntervals.push(window.setInterval(pollSalesScrapeStatus, SCRAPE_POLL_MS));
    syncSalesWaitPolling();
    if (micOverviewResizeHandler) {
        window.removeEventListener('resize', micOverviewResizeHandler);
    }
    micOverviewResizeHandler = () => {
        if (!canMaintainMicStoreOverview()) return;
        syncMicLayoutMode();
        requestAnimationFrame(syncSalesHourlyScroll);
    };
    window.addEventListener('resize', micOverviewResizeHandler);
}

async function init() {
    if (!app) {
        console.error('[MIC overview] #app element missing');
        return;
    }
    try {
        const overviewPaintedEarly = paintOverviewShellEarly();
        const multiPaintedEarly = !overviewPaintedEarly && paintMultiOverviewShellEarly();
        // Overlap profile + overview fetch so multi-store users get data sooner.
        const mePromise = fetchMeProfile();
        const overviewPrefetchPromise =
            multiPaintedEarly || (!overviewPaintedEarly && isMicOverviewPath())
                ? prefetchOverviewPayload()
                : Promise.resolve(null);
        const me = await mePromise;
        if (!me) {
            if (window.__APP_SHELL__ && !canMaintainMicStoreOverview()) return;
            app.textContent = 'Could not load your profile. Redirecting to sign in…';
            window.location.href = '/login';
            return;
        }
        writeOverviewScopeNavHint(Boolean(me.layoutCapabilities?.showScopeNav));
        await window.AdminStoreView?.init?.(me);

        if (!isMicOverviewPath()) {
            if (window.__APP_SHELL__) {
                return;
            }
            await initStoreOverview(me);
            return;
        }

        let viewAs = window.AdminStoreView?.resolveStoreForOverview?.(me) || '';

        if (window.AdminStoreView?.isEnabled?.() && !viewAs) {
            clearBrokenStoreViewMode();
            viewAs = '';
        }

        if (me.layoutCapabilities?.showScopeNav && !viewAs) {
            try {
                sessionStorage.removeItem(MIC_LAST_STORE_KEY);
            } catch {
                /* ignore */
            }
            if (!window.MicOverviewMulti?.start) {
                throw new Error('Overview scripts failed to load. Hard refresh the page (Ctrl+Shift+R).');
            }
            void window.MicOverviewMulti.start(me, app, renderPromoBanner(), {
                prefetchedOverview: overviewPrefetchPromise,
            });
            window.AdminStoreView?.afterShellRendered?.(me);
            return;
        }
        const resolvedStore = viewAs || resolveStoreForUserProfile(me);
        if (resolvedStore) STORE_NUMBER = String(resolvedStore).toLowerCase();
        const canReuseEarlyPaint =
            overviewPaintedEarly && STORE_NUMBER && STORE_NUMBER === resolveEarlyStoreNumber();
        await initStoreOverview(me, { skipShell: canReuseEarlyPaint });
    } catch (err) {
        console.error('[MIC overview] Init failed:', err);
        if (!canMaintainMicStoreOverview()) return;
        app.textContent = err?.message || 'Could not load MIC overview.';
    }
}

window.MicOverviewView = {
    async mount() {
        await init();
    },
    unmount() {
        stopMicStoreOverviewLoops();
        window.MicOverviewMulti?.stop?.();
        MOS()?.unmountPageClasses?.();
        const root = getAppRoot();
        if (root) root.innerHTML = '';
    },
};

if (!window.__APP_SHELL__) {
    init();
}
