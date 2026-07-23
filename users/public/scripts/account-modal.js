(function () {
    const BIN_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path fill="currentColor" d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12ZM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4Z"/>
    </svg>`;

    let backdrop = null;
    let accountsBackdrop = null;
    let profile = null;

    function ensureBackdrop() {
        if (backdrop) return backdrop;
        backdrop = document.createElement('div');
        backdrop.className = 'account-modal-backdrop';
        backdrop.hidden = true;
        backdrop.innerHTML = `
            <div class="account-modal" role="dialog" aria-modal="true">
                <h2 id="account-modal-title"></h2>
                <form id="account-modal-form" class="account-modal-form"></form>
                <p id="account-modal-error" class="account-modal-error" role="alert"></p>
                <div class="account-modal-actions">
                    <button type="button" id="account-modal-cancel">Cancel</button>
                    <button type="submit" form="account-modal-form" class="account-modal-primary" id="account-modal-submit">Save</button>
                </div>
            </div>
        `;
        document.body.appendChild(backdrop);
        backdrop.addEventListener('click', (event) => {
            if (event.target === backdrop) closeModal();
        });
        backdrop.querySelector('#account-modal-cancel')?.addEventListener('click', closeModal);
        return backdrop;
    }

    function closeModal() {
        if (!backdrop) return;
        backdrop.hidden = true;
    }

    function openModal({ title, fields, submitLabel, onSubmit }) {
        const root = ensureBackdrop();
        root.hidden = false;
        root.querySelector('#account-modal-title').textContent = title;
        root.querySelector('#account-modal-error').textContent = '';
        root.querySelector('#account-modal-submit').textContent = submitLabel || 'Save';
        const form = root.querySelector('#account-modal-form');
        form.innerHTML = fields
            .map((field) => {
                if (field.type === 'textarea') {
                    const rows = field.rows || 4;
                    return `
            <label>
                ${field.label}
                <textarea name="${field.name}" rows="${rows}" ${field.required === false ? '' : 'required'}></textarea>
            </label>
        `;
                }
                return `
            <label>
                ${field.label}
                <input name="${field.name}" type="${field.type || 'text'}" ${field.autocomplete ? `autocomplete="${field.autocomplete}"` : ''} ${field.required === false ? '' : 'required'}>
            </label>
        `;
            })
            .join('');
        form.onsubmit = async (event) => {
            event.preventDefault();
            const data = Object.fromEntries(new FormData(form).entries());
            root.querySelector('#account-modal-error').textContent = '';
            root.querySelector('#account-modal-submit').disabled = true;
            try {
                await onSubmit(data);
                closeModal();
            } catch (error) {
                root.querySelector('#account-modal-error').textContent = error.message || 'Request failed.';
            } finally {
                root.querySelector('#account-modal-submit').disabled = false;
            }
        };
        form.querySelector('input')?.focus();
    }

    async function fetchProfile() {
        const res = await fetch('/api/me', { credentials: 'same-origin' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) throw new Error('Could not load account profile.');
        profile = data;
        return data;
    }

    function mountAccountMenu(host, options = {}) {
        if (!host) return;
        host.innerHTML = `
            <div class="account-menu">
                <button type="button" class="mic-account-btn account-menu-trigger" aria-haspopup="true">Account</button>
                <div class="account-menu-panel" hidden>
                    <button type="button" data-action="change-password">Change password</button>
                    <button type="button" data-action="request-feature" hidden>Request a feature</button>
                    <button type="button" data-action="create-account" hidden>Create account</button>
                    <button type="button" data-action="admin-menu" hidden>Admin menu</button>
                    <button type="button" data-action="logout">Sign out</button>
                </div>
            </div>
        `;
        const trigger = host.querySelector('.account-menu-trigger');
        const panel = host.querySelector('.account-menu-panel');
        trigger.addEventListener('click', () => {
            panel.hidden = !panel.hidden;
        });
        document.addEventListener('click', (event) => {
            if (!host.contains(event.target)) panel.hidden = true;
        });
        panel.querySelector('[data-action="logout"]')?.addEventListener('click', () => {
            window.location.href = '/logout';
        });
        panel.querySelector('[data-action="change-password"]')?.addEventListener('click', () => {
            panel.hidden = true;
            openChangePasswordModal();
        });
        panel.querySelector('[data-action="request-feature"]')?.addEventListener('click', () => {
            panel.hidden = true;
            openFeatureRequestModal();
        });
        panel.querySelector('[data-action="create-account"]')?.addEventListener('click', () => {
            panel.hidden = true;
            openCreateAccountModal();
        });
        panel.querySelector('[data-action="admin-menu"]')?.addEventListener('click', () => {
            panel.hidden = true;
            window.location.href = window.AdminMenu?.ADMIN_PAGE_PATH || '/Admin/Settings';
        });
        fetchProfile()
            .then((data) => {
                if (data.username && !data.nologin) {
                    panel.querySelector('[data-action="request-feature"]').hidden = false;
                }
                if (data.canCreateAccount) {
                    panel.querySelector('[data-action="create-account"]').hidden = false;
                }
                if (data.canAccessAdminMenu) {
                    panel.querySelector('[data-action="admin-menu"]').hidden = false;
                }
                if (options.onProfile) options.onProfile(data);
            })
            .catch(() => {});
    }

    function ensureAccountsBackdrop() {
        if (accountsBackdrop) return accountsBackdrop;
        accountsBackdrop = document.createElement('div');
        accountsBackdrop.className = 'account-modal-backdrop';
        accountsBackdrop.id = 'account-accounts-backdrop';
        accountsBackdrop.hidden = true;
        accountsBackdrop.innerHTML = `
            <div class="account-modal account-modal--wide" role="dialog" aria-modal="true" aria-labelledby="account-accounts-title">
                <h2 id="account-accounts-title">View accounts</h2>
                <div id="account-accounts-admin-pick" class="account-modal-store-pick" hidden>
                    <span>Store</span>
                    <select id="account-accounts-store-select" aria-label="Select store"></select>
                </div>
                <div id="account-accounts-body"></div>
                <p id="account-accounts-error" class="account-modal-error" role="alert"></p>
                <div class="account-modal-actions">
                    <button type="button" id="account-accounts-close">Close</button>
                </div>
            </div>
        `;
        document.body.appendChild(accountsBackdrop);
        accountsBackdrop.addEventListener('click', (event) => {
            if (event.target === accountsBackdrop) closeAccountsModal();
        });
        accountsBackdrop.querySelector('#account-accounts-close')?.addEventListener('click', closeAccountsModal);
        return accountsBackdrop;
    }

    function closeAccountsModal() {
        if (!accountsBackdrop) return;
        accountsBackdrop.hidden = true;
    }

    function escapeHtml(text) {
        return String(text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    async function fetchManagedAccounts(storeNumber) {
        const params = new URLSearchParams({ store: storeNumber });
        const res = await fetch(`/api/account/managed-accounts?${params}`, { credentials: 'same-origin' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) {
            throw new Error(data.error || 'Could not load accounts.');
        }
        return data;
    }

    async function deleteManagedAccount(storeNumber, username) {
        const res = await fetch('/api/account/managed-accounts', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ store: storeNumber, username }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) {
            throw new Error(data.error || 'Could not delete account.');
        }
        return data;
    }

    function renderAccountsList(root, accounts, storeNumber, onDelete) {
        const body = root.querySelector('#account-accounts-body');
        if (!body) return;
        if (!accounts.length) {
            body.innerHTML = '<p class="account-accounts-empty">No MIC accounts have been created for this store yet.</p>';
            return;
        }
        body.innerHTML = `<ul class="account-accounts-list"></ul>`;
        const list = body.querySelector('.account-accounts-list');
        accounts.forEach((row) => {
            const li = document.createElement('li');
            const nickname = row.nickname || row.username;
            li.innerHTML = `
                <div>
                    <span class="account-accounts-nickname">${escapeHtml(nickname)}</span>
                    <span class="account-accounts-username">${escapeHtml(row.username)}</span>
                </div>
            `;
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'account-accounts-delete';
            btn.setAttribute('aria-label', `Delete ${nickname}`);
            btn.innerHTML = BIN_SVG;
            btn.addEventListener('click', async () => {
                const username = row.username;
                if (
                    !window.confirm(
                        `Delete account “${nickname}” (${username})? This cannot be undone.`
                    )
                ) {
                    return;
                }
                btn.disabled = true;
                try {
                    await deleteManagedAccount(storeNumber, username);
                    await onDelete();
                } catch (error) {
                    root.querySelector('#account-accounts-error').textContent =
                        error.message || 'Delete failed.';
                    btn.disabled = false;
                }
            });
            li.appendChild(btn);
            list.appendChild(li);
        });
    }

    async function loadAccountsIntoModal(root, storeNumber) {
        const errorEl = root.querySelector('#account-accounts-error');
        if (errorEl) errorEl.textContent = '';
        const body = root.querySelector('#account-accounts-body');
        if (body) body.innerHTML = '<p class="account-accounts-empty">Loading…</p>';
        const data = await fetchManagedAccounts(storeNumber);
        renderAccountsList(root, data.accounts || [], storeNumber, () => loadAccountsIntoModal(root, storeNumber));
        return data;
    }

    function openViewAccountsModal(options = {}) {
        const query = {};
        if (options.storeNumber) query.store = options.storeNumber;
        if (options.focusCreate) query.focusCreate = '1';
        if (window.AdminMenu?.sectionUrl) {
            window.location.href = window.AdminMenu.sectionUrl('accounts-existing', query);
            return;
        }
        if (window.AdminAccounts?.open) {
            void window.AdminAccounts.open(options);
            return;
        }
        void openViewAccountsModalLegacy(options);
    }

    async function openViewAccountsModalLegacy(options = {}) {
        const root = ensureAccountsBackdrop();
        root.hidden = false;
        root.querySelector('#account-accounts-error').textContent = '';

        const profileData = profile || (await fetchProfile());
        const isAdmin = Boolean(options.isAdmin || profileData.role === 'admin' || profileData.stores === '*');
        const adminPick = root.querySelector('#account-accounts-admin-pick');
        const storeSelect = root.querySelector('#account-accounts-store-select');

        let storeNumber = String(options.storeNumber || '').trim();

        if (isAdmin) {
            adminPick.hidden = false;
            const storesRes = await fetch(`${window.location.origin}/api/stores`, { credentials: 'same-origin' });
            const storesData = await storesRes.json().catch(() => ({}));
            const stores = (storesData.stores || []).filter((s) => !s.testStore);
            storeSelect.innerHTML = stores
                .map(
                    (s) =>
                        `<option value="${escapeHtml(s.storeNumber)}">${escapeHtml(s.storeNumber)} - ${escapeHtml(s.storeName || s.storeNumber)}</option>`
                )
                .join('');
            if (!storeNumber && stores.length) storeNumber = String(stores[0].storeNumber);
            if (storeNumber) storeSelect.value = storeNumber;
            storeSelect.onchange = () => {
                loadAccountsIntoModal(root, storeSelect.value).catch((error) => {
                    root.querySelector('#account-accounts-error').textContent = error.message;
                });
            };
        } else {
            adminPick.hidden = true;
            if (!storeNumber) {
                const stores = profileData.stores === '*' ? [] : profileData.stores || [];
                storeNumber = String(stores[0] || '').trim();
            }
            const micMatch =
                window.location.pathname.match(/^\/MIC\/(\d{3,6})\/?$/i) ||
                window.location.pathname.match(/\/(\d{3,6})\/mic\/?$/i);
            if (!storeNumber && micMatch) storeNumber = micMatch[1];
            if (!storeNumber && /^\/MIC\/Overview\/?$/i.test(window.location.pathname)) {
                try {
                    const meRes = await fetch('/api/me', { credentials: 'same-origin' });
                    const me = await meRes.json();
                    const stores =
                        me.stores === '*' ? [] : Array.isArray(me.stores) ? me.stores.map(String) : [];
                    if (stores.length === 1) storeNumber = stores[0];
                } catch {
                    /* ignore */
                }
            }
        }

        if (!storeNumber) {
            root.querySelector('#account-accounts-body').innerHTML =
                '<p class="account-accounts-empty">No store selected.</p>';
            return;
        }

        try {
            await loadAccountsIntoModal(root, storeNumber);
        } catch (error) {
            root.querySelector('#account-accounts-error').textContent = error.message || 'Could not load accounts.';
        }
    }

    function openChangePasswordModal() {
        openModal({
            title: 'Change password',
            submitLabel: 'Update password',
            fields: [
                { label: 'Current password', name: 'currentPassword', type: 'password', autocomplete: 'current-password' },
                { label: 'New password', name: 'newPassword', type: 'password', autocomplete: 'new-password' },
                { label: 'Confirm new password', name: 'confirmPassword', type: 'password', autocomplete: 'new-password' },
            ],
            onSubmit: async (data) => {
                if (data.newPassword !== data.confirmPassword) {
                    throw new Error('New passwords do not match.');
                }
                const res = await fetch('/api/account/change-password', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'same-origin',
                    body: JSON.stringify({
                        currentPassword: data.currentPassword,
                        newPassword: data.newPassword,
                    }),
                });
                const body = await res.json().catch(() => ({}));
                if (!res.ok || !body.success) throw new Error(body.error || 'Password change failed.');
            },
        });
    }

    function openCreateAccountModal() {
        if (window.AdminMenu?.sectionUrl) {
            void fetchProfile()
                .then((data) => {
                    const storeNumber =
                        data.effectiveStores?.[0] ||
                        (Array.isArray(data.stores) ? data.stores[0] : '') ||
                        '';
                    const query = { focusCreate: '1' };
                    if (storeNumber) query.store = storeNumber;
                    window.location.href = window.AdminMenu.sectionUrl('accounts-create', query);
                })
                .catch(() => {
                    window.location.href = window.AdminMenu.sectionUrl('accounts-create', { focusCreate: '1' });
                });
            return;
        }
        if (!window.AdminAccounts?.open) {
            window.location.href = '/Create-Account';
            return;
        }
        void fetchProfile()
            .then((data) => {
                const storeNumber =
                    data.effectiveStores?.[0] ||
                    (Array.isArray(data.stores) ? data.stores[0] : '') ||
                    '';
                const isAdmin =
                    data.canViewCrossStoreAccounts || data.role === 'admin' || data.stores === '*';
                window.AdminAccounts.open({ storeNumber, isAdmin, focusCreate: true });
            })
            .catch(() => {
                window.AdminAccounts.open({ focusCreate: true });
            });
    }

    function openFeatureRequestModal() {
        openModal({
            title: 'Request a feature',
            submitLabel: 'Send request',
            fields: [
                {
                    label: 'What would you like added or improved?',
                    name: 'text',
                    type: 'textarea',
                    rows: 5,
                },
            ],
            onSubmit: async (data) => {
                const res = await fetch('/api/feature-requests', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'same-origin',
                    body: JSON.stringify({ text: data.text }),
                });
                const body = await res.json().catch(() => ({}));
                if (!res.ok || !body.success) {
                    throw new Error(body.error || 'Could not send feature request.');
                }
            },
        });
    }

    window.DashboardAccount = {
        mountAccountMenu,
        fetchProfile,
        openChangePasswordModal,
        openFeatureRequestModal,
        openCreateAccountModal,
        openViewAccountsModal,
        closeAccountsModal,
    };
})();
