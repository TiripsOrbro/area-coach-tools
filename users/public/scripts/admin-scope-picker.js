/**
 * Market / area / store scope picker - modal popup or inline chip rows.
 */
(function (global) {
    let backdrop = null;
    let escHandler = null;
    let scopeTree = null;
    let scopeTreePromise = null;
    let browseScope = { area: '', storeNumber: '' };

    function escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function escapeAttr(value) {
        return escapeHtml(value);
    }

    function asStoreRows(storeRows) {
        if (!storeRows) return [];
        if (Array.isArray(storeRows)) return storeRows;
        if (typeof storeRows === 'object') return Object.values(storeRows);
        return [storeRows];
    }

    function normalizeScopeTree(tree) {
        if (!tree || typeof tree !== 'object') {
            return { areas: [], storesByArea: {}, defaults: {} };
        }
        const storesByArea = {};
        if (tree.storesByArea && typeof tree.storesByArea === 'object') {
            for (const [area, stores] of Object.entries(tree.storesByArea)) {
                storesByArea[area] = Array.isArray(stores) ? stores : [];
            }
        }
        const areas = Array.isArray(tree.areas)
            ? tree.areas
            : Object.keys(storesByArea).filter((area) => storesByArea[area]?.length);
        return {
            areas,
            storesByArea,
            defaults: tree.defaults && typeof tree.defaults === 'object' ? tree.defaults : {},
        };
    }

    function resolveBrowseScope(tree, selections = {}, preferredStore = '') {
        tree = normalizeScopeTree(tree);
        let area = selections.area || '';
        let storeNumber = selections.storeNumber || '';

        const pref = String(preferredStore || '').trim();
        if (pref && !area && !storeNumber) {
            storeNumber = pref;
            for (const [areaName, stores] of Object.entries(tree.storesByArea || {})) {
                if (!stores.some((row) => row.storeNumber === storeNumber)) continue;
                area = areaName;
                break;
            }
        }

        const areas = tree.areas || [];
        if (area && !areas.includes(area)) area = '';
        if (!area && areas.length === 1) area = areas[0];
        if (!area && !storeNumber) {
            const ordered = orderedAreas(areas);
            if (ordered.length) area = ordered[0];
        }
        if (!area && tree.defaults?.area && areas.includes(tree.defaults.area)) area = tree.defaults.area;

        const stores = area ? tree.storesByArea[area] || [] : [];
        if (storeNumber && !stores.some((row) => row.storeNumber === storeNumber)) storeNumber = '';
        if (!storeNumber && stores.length === 1) storeNumber = stores[0].storeNumber;
        if (
            !storeNumber &&
            tree.defaults?.storeNumber &&
            stores.some((row) => row.storeNumber === tree.defaults.storeNumber)
        ) {
            storeNumber = tree.defaults.storeNumber;
        }
        if (!storeNumber && stores.length) storeNumber = stores[0].storeNumber;

        return { area, storeNumber };
    }

    function filterScopeTreeForStores(tree, storeRows) {
        tree = normalizeScopeTree(tree);
        const allowed = new Set(
            asStoreRows(storeRows)
                .map((row) => String(row.storeNumber || row).trim())
                .filter(Boolean)
        );
        if (!allowed.size) {
            return tree;
        }

        const storesByArea = {};
        for (const [area, stores] of Object.entries(tree.storesByArea || {})) {
            const filtered = (stores || []).filter((row) => allowed.has(String(row.storeNumber)));
            if (filtered.length) storesByArea[area] = filtered;
        }

        const areas = (tree.areas || Object.keys(storesByArea)).filter((area) => storesByArea[area]?.length);
        const defaults = { ...(tree.defaults || {}) };
        if (defaults.storeNumber && !allowed.has(String(defaults.storeNumber))) {
            defaults.storeNumber = '';
        }
        if (defaults.area && !storesByArea[defaults.area]?.length) defaults.area = '';

        return {
            ...tree,
            areas,
            storesByArea,
            defaults,
        };
    }

    function areaChipLabel(areaId) {
        const fromDisplay = global.AreaDisplay?.label?.(areaId);
        if (fromDisplay) return fromDisplay;
        const raw = String(areaId ?? '');
        return raw.replace(/-1$/i, '') || raw;
    }

    function orderedAreas(areas) {
        const canonical = ['VIC-1', 'WA-1', 'QLD-1'];
        const list = Array.isArray(areas) ? areas : [];
        const picked = canonical.filter((id) => list.includes(id));
        const rest = list.filter((id) => !canonical.includes(id));
        return picked.length ? picked : rest;
    }

    function renderBrowseScopeRow(scopePrefix, label, rows, selectedValue, getValue, getLabel) {
        const list = Array.isArray(rows) ? rows : [];
        const labelFn = getLabel || getValue;
        const colCount = Math.max(list.length, 1);
        const items = list
            .map((row) => {
                const value = getValue(row);
                const active = String(value) === String(selectedValue);
                return `
                    <button
                        type="button"
                        class="admin-accounts-scope-chip${active ? ' is-active' : ''}"
                        data-browse-scope="${escapeAttr(scopePrefix)}"
                        data-browse-value="${escapeAttr(value)}"
                        aria-pressed="${active ? 'true' : 'false'}"
                    >${escapeHtml(labelFn(row))}</button>`;
            })
            .join('');
        return `
            <div class="admin-accounts-scope-row-wrap">
                <span class="admin-accounts-scope-row-label">${escapeHtml(label)}</span>
                <div class="admin-accounts-scope-row admin-accounts-scope-row--equal" role="group" aria-label="${escapeAttr(label)}" style="--scope-cols: ${colCount};">${items}</div>
            </div>`;
    }

    function treeHasStores(tree) {
        return Object.values(tree?.storesByArea || {}).some((rows) => rows?.length > 0);
    }

    function buildCompactSelectNavigator(tree, scope, scopePrefix = 'browse') {
        tree = normalizeScopeTree(tree);
        const resolved = resolveBrowseScope(tree, scope, scope.storeNumber || '');
        const parts = [];

        const areas = orderedAreas(tree.areas || []);
        if (areas.length >= 1) {
            const options = areas
                .map((area) => {
                    const selected = String(area) === String(resolved.area);
                    return `<option value="${escapeAttr(area)}"${selected ? ' selected' : ''}>${escapeHtml(areaChipLabel(area))}</option>`;
                })
                .join('');
            parts.push(`
                <label class="admin-scope-picker-field">
                    <span class="admin-scope-picker-field-label">Area</span>
                    <select data-browse-scope="${escapeAttr(`${scopePrefix}-area`)}" aria-label="Area">${options}</select>
                </label>`);
        }

        const stores = resolved.area ? (tree.storesByArea || {})[resolved.area] || [] : [];
        if (stores.length >= 1) {
            const options = stores
                .map((row) => {
                    const selected = String(row.storeNumber) === String(resolved.storeNumber);
                    return `<option value="${escapeAttr(row.storeNumber)}"${selected ? ' selected' : ''}>${escapeHtml(String(row.storeNumber))}</option>`;
                })
                .join('');
            parts.push(`
                <label class="admin-scope-picker-field">
                    <span class="admin-scope-picker-field-label">Store</span>
                    <select data-browse-scope="${escapeAttr(`${scopePrefix}-store`)}" aria-label="Store">${options}</select>
                </label>`);
        }

        const finalScope = resolveBrowseScope(tree, resolved, '');
        return {
            html:
                parts.length > 0
                    ? `<div class="admin-scope-picker-compact">${parts.join('')}</div>`
                    : treeHasStores(tree)
                      ? ''
                      : '<p class="admin-scope-picker-empty">No stores available.</p>',
            scope: finalScope,
        };
    }

    function buildNavigatorRows(tree, scope, scopePrefix = 'browse', layout = 'chips') {
        tree = normalizeScopeTree(tree);
        const resolved = resolveBrowseScope(tree, scope, scope.storeNumber || '');
        const rows = [];

        const areas = orderedAreas(tree.areas || []);
        if (areas.length >= 1) {
            rows.push(
                renderBrowseScopeRow(
                    `${scopePrefix}-area`,
                    'Area',
                    areas,
                    resolved.area,
                    (row) => row,
                    (row) => areaChipLabel(row)
                )
            );
        }

        const stores = resolved.area ? (tree.storesByArea || {})[resolved.area] || [] : [];
        if (stores.length >= 1) {
            rows.push(
                renderBrowseScopeRow(
                    `${scopePrefix}-store`,
                    'Store',
                    stores,
                    resolved.storeNumber,
                    (row) => row.storeNumber,
                    (row) => String(row.storeNumber)
                )
            );
        }

        const finalScope = resolveBrowseScope(tree, resolved, '');
        return {
            html:
                rows.join('') ||
                (treeHasStores(tree)
                    ? ''
                    : '<p class="admin-scope-picker-empty">No stores available.</p>'),
            scope: finalScope,
        };
    }

    function storesMatchingScope(storeRows, tree, scope) {
        const list = storeRows || [];
        const { area, storeNumber } = scope || {};
        if (storeNumber) {
            return list.filter((row) => String(row.storeNumber) === String(storeNumber));
        }
        const allowed = new Set();
        if (area && tree?.storesByArea?.[area]) {
            tree.storesByArea[area].forEach((row) => allowed.add(String(row.storeNumber)));
        } else {
            return list;
        }
        return list.filter((row) => allowed.has(String(row.storeNumber)));
    }

    function mountInline(host, { tree, initialScope = {}, preferredStore = '', onChange, scopePrefix = 'inline', layout = 'chips' } = {}) {
        if (!host || !tree) return null;

        let scope = { area: '', storeNumber: '', ...initialScope };
        let treeRef = normalizeScopeTree(tree);
        let layoutMode = layout;

        function render() {
            if (preferredStore && !scope.storeNumber) {
                scope = resolveBrowseScope(treeRef, scope, preferredStore);
            }
            const built =
                layoutMode === 'select'
                    ? buildCompactSelectNavigator(treeRef, scope, scopePrefix)
                    : buildNavigatorRows(treeRef, scope, scopePrefix);
            scope = built.scope;
            host.innerHTML = built.html;
        }

        if (!host.dataset.scopeInlineWired) {
            host.dataset.scopeInlineWired = '1';
            host.addEventListener('click', (event) => {
                const chip = event.target.closest('[data-browse-scope]');
                if (!chip || chip.tagName === 'SELECT') return;
                const name = chip.dataset.browseScope || '';
                const value = chip.dataset.browseValue || '';
                if (name === `${scopePrefix}-area`) {
                    scope = { ...scope, area: value, storeNumber: '' };
                } else if (name === `${scopePrefix}-store`) {
                    scope = { ...scope, storeNumber: value };
                }
                render();
                onChange?.({ ...scope });
            });
            host.addEventListener('change', (event) => {
                const select = event.target.closest('select[data-browse-scope]');
                if (!select) return;
                const name = select.dataset.browseScope || '';
                const value = select.value || '';
                if (name === `${scopePrefix}-area`) {
                    scope = { ...scope, area: value, storeNumber: '' };
                } else if (name === `${scopePrefix}-store`) {
                    scope = { ...scope, storeNumber: value };
                }
                render();
                onChange?.({ ...scope });
            });
        }

        render();
        return {
            refresh(preferred) {
                if (preferred) preferredStore = preferred;
                render();
            },
            getScope() {
                return { ...scope };
            },
            setScope(next) {
                scope = { area: '', storeNumber: '', ...next };
                render();
            },
            setTree(nextTree) {
                treeRef = normalizeScopeTree(nextTree);
                render();
            },
        };
    }

    function ensureBackdrop() {
        if (backdrop) return backdrop;
        backdrop = document.createElement('div');
        backdrop.className = 'mic-item-picker admin-scope-picker';
        backdrop.hidden = true;
        backdrop.innerHTML = `
            <div class="mic-item-picker-panel admin-scope-picker-panel" role="dialog" aria-modal="true" aria-labelledby="admin-scope-picker-title">
                <h2 id="admin-scope-picker-title">Select store</h2>
                <p class="admin-scope-picker-hint" id="admin-scope-picker-hint"></p>
                <div id="admin-scope-picker-nav" class="admin-scope-picker-nav"></div>
                <div class="admin-scope-picker-actions">
                    <button type="button" class="mic-settings-btn admin-scope-picker-select" id="admin-scope-picker-select" disabled>Select store</button>
                    <button type="button" class="admin-scope-picker-cancel">Cancel</button>
                </div>
            </div>`;
        document.body.appendChild(backdrop);
        backdrop.addEventListener('click', (event) => {
            if (event.target === backdrop) close();
        });
        backdrop.querySelector('.admin-scope-picker-cancel')?.addEventListener('click', close);
        backdrop.querySelector('#admin-scope-picker-select')?.addEventListener('click', () => {
            const store = String(browseScope.storeNumber || '').trim();
            if (!store || !pendingOnSelect) return;
            const cb = pendingOnSelect;
            close();
            cb(store);
        });
        backdrop.addEventListener('click', (event) => {
            const chip = event.target.closest('[data-browse-scope]');
            if (!chip || !scopeTree) return;
            const name = chip.dataset.browseScope;
            const value = chip.dataset.browseValue || '';
            if (name === 'browse-area') browseScope = { ...browseScope, area: value, storeNumber: '' };
            else if (name === 'browse-store') browseScope = { ...browseScope, storeNumber: value };
            renderModalNavigator(scopeTree, browseScope.storeNumber);
        });
        return backdrop;
    }

    let pendingOnSelect = null;

    function close() {
        pendingOnSelect = null;
        if (!backdrop) return;
        backdrop.hidden = true;
        if (escHandler) {
            document.removeEventListener('keydown', escHandler);
            escHandler = null;
        }
    }

    function renderModalNavigator(tree, preferredStore = '') {
        const host = backdrop?.querySelector('#admin-scope-picker-nav');
        const selectBtn = backdrop?.querySelector('#admin-scope-picker-select');
        if (!host || !tree) return browseScope.storeNumber;

        const built = buildNavigatorRows(tree, browseScope, 'browse');
        browseScope = resolveBrowseScope(tree, built.scope, preferredStore);
        const finalBuilt = buildNavigatorRows(tree, browseScope, 'browse');
        browseScope = finalBuilt.scope;
        host.innerHTML = finalBuilt.html;
        if (selectBtn) selectBtn.disabled = !browseScope.storeNumber;
        return browseScope.storeNumber;
    }

    async function loadScopeTree() {
        if (scopeTree) return scopeTree;
        if (scopeTreePromise) return scopeTreePromise;
        scopeTreePromise = fetch('/api/admin/store-scope', { credentials: 'same-origin' })
            .then((res) => res.json())
            .then((data) => {
                if (!data.success || !data.scopeTree) {
                    throw new Error(data.error || 'Could not load store list.');
                }
                scopeTree = normalizeScopeTree(data.scopeTree);
                return scopeTree;
            })
            .finally(() => {
                scopeTreePromise = null;
            });
        return scopeTreePromise;
    }

    function open({ title, hint, preferredStore, onSelect, onCancel } = {}) {
        pendingOnSelect = typeof onSelect === 'function' ? onSelect : null;
        const root = ensureBackdrop();
        root.querySelector('#admin-scope-picker-title').textContent = title || 'Select store';
        const hintEl = root.querySelector('#admin-scope-picker-hint');
        if (hint) {
            hintEl.textContent = hint;
            hintEl.hidden = false;
        } else {
            hintEl.textContent = '';
            hintEl.hidden = true;
        }

        return loadScopeTree()
            .then((tree) => {
                browseScope = { area: '', storeNumber: '' };
                renderModalNavigator(tree, preferredStore || '');
                root.hidden = false;
                root.querySelector('#admin-scope-picker-nav button')?.focus();
                escHandler = (event) => {
                    if (event.key === 'Escape') {
                        event.preventDefault();
                        close();
                        onCancel?.();
                    }
                };
                document.addEventListener('keydown', escHandler);
                return true;
            })
            .catch((err) => {
                close();
                alert(err.message || 'Could not open store picker.');
                onCancel?.();
                return false;
            });
    }

    global.AdminScopePicker = {
        open,
        close,
        loadScopeTree,
        filterScopeTreeForStores,
        storesMatchingScope,
        resolveBrowseScope,
        mountInline,
        normalizeScopeTree,
        asStoreRows,
    };
})(window);
