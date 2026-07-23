const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('coachApi', {
    listUsers: () => ipcRenderer.invoke('coach:listUsers'),
    login: (userId) => ipcRenderer.invoke('coach:login', userId),
    logout: () => ipcRenderer.invoke('coach:logout'),
    getActive: () => ipcRenderer.invoke('coach:getActive'),
    getCredentials: (userId) => ipcRenderer.invoke('coach:getCredentials', userId),
    listRegionStores: (userId) => ipcRenderer.invoke('coach:listRegionStores', userId),
    saveCredentials: (userId, payload) => ipcRenderer.invoke('coach:saveCredentials', userId, payload),
    getStoreEmails: () => ipcRenderer.invoke('coach:getStoreEmails'),
    setStoreEmails: (map) => ipcRenderer.invoke('coach:setStoreEmails', map),
    openTools: () => ipcRenderer.invoke('coach:openTools'),
    openAccount: () => ipcRenderer.invoke('coach:openAccount'),
    getStatus: () => ipcRenderer.invoke('coach:status'),
});
