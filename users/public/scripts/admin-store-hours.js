(function (global) {
    const DAY_ROWS = [
        { index: 1, label: 'Monday' },
        { index: 2, label: 'Tuesday' },
        { index: 3, label: 'Wednesday' },
        { index: 4, label: 'Thursday' },
        { index: 5, label: 'Friday' },
        { index: 6, label: 'Saturday' },
        { index: 0, label: 'Sunday' },
    ];

    const AREA_STORAGE_KEY = 'admin-store-hours-area';
    const STORE_STORAGE_KEY = 'admin-store-hours-store';

    let pageHost = null;
    let storesPayload = [];
    let canEdit = false;
    let activeArea = '';
    let activeStoreNumber = '';
    let currentConfig = null;
    let scheduleType = 'uniform';

    function escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function getRoot() {
        return pageHost || null;
    }

    function areaChipLabel(areaId) {
        const fromDisplay = global.AreaDisplay?.label?.(areaId);
        if (fromDisplay) return fromDisplay;
        const raw = String(areaId ?? '');
        return raw.replace(/-1$/i, '') || raw;
    }

    function normalizeAreaKey(value) {
        return String(value || '')
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/(^-|-$)/g, '');
    }

    function orderedAreas() {
        const canonical = ['VIC-1', 'WA-1', 'QLD-1'];
        const areas = [...new Set(storesPayload.map((s) => String(s.area || '').trim()).filter(Boolean))];
        const picked = canonical.filter((id) => areas.includes(id));
        const rest = areas.filter((id) => !canonical.includes(id)).sort();
        return picked.length ? [...picked, ...rest] : rest;
    }

    function storesInActiveArea() {
        const key = normalizeAreaKey(activeArea);
        return storesPayload
            .filter((s) => !key || normalizeAreaKey(s.area) === key)
            .sort((a, b) =>
                String(a.storeNumber).localeCompare(String(b.storeNumber), undefined, { numeric: true })
            );
    }

    function pickDefaultArea() {
        const areas = orderedAreas();
        const saved = sessionStorage.getItem(AREA_STORAGE_KEY);
        if (saved && areas.includes(saved)) return saved;
        return areas[0] || '';
    }

    function pickDefaultStore(areaStores) {
        const saved = sessionStorage.getItem(STORE_STORAGE_KEY);
        if (saved && areaStores.some((s) => String(s.storeNumber) === saved)) return saved;
        return areaStores[0]?.storeNumber || '';
    }

    function hourLabel(hour) {
        const n = Number(hour);
        if (!Number.isFinite(n)) return '';
        if (n === 24 || n === 0) return 'midnight';
        if (n > 24) return `${n - 24}:00 next day`;
        const h = n % 24;
        const suffix = h < 12 ? 'am' : 'pm';
        const display = h % 12 || 12;
        return `${display}${suffix}`;
    }

    function formatHourRange(openHour, closeHour) {
        return `${openHour}:00 – ${closeHour}:00`;
    }

    function scheduleSummary(store) {
        if (store.scheduleType === 'per-day') return 'Different by day of week';
        const uniform = store.uniform || { openHour: store.openHour, closeHour: store.closeHour };
        return `Every day ${formatHourRange(uniform.openHour, uniform.closeHour)}`;
    }

    function todaySummary(store) {
        return `Today ${formatHourRange(store.openHour, store.closeHour)}`;
    }

    function defaultUniform(config) {
        return {
            openHour: config?.uniform?.openHour ?? config?.defaultOpenHour ?? 10,
            closeHour: config?.uniform?.closeHour ?? config?.defaultCloseHour ?? 22,
        };
    }

    function dayHoursFromConfig(config, dayIndex) {
        const key = String(dayIndex);
        if (config?.hoursByDay?.[key]) {
            return {
                openHour: config.hoursByDay[key].openHour,
                closeHour: config.hoursByDay[key].closeHour,
            };
        }
        return defaultUniform(config);
    }

    function storeByNumber(storeNumber) {
        return storesPayload.find((s) => String(s.storeNumber) === String(storeNumber)) || null;
    }

    function renderHourField(name, value, disabled) {
        return `<input type="number" class="admin-store-hours-input" name="${escapeHtml(name)}" min="0" max="30" step="1" value="${escapeHtml(value)}"${disabled ? ' disabled' : ''} aria-label="${escapeHtml(name)}" />`;
    }

    function renderUniformFields(config, disabled) {
        const uniform = defaultUniform(config);
        return `
            <div class="admin-store-hours-uniform">
                <label class="admin-store-hours-field">
                    <span class="admin-store-hours-field-label">Open hour</span>
                    ${renderHourField('uniform-open', uniform.openHour, disabled)}
                    <span class="admin-accounts-meta admin-store-hours-hour-hint">${escapeHtml(hourLabel(uniform.openHour))}</span>
                </label>
                <label class="admin-store-hours-field">
                    <span class="admin-store-hours-field-label">Close hour</span>
                    ${renderHourField('uniform-close', uniform.closeHour, disabled)}
                    <span class="admin-accounts-meta admin-store-hours-hour-hint">${escapeHtml(hourLabel(uniform.closeHour))}</span>
                </label>
            </div>`;
    }

    function renderPerDayFields(config, disabled) {
        const rows = DAY_ROWS.map(({ index, label }) => {
            const hours = dayHoursFromConfig(config, index);
            return `
                <tr>
                    <th scope="row">${escapeHtml(label)}</th>
                    <td>${renderHourField(`day-${index}-open`, hours.openHour, disabled)}</td>
                    <td>${renderHourField(`day-${index}-close`, hours.closeHour, disabled)}</td>
                    <td class="admin-store-hours-day-hint">${escapeHtml(formatHourRange(hours.openHour, hours.closeHour))}</td>
                </tr>`;
        }).join('');
        return `
            <table class="admin-table admin-store-hours-table">
                <thead>
                    <tr>
                        <th scope="col">Day</th>
                        <th scope="col">Open hour</th>
                        <th scope="col">Close hour</th>
                        <th scope="col">Hours</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>`;
    }

    function renderScheduleFields() {
        const root = getRoot();
        const host = root?.querySelector('#admin-store-hours-fields');
        if (!host) return;
        const disabled = !canEdit;
        host.innerHTML =
            scheduleType === 'per-day'
                ? renderPerDayFields(currentConfig, disabled)
                : renderUniformFields(currentConfig, disabled);
        bindHourHints();
    }

    function bindHourHints() {
        const root = getRoot();
        if (!root) return;
        root.querySelectorAll('.admin-store-hours-input').forEach((input) => {
            if (input.dataset.hintBound) return;
            input.dataset.hintBound = '1';
            input.addEventListener('input', () => {
                const row = input.closest('tr');
                if (row) {
                    const open = row.querySelector('[name$="-open"]');
                    const close = row.querySelector('[name$="-close"]');
                    const hint = row.querySelector('.admin-store-hours-day-hint');
                    if (open && close && hint) {
                        hint.textContent = formatHourRange(Number(open.value), Number(close.value));
                    }
                    return;
                }
                const hint = input.closest('.admin-store-hours-field')?.querySelector('.admin-store-hours-hour-hint');
                if (hint) hint.textContent = hourLabel(input.value);
            });
        });
    }

    function renderScheduleToggle() {
        const root = getRoot();
        const host = root?.querySelector('#admin-store-hours-schedule');
        if (!host) return;
        const disabled = !canEdit;
        host.innerHTML = `
            <div class="admin-settings-segmented-tabs admin-accounts-org-nav">
                <div class="admin-accounts-scope-row-wrap">
                    <span class="admin-accounts-scope-row-label">Schedule</span>
                    <div class="admin-accounts-scope-row admin-accounts-scope-row--equal" role="tablist" aria-label="Schedule type" style="--scope-cols: 2">
                        <button type="button" class="admin-accounts-scope-chip${scheduleType === 'uniform' ? ' is-active' : ''}" data-schedule-type="uniform" role="tab"${disabled ? ' disabled' : ''}>Every Day Same Time</button>
                        <button type="button" class="admin-accounts-scope-chip${scheduleType === 'per-day' ? ' is-active' : ''}" data-schedule-type="per-day" role="tab"${disabled ? ' disabled' : ''}>Different by Day of Week</button>
                    </div>
                </div>
            </div>`;
    }

    function renderAreaTabs() {
        const root = getRoot();
        const nav = root?.querySelector('#admin-store-hours-area-tabs');
        if (!nav) return;
        const areas = orderedAreas();
        nav.style.setProperty('--scope-cols', String(Math.max(areas.length, 1)));
        nav.innerHTML = areas
            .map((area) => {
                const isActive = area === activeArea;
                return `<button type="button" class="admin-accounts-scope-chip${isActive ? ' is-active' : ''}" role="tab" aria-selected="${isActive ? 'true' : 'false'}" data-store-hours-area="${escapeHtml(area)}">${escapeHtml(areaChipLabel(area))}</button>`;
            })
            .join('');
    }

    function renderStoreTable() {
        const root = getRoot();
        const host = root?.querySelector('#admin-store-hours-store-table');
        if (!host) return;
        const rows = storesInActiveArea();
        if (!rows.length) {
            host.innerHTML = `<p class="admin-accounts-meta">No stores in ${escapeHtml(areaChipLabel(activeArea) || 'this area')}.</p>`;
            return;
        }
        const body = rows
            .map((store) => {
                const selected = String(store.storeNumber) === String(activeStoreNumber);
                return `<tr class="admin-store-hours-store-row${selected ? ' is-selected' : ''}" data-store-hours-store="${escapeHtml(store.storeNumber)}" tabindex="0" role="button" aria-pressed="${selected ? 'true' : 'false'}">
                    <td class="admin-store-hours-col-store">${escapeHtml(store.storeNumber)}<span class="admin-accounts-meta">${escapeHtml(store.storeName || '')}</span></td>
                    <td>${escapeHtml(scheduleSummary(store))}</td>
                    <td>${escapeHtml(todaySummary(store))}</td>
                </tr>`;
            })
            .join('');
        host.innerHTML = `
            <table class="admin-table admin-store-hours-store-table">
                <thead>
                    <tr>
                        <th scope="col">Store</th>
                        <th scope="col">Schedule</th>
                        <th scope="col">Resolved today</th>
                    </tr>
                </thead>
                <tbody>${body}</tbody>
            </table>`;
    }

    function renderEditor() {
        const root = getRoot();
        const editor = root?.querySelector('#admin-store-hours-editor');
        if (!editor) return;
        const store = storeByNumber(activeStoreNumber);
        if (!store || !currentConfig) {
            editor.hidden = true;
            return;
        }
        editor.hidden = false;
        const title = root.querySelector('#admin-store-hours-editor-title');
        if (title) {
            title.textContent = `${store.storeNumber} ${store.storeName || ''}`.trim();
        }
        const meta = root.querySelector('#admin-store-hours-editor-meta');
        if (meta) {
            meta.textContent = `${store.area || ''} · ${store.timeZone || ''}`.replace(/^ · /, '');
        }
        renderScheduleToggle();
        renderScheduleFields();
        const saveBtn = root.querySelector('#admin-store-hours-save');
        if (saveBtn) saveBtn.hidden = !canEdit;
    }

    function renderShell() {
        const root = getRoot();
        if (!root) return;
        root.innerHTML = `
            <div class="admin-modal admin-modal--inline admin-store-hours">
                <h2>Operating times</h2>
                <div class="admin-settings-segmented-tabs admin-accounts-browse-scope admin-accounts-org-nav admin-store-hours-area-nav">
                    <div class="admin-accounts-scope-row-wrap">
                        <span class="admin-accounts-scope-row-label">Area</span>
                        <nav class="admin-accounts-scope-row admin-accounts-scope-row--equal admin-store-hours-area-tabs" id="admin-store-hours-area-tabs" role="tablist" aria-label="Select area"></nav>
                    </div>
                </div>
                <div class="admin-settings-scroll-body">
                    <div id="admin-store-hours-store-table"></div>
                    <section id="admin-store-hours-editor" class="admin-store-hours-editor" hidden>
                        <h3 id="admin-store-hours-editor-title" class="admin-store-hours-editor-title"></h3>
                        <p id="admin-store-hours-editor-meta" class="admin-accounts-meta"></p>
                        <div id="admin-store-hours-schedule"></div>
                        <div id="admin-store-hours-fields"></div>
                        <div class="admin-store-hours-actions">
                            <button type="button" class="mic-settings-btn admin-btn-primary" id="admin-store-hours-save" hidden>Save changes</button>
                        </div>
                    </section>
                </div>
                <p id="admin-store-hours-error" class="admin-modal-error" role="alert"></p>
            </div>`;
        bindShell();
        renderAreaTabs();
        renderStoreTable();
        renderEditor();
    }

    function bindShell() {
        const root = getRoot();
        if (!root || root.dataset.storeHoursBound) return;
        root.dataset.storeHoursBound = '1';

        root.addEventListener('click', (event) => {
            const areaTab = event.target.closest('[data-store-hours-area]');
            if (areaTab) {
                selectArea(areaTab.getAttribute('data-store-hours-area') || '');
                return;
            }

            const scheduleBtn = event.target.closest('[data-schedule-type]');
            if (scheduleBtn && !scheduleBtn.disabled) {
                const next = scheduleBtn.getAttribute('data-schedule-type');
                if (next && next !== scheduleType) {
                    scheduleType = next;
                    renderScheduleToggle();
                    renderScheduleFields();
                }
                return;
            }

            const storeRow = event.target.closest('[data-store-hours-store]');
            if (storeRow) {
                void selectStore(storeRow.getAttribute('data-store-hours-store') || '');
            }
        });

        root.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            const storeRow = event.target.closest('[data-store-hours-store]');
            if (!storeRow) return;
            event.preventDefault();
            void selectStore(storeRow.getAttribute('data-store-hours-store') || '');
        });

        root.querySelector('#admin-store-hours-save')?.addEventListener('click', () => {
            void saveChanges();
        });
    }

    function selectArea(area) {
        if (!area || area === activeArea) return;
        activeArea = area;
        sessionStorage.setItem(AREA_STORAGE_KEY, activeArea);
        const areaStores = storesInActiveArea();
        activeStoreNumber = pickDefaultStore(areaStores);
        if (activeStoreNumber) sessionStorage.setItem(STORE_STORAGE_KEY, activeStoreNumber);
        renderAreaTabs();
        renderStoreTable();
        void loadStoreHours(activeStoreNumber);
    }

    async function selectStore(storeNumber) {
        const store = String(storeNumber || '').trim();
        if (!store || store === activeStoreNumber) return;
        activeStoreNumber = store;
        sessionStorage.setItem(STORE_STORAGE_KEY, activeStoreNumber);
        renderStoreTable();
        await loadStoreHours(activeStoreNumber);
    }

    async function fetchAllStores() {
        const res = await fetch('/api/admin/store-hours', { credentials: 'same-origin' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) {
            throw new Error(data.error || 'Could not load store hours.');
        }
        storesPayload = Array.isArray(data.stores) ? data.stores : [];
        canEdit = Boolean(data.canEdit);
        return data;
    }

    async function loadStoreHours(storeNumber) {
        const root = getRoot();
        const errEl = root?.querySelector('#admin-store-hours-error');
        if (errEl) errEl.textContent = '';
        const store = String(storeNumber || '').trim();
        if (!store) {
            currentConfig = null;
            renderEditor();
            return;
        }

        const fields = root?.querySelector('#admin-store-hours-fields');
        if (fields) fields.innerHTML = '<p class="admin-accounts-meta">Loading hours…</p>';

        try {
            const cached = storeByNumber(store);
            if (cached) {
                currentConfig = { ...cached, canEdit };
                scheduleType = cached.scheduleType === 'per-day' ? 'per-day' : 'uniform';
                renderEditor();
                return;
            }

            const res = await fetch(`/api/admin/store-hours/${encodeURIComponent(store)}`, {
                credentials: 'same-origin',
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.success) {
                throw new Error(data.error || 'Could not load store hours.');
            }
            currentConfig = data;
            canEdit = Boolean(data.canEdit);
            scheduleType = data.scheduleType === 'per-day' ? 'per-day' : 'uniform';
            renderEditor();
        } catch (err) {
            currentConfig = null;
            if (fields) {
                fields.innerHTML = `<p class="admin-modal-error" role="alert">${escapeHtml(err.message || 'Could not load store hours.')}</p>`;
            }
            renderEditor();
        }
    }

    function readNumberInput(root, selector) {
        const input = root.querySelector(selector);
        const value = Number(input?.value);
        if (!Number.isFinite(value)) throw new Error('Enter valid hour values.');
        return Math.trunc(value);
    }

    function collectPayload(root) {
        if (scheduleType === 'per-day') {
            const hoursByDay = {};
            for (const { index } of DAY_ROWS) {
                hoursByDay[String(index)] = {
                    openHour: readNumberInput(root, `[name="day-${index}-open"]`),
                    closeHour: readNumberInput(root, `[name="day-${index}-close"]`),
                };
            }
            return { scheduleType: 'per-day', hoursByDay };
        }
        return {
            scheduleType: 'uniform',
            uniform: {
                openHour: readNumberInput(root, '[name="uniform-open"]'),
                closeHour: readNumberInput(root, '[name="uniform-close"]'),
            },
        };
    }

    function mergeSavedStore(storeNumber, saved) {
        const idx = storesPayload.findIndex((s) => String(s.storeNumber) === String(storeNumber));
        const merged = {
            ...(idx >= 0 ? storesPayload[idx] : {}),
            storeNumber,
            scheduleType: saved.scheduleType,
            uniform: saved.uniform,
            hoursByDay: saved.hoursByDay,
            openHour: saved.openHour,
            closeHour: saved.closeHour,
        };
        if (idx >= 0) storesPayload[idx] = merged;
        else storesPayload.push(merged);
        currentConfig = { ...merged, canEdit };
    }

    async function saveChanges() {
        const root = getRoot();
        const errEl = root?.querySelector('#admin-store-hours-error');
        const saveBtn = root?.querySelector('#admin-store-hours-save');
        if (!activeStoreNumber) return;
        if (errEl) errEl.textContent = '';
        if (saveBtn) saveBtn.disabled = true;

        try {
            const payload = collectPayload(root);
            const res = await fetch(`/api/admin/store-hours/${encodeURIComponent(activeStoreNumber)}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify(payload),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.success) {
                throw new Error(data.error || 'Could not save store hours.');
            }
            mergeSavedStore(activeStoreNumber, data);
            scheduleType = data.scheduleType === 'per-day' ? 'per-day' : 'uniform';
            renderStoreTable();
            renderEditor();
        } catch (err) {
            if (errEl) errEl.textContent = err.message || 'Could not save store hours.';
        } finally {
            if (saveBtn) saveBtn.disabled = false;
        }
    }

    async function open() {
        const root = getRoot();
        if (root) {
            root.innerHTML = '<p class="admin-accounts-meta">Loading operating times…</p>';
        }
        try {
            await fetchAllStores();
            activeArea = pickDefaultArea();
            if (activeArea) sessionStorage.setItem(AREA_STORAGE_KEY, activeArea);
            activeStoreNumber = pickDefaultStore(storesInActiveArea());
            if (activeStoreNumber) sessionStorage.setItem(STORE_STORAGE_KEY, activeStoreNumber);
            renderShell();
            if (activeStoreNumber) {
                await loadStoreHours(activeStoreNumber);
            }
        } catch (err) {
            if (root) {
                root.innerHTML = `<p class="admin-modal-error" role="alert">${escapeHtml(err.message || 'Could not load operating times.')}</p>`;
            }
        }
    }

    function mount(host) {
        pageHost = host;
        return open();
    }

    function setInlineHost(host) {
        pageHost = host || null;
    }

    function unmount() {
        pageHost = null;
        storesPayload = [];
        activeArea = '';
        activeStoreNumber = '';
        currentConfig = null;
    }

    global.AdminStoreHours = { mount, setInlineHost, unmount, open };
})(window);
