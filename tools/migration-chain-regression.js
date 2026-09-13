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

const migrationBlock = db.match(/const versionedMigrations\s*=\s*\[(.*?)\n\s*\];/s);
assert.ok(migrationBlock, 'versionedMigrations block not found');
const versions = [...migrationBlock[1].matchAll(/\[(\d+),\s*'([^']+)'/g)].map(m => ({version:Number(m[1]), name:m[2]}));
// هذه القائمة تاريخ ثابت (append-only) وليست فحصاً عاماً: أي ترحيلة جديدة يجب أن تُضاف
// هنا يدوياً بنفس الاسم بالضبط — هذا هو الهدف من الاختبار (كشف أي إعادة ترتيب أو
// تعديل لترحيلة منشورة سابقاً). لا تُحوَّل هذه القائمة إلى فحص "حد أدنى" مثل الاختبارات
// الأخرى، لأن فقدان الترتيب/الاسم الدقيق هنا هو بالضبط ما صُمم الاختبار ليكشفه.
const expected = [
  [2,'financial-minor-units-v2'], [3,'accounting-core-v3'], [4,'permissions-matrix-v4'],
  [5,'sync-engine-journal-v5'], [6,'backup-integrity-v6'], [7,'fiscalization-adapters-v7'],
  [8,'commercial-hardening-v8'], [9,'migration-journal-integrity-v9'], [10,'payroll-lifecycle-v10'],
  [11,'inventory-transfer-workflow-v11'], [12,'payroll-advances-v12'], [13,'payroll-advance-repayments-v13'],
  [14,'payroll-termination-final-settlement-v14'], [15,'payroll-commercial-hardening-v15'],
  [16,'shifts-minor-trigger-null-fix-v16'], [17,'accounting-extensions-v17'],
  [18,'payroll-advance-disbursement-method-v18'], [19,'payroll-accrual-v19'], [20,'payroll-future-accrual-correction-v20'],
  [21,'accounting-balance-cache-v21'], [22,'payroll-advances-accounting-v22']
].map(([version,name])=>({version,name}));
assert.deepStrictEqual(versions, expected, 'Versioned migration chain is incomplete or reordered');
assert.strictEqual(current, expected[expected.length-1].version, `CURRENT_SCHEMA_VERSION must match the last entry in the migration chain (got ${current}, chain ends at ${expected[expected.length-1].version}).`);
assert.ok(schema.includes('CREATE TABLE IF NOT EXISTS payroll_employees'), 'schema.sql missing payroll_employees');
assert.ok(schema.includes('CREATE TABLE IF NOT EXISTS payroll_advances'), 'schema.sql missing payroll_advances');
assert.ok(schema.includes('CREATE TABLE IF NOT EXISTS payroll_advance_payments'), 'schema.sql missing payroll_advance_payments');
assert.ok(schema.includes('CREATE TABLE IF NOT EXISTS payroll_final_settlements'), 'schema.sql missing payroll_final_settlements');
assert.ok(db.includes('db.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`);'), 'runtime must stamp CURRENT_SCHEMA_VERSION');

console.log(`Migration chain regression: PASS (v2..v${current}, ${versions.length} immutable migrations)`);
