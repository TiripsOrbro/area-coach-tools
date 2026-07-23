const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopApi', {
    getSetupState: () => ipcRenderer.invoke('setup:get'),
    completeSetup: (payload) => ipcRenderer.invoke('setup:complete', payload),
    pickSecretsFolder: (defaultPath) => ipcRenderer.invoke('setup:pickSecretsFolder', defaultPath),
    suggestSecretsFolder: () => ipcRenderer.invoke('setup:suggestSecretsFolder'),
    getStatus: () => ipcRenderer.invoke('app:status'),
    setupCloudflare: () => ipcRenderer.invoke('cloudflare:setup'),
    getCloudflareStatus: () => ipcRenderer.invoke('cloudflare:status'),
    onSetupProgress: (cb) => {
        const handler = (_event, msg) => cb(msg);
        ipcRenderer.on('setup:progress', handler);
        return () => ipcRenderer.removeListener('setup:progress', handler);
    },
    subscribeLive: (cb) => {
        const handler = (_event, payload) => cb(payload);
        ipcRenderer.on('live:event', handler);
        return () => ipcRenderer.removeListener('live:event', handler);
    },
});
