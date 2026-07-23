(function () {
    const form = document.getElementById('mmx-setup-form');
    const introEl = document.getElementById('mmx-setup-intro');
    const errorEl = document.getElementById('mmx-setup-error');
    const statusEl = document.getElementById('mmx-setup-status');
    const submitBtn = document.getElementById('mmx-setup-submit');
    const submitLabel = submitBtn?.querySelector('.login-submit-label');

    if (window.TbaBrandMark?.svg) {
        const host = document.getElementById('login-brand-mark');
        if (host) host.innerHTML = window.TbaBrandMark.svg('mmx-setup-mark');
    }

    function showError(message) {
        if (errorEl) errorEl.textContent = message || '';
    }

    function setBusy(busy) {
        if (submitBtn) submitBtn.disabled = busy;
        if (submitLabel) submitLabel.textContent = busy ? 'Verifying MMX…' : 'Verify and continue';
        if (statusEl) {
            statusEl.hidden = !busy;
            statusEl.textContent = busy
                ? 'Testing Macromatix login - this may take up to a minute.'
                : '';
        }
    }

    async function loadProfile() {
        try {
            const res = await fetch('/api/me', { credentials: 'same-origin' });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.success) {
                window.location.replace('/login');
                return;
            }
            if (!data.mustCompleteMmxSetup) {
                window.location.replace(data.defaultPath || '/');
                return;
            }
            if (data.welcomeName && introEl) {
                introEl.textContent = `Hi ${data.welcomeName} - link your Macromatix login before continuing.`;
            }
        } catch {
            showError('Could not load account details. Refresh and try again.');
        }
    }

    form?.addEventListener('submit', async (event) => {
        event.preventDefault();
        showError('');
        const firstName = document.getElementById('mmx-first-name')?.value.trim() || '';
        const lastName = document.getElementById('mmx-last-name')?.value.trim() || '';
        const mmxUsername = document.getElementById('mmx-username')?.value.trim() || '';
        const mmxPassword = document.getElementById('mmx-password')?.value || '';

        if (!firstName || !lastName || !mmxUsername || !mmxPassword) {
            showError('Fill in all fields.');
            return;
        }

        setBusy(true);
        try {
            const res = await fetch('/api/account/complete-mmx-setup', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify({ firstName, lastName, mmxUsername, mmxPassword }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.success) {
                showError(data.error || 'Macromatix verification failed.');
                setBusy(false);
                return;
            }
            window.location.replace(data.defaultPath || '/change-password');
        } catch {
            showError('Could not reach the server. Try again.');
            setBusy(false);
        }
    });

    loadProfile();
})();
