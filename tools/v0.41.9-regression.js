'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const root = path.resolve(__dirname, '..');
function ok(cond, label) { if(!cond) throw new Error(`FAIL: ${label}`); console.log(`PASS: ${label}`); }
const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
const lock=JSON.parse(fs.readFileSync(path.join(root,'package-lock.json'),'utf8'));
const v=fs.readFileSync(path.join(root,'VERSION'),'utf8').trim();
const docs=fs.readFileSync(path.join(root,'docs','VERSION.txt'),'utf8').trim();
function validSemver(s){return /^\d+\.\d+\.\d+$/.test(s)}
ok(validSemver(pkg.version),'package version is valid semver');
ok(pkg.version===lock.version && pkg.version===lock.packages[''].version,'package and lock versions are synchronized');
ok(pkg.version===v && docs===`Nexora POS v${pkg.version}`,'version metadata is synchronized');
ok(fs.existsSync(path.join(root,'licensing','license.js')),'runtime license engine path exists');
ok(!fs.existsSync(path.join(root,'tools','private-key.pem')),'vendor private key is absent');
ok(!fs.existsSync(path.join(root,'license','license.js')),'legacy colliding license path is absent');
// Historical regression suites must not hard-code an older current version.
for (const name of ['v0.41.1-regression.js','v0.41.3-regression.js']) {
  const s=fs.readFileSync(path.join(root,'tools',name),'utf8');
  ok(!/version is 0\.41\.[13]/.test(s) && !/pkg\.version==='0\.41\.[13]'/.test(s), `${name} is forward-compatible`);
}
console.log('V0.41.9 REGRESSION: PASS (7/7)');
