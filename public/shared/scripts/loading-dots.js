/**
 * Three-dot loading indicator — pulsing purple dots in a wave.
 */
(function loadingDotsModule(global) {
    function escapeAttr(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/</g, '&lt;');
    }

    function html({ label = 'Loading', size = 'lg', className = '' } = {}) {
        const extra = className ? ` ${className}` : '';
        const aria = label ? ` role="status" aria-label="${escapeAttr(label)}"` : ' aria-hidden="true"';
        return `<div class="loading-dots loading-dots--${size}${extra}"${aria}>
            <span class="loading-dots__dot" aria-hidden="true"></span>
            <span class="loading-dots__dot" aria-hidden="true"></span>
            <span class="loading-dots__dot" aria-hidden="true"></span>
        </div>`;
    }

    function inlineDots(size = 'md', className = '') {
        const extra = className ? ` ${className}` : '';
        return `<div class="loading-dots loading-dots--${size}${extra}" aria-hidden="true">
            <span class="loading-dots__dot" aria-hidden="true"></span>
            <span class="loading-dots__dot" aria-hidden="true"></span>
            <span class="loading-dots__dot" aria-hidden="true"></span>
        </div>`;
    }

    function tileBody({
        message = 'Waiting for sales data',
        animated = true,
        extraClass = '',
        busyLabel = 'Loading sales data',
    } = {}) {
        const wrapClass = extraClass ? `mic-sales-tile-loading ${extraClass}` : 'mic-sales-tile-loading';
        if (!animated) {
            return `<div class="${wrapClass}" role="status" aria-live="polite">
                <p class="mic-sales-tile-loading__message">${escapeAttr(message)}</p>
            </div>`;
        }
        const dots =
            html({ label: '', size: 'md', className: 'mic-sales-tile-loading__dots' }) ||
            inlineDots('md', 'mic-sales-tile-loading__dots');
        return `<div class="${wrapClass}" role="status" aria-live="polite" aria-busy="true" aria-label="${escapeAttr(busyLabel)}">
            ${dots}
            <p class="mic-sales-tile-loading__message">${escapeAttr(message)}</p>
        </div>`;
    }

    global.LoadingDots = { html, inlineDots, tileBody };
})(typeof window !== 'undefined' ? window : globalThis);
