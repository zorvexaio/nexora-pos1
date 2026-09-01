const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const db = read('database/db.js');
const schema = read('database/schema.sql');
const main = read('main.js');
const tableOrder = read('renderer/pages/table-order.js');
const pos = read('renderer/pos.js');
const pkg = JSON.parse(read('package.json'));
const checks = [
 ['version is 0.45.5', pkg.version === '0.45.5'],
 ['sales schema has inventory_committed', /inventory_committed INTEGER NOT NULL DEFAULT 0/.test(schema)],
 ['migration adds inventory_committed', /tryAddColumn\('sales', `inventory_committed INTEGER NOT NULL DEFAULT 0`\)/.test(db)],
 ['table save reads applied table-order movements', /reason='table_order' GROUP BY product_id/.test(db)],
 ['table save uses quantity delta', /const delta = desired - applied/.test(db)],
 ['table save blocks insufficient stock', /المخزون غير كافٍ للصنف/.test(db)],
 ['table save logs stock decrement', /-delta, saleId, 'خصم عند حفظ طلب الطاولة'/.test(db)],
 ['table save restores stock on reduction', /إعادة مخزون عند تعديل طلب الطاولة/.test(db)],
 ['close does not double-deduct committed stock', /if \(!inventoryAlreadyCommitted\)/.test(db)],
 ['split does not double-deduct committed stock', /if \(!sourceInventoryCommitted\)/.test(db)],
 ['merge transfers table-order movements', /UPDATE inventory_movements SET ref_id=.*reason='table_order'/.test(db)],
 ['table UI does not print kitchen twice', !/window\.api\.kitchen\.open\(currentSaleId\)/.test(tableOrder)],
 ['table save triggers kitchen automatically', /void autoSendKitchen\(saleId\)/.test(main)],
 ['kitchen auto-print defaults to on', /db\.getSetting\('kitchen_auto_print', '1'\) === '1'/.test(main)],
 ['credit approval is marked as credit', /approvalPurpose = 'credit'/.test(pos)],
 ['credit sale backend enforces customer and manager approval', /sale\.paymentMethod !== 'credit'/.test(db) && /creditApprovedBy/.test(main)],
];
let failed=0; for (const [name,ok] of checks) { console.log(`${ok?'PASS':'FAIL'}: ${name}`); if(!ok) failed++; }
console.log(`TABLE/SALE REGRESSION ${checks.length-failed}/${checks.length} PASS`);
process.exitCode=failed?1:0;
