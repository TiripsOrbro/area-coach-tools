/**
 * Unified MIC overview page shell — header, mobile tabs, layout breakpoints.
 */
(function micOverviewShellModule(global) {
    const MIC_MOBILE_MAX = 900;
    const TIME_ZONE = 'Australia/Melbourne';
    const MIC_TAB_STORAGE_KEY = 'mic-overview-active-tab';

    const MIC_OVERVIEW_TABS = [
        { id: 'sales', label: 'Sales' },
        { id: 'results', label: 'Results' },
        { id: 'orders', label: 'Orders' },
        { id: 'audits', label: 'Audits' },
    ];

    const CURRENT_PROMO = {
        label: 'Current Promo',
        name: 'Nacho Cheese Dip Burrito',
        imageUrl: '/images/promos/let-it-drip-banner.png',
        pdfUrl: '/documents/promos/let-it-drip-frrop.pdf',
    };

    let activeMicTab = sessionStorage.getItem(MIC_TAB_STORAGE_KEY) || 'sales';
    let micOverviewTabsBound = false;
    let lastMicMobileLayout = null;
    let onMobileLayoutChange = null;

    function escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function formatTime(date) {
        return date.toLocaleTimeString('en-AU', {
            hour: 'numeric',
            minute: '2-digit',
            hour12: true,
            timeZone: TIME_ZONE,
        });
    }

    function renderPromoBanner() {
        return `
        <a
            class="admin-promo-banner"
            href="${CURRENT_PROMO.pdfUrl}"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="${CURRENT_PROMO.label}: ${CURRENT_PROMO.name}. Tap to view FRROP."
        >
            <span class="admin-promo-banner-bg" aria-hidden="true">
                <img src="${CURRENT_PROMO.imageUrl}" alt="">
            </span>
            <span class="admin-promo-banner-content">
                <span class="admin-promo-banner-text">
                    <span class="admin-promo-banner-label">${CURRENT_PROMO.label}</span>
                    <span class="admin-promo-banner-name">${CURRENT_PROMO.name}</span>
                </span>
                <span class="admin-promo-banner-cta">View FRROP</span>
            </span>
        </a>`;
    }

    function isMicMobileView() {
        return global.matchMedia(`(max-width: ${MIC_MOBILE_MAX}px)`).matches;
    }

    function setOnMobileLayoutChange(fn) {
        onMobileLayoutChange = typeof fn === 'function' ? fn : null;
    }

    function syncMicLayoutMode() {
        const mobile = isMicMobileView();
        document.body?.classList?.toggle('mic-overview--mobile', mobile);
        document.documentElement?.classList?.toggle('mic-overview--mobile', mobile);
        if (lastMicMobileLayout !== null && lastMicMobileLayout !== mobile) {
            onMobileLayoutChange?.(mobile);
        }
        lastMicMobileLayout = mobile;
        return mobile;
    }

    function renderMicTabPanel(tabId, content) {
        return `
        <section
            class="mic-tab-panel mic-tab-panel--${tabId}"
            data-mic-tab-panel="${tabId}"
            id="mic-tabpanel-${tabId}"
            role="tabpanel"
            aria-labelledby="mic-tab-${tabId}"
        >${content}</section>`;
    }

    function renderMicOverviewTabsHtml() {
        return MIC_OVERVIEW_TABS.map(({ id, label }) => {
            const isActive = activeMicTab === id;
            return `<button type="button" class="mic-overview-tab${isActive ? ' is-active' : ''}" role="tab" id="mic-tab-${id}" aria-selected="${isActive ? 'true' : 'false'}" aria-controls="mic-tabpanel-${id}" data-mic-overview-tab="${id}">${escapeHtml(label)}</button>`;
        }).join('');
    }

    function applyMicOverviewTab(tabId) {
        if (!MIC_OVERVIEW_TABS.some((tab) => tab.id === tabId)) tabId = 'sales';
        activeMicTab = tabId;
        sessionStorage.setItem(MIC_TAB_STORAGE_KEY, tabId);
        document.querySelectorAll('[data-mic-overview-tab]').forEach((button) => {
            const isActive = button.dataset.micOverviewTab === tabId;
            button.classList.toggle('is-active', isActive);
            button.setAttribute('aria-selected', isActive ? 'true' : 'false');
        });
        const tabClasses = [
            'mic-overview-tab--sales',
            'mic-overview-tab--results',
            'mic-overview-tab--orders',
            'mic-overview-tab--audits',
        ];
        document.body.classList.remove(...tabClasses);
        document.documentElement.classList.remove(...tabClasses);
        document.body.classList.add(`mic-overview-tab--${tabId}`);
        document.documentElement.classList.add(`mic-overview-tab--${tabId}`);
        const grid = document.getElementById('mic-grid');
        if (!grid) return;
        grid.querySelectorAll('[data-mic-tab-panel]').forEach((panel) => {
            const isActive = panel.dataset.micTabPanel === tabId;
            panel.hidden = !isActive;
            panel.classList.toggle('is-tab-active', isActive);
        });
        if (tabId === 'sales') {
            global.requestAnimationFrame(syncSalesHourlyScroll);
        }
    }

    function syncSalesHourlyScroll() {
        if (!isMicMobileView() || activeMicTab !== 'sales') return;
        const panel = document.querySelector('.mic-tab-panel--sales:not([hidden])');
        const hourly = panel?.querySelector('.mic-mobile-hourly--scroll');
        const body = hourly?.querySelector('.mic-mobile-hourly-body');
        const head = hourly?.querySelector('.mic-mobile-hourly-head');
        if (!panel || !hourly || !body) return;
        const hourlyRect = hourly.getBoundingClientRect();
        const headHeight = head?.offsetHeight || 0;
        const link = panel.querySelector('.mic-meal-dashboard-link');
        const bottomLimit = link
            ? link.getBoundingClientRect().top
            : panel.getBoundingClientRect().bottom;
        const available = bottomLimit - hourlyRect.top - headHeight - 4;
        const maxHeight = Math.max(120, Math.floor(available));
        body.style.maxHeight = `${maxHeight}px`;
        body.style.overflowY = 'auto';
        body.style.webkitOverflowScrolling = 'touch';
    }

    function bindMicOverviewTabs() {
        const nav = document.getElementById('mic-overview-tabs');
        if (!nav || micOverviewTabsBound) return;
        nav.addEventListener('click', (event) => {
            const button = event.target.closest('[data-mic-overview-tab]');
            if (!button) return;
            applyMicOverviewTab(button.dataset.micOverviewTab);
        });
        micOverviewTabsBound = true;
    }

    function syncMicOverviewTabs(mobile) {
        const nav = document.getElementById('mic-overview-tabs');
        const tabClasses = [
            'mic-overview-tab--sales',
            'mic-overview-tab--results',
            'mic-overview-tab--orders',
            'mic-overview-tab--audits',
        ];
        if (!mobile) {
            if (nav) nav.hidden = true;
            document.body.classList.remove(...tabClasses);
            document.documentElement.classList.remove(...tabClasses);
            return;
        }
        if (!nav) return;
        nav.hidden = false;
        nav.innerHTML = renderMicOverviewTabsHtml();
        bindMicOverviewTabs();
    }

    function renderShellHtml({ subtitle = 'Overview', promoBannerHtml = '' } = {}) {
        return `
        <div class="mic-page mic-page--admin" id="mic-page">
            <header class="mic-header mic-header--admin">
                <div class="mic-header-brand">
                    <div>
                        <h1>MIC OVERVIEW</h1>
                        <p class="subtitle" id="mic-store-label">${escapeHtml(subtitle)}</p>
                    </div>
                </div>
                ${promoBannerHtml || ''}
                <div class="mic-header-store-slot" id="mic-header-store-slot"></div>
                <div class="mic-header-actions">
                    <div class="mic-clock">
                        <span class="mic-clock-label">Current time</span>
                        <span class="mic-clock-value" id="mic-clock">${formatTime(new Date())}</span>
                        <span class="mic-sales-scrape-hint" id="mic-sales-scrape-hint" hidden>Sales · n/a</span>
                    </div>
                </div>
            </header>
            <nav class="mic-overview-tabs" id="mic-overview-tabs" role="tablist" aria-label="MIC overview sections" hidden></nav>
            <div class="mic-grid mic-grid--admin" id="mic-grid"></div>
        </div>`;
    }

    function mountShell(appEl, { subtitle = 'Overview', promoBannerHtml = '' } = {}) {
        if (!appEl) return;
        mountPageClasses();
        appEl.classList.remove('app-boot-loading');
        appEl.removeAttribute('aria-busy');
        appEl.innerHTML = renderShellHtml({ subtitle, promoBannerHtml });
        global.MicSettings?.ensurePersistentSettingsCog?.();
    }

    function mountPageClasses() {
        document.documentElement?.classList?.add('mic-overview-page');
        document.body?.classList?.add('mic-overview-page');
    }

    function unmountPageClasses() {
        document.documentElement?.classList?.remove(
            'mic-overview-page',
            'mic-overview--mobile',
            'mic-overview-tab--sales',
            'mic-overview-tab--results',
            'mic-overview-tab--orders',
            'mic-overview-tab--audits'
        );
        document.body?.classList?.remove(
            'mic-overview-page',
            'mic-overview--mobile',
            'mic-overview-tab--sales',
            'mic-overview-tab--results',
            'mic-overview-tab--orders',
            'mic-overview-tab--audits'
        );
        micOverviewTabsBound = false;
        lastMicMobileLayout = null;
    }

    function getActiveTab() {
        return activeMicTab;
    }

    global.MicOverviewShell = {
        MIC_MOBILE_MAX,
        MIC_OVERVIEW_TABS,
        MIC_TAB_STORAGE_KEY,
        TIME_ZONE,
        escapeHtml,
        formatTime,
        renderPromoBanner,
        isMicMobileView,
        setOnMobileLayoutChange,
        syncMicLayoutMode,
        renderMicTabPanel,
        renderMicOverviewTabsHtml,
        applyMicOverviewTab,
        syncMicOverviewTabs,
        syncSalesHourlyScroll,
        bindMicOverviewTabs,
        renderShellHtml,
        mountShell,
        mountPageClasses,
        unmountPageClasses,
        getActiveTab,
    };
})(window);
