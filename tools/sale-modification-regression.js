const fs=require('fs'),path=require('path');const root=path.resolve(__dirname,'..');
const db=fs.readFileSync(path.join(root,'database','db.js'),'utf8');
const main=fs.readFileSync(path.join(root,'main.js'),'utf8');
const preload=fs.readFileSync(path.join(root,'preload.js'),'utf8');
const ui=fs.readFileSync(path.join(root,'renderer','pages','returns.js'),'utf8');
const html=fs.readFileSync(path.join(root,'renderer','pages','returns.html'),'utf8');
const checks=[
 ['atomic item modification transaction',/const modifyCompletedSaleItemsTx\s*=\s*db\.transaction/.test(db)],
 ['same sale record is updated',/UPDATE sales SET subtotal=.*WHERE id=\? AND branch_id=\?/.test(db)],
 ['same invoice identity preserved',/invoiceNumber:sale\.invoice_number/.test(db)&&!/nextInvoiceNumber\(\)/.test(db.slice(db.indexOf('const modifyCompletedSaleItemsTx'),db.indexOf('function modifyCompletedSaleItems')))],
 ['fully returned lines rejected',/rq\s*>=\s*Number\(item\.quantity\)/.test(db)&&/مُرجع بالكامل/.test(db)],
 ['before after audit snapshot',/action:'sale_items_modified'/.test(db)&&/before:/.test(db)&&/after:/.test(db)],
 ['inventory reversal and reapply',/sale_modification_reverse/.test(db)&&/sale_modification/.test(db)],
 ['manager admin IPC gate',/ipcMain\.handle\('sales:modifyItems',[\s\S]*requireManagerOrAdmin\(\)/.test(main)],
 ['preload modification API',/modifyItems:\s*\(payload\)\s*=>\s*ipcRenderer\.invoke\('sales:modifyItems'/.test(preload)],
 ['returns UI has modify workflow',/openModifier/.test(ui)&&/modifyProductGrid/.test(html)],
 ['accounting normalizes DB snake_case sale rows',/paymentMethod: sale\.paymentMethod \?\? sale\.payment_method/.test(db)&&/grandTotalMinor: Number\(sale\.grandTotalMinor \?\? sale\.grand_total_minor/.test(db)],
 ['returned quantity floor enforced',/returnedQtyByProduct/.test(db)&&/newQty \+ 1e-9 < returnedQty/.test(db)],
 ['kitchen delta is returned from transaction',/kitchenDeltaItems/.test(db)&&/return \{sale:getSale\(saleId,branch\.id\),invoiceNumber:sale\.invoice_number,kitchenDeltaItems\}/.test(db)],
 ['modify discount fields and categories UI',/modifyCategoryTabs/.test(html)&&/modifyDiscountType/.test(html)&&/modifyDiscountValue/.test(html)],
 ['modify UI uses catalog product price',/price:Number\(p\?\.price \?\? fallbackPrice \?\? 0\)/.test(ui)],
 ['payment correction posts settlement reclassification',/referenceType: 'sale_payment_method_correction'/.test(db)&&/settlementLegs/.test(db)&&/oldSettlement/.test(db)&&/newSettlement/.test(db)],
 ['item modification reverses prior payment corrections',/reference_type IN \(\'sale\',\'sale_payment_method_correction\'\)/.test(db)],
];
let bad=0;for(const [m,c] of checks){if(c)console.log('PASS:',m);else{console.error('FAIL:',m);bad++;}}if(bad)process.exit(1);console.log(`SALE MODIFICATION REGRESSION: PASS ${checks.length}/${checks.length}`);
