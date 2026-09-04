#!/usr/bin/env node
'use strict';
const { spawnSync } = require('child_process');
const tests = [
  'sync-hardening-regression.js','v0.48.0-regression.js','release-metadata-regression.js','update-safety-regression.js',
  'windows-structure-regression.js','client-event-hardening-regression.js','lan-key-persistence-regression.js',
  'deep-regression.js','global-financial-regression.js','payroll-regression.js','payroll-lifecycle-regression.js','payroll-advances-regression.js','payroll-advance-repayments-regression.js','payroll-termination-regression.js','auth-bootstrap-regression.js','sale-readiness.js','release-preflight.js'
];
for (const test of tests) {
  const r = spawnSync(process.execPath, [`tools/${test}`], { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status || 1);
}
console.log('NEXORA ENGINEERING RELEASE GATE: PASS');
