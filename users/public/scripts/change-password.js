(function () {
    const form = document.getElementById('change-password-form');
    const policyEl = document.getElementById('password-policy');
    const introEl = document.getElementById('change-password-intro');
    const errorEl = document.getElementById('change-password-error');
    const submitBtn = document.getElementById('change-password-submit');
    const submitLabel = submitBtn?.querySelector('.login-submit-label');

    if (window.TbaBrandMark?.svg) {
        const host = document.getElementById('login-brand-mark');
        if (host) host.innerHTML = window.TbaBrandMark.svg('change-password-mark');
    }

    function showError(message) {
        if (errorEl) errorEl.textContent = message || '';
    }

    function setBusy(busy) {
        if (submitBtn) submitBtn.disabled = busy;
        if (submitLabel) submitLabel.textContent = busy ? 'Saving…' : 'Save password';
    }

    async function loadPolicy() {
        try {
            const res = await fetch('/api/me', { credentials: 'same-origin' });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.success) {
                window.location.replace('/login');
                return;
            }
            if (!data.mustChangePassword) {
                window.location.replace(data.defaultPath || '/');
                return;
            }
            if (data.mustCompleteMmxSetup) {
                window.location.replace('/mmx-setup');
                return;
            }
            const policy = data.passwordPolicy;
            if (policy?.label && policyEl) {
                policyEl.textContent = policy.label;
            }
            if (data.welcomeName && introEl) {
                introEl.textContent = `Hi ${data.welcomeName} - set a personal password before continuing.`;
            }
        } catch {
            showError('Could not load account details. Refresh and try again.');
        }
    }

    form?.addEventListener('submit', async (event) => {
        event.preventDefault();
        showError('');
        const currentPassword = document.getElementById('current-password')?.value || '';
        const newPassword = document.getElementById('new-password')?.value || '';
        const confirmPassword = document.getElementById('confirm-password')?.value || '';

        if (!currentPassword || !newPassword || !confirmPassword) {
            showError('Fill in all password fields.');
            return;
        }
        if (newPassword !== confirmPassword) {
            showError('New passwords do not match.');
            return;
        }

        setBusy(true);
        try {
            const res = await fetch('/api/account/complete-password-setup', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify({ currentPassword, newPassword, confirmPassword }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.success) {
                showError(data.error || 'Could not save password.');
                setBusy(false);
                return;
            }
            try {
                sessionStorage.removeItem('mic-overview-area');
                sessionStorage.removeItem('admin-view-as-store-enabled');
                sessionStorage.removeItem('admin-view-as-store');
                localStorage.setItem('mic-area-picker-pending', '1');
            } catch {
                /* ignore */
            }
            window.location.replace(data.defaultPath || '/');
        } catch {
            showError('Could not save password. Check your connection.');
            setBusy(false);
        }
    });

    loadPolicy();
})();
