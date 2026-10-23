// اختبار سلوكي حقيقي لدمج الطاولات وتقسيم الطلب على قاعدة بيانات مؤقتة (بدون فحص نصوص المصدر).
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const root = path.resolve(__dirname, '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexora-table-behavior-'));
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') {
    return {
      app: { getPath: () => dataDir },
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (value) => Buffer.from(String(value), 'utf8'),
        decryptString: (value) => Buffer.from(value).toString('utf8'),
      },
    };
  }
  return originalLoad.apply(this, arguments);
};

const db = require(path.join(root, 'database', 'db'));
db.init();

let failures = 0;
function check(name, condition, detail = '') {
  if (condition) console.log(`PASS: ${name}`);
  else { failures += 1; console.log(`FAIL: ${name}${detail ? ' — ' + detail : ''}`); }
}

const admin = db.listUsers().find((u) => u.role === 'admin');
const shift = db.openShift(0, admin.id);
const product = db.createProduct({ name: 'Behavior product', price: 25, cost: 10, initialStock: 50, trackInventory: true });
const productId = product.id;
db.createTable({ name: 'BEH-A', seats: 4 });
db.createTable({ name: 'BEH-B', seats: 4 });
const tables = db.listTables();
const tableA = tables.find((t) => t.name === 'BEH-A').id;
const tableB = tables.find((t) => t.name === 'BEH-B').id;

const saleA = db.getOrCreateOpenSale(tableA, admin.id);
db.setOpenSaleItems(saleA.id, [{ productId, quantity: 3 }]);
const saleB = db.getOrCreateOpenSale(tableB, admin.id);
db.setOpenSaleItems(saleB.id, [{ productId, quantity: 2 }]);

// --- الدمج ---
const merged = db.mergeTables(tableA, tableB, admin.id);
check('merge reports success', merged && merged.success !== false, JSON.stringify(merged).slice(0, 160));
const openAfter = db.getOpenSaleForTable(tableB);
check('merged order is open on target table', !!openAfter);
check('merged subtotal = 5 units x 25', openAfter && Number(openAfter.subtotal) === 125, `subtotal=${openAfter && openAfter.subtotal}`);
check('source table has no open order after merge', !db.getOpenSaleForTable(tableA));

const detail = db.getSale(openAfter.id, db.getCurrentBranch().id);
const items = (detail && detail.items) || [];
const qtyTotal = items.reduce((sum, i) => sum + Number(i.quantity || 0), 0);
check('merged quantities add up to 5', qtyTotal === 5, `quantity=${qtyTotal}`);
check('merged items keep historical cost 10', items.length > 0 && items.every((i) => Number(i.cost_at_sale) === 10),
  JSON.stringify(items.map((i) => i.cost_at_sale)));

// --- التقسيم ---
const item = items[0];
const split = db.splitTableSale(openAfter.id, [{ saleItemId: item.id, quantity: 2 }],
  { paymentMethod: 'cash', cashAmount: 50, cardAmount: 0, changeDue: 0 }, admin.id, shift.id);
check('split succeeds', split && split.success !== false, JSON.stringify(split).slice(0, 200));
const remaining = db.getOpenSaleForTable(tableB);
check('remaining order keeps 3 units (75)', remaining && Number(remaining.subtotal) === 75, `subtotal=${remaining && remaining.subtotal}`);
const paidSaleId = split && (split.paidSaleId ?? split.saleId ?? split.id);
const paidDetail = paidSaleId ? db.getSale(paidSaleId, db.getCurrentBranch().id) : null;
check('paid part is 2 units x 25 = 50', paidDetail && Number(paidDetail.grand_total) === 50,
  `grand_total=${paidDetail && paidDetail.grand_total}`);

if (failures) { console.log(`TABLE MERGE/SPLIT BEHAVIOR: ${failures} FAILED`); process.exit(1); }
console.log('TABLE MERGE/SPLIT BEHAVIOR: PASS');
