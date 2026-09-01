const fs=require('fs');
const db=fs.readFileSync('database/db.js','utf8');
const main=fs.readFileSync('main.js','utf8');
const pkg=require('../package.json');
let pass=0,fail=0;
function t(name,ok){if(ok){pass++;console.log('PASS',name)}else{fail++;console.error('FAIL',name)}}

t('release version is compatible with v0.25 baseline', /^0\.(?:2[5-9]|[3-9]\d)\./.test(pkg.version));
t('sale validates customer branch', /if \(sale\.customerId != null\) \{[\s\S]*SELECT id FROM customers WHERE id=\? AND branch_id=\?/.test(db));
t('sale validates table branch', /if \(sale\.tableId != null\) \{[\s\S]*restaurant_tables WHERE id=\? AND branch_id=\?/.test(db));
t('sale validates optional shift is current branch and open', /if \(sale\.shiftId != null\) \{[\s\S]*SELECT id,status FROM shifts WHERE id=\? AND branch_id=\?[\s\S]*shift\.status !== 'open'/.test(db));
t('sale pricing carries inventory tracking flag', /SELECT p\.id,p\.price,p\.cost,COALESCE\(i\.unit_cost,p\.cost,0\) AS branch_cost,p\.tax_rate,p\.tax_profile_id,p\.name,p\.track_inventory/.test(db) && /trackInventory: Boolean\(product\.track_inventory\)/.test(db));
t('non-tracked sales do not mutate inventory', /if \(item\.trackInventory\) \{[\s\S]*stockResult = updateStock\.run/.test(db));
t('split sale validates stock before commit', /for \(const item of picked\) \{[\s\S]*if \(product\.track_inventory\) \{[\s\S]*الكمية المتوفرة لم تعد كافية لتقسيم الطلب/.test(db));
t('table close avoids stock mutation for non-tracked products', /if \(product\?\.track_inventory\) \{[\s\S]*تحديث مخزون المنتج أثناء إغلاق الطلب/.test(db));
t('returns avoid stock mutation for non-tracked products', /const product = db\.prepare\('SELECT track_inventory FROM products WHERE id=\?'\)[\s\S]*if \(product\?\.track_inventory\)/.test(db));
t('purchase receiving skips non-tracked inventory', /if \(!product\.track_inventory\) continue;/.test(db));
t('backup restore closes database before replacement', /db\.closeDatabase\(\);[\s\S]*fs\.copyFileSync\(sourcePath, dbPath\)/.test(main));
t('full check includes v0.25 regression', /tools\/v0\.25-regression\.js/.test(require('../package.json').scripts.check));
console.log(`v0.25 ${pass}/${pass+fail}`);
process.exit(fail?1:0);
