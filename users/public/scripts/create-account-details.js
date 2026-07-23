(function () {
    const form = document.getElementById('create-account-form');
    const errorEl = document.getElementById('create-details-error');
    const statusEl = document.getElementById('create-details-status');
    const submitBtn = document.getElementById('create-account-submit');
    const successWrapEl = document.getElementById('create-details-success');
    const tempPasswordEl = document.getElementById('create-temp-password');
    const nextStepsEl = document.getElementById('create-details-next-steps');
    const levelGroup = document.getElementById('new-account-level-group');
    const scopeStack = document.getElementById('create-scope-stack');

    let createOptions = null;

    const LEVEL_LABELS = {
        market: 'Market',
        area: 'Area',
        manager: 'Manager',
        mic: 'MIC',
        tm: 'TM',
    };

    if (window.DashboardNavBack) {
        window.DashboardNavBack.mountBackButton(document.getElementById('create-details-back'), {
            fallback: '/Create-Account',
        });
    }

    if (window.TbaBrandMark?.svg) {
        const host = document.getElementById('login-brand-mark');
        if (host) host.innerHTML = window.TbaBrandMark.svg('create-account-details-mark');
    }

    function escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function escapeAttr(value) {
        return escapeHtml(value);
    }

    function selectedRadioValue(name) {
        return document.querySelector(`input[type="radio"][name="${name}"]:checked`)?.value || '';
    }

    function levelNeedsMarket(level) {
        return ['market', 'area', 'manager', 'mic', 'tm'].includes(level);
    }

    function levelNeedsArea(level) {
        return ['area', 'manager', 'mic', 'tm'].includes(level);
    }

    function levelNeedsStore(level) {
        return ['manager', 'mic', 'tm'].includes(level);
    }

    function treeMarkets(tree) {
        return Array.isArray(tree?.markets) ? tree.markets : [];
    }

    function areasForTree(tree, market) {
        const markets = treeMarkets(tree);
        if (markets.length && tree.areasByMarket) {
            return market ? tree.areasByMarket[market] || [] : [];
        }
        return tree.areas || Object.keys(tree.storesByArea || {});
    }

    function resolveScopeSelections(level, tree, selections = {}) {
        let market = selections.market || '';
        let area = selections.area || '';
        let storeNumber = selections.storeNumber || '';
        const markets = treeMarkets(tree);

        if (levelNeedsMarket(level)) {
            if (!market && markets.length === 1) market = markets[0];
            if (!market && tree.defaults?.market) market = tree.defaults.market;
        } else {
            market = '';
        }

        const areas = areasForTree(tree, market);
        if (levelNeedsArea(level)) {
            if (area && !areas.includes(area)) area = '';
            if (!area && areas.length === 1) area = areas[0];
            if (!area && tree.defaults?.area && areas.includes(tree.defaults.area)) area = tree.defaults.area;
        } else {
            area = '';
        }

        const stores = area ? tree.storesByArea[area] || [] : [];
        if (levelNeedsStore(level)) {
            if (storeNumber && !stores.some((row) => row.storeNumber === storeNumber)) storeNumber = '';
            if (!storeNumber && stores.length === 1) storeNumber = stores[0].storeNumber;
            if (
                !storeNumber &&
                tree.defaults?.storeNumber &&
                stores.some((row) => row.storeNumber === tree.defaults.storeNumber)
            ) {
                storeNumber = tree.defaults.storeNumber;
            }
        } else {
            storeNumber = '';
        }

        return { market, area, storeNumber };
    }

    function renderScopeSection(name, label, rows, selectedValue, getValue, getLabel) {
        const labelFn = getLabel || getValue;
        const items = rows
            .map((row, index) => {
                const value = getValue(row);
                const id = `${name}-${index}`;
                const checked = String(value) === String(selectedValue) ? ' checked' : '';
                return `
                    <label class="login-choice" for="${escapeAttr(id)}">
                        <input type="radio" id="${escapeAttr(id)}" name="${escapeAttr(name)}" value="${escapeAttr(value)}"${checked}>
                        <span>${escapeHtml(labelFn(row))}</span>
                    </label>
                `;
            })
            .join('');
        return `
            <div class="login-field create-scope-section">
                <span class="login-choice-legend">${escapeHtml(label)}</span>
                <div class="login-choice-group" role="radiogroup" aria-label="${escapeAttr(label)}">${items}</div>
            </div>
        `;
    }

    function renderLevelBar(container, levels, selected = '') {
        if (!container) return;
        if (!levels.length) {
            container.innerHTML = '<p class="login-choice-empty">No account levels available.</p>';
            return;
        }
        const pick = selected && levels.includes(selected) ? selected : levels[0];
        container.innerHTML = levels
            .map((value) => {
                const id = `accountLevel-${value}`;
                const checked = value === pick ? ' checked' : '';
                return `
                    <label class="login-choice login-choice--level" for="${escapeAttr(id)}">
                        <input type="radio" id="${escapeAttr(id)}" name="accountLevel" value="${escapeAttr(value)}"${checked}>
                        <span>${escapeHtml(LEVEL_LABELS[value] || value)}</span>
                    </label>
                `;
            })
            .join('');
    }

    function renderScopeStack(level) {
        const tree = createOptions?.scopeTree;
        if (!scopeStack || !tree || !level) {
            if (scopeStack) scopeStack.innerHTML = '';
            return;
        }

        const selections = resolveScopeSelections(level, tree, {
            market: selectedRadioValue('market'),
            area: selectedRadioValue('area'),
            storeNumber: selectedRadioValue('storeNumber'),
        });

        const sections = [];
        const markets = treeMarkets(tree);
        if (levelNeedsMarket(level) && markets.length > 1) {
            sections.push(renderScopeSection('market', 'Market', markets, selections.market, (row) => row));
        }
        const areas = areasForTree(tree, selections.market);
        if (levelNeedsArea(level) && areas.length > 1) {
            sections.push(renderScopeSection('area', 'Area', areas, selections.area, (row) => row));
        }
        const stores = selections.area ? tree.storesByArea[selections.area] || [] : [];
        if (levelNeedsStore(level) && stores.length > 1) {
            sections.push(
                renderScopeSection(
                    'storeNumber',
                    'Store',
                    stores,
                    selections.storeNumber,
                    (row) => row.storeNumber,
                    (row) => row.storeNumber
                )
            );
        }
        scopeStack.innerHTML = sections.join('');
    }

    function syncCreateScopeUI() {
        if (!createOptions) return;
        renderScopeStack(selectedRadioValue('accountLevel'));
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
        form.querySelectorAll('input, button[type="submit"]').forEach((el) => {
            if (el !== submitBtn) el.disabled = true;
        });
    }

    async function loadCreateOptions() {
        if (levelGroup) levelGroup.innerHTML = '<p class="login-choice-empty">Loading access levels…</p>';
        const res = await fetch('/api/account/create-options', { credentials: 'include' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) {
            throw new Error(data.error || 'Could not load account options.');
        }
        createOptions = data;
        const levels = data.levelChoices?.length
            ? data.levelChoices
            : (data.assignableLevels || []).map((row) => row.value);
        renderLevelBar(levelGroup, levels);
        syncCreateScopeUI();
    }

    levelGroup?.addEventListener('change', syncCreateScopeUI);
    scopeStack?.addEventListener('change', syncCreateScopeUI);

    form?.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (submitBtn?.type === 'button') return;
        errorEl.textContent = '';
        statusEl.hidden = true;

        const level = selectedRadioValue('accountLevel');
        const username = document.getElementById('new-username').value.trim();
        const tree = createOptions?.scopeTree;
        const resolved = tree
            ? resolveScopeSelections(level, tree, {
                  market: selectedRadioValue('market'),
                  area: selectedRadioValue('area'),
                  storeNumber: selectedRadioValue('storeNumber'),
              })
            : { market: '', area: '', storeNumber: '' };

        if (!username) {
            errorEl.textContent = 'Enter a username.';
            return;
        }
        if (!level) {
            errorEl.textContent = 'Choose an access level.';
            return;
        }
        if (levelNeedsMarket(level) && !resolved.market) {
            errorEl.textContent = 'Choose a market.';
            return;
        }
        if (levelNeedsArea(level) && !resolved.area) {
            errorEl.textContent = 'Choose an area.';
            return;
        }
        if (levelNeedsStore(level) && !resolved.storeNumber) {
            errorEl.textContent = 'Choose a store.';
            return;
        }

        submitBtn.disabled = true;
        submitBtn.textContent = 'Creating…';

        try {
            const res = await fetch('/api/account/create', {
                method: 'POST',
                headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({
                    username,
                    accountLevel: level,
                    storeNumber: resolved.storeNumber,
                    market: resolved.market,
                    area: resolved.area,
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

    loadCreateOptions().catch((error) => {
        errorEl.textContent = error.message || 'Could not load create-account options.';
    });
})();
