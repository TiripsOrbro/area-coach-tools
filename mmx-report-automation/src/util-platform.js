/** Suffix for platform-specific env files: .env.windows on PC, .env.pi on Raspberry Pi. */
function platformEnvSuffix() {
    if (process.platform === 'win32') return 'windows';
    if (process.platform === 'linux') return 'pi';
    return process.platform;
}

function isWindows() {
    return process.platform === 'win32';
}

function isLinux() {
    return process.platform === 'linux';
}

module.exports = { platformEnvSuffix, isWindows, isLinux };
