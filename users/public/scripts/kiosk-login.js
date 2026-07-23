(function () {
    const form = document.getElementById('kiosk-login-form');
    const errorEl = document.getElementById('kiosk-login-error');

    if (window.DashboardNavBack) {
        window.DashboardNavBack.mountBackButton(document.getElementById('kiosk-login-back'), {
            fallback: '/login',
        });
    }

    if (window.TbaBrandMark?.svg) {
        const host = document.getElementById('login-brand-mark');
        if (host) host.innerHTML = window.TbaBrandMark.svg('kiosk-login-mark');
    }

    const params = new URLSearchParams(window.location.search);
    if (params.get('error') === 'invalid') {
        errorEl.textContent = 'Incorrect username or password.';
    }

    form?.addEventListener('submit', async (event) => {
        event.preventDefault();
        errorEl.textContent = '';
        const username = document.getElementById('kiosk-username').value.trim();
        const password = document.getElementById('kiosk-password').value;
        const remember = document.getElementById('kiosk-remember').checked;
        try {
            const res = await fetch('/kiosk/login', {
                method: 'POST',
                headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ username, password, remember }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.success) {
                errorEl.textContent = data.error || 'Sign in failed.';
                return;
            }
            if (data.mustChangePassword) {
                window.location.replace('/change-password');
                return;
            }
            try {
                sessionStorage.setItem('dashboard-entry', 'kiosk');
            } catch (_) {
                /* ignore */
            }
            window.location.replace(data.defaultPath || '/');
        } catch (_) {
            errorEl.textContent = 'Could not sign in.';
        }
    });
})();
