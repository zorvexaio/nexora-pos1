const fs=require('fs');
const path=require('path');
const root=path.resolve(__dirname,'..');
const db=fs.readFileSync(path.join(root,'database','db.js'),'utf8');
const sync=fs.readFileSync(path.join(root,'server','sync-server.js'),'utf8');
const schema=fs.readFileSync(path.join(root,'database','schema.sql'),'utf8');
const syncClient=fs.readFileSync(path.join(root,'database','sync-client.js'),'utf8');
const pkg=require(path.join(root,'package.json'));
const checks=[
  ['version compatible with v0.23 baseline',/^0\.(2[3-9]|[3-9][0-9])\./.test(pkg.version)],
  ['remote inventory delta is always applied for a new UUID', db.includes('if(!inserted.changes)continue;') && db.includes('UPDATE inventory SET quantity=quantity+?')],
  ['remote inventory unit cost respects local newer timestamp', db.includes('const localIsNewer = localInv.updated_at && String(localInv.updated_at) > stamp')],
  ['remote customer balance recalculation does not mutate updated_at', db.includes("UPDATE customers SET balance=?,synced=1 WHERE id=? AND branch_id=?") && !db.includes("UPDATE customers SET balance=?,updated_at=datetime('now'),synced=1 WHERE id=? AND branch_id=?")],
  ['sync client mutex still present',syncClient.includes('let syncInFlight = null;')],
  ['sync server rejects cross-branch UUID collisions',sync.includes('UUID collision across branches')],
  ['foreign keys are enabled',db.includes("db.pragma('foreign_keys = ON')")],
  ['inventory movement UUID is unique',schema.includes('uuid TEXT UNIQUE NOT NULL') && schema.includes('CREATE TABLE IF NOT EXISTS inventory_movements')],
];
let failed=0;
for(const [name,ok] of checks){console.log(`${ok?'PASS':'FAIL'} ${name}`);if(!ok)failed++;}
if(failed) process.exit(1);
console.log(`v0.23 regression: ${checks.length}/${checks.length} PASS`);
