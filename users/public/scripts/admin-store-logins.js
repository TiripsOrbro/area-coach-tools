(function (global) {
    let backdrop = null;
    let pageHost = null;
    let profile = null;
    let activeTab = 'mmx';
    let storeList = [];
    let scopeTree = null;
    let scopeNavigator = null;
    let browseScope = { market: '', area: '', storeNumber: '' };
    let currentStore = '';
    let storeDetail = null;
    let reportEmail = '';
    let savingReportEmail = false;

    const SERVICE_LABELS = {
        mmx: 'MMX',
        lifelenz: 'LifeLenz',
        smg: 'SMG',
        nsf: 'NSF',
        'report-email': 'Report email',
    };

    const SERVICES = ['mmx', 'lifelenz', 'smg', 'nsf', 'report-email'];

    const VERIFY_STATUS_STEPS = {
        mmx: [
            'Starting Macromatix login check...',
            'Opening a browser on the server to reach Macromatix...',
            'Signing in to Macromatix...',
            'Still working: Macromatix checks often take 30-60 seconds on the server...',
        ],
        lifelenz: [
            'Starting LifeLenz login check...',
            'Opening a browser on the server to reach LifeLenz...',
            'Signing in to LifeLenz...',
            'Still working: this can take up to a minute...',
        ],
        smg: ['Checking SMG credentials on the server...'],
        nsf: ['Checking NSF credentials on the server...'],
    };

    let verifyStatusTimer = null;

    function escapeHtml(text) {
        return String(text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function escapeAttr(text) {
        return escapeHtml(text);
    }

    function formatWhen(iso, by) {
        const parts = [];
        if (by) parts.push(escapeHtml(by));
        if (iso) {
            try {
                const date = new Date(iso);
                if (!Number.isNaN(date.getTime())) {
                    parts.push(
                        date.toLocaleString('en-AU', { dateStyle: 'medium', timeStyle: 'short' })
                    );
                } else {
                    parts.push(escapeHtml(iso));
                }
            } catch {
                parts.push(escapeHtml(iso));
            }
        }
        return parts.length ? parts.join(' · ') : '-';
    }

    async function loadReportEmail(storeNumber) {
        const store = String(storeNumber || '').trim();
        if (!store) {
            reportEmail = '';
            return;
        }
        try {
            const res = await fetch(`/api/tacaudit/settings?store=${encodeURIComponent(store)}`, {
                credentials: 'include',
            });
            if (!res.ok) return;
            const data = await res.json().catch(() => ({}));
            reportEmail = String(data.settings?.reportEmail || '').trim();
        } catch {
            /* ignore */
        }
    }

    async function saveReportEmail(storeNumber) {
        const store = String(storeNumber || '').trim();
        if (!store) return;
        const root = getRoot();
        const input = root?.querySelector('#admin-store-logins-report-email');
        const btn = root?.querySelector('#admin-store-logins-save-report-email');
        const errEl = root?.querySelector('#admin-store-logins-report-email-error');
        const email = String(input?.value || '').trim();
        if (errEl) errEl.textContent = '';
        savingReportEmail = true;
        if (btn) {
            btn.disabled = true;
            btn.textContent = 'Saving…';
        }
        try {
            const res = await fetch('/api/tacaudit/settings', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ store, reportEmail: email }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.success) throw new Error(data.error || 'Could not save email.');
            reportEmail = String(data.settings?.reportEmail || email).trim();
            if (input) input.value = reportEmail;
        } catch (err) {
            if (errEl) errEl.textContent = err.message || 'Could not save email.';
        } finally {
            savingReportEmail = false;
            if (btn) {
                btn.disabled = false;
                btn.textContent = 'Save email';
            }
        }
    }

    function renderReportEmailBlock() {
        return `
            <section class="admin-store-logins-section admin-store-logins-report-email">
                <h3>Report email</h3>
                <p class="mic-settings-pref-hint">Completed audit PDFs for this store are emailed here.</p>
                <div class="mic-settings-store-email">
                    <label class="mic-settings-field-label" for="admin-store-logins-report-email">Report email</label>
                    <input type="email" id="admin-store-logins-report-email" value="${escapeAttr(reportEmail)}" placeholder="store@example.com" autocomplete="email" />
                    <button type="button" class="mic-settings-btn mic-settings-btn--primary" id="admin-store-logins-save-report-email"${savingReportEmail ? ' disabled' : ''}>Save email</button>
                </div>
                <p class="admin-modal-error" id="admin-store-logins-report-email-error" role="alert"></p>
            </section>`;
    }

    function bindReportEmailControls() {
        const root = getRoot();
        if (!root) return;
        root.querySelector('#admin-store-logins-save-report-email')?.addEventListener('click', () => {
            void saveReportEmail(currentStore);
        });
    }

    function sectionHeader(title) {
        return `
            <header class="admin-section-header">
                <h2>${escapeHtml(title)}</h2>
            </header>`;
    }

    function loginFieldForService(service) {
        return service === 'lifelenz' ? 'email' : 'username';
    }

    function loginLabelForService(service) {
        return service === 'lifelenz' ? 'Email' : 'Username';
    }

    function normalizeStoreNumber(value) {
        const raw = String(value || '').trim();
        if (!raw) return '';
        const stripped = raw.replace(/^0+/, '');
        return stripped || raw;
    }

    function storeInList(storeNumber) {
        const num = normalizeStoreNumber(storeNumber);
        if (!num) return false;
        return storeList.some((row) => {
            const listed = String(row.storeNumber);
            return listed === num || normalizeStoreNumber(listed) === num;
        });
    }

    function storeNumberFromList(storeNumber) {
        const num = normalizeStoreNumber(storeNumber);
        const row = storeList.find((entry) => normalizeStoreNumber(entry.storeNumber) === num);
        return row ? String(row.storeNumber) : num;
    }

    function preferredStoreNumber(explicit = '') {
        const candidates = [
            explicit,
            currentStore,
            browseScope.storeNumber,
            storeList.length === 1 ? storeList[0].storeNumber : '',
            scopeTree?.defaults?.storeNumber,
        ];
        const effective = profile?.effectiveStores;
        if (Array.isArray(effective)) {
            if (effective.length === 1) candidates.push(effective[0]);
            if (profile?.skipStorePicker && effective[0]) candidates.push(effective[0]);
        }
        const userMatch = String(profile?.username || '').match(/^CB(\d{3,6})$/i);
        if (userMatch?.[1]) candidates.push(userMatch[1]);
        const pathMatch = global.location?.pathname?.match(/\/(?:MIC|mic)\/(\d+)/i);
        if (pathMatch?.[1]) candidates.push(pathMatch[1]);

        for (const candidate of candidates) {
            const num = String(candidate || '').trim();
            if (storeInList(num)) return storeNumberFromList(num);
        }
        return '';
    }

    function scopeTreeHasData(tree) {
        if (!tree) return false;
        if (tree.markets?.length) return true;
        return Object.values(tree.storesByArea || {}).some((rows) => rows?.length > 0);
    }

    function buildFallbackScopeTree(stores) {
        const rows = (stores || []).map((row) => ({
            storeNumber: String(row.storeNumber),
            storeName: String(row.storeName || row.storeNumber),
        }));
        if (!rows.length) return null;
        const bucket = 'Stores';
        return {
            markets: [bucket],
            areasByMarket: { [bucket]: [bucket] },
            storesByArea: { [bucket]: rows },
            defaults: {
                market: bucket,
                area: bucket,
                storeNumber: rows.length === 1 ? rows[0].storeNumber : '',
            },
        };
    }

    function viewHtml() {
        return `
            <div class="admin-modal admin-modal--wide admin-store-logins-view" data-store-logins-view="main">
                ${sectionHeader('Store logins')}
                <div id="admin-store-logins-browse-scope" class="admin-accounts-browse-scope admin-accounts-org-nav"></div>
                <div class="admin-settings-scroll-body">
                    <div id="admin-store-logins-content" class="admin-store-logins-content" hidden>
                        <div class="admin-settings-segmented-tabs admin-accounts-org-nav">
                            <div class="admin-accounts-scope-row-wrap">
                                <span class="admin-accounts-scope-row-label">Service</span>
                                <div class="admin-accounts-scope-row admin-accounts-scope-row--equal" id="admin-store-logins-tabs" role="tablist" style="--scope-cols: ${SERVICES.length}">
                                    ${SERVICES.map(
                                        (svc) =>
                                            `<button type="button" class="admin-accounts-scope-chip${svc === 'mmx' ? ' is-active' : ''}" data-tab="${svc}" role="tab" aria-selected="${svc === 'mmx' ? 'true' : 'false'}">${SERVICE_LABELS[svc]}</button>`
                                    ).join('')}
                                </div>
                            </div>
                        </div>
                        <div id="admin-store-logins-body"></div>
                    </div>
                    <div id="admin-store-logins-empty" class="admin-store-logins-empty">
                        <p class="admin-accounts-empty-hint">Select a store in the org tree to manage logins.</p>
                    </div>
                </div>
                <p id="admin-store-logins-status" class="admin-store-logins-status" role="status" hidden></p>
                <p id="admin-store-logins-error" class="admin-modal-error" role="alert"></p>
                <div class="admin-modal-actions">
                    <button type="button" id="admin-store-logins-close">Close</button>
                </div>
            </div>`;
    }

    function getRoot() {
        return pageHost || backdrop;
    }

    function isInline() {
        return Boolean(pageHost);
    }

    function bindPanel(root) {
        if (root.dataset.adminStoreLoginsBound) return;
        root.dataset.adminStoreLoginsBound = '1';
        root.querySelector('#admin-store-logins-close')?.addEventListener('click', close);
        root.querySelectorAll('#admin-store-logins-tabs [data-tab]').forEach((btn) => {
            btn.addEventListener('click', () => {
                activeTab = btn.dataset.tab;
                applyTabUi();
                renderEditPanel();
            });
        });
        root.querySelector('#admin-store-logins-body')?.addEventListener('submit', (event) => {
            const form = event.target.closest('.admin-store-logins-form');
            if (!form) return;
            event.preventDefault();
            void submitForm(form);
        });
    }

    function ensureViewRoot() {
        if (pageHost) {
            if (!pageHost.querySelector('[data-store-logins-view="main"]')) {
                pageHost.innerHTML = viewHtml();
                bindPanel(pageHost);
            }
            return pageHost;
        }
        if (backdrop?.querySelector('[data-store-logins-view="main"]')) {
            return backdrop;
        }
        if (backdrop) {
            backdrop.remove();
            backdrop = null;
        }
        backdrop = document.createElement('div');
        backdrop.className = 'admin-modal-backdrop';
        backdrop.hidden = true;
        backdrop.innerHTML = viewHtml();
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
        const el = getRoot()?.querySelector('#admin-store-logins-error');
        if (!el) return;
        if (message) {
            stopVerifyStatus();
            el.textContent = message;
            el.hidden = false;
            el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        } else {
            el.textContent = '';
            el.hidden = true;
        }
    }

    function setStatus(message) {
        const el = getRoot()?.querySelector('#admin-store-logins-status');
        if (!el) return;
        if (message) {
            el.textContent = message;
            el.hidden = false;
        } else {
            el.textContent = '';
            el.hidden = true;
        }
    }

    function stopVerifyStatus() {
        if (verifyStatusTimer) {
            clearInterval(verifyStatusTimer);
            verifyStatusTimer = null;
        }
        setStatus('');
    }

    function startVerifyStatus(service) {
        stopVerifyStatus();
        const steps = VERIFY_STATUS_STEPS[service] || VERIFY_STATUS_STEPS.mmx;
        const started = Date.now();
        let step = 0;
        const tick = () => {
            const secs = Math.floor((Date.now() - started) / 1000);
            if (secs >= 8 && step < steps.length - 1) step += 1;
            setStatus(`${steps[step]} (${secs}s)`);
        };
        tick();
        verifyStatusTimer = setInterval(tick, 1000);
    }

    function applyTabUi() {
        const root = getRoot();
        if (!root) return;
        root.querySelectorAll('#admin-store-logins-tabs [data-tab]').forEach((tab) => {
            tab.classList.toggle('is-active', tab.dataset.tab === activeTab);
        });
    }

    function updateStorePanelVisibility(root) {
        const hasStore = Boolean(currentStore);
        root.querySelector('#admin-store-logins-content').hidden = !hasStore;
        root.querySelector('#admin-store-logins-empty').hidden = hasStore;
    }

    async function fetchProfile() {
        if (profile) return profile;
        const res = await fetch('/api/me', { credentials: 'same-origin' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) throw new Error('Could not load profile.');
        profile = data;
        return data;
    }

    async function loadScopeTree() {
        let raw = null;
        try {
            raw = await global.AdminScopePicker.loadScopeTree();
        } catch {
            try {
                const res = await fetch('/api/account/create-options', { credentials: 'same-origin' });
                const data = await res.json().catch(() => ({}));
                if (res.ok && data.success && data.scopeTree) {
                    raw = data.scopeTree;
                }
            } catch {
                /* fall through */
            }
        }

        if (raw) {
            scopeTree = global.AdminScopePicker.filterScopeTreeForStores(raw, storeList);
            if (scopeTreeHasData(scopeTree)) return scopeTree;
        }

        scopeTree = buildFallbackScopeTree(storeList);
        return scopeTree;
    }

    async function loadStores() {
        const res = await fetch('/api/admin/store-logins', { credentials: 'same-origin' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) throw new Error(data.error || 'Could not load store logins.');
        storeList = data.stores || [];
        return storeList;
    }

    function renderScopeNavigator(root, preferredStore = '') {
        const host = root.querySelector('#admin-store-logins-browse-scope');
        if (!host || !scopeTree) {
            if (host) {
                host.innerHTML = '<p class="admin-scope-picker-empty">No stores available.</p>';
            }
            return null;
        }

        scopeNavigator = global.AdminScopePicker.mountInline(host, {
            tree: scopeTree,
            initialScope: { ...browseScope },
            preferredStore,
            scopePrefix: 'browse',
            onChange: (scope) => {
                browseScope = { ...scope };
                void onStoreScopeChange(root);
            },
        });
        browseScope = scopeNavigator.getScope();
        return scopeNavigator;
    }

    async function onStoreScopeChange(root) {
        const scope = scopeNavigator?.getScope?.() || browseScope;
        const storeNumber = String(scope.storeNumber || '').trim();
        setError('');

        if (!storeNumber) {
            currentStore = '';
            storeDetail = null;
            updateStorePanelVisibility(root);
            return;
        }

        const resolved = storeNumberFromList(storeNumber);
        if (resolved === currentStore) return;

        currentStore = resolved;
        updateStorePanelVisibility(root);
        try {
            await loadStoreDetail();
        } catch (error) {
            setError(error.message);
        }
    }

    async function loadStoreDetail() {
        const root = getRoot();
        if (!currentStore) {
            storeDetail = null;
            renderEditPanel();
            return;
        }
        const body = root?.querySelector('#admin-store-logins-body');
        if (body) body.innerHTML = '<p>Loading…</p>';

        const res = await fetch(`/api/admin/store-logins/${encodeURIComponent(currentStore)}`, {
            credentials: 'same-origin',
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) throw new Error(data.error || 'Could not load store login detail.');
        storeDetail = data;
        await loadReportEmail(currentStore);
        renderEditPanel();
    }

    function renderCredentialBlock(entry) {
        if (!entry) {
            return '<p class="admin-accounts-meta">No login saved.</p>';
        }
        return `
            <div class="admin-store-logins-entry">
                <div><strong>${escapeHtml(entry.label || 'Primary')}</strong></div>
                <div>${escapeHtml(entry.maskedLogin || '-')}</div>
                <div class="admin-accounts-meta">Updated ${formatWhen(entry.updatedAt, entry.updatedBy)}</div>
            </div>`;
    }

    function renderEditPanel() {
        const root = getRoot();
        if (!root) return;
        const body = root.querySelector('#admin-store-logins-body');
        if (!body) return;

        if (!currentStore) {
            body.innerHTML = '';
            return;
        }

        if (activeTab === 'report-email') {
            body.innerHTML = renderReportEmailBlock();
            bindReportEmailControls();
            return;
        }

        const service = activeTab;
        const status = storeDetail?.services?.[service] || { configured: false, primary: null, fallbacks: [] };
        const loginField = loginFieldForService(service);
        body.innerHTML = `
            <section class="admin-store-logins-section">
                <h3>Primary ${escapeHtml(SERVICE_LABELS[service])} login for store ${escapeHtml(currentStore)}</h3>
                ${renderCredentialBlock(status.primary)}
                <form class="admin-accounts-form-grid admin-store-logins-form" data-role="primary">
                    <label class="admin-accounts-field">
                        ${escapeHtml(loginLabelForService(service))}
                        <input type="${service === 'lifelenz' ? 'email' : 'text'}" name="${loginField}" autocomplete="off" required>
                    </label>
                    <label class="admin-accounts-field">
                        Password
                        <input type="password" name="password" autocomplete="new-password" required>
                    </label>
                    <label class="admin-accounts-field">
                        Label
                        <input type="text" name="label" value="Primary">
                    </label>
                    <div class="admin-accounts-create-actions">
                        <button type="submit" class="mic-settings-btn admin-btn-primary">Verify &amp; save primary</button>
                    </div>
                </form>
            </section>`;
    }

    function formPayload(form) {
        const data = new FormData(form);
        const payload = {};
        for (const [key, value] of data.entries()) payload[key] = String(value || '').trim();
        return payload;
    }

    async function submitForm(form) {
        if (!currentStore) {
            setError('Select a store before saving logins.');
            return;
        }
        const submitBtn = form.querySelector('button[type="submit"]');
        if (submitBtn?.disabled) return;
        const originalText = submitBtn?.textContent || '';

        setError('');
        const payload = formPayload(form);
        const loginField = loginFieldForService(activeTab);
        if (!payload[loginField] || !payload.password) {
            setError(`${loginLabelForService(activeTab)} and password are required.`);
            return;
        }

        const url = `/api/admin/store-logins/${encodeURIComponent(currentStore)}/${activeTab}/verify`;
        const body = { ...payload, save: true, asFallback: false };

        form.classList.add('is-verifying');
        form.setAttribute('aria-busy', 'true');
        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.textContent = 'Verifying...';
        }
        startVerifyStatus(activeTab);

        try {
            const res = await fetch(url, {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.success) {
                setError(data.error || 'Could not save login.');
                return;
            }
            if (data.bootstrapScrapeStarted) {
                setStatus(
                    'Login saved. Loading sales, SSSG, and orders to place for this store (about 1 minute)...'
                );
                setTimeout(() => setStatus(''), 12000);
            } else {
                setStatus('Login verified and saved.');
                setTimeout(() => setStatus(''), 4000);
            }
            form.reset();
            await loadStoreDetail();
            await loadStores();
        } catch (err) {
            setError(err?.message || 'Could not save login.');
        } finally {
            if (verifyStatusTimer) {
                clearInterval(verifyStatusTimer);
                verifyStatusTimer = null;
            }
            form.classList.remove('is-verifying');
            form.removeAttribute('aria-busy');
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.textContent = originalText;
            }
        }
    }

    async function initView(root, options = {}) {
        activeTab = 'mmx';
        scopeNavigator = null;
        browseScope = { market: '', area: '', storeNumber: '' };
        currentStore = '';
        storeDetail = null;
        stopVerifyStatus();

        const me = await fetchProfile();
        if (!me.canManageStoreLogins) {
            throw new Error('You do not have permission to manage store logins.');
        }

        root.querySelector('#admin-store-logins-error').textContent = '';
        setStatus('');
        applyTabUi();
        updateStorePanelVisibility(root);

        await loadStores();
        await loadScopeTree();

        const preferred = preferredStoreNumber(String(options.storeNumber || '').trim());
        renderScopeNavigator(root, preferred);
        await onStoreScopeChange(root);
    }

    async function mount(host, options = {}) {
        pageHost = host;
        await initView(ensureViewRoot(), options);
    }

    async function open(options = {}) {
        pageHost = null;
        const root = ensureViewRoot();
        root.hidden = false;
        await initView(root, options);
    }

    function setInlineHost(host) {
        pageHost = host || null;
    }

    function unmount() {
        pageHost = null;
        scopeNavigator = null;
        browseScope = { market: '', area: '', storeNumber: '' };
        currentStore = '';
        storeDetail = null;
        stopVerifyStatus();
    }

    global.AdminStoreLogins = { open, close, mount, unmount, setInlineHost };
})(window);
