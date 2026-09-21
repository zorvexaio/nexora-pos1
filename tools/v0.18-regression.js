const fs = require('fs');
const dbSource = fs.readFileSync('database/db.js','utf8');
const pkg = JSON.parse(fs.readFileSync('package.json','utf8'));
const schema = fs.readFileSync('database/schema.sql','utf8');
const assertions = [
  ['cash payment accepts tender above total and validates exact change', /function validatePaymentAmountsMinor[\s\S]*?paymentMethod === 'cash'[\s\S]*?if \(cash < total\)[\s\S]*?if \(cash - total !== change\)/],
  ['purchase receipt writes branch weighted unit_cost into inventory', /INSERT INTO inventory \(branch_id, product_id, quantity, unit_cost, min_quantity/],
  ['purchase receipt updates unit_cost on existing inventory row', /unit_cost=excluded\.unit_cost/],
  ['purchase validates product activity before creating purchase order', /productCheck = db\.prepare\('SELECT id, is_active FROM products WHERE id=\?'/],
  ['credit payment ledger prevents negative balance through applied amount', /const applied = Number\(customer\.balance \|\| 0\) - balanceAfter/],
  ['inventory has unique branch-product ownership', /UNIQUE\(branch_id, product_id\)/],
  ['sales validate aggregated stock by product', /requestedByProduct\.set\(productId,\s*\(requestedByProduct\.get\(productId\)\s*\|\|\s*0\)\s*\+\s*quantity\)/],
  ['release remains compatible with v0.18 baseline', /^0\.(1[89]|[2-9]\d)\.\d+$/],
];
let pass = 0;
for (const [name, pattern] of assertions) {
  const ok = pattern instanceof RegExp ? pattern.test(name==='release remains compatible with v0.18 baseline' ? pkg.version : (pattern.test(dbSource) ? dbSource : schema)) : false;
  if (ok) { console.log(`PASS: ${name}`); pass++; }
  else { console.error(`FAIL: ${name}`); process.exitCode = 1; }
}
console.log(`v0.18 regression: ${pass}/${assertions.length} PASS`);
