const fs = require('fs');

function requireLivePiOrderingData() {
    if (/^(1|true|yes|on)$/i.test(String(process.env.ORDERING_LIVE_DATA_ONLY || '').trim())) {
        return true;
    }
    return String(process.env.NODE_ENV || '').trim().toLowerCase() === 'production';
}

/**
 * Resolve a Pi-local data file. In production (or when ORDERING_LIVE_DATA_ONLY=1),
 * only the live path is used — example templates are never treated as inventory data.
 */
function resolvePiLiveFile({ livePath, examplePath = null }) {
    if (fs.existsSync(livePath)) return livePath;
    if (requireLivePiOrderingData()) {
        return null;
    }
    if (examplePath && fs.existsSync(examplePath)) return examplePath;
    return null;
}

module.exports = {
    requireLivePiOrderingData,
    resolvePiLiveFile,
};
