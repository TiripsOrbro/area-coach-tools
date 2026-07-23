/**
 * Area-grouped scope popup — shared picker for store / area selection.
 */
(function scopePopupModule(global) {
    let backdrop = null;
    let escHandler = null;

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

    function ensureBackdrop() {
        if (backdrop) return backdrop;
        backdrop = document.createElement('div');
        backdrop.className = 'scope-popup-backdrop';
        backdrop.hidden = true;
        backdrop.innerHTML = `
            <div class="scope-popup-panel" role="dialog" aria-modal="true" aria-labelledby="scope-popup-title">
                <div class="scope-popup-panel__header">
                    <h2 class="scope-popup-panel__title" id="scope-popup-title"></h2>
                    <p class="scope-popup-panel__hint" id="scope-popup-hint" hidden></p>
                </div>
                <div class="scope-popup-groups" id="scope-popup-groups"></div>
                <div class="scope-popup-actions">
                    <button type="button" class="mic-settings-btn" id="scope-popup-confirm" disabled>Confirm</button>
                    <button type="button" class="admin-scope-picker-cancel" id="scope-popup-cancel">Cancel</button>
                </div>
            </div>`;
        document.body.appendChild(backdrop);
        backdrop.addEventListener('click', (event) => {
            if (event.target === backdrop) close();
        });
        backdrop.querySelector('#scope-popup-cancel')?.addEventListener('click', close);
        return backdrop;
    }

    let pending = null;
    let selectedValue = '';

    function close() {
        pending = null;
        selectedValue = '';
        if (!backdrop) return;
        backdrop.hidden = true;
        if (escHandler) {
            document.removeEventListener('keydown', escHandler);
            escHandler = null;
        }
    }

    function renderGroups(groups, selected) {
        const host = backdrop?.querySelector('#scope-popup-groups');
        if (!host) return;
        const list = Array.isArray(groups) ? groups : [];
        host.innerHTML = list
            .map((group) => {
                const items = Array.isArray(group.items) ? group.items : [];
                if (!items.length) return '';
                const single = items.length === 1;
                const buttons = items
                    .map((item) => {
                        const value = String(item.value ?? item.id ?? item.storeNumber ?? '');
                        const label = String(item.label ?? item.name ?? value);
                        const active = value === String(selected);
                        return `<button type="button" class="scope-popup-item${active ? ' is-active' : ''}" data-scope-value="${escapeAttr(value)}">${escapeHtml(label)}</button>`;
                    })
                    .join('');
                return `
                    <section class="scope-popup-group${single ? ' scope-popup-group--single' : ''}">
                        <span class="scope-popup-group__label">${escapeHtml(group.label || 'Options')}</span>
                        <div class="scope-popup-group__items" role="group" aria-label="${escapeAttr(group.label || 'Options')}">${buttons}</div>
                    </section>`;
            })
            .join('');
    }

    function wireItemClicks(onSelect) {
        const host = backdrop?.querySelector('#scope-popup-groups');
        const confirmBtn = backdrop?.querySelector('#scope-popup-confirm');
        if (!host) return;
        host.onclick = (event) => {
            const btn = event.target.closest('[data-scope-value]');
            if (!btn) return;
            selectedValue = btn.dataset.scopeValue || '';
            host.querySelectorAll('.scope-popup-item').forEach((el) => {
                el.classList.toggle('is-active', el === btn);
            });
            if (confirmBtn) confirmBtn.disabled = !selectedValue;
            if (pending?.selectOnClick) {
                const item = findItem(pending.groups, selectedValue);
                close();
                onSelect?.(item || { value: selectedValue });
            }
        };
    }

    function findItem(groups, value) {
        for (const group of groups || []) {
            for (const item of group.items || []) {
                const v = String(item.value ?? item.id ?? item.storeNumber ?? '');
                if (v === String(value)) return item;
            }
        }
        return null;
    }

    function open(options = {}) {
        const {
            title = 'Select',
            hint = '',
            groups = [],
            selected = '',
            selectOnClick = false,
            confirmLabel = 'Confirm',
            onSelect,
            onCancel,
        } = options;

        pending = { groups, selectOnClick, onSelect, onCancel };
        selectedValue = String(selected || '');
        const root = ensureBackdrop();
        root.querySelector('#scope-popup-title').textContent = title;
        const hintEl = root.querySelector('#scope-popup-hint');
        if (hint) {
            hintEl.textContent = hint;
            hintEl.hidden = false;
        } else {
            hintEl.textContent = '';
            hintEl.hidden = true;
        }
        const confirmBtn = root.querySelector('#scope-popup-confirm');
        confirmBtn.textContent = confirmLabel;
        confirmBtn.disabled = !selectedValue;
        confirmBtn.onclick = () => {
            if (!selectedValue) return;
            const item = findItem(groups, selectedValue);
            const cb = pending?.onSelect;
            close();
            cb?.(item || { value: selectedValue });
        };
        renderGroups(groups, selectedValue);
        wireItemClicks(onSelect);
        root.hidden = false;
        root.querySelector('.scope-popup-item, #scope-popup-confirm')?.focus();
        escHandler = (event) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                const cb = pending?.onCancel;
                close();
                cb?.();
            }
        };
        document.addEventListener('keydown', escHandler);
        return true;
    }

    function mountTrigger(host, options = {}) {
        if (!host) return;
        const label = options.buttonLabel || options.title || 'Select';
        host.innerHTML = `<button type="button" class="scope-popup-trigger">${escapeHtml(label)}</button>`;
        host.querySelector('button')?.addEventListener('click', () => open(options));
    }

    function groupsFromScopeTree(tree, { kind = 'store' } = {}) {
        const areas = tree?.areas || Object.keys(tree?.storesByArea || {});
        const areaLabel = (name) => global.AreaDisplay?.label?.(name) ?? String(name ?? '').trim();
        return areas
            .map((area) => {
                const rows = tree?.storesByArea?.[area] || [];
                const items =
                    kind === 'area'
                        ? [{ value: area, label: areaLabel(area) }]
                        : rows.map((row) => ({
                              value: row.storeNumber,
                              label: row.storeName
                                  ? `${row.storeNumber} - ${row.storeName}`
                                  : String(row.storeNumber),
                              storeNumber: row.storeNumber,
                              storeName: row.storeName,
                              area,
                          }));
                return { label: areaLabel(area), items };
            })
            .filter((group) => group.items.length);
    }

    global.ScopePopup = {
        open,
        close,
        mountTrigger,
        groupsFromScopeTree,
    };
})(window);
