(function (global) {
    const LEVEL_LABELS = {
        market: 'Market',
        area: 'Area',
        manager: 'Manager',
        mic: 'MIC',
        tm: 'TM',
    };

    const SCOPE_FIELDS = [
        { name: 'accountLevel', label: 'Access level' },
        { name: 'market', label: 'Market' },
        { name: 'area', label: 'Area' },
        { name: 'storeNumber', label: 'Store' },
    ];

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
        let area = selections.area || '';
        let storeNumber = selections.storeNumber || '';
        const areas = areasForTree(tree, selections.market);

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

        const markets = treeMarkets(tree);
        let market = '';
        if (levelNeedsMarket(level)) {
            market =
                selections.market ||
                tree.defaults?.market ||
                (markets.length === 1 ? markets[0] : '');
        }
        return { market, area, storeNumber };
    }

    function fieldClass(theme) {
        return theme === 'admin' ? 'admin-accounts-field' : 'login-field';
    }

    function getSelect(formRoot, name) {
        return formRoot.querySelector(`select[name="${name}"]`);
    }

    function getFieldWrap(formRoot, name) {
        return formRoot.querySelector(`[data-create-field="${name}"]`);
    }

    function setSelectOptions(select, rows, selectedValue, getValue, getLabel) {
        if (!select) return;
        const labelFn = getLabel || getValue;
        const placeholder = select.dataset.placeholder || 'Choose…';
        const options = rows.map((row) => {
            const value = getValue(row);
            const selected = String(value) === String(selectedValue) ? ' selected' : '';
            return `<option value="${escapeAttr(value)}"${selected}>${escapeHtml(labelFn(row))}</option>`;
        });
        if (rows.length > 1) {
            const hasSelected = rows.some((row) => String(getValue(row)) === String(selectedValue));
            const placeholderSelected = selectedValue || !hasSelected ? '' : ' selected';
            select.innerHTML = `<option value="" disabled${placeholderSelected}>${escapeHtml(placeholder)}</option>${options.join('')}`;
        } else {
            select.innerHTML = options.join('');
        }
        if (selectedValue) select.value = String(selectedValue);
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

    function readSelectValue(formRoot, name) {
        const select = getSelect(formRoot, name);
        if (!select) return '';
        return String(select.value || '').trim();
    }

    function mountCreateAccountForm(container, { theme = 'login', createOptions = null, defaultStore = '' } = {}) {
        if (!container) return null;
        const cls = fieldClass(theme);
        container.innerHTML = SCOPE_FIELDS.map(
            (field) => `
            <label class="${cls} create-account-scope-field" data-create-field="${field.name}" hidden>
                ${field.label}
                <select name="${field.name}" aria-label="${field.label}"></select>
                <span class="create-account-field-error" role="alert" hidden></span>
            </label>
        `
        ).join('');

        const formRoot = container;
        const tree = createOptions?.scopeTree;
        if (tree?.defaults && defaultStore) {
            tree.defaults.storeNumber =
                String(defaultStore || tree.defaults.storeNumber || createOptions.defaultStore || '').trim() ||
                tree.defaults.storeNumber;
        }

        const onChange = () => syncScopeSelects(formRoot, createOptions);
        container.querySelectorAll('select').forEach((select) => {
            select.addEventListener('change', onChange);
        });

        if (createOptions) {
            syncScopeSelects(formRoot, createOptions);
        }

        return { formRoot, onChange };
    }

    function syncScopeSelects(formRoot, createOptions) {
        if (!formRoot || !createOptions) return;

        const tree = createOptions.scopeTree;
        if (!tree) return;

        const levels = createOptions.levelChoices?.length
            ? createOptions.levelChoices
            : (createOptions.assignableLevels || []).map((row) => (typeof row === 'string' ? row : row.value));

        const levelSelect = getSelect(formRoot, 'accountLevel');
        const currentLevel = readSelectValue(formRoot, 'accountLevel');
        const defaultLevel =
            (currentLevel && levels.includes(currentLevel) && currentLevel) ||
            levels.find((level) => level === 'manager') ||
            levels.find((level) => level === 'mic') ||
            levels[0] ||
            '';

        if (levelSelect) {
            setSelectOptions(
                levelSelect,
                levels.map((value) => value),
                defaultLevel,
                (row) => row,
                (row) => LEVEL_LABELS[row] || row
            );
            levelSelect.disabled = levels.length <= 1;
        }

        const levelWrap = getFieldWrap(formRoot, 'accountLevel');
        if (levelWrap) levelWrap.hidden = !levels.length;

        const level = defaultLevel;
        const selections = resolveScopeSelections(level, tree, {
            market: readSelectValue(formRoot, 'market'),
            area: readSelectValue(formRoot, 'area'),
            storeNumber: readSelectValue(formRoot, 'storeNumber'),
        });

        const markets = treeMarkets(tree);
        const marketSelect = getSelect(formRoot, 'market');
        const marketWrap = getFieldWrap(formRoot, 'market');
        if (levelNeedsMarket(level) && markets.length) {
            setSelectOptions(marketSelect, markets, selections.market, (row) => row);
            marketSelect.disabled = markets.length <= 1;
            if (marketWrap) marketWrap.hidden = false;
        } else if (marketWrap) {
            marketWrap.hidden = true;
            if (marketSelect) marketSelect.innerHTML = '';
        }

        const areas = areasForTree(tree, selections.market);
        const areaSelect = getSelect(formRoot, 'area');
        const areaWrap = getFieldWrap(formRoot, 'area');
        if (levelNeedsArea(level) && areas.length) {
            setSelectOptions(
                areaSelect,
                areas,
                selections.area,
                (row) => row,
                (row) => window.AreaDisplay?.label?.(row) ?? String(row).replace(/-1$/i, '')
            );
            areaSelect.disabled = areas.length <= 1;
            if (areaWrap) areaWrap.hidden = false;
        } else if (areaWrap) {
            areaWrap.hidden = true;
            if (areaSelect) areaSelect.innerHTML = '';
        }

        const stores = selections.area ? tree.storesByArea[selections.area] || [] : [];
        const storeSelect = getSelect(formRoot, 'storeNumber');
        const storeWrap = getFieldWrap(formRoot, 'storeNumber');
        if (levelNeedsStore(level) && stores.length) {
            setSelectOptions(
                storeSelect,
                stores,
                selections.storeNumber,
                (row) => row.storeNumber,
                (row) => row.storeNumber
            );
            storeSelect.disabled = stores.length <= 1;
            if (storeWrap) storeWrap.hidden = false;
        } else if (storeWrap) {
            storeWrap.hidden = true;
            if (storeSelect) storeSelect.innerHTML = '';
        }
    }

    function setLoading(formRoot, loading) {
        if (!formRoot) return;
        if (!loading) return;
        formRoot.querySelectorAll('select').forEach((select) => {
            select.disabled = true;
        });
        const levelSelect = getSelect(formRoot, 'accountLevel');
        if (levelSelect && !levelSelect.options.length) {
            levelSelect.innerHTML = '<option value="" disabled selected>Loading…</option>';
        }
    }

    function readCreateAccountForm(formRoot, createOptions, { fallbackStore = '' } = {}) {
        const level = readSelectValue(formRoot, 'accountLevel');
        const tree = createOptions?.scopeTree;
        const resolved = tree
            ? resolveScopeSelections(level, tree, {
                  market: readSelectValue(formRoot, 'market'),
                  area: readSelectValue(formRoot, 'area'),
                  storeNumber: readSelectValue(formRoot, 'storeNumber'),
              })
            : { market: '', area: '', storeNumber: '' };

        return {
            accountLevel: level,
            market: resolved.market,
            area: resolved.area,
            storeNumber: resolved.storeNumber || String(fallbackStore || '').trim(),
        };
    }

    function clearFieldErrors(scopeRoot, extraFields = []) {
        const roots = [scopeRoot, ...extraFields.map((el) => el?.closest?.('label') || el?.parentElement)].filter(Boolean);
        roots.forEach((root) => {
            root.querySelectorAll('.create-account-field-error').forEach((el) => {
                el.textContent = '';
                el.hidden = true;
            });
            root.querySelectorAll('.is-field-invalid').forEach((el) => el.classList.remove('is-field-invalid'));
        });
    }

    function showFieldError(formRoot, fieldName, message, extraFieldEl) {
        let wrap = getFieldWrap(formRoot, fieldName);
        if (!wrap && extraFieldEl) wrap = extraFieldEl.closest('label') || extraFieldEl.parentElement;
        if (!wrap) return;
        const errorEl = wrap.querySelector('.create-account-field-error');
        const control = wrap.querySelector('select, input, textarea');
        if (control) control.classList.add('is-field-invalid');
        if (errorEl) {
            errorEl.textContent = message;
            errorEl.hidden = !message;
        }
    }

    function validateCreateAccountForm(formRoot, createOptions, { usernameEl, fallbackStore = '' } = {}) {
        const errors = [];
        const values = readCreateAccountForm(formRoot, createOptions, { fallbackStore });
        const username = String(usernameEl?.value || '').trim();

        clearFieldErrors(formRoot, usernameEl ? [usernameEl] : []);

        if (!values.accountLevel) {
            showFieldError(formRoot, 'accountLevel', 'Choose an access level.');
            errors.push({ field: 'accountLevel', message: 'Choose an access level.' });
        }
        const markets = treeMarkets(createOptions?.scopeTree);
        if (levelNeedsMarket(values.accountLevel) && markets.length && !values.market) {
            showFieldError(formRoot, 'market', 'Choose a market.');
            errors.push({ field: 'market', message: 'Choose a market.' });
        }
        if (levelNeedsArea(values.accountLevel) && !values.area) {
            showFieldError(formRoot, 'area', 'Choose an area.');
            errors.push({ field: 'area', message: 'Choose an area.' });
        }
        if (levelNeedsStore(values.accountLevel) && !values.storeNumber) {
            showFieldError(formRoot, 'storeNumber', 'Choose a store.');
            errors.push({ field: 'storeNumber', message: 'Choose a store.' });
        }
        if (usernameEl && !username) {
            showFieldError(formRoot, null, 'Enter a username.', usernameEl);
            errors.push({ field: 'username', message: 'Enter a username.' });
        }

        return {
            ok: !errors.length,
            errors,
            values: { ...values, username },
        };
    }

    global.CreateAccountForm = {
        LEVEL_LABELS,
        levelNeedsMarket,
        levelNeedsArea,
        levelNeedsStore,
        resolveScopeSelections,
        mountCreateAccountForm,
        syncScopeSelects,
        setLoading,
        readCreateAccountForm,
        validateCreateAccountForm,
        clearFieldErrors,
        showFieldError,
    };
})(window);
