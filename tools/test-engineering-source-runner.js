#!/usr/bin/env node
'use strict';
const path = require('path');
const { spawnSync } = require('child_process');
const root = path.resolve(__dirname, '..');
const tests = [
  'quantity-buffer-regression.js',
  'category-image-removal-regression.js',
  'money-regression.js','sync-hardening-regression.js','v0.48.2-regression.js',
  'payroll-lifecycle-regression.js','payroll-advances-regression.js','payroll-advance-repayments-regression.js',
  'payroll-termination-regression.js','v0.48.0-regression.js','release-metadata-regression.js',
  'update-safety-regression.js','windows-structure-regression.js','client-event-hardening-regression.js',
  'lan-key-persistence-regression.js','deep-regression.js','global-financial-regression.js',
  'auth-bootstrap-regression.js','sale-readiness.js','release-preflight.js',
  'inventory-transfer-regression.js','engineering-audit.js','migration-chain-regression.js'
];
for (const file of tests) {
  const r=spawnSync(process.execPath,[path.join(root,'tools',file)],{cwd:root,encoding:'utf8'});
  if(r.stdout) process.stdout.write(r.stdout);
  if(r.stderr) process.stderr.write(r.stderr);
  if(r.status!==0){process.exit(r.status || 1);}
}
console.log(`ENGINEERING SOURCE SUITE: PASS (${tests.length} suites)`);
