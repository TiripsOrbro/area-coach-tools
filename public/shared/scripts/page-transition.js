/**
 * Fade between store picker and store/area dashboards (sessionStorage handoff).
 */
(function pageTransitionModule(global) {
    const KEY = 'dashboard-nav-transition';
    const FROM_STORES = 'from-stores';
    const FROM_DASHBOARD = 'from-dashboard';
    const FROM_PICKER_KEY = 'dashboard-from-picker';
    const EXIT_MS = 420;

    function prefersReducedMotion() {
        return global.matchMedia('(prefers-reduced-motion: reduce)').matches;
    }

    function markFromStores() {
        try {
            sessionStorage.setItem(KEY, FROM_STORES);
        } catch {
            /* ignore */
        }
    }

    function markFromDashboard() {
        try {
            sessionStorage.setItem(KEY, FROM_DASHBOARD);
        } catch {
            /* ignore */
        }
    }

    function consumeFromStores() {
        try {
            if (sessionStorage.getItem(KEY) !== FROM_STORES) return false;
            sessionStorage.removeItem(KEY);
            return true;
        } catch {
            return false;
        }
    }

    function consumeFromDashboard() {
        try {
            if (sessionStorage.getItem(KEY) !== FROM_DASHBOARD) return false;
            sessionStorage.removeItem(KEY);
            return true;
        } catch {
            return false;
        }
    }

    function markCameFromStorePicker() {
        try {
            sessionStorage.setItem(FROM_PICKER_KEY, '1');
        } catch {
            /* ignore */
        }
    }

    function clearCameFromStorePicker() {
        try {
            sessionStorage.removeItem(FROM_PICKER_KEY);
        } catch {
            /* ignore */
        }
    }

    function navigateTo(url) {
        const dest = String(url || '').trim();
        if (!dest) return;
        if (prefersReducedMotion()) {
            global.location.href = dest;
            return;
        }
        markFromStores();
        document.body.classList.add('page-nav-fade-out');
        global.setTimeout(() => {
            global.location.href = dest;
        }, EXIT_MS);
    }

    function navigateBackToStores(url = '/overview') {
        const dest = String(url || '/overview').trim() || '/overview';
        clearCameFromStorePicker();
        if (prefersReducedMotion()) {
            global.location.href = dest;
            return;
        }
        markFromDashboard();
        document.body.classList.add('page-nav-fade-out');
        global.setTimeout(() => {
            global.location.href = dest;
        }, EXIT_MS);
    }

    function isDashboardLink(anchor) {
        if (!anchor || anchor.target === '_blank') return false;
        const href = anchor.getAttribute('href');
        if (!href || href.startsWith('#')) return false;
        if (anchor.classList.contains('store-tile--empty-area')) return false;
        if (!anchor.classList.contains('store-tile')) return false;
        try {
            const path = new URL(anchor.href, global.location.origin).pathname;
            if (path === '/overview' || path === '/stores') return false;
            if (/^\/(teststore|\d{3,6})\/?$/i.test(path)) return true;
            if (/^\/(area\/[^/]+|a\d+)\/?$/i.test(path)) return true;
        } catch {
            return false;
        }
        return false;
    }

    function installStoreLinkFade(root) {
        const el = root || document;
        el.addEventListener('click', (event) => {
            const anchor = event.target.closest('a.store-tile');
            if (!isDashboardLink(anchor)) return;
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            navigateTo(anchor.href);
        });
    }

    function resetNavTransitionState() {
        document.documentElement.classList.remove('page-nav-enter-pending');
        document.body.classList.remove('page-nav-fade-out', 'page-nav-fade-in', 'page-nav-fade-in--visible');
    }

    function runEnterFade() {
        if (prefersReducedMotion()) return;
        document.body.classList.add('page-nav-fade-in');
        global.requestAnimationFrame(() => {
            global.requestAnimationFrame(() => {
                document.body.classList.add('page-nav-fade-in--visible');
            });
        });
    }

    function initEnterFade() {
        if (!consumeFromStores()) return;
        markCameFromStorePicker();
        resetNavTransitionState();
        runEnterFade();
    }

    function initStoresEnterFade() {
        if (!consumeFromDashboard()) return;
        resetNavTransitionState();
        runEnterFade();
    }

    /** Back/forward restores bfcache with fade-out still on body - clear or fade in. */
    function installPageshowReset() {
        global.addEventListener('pageshow', (event) => {
            const stuckOnExit = document.body.classList.contains('page-nav-fade-out');
            if (stuckOnExit) {
                resetNavTransitionState();
                return;
            }
            if (event.persisted) {
                try {
                    if (sessionStorage.getItem(KEY) === FROM_DASHBOARD) {
                        initStoresEnterFade();
                        return;
                    }
                } catch {
                    /* ignore */
                }
                resetNavTransitionState();
            }
        });
    }

    /** When leaving a store dashboard opened from the picker (incl. browser back). */
    function installDashboardPagehide() {
        global.addEventListener('pagehide', () => {
            try {
                if (sessionStorage.getItem(FROM_PICKER_KEY) === '1') {
                    sessionStorage.setItem(KEY, FROM_DASHBOARD);
                    sessionStorage.removeItem(FROM_PICKER_KEY);
                }
            } catch {
                /* ignore */
            }
        });
    }

    /** Call from an inline <head> script on dashboard pages to avoid a flash before CSS loads. */
    function markEnterPendingInHtml() {
        try {
            if (sessionStorage.getItem(KEY) === FROM_STORES) {
                document.documentElement.classList.add('page-nav-enter-pending');
            }
        } catch {
            /* ignore */
        }
    }

    installPageshowReset();

    global.DashboardPageTransition = {
        KEY,
        FROM_STORES,
        FROM_DASHBOARD,
        markFromStores,
        consumeFromStores,
        navigateTo,
        navigateBackToStores,
        installStoreLinkFade,
        initEnterFade,
        initStoresEnterFade,
        markEnterPendingInHtml,
        installDashboardPagehide,
        resetNavTransitionState,
    };
})(window);
