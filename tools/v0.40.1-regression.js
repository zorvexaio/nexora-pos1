const fs = require('fs');
const main = fs.readFileSync('main.js', 'utf8');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
function pass(name, ok) { if (!ok) throw new Error(`FAIL ${name}`); console.log(`PASS: ${name}`); }
pass('package version is compatible with v0.40.1 baseline', /^0\.(?:4[0-9]|[5-9][0-9])\.\d+$/.test(pkg.version));
const readyBlock = main.indexOf("app.whenReady().then(() => {\n  const ses = require('electron').session.defaultSession;");
pass('session setup starts in unified ready block', readyBlock >= 0);
pass('only one app.whenReady block is used for session/startup setup', (main.match(/app\.whenReady\(\)\.then\(/g) || []).length === 1);
pass('permission hardening is inside ready block', readyBlock < main.indexOf('ses.setPermissionRequestHandler'));
pass('CSP wiring is inside ready block', readyBlock < main.indexOf('ses.webRequest.onHeadersReceived'));
pass('database require remains after session ready setup', main.indexOf("db = require('./database/db')") > main.indexOf('ses.webRequest.onHeadersReceived'));
console.log('V0.40.1 STARTUP/HARDENING REGRESSION: 6/6 PASS');
