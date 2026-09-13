const fs = require('fs');
const db = fs.readFileSync('database/db.js','utf8');
const main = fs.readFileSync('main.js','utf8');
const schema = fs.readFileSync('database/schema.sql','utf8');
const tests = [
  ['sale joins customer only from same branch', /LEFT JOIN customers c ON c\.id = s\.customer_id AND c\.branch_id = s\.branch_id/.test(db)],
  ['sale joins table only from same branch', /LEFT JOIN restaurant_tables t ON t\.id = s\.table_id AND t\.branch_id = s\.branch_id/.test(db)],
  ['open table validates current branch ownership', /SELECT id FROM restaurant_tables WHERE id=\? AND branch_id=\?/.test(db)],
  ['get open sale validates table ownership', /function getOpenSaleForTable\(tableId\)[\s\S]{0,260}restaurant_tables WHERE id=\? AND branch_id=\?/.test(db)],
  ['table payment uses actor user', /db\.closeTableSale\(saleId, trustedPayment, currentUser\.id(?:,\s*shift\?\.id \|\| null)?\)/.test(main)],
  ['close table records actor in payment ledger', /const createdBy = actorUserId \|\| sale\.user_id \|\| null/.test(db)],
  ['client request idempotency unique per branch', /UNIQUE INDEX IF NOT EXISTS idx_sales_branch_client_request ON sales\(branch_id, client_request_id\)/.test(schema)],
  ['branch-scoped inventory index exists', /idx_inventory_branch_product/.test(schema)],
];
let ok=0;
for (const [name, pass] of tests) { console.log(`${pass?'PASS':'FAIL'}: ${name}`); if(pass) ok++; }
if(ok!==tests.length) process.exit(1);
console.log(`V0.16 REGRESSION: PASS (${ok}/${tests.length})`);
