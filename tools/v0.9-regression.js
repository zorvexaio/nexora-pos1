const fs=require('fs');
const db=fs.readFileSync('database/db.js','utf8');
const main=fs.readFileSync('main.js','utf8');
const schema=fs.readFileSync('database/schema.sql','utf8');
const checks=[
['own password is branch scoped', /SELECT password_hash, is_active FROM users WHERE id = \? AND branch_id = \?/m.test(db)],
['open table item pricing is server-side', /const setOpenSaleItemsTx = db\.transaction\(\(saleId, items\) => \{[\s\S]*SELECT p\.id,p\.price,p\.cost,p\.tax_rate/m.test(db)],
['open table totals are recalculated before payment', /recalculateOpenSale\(saleId\);[\s\S]*validatePaymentAmounts\(total/m.test(db)],
['open table close writes payment ledger', /INSERT INTO payment_transactions\(uuid,branch_id,sale_id,shift_id,method,currency_code,amount/m.test(db)],
['merge preserves historical cost', /item\.cost_at_sale \|\| 0\);/m.test(db)],
['split recomputes line total', /const lineTotal = Number\(item\.unit_price\) \* Number\(item\.quantity\);/m.test(db)],
['inventory adjustment validates product', /SELECT id, is_active, track_inventory FROM products WHERE id=\?/m.test(db)],
['inventory adjustment rejects zero', /!Number\.isFinite\(changeQty\) \|\| changeQty===0/m.test(db)],
['schema keeps unique invoice numbers', /invoice_number TEXT UNIQUE/m.test(schema)],
['main sale derives user identity', /const trustedSale = \{ \.\.\.sale, userId: currentUser\.id/m.test(main)],
];
let failed=0;for(const [n,ok] of checks){console.log(`${ok?'PASS':'FAIL'}: ${n}`);if(!ok)failed++;}
if(failed)process.exit(1);console.log(`V0.9 REGRESSION: PASS (${checks.length} checks)`);
