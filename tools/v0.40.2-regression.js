const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const schema = fs.readFileSync(path.join(root, 'database', 'schema.sql'), 'utf8');
const db = fs.readFileSync(path.join(root, 'database', 'db.js'), 'utf8');
function pass(message) { console.log(`PASS: ${message}`); }
function fail(message) { console.error(`FAIL: ${message}`); process.exit(1); }
const checks = [
  [/CREATE TABLE IF NOT EXISTS supplier_ledger[\s\S]*branch_id INTEGER NOT NULL REFERENCES branches\(id\)/, 'supplier_ledger schema has explicit branch ownership', schema],
  [/tryAddColumn\('supplier_ledger', `branch_id INTEGER`\)/, 'legacy supplier_ledger migration adds branch_id', db],
  [/UPDATE supplier_ledger SET branch_id=/, 'legacy supplier_ledger branch backfill exists', db],
  [/assertRuntimeSchemaCompatibility\(\)/, 'runtime schema compatibility guard is wired into init', db],
  [/INSERT INTO supplier_ledger \(uuid, branch_id, supplier_id, purchase_order_id/, 'new supplier ledger entries persist branch_id', db],
  [/SELECT sl\.\*,s\.uuid AS supplier_uuid,b\.uuid AS branch_uuid,po\.uuid AS purchase_order_uuid FROM supplier_ledger sl JOIN suppliers s ON s\.id=sl\.supplier_id JOIN branches b ON b\.id=sl\.branch_id LEFT JOIN purchase_orders po ON po\.id=sl\.purchase_order_id WHERE sl\.branch_id=\?/, 'supplier ledger sync is branch-owned directly', db],
  [/INSERT INTO supplier_ledger\(uuid,branch_id,supplier_id,purchase_order_id/, 'remote supplier ledger insert persists branch_id', db],
];
for (const [re, msg, text] of checks) {
  if (!re.test(text)) fail(msg);
  pass(msg);
}
console.log('V0.40.2 DATABASE COMPATIBILITY REGRESSION: PASS');
