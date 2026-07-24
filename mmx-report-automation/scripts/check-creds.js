#!/usr/bin/env node
/** Verify Macromatix credentials load (no password printed). */
const { getSettings } = require('../src/config');
const { getMacromatixCredentials } = require('../src/mmx-auth');

getSettings();
const { username, password } = getMacromatixCredentials();

console.log('SCRAPER_USERNAME:', username || '(missing)');
console.log('SCRAPER_PASSWORD length:', password ? password.length : 0);
console.log('MMX_EPHEMERAL_BROWSER:', process.env.MMX_EPHEMERAL_BROWSER || '(not set)');

if (!username || !password) {
    process.exit(1);
}
