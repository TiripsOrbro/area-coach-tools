const { ipcRenderer } = require('electron');

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('closeBtn')?.addEventListener('click', () => {
        ipcRenderer.send('update-splash-close');
    });
});
