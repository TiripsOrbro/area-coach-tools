const path = require('path');
const { app } = require('electron');

let serverInstance = null;
let listenPort = 3100;

function serverRoot() {
    if (app.isPackaged) {
        return path.join(process.resourcesPath, 'server');
    }
    return path.join(__dirname, '..', '..');
}

function ensureProjectRootEnv() {
    const root = serverRoot();
    process.env.PROJECT_ROOT = root;
    process.chdir(root);
    return root;
}

async function startLocalServer(port = 3100) {
    if (serverInstance) return { port: listenPort, already: true };
    listenPort = Number(port) || 3100;
    process.env.PORT = String(listenPort);
    const root = ensureProjectRootEnv();
    // Load dotenv from server root
    try {
        require(path.join(root, 'src', 'loadEnv')).loadEnv({ root });
    } catch {
        /* optional */
    }
    const { startServer } = require(path.join(root, 'src', 'app.js'));
    serverInstance = await startServer(listenPort);
    return { port: listenPort, root, already: false };
}

async function stopLocalServer() {
    if (!serverInstance) return;
    await new Promise((resolve) => serverInstance.close(() => resolve()));
    serverInstance = null;
}

function getPort() {
    return listenPort;
}

function adminUrl() {
    return `http://127.0.0.1:${listenPort}/admin/`;
}

module.exports = {
    serverRoot,
    startLocalServer,
    stopLocalServer,
    getPort,
    adminUrl,
};
