#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const money = require('../core/money');
const accounting = require('../finance/accounting');
const permissions = require('../core/permissions');
const root = path.resolve(__dirname, '..');
function readDatabaseSources(root) {
  // الكود قُسِّم من database/db.js إلى database/domains/*.js — نقرأ الكل كنص واحد.
  const dbDir = path.join(root, 'database');
  const files = [path.join(dbDir, 'db.js')];
  const domains = path.join(dbDir, 'domains');
  if (fs.existsSync(domains)) for (const f of fs.readdirSync(domains).sort()) if (f.endsWith('.js')) files.push(path.join(domains, f));
  return files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
}


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
const db = readDatabaseSources(root);
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
assert.match(db, /'1300','Inventory'[\s\S]*'2100','Tax Payable'[\s\S]*'2200','Customer Store Credit'[\s\S]*'4000','Sales Revenue'[\s\S]*'4100','Delivery Revenue'[\s\S]*'5000','Cost of Goods Sold'/);
assert.match(db, /recordSyncOutboxEvent/);
assert.match(db, /saveFiscalDocument/);
console.log('V0.48.0 ENGINEERING REGRESSION: PASS');
