const fs=require('fs');
const path=require('path');
const db=fs.readFileSync(path.join(__dirname,'..','database','db.js'),'utf8');
const main=fs.readFileSync(path.join(__dirname,'..','main.js'),'utf8');
const pos=fs.readFileSync(path.join(__dirname,'..','renderer','pos.js'),'utf8');
const schema=fs.readFileSync(path.join(__dirname,'..','database','schema.sql'),'utf8');
const checks=[
 ['sale idempotency migration',/client_request_id TEXT/.test(db)&&/idx_sales_branch_client_request/.test(db)],
 ['sale returns existing request',/SELECT id, uuid, invoice_number FROM sales WHERE branch_id=\? AND client_request_id=\?/.test(db)&&/idempotent: true/.test(db)],
 ['renderer sends stable request id',/clientRequestId:\s*pendingSaleRequestId/.test(pos)&&/let pendingSaleRequestId = null/.test(pos)],
 ['auth password rate limiting',/AUTH_MAX_ATTEMPTS/.test(db)&&/rateLimited/.test(main)&&/checkAuthRateLimit\(key\)/.test(db)],
 ['pin rate limiting',/key = `pin:\$\{branch\.id\}`/.test(db)],
 ['refund method validation',/!\['cash','card','store_credit'\]\.includes\(refundMethod\)/.test(db)],
 ['loyalty refund does not double-count current return',/id<>\?/.test(db)&&/totalRefunded \+ Number\(priorRefunded/.test(db)],
 ['schema has request id',/client_request_id TEXT/.test(schema)],
 ['version remains compatible with v0.12 contract',/^0\.(?:1[2-9]|[2-9]\d)\.\d+$/.test(JSON.parse(fs.readFileSync(path.join(__dirname,'..','package.json'),'utf8')).version)]
];
let ok=true; for(const [n,v] of checks){console.log(`${v?'PASS':'FAIL'} ${n}`); if(!v)ok=false;} if(!ok)process.exit(1); console.log('v0.12 regression: PASS');
