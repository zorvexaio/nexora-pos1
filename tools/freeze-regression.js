const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const pos = fs.readFileSync(path.join(root, 'renderer', 'pos.js'), 'utf8');
const db = fs.readFileSync(path.join(root, 'database', 'db.js'), 'utf8');
const schema = fs.readFileSync(path.join(root, 'database', 'schema.sql'), 'utf8');
const common = fs.readFileSync(path.join(root, 'renderer', 'common.js'), 'utf8');
const checks = [
  ['product search is bounded', /search \? 80 : 250/.test(db) && /LIMIT \?/.test(db)],
  ['customer search is bounded', /limit = Math\.max\(1, Math\.min\(Number\(filters\.limit\) \|\| \(search \? 40 : 250\), 500\)\)/.test(db)],
  ['renderer ignores stale product responses', /productSearchRequestSeq/.test(pos)],
  ['renderer ignores stale customer responses', /customerSearchRequestSeq/.test(pos)],
  ['draft persistence is deferred', /setTimeout\(persistDraftCartNow, 300\)/.test(pos)],
  ['barcode lookup is single-flight', /barcodeLookupBusy/.test(pos)],
  ['weighted barcode does not double-add weight', /existing\.quantity \+= weightKg;\s*\}\s*else/.test(pos)],
  ['localized payment input parsing', /parseLocaleNumber\(cashReceivedInput\.value\)/.test(pos)],
  ['localized discount parsing', /parseLocaleNumber\(discountValueInput\.value\)/.test(pos)],
  ['renderer stall diagnostics are present', /renderer_stall/.test(common)],
  ['branch-product inventory index exists', /idx_inventory_branch_product/.test(schema)],
];
let failed=0;
for (const [name, ok] of checks) { console.log(`${ok?'PASS':'FAIL'}: ${name}`); if(!ok) failed++; }
if(failed) process.exit(1);
console.log(`FREEZE REGRESSION: PASS (${checks.length} checks)`);
