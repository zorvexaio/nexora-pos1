'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

function fail(message) {
  console.error(`WINDOWS STRUCTURE REGRESSION FAIL: ${message}`);
  process.exit(1);
}

function pass(message) {
  console.log(`PASS: ${message}`);
}

const licenseDoc = path.join(root, 'LICENSE');
const licensingDir = path.join(root, 'licensing');
const licensingEngine = path.join(licensingDir, 'license.js');

if (!fs.existsSync(licenseDoc) || !fs.statSync(licenseDoc).isFile()) {
  fail('root LICENSE must be a regular file');
}
pass('root LICENSE is a file');

if (!fs.existsSync(licensingDir) || !fs.statSync(licensingDir).isDirectory()) {
  fail('licensing directory is missing');
}
pass('licensing directory exists');

if (!fs.existsSync(licensingEngine) || !fs.statSync(licensingEngine).isFile()) {
  fail('licensing/license.js is missing');
}
pass('licensing/license.js exists');

const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
if (packageJson.build?.productName !== 'Nexora POS') fail('electron-builder productName must be Nexora POS');
if (packageJson.build?.nsis?.shortcutName !== 'Nexora POS') fail('NSIS shortcutName must be Nexora POS');
if (packageJson.build?.artifactName !== 'Nexora-POS-Setup-${version}.${ext}') fail('Windows artifactName must use Nexora-POS-Setup naming');
pass('Windows branding is Nexora POS');

const seen = new Map();
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist' || entry.name === 'release-output') continue;
    const full = path.join(dir, entry.name);
    const rel = path.relative(root, full).replace(/\\/g, '/');
    const key = rel.toLowerCase();
    const prior = seen.get(key);
    if (prior && prior !== rel) fail(`case-insensitive Windows path collision: ${prior} <-> ${rel}`);
    seen.set(key, rel);
    if (entry.isDirectory()) walk(full);
  }
}
walk(root);
pass('no Windows case-insensitive path collisions exist');

for (const forbidden of ['license/license.js', 'license\\license.js']) {
  if (fs.existsSync(path.join(root, forbidden))) fail(`legacy conflicting path still exists: ${forbidden}`);
}
pass('legacy conflicting license path is absent');

console.log('WINDOWS STRUCTURE REGRESSION: PASS');
