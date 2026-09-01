const fs=require('fs'); const db=fs.readFileSync('database/db.js','utf8'); const main=fs.readFileSync('main.js','utf8');
let pass=0,fail=0; function t(name,ok){if(ok){pass++;console.log('PASS',name)}else{fail++;console.error('FAIL',name)}}
t('purchase order list is branch-scoped', /function listPurchaseOrders\(\) \{ const b=getCurrentBranch\(\);[\s\S]*WHERE p\.branch_id=\?/.test(db));
t('purchase order get is branch-scoped', /function getPurchaseOrder\(id\) \{ const b=getCurrentBranch\(\);[\s\S]*WHERE p\.id=\? AND p\.branch_id=\? AND s\.branch_id=\?/.test(db));
t('weighted barcode requires login', /products:resolveWeightedBarcode',[\s\S]*requireAccountReady\(\)/.test(main));
t('GS1 barcode requires login', /products:resolveGs1Barcode',[\s\S]*requireAccountReady\(\)/.test(main));
t('purchase receive remains branch-aware', /function receivePurchaseOrder\(id, context = \{\}\) \{ return receivePurchaseOrderTx\(id, getCurrentBranch\(\)\.id, context\); \}/.test(db));
console.log(`v0.24 ${pass}/${pass+fail}`); process.exit(fail?1:0);
