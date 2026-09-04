#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.resolve(__dirname, '..');
const db = fs.readFileSync(path.join(root, 'database', 'db.js'), 'utf8');
const schema = fs.readFileSync(path.join(root, 'database', 'schema.sql'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

const current = Number((db.match(/const CURRENT_SCHEMA_VERSION\s*=\s*(\d+)/) || [])[1]);
assert.strictEqual(current, 15, `Expected CURRENT_SCHEMA_VERSION=15, got ${current}`);

const migrationBlock = db.match(/const versionedMigrations\s*=\s*\[(.*?)\n\s*\];/s);
assert.ok(migrationBlock, 'versionedMigrations block not found');
const versions = [...migrationBlock[1].matchAll(/\[(\d+),\s*'([^']+)'/g)].map(m => ({version:Number(m[1]), name:m[2]}));
const expected = [
  [2,'financial-minor-units-v2'], [3,'accounting-core-v3'], [4,'permissions-matrix-v4'],
  [5,'sync-engine-journal-v5'], [6,'backup-integrity-v6'], [7,'fiscalization-adapters-v7'],
  [8,'commercial-hardening-v8'], [9,'migration-journal-integrity-v9'], [10,'payroll-lifecycle-v10'],
  [11,'inventory-transfer-workflow-v11'], [12,'payroll-advances-v12'], [13,'payroll-advance-repayments-v13'],
  [14,'payroll-termination-final-settlement-v14'], [15,'payroll-commercial-hardening-v15']
].map(([version,name])=>({version,name}));
assert.deepStrictEqual(versions, expected, 'Versioned migration chain is incomplete or reordered');
assert.ok(schema.includes('CREATE TABLE IF NOT EXISTS payroll_employees'), 'schema.sql missing payroll_employees');
assert.ok(schema.includes('CREATE TABLE IF NOT EXISTS payroll_advances'), 'schema.sql missing payroll_advances');
assert.ok(schema.includes('CREATE TABLE IF NOT EXISTS payroll_advance_payments'), 'schema.sql missing payroll_advance_payments');
assert.ok(schema.includes('CREATE TABLE IF NOT EXISTS payroll_final_settlements'), 'schema.sql missing payroll_final_settlements');
assert.ok(db.includes('db.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`);'), 'runtime must stamp CURRENT_SCHEMA_VERSION');
assert.strictEqual(pkg.version, '0.52.1', 'package version drift');

console.log(`Migration chain regression: PASS (v2..v${current}, ${versions.length} immutable migrations)`);
