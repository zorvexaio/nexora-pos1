#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const license = fs.readFileSync(path.join(root, 'licensing', 'license.js'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
let passed = 0;
function ok(name, value) { console.log(`${value ? 'PASS' : 'FAIL'} ${name}`); if (!value) process.exitCode = 1; else passed++; }
ok('version is compatible with v0.27 baseline', /^(?:0\.(?:2[7-9]|[3-9]\d)\.)/.test(pkg.version));
ok('safeStorage clock guard exists', /safeStorage\.isEncryptionAvailable\(\)/.test(license) && /license-last-seen\.bin/.test(license));
ok('clock rollback tolerance exists', /CLOCK_SKEW_TOLERANCE_MS/.test(license));
ok('clock rollback is rejected', /clock_rollback_detected/.test(license));
ok('activation blocks clock rollback', /تم اكتشاف رجوع في ساعة الجهاز/.test(license));
ok('last seen timestamp is protected', /safeStorage\.encryptString\(String\(Math\.trunc\(ms\)\)/.test(license));
ok('expiry compares against guarded clock', /license\.expiresAt\).*clock\.now/.test(license));
ok('preflight still requires real public key', /license public key is still a placeholder/.test(fs.readFileSync(path.join(root,'tools','release-preflight.js'),'utf8')));
console.log(`V0.27 REGRESSION ${passed}/8 PASS`);
if (passed !== 8) process.exit(1);
