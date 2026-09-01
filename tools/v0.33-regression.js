const fs = require('fs');
const path = require('path');
const pkg = require('../package.json');
const license = fs.readFileSync(path.join(__dirname, '..', 'licensing', 'license.js'), 'utf8');
const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
let passed = 0;
function pass(name, condition) {
  if (!condition) throw new Error(`FAIL ${name}`);
  passed += 1;
  console.log(`PASS ${name}`);
}
const [vMaj, vMin] = pkg.version.split('.').map(Number);
pass('version is compatible with v0.32 baseline', vMaj > 0 || vMin >= 32);
pass('Windows device command timeout is bounded', /timeout:\s*DEVICE_COMMAND_TIMEOUT_MS/.test(license));
pass('macOS device command timeout is bounded', (license.match(/timeout:\s*DEVICE_COMMAND_TIMEOUT_MS/g) || []).length >= 2);
pass('device command timeout is 2 seconds or less', /DEVICE_COMMAND_TIMEOUT_MS\s*=\s*2000/.test(license));
pass('device fingerprint fallback remains available', /getOrCreateFallbackId\(/.test(license));
pass('IPC trusted renderer gate remains global', /ipcMain\.handle = \(channel, listener\) =>/.test(main) && /isTrustedRenderer\(event\.sender, event\.senderFrame\)/.test(main));
console.log(`V0.33 REGRESSION ${passed}/6 PASS`);
