(function (global) {
    let backdrop = null;
    let pageHost = null;
    let profile = null;
    let activeTab = 'smg';
    let smgConfig = null;
    let nsfConfig = null;

    function escapeHtml(text) {
        return String(text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function formatAudit(updatedBy, updatedAt) {
        const parts = [];
        if (updatedBy) parts.push(escapeHtml(updatedBy));
        if (updatedAt) {
            try {
                parts.push(new Date(updatedAt).toLocaleString());
            } catch {
                parts.push(escapeHtml(updatedAt));
            }
        }
        return parts.length ? `<p class="admin-accounts-meta">Last updated by ${parts.join(' · ')}</p>` : '';
    }

    function getRoot() {
        return pageHost || backdrop;
    }

    function isInline() {
        return Boolean(pageHost);
    }

    const SMG_NSF_MODAL_HTML = `
            <div class="admin-modal admin-modal--wide admin-modal--smg-nsf" role="dialog" aria-modal="true">
                <h2>Setup SMG / NSF</h2>
                <div class="admin-settings-segmented-tabs admin-accounts-org-nav">
                    <div class="admin-accounts-scope-row-wrap">
                        <span class="admin-accounts-scope-row-label">Section</span>
                        <div class="admin-accounts-scope-row admin-accounts-scope-row--equal" id="admin-smg-nsf-tabs" role="tablist" style="--scope-cols: 2">
                            <button type="button" class="admin-accounts-scope-chip is-active" data-tab="smg" role="tab" aria-selected="true">SMG periods</button>
                            <button type="button" class="admin-accounts-scope-chip" data-tab="nsf" role="tab" aria-selected="false">NSF rounds</button>
                        </div>
                    </div>
                </div>
                <div id="admin-smg-nsf-body"></div>
                <p id="admin-smg-nsf-error" class="admin-modal-error" role="alert"></p>
                <div class="admin-modal-actions">
                    <button type="button" id="admin-smg-nsf-close">Close</button>
                </div>
            </div>`;

    function bindPanel(root) {
        if (root.dataset.adminSmgNsfBound) return;
        root.dataset.adminSmgNsfBound = '1';
        root.querySelector('#admin-smg-nsf-close')?.addEventListener('click', close);
        root.querySelectorAll('[data-tab]').forEach((btn) => {
            btn.addEventListener('click', () => {
                activeTab = btn.dataset.tab;
                applyTabUi();
                renderPanel();
            });
        });
    }

    function ensureBackdrop() {
        if (pageHost) {
            if (!pageHost.querySelector('.admin-modal')) {
                pageHost.innerHTML = SMG_NSF_MODAL_HTML;
                bindPanel(pageHost);
            }
            return pageHost;
        }
        if (backdrop) return backdrop;
        backdrop = document.createElement('div');
        backdrop.className = 'admin-modal-backdrop';
        backdrop.hidden = true;
        backdrop.innerHTML = SMG_NSF_MODAL_HTML;
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

    function setError(message) {
        const el = ensureBackdrop().querySelector('#admin-smg-nsf-error');
        if (!el) return;
        el.textContent = message || '';
        el.hidden = !message;
    }

    function applyTabUi() {
        const root = ensureBackdrop();
        root.querySelectorAll('[data-tab]').forEach((tab) => {
            tab.classList.toggle('is-active', tab.dataset.tab === activeTab);
        });
    }

    async function fetchProfile() {
        if (profile) return profile;
        const res = await fetch('/api/me', { credentials: 'same-origin' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) throw new Error('Could not load profile.');
        profile = data;
        return data;
    }

    async function loadSettings() {
        const res = await fetch('/api/admin/smg-nsf/settings', { credentials: 'same-origin' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) throw new Error(data.error || 'Could not load SMG/NSF settings.');
        smgConfig = data.smg;
        nsfConfig = data.nsf;
    }

    function renderSmgPanel() {
        const cfg = smgConfig || {};
        const periods = cfg.periods || [];
        return `
            ${formatAudit(cfg.updatedBy, cfg.updatedAt)}
            <form id="admin-smg-form" class="admin-accounts-form-grid">
                <label class="admin-accounts-field">
                    Year
                    <input type="number" name="year" min="2000" max="2100" value="${escapeHtml(cfg.year || new Date().getFullYear())}" required>
                </label>
                <label class="admin-accounts-field">
                    Period 1 start date
                    <input type="date" name="period1StartDate" value="${escapeHtml(cfg.period1StartDate || '')}" required>
                </label>
                <label class="admin-accounts-field">
                    Period length (days)
                    <input type="number" name="periodLengthDays" min="1" max="366" value="${escapeHtml(cfg.periodLengthDays || 28)}" required>
                </label>
                <div class="admin-accounts-create-actions">
                    <button type="submit" class="mic-settings-btn admin-btn-primary">Save SMG settings</button>
                </div>
            </form>
            <section class="admin-store-logins-section">
                <h3>Computed periods</h3>
                <table class="admin-table">
                    <thead><tr><th>Period</th><th>Start</th><th>End</th></tr></thead>
                    <tbody>
                        ${periods
                            .map(
                                (row) =>
                                    `<tr><td>${escapeHtml(row.periodNumber)}</td><td>${escapeHtml(row.startDate)}</td><td>${escapeHtml(row.endDate)}</td></tr>`
                            )
                            .join('') || '<tr><td colspan="3">Save settings to preview periods.</td></tr>'}
                    </tbody>
                </table>
            </section>`;
    }

    function renderNsfPanel() {
        const cfg = nsfConfig || {};
        const rounds = cfg.rounds || [];
        return `
            ${formatAudit(cfg.updatedBy, cfg.updatedAt)}
            <form id="admin-nsf-form">
                <label class="admin-accounts-field">
                    Year
                    <input type="number" name="year" min="2000" max="2100" value="${escapeHtml(cfg.year || new Date().getFullYear())}" required>
                </label>
                <table class="admin-table admin-nsf-rounds-table">
                    <thead><tr><th>Round</th><th>Start</th><th>End</th><th></th></tr></thead>
                    <tbody id="admin-nsf-rounds-body">
                        ${rounds
                            .map(
                                (row, index) => `
                            <tr data-round-id="${escapeHtml(row.id || `r${index + 1}`)}">
                                <td>${index + 1}</td>
                                <td><input type="date" name="startDate" value="${escapeHtml(row.startDate || '')}" required></td>
                                <td><input type="date" name="endDate" value="${escapeHtml(row.endDate || '')}" required></td>
                                <td><button type="button" class="mic-settings-btn admin-nsf-remove-round">Remove</button></td>
                            </tr>`
                            )
                            .join('')}
                    </tbody>
                </table>
                <div class="admin-accounts-create-actions">
                    <button type="button" class="mic-settings-btn" id="admin-nsf-add-round">Add round</button>
                    <button type="submit" class="mic-settings-btn admin-btn-primary">Save NSF settings</button>
                </div>
            </form>`;
    }

    function bindNsfForm() {
        const root = ensureBackdrop();
        const form = root.querySelector('#admin-nsf-form');
        if (!form) return;
        form.querySelector('#admin-nsf-add-round')?.addEventListener('click', () => {
            const tbody = form.querySelector('#admin-nsf-rounds-body');
            const index = tbody.querySelectorAll('tr').length;
            const row = document.createElement('tr');
            row.dataset.roundId = `r-new-${Date.now()}`;
            row.innerHTML = `
                <td>${index + 1}</td>
                <td><input type="date" name="startDate" required></td>
                <td><input type="date" name="endDate" required></td>
                <td><button type="button" class="mic-settings-btn admin-nsf-remove-round">Remove</button></td>`;
            tbody.appendChild(row);
            renumberNsfRows(tbody);
        });
        form.addEventListener('click', (event) => {
            if (!event.target.classList.contains('admin-nsf-remove-round')) return;
            const row = event.target.closest('tr');
            row?.remove();
            renumberNsfRows(form.querySelector('#admin-nsf-rounds-body'));
        });
        form.addEventListener('submit', (event) => {
            event.preventDefault();
            void saveNsf(form);
        });
    }

    function renumberNsfRows(tbody) {
        tbody.querySelectorAll('tr').forEach((row, index) => {
            row.querySelector('td:first-child').textContent = String(index + 1);
        });
    }

    function collectNsfRounds(form) {
        return [...form.querySelectorAll('#admin-nsf-rounds-body tr')].map((row, index) => ({
            id: row.dataset.roundId || `r${index + 1}`,
            startDate: row.querySelector('[name="startDate"]')?.value || '',
            endDate: row.querySelector('[name="endDate"]')?.value || '',
        }));
    }

    async function saveSmg(form) {
        setError('');
        const payload = {
            year: Number(form.year.value),
            period1StartDate: form.period1StartDate.value,
            periodLengthDays: Number(form.periodLengthDays.value),
        };
        const res = await fetch('/api/admin/smg-nsf/smg', {
            method: 'PUT',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) {
            setError(data.error || 'Could not save SMG settings.');
            return;
        }
        smgConfig = data.smg;
        renderPanel();
    }

    async function saveNsf(form) {
        setError('');
        const payload = {
            year: Number(form.year.value),
            rounds: collectNsfRounds(form),
        };
        const res = await fetch('/api/admin/smg-nsf/nsf', {
            method: 'PUT',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) {
            setError(data.error || 'Could not save NSF settings.');
            return;
        }
        nsfConfig = data.nsf;
        renderPanel();
    }

    function renderPanel() {
        const root = ensureBackdrop();
        const body = root.querySelector('#admin-smg-nsf-body');
        body.innerHTML = activeTab === 'smg' ? renderSmgPanel() : renderNsfPanel();
        if (activeTab === 'smg') {
            root.querySelector('#admin-smg-form')?.addEventListener('submit', (event) => {
                event.preventDefault();
                void saveSmg(event.target);
            });
        } else {
            bindNsfForm();
        }
    }

    async function open() {
        const me = await fetchProfile();
        if (!me.canManageSmgNsfSettings) {
            throw new Error('Area access or above is required for SMG/NSF settings.');
        }
        ensureBackdrop();
        if (!isInline()) backdrop.hidden = false;
        activeTab = 'smg';
        applyTabUi();
        setError('');
        await loadSettings();
        renderPanel();
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
    }

    global.AdminSmgNsf = { open, close, mount, unmount, setInlineHost };
})(window);
