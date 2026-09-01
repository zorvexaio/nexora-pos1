'use strict';
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const db = fs.readFileSync(path.join(root, 'database', 'db.js'), 'utf8');
const license = fs.readFileSync(path.join(root, 'licensing', 'license.js'), 'utf8');
const results = [];
function pass(name, condition) { if (!condition) throw new Error(`FAIL: ${name}`); results.push(`PASS: ${name}`); }

const sessionReady = main.indexOf('app.whenReady().then(() => {\n  const ses = require(\'electron\').session.defaultSession;');
pass('defaultSession access is inside app.whenReady', sessionReady >= 0);
const allDefaultSessionRefs = [...main.matchAll(/session\.defaultSession/g)].map(m => m.index);
pass('no defaultSession access exists before ready block', allDefaultSessionRefs.every(i => i >= sessionReady));
pass('database encryption is initialized only from after-ready path', /db\s*=\s*require\('\.\/database\/db'\)/.test(main) && /app\.whenReady\(\)\.then\(\(\) => \{[\s\S]{0,500}\n    db\s*=\s*require\('\.\/database\/db'\)/.test(main));
pass('license clock rollback reason matches runtime reason', /reason: 'clock_rollback_detected'/.test(license) && /result\.reason === 'clock_rollback_detected'/.test(main));
pass('preflight rejects vendor private key', /vendor private signing key must never exist/.test(fs.readFileSync(path.join(root, 'tools', 'release-preflight.js'), 'utf8')));
console.log(results.join('\n'));
console.log(`RUNTIME STARTUP REGRESSION: ${results.length}/${results.length} PASS`);
