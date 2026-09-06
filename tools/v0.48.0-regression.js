#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const money = require('../core/money');
const accounting = require('../finance/accounting');
const permissions = require('../core/permissions');
const root = path.resolve(__dirname, '..');

assert.strictEqual(money.toMinor('10.50', 2), 1050);
assert.strictEqual(money.multiplyMinorQuantity(123, 0.5), 62);
assert.strictEqual(money.taxMinor(11800, 18, true), 1800);
assert.strictEqual(money.taxMinor(10000, 18, false), 1800);
assert.strictEqual(permissions.hasPermission('cashier', 'pos.sell'), true);
assert.strictEqual(permissions.hasPermission('cashier', 'users.manage'), false);
assert.deepStrictEqual(accounting.validateJournalLines([
  { accountId: 1, debitMinor: 1000, creditMinor: 0 },
  { accountId: 2, debitMinor: 0, creditMinor: 1000 },
]), { debit: 1000, credit: 1000 });
assert.throws(() => accounting.validateJournalLines([
  { accountId: 1, debitMinor: 1000, creditMinor: 0 },
  { accountId: 2, debitMinor: 0, creditMinor: 900 },
]), /Unbalanced/);

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
assert.ok(/^(?:0\.(?:48|49|50|51|52)\.)/.test(pkg.version));
assert.strictEqual(pkg.devDependencies.electron, '44.2.0');
const db = fs.readFileSync(path.join(root, 'database', 'db.js'), 'utf8');
{
  // كان يطابق قائمة ثابتة (10..15) فيفشل تلقائياً مع أي ترحيلة لاحقة (فشل فعلياً منذ v16).
  const m = db.match(/CURRENT_SCHEMA_VERSION\s*=\s*(\d+)/);
  assert.ok(m, 'A numeric schema version constant is required.');
  assert.ok(Number(m[1]) >= 15, 'Schema version must not regress below the v0.48.0 baseline (v15).');
}
assert.match(db, /grand_total_minor/);
assert.match(db, /accounting_journal_entries/);
assert.match(db, /sync_outbox/);
assert.match(db, /createPortableBackup/);
assert.match(db, /trg_\$\{table\}_money_minor_ai/);
assert.match(db, /postSaleAccountingInTransaction/);
assert.match(db, /'1300','2100','2200','4000','4100','5000'/);
assert.match(db, /recordSyncOutboxEvent/);
assert.match(db, /saveFiscalDocument/);
console.log('V0.48.0 ENGINEERING REGRESSION: PASS');
