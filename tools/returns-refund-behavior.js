// اختبار سلوكي للمرتجعات على قاعدة بيانات مؤقتة: المسترد الجزئي يساوي صافي ما دُفع بالضبط،
// والمخزون يعود، والإرجاع بأكثر من الكمية المباعة مرفوض.
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const root = path.resolve(__dirname, '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexora-returns-behavior-'));
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
const near = (a, b) => Math.abs(Number(a) - b) < 0.011;

const admin = db.listUsers().find((u) => u.role === 'admin');
const shift = db.openShift(0, admin.id);
const product = db.createProduct({ name: 'Return product', price: 25, cost: 10, initialStock: 20, trackInventory: true });
const stockOf = () => Number(db.listProducts({}).find((p) => p.id === product.id).stock);

const sale = db.createSale({
  items: [{ productId: product.id, quantity: 3 }], paymentMethod: 'cash', cashAmount: 75, cardAmount: 0,
  changeDue: 0, discountType: null, discountValue: 0, userId: admin.id, shiftId: shift.id,
});
const saleItem = db.getSale(sale.id, db.getCurrentBranch().id).items[0];
check('sale recorded with 3 units, paid 75', near(db.getSale(sale.id, db.getCurrentBranch().id).grand_total, 75));

// --- مرتجع جزئي: قطعة واحدة ---
const r1 = db.createReturn({ saleId: sale.id, userId: admin.id, shiftId: shift.id, refundMethod: 'cash', reason: 'part1',
  items: [{ saleItemId: saleItem.id, quantity: 1 }] });
check('partial return 1 succeeds', r1 && r1.id != null, JSON.stringify(r1).slice(0, 160));
const after1 = db.getReturn(r1.id);
check('first piece refunds 25', near(after1.total_refunded ?? after1.totalRefunded, 25), JSON.stringify(after1).slice(0, 200));

// --- مرتجع ثانٍ: القطعتان الباقيتان، والأخيرة تأخذ الباقي بالضبط ---
const r2 = db.createReturn({ saleId: sale.id, userId: admin.id, shiftId: shift.id, refundMethod: 'cash', reason: 'part2',
  items: [{ saleItemId: saleItem.id, quantity: 2 }] });
const after2 = db.getReturn(r2.id);
check('remaining two pieces refund 50', near(after2.total_refunded ?? after2.totalRefunded, 50), JSON.stringify(after2).slice(0, 200));

// --- الإرجاع بأكثر من المتبقي مرفوض ---
let overRejected = false;
try {
  db.createReturn({ saleId: sale.id, userId: admin.id, shiftId: shift.id, refundMethod: 'cash', reason: 'over',
    items: [{ saleItemId: saleItem.id, quantity: 1 }] });
} catch (e) { overRejected = true; }
check('returning more than sold is rejected', overRejected);

// --- المخزون: بدأ 20، بيع 3 فصار 17، ثم رجعت الـ3 فصار 20 ---
const stock = stockOf();
check('stock fully restored to 20 after all returns', stock === 20, `stock=${stock}`);

if (failures) { console.log(`RETURNS REFUND BEHAVIOR: ${failures} FAILED`); process.exit(1); }
console.log('RETURNS REFUND BEHAVIOR: PASS');
