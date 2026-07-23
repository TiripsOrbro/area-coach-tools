(function () {
    const form = document.getElementById('create-account-form');
    const errorEl = document.getElementById('create-account-error');
    const statusEl = document.getElementById('create-details-status');
    const submitBtn = document.getElementById('create-account-submit');
    const successWrapEl = document.getElementById('create-details-success');
    const tempPasswordEl = document.getElementById('create-temp-password');
    const nextStepsEl = document.getElementById('create-details-next-steps');
    const scopeFieldsEl = document.getElementById('create-scope-fields');
    const parentUsernameEl = document.getElementById('create-parent-username');
    const parentPasswordEl = document.getElementById('create-parent-password');
    const usernameEl = document.getElementById('new-username');

    const Form = window.CreateAccountForm;
    let createOptions = null;
    let gateVerified = false;

    if (window.DashboardNavBack) {
        window.DashboardNavBack.mountBackButton(document.getElementById('create-account-back'), {
            fallback: '/login',
        });
    }

    if (window.TbaBrandMark?.svg) {
        const host = document.getElementById('login-brand-mark');
        if (host) host.innerHTML = window.TbaBrandMark.svg('create-account-mark');
    }

    const params = new URLSearchParams(window.location.search);
    if (params.get('error') === 'session') {
        errorEl.textContent = 'Your authorization expired. Enter your username and password below, then create the account.';
        try {
            const url = new URL(window.location.href);
            url.searchParams.delete('error');
            window.history.replaceState(null, '', url.pathname + url.search);
        } catch (_) {
            /* ignore */
        }
    }

    function adminAccountsUrl() {
        if (window.AdminMenu?.sectionUrl) {
            return window.AdminMenu.sectionUrl('accounts', { focusCreate: '1' });
        }
        return '/Admin/Settings?focusCreate=1#accounts-create';
    }

    async function maybeRedirectSignedInUser() {
        try {
            const res = await fetch('/api/me', { credentials: 'include' });
            const data = await res.json().catch(() => ({}));
            if (res.ok && data.success && data.canCreateAccount) {
                window.location.replace(adminAccountsUrl());
            }
        } catch (_) {
            /* stay on page */
        }
    }

    function showCreatedAccount(data) {
        if (successWrapEl) successWrapEl.hidden = false;
        if (tempPasswordEl) tempPasswordEl.textContent = data.temporaryPassword || '';
        if (nextStepsEl) {
            nextStepsEl.textContent = data.message || 'The user can sign in with this temporary password.';
        }
        if (submitBtn) {
            submitBtn.textContent = 'Create another account';
            submitBtn.type = 'button';
            submitBtn.onclick = () => window.location.reload();
        }
        form.querySelectorAll('input, select, button[type="submit"]').forEach((el) => {
            if (el !== submitBtn) el.disabled = true;
        });
    }

    async function loadCreateOptions() {
        Form.setLoading(scopeFieldsEl, true);
        const res = await fetch('/api/account/create-options', { credentials: 'include' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) {
            throw new Error(data.error || 'Could not load account options.');
        }
        createOptions = data;
        gateVerified = true;
        Form.mountCreateAccountForm(scopeFieldsEl, { theme: 'login', createOptions });
    }

    async function ensureGateVerified() {
        if (gateVerified) return true;

        const username = parentUsernameEl.value.trim();
        const password = parentPasswordEl.value;
        Form.clearFieldErrors(scopeFieldsEl, [parentUsernameEl, parentPasswordEl]);

        if (!username || !password) {
            errorEl.textContent = 'Enter your username and password to authorize account creation.';
            if (!username) parentUsernameEl.classList.add('is-field-invalid');
            if (!password) parentPasswordEl.classList.add('is-field-invalid');
            return false;
        }

        const res = await fetch('/Create-Account/verify', {
            method: 'POST',
            headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ username, password }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) {
            errorEl.textContent = data.error || 'Could not verify your credentials.';
            return false;
        }

        await loadCreateOptions();
        return true;
    }

    async function initFormOptions() {
        try {
            await loadCreateOptions();
        } catch (_) {
            /* gate cookie not set yet — options load after verify on submit */
        }
    }

    form?.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (submitBtn?.type === 'button') return;

        errorEl.textContent = '';
        statusEl.hidden = true;
        Form.clearFieldErrors(scopeFieldsEl, [usernameEl, parentUsernameEl, parentPasswordEl]);

        submitBtn.disabled = true;
        submitBtn.textContent = gateVerified ? 'Creating…' : 'Verifying…';

        try {
            const verified = await ensureGateVerified();
            if (!verified) {
                submitBtn.disabled = false;
                submitBtn.textContent = 'Create account';
                return;
            }

            const validation = Form.validateCreateAccountForm(scopeFieldsEl, createOptions, { usernameEl });
            if (!validation.ok) {
                errorEl.textContent = validation.errors[0]?.message || 'Fix the highlighted fields.';
                submitBtn.disabled = false;
                submitBtn.textContent = 'Create account';
                return;
            }

            submitBtn.textContent = 'Creating…';
            const { username, accountLevel, storeNumber, market, area } = validation.values;

            const res = await fetch('/api/account/create', {
                method: 'POST',
                headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
                credentials: 'include',
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
                errorEl.textContent = data.error || 'Could not create account.';
                submitBtn.disabled = false;
                submitBtn.textContent = 'Create account';
                return;
            }
            statusEl.hidden = false;
            statusEl.textContent = data.message || 'Account created.';
            showCreatedAccount(data);
        } catch (_) {
            errorEl.textContent = 'Request failed. Check your connection and try again.';
            submitBtn.disabled = false;
            submitBtn.textContent = 'Create account';
        }
    });

    maybeRedirectSignedInUser();
    initFormOptions();
})();
