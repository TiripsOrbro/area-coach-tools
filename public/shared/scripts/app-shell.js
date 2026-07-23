/**
 * Single-page shell — client router with mount/unmount view lifecycle.
 */
(function appShellModule(global) {
    const VIEWPORT_ID = 'app-shell-viewport';
    const VIEW_ID = 'app-shell-view';
    const APP_ID = 'app';
    const TRANSITION_MS = 280;

    const scriptCache = new Map();
    let activeView = null;
    let activeUnmount = null;
    let pendingNavigation = null;
    let navigationDrain = null;
    let bootId = '';
    let shellHasMountedOnce = false;

    function prefersReducedMotion() {
        return global.matchMedia('(prefers-reduced-motion: reduce)').matches;
    }

    function shellPathname() {
        return global.__SHELL_ROUTE__?.pathname ?? global.location.pathname;
    }

    function shellSearch() {
        return global.__SHELL_ROUTE__?.search ?? global.location.search;
    }

    function setShellRoute(pathname, search = '', hash = '') {
        global.__SHELL_ROUTE__ = {
            pathname: String(pathname || '/'),
            search: String(search || ''),
            hash: String(hash || ''),
        };
        global.__APP_SHELL__ = true;
    }

    function getAppEl() {
        let app = document.getElementById(APP_ID);
        if (!app) {
            const view = document.getElementById(VIEW_ID);
            app = document.createElement('div');
            app.id = APP_ID;
            view?.appendChild(app);
        }
        return app;
    }

    function scriptSrc(url, { bust } = {}) {
        const sep = url.includes('?') ? '&' : '?';
        const token = bust || bootId || String(Date.now());
        return `${url}${sep}v=${encodeURIComponent(token)}`;
    }

    /** After load, verify scripts that register a global view/export actually did so. */
    const SCRIPT_READY_CHECKS = {
        '/scripts/dashboard.js': () => global.SalesDashboardView?.mount,
        '/scripts/admin-accounts.js': () => global.AdminAccounts?.mountCreate,
        '/scripts/admin-forecast.js': () => global.AdminForecast?.mount,
        '/scripts/admin-build-to.js': () => global.AdminBuildTo?.mount,
        '/scripts/admin-store-hours.js': () => global.AdminStoreHours?.mount,
        '/scripts/admin-five-am-reports.js': () => global.AdminFiveAmReports?.mount,
        '/scripts/admin-report-subscriptions.js': () => global.AdminReportSubscriptions?.mount,
        '/scripts/admin-live-logs.js': () => global.AdminLiveLogs?.mount,
        '/scripts/admin-store-logins.js': () => global.AdminStoreLogins?.mount,
        '/scripts/admin-smg-nsf.js': () => global.AdminSmgNsf?.mount,
        '/scripts/requests.js': () => global.FeatureRequestsView?.mount,
        '/scripts/bug-reports.js': () => global.BugReportsView?.mount,
    };

    function scriptBasePath(url) {
        return String(url || '').split('?')[0];
    }

    function findShellScript(basePath) {
        return document.querySelector(`script[data-shell-src="${basePath}"]`);
    }

    function loadScript(src, { force = false, bust } = {}) {
        const url = String(src || '').trim();
        if (!url) return Promise.resolve();
        const basePath = scriptBasePath(url);
        const readyCheck = SCRIPT_READY_CHECKS[basePath];

        if (!force && typeof readyCheck === 'function' && readyCheck()) {
            const hit = Promise.resolve();
            if (!scriptCache.has(url)) scriptCache.set(url, hit);
            return hit;
        }

        if (!force && scriptCache.has(url)) return scriptCache.get(url);

        if (!force && findShellScript(basePath)) {
            const hit = Promise.resolve();
            scriptCache.set(url, hit);
            return hit;
        }

        if (force) {
            scriptCache.delete(url);
            findShellScript(basePath)?.remove();
        }

        const promise = new Promise((resolve, reject) => {
            const el = document.createElement('script');
            el.dataset.shellSrc = basePath;
            el.src = scriptSrc(url, { bust });
            el.async = false;
            el.onload = () => {
                if (typeof readyCheck === 'function' && !readyCheck()) {
                    scriptCache.delete(url);
                    el.remove();
                    reject(new Error(`${basePath} loaded but did not register expected exports`));
                    return;
                }
                resolve();
            };
            el.onerror = () => {
                scriptCache.delete(url);
                el.remove();
                reject(new Error(`Failed to load ${url}`));
            };
            document.body.appendChild(el);
        });
        scriptCache.set(url, promise);
        return promise;
    }

    async function loadScriptChain(urls) {
        for (const url of urls || []) {
            await loadScript(url);
        }
    }

    async function loadScriptBatch(urls) {
        await Promise.all((urls || []).map((url) => loadScript(url)));
    }

    function ensureStylesheet(id, href) {
        if (document.getElementById(id)) return;
        const link = document.createElement('link');
        link.id = id;
        link.rel = 'stylesheet';
        const token = bootId || '';
        link.href = token
            ? `${href}${href.includes('?') ? '&' : '?'}v=${encodeURIComponent(token)}`
            : href;
        document.head.appendChild(link);
    }

    function ensureOverviewStyles() {
        ensureStylesheet('shell-mic-css', '/styles/mic.css');
        ensureStylesheet('shell-account-modal-css', '/styles/account-modal.css');
        ensureStylesheet('shell-admin-menu-css', '/styles/admin-menu.css');
    }

    function ensureSalesDashboardStyles() {
        ensureStylesheet('shell-dashboard-css', '/styles/dashboard.css');
        ensureStylesheet('shell-account-modal-css', '/styles/account-modal.css');
        ensureStylesheet('shell-admin-menu-css', '/styles/admin-menu.css');
    }

    function ensureAdminSettingsStyles() {
        // Preferences colour-blind swatches (.mic-colour-sample-box) live in mic.css.
        ensureStylesheet('shell-mic-css', '/styles/mic.css');
        ensureStylesheet('shell-admin-menu-css', '/styles/admin-menu.css');
        ensureStylesheet('shell-account-modal-css', '/styles/account-modal.css');
        ensureStylesheet('shell-requests-css', '/styles/requests.css');
        ensureStylesheet('shell-bug-reports-css', '/styles/bug-reports.css');
        ensureStylesheet('shell-login-css', '/styles/login.css');
    }

    function ensureTacauditStyles() {
        ensureStylesheet('shell-dfsc-css', '/styles/dfsc.css');
        ensureStylesheet('shell-tacaudit-css', '/styles/tacaudit.css');
    }

    async function loadOverviewScripts() {
        // Critical path only — enough to paint shell + tiles + mount overview.
        await loadScriptBatch([
            '/scripts/loading-dots.js',
            '/scripts/dashboard-preload-bridge.js',
            '/scripts/dashboard-data-cache.js',
            '/scripts/area-display.js',
            '/scripts/scope-popup.js',
            '/scripts/mic-settings.js',
            '/scripts/nav-back.js',
            '/scripts/sales-progress.js',
            '/scripts/store-snap-row.js',
            '/scripts/audit-preferences.js',
            '/scripts/area-picker-overlay.js',
            '/scripts/mic-mini-dashboard.js',
            '/scripts/core-countdown.js',
            '/scripts/mic-overview-shell.js',
            '/scripts/mic-overview-tiles.js',
            '/scripts/mic-overview-multi.js',
            '/scripts/admin-scope-picker.js',
            '/scripts/admin-store-view.js',
            '/scripts/mic-dashboard.js',
        ]);
    }

    async function loadOverviewScriptsDeferred() {
        await loadScriptBatch([
            '/scripts/page-transition.js',
            '/scripts/welcome-overlay.js',
            '/scripts/admin-menu.js',
            '/scripts/account-modal.js',
            '/scripts/create-account-form.js',
            '/scripts/admin-accounts.js',
            '/scripts/admin-forecast.js',
            '/scripts/admin-build-to.js',
            '/scripts/admin-store-logins.js',
            '/scripts/admin-smg-nsf.js',
            '/scripts/admin-store-picker.js',
            '/scripts/mmx-user-login-prompt.js',
        ]);
    }

    const SHARED_OVERVIEW_SCRIPTS = [
        '/scripts/page-transition.js',
        '/scripts/welcome-overlay.js',
        '/scripts/loading-dots.js',
        '/scripts/area-display.js',
        '/scripts/area-picker-overlay.js',
        '/scripts/account-modal.js',
        '/scripts/admin-menu.js',
        '/scripts/create-account-form.js',
        '/scripts/admin-accounts.js',
        '/scripts/admin-forecast.js',
        '/scripts/admin-build-to.js',
        '/scripts/admin-store-logins.js',
        '/scripts/admin-smg-nsf.js',
        '/scripts/audit-preferences.js',
        '/scripts/mic-settings.js',
        '/scripts/sales-progress.js',
        '/scripts/dashboard-data-cache.js',
        '/scripts/nav-back.js',
        '/scripts/store-snap-row.js',
        '/scripts/admin-store-picker.js',
        '/scripts/admin-scope-picker.js',
        '/scripts/admin-store-view.js',
        '/scripts/mic-mini-dashboard.js',
        '/scripts/core-countdown.js',
        '/scripts/mic-overview-shell.js',
        '/scripts/mic-overview-tiles.js',
        '/scripts/mic-overview-multi.js',
        '/scripts/mmx-user-login-prompt.js',
        '/scripts/mic-dashboard.js',
    ];

    const SHARED_DASHBOARD_SCRIPTS = [
        '/scripts/page-transition.js',
        '/scripts/welcome-overlay.js',
        '/scripts/loading-dots.js',
        '/scripts/area-display.js',
        '/scripts/audit-preferences.js',
        '/scripts/mic-settings.js',
        '/scripts/dashboard-data-cache.js',
        '/scripts/nav-back.js',
        '/scripts/store-snap-row.js',
        '/scripts/admin-store-tabs.js',
        '/scripts/admin-area-panel.js',
        '/scripts/admin-scope-picker.js',
        '/scripts/stock-count-notify.js',
        '/scripts/popup-timing.js',
        '/scripts/popup-content.js',
        '/scripts/dashboard.js',
    ];

    const SHARED_ADMIN_SCRIPTS = [
        '/scripts/page-transition.js',
        '/scripts/area-display.js',
        '/scripts/nav-back.js',
        '/scripts/audit-preferences.js',
        '/scripts/account-modal.js',
        '/scripts/admin-scope-picker.js',
        '/scripts/admin-store-view.js',
        '/scripts/mic-settings.js',
        '/scripts/create-account-form.js',
        '/scripts/admin-page.js',
    ];

    const ADMIN_SETTINGS_DEFERRED_SCRIPTS = [
        '/scripts/create-account-form.js',
        '/scripts/admin-accounts.js',
        '/scripts/admin-forecast.js',
        '/scripts/admin-build-to.js',
        '/scripts/admin-store-hours.js',
        '/scripts/admin-five-am-reports.js',
        '/scripts/admin-report-subscriptions.js',
        '/scripts/admin-live-logs.js',
        '/scripts/admin-store-logins.js',
        '/scripts/admin-smg-nsf.js',
        '/scripts/requests.js',
        '/scripts/bug-reports.js',
    ];

    /** Per-section scripts so opening Settings does not wait on forecast/build-to/etc. */
    const ADMIN_SECTION_SCRIPTS = {
        'accounts-create': ['/scripts/create-account-form.js', '/scripts/admin-accounts.js'],
        'accounts-existing': ['/scripts/create-account-form.js', '/scripts/admin-accounts.js'],
        'store-logins': ['/scripts/admin-store-logins.js'],
        'smg-nsf': ['/scripts/admin-smg-nsf.js'],
        forecast: ['/scripts/admin-forecast.js'],
        'build-to': ['/scripts/admin-build-to.js'],
        'store-hours': ['/scripts/admin-store-hours.js'],
        'five-am-reports': ['/scripts/admin-five-am-reports.js'],
        'report-subscriptions': ['/scripts/admin-report-subscriptions.js'],
        'live-logs': ['/scripts/admin-live-logs.js'],
        'feature-requests': ['/scripts/requests.js'],
        'bug-reports': ['/scripts/bug-reports.js'],
    };

    function paintAdminSettingsBootShell(app) {
        document.body.classList.add('admin-settings-page', 'admin-page');
        document.body.classList.remove(
            'mic-overview-page',
            'admin-overview-page',
            'mic-overview--mobile',
            'stock-count-page',
            'tacaudit-page',
            'dfsc-page'
        );
        document.documentElement.classList.remove('mic-overview-page', 'admin-overview-page', 'dfsc-page');
        if (document.getElementById('admin-settings-content')) {
            app.classList.remove('app-boot-loading');
            app.removeAttribute('aria-busy');
            return;
        }
        app.classList.remove('app-boot-loading');
        app.removeAttribute('aria-busy');
        app.innerHTML = `
            <div class="admin-settings-shell">
                <header class="admin-settings-header">
                    <div id="nav-back-host" class="admin-settings-header__back"></div>
                    <h1 class="admin-settings-title">Settings</h1>
                    <button type="button" id="admin-settings-nav-toggle" class="admin-settings-nav-toggle admin-settings-header__menu" aria-expanded="false" aria-controls="admin-settings-nav" aria-label="Open menu"><svg class="admin-settings-nav-toggle-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M4 7h16v2H4V7zm0 5h16v2H4v-2zm0 5h16v2H4v-2z"/></svg></button>
                </header>
                <div class="admin-settings-body">
                    <div id="admin-settings-nav-backdrop" class="admin-settings-nav-backdrop" hidden aria-hidden="true"></div>
                    <div class="admin-settings-sidebar-wrap">
                        <nav id="admin-settings-nav" class="admin-settings-sidebar" role="navigation" aria-label="Settings sections"></nav>
                        <div class="admin-settings-sidebar-footer">
                            <button type="button" id="admin-settings-sign-out" class="admin-settings-sign-out">Sign out</button>
                        </div>
                    </div>
                    <main class="admin-settings-main">
                        <div id="admin-settings-content" class="admin-settings-content" role="main">
                            <div class="admin-settings-loading-panel" aria-live="polite">
                                <p class="admin-settings-loading">Loading settings…</p>
                            </div>
                        </div>
                    </main>
                </div>
            </div>`;
    }

    let adminDeferredScriptsPromise = null;
    const adminSectionScriptPromises = new Map();

    function ensureAdminDeferredScripts() {
        if (!adminDeferredScriptsPromise) {
            adminDeferredScriptsPromise = loadScriptBatch(ADMIN_SETTINGS_DEFERRED_SCRIPTS).catch((err) => {
                adminDeferredScriptsPromise = null;
                throw err;
            });
        }
        return adminDeferredScriptsPromise;
    }

    function ensureAdminScriptsForSection(sectionId) {
        const id = String(sectionId || '');
        const urls = ADMIN_SECTION_SCRIPTS[id];
        if (!urls?.length) return Promise.resolve();
        if (adminSectionScriptPromises.has(id)) return adminSectionScriptPromises.get(id);
        const promise = loadScriptBatch(urls).catch((err) => {
            adminSectionScriptPromises.delete(id);
            throw err;
        });
        adminSectionScriptPromises.set(id, promise);
        return promise;
    }

    async function mountAdminSettings() {
        ensureAdminSettingsStyles();
        const app = getAppEl();
        paintAdminSettingsBootShell(app);
        try {
            await loadScriptBatch([
                '/scripts/scope-popup.js',
                '/scripts/mic-settings.js',
                ...SHARED_ADMIN_SCRIPTS,
            ]);
            // Prefetch heavy section modules in the background — do not block first paint.
            void ensureAdminDeferredScripts();
            if (global.AdminSettingsView?.mount) {
                await global.AdminSettingsView.mount(app);
                return;
            }
            app.textContent = 'Admin settings failed to load.';
        } catch (err) {
            console.error('[AppShell] Admin settings mount failed:', err);
            const host = document.getElementById('admin-settings-content');
            if (host) {
                host.innerHTML = `<p class="admin-modal-error" role="alert">${err?.message || 'Admin settings failed to load.'}</p>`;
            } else {
                app.textContent = err?.message || 'Admin settings failed to load.';
            }
        }
    }

    const SHARED_TACAUDIT_SCRIPTS = [
        '/scripts/page-transition.js',
        '/scripts/nav-back.js',
        '/scripts/audit-preferences.js',
        '/scripts/scope-popup.js',
        '/scripts/mic-settings.js',
        '/scripts/admin-scope-picker.js',
    ];

    function fallbackToLegacyStockCountPage() {
        const url = new URL(global.location.href);
        if (url.searchParams.get('noshell') === '1') return false;
        url.searchParams.set('noshell', '1');
        global.location.replace(url.toString());
        return true;
    }

    function ensureTacauditShellChrome() {
        document.documentElement.classList.add('dfsc-page');
        if (!document.getElementById('tacaudit-nav-back')) {
            const host = document.createElement('div');
            host.id = 'tacaudit-nav-back';
            host.className = 'nav-back-host';
            const app = document.getElementById(APP_ID);
            if (app?.parentNode) {
                app.parentNode.insertBefore(host, app);
            } else {
                document.body.insertBefore(host, document.body.firstChild);
            }
        }
    }

    function matchRoute(pathname) {
        const path = String(pathname || '/').replace(/\/+$/, '') || '/';
        const routes = [
            { re: /^\/overview$/i, id: 'overview' },
            { re: /^\/Admin\/Settings$/i, id: 'admin-settings' },
            { re: /^\/changelog$/i, id: 'changelog' },
            { re: /^\/requests$/i, id: 'requests' },
            { re: /^\/tacaudit\/summary$/i, id: 'tacaudit-summary' },
            { re: /^\/tacaudit\/actions$/i, id: 'tacaudit-summary' },
            { re: /^\/MIC\/(teststore|\d{3,6})$/i, id: 'sales-dashboard', store: 1 },
            { re: /^\/Admin\/(qld-1|vic-1|wa-1|teststore|\d{3,6})$/i, id: 'sales-dashboard', area: 1 },
            { re: /^\/Admin\/A\d+$/i, id: 'sales-dashboard', area: 1 },
            { re: /^\/(\d{3,6})\/daily-stock-count$/i, id: 'daily-stock-count', store: 1 },
            { re: /^\/(\d{3,6})\/stock-count\/[^/]+$/i, id: 'stock-count', store: 1 },
            { re: /^\/(\d{3,6})\/tacaudit\/actions$/i, id: 'tacaudit-store', store: 1 },
            { re: /^\/(\d{3,6})\/tacaudit$/i, id: 'tacaudit-store', store: 1 },
            { re: /^\/(\d{3,6})\/(dfsc|pest-walk|psi|rgm-cleaning|period-audit)$/i, id: 'tacaudit-audit', store: 1, audit: 2 },
            { re: /^\/(\d{3,6})\/square-one(?:\/[^/]+)?$/i, id: 'tacaudit-audit', store: 1 },
        ];
        for (const row of routes) {
            const m = path.match(row.re);
            if (!m) continue;
            return {
                id: row.id,
                pathname: path,
                params: {
                    store: m[row.store] || '',
                    area: m[row.area] || '',
                    audit: m[row.audit] || '',
                },
            };
        }
        return { id: 'overview', pathname: '/overview', params: {} };
    }

    async function mountOverview() {
        ensureOverviewStyles();
        await loadOverviewScripts();
        void loadOverviewScriptsDeferred().then(() => {
            global.AdminAccounts?.maybeOpenFromQuery?.();
        });
        if (global.MicOverviewView?.mount) {
            await global.MicOverviewView.mount(getAppEl());
            return;
        }
        console.error('[AppShell] MicOverviewView missing after loading overview scripts');
        getAppEl().textContent =
            'Overview failed to load. Hard refresh the page (Ctrl+Shift+R) or sign in again.';
    }

    async function loadDashboardScripts() {
        await loadScriptBatch([
            '/scripts/page-transition.js',
            '/scripts/welcome-overlay.js',
            '/scripts/loading-dots.js',
            '/scripts/dashboard-preload-bridge.js',
            '/scripts/dashboard-data-cache.js',
            '/scripts/area-display.js',
            '/scripts/scope-popup.js',
            '/scripts/audit-preferences.js',
            '/scripts/mic-settings.js',
            '/scripts/nav-back.js',
            '/scripts/store-snap-row.js',
            '/scripts/stock-count-notify.js',
            '/scripts/admin-store-tabs.js',
            '/scripts/admin-area-panel.js',
            '/scripts/admin-scope-picker.js',
            '/scripts/popup-timing.js',
            '/scripts/popup-content.js',
            '/scripts/dashboard.js',
        ]);
    }

    async function mountSalesDashboard() {
        ensureSalesDashboardStyles();
        async function loadDashboardScriptsWithRetry() {
            await loadDashboardScripts();
        }
        function clearDashboardScriptCache() {
            scriptCache.delete('/scripts/dashboard.js');
            findShellScript('/scripts/dashboard.js')?.remove();
        }
        try {
            await loadDashboardScriptsWithRetry();
        } catch (err) {
            console.warn('[AppShell] dashboard script load failed, retrying:', err);
            clearDashboardScriptCache();
            await loadDashboardScriptsWithRetry();
        }
        if (!global.SalesDashboardView?.mount) {
            clearDashboardScriptCache();
            try {
                await loadScript('/scripts/dashboard.js', { force: true, bust: String(Date.now()) });
            } catch (err) {
                console.error('[AppShell] dashboard.js retry failed:', err);
            }
        }
        if (global.SalesDashboardView?.mount) {
            await global.SalesDashboardView.mount(getAppEl());
            return;
        }
        console.error('[AppShell] SalesDashboardView missing after loading dashboard scripts');
        getAppEl().textContent = 'Dashboard failed to load.';
    }


    function ensureStockCountStyles() {
        ensureStylesheet('shell-stock-count-css', '/styles/stock-count.css');
    }

    async function mountStockCount() {
        document.body.classList.add('stock-count-page');
        ensureStockCountStyles();
        try {
            await loadScriptBatch([
                '/scripts/page-transition.js',
                '/scripts/nav-back.js',
            ]);
            await Promise.allSettled([
                loadScript('/scripts/stock-count-notify.js'),
                loadScript('/scripts/variance-catalog-match.js'),
                loadScript('/scripts/mmx-user-login-prompt.js'),
            ]);
            await loadScript('/scripts/stock-count.js', { force: true });
        } catch (err) {
            console.error('[AppShell] stock count script load failed:', err);
            if (fallbackToLegacyStockCountPage()) return;
            getAppEl().textContent = err?.message || 'Stock count failed to load.';
            return;
        }
        if (!global.StockCountView?.mount) {
            console.error('[AppShell] StockCountView missing after loading stock count scripts');
            if (fallbackToLegacyStockCountPage()) return;
            getAppEl().textContent =
                'Stock count failed to load. Hard refresh the page (Ctrl+Shift+R).';
            return;
        }
        try {
            await global.StockCountView.mount();
        } catch (err) {
            console.error('[AppShell] stock count mount failed:', err);
            if (fallbackToLegacyStockCountPage()) return;
            getAppEl().textContent = err?.message || 'Stock count failed to load.';
        }
    }

    async function mountDailyStockCount() {
        document.body.classList.add('stock-count-page');
        ensureStockCountStyles();
        await loadScript('/scripts/page-transition.js');
        await loadScript('/scripts/nav-back.js');
        await loadScript('/scripts/daily-stock-count.js');
        if (!global.DailyStockCountView?.mount) {
            scriptCache.delete('/scripts/daily-stock-count.js');
            await loadScript('/scripts/daily-stock-count.js', { force: true });
        }
        if (global.DailyStockCountView?.mount) {
            await global.DailyStockCountView.mount();
            return;
        }
        console.error('[AppShell] DailyStockCountView missing after loading daily stock count scripts');
        getAppEl().textContent =
            'Daily stock count failed to load. Hard refresh the page (Ctrl+Shift+R).';
    }

    async function ensureTacauditViewLoaded() {
        await loadScriptChain(SHARED_TACAUDIT_SCRIPTS);
        if (!global.TacauditView?.mount) {
            await loadScript('/scripts/tacaudit.js');
        }
        return Boolean(global.TacauditView?.mount);
    }

    function fallbackToLegacyTacauditPage() {
        const url = new URL(global.location.href);
        if (url.searchParams.get('noshell') === '1') return false;
        url.searchParams.set('noshell', '1');
        global.location.replace(url.toString());
        return true;
    }

    async function mountTacauditSummary() {
        document.body.classList.add('dfsc-page', 'tacaudit-page');
        ensureTacauditStyles();
        ensureTacauditShellChrome();
        try {
            const ready = await ensureTacauditViewLoaded();
            if (!ready) {
                if (fallbackToLegacyTacauditPage()) return;
                throw new Error('TacauditView did not register');
            }
            await global.TacauditView.mount(getAppEl());
        } catch (err) {
            console.error('[AppShell] TacAudit mount failed:', err);
            if (fallbackToLegacyTacauditPage()) return;
            const app = getAppEl();
            app.classList.remove('app-boot-loading');
            app.removeAttribute('aria-busy');
            app.textContent = err?.message || 'TacAudit failed to load.';
        }
    }

    async function mountLegacyPage(url) {
        global.location.href = url;
    }

    function bootLoadingHtml(label = 'Loading') {
        return global.LoadingDots?.html?.({ label, size: 'lg' })
            || '<p class="app-boot-loading__message">Loading…</p>';
    }

    async function mountView(route) {
        const app = getAppEl();
        if (route.id === 'overview' || route.id === 'sales-dashboard') {
            global.MicSettings?.ensurePersistentSettingsCog?.();
        } else {
            global.MicSettings?.hidePersistentSettingsCog?.();
        }
        const skipBootLoading = route.id === 'admin-settings' || route.id === 'requests';
        if (!skipBootLoading) {
            app.className = 'app-boot-loading';
            app.setAttribute('aria-busy', 'true');
            app.innerHTML = bootLoadingHtml();
        }
        document.body.classList.remove('stock-count-page', 'tacaudit-page', 'dfsc-page', 'admin-page');
        document.documentElement.classList.remove('dfsc-page');

        try {
            switch (route.id) {
                case 'overview':
                    await mountOverview();
                    break;
                case 'sales-dashboard':
                    await mountSalesDashboard();
                    break;
                case 'admin-settings':
                    document.body.classList.remove('mic-overview-page', 'admin-overview-page', 'mic-overview--mobile');
                    document.documentElement.classList.remove('mic-overview-page', 'admin-overview-page');
                    await mountAdminSettings();
                    break;
                case 'stock-count':
                case 'daily-stock-count':
                    if (route.id === 'daily-stock-count') await mountDailyStockCount();
                    else await mountStockCount();
                    break;
                case 'tacaudit-summary':
                case 'tacaudit-store':
                    await mountTacauditSummary();
                    break;
                case 'tacaudit-audit':
                    await mountLegacyPage(`${shellPathname()}${shellSearch()}${global.location.hash || ''}`);
                    return;
                case 'changelog':
                    await mountLegacyPage('/changelog');
                    return;
                case 'requests':
                    document.body.classList.remove('mic-overview-page', 'admin-overview-page', 'mic-overview--mobile');
                    document.documentElement.classList.remove('mic-overview-page', 'admin-overview-page');
                    global.history.replaceState(null, '', '/Admin/Settings#feature-requests');
                    setShellRoute('/Admin/Settings', '', '#feature-requests');
                    document.title = 'Admin Settings';
                    await mountAdminSettings();
                    break;
                default:
                    await mountOverview();
            }
        } finally {
            if (!skipBootLoading || !document.getElementById('admin-settings-content')) {
                app.classList.remove('app-boot-loading');
                app.removeAttribute('aria-busy');
            }
        }
    }

    function runTransition(nextMount) {
        const view = document.getElementById(VIEW_ID);
        // First boot: never hide the loading UI behind opacity:0 or a 280ms exit wait.
        if (!view || prefersReducedMotion() || !shellHasMountedOnce) {
            return nextMount();
        }
        view.classList.add('app-shell-view--exiting');
        return new Promise((resolve) => {
            global.setTimeout(async () => {
                await nextMount();
                view.classList.remove('app-shell-view--exiting');
                view.classList.add('app-shell-view--entering');
                requestAnimationFrame(() => {
                    view.classList.add('app-shell-view--visible');
                    global.setTimeout(() => {
                        view.classList.remove('app-shell-view--entering', 'app-shell-view--visible');
                        resolve();
                    }, TRANSITION_MS);
                });
            }, TRANSITION_MS);
        });
    }

    async function unmountActive() {
        if (typeof activeUnmount === 'function') {
            try {
                await activeUnmount();
            } catch (err) {
                console.warn('[AppShell] unmount failed:', err);
            }
        }
        activeUnmount = null;
        activeView = null;
    }

    function parseShellTarget(pathname, search = '', hash = '') {
        const raw = String(pathname || '/overview').trim() || '/overview';
        try {
            const url = new URL(raw, global.location.origin);
            const pathnameClean = url.pathname.replace(/\/+$/, '') || '/';
            return {
                pathname: pathnameClean,
                search: String(search || url.search || ''),
                hash: String(hash || url.hash || ''),
            };
        } catch {
            const pathOnly = raw.split('?')[0].split('#')[0].replace(/\/+$/, '') || '/';
            return { pathname: pathOnly, search: String(search || ''), hash: String(hash || '') };
        }
    }

    function maybeCanonicalizeAdminPath(target) {
        const canon = global.AppPaths?.canonicalAdminSalesPath?.(
            target.pathname,
            target.search,
            target.hash
        );
        if (!canon) return target;
        const url = `${canon.pathname}${canon.search || ''}${canon.hash || ''}`;
        global.history.replaceState({ shell: true, path: canon.pathname }, '', url);
        return canon;
    }

    async function performNavigate(pathname, { replace = false, search = '', hash = '' } = {}) {
        const target = maybeCanonicalizeAdminPath(parseShellTarget(pathname, search, hash));
        const path = target.pathname;
        const route = matchRoute(path);
        route.pathname = path;
        setShellRoute(path, target.search, target.hash);
        const url = `${path}${target.search || ''}${target.hash || ''}`;
        if (replace) {
            global.history.replaceState({ shell: true, path }, '', url);
        } else {
            global.history.pushState({ shell: true, path }, '', url);
        }
        document.title = titleForRoute(route);
        await unmountActive();
        await runTransition(async () => {
            await mountView(route);
            activeView = route.id;
            activeUnmount = unmountHandlerFor(route.id);
            shellHasMountedOnce = true;
        });
        prefetchAdjacent(route);
    }

    async function drainNavigationQueue() {
        try {
            while (pendingNavigation) {
                const job = pendingNavigation;
                pendingNavigation = null;
                await performNavigate(job.pathname, job.options);
            }
        } finally {
            navigationDrain = null;
            if (pendingNavigation) {
                navigationDrain = drainNavigationQueue();
            }
        }
    }

    function navigate(pathname, { replace = false, search = '', hash = '' } = {}) {
        pendingNavigation = { pathname, options: { replace, search, hash } };
        if (!navigationDrain) {
            navigationDrain = drainNavigationQueue();
        }
        return navigationDrain;
    }

    function unmountHandlerFor(viewId) {
        const map = {
            overview: () => global.MicOverviewView?.unmount?.(),
            'sales-dashboard': () => global.SalesDashboardView?.unmount?.(),
            'admin-settings': () => global.AdminSettingsView?.unmount?.(),
            'stock-count': () => global.StockCountView?.unmount?.(),
            'daily-stock-count': () => global.DailyStockCountView?.unmount?.(),
            'tacaudit-summary': () => global.TacauditView?.unmount?.(),
            'tacaudit-store': () => global.TacauditView?.unmount?.(),
        };
        return map[viewId] || null;
    }

    function titleForRoute(route) {
        if (route.id === 'overview') return 'Overview';
        if (route.id === 'sales-dashboard') return 'Sales Dashboard';
        if (route.id === 'admin-settings') return 'Admin Settings';
        if (route.id === 'stock-count') return 'Stock Count';
        if (route.id === 'tacaudit-store' || route.id === 'tacaudit-summary') return 'TacAudit';
        return 'Dashboard';
    }

    function isInternalLink(anchor) {
        if (!anchor || anchor.target === '_blank') return false;
        const href = anchor.getAttribute('href');
        if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) {
            return false;
        }
        try {
            const url = new URL(anchor.href, global.location.origin);
            if (url.origin !== global.location.origin) return false;
            if (url.pathname === '/login' || url.pathname.startsWith('/kiosk')) return false;
            return Boolean(matchRoute(url.pathname.replace(/\/+$/, '') || '/').id);
        } catch {
            return false;
        }
    }

    function installLinkInterceptor() {
        document.addEventListener('click', (event) => {
            const anchor = event.target.closest('a[href]');
            if (!isInternalLink(anchor)) return;
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            const url = new URL(anchor.href, global.location.origin);
            navigate(url.pathname, { search: url.search, hash: url.hash });
        });
    }

    function prefetchAdjacent(route) {
        if (route.id !== 'overview') return;
        loadScriptChain(SHARED_DASHBOARD_SCRIPTS).catch(() => {});
    }

    function installHoverPrefetch() {
        document.addEventListener(
            'mouseenter',
            (event) => {
                const anchor = event.target.closest('a[href]');
                if (!isInternalLink(anchor)) return;
                const url = new URL(anchor.href, global.location.origin);
                const next = matchRoute(url.pathname);
                if (next.id === 'sales-dashboard') {
                    loadScriptChain(SHARED_DASHBOARD_SCRIPTS).catch(() => {});
                }
            },
            true
        );
    }

    function fetchBootMeta() {
        const apply = (meta) => {
            bootId = meta?.bootId || bootId || '';
        };
        if (global.DashboardMeta?.fetchMeta) {
            return global.DashboardMeta.fetchMeta().then(apply).catch(() => {
                bootId = bootId || '';
            });
        }
        return fetch('/api/dashboard/meta', {
            credentials: 'same-origin',
            cache: 'no-store',
        })
            .then((res) => res.json().catch(() => ({})))
            .then(apply)
            .catch(() => {
                bootId = bootId || '';
            });
    }

    async function boot() {
        // Do not block first paint on meta — use Date.now() until bootId arrives.
        void fetchBootMeta();
        installLinkInterceptor();
        installHoverPrefetch();
        global.addEventListener('popstate', () => {
            const path = global.location.pathname;
            navigate(path, { replace: true, search: global.location.search, hash: global.location.hash });
        });
        const target = maybeCanonicalizeAdminPath(
            parseShellTarget(
                global.location.pathname,
                global.location.search,
                global.location.hash
            )
        );
        setShellRoute(target.pathname, target.search, target.hash);
        const route = matchRoute(target.pathname);
        document.title = titleForRoute(route);
        await navigate(target.pathname, { replace: true, search: target.search, hash: target.hash });
    }

    global.AppShell = {
        navigate,
        boot,
        ensureAdminDeferredScripts,
        ensureAdminScriptsForSection,
        shellPathname,
        shellSearch,
        setShellRoute,
        matchRoute,
        prefetchScripts: loadScriptChain,
    };

    if (document.documentElement.dataset.shellNav === '1') {
        boot().catch((err) => {
            console.error('[AppShell] boot failed:', err);
            const app = getAppEl();
            if (app) app.textContent = err?.message || 'Could not start application shell.';
        });
    }
})(window);
