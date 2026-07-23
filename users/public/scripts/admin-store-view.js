/**
 * Admin "view dashboard as store user" — session preference + overview header selector.
 */
(function (global) {
    const ENABLED_KEY = 'admin-view-as-store-enabled';
    const STORE_KEY = 'admin-view-as-store';
    const HEADER_DEFAULT_VALUE = '__all__';

    let meProfile = null;
    let cachedStoreOptions = [];

    function canUse(profile) {
        const p = profile || meProfile;
        if (!p) return false;
        const scope = p.overviewScope;
        return scope === 'super' || scope === 'market' || scope === 'area';
    }

    function isEnabled() {
        try {
            return sessionStorage.getItem(ENABLED_KEY) === '1';
        } catch {
            return false;
        }
    }

    function getSelectedStore() {
        try {
            return String(sessionStorage.getItem(STORE_KEY) || '').trim();
        } catch {
            return '';
        }
    }

    function setEnabled(enabled) {
        try {
            if (enabled) sessionStorage.setItem(ENABLED_KEY, '1');
            else sessionStorage.removeItem(ENABLED_KEY);
        } catch {
            /* ignore */
        }
        syncHeaderStoreButton();
        global.dispatchEvent(new CustomEvent('admin-store-view-change'));
    }

    function setStore(storeNumber) {
        const store = String(storeNumber || '').trim();
        try {
            if (store) sessionStorage.setItem(STORE_KEY, store);
            else sessionStorage.removeItem(STORE_KEY);
        } catch {
            /* ignore */
        }
        syncHeaderStoreButton();
        global.dispatchEvent(new CustomEvent('admin-store-view-change'));
    }

    function asStoreNumbers(list) {
        if (!list) return [];
        if (Array.isArray(list)) return list.map(String);
        return [String(list)];
    }

    function resolveStoreForOverview(profile) {
        if (!canUse(profile)) return '';
        if (!isEnabled()) return '';
        const store = getSelectedStore();
        if (!store) return '';
        const allowed = new Set(asStoreNumbers(profile?.effectiveStores));
        if (allowed.size && !allowed.has(String(store))) return '';
        return store;
    }

    function isActiveOnOverview(profile) {
        return Boolean(resolveStoreForOverview(profile));
    }

    function storeLabel(storeNumber) {
        const num = String(storeNumber || '').trim();
        return num ? `Store ${num}` : 'No store selected';
    }

    function headerStoreButtonLabel() {
        if (!isEnabled()) return 'Default all stores';
        const store = getSelectedStore();
        if (!store) return 'Default all stores';
        const row = cachedStoreOptions.find((entry) => entry.storeNumber === store);
        return row?.label || storeLabel(store);
    }

    function applyAndReload({ enabled, storeNumber } = {}) {
        if (enabled !== undefined) setEnabled(Boolean(enabled));
        if (storeNumber !== undefined) setStore(storeNumber);
        global.location.reload();
    }

    async function buildHeaderStorePopupGroups() {
        const stores = await loadStoreOptions();
        cachedStoreOptions = stores;
        const defaultGroup = {
            label: 'Overview',
            items: [{ value: HEADER_DEFAULT_VALUE, label: 'Default all stores' }],
        };

        try {
            const tree = await global.AdminScopePicker?.loadScopeTree?.();
            if (tree && global.ScopePopup?.groupsFromScopeTree) {
                const filtered = global.AdminScopePicker.filterScopeTreeForStores(
                    tree,
                    stores.map((row) => ({ storeNumber: row.storeNumber }))
                );
                const areaGroups = global.ScopePopup.groupsFromScopeTree(filtered, { kind: 'store' });
                if (areaGroups.length) return [defaultGroup, ...areaGroups];
            }
        } catch {
            /* ignore */
        }

        if (stores.length) {
            return [
                defaultGroup,
                {
                    label: 'Stores',
                    items: stores.map((row) => ({
                        value: row.storeNumber,
                        label: row.label || row.storeNumber,
                    })),
                },
            ];
        }
        return [defaultGroup];
    }

    async function openHeaderStorePicker() {
        const groups = await buildHeaderStorePopupGroups();
        const activeStore = isEnabled() ? getSelectedStore() : '';
        const selected = activeStore || HEADER_DEFAULT_VALUE;

        global.ScopePopup?.open({
            title: 'Select store',
            hint: 'Preview the overview as a single store, or return to the default area view.',
            groups,
            selected,
            selectOnClick: true,
            onSelect: (item) => {
                const value = String(item?.value ?? item?.storeNumber ?? '').trim();
                if (!value || value === HEADER_DEFAULT_VALUE) {
                    applyAndReload({ enabled: false, storeNumber: '' });
                    return;
                }
                applyAndReload({ enabled: true, storeNumber: value });
            },
        });
    }

    function formatStoreOptionLabel(row) {
        const num = String(row?.storeNumber || '').trim();
        const name = String(row?.storeName || '').trim();
        if (!num) return '';
        return name && name !== num ? `${num} - ${name}` : num;
    }

    async function loadStoreOptions() {
        const allowed = new Set(asStoreNumbers(meProfile?.effectiveStores));
        try {
            const tree = await global.AdminScopePicker?.loadScopeTree?.();
            if (tree) {
                const flat = [];
                const seen = new Set();
                for (const rows of Object.values(tree.storesByArea || {})) {
                    for (const row of rows || []) {
                        const num = String(row.storeNumber || '').trim();
                        if (!num || seen.has(num)) continue;
                        if (allowed.size && !allowed.has(num)) continue;
                        seen.add(num);
                        flat.push({
                            storeNumber: num,
                            label: formatStoreOptionLabel(row),
                        });
                    }
                }
                flat.sort((a, b) =>
                    a.storeNumber.localeCompare(b.storeNumber, undefined, { numeric: true })
                );
                if (flat.length) return flat;
            }
        } catch {
            /* ignore */
        }
        return [...allowed]
            .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
            .map((num) => ({ storeNumber: num, label: storeLabel(num) }));
    }

    function syncHeaderStoreButton(btnEl) {
        const btn = btnEl || document.getElementById('mic-header-store-select');
        if (!btn) return;
        btn.textContent = headerStoreButtonLabel();
        const activeStore = isEnabled() ? getSelectedStore() : '';
        btn.setAttribute('aria-pressed', activeStore ? 'true' : 'false');
        document.body.classList.toggle('mic-store-view-active', Boolean(activeStore));
    }

    function wireHeaderStoreButton(btn) {
        if (!btn || btn.dataset.storeSelectWired) return;
        btn.dataset.storeSelectWired = '1';
        btn.addEventListener('click', () => {
            void openHeaderStorePicker();
        });
    }

    function mountHeaderSelector() {
        if (!canUse(meProfile)) return;
        const host =
            document.getElementById('mic-header-store-slot') ||
            document.querySelector('.mic-header--admin .mic-header-actions');
        if (!host) return;

        let wrap = document.getElementById('mic-header-store-select-wrap');
        if (!wrap) {
            wrap = document.createElement('div');
            wrap.id = 'mic-header-store-select-wrap';
            wrap.className = 'mic-header-store-select-wrap';
            wrap.innerHTML = `
                <button
                    type="button"
                    id="mic-header-store-select"
                    class="mic-header-store-select scope-popup-trigger"
                    aria-label="Select store"
                    aria-haspopup="dialog"
                >Default all stores</button>`;
            host.appendChild(wrap);
        }

        const btn = wrap.querySelector('#mic-header-store-select');
        wireHeaderStoreButton(btn);
        void loadStoreOptions().then(() => syncHeaderStoreButton(btn));
    }

    async function init(profile) {
        meProfile = profile || meProfile;
    }

    function afterShellRendered(profile) {
        meProfile = profile || meProfile;
        if (!canUse(meProfile)) return;
        mountHeaderSelector();
    }

    global.AdminStoreView = {
        init,
        afterShellRendered,
        canUse,
        isEnabled,
        getSelectedStore,
        resolveStoreForOverview,
        isActiveOnOverview,
        mountHeaderSelector,
        applyAndReload,
    };
})(window);
