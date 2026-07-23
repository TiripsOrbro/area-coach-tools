/**
 * Store picker modal for multi-store admins (overview + area dashboard).
 */
(function (global) {
    let backdrop = null;
    let escHandler = null;

    function ensureBackdrop() {
        if (backdrop) return backdrop;
        backdrop = document.createElement('div');
        backdrop.className = 'mic-item-picker admin-store-picker';
        backdrop.hidden = true;
        backdrop.innerHTML = `
            <div class="mic-item-picker-panel admin-store-picker-panel" role="dialog" aria-modal="true" aria-labelledby="admin-store-picker-title">
                <h2 id="admin-store-picker-title"></h2>
                <p class="admin-store-picker-hint" id="admin-store-picker-hint"></p>
                <div class="mic-item-list" id="admin-store-picker-list"></div>
                <button type="button" class="admin-store-picker-cancel">Cancel</button>
            </div>
        `;
        document.body.appendChild(backdrop);
        backdrop.addEventListener('click', (event) => {
            if (event.target === backdrop) close();
        });
        backdrop.querySelector('.admin-store-picker-cancel')?.addEventListener('click', close);
        return backdrop;
    }

    function close() {
        if (!backdrop) return;
        backdrop.hidden = true;
        if (escHandler) {
            document.removeEventListener('keydown', escHandler);
            escHandler = null;
        }
    }

    function open({ title, hint, options, onPick }) {
        const root = ensureBackdrop();
        const list = Array.isArray(options) ? options.filter((o) => o && o.id) : [];
        if (!list.length) return false;

        root.querySelector('#admin-store-picker-title').textContent = title || 'Select store';
        const hintEl = root.querySelector('#admin-store-picker-hint');
        if (hint) {
            hintEl.textContent = hint;
            hintEl.hidden = false;
        } else {
            hintEl.textContent = '';
            hintEl.hidden = true;
        }

        const listEl = root.querySelector('#admin-store-picker-list');
        listEl.innerHTML = list
            .map((option) => {
                const label = String(option.label || option.id);
                const sub = option.sub ? `<span class="mic-item-option-points">${escapeHtml(option.sub)}</span>` : '';
                return `<button type="button" class="mic-item-option admin-store-picker-option" data-store-id="${escapeHtml(String(option.id))}">${escapeHtml(label)}${sub}</button>`;
            })
            .join('');

        listEl.querySelectorAll('.admin-store-picker-option').forEach((btn) => {
            btn.addEventListener('click', () => {
                const id = btn.getAttribute('data-store-id');
                const option = list.find((o) => String(o.id) === String(id));
                if (!option) return;
                close();
                onPick?.(id, option);
            });
        });

        root.hidden = false;
        listEl.querySelector('button')?.focus();

        escHandler = (event) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                close();
            }
        };
        document.addEventListener('keydown', escHandler);
        return true;
    }

    function escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    global.AdminStorePicker = { open, close };
})(window);
