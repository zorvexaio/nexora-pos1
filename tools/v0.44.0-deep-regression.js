const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const db = fs.readFileSync(path.join(root, 'database', 'db.js'), 'utf8');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const checks = [
  ['release is 0.44.x or newer', (() => { const v=pkg.version.split('.').map(Number); return v[0]===0 && v[1]>=44; })()],
  ['returns reject open/unpaid orders', db.includes("!['completed', 'partially_refunded'].includes(String(sale.status))")],
  ['split preserves tax profile', /tax_profile_id,tax_inclusive,discount,line_total/.test(db) && /item\.tax_profile_id \|\| null/.test(db) && /item\.tax_inclusive \? 1 : 0/.test(db)],
  ['table close validates payment exactly once', (db.match(/validatePaymentAmounts\(total, payment\.paymentMethod \|\| 'cash'/g) || []).length === 1],
  ['cashier discount setting is bounded', main.includes("value < 0 || value > 100")],
  ['product create validates numeric inputs', /function parseNonNegativeNumber/.test(db) && /parseNonNegativeNumber\(p\?\.price/.test(db)],
  ['product create rejects negative inventory', /المخزون الابتدائي/.test(db) && /n < 0/.test(db)],
];
let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok) failed++;
}
if (failed) process.exit(1);
console.log(`V0.44.0 DEEP PRODUCT REGRESSION: ${checks.length}/${checks.length} passed`);
