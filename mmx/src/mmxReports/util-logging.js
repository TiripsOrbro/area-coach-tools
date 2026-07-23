function ts() {
    return new Date().toISOString();
}

function log(level, msg, extra) {
    const line = `[${ts()}] [${level}] ${msg}`;
    if (extra !== undefined) {
        console.log(line, extra);
    } else {
        console.log(line);
    }
}

module.exports = {
    info: (m, e) => log('INFO', m, e),
    warn: (m, e) => log('WARN', m, e),
    error: (m, e) => log('ERROR', m, e),
};
