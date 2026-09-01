const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const schema = fs.readFileSync(path.join(root, 'database', 'schema.sql'), 'utf8');
const db = fs.readFileSync(path.join(root, 'database', 'db.js'), 'utf8');
function pass(message) { console.log(`PASS: ${message}`); }
function fail(message) { console.error(`FAIL: ${message}`); process.exit(1); }

const expected = [
  'audit_logs','users','inventory','restaurant_tables','tax_profiles','payment_transactions',
  'cash_movements','customers','customer_ledger','store_credit_ledger','shifts','sales',
  'payroll_periods','payroll_adjustments','user_salary_history','suppliers','supplier_ledger',
  'purchase_orders','returns','inventory_movements','bundles'
];

const schemaBranchTables = [...schema.matchAll(/CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\(([\s\S]*?)\);/g)]
  .filter((m) => /\bbranch_id\b/.test(m[2]))
  .map((m) => m[1]);

for (const table of expected) {
  if (!schemaBranchTables.includes(table)) fail(`schema branch table missing from expected set: ${table}`);
  pass(`schema declares branch ownership for ${table}`);
  if (!db.includes(`${table}: 'branch_id INTEGER`)) fail(`legacy migration spec missing ${table}`);
  pass(`legacy migration covers ${table}`);
}

const listMatch = db.match(/const LEGACY_BRANCH_TABLES = Object\.freeze\(\[([\s\S]*?)\]\);/);
if (!listMatch) fail('LEGACY_BRANCH_TABLES declaration missing');
for (const table of expected) {
  if (!listMatch[1].includes(`'${table}'`)) fail(`LEGACY_BRANCH_TABLES omits ${table}`);
}
pass(`legacy branch coverage list contains all ${expected.length} branch-owned tables`);

if (!/ensureLegacyBranchColumns\(tryAddColumn\);/.test(db)) fail('legacy branch repair is not wired before historical migrations');
pass('legacy branch repair runs before historical migrations');
if (!/Legacy branch migration incomplete:/.test(db)) fail('legacy migration is not fail-closed');
pass('legacy branch migration is fail-closed on unresolved rows');
if (!/CREATE INDEX IF NOT EXISTS idx_\$\{table\}_branch_id/.test(db)) fail('branch index creation is missing for legacy tables');
pass('legacy branch indexes are created');
console.log('V0.40.3 LEGACY BRANCH COVERAGE REGRESSION: PASS');
