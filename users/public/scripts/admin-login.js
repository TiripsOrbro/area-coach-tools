(function () {
    const form = document.getElementById('admin-login-form');
    const errorEl = document.getElementById('admin-login-error');

    if (window.DashboardNavBack) {
        window.DashboardNavBack.mountBackButton(document.getElementById('admin-login-back'), {
            fallback: '/login',
        });
    }

    if (window.TbaBrandMark?.svg) {
        const host = document.getElementById('login-brand-mark');
        if (host) host.innerHTML = window.TbaBrandMark.svg('admin-login-mark');
    }

    const params = new URLSearchParams(window.location.search);
    if (params.get('error') === 'invalid') {
        errorEl.textContent = 'Incorrect username or password.';
    }

    function showError(msg) {
        errorEl.textContent = msg || '';
    }

    form?.addEventListener('submit', async (event) => {
        event.preventDefault();
        showError('');
        const username = document.getElementById('admin-username').value.trim();
        const password = document.getElementById('admin-password').value;
        const remember = document.getElementById('admin-remember').checked;
        try {
            const res = await fetch('/admin/login', {
                method: 'POST',
                headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ username, password, remember }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.success) {
                showError(data.error || 'Sign in failed.');
                return;
            }
            if (data.mustChangePassword) {
                window.location.replace('/change-password');
                return;
            }
            try {
                sessionStorage.removeItem('mic-overview-area');
                sessionStorage.removeItem('mic-overview-show-scope-nav');
                sessionStorage.removeItem('admin-view-as-store-enabled');
                sessionStorage.removeItem('admin-view-as-store');
                const showScopeNav = Boolean(data?.showScopeNav ?? data?.layoutCapabilities?.showScopeNav);
                sessionStorage.setItem('mic-overview-show-scope-nav', showScopeNav ? '1' : '0');
                if (showScopeNav) sessionStorage.removeItem('mic-last-store');
                localStorage.setItem('mic-area-picker-pending', '1');
            } catch {
                /* ignore */
            }
            window.location.replace(data.defaultPath || '/overview');
        } catch (err) {
            showError('Could not sign in. Check your connection.');
        }
    });
})();
