const fs=require('fs');
const path=require('path');
const root=path.join(__dirname,'..');
const db=fs.readFileSync(path.join(root,'database','db.js'),'utf8');
const schema=fs.readFileSync(path.join(root,'database','schema.sql'),'utf8');
const server=fs.readFileSync(path.join(root,'server','sync-server.js'),'utf8');
const client=fs.readFileSync(path.join(root,'database','sync-client.js'),'utf8');
const pkg=require(path.join(root,'package.json'));
const checks=[
 ['version is at least 0.21.0', /^0\.(?:2[1-9]|[3-9]\d)\./.test(pkg.version)],
 ['sync entities include payments',server.includes("'payments'" )],
 ['sync entities include cash movements',server.includes("'cash_movements'" )],
 ['sync entities include shifts',server.includes("'shifts'" )],
 ['sync entities include inventory movements',server.includes("'inventory_movements'" )],
 ['sync entities include supplier ledger',server.includes("'supplier_ledger'" )],
 ['sync entities include tax profiles',server.includes("'tax_profiles'" )],
 ['movement UUID migration',db.includes("tryAddColumn('inventory_movements', `uuid TEXT`)")],
 ['supplier ledger UUID migration',db.includes("tryAddColumn('supplier_ledger', `uuid TEXT`)")],
 ['sync mutex',client.includes('syncInFlight')],
 ['payment sync payload',db.includes('const paymentRows =')],
 ['cash movement sync payload',db.includes('const cashMovementRows =')],
 ['shift sync payload',db.includes('const shiftRows =')],
 ['inventory movement sync payload',db.includes('const inventoryMovementRows =')],
 ['tax profile sync payload',db.includes('const taxProfileRows =')],
 ['schema shift synced',schema.includes('synced INTEGER NOT NULL DEFAULT 0') && schema.includes('CREATE TABLE IF NOT EXISTS shifts')],
];

const movementInserts=(db.match(/INSERT INTO inventory_movements/gi)||[]).length;
const movementUuids=(db.match(/INSERT INTO inventory_movements\s*\(\s*uuid\b/gi)||[]).length;
checks.push(['all inventory movement inserts have sync UUID', movementInserts===movementUuids && movementInserts>=8]);
checks.push(['supplier ledger schema has synced flag', schema.includes('CREATE TABLE IF NOT EXISTS supplier_ledger') && schema.slice(schema.indexOf('CREATE TABLE IF NOT EXISTS supplier_ledger'), schema.indexOf('CREATE TABLE IF NOT EXISTS purchase_orders')).includes('synced INTEGER NOT NULL DEFAULT 0')]);

let ok=0; for(const [n,c] of checks){console.log((c?'PASS':'FAIL')+' - '+n); if(c)ok++;}
if(ok!==checks.length)process.exit(1); console.log(`V0.21 REGRESSION ${ok}/${checks.length} PASS`);
