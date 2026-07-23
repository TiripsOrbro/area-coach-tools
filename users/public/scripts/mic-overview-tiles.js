/**
 * Shared MIC overview tile renderers and formatting helpers.
 */
(function micOverviewTilesModule(global) {
    const SMG_REPORTING_URL = 'https://reporting.smg.com/Index.aspx';
    const VOC_PLACEHOLDER = { count: 'TBD', osatPercent: null, accuracyPercent: null };

    const shell = () => global.MicOverviewShell;

    function escapeHtml(value) {
        return shell()?.escapeHtml?.(value) ?? String(value ?? '');
    }

    function formatMoney(value) {
        const n = Number(value) || 0;
        return `$${n.toLocaleString('en-AU')}`;
    }

    function formatVocDisplay(voc = {}) {
        if (voc.placeholder) {
            return { placeholder: true, count: 'TBD', osat: null, acc: null };
        }
        return {
            count: voc.count == null ? '-' : voc.count,
            osat: voc.osatPercent,
            acc: voc.accuracyPercent,
        };
    }

    function formatSssgDisplay(value) {
        if (value == null || Number.isNaN(Number(value))) {
            return { text: '-', toneClass: 'mic-sssg--na' };
        }
        const n = Number(value);
        const sign = n > 0 ? '+' : '';
        const toneClass = n > 0 ? 'mic-sssg--up' : n < 0 ? 'mic-sssg--down' : 'mic-sssg--na';
        return { text: `${sign}${n}%`, toneClass };
    }

    function renderMicTabPanel(tabId, content) {
        return shell()?.renderMicTabPanel?.(tabId, content) ?? content;
    }

    function renderVocTile(vocRaw, { tabbed = false, wide = false, inRow = false } = {}) {
        const voc = typeof vocRaw?.count !== 'undefined' && !vocRaw?.osatPercent && vocRaw?.placeholder == null
            ? formatVocDisplay(vocRaw)
            : vocRaw?.placeholder != null || vocRaw?.osat != null
              ? vocRaw
              : formatVocDisplay(vocRaw);
        const posClass =
            tabbed || inRow ? '' : ` mic-tile--pos-voc${wide ? ' mic-tile--pos-voc-wide' : ''}`;
        const osatText = voc.placeholder ? 'TBD%' : voc.osat == null ? '-' : `${voc.osat}%`;
        const accText = voc.placeholder ? 'TBD%' : voc.acc == null ? '-' : `${voc.acc}%`;
        return `
        <a class="mic-tile mic-tile--link mic-tile--voc mic-tile--metric-card${posClass}" href="${SMG_REPORTING_URL}" target="_blank" rel="noopener noreferrer" aria-label="VOC - open SMG reporting">
            <div class="mic-tile-body mic-metric-card">
                <div class="mic-metric-card__head">
                    <div class="mic-tile-label">VOC</div>
                </div>
                <div class="mic-voc-grid">
                    <div class="mic-voc-count">${voc.count}</div>
                    <div class="mic-voc-metrics">
                        <span class="mic-voc-metric">OSAT ${osatText}</span>
                        <span class="mic-voc-metric">Acc ${accText}</span>
                    </div>
                </div>
                <div class="mic-tile-sub mic-tile-sub--footnote">Pipeline coming soon</div>
            </div>
        </a>`;
    }

    function renderSssgTile(salesOrArea = {}, { tabbed = false, todayValue, wtdValue } = {}) {
        const today = formatSssgDisplay(
            todayValue != null ? todayValue : salesOrArea.sssgPercent ?? salesOrArea.sssgToday
        );
        const wtd = formatSssgDisplay(
            wtdValue != null ? wtdValue : salesOrArea.sssgWtdPercent ?? salesOrArea.sssgWtd
        );
        const hasData = today.text !== '-' || wtd.text !== '-';
        const futureClass = hasData ? '' : ' mic-tile--future';
        const posClass = tabbed ? '' : ' mic-tile--pos-sssg';
        return `
        <article class="mic-tile mic-tile--sssg mic-tile--metric-card${futureClass}${posClass}">
            <div class="mic-tile-body mic-metric-card">
                <div class="mic-metric-card__head">
                    <div class="mic-tile-label">Today SSSG</div>
                </div>
                <div class="mic-sssg-grid">
                    <div class="mic-sssg-value ${today.toneClass}">${escapeHtml(today.text)}</div>
                    <div class="mic-sssg-footer">
                        <span class="mic-sssg-wtd ${wtd.toneClass}">WTD ${escapeHtml(wtd.text)}</span>
                    </div>
                </div>
            </div>
        </article>`;
    }

    function renderBlankTile({ posClass = 'mic-tile--pos-blank' } = {}) {
        return `<article class="mic-tile mic-tile--blank ${posClass}" aria-hidden="true"></article>`;
    }

    function renderAdminLabelTile({ label, posClass, sub = 'Coming soon', tabbed = false, inRow = false, href = '' } = {}) {
        const subHtml = sub ? `<div class="mic-tile-sub">${escapeHtml(sub)}</div>` : '';
        const gridPosClass = tabbed || inRow ? '' : ` ${posClass}`;
        const body = `
            <div class="mic-tile-body">
                <div class="mic-tile-label">${escapeHtml(label)}</div>
                ${subHtml}
            </div>`;
        if (href) {
            return `<a class="mic-tile mic-tile--link${gridPosClass}" href="${escapeHtml(href)}" aria-label="${escapeHtml(`${label} - ${sub}`)}">${body}</a>`;
        }
        return `<article class="mic-tile${gridPosClass}">${body}</article>`;
    }

    function renderEqualWidthRow(tileHtmlList, { rowNum, tabbed = false, extraClass = '' } = {}) {
        const tiles = tileHtmlList.filter(Boolean);
        if (!tiles.length) return '';
        const colCount = tiles.length;
        if (tabbed) {
            return `<div class="mic-tab-tile-row mic-tab-tile-row--cols-${colCount}">${tiles.join('')}</div>`;
        }
        const rowClass = rowNum ? ` mic-grid-equal-row--row-${rowNum}` : '';
        return `<div class="mic-grid-equal-row mic-grid-equal-row--cols-${colCount}${rowClass}${extraClass ? ` ${extraClass}` : ''}">${tiles.join('')}</div>`;
    }

    function renderLoadingPlaceholderTile() {
        return `
        <article class="mic-tile mic-tile--loading mic-tile--loading-skeleton">
            <div class="mic-tile-body mic-tile-body--loading" aria-hidden="true"></div>
        </article>`;
    }

    function renderLoadingPlaceholderTiles(count) {
        return Array.from({ length: count }, () => renderLoadingPlaceholderTile()).join('');
    }

    global.MicOverviewTiles = {
        SMG_REPORTING_URL,
        VOC_PLACEHOLDER,
        formatMoney,
        formatVocDisplay,
        formatSssgDisplay,
        renderMicTabPanel,
        renderVocTile,
        renderSssgTile,
        renderBlankTile,
        renderAdminLabelTile,
        renderEqualWidthRow,
        renderLoadingPlaceholderTile,
        renderLoadingPlaceholderTiles,
    };
})(window);
