(function () {
    const ARROW_SVG = `<svg class="nav-back-icon" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
        <path fill="currentColor" d="M15.41 7.41 14 6l-6 6 6 6 1.41-1.41L10.83 12z"/>
    </svg>`;

    function resolveFloatingHost(host) {
        if (!host.id) {
            if (host.parentElement !== document.body) {
                document.body.insertBefore(host, document.body.firstChild);
            }
            return host;
        }
        let resolved = document.getElementById(host.id);
        if (!resolved) {
            resolved = host;
        } else if (resolved !== host) {
            host.remove();
        }
        if (resolved.parentElement !== document.body) {
            document.body.insertBefore(resolved, document.body.firstChild);
        }
        return resolved;
    }

    function mountBackButton(host, options = {}) {
        if (!host) return;
        const fallback = options.fallback || '/login';
        const ariaLabel = String(options.label || 'Back').replace(/^←\s*/, '').trim() || 'Back';
        if (!options.embedded) {
            host = resolveFloatingHost(host);
        }
        host.classList.add('nav-back-host');
        if (options.embedded) {
            host.classList.add('nav-back-host--embedded');
            host.classList.remove('nav-back-host--floating');
        } else {
            host.classList.add('nav-back-host--floating');
            host.classList.remove('nav-back-host--embedded');
        }
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'nav-back-bubble';
        btn.id = 'nav-back-btn';
        btn.setAttribute('aria-label', ariaLabel);
        btn.innerHTML = ARROW_SVG;
        host.replaceChildren(btn);
        btn.addEventListener('click', () => {
            const dest = String(fallback).trim() || '/login';
            const alwaysFallback = Boolean(options.alwaysFallback);
            const fadeToStores = Boolean(options.fadeToStores);
            const useFade =
                Boolean(options.fade) || fadeToStores || dest === '/overview' || dest === '/MIC/Overview' || dest === '/Admin/Overview' || dest === '/admin/overview';

            if (alwaysFallback || useFade) {
                if (useFade && window.DashboardPageTransition?.navigateBackToStores) {
                    window.DashboardPageTransition.navigateBackToStores(dest);
                    return;
                }
                window.location.href = dest;
                return;
            }

            if (window.history.length > 1) {
                window.history.back();
                return;
            }
            window.location.href = dest;
        });
    }

    window.DashboardNavBack = { mountBackButton };
})();
