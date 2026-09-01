'use strict';
const fs = require('fs');
const main = fs.readFileSync('database/db.js','utf8');
const sync = fs.readFileSync('server/sync-server.js','utf8');
const pos = fs.readFileSync('renderer/index.html','utf8') + fs.readFileSync('renderer/pos.js','utf8');
const schema = fs.readFileSync('database/schema.sql','utf8');
const checks = [
  ['store credit has separate balance field', /store_credit_balance REAL NOT NULL DEFAULT 0/.test(schema)],
  ['sale supports store credit', /store_credit/.test(main)],
  ['store credit requires customer', /الدفع برصيد المتجر يتطلب اختيار عميل/.test(main)],
  ['return issues store credit instead of debt', /UPDATE customers SET store_credit_balance=/.test(main)],
  ['store credit payment ledger exists', /'store_credit'/.test(main)],
  ['store credit UI exists', /value="store_credit"/.test(pos)],
  ['customer ledger has UUID and sync', /customer_ledger[\s\S]{0,300}uuid TEXT/.test(schema) && /customer_ledger: customerLedgerRows/.test(main)],
  ['global sync entities are explicit', /GLOBAL_ENTITIES = new Set/.test(sync)],
  ['cross-branch UUID collision is rejected for owned data', /Sync UUID collision across branches/.test(sync)],
  ['global pull is deliberate', /branch_uuid = \? OR branch_uuid IS NULL/.test(sync)],
];
let failed=0; for(const [name,ok] of checks){console.log(`${ok?'PASS':'FAIL'}: ${name}`); if(!ok) failed++;}
if(failed) process.exit(1); console.log(`GLOBAL FINANCIAL REGRESSION: PASS (${checks.length} checks)`);
