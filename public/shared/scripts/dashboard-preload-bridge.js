/**
 * Signals the login page when a dashboard route loaded in #dashboard-preload is usable.
 */
(function dashboardPreloadBridgeModule(global) {
    const MESSAGE_TYPE = 'dashboard-preload-ready';

    function isLoginPreloadFrame() {
        try {
            return global.parent !== global && global.frameElement?.id === 'dashboard-preload';
        } catch {
            return false;
        }
    }

    function signalReady(phase) {
        if (!isLoginPreloadFrame()) return;
        try {
            global.parent.postMessage(
                { type: MESSAGE_TYPE, phase: String(phase || 'content') },
                global.location.origin
            );
        } catch {
            /* ignore */
        }
    }

    global.DashboardPreloadBridge = {
        signalReady,
        isLoginPreloadFrame,
    };
})(typeof window !== 'undefined' ? window : globalThis);
