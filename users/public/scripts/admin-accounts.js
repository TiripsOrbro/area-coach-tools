(function (global) {
    let backdrop = null;
    let pageHost = null;
    let activeView = '';
    let profile = null;
    let createOptions = null;
    let currentStoreNumber = '';
    let scopeNavigator = null;
    let browseScope = { market: '', area: '', storeNumber: '' };

    const Form = () => global.CreateAccountForm;

    function escapeHtml(text) {
        return String(text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function formatLastLogin(iso) {
        if (!iso) return '-';
        try {
            const date = new Date(iso);
            if (Number.isNaN(date.getTime())) return '-';
            return date.toLocaleString('en-AU', { dateStyle: 'medium', timeStyle: 'short' });
        } catch {
            return '-';
        }
    }

    function getRoot() {
        return pageHost || backdrop;
    }

    function isInline() {
        return Boolean(pageHost);
    }

    function sectionHeader(title) {
        return `
            <header class="admin-section-header">
                <h2>${escapeHtml(title)}</h2>
            </header>`;
    }

    function createViewHtml() {
        return `
            <div class="admin-modal admin-modal--wide admin-accounts-view" data-accounts-view="create">
                ${sectionHeader('Create account')}
                <section id="admin-accounts-create" class="admin-accounts-create admin-accounts-create--standalone">
                    <form id="admin-accounts-create-form" class="admin-accounts-form-grid">
                        <div id="admin-create-scope-fields" class="admin-accounts-scope-stack"></div>
                        <label class="admin-accounts-field">
                            Username
                            <input id="admin-create-username" type="text" autocomplete="off" required>
                            <span class="create-account-field-error" role="alert" hidden></span>
                        </label>
                        <div class="admin-accounts-create-actions">
                            <button type="submit" class="mic-settings-btn admin-btn-primary" id="admin-create-submit">Save account</button>
                            <button type="reset" class="mic-settings-btn" id="admin-create-reset">Clear form</button>
                        </div>
                        <div id="admin-create-result" class="admin-accounts-temp-password" hidden></div>
                    </form>
                </section>
                <p id="admin-accounts-error" class="admin-modal-error" role="alert"></p>
                <div class="admin-modal-actions">
                    <button type="button" id="admin-accounts-close">Close</button>
                </div>
            </div>`;
    }

    function existingViewHtml() {
        return `
            <div class="admin-modal admin-modal--wide admin-accounts-view" data-accounts-view="existing">
                ${sectionHeader('Existing accounts')}
                <div id="admin-accounts-browse-scope" class="admin-accounts-browse-scope admin-accounts-org-nav"></div>
                <div id="admin-accounts-body" class="admin-accounts-body"></div>
                <p id="admin-accounts-error" class="admin-modal-error" role="alert"></p>
                <div class="admin-modal-actions">
                    <button type="button" id="admin-accounts-close">Close</button>
                </div>
            </div>`;
    }

    function viewHtml(view) {
        return view === 'existing' ? existingViewHtml() : createViewHtml();
    }

    function bindCreatePanel(root) {
        if (root.dataset.adminAccountsCreateBound) return;
        root.dataset.adminAccountsCreateBound = '1';
        root.querySelector('#admin-accounts-close')?.addEventListener('click', close);
        root.querySelector('#admin-accounts-create-form')?.addEventListener('submit', (event) => {
            event.preventDefault();
            void submitCreateAccount();
        });
        root.querySelector('#admin-accounts-create-form')?.addEventListener('reset', () => {
            window.setTimeout(() => {
                const scopeFields = root.querySelector('#admin-create-scope-fields');
                Form()?.syncScopeSelects(scopeFields, createOptions);
                Form()?.clearFieldErrors(scopeFields, [root.querySelector('#admin-create-username')]);
                root.querySelector('#admin-create-result').hidden = true;
                root.querySelector('#admin-create-result').innerHTML = '';
                const submitBtn = root.querySelector('#admin-create-submit');
                submitBtn.disabled = false;
                submitBtn.textContent = 'Save account';
            }, 0);
        });
    }

    function bindExistingPanel(root) {
        if (root.dataset.adminAccountsExistingBound) return;
        root.dataset.adminAccountsExistingBound = '1';
        root.querySelector('#admin-accounts-close')?.addEventListener('click', close);
    }

    function ensureViewRoot(view) {
        const html = viewHtml(view);
        if (pageHost) {
            if (pageHost.querySelector(`[data-accounts-view="${view}"]`)) {
                return pageHost;
            }
            pageHost.innerHTML = html;
            if (view === 'create') bindCreatePanel(pageHost);
            else bindExistingPanel(pageHost);
            return pageHost;
        }
        if (backdrop && backdrop.querySelector(`[data-accounts-view="${view}"]`)) {
            return backdrop;
        }
        if (backdrop) {
            backdrop.remove();
            backdrop = null;
        }
        backdrop = document.createElement('div');
        backdrop.className = 'admin-modal-backdrop';
        backdrop.hidden = true;
        backdrop.innerHTML = html;
        document.body.appendChild(backdrop);
        backdrop.addEventListener('click', (event) => {
            if (event.target === backdrop) close();
        });
        if (view === 'create') bindCreatePanel(backdrop);
        else bindExistingPanel(backdrop);
        return backdrop;
    }

    function close() {
        if (isInline()) return;
        if (backdrop) backdrop.hidden = true;
        resetCreateForm();
        scopeNavigator = null;
    }

    function unmount() {
        pageHost = null;
        activeView = '';
        scopeNavigator = null;
    }

    function resetCreateForm() {
        const root = getRoot();
        if (!root || activeView !== 'create') return;
        const form = root.querySelector('#admin-accounts-create-form');
        const resultEl = root.querySelector('#admin-create-result');
        const submitBtn = root.querySelector('#admin-create-submit');
        const scopeFields = root.querySelector('#admin-create-scope-fields');
        form?.reset();
        if (resultEl) {
            resultEl.hidden = true;
            resultEl.innerHTML = '';
        }
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Save account';
        }
        Form()?.syncScopeSelects(scopeFields, createOptions);
        Form()?.clearFieldErrors(scopeFields, [root.querySelector('#admin-create-username')]);
    }

    function scopeTreeHasData(tree) {
        if (!tree) return false;
        if (tree.markets?.length) return true;
        return Object.values(tree.storesByArea || {}).some((rows) => rows?.length > 0);
    }

    async function loadScopeTree() {
        if (!global.AdminScopePicker?.loadScopeTree) {
            throw new Error('Org tree picker is not available.');
        }
        try {
            const tree = await global.AdminScopePicker.loadScopeTree();
            if (scopeTreeHasData(tree)) return tree;
        } catch (_) {
            /* fall back to create-options scope tree */
        }
        const opts = await ensureCreateOptions();
        if (scopeTreeHasData(opts?.scopeTree)) return opts.scopeTree;
        throw new Error('Could not load store list.');
    }

    function renderScopeNavigator(root, tree, preferredStore = '') {
        const host = root.querySelector('#admin-accounts-browse-scope');
        if (!host || !tree) {
            if (host) host.innerHTML = '';
            return null;
        }
        scopeNavigator = global.AdminScopePicker.mountInline(host, {
            tree,
            initialScope: { ...browseScope },
            preferredStore,
            scopePrefix: 'browse',
            onChange: (scope) => {
                browseScope = { ...scope };
                void onExistingScopeChange(root);
            },
        });
        return scopeNavigator;
    }

    async function onExistingScopeChange(root) {
        const scope = scopeNavigator?.getScope?.() || browseScope;
        const storeNumber = String(scope.storeNumber || '').trim();
        if (!storeNumber) {
            if (currentStoreNumber) {
                currentStoreNumber = '';
                root.querySelector('#admin-accounts-body').innerHTML =
                    '<p class="admin-accounts-empty-hint">Select a store in the org tree to view accounts.</p>';
            } else {
                root.querySelector('#admin-accounts-body').innerHTML =
                    '<p class="admin-accounts-empty-hint">Select a store in the org tree to view accounts.</p>';
            }
            return;
        }
        if (storeNumber === currentStoreNumber) return;
        currentStoreNumber = storeNumber;
        try {
            await loadAccountsList(root, storeNumber);
        } catch (error) {
            root.querySelector('#admin-accounts-error').textContent = error.message;
        }
    }

    async function populateCreateForm(storeNumber) {
        const root = ensureViewRoot('create');
        const scopeFields = root.querySelector('#admin-create-scope-fields');
        const errorEl = root.querySelector('#admin-accounts-error');
        Form()?.setLoading(scopeFields, true);
        try {
            const opts = await ensureCreateOptions();
            const levels = opts.levelChoices?.length
                ? opts.levelChoices
                : (opts.assignableLevels || []).map((row) => row.value);
            if (!levels.length) {
                if (scopeFields) {
                    scopeFields.innerHTML =
                        '<p class="admin-accounts-meta">No account levels available for your login.</p>';
                }
                return;
            }
            const resolvedStore =
                String(storeNumber || opts.scopeTree?.defaults?.storeNumber || opts.defaultStore || '').trim();
            Form()?.mountCreateAccountForm(scopeFields, {
                theme: 'admin',
                createOptions: opts,
                defaultStore: resolvedStore,
            });
            currentStoreNumber = resolvedStore;
        } catch (error) {
            if (scopeFields) {
                scopeFields.innerHTML = `<p class="admin-accounts-meta">${escapeHtml(error.message || 'Could not load access levels.')}</p>`;
            }
            if (errorEl) errorEl.textContent = error.message || 'Could not load access levels.';
            throw error;
        }
    }

    async function submitCreateAccount() {
        const root = ensureViewRoot('create');
        const errorEl = root.querySelector('#admin-accounts-error');
        const submitBtn = root.querySelector('#admin-create-submit');
        const resultEl = root.querySelector('#admin-create-result');
        const scopeFields = root.querySelector('#admin-create-scope-fields');
        const usernameEl = root.querySelector('#admin-create-username');

        errorEl.textContent = '';
        const validation = Form()?.validateCreateAccountForm(scopeFields, createOptions, {
            usernameEl,
            fallbackStore: currentStoreNumber,
        });
        if (!validation?.ok) {
            errorEl.textContent = validation.errors[0]?.message || 'Fix the highlighted fields.';
            return;
        }

        const { username, accountLevel, storeNumber, market, area } = validation.values;

        submitBtn.disabled = true;
        submitBtn.textContent = 'Creating…';
        try {
            const res = await fetch('/api/account/create', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify({
                    username,
                    accountLevel,
                    storeNumber,
                    market,
                    area,
                    useTemporaryPassword: true,
                }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.success) {
                throw new Error(data.error || 'Could not create account.');
            }
            if (resultEl) {
                resultEl.hidden = false;
                resultEl.innerHTML = `
                    <strong>Account created for ${escapeHtml(data.username || username)}</strong>
                    <span class="admin-accounts-meta">Copy this temporary password now. It will not be shown again.</span>
                    <code>${escapeHtml(data.temporaryPassword || '')}</code>
                    <span class="admin-accounts-meta">${escapeHtml(data.message || '')}</span>`;
            }
            submitBtn.textContent = 'Created';
        } catch (error) {
            errorEl.textContent = error.message;
            submitBtn.disabled = false;
            submitBtn.textContent = 'Save account';
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

    async function fetchAccounts(storeNumber) {
        const params = new URLSearchParams({ store: storeNumber });
        const res = await fetch(`/api/account/managed-accounts?${params}`, { credentials: 'same-origin' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) throw new Error(data.error || 'Could not load accounts.');
        return data;
    }

    async function deleteAccount(storeNumber, username) {
        const res = await fetch('/api/account/managed-accounts', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ store: storeNumber, username }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) throw new Error(data.error || 'Delete failed.');
    }

    async function patchAccount(storeNumber, username, patch) {
        const res = await fetch('/api/account/managed-accounts', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ store: storeNumber, username, ...patch }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) throw new Error(data.error || 'Update failed.');
        return data;
    }

    async function fetchLoginHistory(storeNumber, username) {
        const params = new URLSearchParams({ store: storeNumber, username, limit: '20' });
        const res = await fetch(`/api/account/login-history?${params}`, { credentials: 'same-origin' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) throw new Error(data.error || 'Could not load login history.');
        return data.events || [];
    }

    async function ensureCreateOptions() {
        if (createOptions) return createOptions;
        const res = await fetch('/api/account/create-options', { credentials: 'same-origin' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) throw new Error(data.error || 'Could not load account options.');
        createOptions = data;
        return data;
    }

    function renderAccounts(root, accounts, storeNumber, reload) {
        const body = root.querySelector('#admin-accounts-body');
        if (!accounts.length) {
            body.innerHTML = '<p class="admin-accounts-empty-hint">No crew accounts have been created for this store yet.</p>';
            return;
        }
        body.innerHTML = `<ul class="admin-accounts-list"></ul>`;
        const list = body.querySelector('.admin-accounts-list');
        accounts.forEach((row) => {
            const li = document.createElement('li');
            const storesLabel = (row.stores || []).join(', ') || storeNumber;
            li.innerHTML = `
                <div>
                    <strong>${escapeHtml(row.nickname || row.username)}</strong>
                    <span class="admin-accounts-meta">${escapeHtml(row.username)} · ${escapeHtml(row.accountLevel || 'mic')} · stores: ${escapeHtml(storesLabel)}</span>
                    <span class="admin-accounts-meta">Last login: ${escapeHtml(formatLastLogin(row.lastLoginAt))}</span>
                </div>
                <div>
                    <button type="button" class="mic-settings-btn" data-action="edit">Edit</button>
                    <button type="button" class="mic-settings-btn" data-action="history">History</button>
                    <button type="button" class="mic-settings-btn mic-settings-btn--danger" data-action="delete">Delete</button>
                </div>`;
            li.querySelector('[data-action="delete"]')?.addEventListener('click', async () => {
                if (!window.confirm(`Delete account “${row.nickname || row.username}”?`)) return;
                try {
                    await deleteAccount(storeNumber, row.username);
                    await reload();
                } catch (error) {
                    root.querySelector('#admin-accounts-error').textContent = error.message;
                }
            });
            li.querySelector('[data-action="history"]')?.addEventListener('click', async () => {
                try {
                    const events = await fetchLoginHistory(storeNumber, row.username);
                    const lines = events.length
                        ? events
                              .map(
                                  (ev) =>
                                      `${ev.at || ''} · ${ev.success === false ? 'failed' : 'ok'}${ev.ip ? ` · ${ev.ip}` : ''}`
                              )
                              .join('\n')
                        : 'No login events recorded yet.';
                    window.alert(lines);
                } catch (error) {
                    root.querySelector('#admin-accounts-error').textContent = error.message;
                }
            });
            li.querySelector('[data-action="edit"]')?.addEventListener('click', async () => {
                try {
                    const opts = await ensureCreateOptions();
                    const levels = (opts.levelChoices || opts.assignableLevels || [])
                        .map((row) => (typeof row === 'string' ? row : row.value))
                        .join(', ');
                    const nextLevel = window.prompt(
                        `Account level for ${row.username}\nAllowed: ${levels}`,
                        row.accountLevel || 'mic'
                    );
                    const nextStores = window.prompt(
                        `Store access (comma-separated) for ${row.username}`,
                        (row.stores || [storeNumber]).join(', ')
                    );
                    const patch = {};
                    if (nextLevel && nextLevel.trim()) patch.accountLevel = nextLevel.trim();
                    if (nextStores != null) {
                        patch.stores = nextStores
                            .split(',')
                            .map((s) => s.trim())
                            .filter(Boolean);
                    }
                    await patchAccount(storeNumber, row.username, patch);
                    await reload();
                } catch (error) {
                    root.querySelector('#admin-accounts-error').textContent = error.message;
                }
            });
            list.appendChild(li);
        });
    }

    async function loadAccountsList(root, storeNumber) {
        root.querySelector('#admin-accounts-error').textContent = '';
        root.querySelector('#admin-accounts-body').innerHTML = '<p>Loading…</p>';
        const data = await fetchAccounts(storeNumber);
        renderAccounts(root, data.accounts || [], storeNumber, () => loadAccountsList(root, storeNumber));
    }

    async function mountCreate(host, options = {}) {
        activeView = 'create';
        pageHost = host;
        browseScope = { market: '', area: '', storeNumber: '' };
        scopeNavigator = null;
        const root = ensureViewRoot('create');
        root.querySelector('#admin-accounts-error').textContent = '';
        resetCreateForm();
        const storeNumber = String(options.storeNumber || '').trim();
        try {
            await populateCreateForm(storeNumber);
        } catch (error) {
            root.querySelector('#admin-accounts-error').textContent = error.message;
        }
        if (options.focusCreate) {
            root.querySelector('#admin-create-username')?.focus();
        }
    }

    async function mountExisting(host, options = {}) {
        activeView = 'existing';
        pageHost = host;
        browseScope = { market: '', area: '', storeNumber: '' };
        scopeNavigator = null;
        currentStoreNumber = '';
        const root = ensureViewRoot('existing');
        root.querySelector('#admin-accounts-error').textContent = '';
        root.querySelector('#admin-accounts-body').innerHTML = '<p>Loading…</p>';
        try {
            const tree = await loadScopeTree();
            const preferred = String(options.storeNumber || '').trim();
            renderScopeNavigator(root, tree, preferred);
            await onExistingScopeChange(root);
        } catch (error) {
            root.querySelector('#admin-accounts-body').innerHTML = '';
            root.querySelector('#admin-accounts-error').textContent = error.message;
        }
    }

    async function mount(host, options = {}) {
        const view = options.view === 'existing' ? 'existing' : 'create';
        if (view === 'existing') return mountExisting(host, options);
        return mountCreate(host, options);
    }

    async function open(options = {}) {
        pageHost = null;
        activeView = options.view === 'existing' ? 'existing' : 'create';
        const root = ensureViewRoot(activeView);
        if (!isInline()) root.hidden = false;
        root.querySelector('#admin-accounts-error').textContent = '';

        if (activeView === 'existing') {
            browseScope = { market: '', area: '', storeNumber: '' };
            scopeNavigator = null;
            currentStoreNumber = '';
            root.querySelector('#admin-accounts-body').innerHTML = '<p>Loading…</p>';
            try {
                const tree = await loadScopeTree();
                renderScopeNavigator(root, tree, options.storeNumber || '');
                await onExistingScopeChange(root);
            } catch (error) {
                root.querySelector('#admin-accounts-body').innerHTML = '';
                root.querySelector('#admin-accounts-error').textContent = error.message;
            }
            return;
        }

        resetCreateForm();
        try {
            await populateCreateForm(options.storeNumber || '');
        } catch (error) {
            root.querySelector('#admin-accounts-error').textContent = error.message;
        }
        if (options.focusCreate) {
            root.querySelector('#admin-create-username')?.focus();
        }
    }

    function maybeOpenFromQuery() {
        const params = new URLSearchParams(window.location.search);
        if (params.get('accounts') !== '1') return;
        const focusCreate = params.get('focusCreate') === '1' ? '1' : 'true';
        window.location.href = `/Admin/Settings?focusCreate=${focusCreate}#accounts-create`;
    }

    function setInlineHost(host, view) {
        pageHost = host || null;
        if (view) activeView = view;
    }

    global.AdminAccounts = {
        open,
        close,
        mount,
        mountCreate,
        mountExisting,
        unmount,
        setInlineHost,
        maybeOpenFromQuery,
    };
})(window);
