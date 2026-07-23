/**
 * Admin store dashboard - /Admin/qld-1|vic-1|wa-1 with in-page store switching.
 */
(function (global) {
    const MOBILE_MAX = 900;
    const ADMIN_AREAS = ['VIC-1', 'WA-1', 'QLD-1'];

    function areaLabel(name) {
        return global.AreaDisplay?.label?.(name) ?? String(name ?? '').trim();
    }

    function shellPath() {
        return global.__SHELL_ROUTE__?.pathname ?? global.location.pathname;
    }

    function isAdminAreaPath() {
        return /^\/Admin\/(qld-1|vic-1|wa-1|A\d+)\/?$/i.test(shellPath());
    }

    function isLegacyAdminStorePath() {
        return /^\/Admin\/(teststore|\d{3,6})\/?$/i.test(global.location.pathname);
    }

    function isAdminStorePath() {
        return isAdminAreaPath() || isLegacyAdminStorePath();
    }

    function areaSlugFromName(name) {
        return normalizeAreaKey(name);
    }

    function areaCodeFromName(name) {
        return areaSlugFromName(name);
    }

    function areaFromPath() {
        const slugMatch = shellPath().match(/^\/Admin\/(qld-1|vic-1|wa-1)\/?$/i);
        if (slugMatch) return String(slugMatch[1]).toLowerCase();
        const legacyMatch = shellPath().match(/^\/Admin\/A(\d+)\/?$/i);
        if (legacyMatch) {
            const legacyMap = { 1: 'qld-1', 2: 'qld-1', 21: 'vic-1', 22: 'vic-1' };
            return legacyMap[Number(legacyMatch[1])] || '';
        }
        return '';
    }

    function storeFromPath() {
        const m = global.location.pathname.match(/^\/Admin\/(teststore|\d{3,6})\/?$/i);
        return m ? String(m[1]).toLowerCase() : '';
    }

    function escapeHtml(text) {
        return String(text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function normalizeAreaKey(value) {
        return String(value || '')
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/(^-|-$)/g, '');
    }

    function storeTabId(store) {
        if (!store) return '';
        if (store.testStore) return 'teststore';
        return String(store.storeNumber || '').replace(/[^0-9]/g, '');
    }

    function areaKeyForStore(store) {
        if (!store) return '';
        if (store.testStore) return 'test-store';
        return store.areaKey || normalizeAreaKey(store.area || '');
    }

    function activeAreaKey(stores, activeStore, areaCode) {
        if (areaCode) {
            const legacy = String(areaCode).match(/^A(\d+)$/i);
            if (legacy) {
                const legacyMap = { 1: 'qld-1', 2: 'qld-1', 21: 'vic-1', 22: 'vic-1' };
                return legacyMap[Number(legacy[1])] || normalizeAreaKey(areaCode);
            }
            return normalizeAreaKey(areaCode);
        }
        const active = String(activeStore || storeFromPath()).toLowerCase();
        if (active === 'teststore') return 'test-store';
        const entry = stores.find((s) => storeTabId(s) === active);
        return entry ? areaKeyForStore(entry) : '';
    }

    function storesInArea(stores, areaName) {
        const key = normalizeAreaKey(areaName);
        return sortStores((stores || []).filter((s) => !s.testStore && areaKeyForStore(s) === key));
    }

    function areaHref(areaName) {
        const slug = areaSlugFromName(areaName);
        if (slug) {
            return global.AppPaths?.adminArea?.(slug, { view: 'area' }) || `/Admin/${slug}?view=area`;
        }
        return global.AppPaths?.overview?.() || '/overview';
    }

    function filterStoresForActiveArea(stores, activeStore, areaCode) {
        const list = Array.isArray(stores) ? stores.filter((s) => s && (s.storeNumber || s.testStore)) : [];
        const active = String(activeStore || '').toLowerCase();

        if (isAdminAreaPath() && areaCode) {
            const key = activeAreaKey(stores, activeStore, areaCode);
            return list.filter((s) => !s.testStore && areaKeyForStore(s) === key);
        }

        if (active === 'teststore') {
            return list.filter((s) => s.testStore);
        }

        const activeEntry = list.find((s) => storeTabId(s) === active);
        if (!activeEntry) {
            return list.filter((s) => !s.testStore);
        }

        const areaKey = areaKeyForStore(activeEntry);
        return list.filter((s) => {
            if (s.testStore) return false;
            return areaKeyForStore(s) === areaKey;
        });
    }

    function sortStores(stores) {
        return [...stores].sort((a, b) =>
            String(a.storeNumber).localeCompare(String(b.storeNumber), undefined, { numeric: true })
        );
    }

    function legacyTabHref(storeNumber) {
        const num = String(storeNumber || '').trim();
        return num
            ? global.AppPaths?.adminStore?.(num) || `/Admin/${encodeURIComponent(num)}`
            : global.AppPaths?.overview?.() || '/overview';
    }

    function tabLabel(store) {
        if (store.testStore) return 'Test';
        return String(store.storeNumber || '').replace(/[^0-9]/g, '');
    }

    function mobileTabLabel(store) {
        if (!store) return 'Store';
        if (store.testStore) return store.storeName || 'Test Store';
        const num = tabLabel(store);
        const name = String(store.storeName || '').trim();
        if (name && name !== num) return name;
        return num || 'Store';
    }

    function activePickerLabel(stores, activeStore) {
        if (areaTotalsViewActive) return 'Area';
        const active = String(activeStore || '').toLowerCase();
        const current = stores.find((s) => storeTabId(s) === active);
        if (!current) return 'Select store';
        return mobileTabLabel(current);
    }

    let areaTotalsViewActive = false;

    function renderAreaTabs(stores, activeStore, areaCode) {
        const currentKey = activeAreaKey(stores, activeStore, areaCode);
        const parts = [];
        ADMIN_AREAS.forEach((name, idx) => {
            const key = normalizeAreaKey(name);
            const isActive = key === currentKey;
            const href = areaHref(name);
            if (isActive) {
                parts.push(
                    `<button type="button" class="admin-area-tab is-active${areaTotalsViewActive ? ' is-area-totals-view' : ''}" role="tab" aria-selected="true" data-area-totals-view aria-pressed="${areaTotalsViewActive ? 'true' : 'false'}">${escapeHtml(areaLabel(name))}</button>`
                );
            } else {
                parts.push(
                    `<a class="admin-area-tab" role="tab" href="${escapeHtml(href)}" data-area-name="${escapeHtml(name)}">${escapeHtml(areaLabel(name))}</a>`
                );
            }
            if (idx < ADMIN_AREAS.length - 1) {
                parts.push('<span class="admin-area-tab-pipe" aria-hidden="true">|</span>');
            }
        });
        return parts.join('');
    }

    function renderAreaTotalsTab(useInPageSwitch) {
        if (!useInPageSwitch) return '';
        const cls = `admin-store-tabs__tab admin-store-tabs__tab--area${areaTotalsViewActive ? ' is-active' : ''}`;
        return `<button type="button" class="${cls}" data-area-totals-tab role="tab"${
            areaTotalsViewActive ? ' aria-current="page"' : ''
        } aria-selected="${areaTotalsViewActive ? 'true' : 'false'}"><span class="admin-store-tabs__num">Area</span></button>`;
    }

    function renderAreaTotalsMenuItem(useInPageSwitch) {
        if (!useInPageSwitch) return '';
        const cls = `admin-store-tabs__menu-item admin-store-tabs__menu-item--area${
            areaTotalsViewActive ? ' is-active' : ''
        }`;
        return `<button type="button" class="${cls}" data-area-totals-tab role="option"${
            areaTotalsViewActive ? ' aria-current="page"' : ''
        }>Area dashboard</button>`;
    }

    function renderStoreTabControl(store, activeStore, useInPageSwitch) {
        const num = storeTabId(store);
        if (!num) return '';
        const active = String(activeStore || '').toLowerCase();
        const isActive = !areaTotalsViewActive && num === active;
        const label = tabLabel(store);
        const cls = `admin-store-tabs__tab${isActive ? ' is-active' : ''}`;
        if (useInPageSwitch) {
            return `<button type="button" class="${cls}" data-store-select="${escapeHtml(num)}"${
                isActive ? ' aria-current="page"' : ''
            } role="tab"><span class="admin-store-tabs__num">${escapeHtml(label)}</span></button>`;
        }
        return `<a class="${cls}" href="${escapeHtml(legacyTabHref(num))}"${
            isActive ? ' aria-current="page"' : ''
        } role="tab"><span class="admin-store-tabs__num">${escapeHtml(label)}</span></a>`;
    }

    function renderMenuControl(store, activeStore, useInPageSwitch) {
        const num = storeTabId(store);
        if (!num) return '';
        const active = String(activeStore || '').toLowerCase();
        const isActive = !areaTotalsViewActive && num === active;
        const label = mobileTabLabel(store);
        const cls = `admin-store-tabs__menu-item${isActive ? ' is-active' : ''}`;
        if (useInPageSwitch) {
            return `<button type="button" class="${cls}" data-store-select="${escapeHtml(num)}"${
                isActive ? ' aria-current="page"' : ''
            } role="option">${escapeHtml(label)}</button>`;
        }
        return `<a class="${cls}" href="${escapeHtml(legacyTabHref(num))}"${
            isActive ? ' aria-current="page"' : ''
        } role="option">${escapeHtml(label)}</a>`;
    }

    function renderTabs(stores, activeStore, areaCode) {
        const useInPageSwitch = isAdminAreaPath();
        const filtered = sortStores(filterStoresForActiveArea(stores, activeStore, areaCode));
        const active = activeStore || storeFromPath();
        const areaTab = renderAreaTotalsTab(useInPageSwitch);
        const items =
            areaTab + filtered.map((s) => renderStoreTabControl(s, active, useInPageSwitch)).join('');
        const menuItems =
            renderAreaTotalsMenuItem(useInPageSwitch) +
            filtered.map((s) => renderMenuControl(s, active, useInPageSwitch)).join('');
        const pickerLabel = escapeHtml(activePickerLabel(filtered, active));

        return `
            <div class="admin-store-chrome">
                <nav class="admin-area-tabs admin-store-area-tabs" role="tablist" aria-label="Select area">
                    ${renderAreaTabs(stores, active, areaCode)}
                </nav>
                <nav class="admin-store-tabs" aria-label="Switch store">
                    <div class="admin-store-tabs__scroll" role="tablist">${items}</div>
                    <div class="admin-store-tabs__mobile">
                        <button
                            type="button"
                            class="admin-store-tabs__picker-btn"
                            aria-expanded="false"
                            aria-haspopup="listbox"
                            aria-controls="admin-store-tabs-menu"
                        >
                            <span class="admin-store-tabs__picker-label">${pickerLabel}</span>
                        </button>
                        <div
                            id="admin-store-tabs-menu"
                            class="admin-store-tabs__menu"
                            role="listbox"
                            hidden
                        >${menuItems}</div>
                    </div>
                </nav>
            </div>`;
    }

    function positionMobileMenu(btn, menu) {
        const rect = btn.getBoundingClientRect();
        const isMobile = window.matchMedia(`(max-width: ${MOBILE_MAX}px)`).matches;
        menu.style.position = 'fixed';
        menu.style.top = `${Math.round(rect.bottom + 6)}px`;
        menu.style.right = 'auto';
        if (isMobile) {
            const menuWidth = Math.min(320, Math.max(240, global.innerWidth - 32));
            menu.style.left = `${Math.round((global.innerWidth - menuWidth) / 2)}px`;
            menu.style.width = `${menuWidth}px`;
        } else {
            menu.style.left = `${Math.round(rect.left)}px`;
            menu.style.width = `${Math.round(rect.width)}px`;
        }
    }

    function clearMobileMenuPosition(menu) {
        menu.style.position = '';
        menu.style.top = '';
        menu.style.left = '';
        menu.style.width = '';
        menu.style.right = '';
    }

    function closeMobileMenu(bar) {
        const btn = bar.querySelector('.admin-store-tabs__picker-btn');
        const menu = bar.querySelector('.admin-store-tabs__menu');
        const nav = bar.querySelector('.admin-store-tabs');
        if (!btn || !menu) return;
        menu.hidden = true;
        btn.setAttribute('aria-expanded', 'false');
        nav?.classList.remove('admin-store-tabs--menu-open');
        clearMobileMenuPosition(menu);
    }

    function openMobileMenu(bar) {
        const btn = bar.querySelector('.admin-store-tabs__picker-btn');
        const menu = bar.querySelector('.admin-store-tabs__menu');
        const nav = bar.querySelector('.admin-store-tabs');
        if (!btn || !menu) return;
        positionMobileMenu(btn, menu);
        menu.hidden = false;
        btn.setAttribute('aria-expanded', 'true');
        nav?.classList.add('admin-store-tabs--menu-open');
    }

    function bindMobilePicker(bar) {
        if (bar.dataset.mobilePickerBound) return;
        bar.dataset.mobilePickerBound = '1';

        let ignoreOutsideClose = false;

        bar.addEventListener('click', (e) => {
            const btn = e.target.closest('.admin-store-tabs__picker-btn');
            if (!btn || !bar.contains(btn)) return;
            e.preventDefault();
            e.stopPropagation();
            const menu = bar.querySelector('.admin-store-tabs__menu');
            if (!menu) return;
            const willOpen = menu.hidden;
            if (willOpen) {
                openMobileMenu(bar);
                ignoreOutsideClose = true;
                window.setTimeout(() => {
                    ignoreOutsideClose = false;
                }, 300);
            } else {
                closeMobileMenu(bar);
            }
        });

        bar.addEventListener('click', (e) => {
            const pick = e.target.closest('[data-store-select]');
            if (pick) {
                e.preventDefault();
                const storeNum = pick.getAttribute('data-store-select');
                if (storeNum && global.AdminAreaDashboard?.selectStore) {
                    global.AdminAreaDashboard.selectStore(storeNum);
                }
                closeMobileMenu(bar);
                return;
            }
            if (e.target.closest('.admin-store-tabs__menu-item')) closeMobileMenu(bar);
        });

        bar.addEventListener('click', (e) => {
            const areaTotalsBtn = e.target.closest('[data-area-totals-view]');
            if (areaTotalsBtn) {
                e.preventDefault();
                if (areaTotalsViewActive) {
                    global.AdminAreaDashboard?.showStoreView?.();
                } else {
                    void global.AdminAreaDashboard?.showAreaTotals?.();
                }
                return;
            }
            const areaTotalsTab = e.target.closest('[data-area-totals-tab]');
            if (areaTotalsTab) {
                e.preventDefault();
                if (!areaTotalsViewActive) void global.AdminAreaDashboard?.showAreaTotals?.();
                return;
            }
            const tab = e.target.closest('.admin-store-tabs__tab[data-store-select]');
            if (!tab) return;
            e.preventDefault();
            const storeNum = tab.getAttribute('data-store-select');
            if (storeNum && global.AdminAreaDashboard?.selectStore) {
                global.AdminAreaDashboard.selectStore(storeNum);
            }
        });

        document.addEventListener('click', (e) => {
            if (ignoreOutsideClose) return;
            if (!bar.contains(e.target)) closeMobileMenu(bar);
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') closeMobileMenu(bar);
        });

        window.addEventListener(
            'resize',
            () => {
                const menu = bar.querySelector('.admin-store-tabs__menu');
                const btn = bar.querySelector('.admin-store-tabs__picker-btn');
                if (!menu || menu.hidden || !btn) return;
                positionMobileMenu(btn, menu);
            },
            { passive: true }
        );
    }

    let cachedStores = [];
    let cachedAreaCode = '';
    let cachedActiveStore = '';

    function paintTabs(activeStore) {
        if (activeStore) cachedActiveStore = String(activeStore).toLowerCase();
        const bar = document.getElementById('admin-store-tabs');
        if (!bar) return;
        bar.innerHTML = renderTabs(cachedStores, cachedActiveStore, cachedAreaCode);
        bindMobilePicker(bar);
        bar.querySelector('.admin-store-tabs__tab.is-active')?.scrollIntoView({
            inline: 'center',
            block: 'nearest',
            behavior: 'smooth',
        });
    }

    async function mountAdminStoreTabs(activeStore, options = {}) {
        if (!isAdminStorePath()) return;
        const dashboard = document.querySelector('.dashboard');
        if (!dashboard) return;

        cachedAreaCode = options.areaCode || areaFromPath();
        if (Array.isArray(options.stores) && options.stores.length) {
            cachedStores = options.stores;
        }

        let bar = document.getElementById('admin-store-tabs');
        if (!bar) {
            bar = document.createElement('div');
            bar.id = 'admin-store-tabs';
            const pickerHost = document.getElementById('dashboard-header-store-picker');
            if (pickerHost) {
                pickerHost.appendChild(bar);
            } else {
                const backHost = document.getElementById('admin-store-nav-back');
                if (backHost?.nextSibling) {
                    dashboard.insertBefore(bar, backHost.nextSibling);
                } else {
                    dashboard.prepend(bar);
                }
            }
        }

        bar.innerHTML = '<div class="admin-store-tabs__loading">Loading stores…</div>';

        try {
            const res = await fetch('/api/stores', { credentials: 'same-origin' });
            const data = await res.json();
            if (Array.isArray(data.stores) && data.stores.length) {
                cachedStores = data.stores;
            }
            const current = activeStore || storeFromPath();
            paintTabs(current);
        } catch {
            if (!cachedStores.length) cachedStores = [];
            paintTabs(activeStore || storeFromPath());
        }
    }

    function refreshFromAreaSales(areaStores, activeStore, areaCode) {
        if (!isAdminAreaPath()) return;
        cachedAreaCode = areaCode || cachedAreaCode || areaFromPath();
        if (Array.isArray(areaStores) && areaStores.length) {
            const key = normalizeAreaKey(
                areaCodeFromName(`Area ${String(cachedAreaCode).replace(/^A/i, '')}`)
            );
            cachedStores = areaStores.map((slice) => ({
                storeNumber: slice.storeNumber,
                storeName: slice.storeName || slice.storeNumber,
                area: `Area ${String(cachedAreaCode).replace(/^A/i, '')}`,
                areaKey: key,
            }));
        }
        paintTabs(activeStore || storeFromPath());
    }

    function updateActiveStore(activeStore) {
        if (!isAdminAreaPath()) return;
        paintTabs(activeStore);
    }

    function setViewMode(mode) {
        areaTotalsViewActive = mode === 'area';
        paintTabs(cachedActiveStore);
    }

    global.AdminStoreTabs = {
        isAdminStorePath,
        isAdminAreaPath,
        isLegacyAdminStorePath,
        storeFromPath,
        areaFromPath,
        areaHref,
        areaCodeFromName,
        filterStoresForActiveArea,
        mount: mountAdminStoreTabs,
        updateActiveStore,
        refreshFromAreaSales,
        setViewMode,
        mobileMaxWidth: MOBILE_MAX,
        adminAreas: ADMIN_AREAS,
    };

    document.addEventListener('click', (e) => {
        if (!isAdminAreaPath()) return;
        const areaStoreTab = e.target.closest('#admin-store-tabs [data-area-totals-tab]');
        if (areaStoreTab) {
            e.preventDefault();
            if (!areaTotalsViewActive) void global.AdminAreaDashboard?.showAreaTotals?.();
            return;
        }
        const areaTotalsBtn = e.target.closest('#admin-store-tabs [data-area-totals-view]');
        if (!areaTotalsBtn) return;
        e.preventDefault();
        if (areaTotalsViewActive) {
            global.AdminAreaDashboard?.showStoreView?.();
        } else {
            void global.AdminAreaDashboard?.showAreaTotals?.();
        }
    });
})(window);
