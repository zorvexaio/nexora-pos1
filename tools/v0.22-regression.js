const fs=require('fs');
const path=require('path');
const root=path.join(__dirname,'..');
const db=fs.readFileSync(path.join(root,'database','db.js'),'utf8');
const schema=fs.readFileSync(path.join(root,'database','schema.sql'),'utf8');
const server=fs.readFileSync(path.join(root,'server','sync-server.js'),'utf8');
const pkg=require(path.join(root,'package.json'));
const checks = [];
const add = (name, condition) => checks.push([name, Boolean(condition)]);
add('version compatible with v0.22 baseline', /^0\.(2[2-9]|[3-9][0-9])\./.test(pkg.version));
add('restaurant table sync entity', server.includes("'restaurant_tables'"));
add('restaurant table UUID migration', db.includes("tryAddColumn('restaurant_tables', `uuid TEXT`)"));
add('sale item UUID migration', db.includes("tryAddColumn('sale_items', `uuid TEXT`)"));
add('inventory movement unit cost after', db.includes("tryAddColumn('inventory_movements', `unit_cost_after REAL`)"));
add('product payload preserves tax profile UUID', db.includes('tp.uuid AS tax_profile_uuid'));
add('product payload preserves parent product UUID', db.includes('pp.uuid AS parent_product_uuid'));
add('sale item payload preserves tax profile UUID', db.includes('tp.uuid AS tax_profile_uuid FROM sale_items'));
add('sale sync preserves loyalty awarded', db.includes('loyalty_points_awarded'));
add('sale sync preserves loyalty reversed', db.includes('loyalty_points_reversed'));
add('return sync links exact sale item UUID', db.includes('sale_item_uuid'));
add('return sync applies store credit through ledger', db.includes("changes.store_credit_ledger") && db.includes("entryType: 'return_credit'"));
add('return sync idempotent before financial side effects', db.includes('if(!inserted.changes) continue; // idempotent'));
add('customer balance rebuild does not create sync loop', /UPDATE customers SET balance=.*synced=1/.test(db));
add('tax profiles applied before products', db.indexOf('// 1) tax profiles first') < db.indexOf('// 3) products first'));
add('sales applied before returns', db.indexOf('// 6) sales before returns/payments/ledgers') < db.indexOf('// 7) returns before payment_transactions'));
add('returns applied before store-credit ledger and payments', db.indexOf('// 7) returns before payment_transactions') < db.indexOf('// 8) store-credit ledger before payments') && db.indexOf('// 8) store-credit ledger before payments') < db.indexOf('// 9) payments/cash after their parents exist'));
add('purchase orders applied before supplier ledger', db.indexOf('// 5) purchase orders before supplier ledger') < db.indexOf('// 10) ledgers after their referenced sales/purchase orders exist.'));
// ملاحظة: own() صار يستقبل اسم الكيان (entity) كوسيط ثاني لتفعيل التحقق الصارم من
// ملكية الفرع لعمليات حركة المخزون (inventory_movements ضمن branchOwnedEntities) —
// تعزيز أمني حقيقي، لا مجرد تنسيق. حدّثنا نمط البحث ليطابق الاستدعاء الحالي.
add('inventory snapshot precedes movement delta', db.indexOf('// 9) inventory snapshot first') < db.indexOf("for(const im of own(changes.inventory_movements||[], 'inventory_movements')"));
add('inventory movement UUID insert', /INSERT INTO inventory_movements\s*\(uuid\b/.test(db));
const inventorySyncSection=db.slice(db.indexOf('// 9) inventory snapshot first'), db.indexOf('// 10) ledgers after their referenced sales/purchase orders exist'));
const inventorySnapshotSection=inventorySyncSection.slice(0, inventorySyncSection.indexOf("for(const im of own(changes.inventory_movements||[], 'inventory_movements')"));
add('inventory snapshot avoids absolute quantity overwrite and preserves newer local state', inventorySnapshotSection.includes('UPDATE inventory SET min_quantity=?,unit_cost=CASE WHEN ? THEN unit_cost ELSE COALESCE(?,unit_cost) END,updated_at=CASE WHEN ? THEN updated_at ELSE ? END,synced=1') && !inventorySnapshotSection.includes('UPDATE inventory SET quantity='));
const saleSchemaStart = schema.indexOf('CREATE TABLE IF NOT EXISTS sale_items');
const saleSchemaEnd = schema.indexOf('CREATE TABLE IF NOT EXISTS bundle_items');
add('sale item schema requires uuid', saleSchemaStart >= 0 && saleSchemaEnd > saleSchemaStart && schema.slice(saleSchemaStart, saleSchemaEnd).includes('uuid TEXT UNIQUE NOT NULL'));
const tableSchemaStart = schema.indexOf('CREATE TABLE IF NOT EXISTS restaurant_tables');
const tableSchemaEnd = schema.indexOf('CREATE INDEX IF NOT EXISTS idx_restaurant_tables_branch_name');
add('restaurant table schema has UUID metadata', tableSchemaStart >= 0 && tableSchemaEnd > tableSchemaStart && schema.slice(tableSchemaStart, tableSchemaEnd).includes('uuid TEXT UNIQUE NOT NULL'));

let ok = 0;
for (const [name, condition] of checks) {
  console.log((condition ? 'PASS' : 'FAIL') + ' - ' + name);
  if (condition) ok++;
}
if (ok !== checks.length) process.exit(1);
console.log(`V0.22 REGRESSION ${ok}/${checks.length} PASS`);
