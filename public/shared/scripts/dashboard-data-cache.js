/**
 * Persists last-known dashboard sales / MIC overview payloads in localStorage
 * so login and navigation can paint immediately while fresh data loads.
 */
(function dashboardDataCacheModule(global) {
    const VERSION = 1;
    const TIME_ZONE = 'Australia/Melbourne';
    const LAST_ADMIN_OVERVIEW_KEY = 'dashboard-last-admin-overview-key';

    function storageKey(kind, store) {
        const s = String(store || 'default').toLowerCase();
        return `dashboard-data-cache:v${VERSION}:${kind}:${s}`;
    }

    function businessDayKey(timestamp) {
        try {
            return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(new Date(timestamp));
        } catch {
            return new Date(timestamp).toDateString();
        }
    }

    function read(kind, store) {
        try {
            const raw = localStorage.getItem(storageKey(kind, store));
            if (!raw) return null;
            const entry = JSON.parse(raw);
            if (!entry?.data || !entry.savedAt) return null;
            // Sales figures reset each trading day, so an entry saved on a
            // previous day would flash stale numbers before the live fetch
            // wipes them. Only restore same-day data, but keep the stored
            // entry around in case it's needed (it gets overwritten by the
            // next meaningful payload anyway).
            if (businessDayKey(entry.savedAt) !== businessDayKey(Date.now())) {
                return null;
            }
            return entry;
        } catch {
            return null;
        }
    }

    function write(kind, store, data) {
        if (!data) return;
        try {
            localStorage.setItem(
                storageKey(kind, store),
                JSON.stringify({
                    savedAt: Date.now(),
                    data,
                })
            );
        } catch {
            /* quota or private mode */
        }
    }

    function sumHourly(arr) {
        return Array.isArray(arr) ? arr.reduce((sum, v) => sum + (Number(v) || 0), 0) : 0;
    }

    function hasMeaningfulSalesSlice(slice) {
        if (!slice || slice.success === false) return false;
        return sumHourly(slice.actual) > 0 || sumHourly(slice.forecast) > 0;
    }

    function hasMeaningfulMicOverview(data) {
        if (!data || data.success === false) return false;
        const sales = data.salesToday || {};
        if (Number(sales.actual) > 0 || Number(sales.forecast) > 0) return true;
        if (sumHourly(sales.actualHourly) > 0 || sumHourly(sales.forecastHourly) > 0) return true;
        const resolved = global.MicMiniDashboard?.resolveHourly?.(sales);
        if (resolved) {
            return sumHourly(resolved.actuals) > 0 || sumHourly(resolved.forecasts) > 0;
        }
        return sumHourly(sales.rawActual) > 0 || sumHourly(sales.rawForecast) > 0;
    }

    function hasMeaningfulAdminOverview(data) {
        if (!data || data.success === false || data.placeholder) return false;
        for (const area of data.areas || []) {
            const sales = area.salesToday || {};
            if (Number(sales.actual) > 0 || Number(sales.forecast) > 0) return true;
            for (const store of area.storeSales || []) {
                if (Number(store.actual) > 0 || Number(store.forecast) > 0) return true;
            }
        }
        return false;
    }

    function staleAgeSeconds(entry) {
        if (!entry?.savedAt) return 0;
        return Math.round((Date.now() - entry.savedAt) / 1000);
    }

    function rememberAdminOverviewKey(scopeKey) {
        const key = String(scopeKey || '').trim();
        if (!key) return;
        try {
            sessionStorage.setItem(LAST_ADMIN_OVERVIEW_KEY, key);
        } catch {
            /* ignore */
        }
    }

    function readAdminOverviewByLastKey() {
        try {
            const key = sessionStorage.getItem(LAST_ADMIN_OVERVIEW_KEY);
            if (!key) return null;
            return read('overview-admin', key);
        } catch {
            return null;
        }
    }

    global.DashboardDataCache = {
        readSales: (store) => read('sales', store),
        writeSales: (store, data) => {
            if (hasMeaningfulSalesSlice(data)) write('sales', store, data);
        },
        readOverview: (store) => read('overview', store),
        writeOverview: (store, data) => {
            if (hasMeaningfulMicOverview(data)) write('overview', store, data);
        },
        readAdminOverview: (scopeKey) => read('overview-admin', scopeKey),
        writeAdminOverview: (scopeKey, data) => {
            if (hasMeaningfulAdminOverview(data)) write('overview-admin', scopeKey, data);
        },
        rememberAdminOverviewKey,
        readAdminOverviewByLastKey,
        hasMeaningfulSalesSlice,
        hasMeaningfulMicOverview,
        hasMeaningfulAdminOverview,
        staleAgeSeconds,
    };
})(typeof window !== 'undefined' ? window : globalThis);
