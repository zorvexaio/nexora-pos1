const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const pos = fs.readFileSync(path.join(root, 'renderer', 'pos.js'), 'utf8');
const db = fs.readFileSync(path.join(root, 'database', 'db.js'), 'utf8');
const common = fs.readFileSync(path.join(root, 'renderer', 'common.js'), 'utf8');
const returns = fs.readFileSync(path.join(root, 'renderer', 'pages', 'returns.js'), 'utf8');

const checks = [
  ['POS reads global tax mode', /organizationTaxMode/.test(pos) && /window\.api\.global\.get\(\)/.test(pos)],
  ['POS cart and checkout use the shared per-line minor-unit tax helper', (pos.match(/sumCartTax\(cart, organizationMinorUnit\)/g) || []).length === 2],
  ['shared helper extracts inclusive tax as gross x rate / (100 + rate)', /const den = inclusive \? 10000 \+ bps : 10000;/.test(common) && /Math\.floor\(\(grossMinor \* bps \* 2 \+ den\) \/ \(2 \* den\)\)/.test(common)],
  ['invoice modification preview uses the same helper', /sumCartTax\(modifyCart, modifyMinorUnit\)/.test(returns)],
  ['product list exposes tax-profile inclusion', /tax_profile_rate/.test(db) && /tax_profile_inclusive/.test(db) && /LEFT JOIN tax_profiles/.test(db)],
  ['barcode and weighted-product lookups preserve tax profiles', /function getProductByPlu[\s\S]*tax_profile_rate/.test(db) && /function resolveGs1Barcode[\s\S]*tax_profile_rate/.test(db)],
];
let bad = 0;
for (const [name, ok] of checks) {
  if (ok) console.log('PASS:', name);
  else { console.error('FAIL:', name); bad += 1; }
}
if (bad) process.exit(1);
console.log(`TAX INCLUSIVE UI REGRESSION: PASS ${checks.length}/${checks.length}`);
