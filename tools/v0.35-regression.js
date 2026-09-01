const fs=require('fs'),path=require('path');
const root=path.join(__dirname,'..');
const db=fs.readFileSync(path.join(root,'database','db.js'),'utf8');
const schema=fs.readFileSync(path.join(root,'database','schema.sql'),'utf8');
const server=fs.readFileSync(path.join(root,'server','sync-server.js'),'utf8');
const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
function ok(c,m){if(!c)throw new Error('FAIL: '+m); console.log('PASS: '+m);}
ok(schema.includes('CREATE TABLE IF NOT EXISTS store_credit_ledger'),'store credit ledger schema exists');
ok(db.includes('appendStoreCreditLedger') && db.includes("entryType: 'sale_spend'") && db.includes("entryType: 'return_credit'"),'local store-credit changes use event deltas');
ok(db.includes('storeCreditLedgerRows') && db.includes('store_credit_ledger: storeCreditLedgerRows'),'store credit ledger is in sync payload');
ok(db.includes('changes.store_credit_ledger'),'remote store-credit ledger events are applied');
ok(!db.includes('store_credit_balance=excluded.store_credit_balance'),'customer sync no longer overwrites store-credit snapshot');
ok(server.includes("'store_credit_ledger'"),'central sync accepts store-credit ledger');
ok(db.includes('foreign(changes.store_credit_ledger)'),'store-credit ledger is protected by branch isolation');
ok(db.includes('recalcStoreCreditBalance(customerId,branchId,false)'),'remote events rebuild balance without synthetic local timestamp');
const versionFile=fs.readFileSync(path.join(root,'docs','VERSION.txt'),'utf8').trim();
ok(versionFile===`Nexora POS v${pkg.version}`,'package version matches VERSION.txt');
console.log('v0.35 regression: 9/9 PASS');
