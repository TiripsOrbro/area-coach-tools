#!/usr/bin/env node
/** Copy config/*.example → config/*.json if missing */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pairs = [
    ['config/pipeline.json.example', 'config/pipeline.json'],
    ['config/excel-mapping.json.example', 'config/excel-mapping.json'],
];

for (const [src, dest] of pairs) {
    const from = path.join(root, src);
    const to = path.join(root, dest);
    if (fs.existsSync(to)) {
        console.log(`Exists: ${dest}`);
        continue;
    }
    fs.copyFileSync(from, to);
    console.log(`Created: ${dest}`);
}

console.log('Edit config/*.json using docs/mmx-report-automation-discovery.md');
