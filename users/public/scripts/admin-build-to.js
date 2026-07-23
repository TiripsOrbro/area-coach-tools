(function (global) {
    let backdrop = null;
    let pageHost = null;
    let profile = null;
    let catalogCache = null;
    let storeList = [];
    let scopeTree = null;
    let scopeNavigator = null;
    let browseScope = { market: '', area: '', storeNumber: '' };
    let canEditItemCodes = false;
    let canConfigure = false;
    let canAddItems = false;
    let canCopyVendor = false;
    let allVendorsCache = [];
    let existingVendorsCache = [];
    let viewMode = 'rules';
    let configureVendorFilter = '';
    let unitLabelOptions = [];

    const CONFIGURE_COL_KEYS = [
        'mmxName',
        'commonName',
        'vendor',
        'mmxCode',
        'vendorCode',
        'fallbackCodes',
        'outer',
        'inner',
        'unit',
        'unitsPerPack',
        'packsPerBox',
        'countOuter',
        'countInner',
        'countUnit',
    ];
    const CONFIGURE_COL_DEFAULTS = {
        mmxName: 280,
        commonName: 120,
        vendor: 110,
        mmxCode: 88,
        vendorCode: 88,
        fallbackCodes: 140,
        outer: 72,
        inner: 72,
        unit: 72,
        unitsPerPack: 108,
        packsPerBox: 108,
        countOuter: 76,
        countInner: 76,
        countUnit: 76,
    };
    const CONFIGURE_COL_WIDTHS_KEY_PREFIX = 'admin-buildto-configure-col-widths';

    function configureColWidthsStorageKey() {
        const username = String(profile?.username || '').trim();
        if (username) return `${CONFIGURE_COL_WIDTHS_KEY_PREFIX}:${username}`;
        return CONFIGURE_COL_WIDTHS_KEY_PREFIX;
    }

    function loadConfigureColWidths() {
        try {
            const key = configureColWidthsStorageKey();
            let raw = localStorage.getItem(key);
            if (!raw && key !== CONFIGURE_COL_WIDTHS_KEY_PREFIX) {
                raw = localStorage.getItem(CONFIGURE_COL_WIDTHS_KEY_PREFIX);
            }
            if (!raw) return { ...CONFIGURE_COL_DEFAULTS };
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object') return { ...CONFIGURE_COL_DEFAULTS };
            return { ...CONFIGURE_COL_DEFAULTS, ...parsed };
        } catch {
            return { ...CONFIGURE_COL_DEFAULTS };
        }
    }

    function saveConfigureColWidths(widths) {
        const next = { ...CONFIGURE_COL_DEFAULTS };
        CONFIGURE_COL_KEYS.forEach((key) => {
            const value = widths?.[key];
            next[key] =
                value != null && Number.isFinite(Number(value))
                    ? Math.max(48, Math.round(Number(value)))
                    : next[key];
        });
        try {
            localStorage.setItem(configureColWidthsStorageKey(), JSON.stringify(next));
        } catch {
            /* ignore quota errors */
        }
    }

    function hasSavedConfigureColWidths() {
        try {
            const key = configureColWidthsStorageKey();
            if (localStorage.getItem(key)) return true;
            if (key !== CONFIGURE_COL_WIDTHS_KEY_PREFIX && localStorage.getItem(CONFIGURE_COL_WIDTHS_KEY_PREFIX)) {
                return true;
            }
            return false;
        } catch {
            return false;
        }
    }

    let configureColMeasureSpan = null;
    let buildToConfirmResolve = null;

    function closeBuildToConfirm(result) {
        const root = ensureBackdrop();
        const backdrop = root.querySelector('#admin-buildto-confirm-backdrop');
        if (backdrop) {
            backdrop.hidden = true;
            backdrop.setAttribute('aria-hidden', 'true');
        }
        if (buildToConfirmResolve) {
            buildToConfirmResolve(Boolean(result));
            buildToConfirmResolve = null;
        }
    }

    function showBuildToConfirm(options = {}) {
        const root = ensureBackdrop();
        const backdrop = root.querySelector('#admin-buildto-confirm-backdrop');
        const titleEl = root.querySelector('#admin-buildto-confirm-title');
        const messageEl = root.querySelector('#admin-buildto-confirm-message');
        const okBtn = root.querySelector('#admin-buildto-confirm-ok');
        const cancelBtn = root.querySelector('#admin-buildto-confirm-cancel');
        if (!backdrop || !titleEl || !messageEl || !okBtn || !cancelBtn) {
            return Promise.resolve(false);
        }

        titleEl.textContent = String(options.title || 'Confirm').trim();
        messageEl.textContent = String(options.message || '').trim();
        okBtn.textContent = String(options.confirmLabel || 'Delete').trim();
        cancelBtn.textContent = String(options.cancelLabel || 'Cancel').trim();
        okBtn.classList.toggle('admin-buildto-confirm-ok--danger', options.destructive !== false);

        backdrop.hidden = false;
        backdrop.setAttribute('aria-hidden', 'false');
        cancelBtn.focus();

        return new Promise((resolve) => {
            buildToConfirmResolve = resolve;
        });
    }

    function bindBuildToConfirmDialog(root) {
        const backdrop = root.querySelector('#admin-buildto-confirm-backdrop');
        if (!backdrop || backdrop.dataset.adminBuildToConfirmBound) return;
        backdrop.dataset.adminBuildToConfirmBound = '1';

        root.querySelector('#admin-buildto-confirm-ok')?.addEventListener('click', () => {
            closeBuildToConfirm(true);
        });
        root.querySelector('#admin-buildto-confirm-cancel')?.addEventListener('click', () => {
            closeBuildToConfirm(false);
        });
        backdrop.addEventListener('click', (event) => {
            if (event.target === backdrop) closeBuildToConfirm(false);
        });
        root.querySelector('.admin-buildto-confirm')?.addEventListener('click', (event) => {
            event.stopPropagation();
        });
        root.addEventListener('keydown', (event) => {
            if (event.key !== 'Escape' || backdrop.hidden) return;
            event.preventDefault();
            closeBuildToConfirm(false);
        });
    }

    function measureConfigureText(text, font) {
        if (!configureColMeasureSpan) {
            configureColMeasureSpan = document.createElement('span');
            configureColMeasureSpan.style.cssText =
                'position:absolute;left:-9999px;top:-9999px;white-space:nowrap;visibility:hidden;';
            document.body.appendChild(configureColMeasureSpan);
        }
        configureColMeasureSpan.style.font = font;
        configureColMeasureSpan.textContent = String(text || '');
        return configureColMeasureSpan.offsetWidth;
    }

    function measureConfigureHeaderWidth(th) {
        if (!th) return 48;
        const label = String(th.textContent || '').replace(/\s+/g, ' ').trim();
        return measureConfigureText(label, getComputedStyle(th).font) + 22;
    }

    function measureConfigureCellWidth(cell) {
        if (!cell) return 48;
        const checkbox = cell.querySelector('input[type="checkbox"]');
        if (checkbox) return CONFIGURE_COL_DEFAULTS.countOuter || 76;

        const select = cell.querySelector('select');
        if (select) {
            let max = 0;
            for (const option of select.options) {
                max = Math.max(max, measureConfigureText(option.text, getComputedStyle(select).font));
            }
            return max + 32;
        }

        const input = cell.querySelector('input');
        if (input) {
            const text = input.value || input.placeholder || '';
            return measureConfigureText(text, getComputedStyle(input).font) + 28;
        }

        return Math.max(cell.scrollWidth, cell.offsetWidth, 48);
    }

    function autoFitConfigureColumns(table) {
        if (!table) return;
        const rows = table.querySelectorAll('tbody tr[data-item-code]');
        const widths = CONFIGURE_COL_KEYS.map((key, colIndex) => {
            const th = table.querySelector(`thead th:nth-child(${colIndex + 1})`);
            let max = measureConfigureHeaderWidth(th);
            rows.forEach((row) => {
                const cell = row.cells[colIndex];
                if (cell) max = Math.max(max, measureConfigureCellWidth(cell));
            });
            return Math.max(48, Math.ceil(max));
        });
        applyConfigureColWidths(table, widths);
    }

    function configureColgroupHtml() {
        const deleteCol = '<col class="admin-buildto-col-delete" style="width:44px">';
        if (!hasSavedConfigureColWidths()) {
            return `<colgroup>${CONFIGURE_COL_KEYS.map(
                (key) => `<col data-col-key="${escapeHtml(key)}">`
            ).join('')}${deleteCol}</colgroup>`;
        }
        const widths = loadConfigureColWidths();
        return `<colgroup>${CONFIGURE_COL_KEYS.map(
            (key) => `<col data-col-key="${escapeHtml(key)}" style="width:${widths[key]}px">`
        ).join('')}${deleteCol}</colgroup>`;
    }

    function readConfigureColWidths(table) {
        const saved = loadConfigureColWidths();
        return CONFIGURE_COL_KEYS.map((key) => {
            const col = table?.querySelector(`colgroup col[data-col-key="${key}"]`);
            const inline = parseInt(col?.style.width, 10);
            if (Number.isFinite(inline)) return inline;
            return saved[key] || CONFIGURE_COL_DEFAULTS[key] || 48;
        });
    }

    function applyConfigureColWidths(table, widths) {
        if (!table || !Array.isArray(widths)) return;
        CONFIGURE_COL_KEYS.forEach((key, index) => {
            const col = table.querySelector(`colgroup col[data-col-key="${key}"]`);
            if (col) col.style.width = `${Math.max(48, widths[index])}px`;
        });
        syncConfigureTableWidth(table);
    }

    function syncConfigureTableWidth(table) {
        if (!table) return;
        let total = 0;
        CONFIGURE_COL_KEYS.forEach((key) => {
            const col = table.querySelector(`colgroup col[data-col-key="${key}"]`);
            total += parseInt(col?.style.width, 10) || 48;
        });
        const deleteCol = table.querySelector('colgroup col.admin-buildto-col-delete');
        total += parseInt(deleteCol?.style.width, 10) || 44;
        table.style.width = `${total}px`;
    }

    function bindConfigureColumnResize(table) {
        if (!table) return;
        if (hasSavedConfigureColWidths()) {
            applyConfigureColWidths(table, readConfigureColWidths(table));
        } else {
            autoFitConfigureColumns(table);
        }

        CONFIGURE_COL_KEYS.forEach((key, index) => {
            const col = table.querySelector(`colgroup col[data-col-key="${key}"]`);
            const th = table.querySelector(`thead th:nth-child(${index + 1})`);
            if (!col || !th || th.querySelector('.admin-buildto-col-resize')) return;

            th.classList.add('admin-buildto-col-header');
            const handle = document.createElement('span');
            handle.className = 'admin-buildto-col-resize';
            handle.setAttribute('role', 'separator');
            handle.setAttribute('aria-orientation', 'vertical');
            handle.title = 'Drag to resize column';
            th.appendChild(handle);

            let startX = 0;
            let startWidth = 0;
            let peerWidths = [];

            const onMove = (event) => {
                const clientX = event.touches ? event.touches[0].clientX : event.clientX;
                const next = Math.max(48, startWidth + (clientX - startX));
                const widths = peerWidths.slice();
                widths[index] = next;
                applyConfigureColWidths(table, widths);
            };

            const onEnd = () => {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onEnd);
                document.removeEventListener('touchmove', onMove);
                document.removeEventListener('touchend', onEnd);
                document.body.classList.remove('admin-buildto-col-resizing');
                const widths = readConfigureColWidths(table);
                const saved = {};
                CONFIGURE_COL_KEYS.forEach((colKey, colIndex) => {
                    saved[colKey] = widths[colIndex];
                });
                saveConfigureColWidths(saved);
            };

            const onStart = (event) => {
                event.preventDefault();
                event.stopPropagation();
                startX = event.touches ? event.touches[0].clientX : event.clientX;
                peerWidths = readConfigureColWidths(table);
                startWidth = peerWidths[index];
                document.body.classList.add('admin-buildto-col-resizing');
                document.addEventListener('mousemove', onMove);
                document.addEventListener('mouseup', onEnd);
                document.addEventListener('touchmove', onMove, { passive: false });
                document.addEventListener('touchend', onEnd);
            };

            handle.addEventListener('mousedown', onStart);
            handle.addEventListener('touchstart', onStart, { passive: false });
        });
    }

    const BUILD_TO_COG_SVG = `<svg class="admin-buildto-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path fill="currentColor" d="M19.14 12.94c.04-.31.06-.63.06-.94s-.02-.63-.06-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96c-.5-.38-1.05-.7-1.65-.94l-.36-2.54a.5.5 0 0 0-.49-.42h-3.84a.5.5 0 0 0-.49.42l-.36 2.54c-.6.24-1.15.56-1.65.94l-2.39-.96a.5.5 0 0 0-.6.22l-1.92 3.32a.5.5 0 0 0 .12.64l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32a.5.5 0 0 0 .6.22l2.39-.96c.5.38 1.05.7 1.65.94l.36 2.54a.5.5 0 0 0 .49.42h3.84a.5.5 0 0 0 .49-.42l.36-2.54c.6-.24 1.15-.56 1.65-.94l2.39.96a.5.5 0 0 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58ZM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7Z"/>
            </svg>`;

    const BUILD_TO_BACK_SVG = `<svg class="admin-buildto-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path fill="currentColor" d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/>
            </svg>`;

    const BUILD_TO_COPY_SVG = `<svg class="admin-buildto-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path fill="currentColor" d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/>
            </svg>`;

    const BUILD_TO_ADD_SVG = `<svg class="admin-buildto-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path fill="currentColor" d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/>
            </svg>`;

    const BUILD_TO_REMOVE_SVG = `<svg class="admin-buildto-icon admin-buildto-icon--sm" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path fill="currentColor" d="M19 13H5v-2h14v2z"/>
            </svg>`;

    function escapeHtml(text) {
        return String(text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function itemCommonLabel(item) {
        return String(item?.displayName || item?.name || item?.itemCode || '').trim();
    }

    function dropdownRuleType(item) {
        const type = String(item.ruleType || '').toLowerCase();
        if (type === 'on-hand') return 'on-hand';
        if (type === 'manual' || type === 'order-manual') return 'manual';
        return 'days';
    }

    function fixedDisplayValue(item) {
        if (item.buildToFixed != null) return item.buildToFixed;
        return '';
    }

    function warnDisplayValue(item) {
        if (item.stockWarningDays != null) return item.stockWarningDays;
        return item.defaultStockWarningDays ?? 5;
    }

    function applyRuleTypeRow(row) {
        const type = row.querySelector('[data-field="ruleType"]')?.value || 'days';
        const showDaysBuffer = type === 'days' || type === 'on-hand';
        const showFixed = type === 'manual';
        row.querySelectorAll('[data-buildto-group="days"]').forEach((cell) => {
            cell.classList.toggle('admin-buildto-group--off', !showDaysBuffer);
        });
        row.querySelectorAll('[data-buildto-group="fixed"]').forEach((cell) => {
            cell.classList.toggle('admin-buildto-group--off', !showFixed);
        });
    }

    function displayMmxCode(item) {
        return String(item.fileMmxCode || item.mmxCode || item.catalogMmxCode || item.itemCode || '').trim();
    }

    function displayVendorCode(item) {
        return String(item.fileVendorCode || item.vendorCode || item.catalogMmxCode || item.itemCode || '').trim();
    }

    function displayFallbackCodes(item) {
        const effective = formatFallbackCodes(item.fallbackCodes);
        if (effective) return effective;
        return formatFallbackCodes(item.fileFallbackCodes);
    }

    function applyItemCodeFields(row, item) {
        const mmx = displayMmxCode(item);
        const vendor = displayVendorCode(item);
        const fallbacks = displayFallbackCodes(item);
        const catalogMmx = String(item.catalogMmxCode || item.itemCode || '').trim();

        row.dataset.catalogMmx = catalogMmx;
        row.dataset.loadedMmx = mmx;
        row.dataset.loadedVendor = vendor;
        row.dataset.loadedFallbacks = fallbacks;
        row.dataset.fileFallbacks = formatFallbackCodes(item.fileFallbackCodes);

        const mmxInput = row.querySelector('[data-field="mmxCode"]');
        const vendorInput = row.querySelector('[data-field="vendorCode"]');
        const fallbackInput = row.querySelector('[data-field="fallbackCodes"]');
        const codeLocked = !canEditItemCodes;
        const lockedTitle = 'Area Manager or above can change item codes';
        if (mmxInput) {
            mmxInput.value = mmx;
            mmxInput.readOnly = codeLocked;
            mmxInput.classList.toggle('admin-buildto-code-input--locked', codeLocked);
            mmxInput.title = codeLocked ? lockedTitle : 'MMX / Key Item Count code';
        }
        if (vendorInput) {
            vendorInput.value = vendor;
            vendorInput.readOnly = codeLocked;
            vendorInput.classList.toggle('admin-buildto-code-input--locked', codeLocked);
            vendorInput.title = codeLocked ? lockedTitle : 'Vendor order code';
        }
        if (fallbackInput) {
            fallbackInput.value = fallbacks;
            fallbackInput.placeholder = fallbacks ? '' : '-';
            fallbackInput.readOnly = codeLocked;
            fallbackInput.classList.toggle('admin-buildto-code-input--locked', codeLocked);
            fallbackInput.title = codeLocked
                ? lockedTitle
                : 'Extra ISE/SOH codes, tried in order (comma-separated)';
        }
    }

    function getRoot() {
        return pageHost || backdrop;
    }

    function isInline() {
        return Boolean(pageHost);
    }

    const BUILD_TO_MODAL_HTML = `
            <div class="admin-modal admin-modal--wide admin-modal--build-to" role="dialog" aria-modal="true">
                <div class="admin-buildto-header">
                    <div class="admin-buildto-header-main">
                        <div class="admin-buildto-header-text">
                            <h2 id="admin-buildto-title">Build to adjustments</h2>
                        </div>
                        <div class="admin-buildto-header-actions">
                            <button type="button" class="mic-settings-btn admin-buildto-mode-toggle admin-buildto-header-icon-btn admin-buildto-mode-toggle--cog" id="admin-buildto-mode-toggle" hidden aria-label="Configure items" title="Configure items">${BUILD_TO_COG_SVG}</button>
                            <button type="button" class="mic-settings-btn admin-buildto-add admin-buildto-header-icon-btn" id="admin-buildto-add" hidden aria-label="New item" title="New item">${BUILD_TO_ADD_SVG}</button>
                            <button type="button" class="mic-settings-btn admin-buildto-copy-vendor admin-buildto-header-icon-btn" id="admin-buildto-copy-vendor" hidden aria-label="Copy to vendor" title="Copy to vendor">${BUILD_TO_COPY_SVG}</button>
                        </div>
                    </div>
                </div>
                <div id="admin-buildto-browse-scope" class="admin-accounts-browse-scope admin-accounts-org-nav"></div>
                <div class="admin-modal-toolbar admin-buildto-toolbar">
                    <div class="admin-buildto-vendor-filter-wrap" id="admin-buildto-vendor-filter-wrap" hidden>
                        <label class="admin-buildto-vendor-filter-label">Vendor
                            <span class="admin-buildto-vendor-filter-row">
                                <select id="admin-buildto-vendor-filter" class="admin-buildto-type-select" aria-label="Filter by vendor"></select>
                                <button type="button" class="mic-settings-btn admin-buildto-vendor-remove admin-buildto-header-icon-btn" id="admin-buildto-vendor-remove" hidden aria-label="Remove vendor" title="Remove inactive vendor">${BUILD_TO_REMOVE_SVG}</button>
                            </span>
                        </label>
                    </div>
                    <div class="admin-buildto-search-wrap">
                        <input type="search" id="admin-buildto-search" placeholder="Search items…" aria-label="Search items" />
                    </div>
                    <button type="button" class="mic-settings-btn admin-btn-primary admin-buildto-save" id="admin-buildto-save">Save changes</button>
                </div>
                <div class="admin-buildto-new-wrap" id="admin-buildto-new-wrap" hidden></div>
                <div class="admin-buildto-new-wrap" id="admin-buildto-copy-wrap" hidden></div>
                <div class="admin-buildto-table-wrap" id="admin-buildto-body"></div>
                <p id="admin-buildto-error" class="admin-modal-error" role="alert"></p>
                <div class="admin-modal-actions admin-buildto-actions">
                    <button type="button" class="admin-buildto-close-btn" id="admin-buildto-close">Close</button>
                </div>
                <div class="admin-buildto-confirm-backdrop" id="admin-buildto-confirm-backdrop" hidden aria-hidden="true">
                    <div class="admin-buildto-confirm" role="alertdialog" aria-modal="true" aria-labelledby="admin-buildto-confirm-title" aria-describedby="admin-buildto-confirm-message">
                        <h3 id="admin-buildto-confirm-title">Confirm</h3>
                        <p id="admin-buildto-confirm-message"></p>
                        <div class="admin-buildto-confirm-actions">
                            <button type="button" class="admin-buildto-close-btn" id="admin-buildto-confirm-cancel">Cancel</button>
                            <button type="button" class="mic-settings-btn admin-btn-primary admin-buildto-confirm-ok" id="admin-buildto-confirm-ok">Delete</button>
                        </div>
                    </div>
                </div>
            </div>`;

    function bindPanel(root) {
        if (root.dataset.adminBuildToBound) return;
        root.dataset.adminBuildToBound = '1';
        root.querySelector('#admin-buildto-close')?.addEventListener('click', close);
        root.querySelector('#admin-buildto-save')?.addEventListener('click', () => {
            void saveChanges();
        });
        root.querySelector('#admin-buildto-add')?.addEventListener('click', () => {
            toggleNewItemForm();
        });
        root.querySelector('#admin-buildto-mode-toggle')?.addEventListener('click', () => {
            if (viewMode === 'configure') exitConfigureMode();
            else enterConfigureMode();
        });
        root.querySelector('#admin-buildto-copy-vendor')?.addEventListener('click', () => {
            toggleCopyVendorForm();
        });
        root.querySelector('#admin-buildto-vendor-filter')?.addEventListener('change', (event) => {
            configureVendorFilter = event.target.value || '';
            updateVendorRemoveButton();
            renderTable();
        });
        root.querySelector('#admin-buildto-vendor-remove')?.addEventListener('click', () => {
            void removeSelectedVendor();
        });
        bindBuildToConfirmDialog(root);
        root.querySelector('#admin-buildto-search')?.addEventListener('input', () => renderTable());
    }

    function ensureBackdrop() {
        if (pageHost) {
            if (!pageHost.querySelector('.admin-modal')) {
                pageHost.innerHTML = BUILD_TO_MODAL_HTML;
                bindPanel(pageHost);
            }
            return pageHost;
        }
        if (backdrop) return backdrop;
        backdrop = document.createElement('div');
        backdrop.className = 'admin-modal-backdrop';
        backdrop.hidden = true;
        backdrop.innerHTML = BUILD_TO_MODAL_HTML;
        document.body.appendChild(backdrop);
        backdrop.addEventListener('click', (event) => {
            if (event.target === backdrop) close();
        });
        bindPanel(backdrop);
        return backdrop;
    }

    function close() {
        if (isInline()) return;
        if (backdrop) backdrop.hidden = true;
    }

    function applyViewModeUi() {
        const root = ensureBackdrop();
        const isConfigure = viewMode === 'configure';
        const title = root.querySelector('#admin-buildto-title');
        const modeToggle = root.querySelector('#admin-buildto-mode-toggle');
        const headerActions = root.querySelector('.admin-buildto-header-actions');
        const browseScopeHost = root.querySelector('#admin-buildto-browse-scope');
        const vendorFilterWrap = root.querySelector('#admin-buildto-vendor-filter-wrap');
        const copyBtn = root.querySelector('#admin-buildto-copy-vendor');
        const addBtn = root.querySelector('#admin-buildto-add');

        if (title) title.textContent = isConfigure ? 'Configure items' : 'Build to adjustments';
        if (headerActions) {
            headerActions.classList.toggle('admin-buildto-header-actions--configure', isConfigure);
        }
        if (modeToggle) {
            modeToggle.hidden = !canAddItems;
            modeToggle.classList.toggle('admin-buildto-mode-toggle--back', isConfigure);
            modeToggle.classList.toggle('admin-buildto-mode-toggle--cog', !isConfigure);
            if (isConfigure) {
                modeToggle.innerHTML = BUILD_TO_BACK_SVG;
                modeToggle.setAttribute('aria-label', 'Back to build-to');
                modeToggle.title = 'Back to build-to';
            } else {
                modeToggle.innerHTML = BUILD_TO_COG_SVG;
                modeToggle.setAttribute('aria-label', 'Configure items');
                modeToggle.title = 'Configure items';
            }
        }
        if (browseScopeHost) browseScopeHost.hidden = isConfigure;
        if (vendorFilterWrap) vendorFilterWrap.hidden = !isConfigure;
        const vendorRemoveBtn = root.querySelector('#admin-buildto-vendor-remove');
        if (vendorRemoveBtn) vendorRemoveBtn.hidden = !(isConfigure && canAddItems);
        if (copyBtn) copyBtn.hidden = !(isConfigure && canCopyVendor);
        if (addBtn) addBtn.hidden = !isConfigure || !canAddItems;
    }

    function enterConfigureMode() {
        if (!canAddItems) {
            const root = ensureBackdrop();
            const errEl = root.querySelector('#admin-buildto-error');
            if (errEl) {
                errEl.textContent = 'Area Manager or above is required to configure items.';
            }
            return;
        }
        viewMode = 'configure';
        applyViewModeUi();
        populateVendorFilter();
        void loadCatalog().catch((error) => {
            const root = ensureBackdrop();
            root.querySelector('#admin-buildto-error').textContent = error.message || 'Could not load catalog.';
        });
    }

    function exitConfigureMode() {
        viewMode = 'rules';
        const root = ensureBackdrop();
        const wrap = root.querySelector('#admin-buildto-new-wrap');
        const copyWrap = root.querySelector('#admin-buildto-copy-wrap');
        if (wrap) wrap.hidden = true;
        if (copyWrap) copyWrap.hidden = true;
        applyViewModeUi();
        void loadCatalog().catch((error) => {
            root.querySelector('#admin-buildto-error').textContent = error.message || 'Could not load catalog.';
        });
    }

    function vendorsForFilter() {
        if (allVendorsCache.length) return allVendorsCache;
        return (catalogCache?.vendors || newItemVendors()).map((v) => ({
            slug: v.slug,
            label: v.label || v.slug,
            configured: true,
            custom: false,
        }));
    }

    function selectedFilterVendor() {
        return vendorsForFilter().find((v) => v.slug === configureVendorFilter) || null;
    }

    function updateVendorRemoveButton() {
        const root = ensureBackdrop();
        const btn = root.querySelector('#admin-buildto-vendor-remove');
        const vendor = selectedFilterVendor();
        if (!btn) return;
        btn.disabled = !vendor;
        btn.title = vendor ? `Remove ${vendor.label || vendor.slug}` : 'Remove vendor';
    }

    function populateVendorFilter() {
        const root = ensureBackdrop();
        const select = root.querySelector('#admin-buildto-vendor-filter');
        if (!select) return;
        const vendors = vendorsForFilter();
        if (!configureVendorFilter && vendors.length) {
            configureVendorFilter = vendors[0].slug;
        } else if (configureVendorFilter && !vendors.some((v) => v.slug === configureVendorFilter)) {
            configureVendorFilter = vendors[0]?.slug || '';
        }
        select.innerHTML = vendors
            .map((v) => {
                const label = v.configured ? v.label || v.slug : `${v.label || v.slug} (inactive)`;
                return `<option value="${escapeHtml(v.slug)}" ${v.slug === configureVendorFilter ? 'selected' : ''}>${escapeHtml(label)}</option>`;
            })
            .join('');
        updateVendorRemoveButton();
    }

    async function removeSelectedVendor() {
        const vendor = selectedFilterVendor();
        if (!vendor) return;
        const label = String(vendor.label || vendor.slug).trim();
        const ok = await showBuildToConfirm({
            title: 'Remove vendor?',
            message: `Remove "${label}"? This deletes the vendor catalog from this server and removes its MMX order entries.`,
            confirmLabel: 'Remove vendor',
        });
        if (!ok) return;

        const root = ensureBackdrop();
        const errEl = root.querySelector('#admin-buildto-error');
        if (errEl) errEl.textContent = '';

        try {
            const res = await fetch(`/api/admin/build-to/vendors/${encodeURIComponent(vendor.slug)}`, {
                method: 'DELETE',
                credentials: 'same-origin',
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || data.success === false) {
                throw new Error(data.error || 'Could not remove vendor.');
            }
            configureVendorFilter = '';
            allVendorsCache = [];
            await loadCatalog();
        } catch (error) {
            if (errEl) errEl.textContent = error.message || 'Could not remove vendor.';
        }
    }

    function renderTable() {
        if (viewMode === 'configure') renderConfigureRows();
        else renderRows();
    }

    function formatFallbackCodes(codes) {
        if (Array.isArray(codes)) return codes.filter(Boolean).join(', ');
        if (codes == null || codes === '') return '';
        return String(codes).trim();
    }

    function asStoreNumbers(list) {
        if (!list) return [];
        if (Array.isArray(list)) return list.map(String);
        return [String(list)];
    }

    function getOverrideScope() {
        const area = String(browseScope.area || '').trim();
        const store = String(browseScope.storeNumber || '').trim();
        if (store) return { level: 'store', store, area };
        if (area) return { level: 'area', area };
        return { level: 'none' };
    }

    function scopeCatalogParams() {
        if (viewMode === 'configure') {
            const params = new URLSearchParams();
            params.set('configure', '1');
            return { scope: { level: 'global' }, params };
        }
        const scope = getOverrideScope();
        const params = new URLSearchParams();
        if (scope.level === 'store' && scope.store) params.set('store', scope.store);
        else if (scope.level === 'area' && scope.area) params.set('area', scope.area);
        return { scope, params };
    }

    async function loadScopeTree() {
        if (!global.AdminScopePicker) throw new Error('Store picker not available.');
        const raw = await global.AdminScopePicker.loadScopeTree();
        const rows = global.AdminScopePicker.asStoreRows
            ? global.AdminScopePicker.asStoreRows(storeList)
            : storeList;
        scopeTree = global.AdminScopePicker.filterScopeTreeForStores(raw, rows);
        return scopeTree;
    }

    function renderScopeNavigator() {
        const root = ensureBackdrop();
        const host = root.querySelector('#admin-buildto-browse-scope');
        if (!host) return;
        if (!scopeTree || !global.AdminScopePicker) {
            host.innerHTML = '<p class="admin-scope-picker-empty">No stores available.</p>';
            return;
        }

        const onScopeChange = (scope) => {
            browseScope = { ...scope };
            void loadCatalog().catch((error) => {
                const root = ensureBackdrop();
                root.querySelector('#admin-buildto-error').textContent = error.message || 'Could not load catalog.';
            });
        };

        if (!scopeNavigator) {
            scopeNavigator = global.AdminScopePicker.mountInline(host, {
                tree: scopeTree,
                initialScope: browseScope,
                preferredStore: browseScope.storeNumber,
                scopePrefix: 'browse',
                onChange: onScopeChange,
            });
        } else {
            scopeNavigator.setTree(scopeTree);
            scopeNavigator.setScope(browseScope);
        }
        if (scopeNavigator) {
            browseScope = scopeNavigator.getScope();
        }
    }

    async function fetchProfile() {
        if (profile) return profile;
        const res = await fetch('/api/me', { credentials: 'same-origin' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) throw new Error('Could not load profile.');
        profile = data;
        return data;
    }

    async function loadStores() {
        const me = await fetchProfile();
        if (me.canViewCrossStoreAccounts) {
            const res = await fetch('/api/stores', { credentials: 'same-origin' });
            const data = await res.json().catch(() => ({}));
            return (data.stores || []).filter((s) => !s.testStore);
        }
        const nums =
            me.stores === '*'
                ? []
                : asStoreNumbers(me.effectiveStores || me.stores);
        return nums.map((storeNumber) => ({ storeNumber, storeName: storeNumber }));
    }

    async function loadCatalog() {
        const root = ensureBackdrop();
        const body = root.querySelector('#admin-buildto-body');
        const { scope, params } = scopeCatalogParams();
        if (viewMode === 'configure') {
            // Global item configuration — no area/store scope required.
        } else if (scope.level === 'none') {
            catalogCache = null;
            body.innerHTML = '<p>Select an area or store to view build-to adjustments.</p>';
            return;
        }
        const res = await fetch(`/api/admin/build-to/catalog?${params}`, { credentials: 'same-origin' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) throw new Error(data.error || 'Could not load build-to catalog.');
        catalogCache = data;
        unitLabelOptions = Array.isArray(data.unitLabelOptions) ? data.unitLabelOptions : [];
        if (Array.isArray(data.allVendors)) allVendorsCache = data.allVendors;
        if (Array.isArray(data.existingVendors)) existingVendorsCache = data.existingVendors;
        if (viewMode === 'configure') populateVendorFilter();
        try {
            renderTable();
        } catch (error) {
            throw new Error(error.message || 'Could not render build-to catalog.');
        }
    }

    function allItems() {
        const items = [];
        for (const vendor of catalogCache?.vendors || []) {
            for (const item of vendor.items || []) {
                items.push({ ...item, vendorSlug: vendor.slug, vendorLabel: vendor.label });
            }
        }
        return items;
    }

    function renderRows() {
        const root = ensureBackdrop();
        const body = root.querySelector('#admin-buildto-body');
        const q = String(root.querySelector('#admin-buildto-search')?.value || '')
            .trim()
            .toLowerCase();
        const items = allItems().filter((item) => {
            if (!q) return true;
            return (
                String(item.itemCode || '').toLowerCase().includes(q) ||
                String(item.name || '').toLowerCase().includes(q) ||
                String(item.displayName || '').toLowerCase().includes(q)
            );
        });
        if (!items.length) {
            body.innerHTML = '<p>No items match.</p>';
            return;
        }
        const itemsByCode = new Map(items.map((item) => [String(item.itemCode), item]));
        body.innerHTML = `
            <table class="admin-table admin-buildto-table">
                <thead>
                    <tr>
                        <th>Item</th>
                        <th>Vendor</th>
                        <th>Type</th>
                        <th>Count</th>
                        <th>Daily</th>
                        <th>Days</th>
                        <th>+Buffer</th>
                        <th>Fixed</th>
                        <th>Warn</th>
                    </tr>
                </thead>
                <tbody>
                    ${items
                        .map((item) => {
                            const ruleType = dropdownRuleType(item);
                            const fixedValue = fixedDisplayValue(item);
                            const defaultWarn = item.defaultStockWarningDays ?? 5;
                            const warnValue = warnDisplayValue(item);
                            return `
                        <tr data-item-code="${escapeHtml(item.itemCode)}"
                            data-catalog-needs-count="${item.catalogNeedsCount ? '1' : '0'}"
                            data-catalog-include-daily="${item.catalogIncludeDaily ? '1' : '0'}"
                            data-store-skip-override="${item.storeSkipStockCountOverride != null ? '1' : '0'}"
                            data-area-skip-override="${item.areaSkipStockCountOverride != null ? '1' : '0'}"
                            data-store-skip-key-override="${item.storeSkipKeyItemCountOverride != null ? '1' : '0'}"
                            data-area-skip-key-override="${item.areaSkipKeyItemCountOverride != null ? '1' : '0'}"
                            data-store-include-daily-override="${item.storeIncludeDailyOverride != null ? '1' : '0'}"
                            data-area-include-daily-override="${item.areaIncludeDailyOverride != null ? '1' : '0'}"
                            data-default-stock-warning="${escapeHtml(defaultWarn)}"
                            data-initial-stock-warning="${item.stockWarningDays != null ? escapeHtml(item.stockWarningDays) : ''}"
                            data-initial-rule-type="${escapeHtml(ruleType)}">
                            <td class="admin-buildto-item-cell">${escapeHtml(itemCommonLabel(item))}<span class="admin-accounts-meta">${escapeHtml(item.itemCode)}</span></td>
                            <td class="admin-buildto-vendor-cell">${escapeHtml(item.vendorLabel || item.vendorSlug)}</td>
                            <td>
                                <select data-field="ruleType" class="admin-buildto-type-select">
                                    <option value="days" ${ruleType === 'days' ? 'selected' : ''}>Days</option>
                                    <option value="on-hand" ${ruleType === 'on-hand' ? 'selected' : ''}>On hand</option>
                                    <option value="manual" ${ruleType === 'manual' ? 'selected' : ''}>Manual</option>
                                </select>
                            </td>
                            <td class="admin-table-check"><input type="checkbox" data-field="needsCount" ${item.needsCount ? 'checked' : ''} title="Include in weekly stock count" /></td>
                            <td class="admin-table-check"><input type="checkbox" data-field="includeDaily" ${item.includeDaily ? 'checked' : ''} title="Include in daily count" /></td>
                            <td data-buildto-group="days"><input type="number" min="0" max="31" data-field="buildToDays" class="admin-buildto-num-input" value="${item.buildToDays != null ? escapeHtml(item.buildToDays) : ''}" /></td>
                            <td data-buildto-group="days"><input type="number" min="0" max="99" data-field="buildToAdd" class="admin-buildto-num-input" value="${escapeHtml(item.buildToAdd || 0)}" /></td>
                            <td data-buildto-group="fixed"><input type="number" min="0" max="999" data-field="buildToFixed" class="admin-buildto-num-input" value="${fixedValue !== '' ? escapeHtml(fixedValue) : ''}" /></td>
                            <td class="admin-buildto-warn-cell"><input type="number" min="1" max="31" data-field="stockWarningDays" class="admin-buildto-num-input admin-buildto-warn-input" value="${escapeHtml(warnValue)}" title="Low stock warning threshold (days)" /></td>
                        </tr>`;
                        })
                        .join('')}
                </tbody>
            </table>`;
        bindRuleRowControls(itemsByCode);
    }

    function unitOptionsHtml(selected) {
        const sel = String(selected || '').trim();
        const options = unitLabelOptions.length
            ? unitLabelOptions
            : ['Boxes', 'Cartons', 'Bags', 'Packs', 'Rolls', 'KGs', 'Each', 'Bottles', 'Cans', 'Tubs'];
        return options
            .map((label) => {
                const value = escapeHtml(label);
                return `<option value="${value}" ${label === sel ? 'selected' : ''}>${value}</option>`;
            })
            .join('');
    }

    function vendorOptionsHtml(vendors, selected) {
        const sel = String(selected || '').trim();
        return vendors
            .map(
                (v) =>
                    `<option value="${escapeHtml(v.slug)}" ${v.slug === sel ? 'selected' : ''}>${escapeHtml(v.label || v.slug)}</option>`
            )
            .join('');
    }

    function bindRuleRowControls(itemsByCode) {
        const root = ensureBackdrop();
        root.querySelectorAll('tbody tr[data-item-code]').forEach((row) => {
            applyRuleTypeRow(row);
            const select = row.querySelector('[data-field="ruleType"]');
            if (select && !select.dataset.bound) {
                select.dataset.bound = '1';
                select.addEventListener('change', () => applyRuleTypeRow(row));
            }
        });
    }

    function bindConfigureRowControls(itemsByCode) {
        const root = ensureBackdrop();
        const vendors = vendorListForUi();
        root.querySelectorAll('tbody tr[data-item-code]').forEach((row) => {
            const item = itemsByCode?.get(row.getAttribute('data-item-code'));
            if (item) applyConfigureFields(row, item, vendors);
            for (let i = 0; i < 3; i++) {
                const enable = row.querySelector(`[data-field="enableUnit${i}"]`);
                const unitSelect = row.querySelector(`[data-field="unit${i}"]`);
                if (enable && unitSelect && !enable.dataset.bound) {
                    enable.dataset.bound = '1';
                    enable.addEventListener('change', () => {
                        unitSelect.disabled = !enable.checked;
                        unitSelect.classList.toggle('admin-buildto-unit-select--off', !enable.checked);
                    });
                }
            }
        });
    }

    function applyConfigureFields(row, item, vendors) {
        const mmx = displayMmxCode(item);
        const vendorCode = displayVendorCode(item);
        const fallbacks = displayFallbackCodes(item);
        const catalogMmx = String(item.catalogMmxCode || item.itemCode || '').trim();
        const catalogVendor = String(item.catalogVendorSlug || item.vendorSlug || '').trim();
        const effectiveVendor = String(item.effectiveVendorSlug || catalogVendor).trim();
        const units = Array.isArray(item.units) ? item.units : Array.isArray(item.fileUnits) ? item.fileUnits : ['N/a', 'N/a', 'N/a'];
        const fileUnits = Array.isArray(item.fileUnits) ? item.fileUnits : units;
        const innerPerCarton = item.innerPerCarton != null ? item.innerPerCarton : '';
        const unitsPerPack = item.unitsPerPack != null ? item.unitsPerPack : '';
        const fileInner = item.fileInnerPerCarton != null ? item.fileInnerPerCarton : '';
        const fileUnitsPerPack = item.fileUnitsPerPack != null ? item.fileUnitsPerPack : '';
        const fileCatalogName = String(item.fileCatalogName || item.name || '').trim();
        const fileDisplayName = String(item.fileDisplayName || item.displayName || '').trim();

        row.dataset.catalogMmx = catalogMmx;
        row.dataset.catalogVendorSlug = catalogVendor;
        row.dataset.loadedMmx = mmx;
        row.dataset.loadedVendor = vendorCode;
        row.dataset.loadedFallbacks = fallbacks;
        row.dataset.loadedVendorSlug = effectiveVendor;
        row.dataset.loadedUnits = JSON.stringify(units);
        row.dataset.fileUnits = JSON.stringify(fileUnits);
        row.dataset.fileInnerPerCarton = fileInner !== '' ? String(fileInner) : '';
        row.dataset.fileUnitsPerPack = fileUnitsPerPack !== '' ? String(fileUnitsPerPack) : '';
        row.dataset.initialVendorSlug = item.scopeVendorSlug != null ? String(item.scopeVendorSlug) : '';
        row.dataset.initialUnits = item.scopeUnits ? JSON.stringify(item.scopeUnits) : '';
        row.dataset.initialInnerPerCarton =
            item.scopeInnerPerCarton != null ? String(item.scopeInnerPerCarton) : '';
        row.dataset.initialUnitsPerPack =
            item.scopeUnitsPerPack != null ? String(item.scopeUnitsPerPack) : '';
        row.dataset.loadedInnerPerCarton = innerPerCarton !== '' ? String(innerPerCarton) : '';
        row.dataset.loadedUnitsPerPack = unitsPerPack !== '' ? String(unitsPerPack) : '';
        row.dataset.fileCatalogName = fileCatalogName;
        row.dataset.fileDisplayName = fileDisplayName;
        row.dataset.loadedCatalogName = fileCatalogName;
        row.dataset.loadedDisplayName = fileDisplayName;

        const vendorSelect = row.querySelector('[data-field="vendorSlug"]');
        if (vendorSelect) vendorSelect.innerHTML = vendorOptionsHtml(vendors, effectiveVendor);

        const mmxInput = row.querySelector('[data-field="mmxCode"]');
        const vendorInput = row.querySelector('[data-field="vendorCode"]');
        const fallbackInput = row.querySelector('[data-field="fallbackCodes"]');
        const innerInput = row.querySelector('[data-field="innerPerCarton"]');
        const unitsPerPackInput = row.querySelector('[data-field="unitsPerPack"]');
        const catalogNameInput = row.querySelector('[data-field="catalogName"]');
        const displayNameInput = row.querySelector('[data-field="displayName"]');
        const codeLocked = !canEditItemCodes;
        const nameLocked = !canAddItems;
        const lockedTitle = 'Area Manager or above can change item configuration';
        const nameLockedTitle = 'Area Manager or above can change item names';
        if (catalogNameInput) {
            catalogNameInput.value = fileCatalogName;
            catalogNameInput.readOnly = nameLocked;
            catalogNameInput.classList.toggle('admin-buildto-code-input--locked', nameLocked);
            catalogNameInput.title = nameLocked ? nameLockedTitle : 'Catalog / MMX item name';
        }
        if (displayNameInput) {
            displayNameInput.value = fileDisplayName;
            displayNameInput.readOnly = nameLocked;
            displayNameInput.classList.toggle('admin-buildto-code-input--locked', nameLocked);
            displayNameInput.title = nameLocked ? nameLockedTitle : 'Plain name shown in stock count';
        }
        if (mmxInput) {
            mmxInput.value = mmx;
            mmxInput.readOnly = codeLocked;
            mmxInput.classList.toggle('admin-buildto-code-input--locked', codeLocked);
        }
        if (vendorInput) {
            vendorInput.value = vendorCode;
            vendorInput.readOnly = codeLocked;
            vendorInput.classList.toggle('admin-buildto-code-input--locked', codeLocked);
        }
        if (fallbackInput) {
            fallbackInput.value = fallbacks;
            fallbackInput.placeholder = fallbacks ? '' : '-';
            fallbackInput.readOnly = codeLocked;
            fallbackInput.classList.toggle('admin-buildto-code-input--locked', codeLocked);
        }
        if (innerInput) {
            innerInput.value = innerPerCarton !== '' ? innerPerCarton : '';
            innerInput.readOnly = codeLocked;
            innerInput.classList.toggle('admin-buildto-code-input--locked', codeLocked);
        }
        if (unitsPerPackInput) {
            unitsPerPackInput.value = unitsPerPack !== '' ? unitsPerPack : '';
            unitsPerPackInput.readOnly = codeLocked;
            unitsPerPackInput.classList.toggle('admin-buildto-code-input--locked', codeLocked);
        }
        if (vendorSelect) {
            vendorSelect.disabled = codeLocked;
            vendorSelect.classList.toggle('admin-buildto-code-input--locked', codeLocked);
            vendorSelect.title = codeLocked ? lockedTitle : 'Stock count vendor tab';
        }

        for (let i = 0; i < 3; i++) {
            const label = units[i] || 'N/a';
            const enabled = !/^n\s*\/\s*a$/i.test(String(label).trim());
            const enableBox = row.querySelector(`[data-field="enableUnit${i}"]`);
            const unitSelect = row.querySelector(`[data-field="unit${i}"]`);
            if (enableBox) {
                enableBox.checked = enabled;
                enableBox.disabled = codeLocked;
            }
            if (unitSelect) {
                unitSelect.innerHTML = unitOptionsHtml(enabled ? label : fileUnits[i] || 'Boxes');
                unitSelect.value = enabled ? label : unitSelect.options[0]?.value || 'Boxes';
                unitSelect.disabled = codeLocked || !enabled;
                unitSelect.classList.toggle('admin-buildto-unit-select--off', !enabled);
            }
        }
    }

    function configureItems() {
        const vendorSlug = String(configureVendorFilter || '').trim();
        return allItems().filter((item) => {
            const catalogVendor = String(item.catalogVendorSlug || item.vendorSlug || '').trim();
            return !vendorSlug || catalogVendor === vendorSlug;
        });
    }

    function renderConfigureRows() {
        const root = ensureBackdrop();
        const body = root.querySelector('#admin-buildto-body');
        const q = String(root.querySelector('#admin-buildto-search')?.value || '')
            .trim()
            .toLowerCase();
        const items = configureItems().filter((item) => {
            if (!q) return true;
            return (
                String(item.itemCode || '').toLowerCase().includes(q) ||
                String(item.name || '').toLowerCase().includes(q) ||
                String(item.displayName || '').toLowerCase().includes(q)
            );
        });
        if (!items.length) {
            body.innerHTML = '<p>No items match.</p>';
            return;
        }
        const vendors = vendorListForUi();
        const itemsByCode = new Map(items.map((item) => [String(item.itemCode), item]));
        body.innerHTML = `
            <table class="admin-table admin-buildto-table admin-buildto-table--configure">
                ${configureColgroupHtml()}
                <thead>
                    <tr>
                        <th>MMX name</th>
                        <th>Common name</th>
                        <th>Vendor</th>
                        <th>MMX code</th>
                        <th>Vendor code</th>
                        <th>Fallback codes</th>
                        <th>Outer</th>
                        <th>Inner</th>
                        <th>Unit</th>
                        <th>Each/Kgs per pack</th>
                        <th>Packs per box</th>
                        <th>Count outer</th>
                        <th>Count inner</th>
                        <th>Count unit</th>
                        <th class="admin-buildto-col-delete-header" aria-label="Delete"></th>
                    </tr>
                </thead>
                <tbody>
                    ${items
                        .map((item) => {
                            const effectiveVendor = String(
                                item.effectiveVendorSlug || item.catalogVendorSlug || item.vendorSlug || ''
                            ).trim();
                            return `
                        <tr data-item-code="${escapeHtml(item.itemCode)}"
                            data-catalog-vendor-slug="${escapeHtml(item.catalogVendorSlug || item.vendorSlug || '')}">
                            <td><input type="text" data-field="catalogName" class="admin-buildto-code-input admin-buildto-name-input" autocomplete="off" title="Catalog / MMX item name" /></td>
                            <td><input type="text" data-field="displayName" class="admin-buildto-code-input admin-buildto-name-input" autocomplete="off" placeholder="Optional" title="Plain name shown in stock count" /></td>
                            <td><select data-field="vendorSlug" class="admin-buildto-type-select">${vendorOptionsHtml(vendors, effectiveVendor)}</select></td>
                            <td><input type="text" data-field="mmxCode" class="admin-buildto-code-input" autocomplete="off" /></td>
                            <td><input type="text" data-field="vendorCode" class="admin-buildto-code-input" autocomplete="off" /></td>
                            <td><input type="text" data-field="fallbackCodes" class="admin-buildto-fallback-input" autocomplete="off" placeholder="Comma-separated" title="Extra item codes for the same product, tried in order" /></td>
                            <td><select data-field="unit0" class="admin-buildto-type-select admin-buildto-unit-select">${unitOptionsHtml('Boxes')}</select></td>
                            <td><select data-field="unit1" class="admin-buildto-type-select admin-buildto-unit-select">${unitOptionsHtml('N/a')}</select></td>
                            <td><select data-field="unit2" class="admin-buildto-type-select admin-buildto-unit-select">${unitOptionsHtml('N/a')}</select></td>
                            <td><input type="number" min="0" step="any" data-field="unitsPerPack" class="admin-buildto-num-input" placeholder="-" title="Each or KGs in one inner pack" /></td>
                            <td><input type="number" min="0" step="any" data-field="innerPerCarton" class="admin-buildto-num-input" placeholder="-" title="Inner packs per outer box" /></td>
                            <td class="admin-table-check"><input type="checkbox" data-field="enableUnit0" title="Show outer column in stock count" /></td>
                            <td class="admin-table-check"><input type="checkbox" data-field="enableUnit1" title="Show inner column in stock count" /></td>
                            <td class="admin-table-check"><input type="checkbox" data-field="enableUnit2" title="Show unit column in stock count" /></td>
                            <td class="admin-buildto-delete-cell">${canAddItems ? `<button type="button" class="admin-buildto-delete-item admin-buildto-header-icon-btn" data-delete-item aria-label="Delete item" title="Delete item">${BUILD_TO_REMOVE_SVG}</button>` : ''}</td>
                        </tr>`;
                        })
                        .join('')}
                </tbody>
            </table>`;
        const table = body.querySelector('.admin-buildto-table--configure');
        bindConfigureRowControls(itemsByCode);
        bindConfigureDeleteControls(itemsByCode);
        bindConfigureColumnResize(table);
    }

    function bindConfigureDeleteControls(itemsByCode) {
        const root = ensureBackdrop();
        root.querySelectorAll('[data-delete-item]').forEach((btn) => {
            if (btn.dataset.bound) return;
            btn.dataset.bound = '1';
            btn.addEventListener('click', () => {
                const row = btn.closest('tr[data-item-code]');
                if (!row) return;
                const itemCode = row.getAttribute('data-item-code');
                const item = itemsByCode?.get(itemCode);
                const vendorSlug = String(
                    row.dataset.catalogVendorSlug || item?.catalogVendorSlug || item?.vendorSlug || ''
                ).trim();
                const label = item ? itemCommonLabel(item) : itemCode;
                void deleteConfigureItem(itemCode, vendorSlug, label);
            });
        });
    }

    async function deleteConfigureItem(itemCode, vendorSlug, label) {
        if (!canAddItems) return;
        const code = String(itemCode || '').trim();
        if (!code) return;
        const name = String(label || code).trim();
        const ok = await showBuildToConfirm({
            title: 'Delete item?',
            message: `Delete "${name}" (${code}) from the catalog? This removes the item, its display name, and build-to overrides.`,
            confirmLabel: 'Delete item',
        });
        if (!ok) return;

        const root = ensureBackdrop();
        const errEl = root.querySelector('#admin-buildto-error');
        if (errEl) errEl.textContent = '';

        try {
            const res = await fetch('/api/admin/build-to/items', {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify({ itemCode: code, vendor: vendorSlug }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.success) throw new Error(data.error || 'Delete failed.');
            await loadCatalog();
        } catch (error) {
            if (errEl) errEl.textContent = error.message || 'Delete failed.';
        }
    }

    function vendorListForUi() {
        if (allVendorsCache.length) return allVendorsCache;
        return (catalogCache?.vendors || newItemVendors()).map((v) => ({
            slug: v.slug,
            label: v.label || v.slug,
            configured: true,
        }));
    }

    function existingVendorsForCopyUi() {
        if (existingVendorsCache.length) return existingVendorsCache;
        return vendorListForUi().map((v) => ({
            label: v.label || v.slug,
            catalogSlug: v.slug,
            mmxLabel: v.label || v.slug,
        }));
    }

    function renderCopyVendorForm() {
        const root = ensureBackdrop();
        const wrap = root.querySelector('#admin-buildto-copy-wrap');
        if (!wrap) return;
        const vendors = vendorListForUi();
        const sourceSlug = String(configureVendorFilter || vendors[0]?.slug || '').trim();
        const existingVendors = existingVendorsForCopyUi();
        wrap.innerHTML = `
            <div class="admin-buildto-new admin-buildto-copy" id="admin-buildto-copy">
                <h3>Copy to vendor</h3>
                <div class="admin-buildto-new-grid">
                    <label>Source vendor
                        <select data-copy-vendor="sourceSelect" class="admin-buildto-type-select" aria-label="Source vendor">
                            ${vendors
                                .map(
                                    (v) =>
                                        `<option value="${escapeHtml(v.slug)}" ${v.slug === sourceSlug ? 'selected' : ''}>${escapeHtml(v.label || v.slug)}</option>`
                                )
                                .join('')}
                        </select>
                    </label>
                    <div data-copy-vendor="newPanel" class="admin-buildto-copy-panel">
                        <label>Vendor name
                            <input type="text" data-copy-vendor="newName" class="admin-buildto-code-input" placeholder="e.g. Sands" />
                        </label>
                        <label>MMX scheduled order label
                            <input type="text" data-copy-vendor="mmxLabel" class="admin-buildto-code-input" placeholder="e.g. Sands WA" />
                        </label>
                    </div>
                    <div data-copy-vendor="existingPanel" class="admin-buildto-copy-panel" hidden>
                        <label>Existing vendor
                            <select data-copy-vendor="existingSelect" class="admin-buildto-type-select">
                                ${existingVendors.length
                                    ? existingVendors
                                          .map(
                                              (v) =>
                                                  `<option value="${escapeHtml(v.label)}">${escapeHtml(v.label)}</option>`
                                          )
                                          .join('')
                                    : '<option value="">No existing vendors yet</option>'}
                            </select>
                        </label>
                        <fieldset data-copy-vendor="modeWrap" class="admin-buildto-copy-mode">
                            <legend>If target already has items</legend>
                            <label class="admin-buildto-copy-mode-option">
                                <input type="radio" name="admin-buildto-copy-mode" data-copy-vendor="mode" value="append" checked />
                                Append missing items only
                            </label>
                            <label class="admin-buildto-copy-mode-option">
                                <input type="radio" name="admin-buildto-copy-mode" data-copy-vendor="mode" value="replace" />
                                Replace entire catalog
                            </label>
                        </fieldset>
                    </div>
                </div>
                <p class="admin-modal-error admin-buildto-new-error" data-copy-vendor="error" role="alert"></p>
                <div class="admin-buildto-new-actions admin-buildto-copy-actions">
                    <button type="button" class="mic-settings-btn admin-btn-primary" data-copy-vendor="submit">Copy items</button>
                    <button type="button" class="mic-settings-btn admin-buildto-copy-mode-switch" data-copy-vendor="modeSwitch">Copy to existing vendor</button>
                    <button type="button" class="admin-buildto-close-btn" data-copy-vendor="cancel">Cancel</button>
                </div>
            </div>`;

        const form = wrap.querySelector('#admin-buildto-copy');
        const newPanel = form.querySelector('[data-copy-vendor="newPanel"]');
        const existingPanel = form.querySelector('[data-copy-vendor="existingPanel"]');
        const modeSwitch = form.querySelector('[data-copy-vendor="modeSwitch"]');
        const newNameInput = form.querySelector('[data-copy-vendor="newName"]');
        const mmxInput = form.querySelector('[data-copy-vendor="mmxLabel"]');
        let copyTargetMode = 'new';

        function syncCopyFormUi() {
            const isExisting = copyTargetMode === 'existing';
            if (newPanel) newPanel.hidden = isExisting;
            if (existingPanel) existingPanel.hidden = !isExisting;
            if (modeSwitch) {
                modeSwitch.textContent = isExisting ? 'Copy to new vendor' : 'Copy to existing vendor';
            }
        }

        newNameInput?.addEventListener('input', () => {
            if (mmxInput && !mmxInput.dataset.touched) {
                mmxInput.value = String(newNameInput.value || '').trim();
            }
        });
        mmxInput?.addEventListener('input', () => {
            mmxInput.dataset.touched = '1';
        });
        modeSwitch?.addEventListener('click', () => {
            copyTargetMode = copyTargetMode === 'existing' ? 'new' : 'existing';
            if (mmxInput) delete mmxInput.dataset.touched;
            syncCopyFormUi();
        });
        syncCopyFormUi();

        form.querySelector('[data-copy-vendor="cancel"]')?.addEventListener('click', () => {
            wrap.hidden = true;
        });
        form.querySelector('[data-copy-vendor="submit"]')?.addEventListener('click', () => {
            void submitCopyVendor(form, copyTargetMode);
        });
    }

    function toggleCopyVendorForm() {
        const root = ensureBackdrop();
        const wrap = root.querySelector('#admin-buildto-copy-wrap');
        const newWrap = root.querySelector('#admin-buildto-new-wrap');
        if (!wrap) return;
        if (wrap.hidden) {
            if (newWrap) newWrap.hidden = true;
            renderCopyVendorForm();
            wrap.hidden = false;
        } else {
            wrap.hidden = true;
        }
    }

    async function submitCopyVendor(form, copyTargetMode = 'new') {
        const errorEl = form.querySelector('[data-copy-vendor="error"]');
        if (errorEl) errorEl.textContent = '';

        const newName = String(form.querySelector('[data-copy-vendor="newName"]')?.value || '').trim();
        const mmxLabel = String(form.querySelector('[data-copy-vendor="mmxLabel"]')?.value || '').trim();
        const mode =
            form.querySelector('[data-copy-vendor="mode"]:checked')?.value === 'replace' ? 'replace' : 'append';
        const existingLabel = String(form.querySelector('[data-copy-vendor="existingSelect"]')?.value || '').trim();
        const sourceSlug = String(form.querySelector('[data-copy-vendor="sourceSelect"]')?.value || '').trim();
        if (!sourceSlug) {
            if (errorEl) errorEl.textContent = 'Select a source vendor.';
            return;
        }

        const body = { sourceSlug, mode, mmxOrderLabel: mmxLabel };
        if (copyTargetMode === 'existing') {
            if (!existingLabel) {
                if (errorEl) errorEl.textContent = 'Select an existing vendor.';
                return;
            }
            body.targetExistingLabel = existingLabel;
            body.mmxOrderLabel = existingLabel;
        } else {
            if (!newName) {
                if (errorEl) errorEl.textContent = 'Enter a name for the new vendor.';
                return;
            }
            if (!mmxLabel) {
                if (errorEl) errorEl.textContent = 'MMX scheduled order label is required.';
                return;
            }
            body.targetLabel = newName;
        }

        const submitBtn = form.querySelector('[data-copy-vendor="submit"]');
        submitBtn.disabled = true;
        try {
            const res = await fetch('/api/admin/build-to/vendors/copy', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify(body),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.success) throw new Error(data.error || 'Copy failed.');
            const root = ensureBackdrop();
            const wrap = root.querySelector('#admin-buildto-copy-wrap');
            if (wrap) wrap.hidden = true;
            configureVendorFilter = data.targetSlug || configureVendorFilter;
            root.querySelector('#admin-buildto-error').textContent =
                `Copied ${data.copied} item(s) to ${data.targetLabel || data.targetSlug}` +
                (data.skipped ? ` (${data.skipped} skipped as duplicates).` : '.');
            await loadCatalog();
        } catch (error) {
            if (errorEl) errorEl.textContent = error.message || 'Copy failed.';
        } finally {
            submitBtn.disabled = false;
        }
    }

    function newItemVendors() {
        return (catalogCache?.vendors || []).map((vendor) => ({
            slug: vendor.slug,
            label: vendor.label || vendor.slug,
            locations: Array.isArray(vendor.locations) ? vendor.locations : [],
        }));
    }

    function renderNewItemLocations(form, vendorSlug) {
        const host = form.querySelector('[data-new-item="locations"]');
        if (!host) return;
        const vendor = newItemVendors().find((v) => v.slug === vendorSlug);
        const locations = vendor?.locations || [];
        host.innerHTML = `
            ${locations
                .map(
                    (loc) => `
                <label class="admin-buildto-new-loc">
                    <input type="checkbox" data-new-item-location value="${escapeHtml(loc)}" />
                    <span>${escapeHtml(loc)}</span>
                </label>`
                )
                .join('')}
            <input type="text" data-new-item="newLocation" class="admin-buildto-code-input" placeholder="New location…" title="Optional: a new stock-count tab/location name" />`;
    }

    function applyNewItemRuleType(form) {
        const type = form.querySelector('[data-new-item="ruleType"]')?.value || 'days';
        const showDays = type === 'days' || type === 'on-hand';
        form.querySelectorAll('[data-new-item-group="days"]').forEach((el) => {
            el.classList.toggle('admin-buildto-group--off', !showDays);
        });
        form.querySelectorAll('[data-new-item-group="fixed"]').forEach((el) => {
            el.classList.toggle('admin-buildto-group--off', showDays);
        });
    }

    function renderNewItemForm() {
        const root = ensureBackdrop();
        const wrap = root.querySelector('#admin-buildto-new-wrap');
        if (!wrap) return;
        const vendors = newItemVendors();
        if (!vendors.length) {
            wrap.innerHTML = '<p>Load a catalog first.</p>';
            return;
        }
        wrap.innerHTML = `
            <div class="admin-buildto-new" id="admin-buildto-new">
                <h3>New item</h3>
                <div class="admin-buildto-new-grid">
                    <label>Vendor
                        <select data-new-item="vendor" class="admin-buildto-type-select">
                            ${vendors.map((v) => `<option value="${escapeHtml(v.slug)}">${escapeHtml(v.label)}</option>`).join('')}
                        </select>
                    </label>
                    <label>Item name
                        <input type="text" data-new-item="name" class="admin-buildto-code-input" placeholder="e.g. TB SAUCE VERDE 10X1KG" />
                    </label>
                    <label>MMX / item code
                        <input type="text" data-new-item="itemCode" class="admin-buildto-code-input" placeholder="e.g. 38123" title="Macromatix Key Item Count / ISE code" />
                    </label>
                    <label>Vendor code <span class="admin-buildto-new-optional">optional</span>
                        <input type="text" data-new-item="vendorCode" class="admin-buildto-code-input" placeholder="Same as item code" title="Vendor order code, if different" />
                    </label>
                    <label>Fallback codes <span class="admin-buildto-new-optional">optional</span>
                        <input type="text" data-new-item="fallbackCodes" class="admin-buildto-code-input" placeholder="Comma-separated" title="Extra ISE/SOH codes, tried in order" />
                    </label>
                    <label>Type
                        <select data-new-item="ruleType" class="admin-buildto-type-select">
                            <option value="days" selected>Days</option>
                            <option value="on-hand">On hand</option>
                            <option value="manual">Manual</option>
                        </select>
                    </label>
                    <label data-new-item-group="days">Days
                        <input type="number" min="1" max="31" data-new-item="buildToDays" class="admin-buildto-num-input" value="10" />
                    </label>
                    <label data-new-item-group="days">+Buffer
                        <input type="number" min="0" max="99" data-new-item="buildToAdd" class="admin-buildto-num-input" value="0" />
                    </label>
                    <label data-new-item-group="fixed" class="admin-buildto-group--off">Fixed build-to
                        <input type="number" min="0" max="999" step="any" data-new-item="buildToFixed" class="admin-buildto-num-input" placeholder="Blank = stock count only" />
                    </label>
                    <label>Outer unit
                        <input type="text" data-new-item="unit0" class="admin-buildto-code-input" value="Boxes" title="First count column (Boxes, Cartons, Bags…)" />
                    </label>
                    <label>Inner unit
                        <input type="text" data-new-item="unit1" class="admin-buildto-code-input" value="N/a" title="Second count column, or N/a" />
                    </label>
                    <label>Unit
                        <input type="text" data-new-item="unit2" class="admin-buildto-code-input" value="N/a" title="Third count column (KGs, Each…), or N/a" />
                    </label>
                    <label>Inner per carton <span class="admin-buildto-new-optional">optional</span>
                        <input type="number" min="0" step="any" data-new-item="innerPerCarton" class="admin-buildto-num-input" placeholder="-" title="Inner units per carton (e.g. 10 packs per box)" />
                    </label>
                </div>
                <div class="admin-buildto-new-locrow">
                    <span class="admin-buildto-new-label">Count locations</span>
                    <div class="admin-buildto-new-locs" data-new-item="locations"></div>
                </div>
                <div class="admin-buildto-new-flags">
                    <label><input type="checkbox" data-new-item="includeKeyItem" /> Key Item Count</label>
                    <label><input type="checkbox" data-new-item="includeDaily" /> Daily count</label>
                </div>
                <p class="admin-modal-error admin-buildto-new-error" data-new-item="error" role="alert"></p>
                <div class="admin-buildto-new-actions">
                    <button type="button" class="mic-settings-btn admin-btn-primary" data-new-item="submit">Add item</button>
                    <button type="button" class="admin-buildto-close-btn" data-new-item="cancel">Cancel</button>
                </div>
            </div>`;

        const form = wrap.querySelector('#admin-buildto-new');
        const vendorSelect = form.querySelector('[data-new-item="vendor"]');
        renderNewItemLocations(form, vendorSelect.value);
        vendorSelect.addEventListener('change', () => renderNewItemLocations(form, vendorSelect.value));
        form.querySelector('[data-new-item="ruleType"]').addEventListener('change', () => applyNewItemRuleType(form));
        form.querySelector('[data-new-item="cancel"]').addEventListener('click', () => {
            wrap.hidden = true;
        });
        form.querySelector('[data-new-item="submit"]').addEventListener('click', () => {
            void submitNewItem(form);
        });
    }

    function toggleNewItemForm() {
        const root = ensureBackdrop();
        const wrap = root.querySelector('#admin-buildto-new-wrap');
        if (!wrap) return;
        if (wrap.hidden) {
            renderNewItemForm();
            wrap.hidden = false;
            wrap.querySelector('[data-new-item="name"]')?.focus();
        } else {
            wrap.hidden = true;
        }
    }

    async function submitNewItem(form) {
        const field = (key) => form.querySelector(`[data-new-item="${key}"]`);
        const errorEl = field('error');
        errorEl.textContent = '';

        const locations = [...form.querySelectorAll('[data-new-item-location]:checked')].map((el) => el.value);
        const newLocation = String(field('newLocation')?.value || '').trim();
        if (newLocation) locations.push(newLocation);

        const body = {
            vendor: field('vendor')?.value || '',
            name: String(field('name')?.value || '').trim(),
            itemCode: String(field('itemCode')?.value || '').trim(),
            vendorCode: String(field('vendorCode')?.value || '').trim(),
            fallbackCodes: String(field('fallbackCodes')?.value || '').trim(),
            ruleType: field('ruleType')?.value || 'days',
            buildToDays: field('buildToDays')?.value,
            buildToAdd: field('buildToAdd')?.value,
            buildToFixed: field('buildToFixed')?.value,
            units: [field('unit0')?.value, field('unit1')?.value, field('unit2')?.value],
            locations,
            innerPerCarton: field('innerPerCarton')?.value,
            includeKeyItem: Boolean(field('includeKeyItem')?.checked),
            includeDaily: Boolean(field('includeDaily')?.checked),
        };
        if (!body.name) {
            errorEl.textContent = 'Item name is required.';
            return;
        }
        if (!body.itemCode) {
            errorEl.textContent = 'Item code is required.';
            return;
        }

        const submitBtn = field('submit');
        submitBtn.disabled = true;
        try {
            const res = await fetch('/api/admin/build-to/items', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify(body),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.success) throw new Error(data.error || 'Could not add item.');
            const root = ensureBackdrop();
            const wrap = root.querySelector('#admin-buildto-new-wrap');
            if (wrap) wrap.hidden = true;
            const search = root.querySelector('#admin-buildto-search');
            if (search) search.value = data.itemCode || body.itemCode;
            await loadCatalog();
        } catch (error) {
            errorEl.textContent = error.message || 'Could not add item.';
        } finally {
            submitBtn.disabled = false;
        }
    }

    function parseFallbackInput(value) {
        return String(value || '')
            .split(/[,;\s]+/)
            .map((part) => part.trim())
            .filter(Boolean);
    }

    function sameCodeList(a, b) {
        const left = parseFallbackInput(a).map((c) => c.toUpperCase());
        const right = parseFallbackInput(b).map((c) => c.toUpperCase());
        if (left.length !== right.length) return false;
        return left.every((code, i) => code === right[i]);
    }

    function readUnitsFromRow(row) {
        const units = ['N/a', 'N/a', 'N/a'];
        for (let i = 0; i < 3; i++) {
            const enabled = Boolean(row.querySelector(`[data-field="enableUnit${i}"]`)?.checked);
            if (enabled) {
                units[i] = String(row.querySelector(`[data-field="unit${i}"]`)?.value || 'N/a').trim() || 'N/a';
            }
        }
        return units;
    }

    function sameUnits(a, b) {
        const left = Array.isArray(a) ? a : JSON.parse(a || '[]');
        const right = Array.isArray(b) ? b : JSON.parse(b || '[]');
        if (left.length !== 3 || right.length !== 3) return false;
        return left.every((val, i) => String(val).trim().toLowerCase() === String(right[i]).trim().toLowerCase());
    }

    function collectConfigurePatch(row, rule) {
        if (!canEditItemCodes) return;
        const mmx = String(row.querySelector('[data-field="mmxCode"]')?.value || '').trim();
        const vendorCode = String(row.querySelector('[data-field="vendorCode"]')?.value || '').trim();
        const fallbacks = String(row.querySelector('[data-field="fallbackCodes"]')?.value || '').trim();
        const vendorSlug = String(row.querySelector('[data-field="vendorSlug"]')?.value || '').trim();
        const innerRaw = row.querySelector('[data-field="innerPerCarton"]')?.value;
        const unitsPerPackRaw = row.querySelector('[data-field="unitsPerPack"]')?.value;
        const catalogName = String(row.querySelector('[data-field="catalogName"]')?.value || '').trim();
        const displayName = String(row.querySelector('[data-field="displayName"]')?.value || '').trim();
        const units = readUnitsFromRow(row);

        const catalogMmx = row.dataset.catalogMmx || '';
        const catalogVendor = row.dataset.catalogVendorSlug || '';
        const loadedMmx = row.dataset.loadedMmx || '';
        const loadedVendor = row.dataset.loadedVendor || '';
        const loadedFallbacks = row.dataset.loadedFallbacks || '';
        const loadedVendorSlug = row.dataset.loadedVendorSlug || '';
        const loadedUnits = JSON.parse(row.dataset.loadedUnits || '["N/a","N/a","N/a"]');
        const fileUnits = JSON.parse(row.dataset.fileUnits || '["N/a","N/a","N/a"]');
        const fileInner = row.dataset.fileInnerPerCarton || '';
        const fileUnitsPerPack = row.dataset.fileUnitsPerPack || '';
        const initialVendorSlug = row.dataset.initialVendorSlug || '';
        const initialUnits = row.dataset.initialUnits || '';
        const initialInner = row.dataset.initialInnerPerCarton || '';
        const initialUnitsPerPack = row.dataset.initialUnitsPerPack || '';
        const fileCatalogName = row.dataset.fileCatalogName || '';
        const fileDisplayName = row.dataset.fileDisplayName || '';
        const loadedCatalogName = row.dataset.loadedCatalogName || '';
        const loadedDisplayName = row.dataset.loadedDisplayName || '';

        if (catalogName && catalogName !== loadedCatalogName) {
            rule.catalogName = catalogName;
        }

        if (displayName !== loadedDisplayName) {
            rule.displayName = displayName || null;
        }

        if (mmx !== loadedMmx) {
            rule.mmxCode = mmx && mmx !== catalogMmx ? mmx : null;
        }

        if (vendorCode !== loadedVendor) {
            rule.vendorCode = vendorCode && vendorCode !== catalogMmx ? vendorCode : null;
        }

        if (!sameCodeList(fallbacks, loadedFallbacks)) {
            const list = parseFallbackInput(fallbacks);
            rule.fallbackCodes = list.length ? list : null;
        }

        if (vendorSlug !== loadedVendorSlug) {
            rule.vendorSlug = vendorSlug && vendorSlug !== catalogVendor ? vendorSlug : null;
        } else if (initialVendorSlug && vendorSlug === catalogVendor) {
            rule.vendorSlug = null;
        }

        if (!sameUnits(units, loadedUnits)) {
            rule.units = sameUnits(units, fileUnits) ? null : units;
        } else if (initialUnits && sameUnits(units, fileUnits)) {
            rule.units = null;
        }

        const innerValue = innerRaw !== '' && innerRaw != null ? String(innerRaw).trim() : '';
        const loadedInnerStr = row.dataset.loadedInnerPerCarton || '';
        const fileInnerNum = fileInner !== '' ? Number(fileInner) : null;
        const effectiveInner = innerValue !== '' ? Number(innerValue) : null;

        if (innerValue !== loadedInnerStr) {
            if (effectiveInner != null && Number.isFinite(effectiveInner)) {
                rule.innerPerCarton =
                    fileInnerNum != null && effectiveInner === fileInnerNum ? null : effectiveInner;
            } else if (fileInnerNum != null) {
                rule.innerPerCarton = null;
            }
        } else if (initialInner && innerValue === (fileInner !== '' ? fileInner : '')) {
            rule.innerPerCarton = null;
        }

        const unitsPerPackValue =
            unitsPerPackRaw !== '' && unitsPerPackRaw != null ? String(unitsPerPackRaw).trim() : '';
        const loadedUnitsPerPackStr = row.dataset.loadedUnitsPerPack || '';
        const fileUnitsPerPackNum = fileUnitsPerPack !== '' ? Number(fileUnitsPerPack) : null;
        const effectiveUnitsPerPack = unitsPerPackValue !== '' ? Number(unitsPerPackValue) : null;

        if (unitsPerPackValue !== loadedUnitsPerPackStr) {
            if (effectiveUnitsPerPack != null && Number.isFinite(effectiveUnitsPerPack)) {
                rule.unitsPerPack =
                    fileUnitsPerPackNum != null && effectiveUnitsPerPack === fileUnitsPerPackNum
                        ? null
                        : effectiveUnitsPerPack;
            } else if (fileUnitsPerPackNum != null) {
                rule.unitsPerPack = null;
            }
        } else if (
            initialUnitsPerPack &&
            unitsPerPackValue === (fileUnitsPerPack !== '' ? fileUnitsPerPack : '')
        ) {
            rule.unitsPerPack = null;
        }
    }

    function collectPatch() {
        const root = ensureBackdrop();
        const scope = getOverrideScope();
        const useAreaLayer = scope.level === 'area';
        const patch = {};
        root.querySelectorAll('tbody tr[data-item-code]').forEach((row) => {
            const code = row.getAttribute('data-item-code');
            const rule = {};
            const ruleType = row.querySelector('[data-field="ruleType"]')?.value || 'days';
            const days = row.querySelector('[data-field="buildToDays"]')?.value;
            const add = row.querySelector('[data-field="buildToAdd"]')?.value;
            const fixed = row.querySelector('[data-field="buildToFixed"]')?.value;
            const needsCount = Boolean(row.querySelector('[data-field="needsCount"]')?.checked);
            const includeDaily = Boolean(row.querySelector('[data-field="includeDaily"]')?.checked);
            const warnDays = row.querySelector('[data-field="stockWarningDays"]')?.value;
            const initialWarn = row.dataset.initialStockWarning || '';
            const catalogNeedsCount = row.dataset.catalogNeedsCount === '1';
            const catalogIncludeDaily = row.dataset.catalogIncludeDaily === '1';
            const hadSkipOverride = useAreaLayer
                ? row.dataset.areaSkipOverride === '1'
                : row.dataset.storeSkipOverride === '1';
            const hadSkipKeyOverride = useAreaLayer
                ? row.dataset.areaSkipKeyOverride === '1'
                : row.dataset.storeSkipKeyOverride === '1';
            const hadIncludeDailyOverride = useAreaLayer
                ? row.dataset.areaIncludeDailyOverride === '1'
                : row.dataset.storeIncludeDailyOverride === '1';
            const initialRuleType = row.dataset.initialRuleType || 'days';

            if (ruleType === 'days') {
                if (days !== '') rule.buildToDays = Number(days);
                if (add !== '') rule.buildToAdd = Number(add);
                if (initialRuleType !== 'days') {
                    rule.buildToFixed = null;
                    rule.buildToManual = null;
                    if (initialRuleType === 'on-hand' || hadSkipKeyOverride) {
                        rule.skipKeyItemCount = null;
                    }
                }
            } else if (ruleType === 'on-hand') {
                if (days !== '') rule.buildToDays = Number(days);
                if (add !== '') rule.buildToAdd = Number(add);
                rule.buildToFixed = null;
                if (initialRuleType !== 'on-hand') {
                    rule.buildToManual = null;
                    rule.skipKeyItemCount = true;
                }
            } else if (ruleType === 'manual') {
                if (fixed !== '') rule.buildToFixed = Number(fixed);
                else if (initialRuleType === 'manual') rule.buildToFixed = null;
                if (initialRuleType !== 'manual') {
                    rule.buildToDays = null;
                    rule.buildToAdd = null;
                    rule.buildToManual = true;
                    if (initialRuleType === 'on-hand' || hadSkipKeyOverride) {
                        rule.skipKeyItemCount = null;
                    }
                }
            }

            if (needsCount !== catalogNeedsCount) {
                rule.skipStockCount = !needsCount;
            } else if (hadSkipOverride) {
                rule.skipStockCount = null;
            }

            if (includeDaily !== catalogIncludeDaily) {
                rule.includeDaily = includeDaily;
            } else if (hadIncludeDailyOverride) {
                rule.includeDaily = null;
            }

            const defaultWarn = row.dataset.defaultStockWarning || '5';
            const effectiveWarn = warnDays !== '' ? String(warnDays) : defaultWarn;
            if (initialWarn !== '') {
                if (effectiveWarn !== initialWarn) {
                    rule.stockWarningDays = effectiveWarn === defaultWarn ? null : Number(effectiveWarn);
                }
            } else if (effectiveWarn !== defaultWarn) {
                rule.stockWarningDays = Number(effectiveWarn);
            }

            if (Object.keys(rule).length) patch[code] = rule;
        });
        return patch;
    }

    function collectConfigurePatchAll() {
        const root = ensureBackdrop();
        const patch = {};
        root.querySelectorAll('tbody tr[data-item-code]').forEach((row) => {
            const code = row.getAttribute('data-item-code');
            const rule = {};
            collectConfigurePatch(row, rule);
            if (Object.keys(rule).length) patch[code] = rule;
        });
        return patch;
    }

    async function readSaveResponse(res) {
        const text = await res.text();
        if (!text) return {};
        try {
            return JSON.parse(text);
        } catch {
            return {};
        }
    }

    async function putBuildToOverrides(body) {
        const res = await fetch('/api/admin/build-to/overrides', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify(body),
        });
        const data = await readSaveResponse(res);
        if (!res.ok) {
            throw new Error(data.error || `Save failed (${res.status}).`);
        }
        if (data.success === false) {
            throw new Error(data.error || 'Save failed.');
        }
    }

    async function saveChanges() {
        const root = ensureBackdrop();
        const errEl = root.querySelector('#admin-buildto-error');
        const saveBtn = root.querySelector('#admin-buildto-save');
        if (saveBtn?.disabled) return;

        if (errEl) errEl.textContent = '';
        const defaultLabel = 'Save changes';
        const startedAt = Date.now();
        if (saveBtn) {
            saveBtn.disabled = true;
            saveBtn.textContent = 'Saving…';
        }

        try {
            if (viewMode === 'configure') {
                const patch = collectConfigurePatchAll();
                await putBuildToOverrides({ global: patch });
            } else {
                const patch = collectPatch();
                const scope = getOverrideScope();
                if (scope.level === 'none') throw new Error('Select an area or store first.');
                if (scope.level === 'store') {
                    await putBuildToOverrides({ stores: { [scope.store]: patch } });
                } else if (scope.level === 'area') {
                    await putBuildToOverrides({ areas: { [scope.area]: patch } });
                } else {
                    throw new Error('Select an area or store first.');
                }
            }

            try {
                await loadCatalog();
                if (errEl) errEl.textContent = '';
            } catch (reloadError) {
                if (errEl) {
                    errEl.textContent =
                        reloadError.message || 'Changes saved, but the table could not refresh.';
                }
            }
        } catch (error) {
            if (errEl) errEl.textContent = error.message || 'Save failed.';
        } finally {
            const remainingMs = Math.max(0, 1000 - (Date.now() - startedAt));
            if (remainingMs) await new Promise((resolve) => setTimeout(resolve, remainingMs));
            if (saveBtn) {
                saveBtn.disabled = false;
                saveBtn.textContent = defaultLabel;
            }
        }
    }

    async function open() {
        const root = ensureBackdrop();
        if (!isInline()) root.hidden = false;
        root.querySelector('#admin-buildto-error').textContent = '';
        const me = await fetchProfile();
        canConfigure =
            Boolean(me.canEditGlobalBuildTo) ||
            (Array.isArray(me.accessibleAreas) && me.accessibleAreas.length > 0);
        canEditItemCodes = Boolean(me.canEditGlobalBuildTo);
        canAddItems = Boolean(me.canEditGlobalBuildTo);
        canCopyVendor = Boolean(me.canEditGlobalBuildTo);
        const addBtn = root.querySelector('#admin-buildto-add');
        const modeToggle = root.querySelector('#admin-buildto-mode-toggle');
        if (modeToggle) modeToggle.hidden = !canAddItems;
        viewMode = 'rules';
        applyViewModeUi();
        storeList = await loadStores();
        await loadScopeTree();
        renderScopeNavigator();
        root.querySelector('#admin-buildto-body').innerHTML = '<p>Loading…</p>';
        try {
            await loadCatalog();
        } catch (error) {
            root.querySelector('#admin-buildto-error').textContent = error.message;
        }
    }

    function mount(host, options = {}) {
        pageHost = host;
        return open(options);
    }

    function setInlineHost(host) {
        pageHost = host || null;
    }

    function unmount() {
        pageHost = null;
    }

    global.AdminBuildTo = { open, close, mount, unmount, setInlineHost };
})(window);
