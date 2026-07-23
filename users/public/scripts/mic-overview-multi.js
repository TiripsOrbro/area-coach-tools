/**
 * Area / market scoped MIC overview - used by mic-dashboard.js for non-store scopes.
 */
(function (global) {
    const REFRESH_MS = 2 * 60 * 1000;
    const SCRAPE_POLL_MS = 15 * 1000;
    const TIME_ZONE = 'Australia/Melbourne';
    const DEFAULT_AREA = 'VIC-1';
    const DAILY_COUNT_STORE_KEY = 'daily-count-store';
    const LOADING_AUDIT_TILE_COUNT = 4;

    const MOS = () => global.MicOverviewShell;
    const MOT = () => global.MicOverviewTiles;

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

    function formatSssgDisplay(value) {
        return MOT()?.formatSssgDisplay?.(value) ?? { text: '-', toneClass: 'mic-sssg--na' };
    }

    function isMicMobileView() {
        return MOS()?.isMicMobileView?.() ?? global.matchMedia('(max-width: 900px)').matches;
    }

    function syncMicLayoutMode() {
        return MOS()?.syncMicLayoutMode?.() ?? isMicMobileView();
    }

    function renderMicTabPanel(tabId, content) {
        return MOT()?.renderMicTabPanel?.(tabId, content) ?? content;
    }

    function applyMicOverviewTab(tabId) {
        MOS()?.applyMicOverviewTab?.(tabId);
    }

    function syncMicOverviewTabs(mobile) {
        MOS()?.syncMicOverviewTabs?.(mobile);
    }

    function renderEqualWidthRow(tileHtmlList, options = {}) {
        return MOT()?.renderEqualWidthRow?.(tileHtmlList, options) ?? tileHtmlList.filter(Boolean).join('');
    }

    function renderLoadingPlaceholderTile() {
        return MOT()?.renderLoadingPlaceholderTile?.() ?? '';
    }

    function renderLoadingPlaceholderTiles(count) {
        return MOT()?.renderLoadingPlaceholderTiles?.(count) ?? '';
    }

    let app = null;
    let meProfile = null;
    let overviewData = null;
    let dfscStatus = null;
    let areaIndex = 0;
    let areaPickerActive = false;
    let pendingAreaName = '';
    let lastSalesUpdatedAt = null;
    let overviewLoadInFlight = false;
    let intervals = [];

    function shellPathname() {
        const raw = global.__SHELL_ROUTE__?.pathname ?? global.location.pathname;
        return String(raw).split('?')[0].split('#')[0];
    }

    function canMaintainMicOverview() {
        if (!/^\/overview\/?$/i.test(shellPathname())) return false;
        if (global.__APP_SHELL__ && global.AppShell?.matchRoute) {
            return global.AppShell.matchRoute(shellPathname())?.id === 'overview';
        }
        return true;
    }

    function normalizeAreaKey(value) {
        return String(value || '')
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/(^-|-$)/g, '');
    }

    function adminOverviewCacheKey(profile) {
        const scope = String(profile?.overviewScope || 'admin').toLowerCase();
        const areas = (profile?.accessibleAreas || [])
            .map((name) => String(name || '').trim().toLowerCase())
            .filter(Boolean)
            .sort()
            .join('|');
        return `${scope}:${areas || 'default'}`;
    }

    function buildPlaceholderAdminOverview(profile) {
        const areaNames = global.MicAreaPicker?.resolveInitialAreaNames?.(profile, null) || [];
        const names = areaNames.length ? areaNames : [DEFAULT_AREA];
        const areas = names.map((name) => {
            const trimmed = String(name || '').trim();
            return {
                name: trimmed,
                areaKey: normalizeAreaKey(trimmed),
                salesToday: { actual: 0, forecast: 0 },
                storeSales: [],
                auditTileSummaries: [],
                dailyStockCount: { configured: false },
            };
        });
        const vocByArea = areas.map((a) => ({
            name: a.name,
            areaKey: a.areaKey,
            ...VOC_PLACEHOLDER,
            placeholder: true,
        }));
        return {
            success: true,
            placeholder: true,
            areas,
            vocByArea,
            storesNeedingOrders: [],
        };
    }

    function restoreCachedAdminOverview() {
        if (!meProfile) return null;
        const entry = global.DashboardDataCache?.readAdminOverview?.(adminOverviewCacheKey(meProfile));
        if (!entry?.data || !global.DashboardDataCache?.hasMeaningfulAdminOverview?.(entry.data)) {
            return null;
        }
        return entry.data;
    }

    function persistAdminOverview(data) {
        if (!meProfile || !data?.success || data.placeholder) return;
        const cacheKey = adminOverviewCacheKey(meProfile);
        global.DashboardDataCache?.writeAdminOverview?.(cacheKey, data);
        global.DashboardDataCache?.rememberAdminOverviewKey?.(cacheKey);
    }

    function bindMicNavigationSettings() {
        global.MicSettings?.bind?.({
            getViewAccountsOptions: () => ({
                isAdmin: Boolean(meProfile?.canViewCrossStoreAccounts),
            }),
            resolveAdminMenuVisibility: !meProfile?.canAccessAdminMenu,
        });
        global.AdminMenu?.bind?.({
            getViewAccountsOptions: () => ({
                isAdmin: Boolean(meProfile?.canViewCrossStoreAccounts),
            }),
        });
        global.AdminAccounts?.maybeOpenFromQuery?.();
        global.MicSettings?.initPreferences?.();
    }

    function renderLoadingMarkHtml() {
        return global.LoadingDots?.html?.({ label: 'Loading sales data', size: 'lg' }) || '';
    }

    function renderLoadingOverlay() {
        const dots = renderLoadingMarkHtml();
        return `<div class="mic-grid-loading-overlay" aria-live="polite" aria-label="Loading sales data">${dots}</div>`;
    }

    function renderAreaSalesLoadingBody() {
        return (
            global.LoadingDots?.tileBody?.({ extraClass: 'mic-sales-tile-loading--area' }) ||
            `<div class="mic-sales-tile-loading mic-sales-tile-loading--area" role="status" aria-live="polite" aria-busy="true">
                <div class="loading-dots loading-dots--md mic-sales-tile-loading__dots" aria-hidden="true">
                    <span class="loading-dots__dot" aria-hidden="true"></span>
                    <span class="loading-dots__dot" aria-hidden="true"></span>
                    <span class="loading-dots__dot" aria-hidden="true"></span>
                </div>
                <p class="mic-sales-tile-loading__message">Waiting for sales data</p>
            </div>`
        );
    }

    function renderLoadingAreaStoresTile({ tabbed = false } = {}) {
        const posClass = tabbed ? '' : ' mic-tile--pos-area-stores';
        const mobileClass = tabbed ? ' mic-store-lead--mobile' : '';
        return `
        <article class="mic-tile mic-tile--store-leaderboard mic-tile--loading-skeleton${posClass}">
            <div class="mic-store-lead mic-store-lead--purple${mobileClass}">
                <div class="mic-store-lead-store-label">Sales</div>
                <div class="mic-store-lead-sales mic-store-lead-sales--pending" aria-hidden="true"></div>
            </div>
            <div class="mic-store-lead-list mic-store-lead-list--dashboard mic-store-lead-list--loading-sales">
                ${renderAreaSalesLoadingBody()}
            </div>
        </article>`;
    }

    function renderLoadingInteractiveTopRow() {
        return renderEqualWidthRow(
            [
                renderVocTile(VOC_PLACEHOLDER, { inRow: true }),
                renderLoadingPlaceholderTile(),
                renderCoreCountdownTile({ inRow: true }),
            ],
            { rowNum: 'top' }
        );
    }

    function renderLoadingDesktopTiles() {
        const topRow = renderLoadingInteractiveTopRow();
        const middleRow = renderEqualWidthRow(
            [renderLoadingPlaceholderTile(), renderLoadingPlaceholderTile()],
            { rowNum: 1, extraClass: 'mic-tile--pos-middle-row' }
        );
        const auditRow = renderEqualWidthRow(
            Array.from({ length: LOADING_AUDIT_TILE_COUNT }, () => renderLoadingPlaceholderTile()),
            { rowNum: 2, extraClass: 'mic-tile--pos-weekly-audit-row' }
        );
        return `${renderLoadingAreaStoresTile()}${topRow}${middleRow}${auditRow}`;
    }

    function loadingAreaNames() {
        return global.MicAreaPicker?.resolveInitialAreaNames?.(meProfile, overviewData?.areas) || [];
    }

    function areaLabel(value) {
        return global.AreaDisplay?.label?.(value) ?? String(value ?? '').trim();
    }

    function renderLoadingMobileTiles() {
        return `
        ${renderMicTabPanel('sales', renderLoadingAreaStoresTile({ tabbed: true }))}
        ${renderMicTabPanel(
            'results',
            `${renderVocTile(VOC_PLACEHOLDER, { tabbed: true })}${renderCoreCountdownTile({ tabbed: true })}`
        )}
        ${renderMicTabPanel('orders', renderLoadingPlaceholderTiles(2))}
        ${renderMicTabPanel('audits', renderLoadingPlaceholderTiles(3))}`;
    }

    function subtitleForScope() {
        const area = currentArea();
        if (area?.name) return areaLabel(area);
        const stored = pendingAreaName || global.MicAreaPicker?.getStoredArea?.() || '';
        if (stored) return areaLabel(stored);
        const scope = meProfile?.overviewScope;
        if (scope === 'area') {
            const areas = meProfile?.accessibleAreas;
            if (Array.isArray(areas) && areas.length === 1) return areaLabel(areas[0]);
        }
        const preliminary = loadingAreaNames();
        if (preliminary.length === 1) return areaLabel(preliminary[0]);
        if (preliminary.length > 1) return areaLabel(preliminary[areaIndex % preliminary.length]);
        return 'Overview';
    }

    function updateScopeSubtitle() {
        const label = document.getElementById('mic-store-label');
        if (label) label.textContent = subtitleForScope();
    }

    function applyAreaSelection(name) {
        const areas = overviewData?.areas || [];
        if (!areas.length) {
            pendingAreaName = String(name || '').trim();
            return;
        }
        const target = String(name || pendingAreaName || global.MicAreaPicker?.getStoredArea?.() || '').trim();
        if (target) {
            areaIndex = global.MicAreaPicker?.areaIndexForName?.(areas, target) ?? defaultAreaIndex(areas);
            pendingAreaName = target;
        }
        updateScopeSubtitle();
        renderTiles();
    }

    async function dismissAreaPickerWhenReady() {
        if (!areaPickerActive || !global.MicAreaPicker) return;
        await new Promise((resolve) => {
            global.requestAnimationFrame(() => global.requestAnimationFrame(resolve));
        });
        await global.MicAreaPicker.dismiss();
        areaPickerActive = false;
    }

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

    function sortStoresByNumber(stores) {
        return [...(stores || [])].sort((a, b) =>
            String(a.storeNumber).localeCompare(String(b.storeNumber), undefined, { numeric: true })
        );
    }

    function adminAreaSlug(area) {
        const key = String(area?.areaKey || '').trim().toLowerCase();
        if (key) return key;
        const fromPaths = global.AppPaths?.areaCodeFromName?.(area?.name);
        if (fromPaths) return fromPaths;
        const m = String(area?.name || '').match(/(\d+)/);
        if (!m) return '';
        const legacyMap = { 1: 'qld-1', 2: 'qld-1', 21: 'vic-1', 22: 'vic-1' };
        return legacyMap[Number(m[1])] || '';
    }

    function adminStoreSnapOptions(area) {
        return {
            storeBasePath: '/Admin',
            adminAreaCode: adminAreaSlug(area),
            adminAreaLinkOnly: true,
        };
    }

    function defaultAreaIndex(areas) {
        const list = areas || [];
        if (!list.length) return 0;
        const idx = list.findIndex((a) => String(a?.name || '').trim() === DEFAULT_AREA);
        return idx >= 0 ? idx : 0;
    }

    function currentArea() {
        const areas = overviewData?.areas || [];
        if (!areas.length) return null;
        return areas[areaIndex % areas.length];
    }

    function currentDisplayArea() {
        return currentArea();
    }

    function ordersForDisplay() {
        const all = overviewData?.storesNeedingOrders || [];
        const area = currentArea();
        if (!area) return [];
        const inArea = new Set((area.storeSales || []).map((s) => String(s.storeNumber).trim()).filter(Boolean));
        if (!inArea.size) {
            const key = area.areaKey;
            const name = area.name;
            return all.filter((s) => (key && s.areaKey === key) || (name && s.areaName === name));
        }
        return all.filter((s) => inArea.has(String(s.storeNumber).trim()));
    }

    function auditTilesForDisplay() {
        const area = currentArea();
        return area?.auditTileSummaries || [];
    }

    function currentVoc() {
        const list = overviewData?.vocByArea || [];
        if (!list.length) return null;
        return list[areaIndex % list.length];
    }

    function areaSssgToday(area) {
        const v = area?.sssgTodayPercent;
        if (v == null || Number.isNaN(Number(v))) return formatAreaSssgFromStores(area);
        return Number(v);
    }

    function areaSssgWtd(area) {
        const v = area?.sssgWtdPercent;
        return v == null || Number.isNaN(Number(v)) ? null : Number(v);
    }

    function formatAreaSssgFromStores(area) {
        const stores = Array.isArray(area?.storeSales) ? area.storeSales : [];
        const values = stores
            .map((s) => s.sssgPercent)
            .filter((v) => v != null && !Number.isNaN(Number(v)))
            .map((v) => Number(v));
        if (!values.length) return null;
        return Math.round((values.reduce((sum, v) => sum + v, 0) / values.length) * 10) / 10;
    }

    function renderAreaSalesTotal(sales) {
        const actual = Number(sales?.actual) || 0;
        const forecast = Number(sales?.forecast) || 0;
        const progress = sales?.progress || {};
        const paceClass = progress.paceClass || 'cell-green';
        const outcomeClass = progress.outcomeClass || paceClass;
        const timeFill = global.SalesProgress?.paceFillPercentFromProgress?.(progress) ?? 0;
        const layers =
            global.SalesProgress?.buildLiveProgressLayersHtml?.(timeFill, outcomeClass, paceClass) ||
            global.SalesProgress?.buildPaceStripHtml?.(timeFill, paceClass) ||
            '';
        return `
        <div class="mic-store-lead-sales-stack">
            <div class="mic-store-lead-total-amount">${formatMoney(actual)} / ${formatMoney(forecast)}</div>
            <div class="mic-store-lead-pace-band">${layers}</div>
        </div>`;
    }

    function areaRowCells(areas) {
        const last = areas.length - 1;
        const parts = [];
        areas.forEach((a, idx) => {
            const active = idx === areaIndex % areas.length;
            parts.push(
                `<button type="button" class="admin-area-text-tab${active ? ' is-active' : ''}" role="tab" aria-selected="${active}" data-area-index="${idx}">${escapeHtml(areaLabel(a))}</button>`
            );
            if (idx < last) parts.push('<span class="admin-area-text-pipe" aria-hidden="true"> |</span>');
        });
        return parts.join('');
    }

    function renderAreaTextSelector({ live = false } = {}) {
        const areas = overviewData?.areas || [];
        if (!areas.length) return '';
        const liveAttr = live ? ' aria-live="polite"' : '';
        return `
        <div class="admin-area-text-track" role="tablist"${liveAttr} data-area-count="${areas.length}">
            <div class="admin-area-text-row">${areaRowCells(areas)}</div>
        </div>`;
    }

    function setActiveAreaTab(track, index) {
        track.querySelectorAll('.admin-area-text-tab').forEach((tab, idx) => {
            const active = idx === index;
            tab.classList.toggle('is-active', active);
            tab.setAttribute('aria-selected', String(active));
        });
    }

    function applyAreaHighlight() {
        const track = document.querySelector('.admin-area-text-track');
        const areas = overviewData?.areas || [];
        if (!track || !areas.length) return;
        setActiveAreaTab(track, areaIndex % areas.length);
    }

    function renderAreaStoresTile(area, { tabbed = false } = {}) {
        const sales = area?.salesToday || { actual: 0, forecast: 0 };
        const rows =
            global.StoreSnapRow?.renderStoreSnapList?.(
                sortStoresByNumber(area?.storeSales),
                formatMoney,
                undefined,
                adminStoreSnapOptions(area)
            ) || '<p class="mic-store-lead-empty">No stores in this area yet.</p>';
        const posClass = tabbed ? '' : ' mic-tile--pos-area-stores';
        const mobileClass = tabbed ? ' mic-store-lead--mobile' : '';
        return `
        <article class="mic-tile mic-tile--store-leaderboard${posClass}">
            <div class="mic-store-lead mic-store-lead--purple${mobileClass}">
                ${renderAreaTextSelector({ live: true })}
                <div class="mic-store-lead-sales">${renderAreaSalesTotal(sales)}</div>
            </div>
            <div class="mic-store-lead-list${tabbed ? ' mic-store-lead-list--dashboard' : ''}" role="list">${rows}</div>
        </article>`;
    }

    function renderSssgTile(area, { tabbed = false } = {}) {
        return (
            MOT()?.renderSssgTile?.(area, {
                tabbed,
                todayValue: areaSssgToday(area),
                wtdValue: areaSssgWtd(area),
            }) ?? ''
        );
    }

    function useMicStyleTiles() {
        return false;
    }

    function renderVocTile(vocRaw, options = {}) {
        return MOT()?.renderVocTile?.(vocRaw, options) ?? '';
    }

    function dfscStoresForArea(area) {
        const stores = dfscStatus?.stores || [];
        if (!area) return [];
        const inArea = new Set((area.storeSales || []).map((s) => String(s.storeNumber).trim()).filter(Boolean));
        if (inArea.size) return stores.filter((s) => inArea.has(String(s.storeNumber).trim()));
        const key = area.areaKey || area.key;
        const name = String(area.name || '').trim();
        return stores.filter((s) => {
            const storeArea = String(s.area || '').trim();
            if (name && storeArea === name) return true;
            if (key && String(s.areaKey || '').trim() === String(key).trim()) return true;
            return false;
        });
    }

    function dfscSubtextForDisplay() {
        if (!dfscStatus?.stores) return 'Loading…';
        const area = useMicStyleTiles() ? null : currentArea();
        const rows = useMicStyleTiles() ? dfscStatus.stores : dfscStoresForArea(area);
        if (!rows.length) return 'No stores in this area';
        const amDone = rows.filter((r) => r.amCompleted).length;
        const pmDone = rows.filter((r) => r.pmCompleted).length;
        const inProgress = rows.filter((r) => r.inProgress).length;
        let text = `AM ${amDone}/${rows.length} · PM ${pmDone}/${rows.length}`;
        if (inProgress) text += ` · ${inProgress} in progress`;
        return text;
    }

    function renderDfscAdminTile({ tabbed = false, inRow = false } = {}) {
        const posClass = tabbed || inRow ? '' : ' mic-tile--pos-dfsc';
        const sub = escapeHtml(dfscSubtextForDisplay());
        const href = tacauditDfscAdminHref();
        const body = `
            <div class="mic-tile-body">
                <div class="mic-tile-label">DFSC</div>
                <div class="mic-tile-sub">${sub}</div>
            </div>`;
        if (href) {
            return `
        <a class="mic-tile mic-tile--link mic-tile--dfsc${posClass}" href="${escapeHtml(href)}" aria-label="DFSC - open TacAudit summary">${body}</a>`;
        }
        return `<article class="mic-tile mic-tile--dfsc${posClass}">${body}</article>`;
    }

    function renderAdminLabelTile({
        label,
        posClass,
        sub = 'Coming soon',
        tabbed = false,
        inRow = false,
        href = '',
    }) {
        const gridPos = tabbed || inRow ? '' : ` ${posClass}`;
        const body = `
            <div class="mic-tile-body">
                <div class="mic-tile-label">${escapeHtml(label)}</div>
                <div class="mic-tile-sub">${escapeHtml(sub)}</div>
            </div>`;
        if (href) {
            return `
        <a class="mic-tile mic-tile--link${gridPos}" href="${escapeHtml(href)}" aria-label="${escapeHtml(`${label} - ${sub}`)}">${body}</a>`;
        }
        return `<article class="mic-tile${gridPos}">${body}</article>`;
    }

    function dailyStockCountForDisplay() {
        const area = currentDisplayArea();
        return area?.dailyStockCount || {};
    }

    function dailyCountHrefForArea(dc) {
        let href = dc.href || '/daily-stock-count';
        try {
            const saved = sessionStorage.getItem('daily-count-store');
            if (saved && Array.isArray(dc.storeNumbers) && dc.storeNumbers.map(String).includes(saved)) {
                href = `/${saved}/daily-stock-count`;
            }
        } catch {
            /* ignore */
        }
        return href;
    }

    function adminUsesStorePicker(storeCount) {
        return Boolean(meProfile?.canViewCrossStoreAccounts) && Number(storeCount) !== 1;
    }

    function storeLabelFromOverview(storeNumber) {
        const num = String(storeNumber || '').trim();
        const areas = overviewData?.areas || [];
        for (const area of areas) {
            const match = (area.storeSales || []).find((s) => String(s.storeNumber).trim() === num);
            if (match?.storeName) return `${num} - ${match.storeName}`;
        }
        const order = (overviewData?.storesNeedingOrders || []).find((s) => String(s.storeNumber).trim() === num);
        if (order?.storeName) return `${num} - ${order.storeName}`;
        return num;
    }

    function openDailyCountStorePicker() {
        const dc = dailyStockCountForDisplay();
        const storeNumbers = (dc.storeNumbers || []).map((n) => String(n).trim()).filter(Boolean);
        if (!storeNumbers.length) return;
        if (storeNumbers.length === 1) {
            const store = storeNumbers[0].toLowerCase();
            try {
                sessionStorage.setItem(DAILY_COUNT_STORE_KEY, store);
            } catch {
                /* ignore */
            }
            global.location.assign(`/${store}/daily-stock-count`);
            return;
        }
        global.AdminStorePicker?.open({
            title: 'Select store',
            hint: 'Choose a store to start daily count.',
            options: storeNumbers.map((num) => ({
                id: num.toLowerCase(),
                label: storeLabelFromOverview(num),
            })),
            onPick: (store) => {
                try {
                    sessionStorage.setItem(DAILY_COUNT_STORE_KEY, store);
                } catch {
                    /* ignore */
                }
                global.location.assign(`/${store}/daily-stock-count`);
            },
        });
    }

    function openStockCountStorePicker() {
        const list = ordersForDisplay();
        if (!list.length) return;
        if (list.length === 1 && list[0]?.href) {
            global.location.assign(list[0].href);
            return;
        }
        global.AdminStorePicker?.open({
            title: 'Select store',
            hint: 'Choose a store to start stock count.',
            options: list.map((entry) => ({
                id: String(entry.storeNumber).toLowerCase(),
                label: entry.storeName ? `${entry.storeNumber} - ${entry.storeName}` : String(entry.storeNumber),
                sub: ordersStoreDetail(entry),
                href: entry.href,
            })),
            onPick: (_store, option) => {
                if (option?.href) global.location.assign(option.href);
            },
        });
    }

    function renderDailyCountTile({ tabbed = false, inRow = false } = {}) {
        const dc = dailyStockCountForDisplay();
        if (!dc.configured) return '';
        const sub = dc.sub || dc.message || 'Open daily count';
        const href = dailyCountHrefForArea(dc);
        const storeNumbers = (dc.storeNumbers || []).map((n) => String(n).trim()).filter(Boolean);
        const usePicker = adminUsesStorePicker(storeNumbers.length);
        const posClass = tabbed || inRow ? '' : ' mic-tile--pos-daily-count';
        const body = `
            <div class="mic-tile-body">
                <div class="mic-tile-label">Daily count</div>
                <div class="mic-tile-sub">${escapeHtml(sub)}</div>
            </div>`;
        if (dc.clickable && (href || usePicker)) {
            if (usePicker) {
                return `
        <button
            type="button"
            class="mic-tile mic-tile--link mic-tile--daily-count${posClass}"
            data-store-picker="daily-count"
            aria-label="${escapeHtml(`Daily count - ${sub}`)}"
        >${body}</button>`;
            }
            return `
        <a
            class="mic-tile mic-tile--link mic-tile--daily-count${posClass}"
            href="${escapeHtml(href)}"
            aria-label="${escapeHtml(`Daily count - ${sub}`)}"
        >${body}</a>`;
        }
        return `<article class="mic-tile mic-tile--daily-count${posClass}">${body}</article>`;
    }

    function ordersStoreDetail(entry) {
        const count = Number(entry?.pendingCount) || 0;
        if (count > 0) return `${count} vendor${count === 1 ? '' : 's'} to count`;
        return entry?.message || 'Open stock count';
    }

    function countAdminContentRows(auditTiles) {
        let rows = 2;
        if ((auditTiles || []).length > 0 || tacauditAdminHubHref()) rows += 1;
        return rows;
    }

    function tacauditAdminHubHref() {
        return (
            tacauditHrefForTile() ||
            global.AppPaths?.tacauditAdminHub?.({ area: tacauditAreaQuery() }) ||
            '/tacaudit/summary'
        );
    }

    function renderTacauditHubLink({ tabbed = false } = {}) {
        const href = tacauditAdminHubHref();
        if (!href) return '';
        const tabbedClass = tabbed ? ' mic-tacaudit-hub-link--tabbed' : '';
        return `<a class="mic-tacaudit-hub-link${tabbedClass}" href="${escapeHtml(href)}" aria-label="Go to TacAudit landing page">Go to TacAudit</a>`;
    }

    function formatStoreStatsSub(stats = {}) {
        const notStarted = Number(stats.notStarted) || 0;
        const inProgress = Number(stats.inProgress) || 0;
        const complete = Number(stats.completed) || 0;
        return [
            `${notStarted} store${notStarted === 1 ? '' : 's'} not started`,
            `${inProgress} store${inProgress === 1 ? '' : 's'} in progress`,
            `${complete} store${complete === 1 ? '' : 's'} complete`,
        ].join(' · ');
    }

    function auditStatLine(count, phrase) {
        const n = Number(count) || 0;
        return `${n} store${n === 1 ? '' : 's'} ${phrase}`;
    }

    function firstStoreNumberInDisplayScope() {
        const area = currentDisplayArea();
        const fromArea = sortStoresByNumber(area?.storeSales || [])
            .map((s) => String(s.storeNumber).trim())
            .filter(Boolean);
        if (fromArea.length) return fromArea[0].toLowerCase();
        for (const a of overviewData?.areas || []) {
            for (const s of sortStoresByNumber(a.storeSales || [])) {
                const n = String(s.storeNumber).trim();
                if (n) return n.toLowerCase();
            }
        }
        return '';
    }

    function tacauditAreaQuery() {
        return String(currentDisplayArea()?.name || overviewData?.areas?.[0]?.name || '').trim();
    }

    function tacauditHrefForTile() {
        if (!global.AppPaths?.tacauditAdminHub) return '';
        return global.AppPaths.tacauditAdminHub({
            area: tacauditAreaQuery(),
        });
    }

    function tacauditDfscAdminHref() {
        if (!global.AppPaths?.tacauditAdminHub) return '';
        return global.AppPaths.tacauditAdminHub({
            area: tacauditAreaQuery(),
        });
    }

    function auditStatTextScaleClass(notStarted, inProgress, complete) {
        const lines = [
            auditStatLine(notStarted, 'not started'),
            auditStatLine(inProgress, 'in progress'),
            auditStatLine(complete, 'complete'),
        ];
        const maxLen = Math.max(...lines.map((line) => line.length));
        if (maxLen > 24) return 'mic-audit-stat-scale--sm';
        if (maxLen > 19) return 'mic-audit-stat-scale--md';
        return 'mic-audit-stat-scale--lg';
    }

    function tileHasAuditStats(tile) {
        return tile?.stats && typeof tile.stats === 'object';
    }

    function aggregatedSquareOneStats(tiles) {
        const stats = { notStarted: 0, inProgress: 0, completed: 0 };
        for (const tile of allSquareOneAuditTiles(tiles)) {
            stats.notStarted += Number(tile.stats?.notStarted) || 0;
            stats.inProgress += Number(tile.stats?.inProgress) || 0;
            stats.completed += Number(tile.stats?.completed) || 0;
        }
        return stats;
    }

    function pickAdminAuditTilesForRow(tiles) {
        const all = tiles || [];
        const squareDue = all.filter((t) => t.kind === 'square-one' && !t.done);
        const weekly = all.filter((t) => t.kind === 'weekly');
        const weeklyDue = weekly.filter((t) => !t.done);
        const weeklyPick = weeklyDue.length ? weeklyDue : weekly;
        if (squareDue.length >= 2) {
            return [...squareDue.slice(0, 2), ...weeklyPick.slice(0, 2)];
        }
        return [...squareDue, ...weeklyPick].slice(0, 4);
    }

    function dueSquareOneAuditTiles(tiles) {
        return (tiles || []).filter((t) => t.kind === 'square-one' && !t.done);
    }

    function allSquareOneAuditTiles(tiles) {
        return (tiles || []).filter((t) => t.kind === 'square-one');
    }

    function renderSquareOneMiddleTileAdmin(tiles, { tabbed = false, inRow = false } = {}) {
        const due = dueSquareOneAuditTiles(tiles);
        if (due.length >= 2) return '';
        if (due.length === 1) {
            return renderAdminAuditTile(due[0], { tabbed, inRow });
        }
        const all = allSquareOneAuditTiles(tiles);
        if (all.length) {
            return renderAdminAuditTile(
                {
                    tileLabel: 'Square One',
                    kind: 'square-one',
                    stats: aggregatedSquareOneStats(tiles),
                    done: all.every((t) => t.done),
                },
                { tabbed, inRow }
            );
        }
        return '';
    }

    function shouldShowAdminOrdersTile() {
        if (!useMicStyleTiles()) return true;
        return ordersForDisplay().length > 0;
    }

    function renderOrdersSummaryTile({ tabbed = false, inRow = false } = {}) {
        const list = ordersForDisplay();
        const storeCount = list.length;
        const vendorCount = list.reduce((sum, row) => sum + (Number(row.pendingCount) || 0), 0);
        const active = storeCount > 0;
        const sub = active
            ? `${storeCount} store${storeCount === 1 ? '' : 's'} · ${vendorCount} vendor${vendorCount === 1 ? '' : 's'} to count`
            : 'All orders are placed for today';
        const posClass = tabbed || inRow ? '' : ' mic-tile--pos-orders';
        const stateClass = active ? ' mic-tile--orders-active' : ' mic-tile--orders-idle';
        const body = `
            <div class="mic-tile-body">
                <div class="mic-tile-label">Orders to place</div>
                <div class="mic-tile-sub">${escapeHtml(sub)}</div>
            </div>`;
        const usePicker = active && adminUsesStorePicker(storeCount);
        if (active && (usePicker || (storeCount === 1 && list[0]?.href))) {
            if (usePicker) {
                return `
        <button
            type="button"
            class="mic-tile mic-tile--link mic-tile--orders-to-place${stateClass}${posClass}"
            data-store-picker="stock-count"
            aria-label="${escapeHtml(`Orders to place - ${sub}`)}"
        >${body}</button>`;
            }
            return `
        <a
            class="mic-tile mic-tile--link mic-tile--orders-to-place${stateClass}${posClass}"
            href="${escapeHtml(list[0].href)}"
            aria-label="${escapeHtml(`Orders to place - ${sub}`)}"
        >${body}</a>`;
        }
        return `<article class="mic-tile mic-tile--orders-to-place${stateClass}${posClass}">${body}</article>`;
    }

    function renderAdminAuditTile(tile, { tabbed = false, inRow = false } = {}) {
        const label = escapeHtml(tile?.tileLabel || tile?.label || 'Audit');
        const plainLabel = tile?.tileLabel || tile?.label || 'Audit';
        const doneClass = tile?.done ? ' mic-tile--audit-complete' : ' mic-tile--audit-due';
        const kindClass = tile?.kind === 'square-one' ? ' mic-tile--square-one' : '';
        const gridPos = tabbed || inRow ? '' : '';
        const tacauditHref = tacauditHrefForTile(tile);
        const linkClass = tacauditHref ? ' mic-tile--link' : '';
        const tag = tacauditHref ? 'a' : 'article';
        const hrefAttr = tacauditHref ? ` href="${escapeHtml(tacauditHref)}"` : '';
        const ariaAttr = tacauditHref
            ? ` aria-label="${escapeHtml(`${plainLabel} - open TacAudit`)}"`
            : '';

        if (tileHasAuditStats(tile)) {
            const notStarted = Number(tile.stats.notStarted) || 0;
            const inProgress = Number(tile.stats.inProgress) || 0;
            const complete = Number(tile.stats.completed) || 0;
            const scaleClass = auditStatTextScaleClass(notStarted, inProgress, complete);
            return `
        <${tag} class="mic-tile mic-tile--weekly-audit mic-tile--audit-stats${kindClass}${doneClass}${linkClass}${gridPos}"${hrefAttr}${ariaAttr}>
            <div class="mic-tile-body mic-tile-body--audit-stats ${scaleClass}">
                <div class="mic-tile-label mic-tile-label--audit-stats">${label}</div>
                <div class="mic-audit-stat mic-audit-stat--not-started">
                    <span class="mic-audit-stat-line">${escapeHtml(auditStatLine(notStarted, 'not started'))}</span>
                </div>
                <div class="mic-audit-stat mic-audit-stat--in-progress">
                    <span class="mic-audit-stat-line">${escapeHtml(auditStatLine(inProgress, 'in progress'))}</span>
                </div>
                <div class="mic-audit-stat mic-audit-stat--complete">
                    <span class="mic-audit-stat-line">${escapeHtml(auditStatLine(complete, 'complete'))}</span>
                </div>
            </div>
        </${tag}>`;
        }

        const sub = escapeHtml(tile?.sub || (tile?.done ? 'Complete' : 'Due this week'));
        return `
        <${tag} class="mic-tile mic-tile--weekly-audit${kindClass}${doneClass}${linkClass}${gridPos}"${hrefAttr}${ariaAttr}>
            <div class="mic-tile-body">
                <div class="mic-tile-label">${label}</div>
                <div class="mic-tile-sub">${sub}</div>
            </div>
        </${tag}>`;
    }

    function renderAdminAuditTilesOnly(tiles, { tabbed = false, rowNum = 2, includeHub = false } = {}) {
        const picked = (tiles || []).map((tile) => renderAdminAuditTile(tile));
        const hub = includeHub ? renderTacauditHubLink({ tabbed }) : '';
        if (!picked.length && !hub) return '';
        if (tabbed) {
            const row = picked.length ? renderEqualWidthRow(picked, { tabbed: true }) : '';
            return `${row}${hub}`;
        }
        if (includeHub) {
            const colCount = picked.length || 1;
            const auditRow = picked.length
                ? `<div class="mic-tacaudit-access-audits mic-grid-equal-row mic-grid-equal-row--cols-${colCount}">${picked.join('')}</div>`
                : '';
            return `<div class="mic-tacaudit-access mic-grid-equal-row--row-${rowNum} mic-tile--pos-weekly-audit-row">${auditRow}${hub}</div>`;
        }
        if (!picked.length) return '';
        return renderEqualWidthRow(picked, {
            rowNum,
            extraClass: 'mic-tile--pos-weekly-audit-row',
        });
    }

    function renderCoreCountdownTile({ tabbed = false, inRow = false } = {}) {
        return global.CoreCountdown?.renderTileHtml?.({ tabbed, inRow }) || '';
    }

    function renderAdminTopRow(vocRaw) {
        const tiles = [
            renderVocTile(vocRaw, { inRow: true }),
            renderDfscAdminTile({ inRow: true }),
            renderCoreCountdownTile({ inRow: true }),
        ].filter(Boolean);
        if (!tiles.length) return '';
        return renderEqualWidthRow(tiles, { rowNum: 'top' });
    }

    function renderAdminMiddleRow({ tabbed = false } = {}) {
        const auditTiles = auditTilesForDisplay();
        const tiles = [];
        if (useMicStyleTiles()) {
            const squareTile = renderSquareOneMiddleTileAdmin(auditTiles, { tabbed, inRow: !tabbed });
            if (squareTile) tiles.push(squareTile);
        }
        tiles.push(renderDailyCountTile({ tabbed, inRow: !tabbed }));
        if (shouldShowAdminOrdersTile()) {
            tiles.push(renderOrdersSummaryTile({ tabbed, inRow: !tabbed }));
        }
        const filtered = tiles.filter(Boolean);
        if (!filtered.length) return '';
        if (tabbed) return renderEqualWidthRow(filtered, { tabbed: true });
        return renderEqualWidthRow(filtered, { rowNum: 1, extraClass: 'mic-tile--pos-middle-row' });
    }

    function renderMobileOrdersTab() {
        const tiles = [];
        if (shouldShowAdminOrdersTile()) {
            tiles.push(renderOrdersSummaryTile({ tabbed: true }));
        }
        tiles.push(renderDailyCountTile({ tabbed: true }));
        return renderEqualWidthRow(tiles.filter(Boolean), { tabbed: true });
    }

    function renderDesktopTiles() {
        const displayArea = currentDisplayArea();
        const vocRaw = useMicStyleTiles() ? VOC_PLACEHOLDER : currentVoc() || {};
        const auditTiles = auditTilesForDisplay();
        return `
        ${renderAreaStoresTile(displayArea)}
        ${renderAdminTopRow(vocRaw)}
        ${renderAdminMiddleRow()}
        ${renderAdminAuditTilesOnly(auditTiles, { includeHub: true })}`;
    }

    function renderMobileTabbedTiles() {
        const displayArea = currentDisplayArea();
        const vocRaw = useMicStyleTiles() ? VOC_PLACEHOLDER : currentVoc() || {};
        const auditTiles = auditTilesForDisplay();
        return `
        ${renderMicTabPanel('sales', renderAreaStoresTile(displayArea, { tabbed: true }))}
        ${renderMicTabPanel('results', `${renderVocTile(vocRaw, { tabbed: true })}${renderCoreCountdownTile({ tabbed: true })}${renderSssgTile(displayArea, { tabbed: true })}`)}
        ${renderMicTabPanel('orders', renderMobileOrdersTab())}
        ${renderMicTabPanel('audits', `${renderDfscAdminTile({ tabbed: true })}${renderAdminAuditTilesOnly(auditTiles, { tabbed: true, includeHub: true })}`)}`;
    }

    function bindStorePickerTiles() {
        const grid = document.getElementById('mic-grid');
        if (!grid) return;
        grid.querySelectorAll('[data-store-picker="daily-count"]').forEach((btn) => {
            btn.addEventListener('click', () => openDailyCountStorePicker());
        });
        grid.querySelectorAll('[data-store-picker="stock-count"]').forEach((btn) => {
            btn.addEventListener('click', () => openStockCountStorePicker());
        });
    }

    function bindTacauditTileLinks() {
        const grid = document.getElementById('mic-grid');
        if (!grid || grid.dataset.tacauditLinksBound === '1') return;
        grid.dataset.tacauditLinksBound = '1';
        grid.addEventListener('click', (event) => {
            const anchor = event.target.closest('a.mic-tile--link');
            if (!anchor) return;
            const href = anchor.getAttribute('href') || '';
            if (!/\/tacaudit\//i.test(href)) return;
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            if (!global.DashboardPageTransition?.navigateTo) return;
            event.preventDefault();
            global.DashboardPageTransition.navigateTo(anchor.href);
        });
    }

    function bindAreaTextSelector() {
        const grid = document.getElementById('mic-grid');
        if (!grid) return;
        grid.querySelectorAll('.admin-area-text-tab').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const idx = Number(btn.dataset.areaIndex);
                if (!Number.isFinite(idx)) return;
                areaIndex = idx;
                const areaName = overviewData?.areas?.[idx]?.name;
                if (areaName) global.MicAreaPicker?.setStoredArea?.(areaName);
                updateScopeSubtitle();
                renderTiles();
            });
        });
    }

    function renderTiles() {
        const grid = document.getElementById('mic-grid');
        if (!grid || !overviewData) return;
        const mobile = syncMicLayoutMode();
        syncMicOverviewTabs(mobile);
        grid.classList.toggle('mic-grid--tabbed', mobile);
        grid.classList.remove('mic-grid--loading');
        grid.setAttribute('aria-busy', overviewData.placeholder ? 'true' : 'false');
        const auditTiles = auditTilesForDisplay();
        if (!mobile) {
            grid.style.setProperty('--mic-content-rows', String(countAdminContentRows(auditTiles)));
        } else {
            grid.style.removeProperty('--mic-content-rows');
        }
        grid.innerHTML = mobile ? renderMobileTabbedTiles() : renderDesktopTiles();
        global.CoreCountdown?.refreshTiles?.();
        global.CoreCountdown?.startTick?.();
        bindStorePickerTiles();
        bindTacauditTileLinks();
        bindAreaTextSelector();
        applyAreaHighlight();
        if (mobile) applyMicOverviewTab(MOS()?.getActiveTab?.() || 'sales');
        loadDfscStatus();
    }

    function renderShell(promoBannerHtml) {
        if (!canMaintainMicOverview()) return;
        MOS()?.mountShell?.(app, {
            subtitle: subtitleForScope(),
            promoBannerHtml: promoBannerHtml || '',
        });
        global.AdminStoreView?.afterShellRendered?.(meProfile);
        bindMicNavigationSettings();
        renderTiles();
    }

    async function loadDfscStatus() {
        try {
            const res = await fetch('/api/admin/dfsc/status', { credentials: 'same-origin' });
            const data = await res.json();
            if (res.ok && data.success) {
                dfscStatus = data;
                const sub = document.querySelector('.mic-tile--dfsc .mic-tile-sub');
                if (sub) sub.textContent = dfscSubtextForDisplay();
            }
        } catch {
            /* ignore */
        }
    }

    function paintLoadingGrid() {
        const grid = document.getElementById('mic-grid');
        if (!grid) return;
        const mobile = syncMicLayoutMode();
        syncMicOverviewTabs(mobile);
        grid.classList.add('mic-grid--loading');
        grid.classList.toggle('mic-grid--tabbed', mobile);
        grid.setAttribute('aria-busy', 'true');
        grid.innerHTML = mobile ? renderLoadingMobileTiles() : renderLoadingDesktopTiles();
    }

    function tryRestoreLastCachedOverview() {
        const entry = global.DashboardDataCache?.readAdminOverviewByLastKey?.();
        if (!entry?.data || !global.DashboardDataCache?.hasMeaningfulAdminOverview?.(entry.data)) {
            return false;
        }
        overviewData = entry.data;
        return true;
    }

    function paintCachedOrLoadingGrid() {
        if (tryRestoreLastCachedOverview()) {
            const grid = document.getElementById('mic-grid');
            if (grid) {
                grid.classList.remove('mic-grid--loading');
                grid.setAttribute('aria-busy', 'false');
            }
            renderTiles();
            global.DashboardPreloadBridge?.signalReady?.('content');
            return true;
        }
        if (!overviewData?.placeholder) {
            overviewData = buildPlaceholderAdminOverview(meProfile || {});
        }
        paintLoadingGrid();
        return false;
    }

    async function resolvePrefetchedOverview(prefetched) {
        if (!prefetched) return null;
        if (typeof prefetched.then === 'function') {
            try {
                return await prefetched;
            } catch {
                return null;
            }
        }
        return prefetched;
    }

    async function loadOverview(prefetched) {
        if (!canMaintainMicOverview()) return;
        if (overviewLoadInFlight) return;
        overviewLoadInFlight = true;
        try {
            let data = prefetched && prefetched.success ? prefetched : null;
            if (!data) {
                const resolved = await resolvePrefetchedOverview(prefetched);
                if (resolved?.success) data = resolved;
            }
            if (!data) {
                const res = await fetch('/api/overview', { credentials: 'same-origin' });
                data = await res.json();
                if (!res.ok || !data.success) {
                    app.textContent = data.error || 'Could not load overview.';
                    return;
                }
            }
            if (data.salesUpdatedAt) lastSalesUpdatedAt = data.salesUpdatedAt;
            updateSalesScrapeHint(data.salesScrapeStatus || { salesUpdatedAt: data.salesUpdatedAt });
            overviewData = data;
            persistAdminOverview(data);
            const areas = data.areas || [];
            const isFirstLoad = !document.getElementById('mic-grid');
            if (!document.getElementById('mic-grid')) renderShell(MOS()?.renderPromoBanner?.());
            const storedArea = pendingAreaName || global.MicAreaPicker?.getStoredArea?.() || '';
            if (areas.length && isFirstLoad) {
                if (storedArea) {
                    applyAreaSelection(storedArea);
                } else if (!areaPickerActive) {
                    areaIndex = defaultAreaIndex(areas);
                    updateScopeSubtitle();
                    renderTiles();
                } else {
                    areaIndex = defaultAreaIndex(areas);
                    renderTiles();
                }
            } else {
                renderTiles();
            }
            global.DashboardPreloadBridge?.signalReady?.('content');
        } finally {
            overviewLoadInFlight = false;
        }
    }

    async function checkForScrapeUpdate() {
        if (overviewLoadInFlight) return;
        try {
            const res = await fetch('/api/admin/overview/status', { credentials: 'same-origin' });
            const data = await res.json();
            if (!res.ok || !data.success) return;
            updateSalesScrapeHint(data);
            const updatedAt = data.salesUpdatedAt || null;
            if (!updatedAt) return;
            if (!lastSalesUpdatedAt) {
                lastSalesUpdatedAt = updatedAt;
                return;
            }
            if (updatedAt !== lastSalesUpdatedAt) await loadOverview();
        } catch {
            /* ignore */
        }
    }

    function clearIntervals() {
        for (const id of intervals) global.clearInterval(id);
        intervals = [];
    }

    function stop() {
        clearIntervals();
        MOS()?.unmountPageClasses?.();
        overviewLoadInFlight = false;
    }

    async function start(profile, appEl, promoBannerHtml, options = {}) {
        meProfile = profile;
        app = appEl;
        clearIntervals();
        pendingAreaName =
            global.MicAreaPicker?.isPickerPending?.() ? '' : global.MicAreaPicker?.getStoredArea?.() || '';
        const profileCached = restoreCachedAdminOverview();
        if (profileCached) {
            overviewData = profileCached;
        } else if (
            !overviewData ||
            overviewData.placeholder ||
            !global.DashboardDataCache?.hasMeaningfulAdminOverview?.(overviewData)
        ) {
            overviewData = buildPlaceholderAdminOverview(profile);
        }
        if (!overviewData.placeholder) {
            global.DashboardPreloadBridge?.signalReady?.('content');
        }
        MOS()?.setOnMobileLayoutChange?.(() => {
            if (overviewData) renderTiles();
        });
        renderShell(promoBannerHtml);
        syncMicLayoutMode();
        global.DashboardPreloadBridge?.signalReady?.('shell');

        const pickerAreas = global.MicAreaPicker?.resolveInitialAreaNames?.(profile, null) || [];
        const showPicker =
            global.MicAreaPicker?.shouldShowPicker?.(profile) && pickerAreas.length > 1;

        if (showPicker) {
            areaPickerActive = true;
            void global.MicAreaPicker.show({
                profile,
                areaNames: pickerAreas,
                onPick: (name) => {
                    applyAreaSelection(name);
                },
            }).finally(() => {
                areaPickerActive = false;
            });
        }

        void global.CoreCountdown?.init?.();
        // Parallel: overview (or use prefetch) + DFSC status.
        void Promise.all([
            loadOverview(options.prefetchedOverview || null),
            loadDfscStatus(),
        ]);

        intervals.push(
            global.setInterval(() => {
                const clock = document.getElementById('mic-clock');
                if (clock) clock.textContent = formatTime(new Date());
            }, 1000)
        );
        intervals.push(global.setInterval(() => loadOverview(), REFRESH_MS));
        intervals.push(global.setInterval(checkForScrapeUpdate, SCRAPE_POLL_MS));
        global.addEventListener('resize', () => {
            syncMicLayoutMode();
        });
    }

    global.MicOverviewMulti = {
        start,
        loadOverview,
        stop,
        paintCachedOrLoadingGrid,
        tryRestoreLastCachedOverview,
    };
})(window);
