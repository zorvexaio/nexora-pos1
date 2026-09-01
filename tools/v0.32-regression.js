const fs = require('fs');
const path = require('path');
const pkg = require('../package.json');
let passed = 0;
function pass(name, condition) {
  if (!condition) throw new Error(`FAIL ${name}`);
  passed += 1;
  console.log(`PASS ${name}`);
}
const root = path.join(__dirname, '..');
const versionFile = fs.readFileSync(path.join(root, 'docs', 'VERSION.txt'), 'utf8').trim();
const manifest = path.join(root, `CORE_SHA256_V${pkg.version}.txt`);
const [vMaj, vMin] = pkg.version.split('.').map(Number);
pass('version remains compatible with v0.32 baseline', vMaj > 0 || vMin >= 32);
pass('version file matches package version', versionFile === `Nexora POS v${pkg.version}`);
pass('versioned core manifest exists', fs.existsSync(manifest));
pass('default core manifest exists', fs.existsSync(path.join(root, 'CORE_SHA256.txt')));
pass('release preflight is part of check', /tools\/release-preflight\.js/.test(pkg.scripts.check));
console.log(`V0.32 REGRESSION ${passed}/5 PASS`);
