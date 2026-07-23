const path = require('path');

const root = process.env.PROJECT_ROOT || path.join(__dirname, '..');

function domain(name) {
    const base = path.join(root, name);
    return {
        root: base,
        src: path.join(base, 'src'),
        public: path.join(base, 'public'),
        data: path.join(base, 'data'),
        config: path.join(base, 'config'),
        scripts: path.join(base, 'scripts'),
    };
}

const dashboard = domain('dashboard');
const stores = {
    ...domain('stores'),
    storelist: process.env.STORELIST_PATH || path.join(root, 'stores', '.storelist'),
};
const mmx = domain('mmx');
const vendors = {
    ...domain('vendors'),
    catalogs: process.env.VENDOR_CATALOGS_DIR || path.join(root, 'vendors', 'catalogs'),
    reports: process.env.VENDOR_REPORTS_DIR || path.join(root, 'vendors', 'reports'),
};
const users = domain('users');

module.exports = {
    root,
    sharedPublic: path.join(root, 'public', 'shared'),
    sharedSrc: path.join(root, 'src', 'shared'),
    legacy: {
        data: path.join(root, 'data'),
        config: path.join(root, 'config'),
        public: path.join(root, 'public'),
        scripts: path.join(root, 'scripts'),
    },
    dashboard,
    vendors,
    stores,
    users,
    mmx,
    forecast: domain('forecast'),
    tacaudit: domain('tacaudit'),
    smg: domain('smg'),
    nsf: domain('nsf'),
    mmxReportAutomation:
        process.env.MMX_REPORT_AUTOMATION_DIR ||
        (fsExists(path.join('Y:', 'Taco Bell Dashboard', 'mmx-report-automation'))
            ? path.join('Y:', 'Taco Bell Dashboard', 'mmx-report-automation')
            : path.join(root, '..', 'mmx-report-automation')),
};

function fsExists(p) {
    try {
        return require('fs').existsSync(p);
    } catch {
        return false;
    }
}
