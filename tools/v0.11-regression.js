const fs=require('fs');
const path=require('path');
const db=fs.readFileSync(path.join(__dirname,'..','database','db.js'),'utf8');
const schema=fs.readFileSync(path.join(__dirname,'..','database','schema.sql'),'utf8');
const checks=[
  ['inventory schema has branch unit cost', /unit_cost REAL NOT NULL DEFAULT 0/.test(schema)],
  ['legacy migration adds branch unit cost once', /const inventoryUnitCostAdded = tryAddColumn\('inventory'/.test(db) && /if \(inventoryUnitCostAdded\)/.test(db)],
  ['sale pricing reads branch unit cost', /COALESCE\(i\.unit_cost, p\.cost, 0\) AS branch_cost/.test(db)],
  ['sale item snapshots branch cost', /costAtSale: Math\.max\(0, Number\(product\.branch_cost/.test(db)],
  ['purchase receiving updates branch unit cost', /unit_cost=excluded\.unit_cost/.test(db)],
  ['purchase weighted cost uses branch inventory cost', /stockRow\?\.unit_cost/.test(db)],
  ['remote inventory snapshot preserves unit cost with timestamp guard', /UPDATE inventory SET min_quantity=\?,unit_cost=CASE WHEN \? THEN unit_cost ELSE COALESCE\(\?,unit_cost\) END,updated_at=CASE WHEN \? THEN updated_at ELSE \? END/.test(db) && /inventory_movements[\s\S]*unit_cost_after/.test(db)],
  ['open table snapshots branch cost', /COALESCE\(i\.unit_cost,p\.cost,0\) AS branch_cost/.test(db) && /costAtSale:Math\.max\(0,Number\(product\.branch_cost/.test(db)] ,
];
let failed=0;for(const [name,ok] of checks){console.log(`${ok?'PASS':'FAIL'}: ${name}`);if(!ok)failed++;}
if(failed){process.exitCode=1;console.error(`V0.11 REGRESSION: ${failed} failed`);}else console.log('V0.11 REGRESSION: PASS (8 checks)');
