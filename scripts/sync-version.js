'use strict';
// Run by `npm version x.y.z` (the "version" script): writes package.json's version into
// cutout/version.js, so the browser version shows the same number as the installers.
const fs = require('fs');
const path = require('path');

const { version } = require('../package.json');
const file = path.join(__dirname, '..', 'cutout', 'version.js');
const text = fs.readFileSync(file, 'utf8');
const next = text.replace(/CUTOUT_VERSION = '[^']*'/, `CUTOUT_VERSION = '${version}'`);
if (next === text && !text.includes(`'${version}'`)) throw new Error('CUTOUT_VERSION not found in cutout/version.js');
fs.writeFileSync(file, next);
console.log(`cutout/version.js -> ${version}`);
