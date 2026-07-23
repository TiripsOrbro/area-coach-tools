(function (global) {
    const REPORT_TYPES = {
        'historical-hourly-sales': 'Historical Hourly Sales Data',
        'ise-trimmed-average': 'Usage Average (ISE)',
    };

    const DEFAULT_ISE_WEEKS = 5;
    const MAX_ISE_WEEKS = 12;
    const SETUP_DOWNLOAD_LABEL = 'Download report';

    const AREA_STORAGE_KEY = 'admin-report-sub-area';

    let pageHost = null;
    let setupBackdrop = null;
    let storesPickerBackdrop = null;
    let sendNowBackdrop = null;
    /** @type {string[] | null} */
    let storesPickerSnapshot = null;
    let progressBackdrop = null;
    let progressRunning = false;
    /** @type {{ reportType: string, scopeType: string, scopeId: string, dateRange: object } | null} */
    let progressDownloadPayload = null;
    /** @type {{ reportType: string, scopeType: string, scopeId: string, dateRange: object } | null} */
    let progressBackfillPayload = null;
    let subscriptions = [];
    let canManage = false;
    let canManageAreaScope = false;
    let canBackfillData = false;
    let defaultScheduleHour = 7;
    let scheduleTimeZone = 'Australia/Melbourne';
    let emailFrom = 'TacoBellAudits@gmail.com';
    let scopeTree = null;
    let activeArea = '';
    /** @type {{ scopeType: 'area' | 'store', scopeId: string, reportType: string, subscription: object | null } | null} */
    let setupContext = null;

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

    function orderedAreas() {
        const canonical = ['VIC-1', 'WA-1', 'QLD-1'];
        const list = scopeTree?.areas || [];
        const picked = canonical.filter((id) => list.includes(id));
        const rest = list.filter((id) => !canonical.includes(id));
        return picked.length ? [...picked, ...rest] : list;
    }

    function storesInArea(area) {
        return (scopeTree?.storesByArea || {})[area] || [];
    }

    function pickDefaultArea() {
        const areas = orderedAreas();
        const saved = sessionStorage.getItem(AREA_STORAGE_KEY);
        if (saved && areas.includes(saved) && storesInArea(saved).length) return saved;
        return areas.find((area) => storesInArea(area).length) || areas[0] || '';
    }

    function reportTypeLabel(type) {
        return REPORT_TYPES[String(type || '').trim()] || String(type || '-');
    }

    function isIseReport(reportType) {
        return String(reportType || '').trim() === 'ise-trimmed-average';
    }

    function formatRangeLabel(sub) {
        const range = sub?.dateRange || {};
        if (isIseReport(sub?.reportType)) {
            const weeks = Number(range.weeks ?? DEFAULT_ISE_WEEKS);
            return `${weeks} week${weeks === 1 ? '' : 's'} from yesterday`;
        }
        return range.startDate && range.endDate ? `${range.startDate} → ${range.endDate}` : 'Default range';
    }

    function renderWeeksOptions(selected) {
        const weeks = Number.isFinite(Number(selected)) ? Number(selected) : DEFAULT_ISE_WEEKS;
        return Array.from({ length: MAX_ISE_WEEKS }, (_, index) => {
            const value = index + 1;
            return `<option value="${value}"${value === weeks ? ' selected' : ''}>${value} week${value === 1 ? '' : 's'}</option>`;
        }).join('');
    }

    function setSetupFieldVisible(el, visible) {
        if (!el) return;
        el.hidden = !visible;
        el.style.display = visible ? '' : 'none';
    }

    function syncSetupRangeFields() {
        const modal = setupBackdrop;
        if (!modal || !setupContext) return;
        const isIse = isIseReport(setupContext.reportType);
        setSetupFieldVisible(modal.querySelector('#admin-report-sub-setup-start-label'), !isIse);
        setSetupFieldVisible(modal.querySelector('#admin-report-sub-setup-end-label'), !isIse);
        setSetupFieldVisible(modal.querySelector('#admin-report-sub-setup-weeks-label'), isIse);
    }

    function reportTypeShort(type) {
        const key = String(type || '').trim();
        if (key === 'historical-hourly-sales') return 'Hourly sales';
        if (key === 'ise-trimmed-average') return 'Usage Average (ISE)';
        return reportTypeLabel(key);
    }

    function findSubscription(scopeType, scopeId, reportType) {
        return (
            subscriptions.find(
                (sub) =>
                    String(sub.scopeType || 'store').trim() === scopeType &&
                    String(sub.scopeId || '').trim() === String(scopeId) &&
                    String(sub.reportType || '').trim() === String(reportType)
            ) || null
        );
    }

    function normalizeHour(hour) {
        const h = Number(hour);
        if (!Number.isFinite(h)) return null;
        return ((Math.floor(h) % 24) + 24) % 24;
    }

    const WEEKDAYS = [
        { value: 1, label: 'Monday' },
        { value: 2, label: 'Tuesday' },
        { value: 3, label: 'Wednesday' },
        { value: 4, label: 'Thursday' },
        { value: 5, label: 'Friday' },
        { value: 6, label: 'Saturday' },
        { value: 0, label: 'Sunday' },
    ];

    function weekdayLabel(dayOfWeek) {
        const n = Number(dayOfWeek);
        return WEEKDAYS.find((d) => d.value === n)?.label || 'Monday';
    }

    function formatScheduleSummary(sub) {
        const time = formatScheduleTime(sub?.scheduleHour);
        const frequency = String(sub?.frequency || 'daily').trim().toLowerCase();
        if (frequency === 'weekly') {
            return `Weekly on ${weekdayLabel(sub?.scheduleDayOfWeek)} at ${time}`;
        }
        return `Daily at ${time}`;
    }

    function renderWeekdayOptions(selected) {
        const day = Number.isFinite(Number(selected)) ? Number(selected) : 1;
        return WEEKDAYS.map(
            (entry) =>
                `<option value="${entry.value}"${entry.value === day ? ' selected' : ''}>${escapeHtml(entry.label)}</option>`
        ).join('');
    }

    function syncSetupScheduleFields() {
        const modal = setupBackdrop;
        if (!modal) return;
        const frequency = String(modal.querySelector('#admin-report-sub-setup-frequency')?.value || 'daily').trim();
        const isWeekly = frequency === 'weekly';
        setSetupFieldVisible(modal.querySelector('#admin-report-sub-setup-day-label'), isWeekly);
    }

    function formatScheduleTime(hour) {
        const normalized = normalizeHour(hour);
        if (normalized == null) return '-';
        const meridiem = normalized >= 12 ? 'PM' : 'AM';
        const displayHour = normalized % 12 || 12;
        return `${displayHour}:00 ${meridiem}`;
    }

    function hourToTimeInputValue(hour) {
        const normalized = normalizeHour(hour);
        if (normalized == null) return '07:00';
        return `${String(normalized).padStart(2, '0')}:00`;
    }

    function parseTimeInputValue(value) {
        const match = String(value || '')
            .trim()
            .match(/^(\d{1,2})(?::(\d{2}))?/);
        if (!match) return null;
        return normalizeHour(Number(match[1]));
    }

    function defaultDateRange() {
        const end = new Date();
        end.setDate(end.getDate() - 1);
        const start = new Date(end);
        start.setDate(start.getDate() - 34);
        const fmt = (dt) =>
            `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
        return { startDate: fmt(start), endDate: fmt(end) };
    }

    function allStoreNumbersInArea(areaId) {
        return storesInArea(areaId)
            .map((row) => String(row.storeNumber || '').trim())
            .filter(Boolean);
    }

    function resolveIncludedStoreNumbers(sub, areaId) {
        const all = allStoreNumbersInArea(areaId);
        const raw = sub?.includedStoreNumbers;
        if (!Array.isArray(raw) || !raw.length) return [...all];
        const allowed = new Set(raw.map((value) => String(value)));
        return all.filter((store) => allowed.has(store));
    }

    function formatAreaStoresLabel(areaId, includedStoreNumbers) {
        const total = allStoreNumbersInArea(areaId).length;
        const count = Array.isArray(includedStoreNumbers) ? includedStoreNumbers.length : total;
        if (!total) return 'No stores';
        if (count >= total) return `All ${total} store${total === 1 ? '' : 's'}`;
        return `${count} of ${total} store${total === 1 ? '' : 's'}`;
    }

    function readSetupIncludedStoreNumbers() {
        if (!setupContext || setupContext.scopeType !== 'area') return null;
        const selected = Array.isArray(setupContext.includedStoreNumbers)
            ? setupContext.includedStoreNumbers.map((value) => String(value)).filter(Boolean)
            : allStoreNumbersInArea(setupContext.scopeId);
        return selected.length ? selected : null;
    }

    function syncSetupAreaStoresRow() {
        const modal = setupBackdrop;
        if (!modal || !setupContext) return;
        const row = modal.querySelector('#admin-report-sub-setup-area-stores');
        const isArea = setupContext.scopeType === 'area';
        if (row) row.hidden = !isArea;
        if (!isArea) return;
        updateAreaStoresSummary();
    }

    function updateAreaStoresSummary() {
        const modal = setupBackdrop;
        if (!modal || !setupContext || setupContext.scopeType !== 'area') return;
        const summaryEl = modal.querySelector('#admin-report-sub-setup-stores-summary');
        const chooseBtn = modal.querySelector('#admin-report-sub-setup-choose-stores');
        const label = formatAreaStoresLabel(setupContext.scopeId, readSetupIncludedStoreNumbers());
        if (summaryEl) summaryEl.textContent = label;
        if (chooseBtn) chooseBtn.textContent = `Choose stores (${label})`;
    }

    function ensureStoresPickerModal() {
        if (storesPickerBackdrop) return storesPickerBackdrop;
        storesPickerBackdrop = document.createElement('div');
        storesPickerBackdrop.className =
            'admin-modal-backdrop admin-modal-backdrop--stacked admin-report-sub-stores-picker-backdrop';
        storesPickerBackdrop.hidden = true;
        storesPickerBackdrop.innerHTML = `
            <div class="admin-modal admin-modal--wide admin-report-sub-stores-picker-modal" role="dialog" aria-modal="true" aria-labelledby="admin-report-sub-stores-picker-title">
                <h2 id="admin-report-sub-stores-picker-title">Stores in subscription</h2>
                <p class="admin-accounts-meta" id="admin-report-sub-stores-picker-scope"></p>
                <div class="admin-report-sub-stores-picker-actions">
                    <button type="button" class="mic-settings-btn" id="admin-report-sub-stores-picker-all">Select all</button>
                    <button type="button" class="mic-settings-btn" id="admin-report-sub-stores-picker-none">Clear all</button>
                </div>
                <ul class="admin-report-sub-stores-picker-list" id="admin-report-sub-stores-picker-list"></ul>
                <div class="admin-report-sub-form-actions">
                    <button type="button" class="mic-settings-btn admin-btn-primary" id="admin-report-sub-stores-picker-done">Done</button>
                    <button type="button" id="admin-report-sub-stores-picker-cancel">Cancel</button>
                </div>
                <p class="admin-modal-error" id="admin-report-sub-stores-picker-error" role="alert"></p>
            </div>`;
        document.body.appendChild(storesPickerBackdrop);

        storesPickerBackdrop.addEventListener('click', (event) => {
            if (event.target === storesPickerBackdrop) closeStoresPicker(false);
        });
        storesPickerBackdrop.querySelector('#admin-report-sub-stores-picker-cancel')?.addEventListener('click', () =>
            closeStoresPicker(false)
        );
        storesPickerBackdrop.querySelector('#admin-report-sub-stores-picker-done')?.addEventListener('click', () =>
            closeStoresPicker(true)
        );
        storesPickerBackdrop.querySelector('#admin-report-sub-stores-picker-all')?.addEventListener('click', () => {
            if (!setupContext || setupContext.scopeType !== 'area') return;
            setupContext.includedStoreNumbers = allStoreNumbersInArea(setupContext.scopeId);
            renderStoresPickerList();
        });
        storesPickerBackdrop.querySelector('#admin-report-sub-stores-picker-none')?.addEventListener('click', () => {
            if (!setupContext) return;
            setupContext.includedStoreNumbers = [];
            renderStoresPickerList();
        });

        return storesPickerBackdrop;
    }

    function renderStoresPickerList() {
        const modal = storesPickerBackdrop;
        if (!modal || !setupContext || setupContext.scopeType !== 'area') return;
        const listEl = modal.querySelector('#admin-report-sub-stores-picker-list');
        if (!listEl) return;
        const selected = new Set((setupContext.includedStoreNumbers || []).map((value) => String(value)));
        const rows = storesInArea(setupContext.scopeId);
        listEl.innerHTML = rows
            .map((row) => {
                const store = String(row.storeNumber);
                const name = String(row.storeName || '').trim();
                const checked = selected.has(store);
                return `<li class="admin-report-sub-stores-picker-item">
                    <label class="admin-report-sub-stores-picker-label">
                        <input type="checkbox" data-report-sub-store-toggle="${escapeHtml(store)}"${checked ? ' checked' : ''} />
                        <span>${escapeHtml(store)}${name ? ` <span class="admin-accounts-meta">${escapeHtml(name)}</span>` : ''}</span>
                    </label>
                </li>`;
            })
            .join('');

        listEl.querySelectorAll('[data-report-sub-store-toggle]').forEach((input) => {
            input.addEventListener('change', (event) => {
                const store = event.target.getAttribute('data-report-sub-store-toggle') || '';
                if (!store || !setupContext) return;
                const current = new Set((setupContext.includedStoreNumbers || []).map((value) => String(value)));
                if (event.target.checked) current.add(store);
                else current.delete(store);
                setupContext.includedStoreNumbers = [...current];
                const errEl = modal.querySelector('#admin-report-sub-stores-picker-error');
                if (errEl) errEl.textContent = '';
            });
        });
    }

    function openStoresPicker() {
        if (!setupContext || setupContext.scopeType !== 'area') return;
        const modal = ensureStoresPickerModal();
        storesPickerSnapshot = [...(setupContext.includedStoreNumbers || [])];
        modal.querySelector('#admin-report-sub-stores-picker-scope').textContent = scopeDisplayLabel(
            setupContext.scopeType,
            setupContext.scopeId
        );
        modal.querySelector('#admin-report-sub-stores-picker-error').textContent = '';
        renderStoresPickerList();
        modal.hidden = false;
    }

    function closeStoresPicker(apply) {
        if (!storesPickerBackdrop) return;
        if (!apply && setupContext && storesPickerSnapshot) {
            setupContext.includedStoreNumbers = [...storesPickerSnapshot];
        }
        storesPickerSnapshot = null;
        storesPickerBackdrop.hidden = true;
        if (apply && setupContext) {
            const count = readSetupIncludedStoreNumbers()?.length || 0;
            const errEl = storesPickerBackdrop.querySelector('#admin-report-sub-stores-picker-error');
            if (!count) {
                if (errEl) errEl.textContent = 'Select at least one store.';
                storesPickerBackdrop.hidden = false;
                return;
            }
            updateAreaStoresSummary();
            void refreshSetupDataStatus();
        }
    }

    function parseRecipientsInput(raw) {
        return String(raw || '')
            .split(/[,;\s]+/)
            .map((r) => r.trim())
            .filter(Boolean);
    }

    function readSetupRecipientsForSend() {
        const inputVal = String(setupBackdrop?.querySelector('#admin-report-sub-setup-recipients')?.value || '').trim();
        if (inputVal) return inputVal;
        const sub = setupContext?.subscription;
        return Array.isArray(sub?.recipients) ? sub.recipients.filter(Boolean).join(', ') : '';
    }

    function ensureSendNowModal() {
        if (sendNowBackdrop) return sendNowBackdrop;
        sendNowBackdrop = document.createElement('div');
        sendNowBackdrop.className =
            'admin-modal-backdrop admin-modal-backdrop--stacked admin-report-sub-send-backdrop';
        sendNowBackdrop.hidden = true;
        sendNowBackdrop.innerHTML = `
            <div class="admin-modal admin-modal--wide admin-report-sub-send-modal" role="dialog" aria-modal="true" aria-labelledby="admin-report-sub-send-title">
                <h2 id="admin-report-sub-send-title">Send report now</h2>
                <p class="admin-accounts-meta" id="admin-report-sub-send-scope"></p>
                <label class="admin-report-sub-send-recipients-label">
                    Send to
                    <input type="text" id="admin-report-sub-send-recipients" placeholder="email@example.com, …" autocomplete="email" />
                </label>
                <p class="admin-accounts-meta admin-report-sub-send-hint">Prefilled from this subscription. Edit to send to a different address without changing the saved subscription.</p>
                <div class="admin-report-sub-form-actions">
                    <button type="button" class="mic-settings-btn admin-btn-primary" id="admin-report-sub-send-confirm">Send</button>
                    <button type="button" id="admin-report-sub-send-cancel">Cancel</button>
                </div>
                <p class="admin-modal-error" id="admin-report-sub-send-error" role="alert"></p>
            </div>`;
        document.body.appendChild(sendNowBackdrop);

        sendNowBackdrop.addEventListener('click', (event) => {
            if (event.target === sendNowBackdrop) closeSendNowModal();
        });
        sendNowBackdrop.querySelector('#admin-report-sub-send-cancel')?.addEventListener('click', closeSendNowModal);
        sendNowBackdrop.querySelector('#admin-report-sub-send-confirm')?.addEventListener('click', () =>
            void confirmSendNow()
        );

        return sendNowBackdrop;
    }

    function openSendNowModal() {
        if (!setupContext?.subscription?.id) return;
        const modal = ensureSendNowModal();
        modal.querySelector('#admin-report-sub-send-scope').textContent = `${scopeDisplayLabel(
            setupContext.scopeType,
            setupContext.scopeId
        )} · ${reportTypeLabel(setupContext.reportType)}`;
        modal.querySelector('#admin-report-sub-send-recipients').value = readSetupRecipientsForSend();
        modal.querySelector('#admin-report-sub-send-error').textContent = '';
        modal.hidden = false;
        modal.querySelector('#admin-report-sub-send-recipients')?.focus();
    }

    function closeSendNowModal() {
        if (!sendNowBackdrop) return;
        sendNowBackdrop.hidden = true;
        sendNowBackdrop.querySelector('#admin-report-sub-send-error').textContent = '';
    }

    async function confirmSendNow() {
        const modal = sendNowBackdrop;
        const errEl = modal?.querySelector('#admin-report-sub-send-error');
        const sub = setupContext?.subscription;
        if (!modal || !sub?.id) return;

        const recipients = parseRecipientsInput(modal.querySelector('#admin-report-sub-send-recipients')?.value);
        if (!recipients.length) {
            if (errEl) errEl.textContent = 'Enter at least one recipient email.';
            return;
        }

        const confirmBtn = modal.querySelector('#admin-report-sub-send-confirm');
        if (confirmBtn) {
            confirmBtn.disabled = true;
            confirmBtn.textContent = 'Sending…';
        }
        try {
            closeSendNowModal();
            await sendNowFromSetup(recipients);
        } finally {
            if (confirmBtn) {
                confirmBtn.disabled = false;
                confirmBtn.textContent = 'Send';
            }
        }
    }

    function scopeDisplayLabel(scopeType, scopeId) {
        if (scopeType === 'area') return `All stores in ${areaChipLabel(scopeId)}`;
        const stores = storesInArea(activeArea);
        const row = stores.find((entry) => String(entry.storeNumber) === String(scopeId));
        const name = String(row?.storeName || '').trim();
        return name ? `Store ${scopeId}, ${name}` : `Store ${scopeId}`;
    }

    async function fetchProfile() {
        try {
            const res = await fetch('/api/me', { credentials: 'same-origin' });
            const data = await res.json().catch(() => ({}));
            return res.ok && data.success ? data : {};
        } catch {
            return {};
        }
    }

    async function fetchSubscriptions() {
        const res = await fetch('/api/admin/report-subscriptions', { credentials: 'same-origin' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) {
            throw new Error(data.error || 'Could not load report subscriptions.');
        }
        return data;
    }

    async function loadScopeTree() {
        if (scopeTree) return scopeTree;
        const res = await fetch('/api/admin/store-scope', { credentials: 'same-origin' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success || !data.scopeTree) {
            throw new Error(data.error || 'Could not load store list.');
        }
        scopeTree = data.scopeTree;
        return scopeTree;
    }

    function renderAreaTabs() {
        const areas = orderedAreas();
        return areas
            .map((area) => {
                const isActive = area === activeArea;
                return `<button type="button" class="admin-accounts-scope-chip${isActive ? ' is-active' : ''}" role="tab" aria-selected="${isActive ? 'true' : 'false'}" data-report-sub-area="${escapeHtml(area)}">${escapeHtml(areaChipLabel(area))}</button>`;
            })
            .join('');
    }

    function renderCellToggle(sub) {
        if (!sub) return '';
        const enabled = sub.enabled !== false;
        if (!canManage) {
            return `<span class="admin-report-sub-cell-status${enabled ? '' : ' admin-report-sub-cell-status--off'}">${enabled ? 'On' : 'Off'}</span>`;
        }
        return `<label class="mic-toggle-switch admin-report-sub-cell-toggle" title="${enabled ? 'Disable subscription' : 'Enable subscription'}">
            <input type="checkbox" role="switch" aria-label="Enable subscription" data-report-sub-enabled="${escapeHtml(sub.id)}"${enabled ? ' checked' : ''} />
            <span class="mic-toggle-slider" aria-hidden="true"></span>
        </label>`;
    }

    function renderCellSummary(sub) {
        if (!sub) {
            return canManage
                ? '<span class="admin-accounts-meta">Not set up</span>'
                : '<span class="admin-accounts-meta">-</span>';
        }
        const enabled = sub.enabled !== false;
        const rangeLabel = formatRangeLabel(sub);
        const lastSent = sub.lastSentDate ? `Last sent ${sub.lastSentDate}` : 'Not sent yet';
        const recipientCount = Array.isArray(sub.recipients) ? sub.recipients.filter(Boolean).length : 0;
        const areaStoresMeta =
            String(sub.scopeType || '') === 'area'
                ? `<span class="admin-report-sub-cell-meta">${escapeHtml(formatAreaStoresLabel(sub.scopeId, resolveIncludedStoreNumbers(sub, sub.scopeId)))}</span>`
                : '';
        return `
            <div class="admin-report-sub-cell-summary${enabled ? '' : ' admin-report-sub-cell-summary--off'}">
                ${renderCellToggle(sub)}
                <span class="admin-report-sub-cell-meta">${escapeHtml(formatScheduleSummary(sub))} · ${recipientCount} recipient${recipientCount === 1 ? '' : 's'}</span>
                ${areaStoresMeta}
                <span class="admin-report-sub-cell-meta">${escapeHtml(rangeLabel)}</span>
                <span class="admin-report-sub-cell-meta">${escapeHtml(lastSent)}</span>
            </div>`;
    }

    function renderSetupButton(scopeType, scopeId, reportType, sub) {
        if (!canManage) return '';
        const label = sub ? 'Manage' : 'Set up';
        return `<button type="button" class="mic-settings-btn admin-report-sub-setup-btn" data-report-sub-setup="${escapeHtml(reportType)}" data-report-sub-scope-type="${escapeHtml(scopeType)}" data-report-sub-scope-id="${escapeHtml(scopeId)}">${label}</button>`;
    }

    function renderMatrixCell(scopeType, scopeId, reportType) {
        const sub = findSubscription(scopeType, scopeId, reportType);
        return `
            <td class="admin-report-sub-matrix-cell">
                ${renderCellSummary(sub)}
                ${renderSetupButton(scopeType, scopeId, reportType, sub)}
            </td>`;
    }

    function renderMatrixRow(scopeType, scopeId, label, rowClass = '') {
        const typeKeys = Object.keys(REPORT_TYPES);
        const cells = typeKeys.map((reportType) => renderMatrixCell(scopeType, scopeId, reportType)).join('');
        return `
            <tr class="admin-report-sub-matrix-row${rowClass}">
                <th scope="row" class="admin-report-sub-matrix-store">${escapeHtml(label)}</th>
                ${cells}
            </tr>`;
    }

    function renderMatrix() {
        const stores = storesInArea(activeArea);
        if (!stores.length && !activeArea) {
            return '<p class="admin-accounts-meta">No stores available.</p>';
        }

        const typeHeaders = Object.entries(REPORT_TYPES)
            .map(
                ([value, label]) =>
                    `<th scope="col" class="admin-report-sub-matrix-type" title="${escapeHtml(label)}">${escapeHtml(reportTypeShort(value))}</th>`
            )
            .join('');

        const areaRow =
            activeArea && canManageAreaScope
                ? renderMatrixRow('area', activeArea, `All stores, ${areaChipLabel(activeArea)}`, ' admin-report-sub-matrix-row--area')
                : '';

        const storeRows = stores
            .map((row) => {
                const storeNumber = String(row.storeNumber);
                const name = String(row.storeName || '').trim();
                const label = name ? `${storeNumber} ${name}` : storeNumber;
                return renderMatrixRow('store', storeNumber, label);
            })
            .join('');

        return `
            <div class="admin-report-sub-matrix-wrap">
                <table class="admin-table admin-report-sub-matrix">
                    <thead>
                        <tr>
                            <th scope="col" class="admin-report-sub-matrix-store">Store</th>
                            ${typeHeaders}
                        </tr>
                    </thead>
                    <tbody>${areaRow}${storeRows}</tbody>
                </table>
            </div>`;
    }

    function render() {
        const root = getRoot();
        if (!root) return;
        const areaCount = Math.max(orderedAreas().length, 1);
        root.innerHTML = `
            <div class="admin-modal admin-modal--inline admin-report-subscriptions">
                <h2>Report subscriptions</h2>
                <p class="admin-modal-error" id="admin-report-sub-error" role="alert"></p>
                <div class="admin-settings-segmented-tabs admin-accounts-browse-scope admin-accounts-org-nav admin-report-sub-area-nav">
                    <div class="admin-accounts-scope-row-wrap">
                        <span class="admin-accounts-scope-row-label">Area</span>
                        <nav class="admin-accounts-scope-row admin-accounts-scope-row--equal admin-report-sub-area-tabs" id="admin-report-sub-area-tabs" role="tablist" aria-label="Select area" style="--scope-cols: ${areaCount}">${renderAreaTabs()}</nav>
                    </div>
                </div>
                <div id="admin-report-sub-matrix">${renderMatrix()}</div>
            </div>`;
        bindPageEvents();
        bindMatrixEvents();
    }

    function refreshMatrix() {
        const root = getRoot();
        const host = root?.querySelector('#admin-report-sub-matrix');
        if (!host) return;
        host.innerHTML = renderMatrix();
        bindMatrixEvents();
    }

    function refreshAreaTabs() {
        const root = getRoot();
        const nav = root?.querySelector('#admin-report-sub-area-tabs');
        if (!nav) return;
        const areaCount = Math.max(orderedAreas().length, 1);
        nav.style.setProperty('--scope-cols', String(areaCount));
        nav.innerHTML = renderAreaTabs();
    }

    function selectArea(area) {
        if (!area || area === activeArea) return;
        activeArea = area;
        sessionStorage.setItem(AREA_STORAGE_KEY, activeArea);
        refreshAreaTabs();
        refreshMatrix();
    }

    function bindPageEvents() {
        const root = getRoot();
        if (!root || root.dataset.reportSubPageBound) return;
        root.dataset.reportSubPageBound = '1';
        root.addEventListener('click', (event) => {
            const areaTab = event.target.closest('[data-report-sub-area]');
            if (areaTab) {
                selectArea(areaTab.getAttribute('data-report-sub-area') || '');
            }
        });
    }

    function bindMatrixEvents() {
        const root = getRoot();
        if (!root) return;

        root.querySelectorAll('[data-report-sub-enabled]').forEach((input) => {
            input.addEventListener('change', (event) => {
                const id = event.target.getAttribute('data-report-sub-enabled') || '';
                if (!id) return;
                void saveEnabled(id, event.target.checked, event.target);
            });
        });

        root.querySelectorAll('[data-report-sub-setup]').forEach((btn) => {
            btn.addEventListener('click', () => {
                openSetup({
                    scopeType: btn.getAttribute('data-report-sub-scope-type') || 'store',
                    scopeId: btn.getAttribute('data-report-sub-scope-id') || '',
                    reportType: btn.getAttribute('data-report-sub-setup') || '',
                });
            });
        });
    }

    function triggerReportFileDownload(payload) {
        if (!payload?.contentBase64) return;
        const bytes = Uint8Array.from(atob(payload.contentBase64), (c) => c.charCodeAt(0));
        const blob = new Blob([bytes], {
            type: payload.contentType || 'application/octet-stream',
        });
        triggerBlobDownload(blob, payload.filename || 'report.csv');
    }

    function triggerBlobDownload(blob, filename) {
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename || 'report.csv';
        link.click();
        URL.revokeObjectURL(url);
    }

    function buildDownloadPayload(payload) {
        const body = {
            reportType: payload.reportType,
            scopeType: payload.scopeType,
            scopeId: payload.scopeId,
            dateRange: payload.dateRange,
            backfill: false,
        };
        if (
            payload.scopeType === 'area' &&
            Array.isArray(payload.includedStoreNumbers) &&
            payload.includedStoreNumbers.length
        ) {
            body.includedStoreNumbers = payload.includedStoreNumbers;
        }
        return body;
    }

    async function downloadReportViaStream(payload, { title } = {}) {
        const result = await runStreamAction('download', buildDownloadPayload(payload), {
            title: title || 'Generating report',
        });
        if (!result?.contentBase64) {
            throw new Error('Report generation produced no file.');
        }
        triggerReportFileDownload(result);
        return result;
    }

    async function downloadReportSilent(payload) {
        const body = buildDownloadPayload(payload);
        const res = await fetch('/api/admin/report-subscriptions/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify(body),
        });
        const contentType = res.headers.get('Content-Type') || '';
        if (!res.ok) {
            const data = contentType.includes('json') ? await res.json().catch(() => ({})) : {};
            throw new Error(data.error || `Request failed (${res.status}).`);
        }
        if (contentType.includes('application/json')) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error || 'Could not generate report.');
        }
        const blob = await res.blob();
        const disposition = res.headers.get('Content-Disposition') || '';
        const match = /filename="([^"]+)"/i.exec(disposition);
        triggerBlobDownload(blob, match?.[1] || 'report.csv');
    }

    function ensureProgressModal() {
        if (progressBackdrop) {
            progressBackdrop
                .querySelector('#admin-report-sub-progress-download')
                ?.classList.add('mic-settings-btn', 'admin-btn-primary');
            progressBackdrop
                .querySelector('#admin-report-sub-progress-rebackfill')
                ?.classList.add('mic-settings-btn', 'admin-btn-primary');
            return progressBackdrop;
        }
        progressBackdrop = document.createElement('div');
        progressBackdrop.className = 'admin-modal-backdrop admin-modal-backdrop--stacked admin-report-sub-progress-backdrop';
        progressBackdrop.hidden = true;
        progressBackdrop.innerHTML = `
            <div class="admin-modal admin-modal--wide admin-report-sub-progress-modal" role="dialog" aria-modal="true" aria-labelledby="admin-report-sub-progress-title">
                <h2 id="admin-report-sub-progress-title">Working…</h2>
                <p class="admin-report-sub-progress-status" id="admin-report-sub-progress-status">Starting…</p>
                <div class="admin-report-sub-progress-log-wrap">
                    <ol class="admin-report-sub-progress-log" id="admin-report-sub-progress-log" role="log" aria-live="polite"></ol>
                </div>
                <div class="admin-report-sub-form-actions admin-report-sub-progress-actions">
                    <div class="admin-report-sub-progress-actions-row admin-report-sub-progress-actions-row--primary">
                        <button type="button" class="mic-settings-btn admin-btn-primary" id="admin-report-sub-progress-download" hidden>Download report</button>
                        <button type="button" class="mic-settings-btn admin-btn-primary" id="admin-report-sub-progress-rebackfill" hidden>Re-backfill</button>
                    </div>
                    <button type="button" id="admin-report-sub-progress-close" disabled>Close</button>
                </div>
            </div>`;
        document.body.appendChild(progressBackdrop);
        progressBackdrop.querySelector('#admin-report-sub-progress-download')?.addEventListener('click', () =>
            void downloadFromProgressModal()
        );
        progressBackdrop.querySelector('#admin-report-sub-progress-rebackfill')?.addEventListener('click', () =>
            void rebackfillFromProgressModal()
        );
        progressBackdrop.querySelector('#admin-report-sub-progress-close')?.addEventListener('click', closeProgressModal);
        progressBackdrop.addEventListener('click', (event) => {
            if (event.target === progressBackdrop && !progressRunning) closeProgressModal();
        });
        return progressBackdrop;
    }

    const PROGRESS_TIME_FORMAT = { hour: 'numeric', minute: '2-digit' };
    const PROGRESS_LOG_SKIP_TYPES = new Set(['day-saved', 'day-read', 'day-batch-start', 'keepalive']);

    function shouldShowProgressEvent(event) {
        return !PROGRESS_LOG_SKIP_TYPES.has(String(event?.type || '').trim());
    }

    function formatProgressTime(event) {
        const ts = event?.ts ? new Date(event.ts) : new Date();
        return ts.toLocaleTimeString(undefined, PROGRESS_TIME_FORMAT);
    }

    function progressLogClass(type, success) {
        const key = String(type || '').trim();
        if (key === 'complete') return success ? 'admin-report-sub-progress-line--ok' : 'admin-report-sub-progress-line--error';
        if (key === 'day-saved' || key === 'store-done' || key === 'scope-done' || key === 'file-ready') {
            return 'admin-report-sub-progress-line--ok';
        }
        if (key === 'day-skipped' || key === 'warn') return 'admin-report-sub-progress-line--warn';
        return '';
    }

    function appendProgressLine(logEl, event) {
        if (!logEl || !event || !shouldShowProgressEvent(event)) return;
        const li = document.createElement('li');
        const type = String(event.type || 'info');
        const ok = type === 'complete' ? event.success !== false : true;
        li.className = ['admin-report-sub-progress-line', progressLogClass(type, ok)].filter(Boolean).join(' ');
        const time = formatProgressTime(event);
        const msg = event.message || event.error || JSON.stringify(event);
        li.textContent = `[${time}] ${msg}`;
        logEl.appendChild(li);
        logEl.parentElement?.scrollTo({ top: logEl.parentElement.scrollHeight, behavior: 'smooth' });
    }

    function openProgressModal(title, statusText) {
        const modal = ensureProgressModal();
        modal.querySelector('#admin-report-sub-progress-title').textContent = title || 'Working…';
        modal.querySelector('#admin-report-sub-progress-status').textContent = statusText || 'Starting…';
        const logEl = modal.querySelector('#admin-report-sub-progress-log');
        if (logEl) logEl.innerHTML = '';
        progressDownloadPayload = null;
        progressBackfillPayload = null;
        const downloadBtn = modal.querySelector('#admin-report-sub-progress-download');
        if (downloadBtn) {
            downloadBtn.hidden = true;
            downloadBtn.disabled = false;
            downloadBtn.textContent = 'Download report';
        }
        const rebackfillBtn = modal.querySelector('#admin-report-sub-progress-rebackfill');
        if (rebackfillBtn) {
            rebackfillBtn.hidden = true;
            rebackfillBtn.disabled = false;
            rebackfillBtn.textContent = 'Re-backfill';
        }
        modal.querySelector('#admin-report-sub-progress-close').disabled = true;
        modal.hidden = false;
        progressRunning = true;
    }

    function closeProgressModal() {
        if (progressRunning) return;
        progressDownloadPayload = null;
        progressBackfillPayload = null;
        if (progressBackdrop) {
            progressBackdrop.hidden = true;
            const statusEl = progressBackdrop.querySelector('#admin-report-sub-progress-status');
            statusEl?.classList.remove('admin-modal-error', 'admin-report-sub-progress-status--ok');
            const downloadBtn = progressBackdrop.querySelector('#admin-report-sub-progress-download');
            if (downloadBtn) downloadBtn.hidden = true;
            const rebackfillBtn = progressBackdrop.querySelector('#admin-report-sub-progress-rebackfill');
            if (rebackfillBtn) rebackfillBtn.hidden = true;
        }
    }

    function setSetupFeedback(message, isError) {
        const errEl = setupBackdrop?.querySelector('#admin-report-sub-setup-error');
        if (!errEl) return;
        errEl.textContent = message || '';
        errEl.classList.toggle('admin-modal-error', Boolean(isError && message));
        errEl.classList.toggle('admin-modal-success', Boolean(!isError && message));
    }

    function finishProgressModal(
        statusText,
        success,
        { showDownload = false, downloadPayload = null, showRebackfill = false, backfillPayload = null } = {}
    ) {
        progressRunning = false;
        const modal = progressBackdrop;
        if (!modal) return;
        const statusEl = modal.querySelector('#admin-report-sub-progress-status');
        if (statusEl) {
            statusEl.textContent = statusText || (success ? 'Done.' : 'Failed.');
            statusEl.classList.toggle('admin-modal-error', !success);
            statusEl.classList.toggle('admin-report-sub-progress-status--ok', success);
        }
        const downloadBtn = modal.querySelector('#admin-report-sub-progress-download');
        if (downloadBtn) {
            const canDownload = Boolean(showDownload && downloadPayload);
            progressDownloadPayload = canDownload ? downloadPayload : null;
            downloadBtn.hidden = !canDownload;
            downloadBtn.disabled = false;
            downloadBtn.textContent = 'Download report';
        }
        const rebackfillBtn = modal.querySelector('#admin-report-sub-progress-rebackfill');
        if (rebackfillBtn) {
            const canRebackfill = Boolean(showRebackfill && backfillPayload && canBackfillData);
            progressBackfillPayload = canRebackfill ? backfillPayload : null;
            rebackfillBtn.hidden = !canRebackfill;
            rebackfillBtn.disabled = false;
            rebackfillBtn.textContent = 'Re-backfill';
        }
        const closeBtn = modal.querySelector('#admin-report-sub-progress-close');
        if (closeBtn) closeBtn.disabled = false;
    }

    async function rebackfillFromProgressModal() {
        const payload = progressBackfillPayload;
        if (!payload || progressRunning) return;
        const rebackfillBtn = progressBackdrop?.querySelector('#admin-report-sub-progress-rebackfill');
        if (rebackfillBtn) {
            rebackfillBtn.disabled = true;
            rebackfillBtn.textContent = 'Backfilling…';
        }
        try {
            await runStoreByStoreBackfill(
                { ...payload, force: true },
                {
                    title: 'Re-backfilling report data',
                    onComplete: async () => {
                        await refreshSetupDataStatus();
                    },
                }
            );
        } catch {
            if (rebackfillBtn) {
                rebackfillBtn.disabled = false;
                rebackfillBtn.textContent = 'Re-backfill';
            }
        }
    }

    async function downloadFromProgressModal() {
        const payload = progressDownloadPayload;
        if (!payload || progressRunning) return;
        const downloadBtn = progressBackdrop?.querySelector('#admin-report-sub-progress-download');
        if (downloadBtn) {
            downloadBtn.disabled = true;
            downloadBtn.textContent = 'Downloading…';
        }
        try {
            await downloadReportViaStream(payload);
            await refreshSetupDataStatus();
        } catch (err) {
            const statusEl = progressBackdrop?.querySelector('#admin-report-sub-progress-status');
            if (statusEl) {
                statusEl.textContent = err.message || 'Download failed.';
                statusEl.classList.add('admin-modal-error');
                statusEl.classList.remove('admin-report-sub-progress-status--ok');
            }
        } finally {
            if (downloadBtn) {
                downloadBtn.disabled = false;
                downloadBtn.textContent = 'Download report';
            }
        }
    }

    function resolveBackfillStoreList(scopeType, scopeId, includedStoreNumbers = null) {
        const type = String(scopeType || 'store').trim();
        const id = String(scopeId || '').trim();
        if (type === 'area') {
            const all = storesInArea(id)
                .map((row) => String(row.storeNumber || row.id || '').trim())
                .filter(Boolean);
            if (!Array.isArray(includedStoreNumbers) || !includedStoreNumbers.length) return all;
            const allowed = new Set(includedStoreNumbers.map((value) => String(value)));
            return all.filter((store) => allowed.has(store));
        }
        return id ? [id] : [];
    }

    async function runStoreByStoreBackfill(basePayload, { title, onComplete } = {}) {
        const stores = resolveBackfillStoreList(
            basePayload.scopeType,
            basePayload.scopeId,
            basePayload.includedStoreNumbers
        );
        if (stores.length <= 1) {
            return runStreamAction('backfill', basePayload, { title, onComplete });
        }

        const modal = ensureProgressModal();
        const logEl = modal.querySelector('#admin-report-sub-progress-log');
        openProgressModal(
            title || 'Backfilling report data',
            `Starting backfill for ${stores.length} store(s), one at a time…`
        );

        let allReady = true;
        let anyFailed = false;
        const storeStatuses = [];
        const { force: forceFlag, ...restPayload } = basePayload;

        for (let i = 0; i < stores.length; i += 1) {
            const storeNumber = stores[i];
            appendProgressLine(logEl, {
                type: 'info',
                ts: new Date().toISOString(),
                message: `── Store ${storeNumber} (${i + 1}/${stores.length}) ──`,
            });

            try {
                const res = await fetch('/api/admin/report-subscriptions/run-stream', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'same-origin',
                    body: JSON.stringify({
                        action: 'backfill',
                        ...restPayload,
                        scopeType: 'store',
                        scopeId: storeNumber,
                        force: forceFlag,
                    }),
                });
                if (!res.ok && !res.body) {
                    const data = await res.json().catch(() => ({}));
                    throw new Error(data.error || `Request failed (${res.status}).`);
                }

                const finalEvent = await consumeNdjsonStream(res, (event) => {
                    if (event.type === 'complete' || event.type === 'keepalive') return;
                    appendProgressLine(logEl, event);
                    if (event.message) {
                        modal.querySelector('#admin-report-sub-progress-status').textContent = event.message;
                    }
                });

                if (!finalEvent?.success) {
                    throw new Error(finalEvent?.error || 'Store backfill failed.');
                }
                if (!finalEvent.result?.ready) allReady = false;
                if (Array.isArray(finalEvent.result?.stores)) {
                    storeStatuses.push(...finalEvent.result.stores);
                }
            } catch (err) {
                anyFailed = true;
                allReady = false;
                appendProgressLine(logEl, {
                    type: 'complete',
                    success: false,
                    ts: new Date().toISOString(),
                    message: `Store ${storeNumber}: ${err.message || 'Failed.'}`,
                });
            }
        }

        const result = {
            ready: allReady && !anyFailed,
            stores: storeStatuses,
            message: anyFailed
                ? 'Backfill finished with errors. See log.'
                : allReady
                  ? 'Backfill complete. All stores ready.'
                  : 'Backfill finished. Some stores still need data.',
        };

        appendProgressLine(logEl, {
            type: 'complete',
            success: !anyFailed,
            ts: new Date().toISOString(),
            message: result.message,
        });

        const { force: _force, ...cleanPayload } = basePayload;
        finishProgressModal(result.message, !anyFailed, {
            showDownload: !anyFailed,
            downloadPayload: cleanPayload,
            showRebackfill: true,
            backfillPayload: cleanPayload,
        });

        if (typeof onComplete === 'function') {
            await onComplete(result);
        }
        return result;
    }

    async function consumeNdjsonStream(response, onEvent) {
        if (!response.body) {
            const data = await response.json().catch(() => ({}));
            if (data.error) throw new Error(data.error);
            return data;
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let finalResult = null;
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                let event;
                try {
                    event = JSON.parse(trimmed);
                } catch {
                    continue;
                }
                onEvent?.(event);
                if (event.type === 'complete') finalResult = event;
            }
        }
        const tail = buffer.trim();
        if (tail) {
            try {
                const event = JSON.parse(tail);
                onEvent?.(event);
                if (event.type === 'complete') finalResult = event;
            } catch {
                /* ignore partial tail */
            }
        }
        return finalResult;
    }

    async function runStreamAction(action, payload, { title, onComplete } = {}) {
        const modal = ensureProgressModal();
        const logEl = modal.querySelector('#admin-report-sub-progress-log');
        const titles = {
            backfill: 'Backfilling report data',
            download: 'Generating report',
            send: 'Sending report',
        };
        openProgressModal(title || titles[action] || 'Working…', 'Connecting to server…');

        try {
            const res = await fetch('/api/admin/report-subscriptions/run-stream', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify({ action, ...payload }),
            });
            if (!res.ok && !res.body) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data.error || `Request failed (${res.status}).`);
            }

            const finalEvent = await consumeNdjsonStream(res, (event) => {
                if (event.type === 'complete' || event.type === 'keepalive') return;
                appendProgressLine(logEl, event);
                if (event.message) {
                    modal.querySelector('#admin-report-sub-progress-status').textContent = event.message;
                }
            });

            if (!finalEvent) throw new Error('No response from server.');
            appendProgressLine(logEl, {
                type: 'complete',
                success: finalEvent.success,
                ts: new Date().toISOString(),
                message: finalEvent.success
                    ? finalEvent.result?.message || 'Finished successfully.'
                    : finalEvent.error || 'Failed.',
            });

            if (!finalEvent.success) {
                throw new Error(finalEvent.error || 'Operation failed.');
            }

            const { force: _force, ...cleanPayload } = payload || {};
            const backfillExtras =
                action === 'backfill'
                    ? {
                          showDownload: true,
                          downloadPayload: cleanPayload,
                          showRebackfill: true,
                          backfillPayload: cleanPayload,
                      }
                    : {};

            finishProgressModal(
                finalEvent.result?.message ||
                    (action === 'backfill'
                        ? finalEvent.result?.ready
                            ? 'Backfill complete. All stores ready.'
                            : 'Backfill finished. Some stores still need data.'
                        : action === 'send'
                          ? finalEvent.result?.email?.sent
                              ? 'Report sent successfully.'
                              : `Report generated but email not sent (${finalEvent.result?.email?.reason || 'unknown'}).`
                          : 'Done.'),
                true,
                backfillExtras
            );

            if (typeof onComplete === 'function') {
                await onComplete(finalEvent.result || {});
            }
            return finalEvent.result;
        } catch (err) {
            appendProgressLine(logEl, {
                type: 'complete',
                success: false,
                ts: new Date().toISOString(),
                message: err.message || 'Request failed.',
            });
            finishProgressModal(
                err.message || 'Request failed.',
                false,
                action === 'backfill'
                    ? { showRebackfill: true, backfillPayload: payload }
                    : {}
            );
            throw err;
        }
    }

    function ensureSetupModal() {
        if (setupBackdrop) {
            const downloadBtn = setupBackdrop.querySelector('#admin-report-sub-setup-download');
            if (downloadBtn && !downloadBtn.disabled) downloadBtn.textContent = SETUP_DOWNLOAD_LABEL;
            return setupBackdrop;
        }
        setupBackdrop = document.createElement('div');
        setupBackdrop.className = 'admin-modal-backdrop admin-modal-backdrop--stacked';
        setupBackdrop.hidden = true;
        setupBackdrop.innerHTML = `
            <div class="admin-modal admin-modal--wide admin-report-sub-setup-modal" role="dialog" aria-modal="true" aria-labelledby="admin-report-sub-setup-title">
                <h2 id="admin-report-sub-setup-title">Set up subscription</h2>
                <p class="admin-report-sub-setup-scope" id="admin-report-sub-setup-scope"></p>
                <p class="admin-accounts-meta" id="admin-report-sub-setup-report"></p>
                <div class="admin-report-sub-form-grid">
                    <label>
                        Recipients
                        <input type="text" id="admin-report-sub-setup-recipients" placeholder="email@example.com, …" autocomplete="email" />
                    </label>
                    <label id="admin-report-sub-setup-start-label">
                        Start date
                        <input type="date" id="admin-report-sub-setup-start" />
                    </label>
                    <label id="admin-report-sub-setup-end-label">
                        End date
                        <input type="date" id="admin-report-sub-setup-end" />
                    </label>
                    <label id="admin-report-sub-setup-weeks-label" hidden>
                        Weeks (from yesterday)
                        <select id="admin-report-sub-setup-weeks"></select>
                    </label>
                    <label>
                        Frequency
                        <select id="admin-report-sub-setup-frequency">
                            <option value="daily">Daily</option>
                            <option value="weekly">Weekly</option>
                        </select>
                    </label>
                    <label>
                        Time
                        <input type="time" id="admin-report-sub-setup-time" step="3600" />
                    </label>
                    <label id="admin-report-sub-setup-day-label" hidden>
                        Day
                        <select id="admin-report-sub-setup-day"></select>
                    </label>
                </div>
                <div class="admin-report-sub-setup-area-stores" id="admin-report-sub-setup-area-stores" hidden>
                    <div class="admin-report-sub-setup-area-stores-row">
                        <span class="admin-accounts-meta">Stores tracked</span>
                        <button type="button" class="mic-settings-btn" id="admin-report-sub-setup-choose-stores">Choose stores…</button>
                    </div>
                    <p class="admin-accounts-meta" id="admin-report-sub-setup-stores-summary"></p>
                </div>
                <div id="admin-report-sub-setup-status" class="admin-report-sub-setup-status"></div>
                <div class="admin-report-sub-form-actions admin-report-sub-setup-actions">
                    <button type="button" class="mic-settings-btn admin-btn-primary" id="admin-report-sub-setup-primary">Save subscription</button>
                    <button type="button" class="mic-settings-btn" id="admin-report-sub-setup-save-changes" hidden>Save changes</button>
                    <button type="button" class="mic-settings-btn" id="admin-report-sub-setup-send" hidden>Send now</button>
                    <button type="button" class="mic-settings-btn" id="admin-report-sub-setup-download">${SETUP_DOWNLOAD_LABEL}</button>
                    <button type="button" class="mic-settings-btn" id="admin-report-sub-setup-backfill">Backfill data</button>
                    <button type="button" id="admin-report-sub-setup-close">Close</button>
                </div>
                <p class="admin-modal-error" id="admin-report-sub-setup-error" role="alert"></p>
            </div>`;
        document.body.appendChild(setupBackdrop);

        setupBackdrop.addEventListener('click', (event) => {
            if (event.target === setupBackdrop) closeSetup();
        });
        setupBackdrop.querySelector('#admin-report-sub-setup-close')?.addEventListener('click', closeSetup);
        setupBackdrop.querySelector('#admin-report-sub-setup-primary')?.addEventListener('click', () => {
            if (setupContext?.subscription?.id) void deleteFromSetup();
            else void saveSetup();
        });
        setupBackdrop.querySelector('#admin-report-sub-setup-save-changes')?.addEventListener('click', () => void saveSetup());
        setupBackdrop.querySelector('#admin-report-sub-setup-send')?.addEventListener('click', openSendNowModal);
        setupBackdrop.querySelector('#admin-report-sub-setup-download')?.addEventListener('click', () => void downloadFromSetup(false));
        setupBackdrop.querySelector('#admin-report-sub-setup-backfill')?.addEventListener('click', () => void downloadFromSetup(true));
        setupBackdrop.querySelector('#admin-report-sub-setup-start')?.addEventListener('change', () => void refreshSetupDataStatus());
        setupBackdrop.querySelector('#admin-report-sub-setup-end')?.addEventListener('change', () => void refreshSetupDataStatus());
        setupBackdrop.querySelector('#admin-report-sub-setup-weeks')?.addEventListener('change', () => void refreshSetupDataStatus());
        setupBackdrop.querySelector('#admin-report-sub-setup-frequency')?.addEventListener('change', syncSetupScheduleFields);
        setupBackdrop.querySelector('#admin-report-sub-setup-choose-stores')?.addEventListener('click', openStoresPicker);

        return setupBackdrop;
    }

    function syncSetupActions(sub) {
        const modal = setupBackdrop;
        if (!modal) return;
        const hasSub = Boolean(sub?.id);
        const primaryBtn = modal.querySelector('#admin-report-sub-setup-primary');
        const changesBtn = modal.querySelector('#admin-report-sub-setup-save-changes');
        if (primaryBtn) {
            primaryBtn.textContent = hasSub ? 'Delete subscription' : 'Save subscription';
            primaryBtn.classList.toggle('admin-report-sub-setup-delete', hasSub);
            primaryBtn.classList.toggle('admin-btn-primary', !hasSub);
        }
        if (changesBtn) changesBtn.hidden = !hasSub;
        modal.querySelector('#admin-report-sub-setup-send').hidden = !hasSub;
    }

    function openSetup({ scopeType, scopeId, reportType }) {
        if (!canManage) return;
        const sub = findSubscription(scopeType, scopeId, reportType);
        setupContext = {
            scopeType,
            scopeId,
            reportType,
            subscription: sub,
            includedStoreNumbers:
                scopeType === 'area' ? resolveIncludedStoreNumbers(sub, scopeId) : null,
        };
        const modal = ensureSetupModal();
        const defaults = defaultDateRange();
        const range = sub?.dateRange || defaults;

        modal.querySelector('#admin-report-sub-setup-title').textContent = sub ? 'Manage subscription' : 'Set up subscription';
        modal.querySelector('#admin-report-sub-setup-scope').textContent = scopeDisplayLabel(scopeType, scopeId);
        modal.querySelector('#admin-report-sub-setup-report').textContent = reportTypeLabel(reportType);
        modal.querySelector('#admin-report-sub-setup-recipients').value = Array.isArray(sub?.recipients)
            ? sub.recipients.join(', ')
            : '';
        if (isIseReport(reportType)) {
            modal.querySelector('#admin-report-sub-setup-weeks').innerHTML = renderWeeksOptions(
                sub?.dateRange?.weeks ?? DEFAULT_ISE_WEEKS
            );
        } else {
            modal.querySelector('#admin-report-sub-setup-start').value = range.startDate || defaults.startDate;
            modal.querySelector('#admin-report-sub-setup-end').value = range.endDate || defaults.endDate;
        }
        syncSetupRangeFields();
        modal.querySelector('#admin-report-sub-setup-time').value = hourToTimeInputValue(
            Number.isFinite(Number(sub?.scheduleHour)) ? sub.scheduleHour : defaultScheduleHour
        );
        const frequency = String(sub?.frequency || 'daily').trim().toLowerCase() === 'weekly' ? 'weekly' : 'daily';
        modal.querySelector('#admin-report-sub-setup-frequency').value = frequency;
        modal.querySelector('#admin-report-sub-setup-day').innerHTML = renderWeekdayOptions(sub?.scheduleDayOfWeek);
        syncSetupScheduleFields();
        modal.querySelector('#admin-report-sub-setup-error').textContent = '';
        modal.querySelector('#admin-report-sub-setup-error')?.classList.remove('admin-modal-error', 'admin-modal-success');
        modal.querySelector('#admin-report-sub-setup-status').innerHTML = '';
        syncSetupActions(sub);
        modal.querySelector('#admin-report-sub-setup-backfill').hidden = !canBackfillData;
        syncSetupAreaStoresRow();
        modal.hidden = false;
        void refreshSetupDataStatus();
    }

    function closeSetup() {
        setupContext = null;
        storesPickerSnapshot = null;
        if (storesPickerBackdrop) storesPickerBackdrop.hidden = true;
        if (sendNowBackdrop) sendNowBackdrop.hidden = true;
        if (setupBackdrop) setupBackdrop.hidden = true;
    }

    function readSetupForm() {
        const modal = setupBackdrop;
        if (!modal || !setupContext) return null;
        const recipientsRaw = String(modal.querySelector('#admin-report-sub-setup-recipients')?.value || '').trim();
        const scheduleHour = parseTimeInputValue(modal.querySelector('#admin-report-sub-setup-time')?.value);
        const frequencyRaw = String(modal.querySelector('#admin-report-sub-setup-frequency')?.value || 'daily').trim();
        const frequency = frequencyRaw === 'weekly' ? 'weekly' : 'daily';
        const scheduleDayOfWeek = Number(modal.querySelector('#admin-report-sub-setup-day')?.value);
        const weeks = Number(modal.querySelector('#admin-report-sub-setup-weeks')?.value);
        const recipients = recipientsRaw
            .split(/[,;\s]+/)
            .map((r) => r.trim())
            .filter(Boolean);
        const base = {
            ...setupContext,
            recipients,
            frequency,
            scheduleHour: scheduleHour != null ? scheduleHour : defaultScheduleHour,
            scheduleDayOfWeek: Number.isFinite(scheduleDayOfWeek) ? scheduleDayOfWeek : 1,
        };
        if (setupContext.scopeType === 'area') {
            const included = readSetupIncludedStoreNumbers();
            if (!included?.length) return null;
            const all = allStoreNumbersInArea(setupContext.scopeId);
            base.includedStoreNumbers = included;
            if (included.length >= all.length) base.includedStoreNumbers = null;
        }
        if (isIseReport(setupContext.reportType)) {
            return {
                ...base,
                weeks: Number.isFinite(weeks) ? weeks : DEFAULT_ISE_WEEKS,
            };
        }
        return {
            ...base,
            startDate: String(modal.querySelector('#admin-report-sub-setup-start')?.value || '').trim(),
            endDate: String(modal.querySelector('#admin-report-sub-setup-end')?.value || '').trim(),
        };
    }

    function renderSetupDataStatus(status) {
        if (!status?.stores?.length) {
            return '<p class="admin-accounts-meta">Checking data readiness…</p>';
        }
        const isHourly = setupContext?.reportType === 'historical-hourly-sales';
        const rows = status.stores
            .map((row) => {
                const cov = row.coverage || {};
                let detail = '';
                if (cov.missingDays?.length) {
                    detail = `${cov.presentDays || 0}/${cov.totalDays || 0} days, missing ${cov.missingDays.length}`;
                } else if (cov.snapshotCount != null) {
                    detail = `${cov.snapshotCount}/${cov.weeksNeeded || 5} ISE snapshots`;
                } else if (cov.ready) {
                    detail = 'Report ready';
                } else {
                    detail = 'Incomplete';
                }
                if (isHourly && row.forecastReadiness) {
                    const fr = row.forecastReadiness;
                    if (fr.ready) {
                        detail += ' · Forecast ready';
                    } else {
                        const gaps = Array.isArray(fr.weekdayGaps) && fr.weekdayGaps.length
                            ? `needs ${fr.weekdayGaps.join(', ')}`
                            : `${fr.daysRecorded || 0}/${fr.daysRequired || 35} days`;
                        detail += ` · Forecast ${gaps}`;
                    }
                }
                const warn = !cov.ready || (isHourly && row.forecastReadiness && !row.forecastReadiness.ready);
                const cls = warn ? ' admin-report-sub-status--warn' : '';
                return `<li class="admin-report-sub-status-item${cls}">${escapeHtml(row.storeNumber)} ${escapeHtml(row.storeName || '')}: ${escapeHtml(detail)}</li>`;
            })
            .join('');
        let headline;
        if (status.ready && (!isHourly || status.forecastReady)) {
            headline = '<p class="admin-accounts-meta">Data ready for reports and forecasting.</p>';
        } else if (status.ready && isHourly) {
            headline =
                '<p class="admin-modal-error">Report data ready, but some stores still need forecast history before the forecasting tool can run.</p>';
        } else {
            headline = '<p class="admin-modal-error">Some stores need data before reports can run.</p>';
        }
        return `${headline}<ul class="admin-report-sub-status-list">${rows}</ul>`;
    }

    async function refreshSetupDataStatus() {
        const modal = setupBackdrop;
        const host = modal?.querySelector('#admin-report-sub-setup-status');
        if (!host || !setupContext) return;
        const startDate = String(modal.querySelector('#admin-report-sub-setup-start')?.value || '').trim();
        const endDate = String(modal.querySelector('#admin-report-sub-setup-end')?.value || '').trim();
        const weeks = Number(modal.querySelector('#admin-report-sub-setup-weeks')?.value);
        host.innerHTML = '<p class="admin-accounts-meta">Checking data…</p>';
        try {
            const qs = new URLSearchParams({
                reportType: setupContext.reportType,
                scopeType: setupContext.scopeType,
                scopeId: setupContext.scopeId,
            });
            if (isIseReport(setupContext.reportType)) {
                qs.set('weeks', String(Number.isFinite(weeks) ? weeks : DEFAULT_ISE_WEEKS));
                qs.set('endOffsetDays', '1');
            } else {
                qs.set('startDate', startDate);
                qs.set('endDate', endDate);
            }
            const included = readSetupIncludedStoreNumbers();
            if (setupContext.scopeType === 'area' && included?.length) {
                qs.set('includedStoreNumbers', included.join(','));
            }
            const res = await fetch(`/api/admin/report-subscriptions/data-status?${qs}`, {
                credentials: 'same-origin',
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.success) throw new Error(data.error || 'Could not load status.');
            host.innerHTML = renderSetupDataStatus(data);
        } catch (err) {
            host.innerHTML = `<p class="admin-modal-error">${escapeHtml(err.message)}</p>`;
        }
    }

    async function saveSetup() {
        const modal = setupBackdrop;
        const errEl = modal?.querySelector('#admin-report-sub-setup-error');
        if (errEl) errEl.textContent = '';
        const form = readSetupForm();
        if (!form) return;
        if (!form.recipients.length) {
            if (errEl) errEl.textContent = 'Enter at least one recipient email.';
            return;
        }
        if (form.scopeType === 'area' && !readSetupIncludedStoreNumbers()?.length) {
            if (errEl) errEl.textContent = 'Select at least one store for the area subscription.';
            return;
        }

        const btn = modal.querySelector('#admin-report-sub-setup-save-changes');
        if (btn && !btn.hidden) btn.disabled = true;
        const primaryBtn = modal.querySelector('#admin-report-sub-setup-primary');
        if (primaryBtn && primaryBtn.textContent === 'Save subscription') primaryBtn.disabled = true;
        try {
            const existing = form.subscription;
            const payload = {
                reportType: form.reportType,
                scopeType: form.scopeType,
                scopeId: form.scopeId,
                recipients: form.recipients,
                frequency: form.frequency,
                scheduleHour: form.scheduleHour,
                scheduleDayOfWeek: form.frequency === 'weekly' ? form.scheduleDayOfWeek : null,
                enabled: existing?.enabled !== false,
                dateRange: isIseReport(form.reportType)
                    ? { mode: 'ise-weeks', weeks: form.weeks, endOffsetDays: 1 }
                    : { mode: 'fixed', startDate: form.startDate, endDate: form.endDate },
            };
            if (form.scopeType === 'area') {
                payload.includedStoreNumbers =
                    Array.isArray(form.includedStoreNumbers) && form.includedStoreNumbers.length
                        ? form.includedStoreNumbers
                        : null;
            }

            let res;
            if (existing?.id) {
                res = await fetch(`/api/admin/report-subscriptions/${encodeURIComponent(existing.id)}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'same-origin',
                    body: JSON.stringify(payload),
                });
            } else {
                res = await fetch('/api/admin/report-subscriptions', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'same-origin',
                    body: JSON.stringify({ ...payload, enabled: true }),
                });
            }

            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.success) throw new Error(data.error || 'Could not save subscription.');

            if (existing?.id) {
                const idx = subscriptions.findIndex((row) => row.id === existing.id);
                if (idx >= 0 && data.subscription) subscriptions[idx] = data.subscription;
            } else if (data.subscription) {
                subscriptions.push(data.subscription);
            }

            setupContext = {
                ...form,
                subscription: data.subscription || existing,
                includedStoreNumbers:
                    form.scopeType === 'area'
                        ? resolveIncludedStoreNumbers(data.subscription || existing, form.scopeId)
                        : null,
            };
            syncSetupActions(setupContext.subscription);
            syncSetupAreaStoresRow();
            modal.querySelector('#admin-report-sub-setup-title').textContent = 'Manage subscription';
            refreshMatrix();
            if (errEl) errEl.textContent = 'Subscription saved.';
        } catch (err) {
            if (errEl) errEl.textContent = err.message || 'Could not save subscription.';
        } finally {
            if (btn && !btn.hidden) btn.disabled = false;
            if (primaryBtn && primaryBtn.textContent === 'Save subscription') primaryBtn.disabled = false;
        }
    }

    async function downloadFromSetup(backfillOnly) {
        const form = readSetupForm();
        if (!form?.scopeId) return;
        setSetupFeedback('', false);

        const btn = setupBackdrop?.querySelector(backfillOnly ? '#admin-report-sub-setup-backfill' : '#admin-report-sub-setup-download');
        const defaultLabel = backfillOnly ? 'Backfill data' : SETUP_DOWNLOAD_LABEL;
        if (btn) {
            btn.disabled = true;
            btn.textContent = backfillOnly ? 'Backfilling…' : 'Downloading…';
        }
        const payload = {
            reportType: form.reportType,
            scopeType: form.scopeType,
            scopeId: form.scopeId,
            dateRange: isIseReport(form.reportType)
                ? { mode: 'ise-weeks', weeks: form.weeks, endOffsetDays: 1 }
                : { startDate: form.startDate, endDate: form.endDate },
        };
        if (form.scopeType === 'area' && Array.isArray(form.includedStoreNumbers) && form.includedStoreNumbers.length) {
            payload.includedStoreNumbers = form.includedStoreNumbers;
        }
        try {
            if (backfillOnly) {
                const result = await runStoreByStoreBackfill(payload, {
                    onComplete: async () => {
                        await refreshSetupDataStatus();
                    },
                });
                setSetupFeedback(
                    result?.ready && result?.forecastReady
                        ? 'Backfill complete. Report and forecast history ready.'
                        : result?.ready
                          ? 'Backfill complete. Report data ready; see status for forecast gaps.'
                          : 'Backfill finished. See progress log for details.',
                    !(result?.ready && result?.forecastReady)
                );
            } else {
                await downloadReportViaStream(payload);
                setSetupFeedback('Report downloaded.', false);
                await refreshSetupDataStatus();
            }
        } catch (err) {
            setSetupFeedback(err.message || 'Request failed.', true);
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.textContent = defaultLabel;
            }
        }
    }

    async function sendNowFromSetup(recipients) {
        const modal = setupBackdrop;
        const errEl = modal?.querySelector('#admin-report-sub-setup-error');
        if (errEl) errEl.textContent = '';
        const sub = setupContext?.subscription;
        if (!sub?.id) return;
        const resolvedRecipients = Array.isArray(recipients) && recipients.length ? recipients : null;
        const btn = modal.querySelector('#admin-report-sub-setup-send');
        if (btn) {
            btn.disabled = true;
            btn.textContent = 'Sending…';
        }
        try {
            const payload = { subscriptionId: sub.id };
            if (resolvedRecipients) payload.recipients = resolvedRecipients;
            await runStreamAction('send', payload, {
                onComplete: async () => {
                    const refreshed = await fetchSubscriptions();
                    subscriptions = Array.isArray(refreshed.subscriptions) ? refreshed.subscriptions : subscriptions;
                    setupContext.subscription = subscriptions.find((row) => row.id === sub.id) || sub;
                    refreshMatrix();
                },
            });
            if (errEl) errEl.textContent = 'See progress log for send result.';
        } catch (err) {
            if (errEl) errEl.textContent = err.message || 'Could not send report.';
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.textContent = 'Send now';
            }
        }
    }

    async function deleteFromSetup() {
        const modal = setupBackdrop;
        const errEl = modal?.querySelector('#admin-report-sub-setup-error');
        if (errEl) errEl.textContent = '';
        const sub = setupContext?.subscription;
        if (!sub?.id) return;
        if (!global.confirm('Delete this report subscription?')) return;
        try {
            const res = await fetch(`/api/admin/report-subscriptions/${encodeURIComponent(sub.id)}`, {
                method: 'DELETE',
                credentials: 'same-origin',
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.success) throw new Error(data.error || 'Could not delete subscription.');
            subscriptions = subscriptions.filter((row) => row.id !== sub.id);
            closeSetup();
            refreshMatrix();
        } catch (err) {
            if (errEl) errEl.textContent = err.message || 'Could not delete subscription.';
        }
    }

    async function saveEnabled(id, enabled, inputEl) {
        const root = getRoot();
        const errEl = root?.querySelector('#admin-report-sub-error');
        if (errEl) errEl.textContent = '';
        try {
            const res = await fetch(`/api/admin/report-subscriptions/${encodeURIComponent(id)}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify({ enabled }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.success) {
                throw new Error(data.error || 'Could not save subscription.');
            }
            const idx = subscriptions.findIndex((row) => row.id === id);
            if (idx >= 0 && data.subscription) subscriptions[idx] = data.subscription;
            refreshMatrix();
        } catch (err) {
            if (inputEl) inputEl.checked = !enabled;
            if (errEl) errEl.textContent = err.message || 'Could not save subscription.';
        }
    }

    async function open() {
        const root = getRoot();
        if (root) {
            root.innerHTML = '<p class="admin-accounts-meta">Loading report subscriptions…</p>';
        }
        try {
            const [profile, payload, tree] = await Promise.all([
                fetchProfile(),
                fetchSubscriptions(),
                loadScopeTree(),
            ]);
            canManage = Boolean(payload.canManage ?? profile.canAccessAdminMenu);
            canManageAreaScope = Boolean(payload.canManageAreaScope);
            canBackfillData = Boolean(profile.canEditGlobalBuildTo);
            subscriptions = Array.isArray(payload.subscriptions) ? payload.subscriptions : [];
            defaultScheduleHour = Number(payload.defaultScheduleHour ?? 7);
            scheduleTimeZone = String(payload.timeZone || scheduleTimeZone).trim() || scheduleTimeZone;
            emailFrom = String(payload.emailFrom || emailFrom).trim() || emailFrom;
            scopeTree = tree;
            activeArea = pickDefaultArea();
            if (activeArea) sessionStorage.setItem(AREA_STORAGE_KEY, activeArea);
            render();
        } catch (err) {
            if (root) {
                root.innerHTML = `<p class="admin-modal-error" role="alert">${escapeHtml(err.message || 'Could not load report subscriptions.')}</p>`;
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
        closeSetup();
        closeProgressModal();
        progressRunning = false;
        progressDownloadPayload = null;
        progressBackfillPayload = null;
        pageHost = null;
        subscriptions = [];
        scopeTree = null;
        activeArea = '';
        canManageAreaScope = false;
        canBackfillData = false;
        setupContext = null;
    }

    global.AdminReportSubscriptions = { mount, setInlineHost, unmount, open };
})(window);
