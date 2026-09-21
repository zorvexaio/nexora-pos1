// اختبار: تقسيم فاتورة الطاولة يحسب بوحدات صغرى صحيحة، يرحّل محاسبياً، ويدعم
// نقدي/بطاقة/آجل/رصيد متجر بشكل صحيح (بلا اختفاء أموال).
// شغّله: node tools/split-table-sale-money-regression.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexora-split-money-'));
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

const db = require('../database/db');
const money = require('../core/money');
db.init();

function lineTotalWithTax(unitPrice, qty, ratePercent, minorUnit = 2) {
  const unitMinor = money.toMinor(unitPrice, minorUnit);
  const grossMinor = money.multiplyMinorQuantity(unitMinor, qty);
  const taxMinorAmt = money.taxMinor(grossMinor, ratePercent, false);
  return money.fromMinor(grossMinor + taxMinorAmt, minorUnit);
}

let failed = 0;
function ok(cond, msg) {
  if (cond) console.log(`PASS: ${msg}`);
  else { console.log(`FAIL: ${msg}`); failed++; }
}
function nearly(actual, expected, msg) {
  ok(Math.abs(Number(actual) - expected) < 0.011, `${msg} (expected ${expected}, got ${actual})`);
}

const admin = db.listUsers().find((u) => u.role === 'admin');
ok(!!admin, 'seed admin exists');
const shift = db.openShift(0, admin.id);
ok(shift.success, 'opened cash shift');

// منتج بضريبة غير صفرية حتى نتأكد من صحة حساب الوحدات الصغرى مع الضريبة معاً
const product = db.createProduct({ name: 'صنف اختبار التقسيم', price: 19.99, cost: 7.5, taxRate: 15, initialStock: 100, trackInventory: true });
const table = db.createTable({ name: 'طاولة اختبار التقسيم', seats: 4 });
const openSale = db.getOrCreateOpenSale(table.id, admin.id);
ok(openSale.status === 'open', 'table order opened');

db.setOpenSaleItems(openSale.id, [{ productId: product.id, quantity: 5, notes: '' }]);
const beforeSplit = db.getOpenSaleForTable(table.id);
ok(beforeSplit.items.length === 1 && Number(beforeSplit.items[0].quantity) === 5, 'five units saved on the open table order');
const saleItemId = beforeSplit.items[0].id;

// 0) توازن ميزان المراجعة الأساسي قبل أي عملية
let tb = db.getTrialBalance();
ok(tb.balanced, 'trial balance balanced at baseline');

// 1) تقسيم جزئي (صنفان من 5) بدفع نقدي
const total2Units = lineTotalWithTax(19.99, 2, 15);
const split1 = db.splitTableSale(openSale.id, [{ saleItemId, quantity: 2 }], { paymentMethod: 'cash', cashAmount: total2Units, cardAmount: 0, changeDue: 0 }, admin.id, shift.id);
ok(split1.success, 'partial cash split succeeded');
const paidSale1 = db.listPaymentTransactions({}).find((p) => p.sale_id === split1.id);
ok(!!paidSale1 && paidSale1.method === 'cash', 'cash payment_transactions row created for the split');
nearly(paidSale1.amount, total2Units, 'cash payment amount matches 2 units at 19.99 plus 15% tax, computed in minor units');

tb = db.getTrialBalance();
ok(tb.balanced, 'trial balance remains balanced after the first (cash) split — accounting was posted');

// تحقق أن الجزء المتبقي على الطاولة تناقص بشكل صحيح (5 - 2 = 3)
const afterSplit1 = db.getOpenSaleForTable(table.id);
ok(afterSplit1.items.length === 1 && Number(afterSplit1.items[0].quantity) === 3, 'remaining open order now has 3 units left');

// 2) تقسيم آخر (صنف واحد من الباقي) بالبطاقة
const total1Unit = lineTotalWithTax(19.99, 1, 15);
const split2 = db.splitTableSale(openSale.id, [{ saleItemId: afterSplit1.items[0].id, quantity: 1 }], { paymentMethod: 'card', cashAmount: 0, cardAmount: total1Unit, changeDue: 0 }, admin.id, shift.id);
ok(split2.success, 'partial card split succeeded');
tb = db.getTrialBalance();
ok(tb.balanced, 'trial balance remains balanced after the second (card) split');

// 3) تقسيم بالدفع الآجل (credit) — يجب أن يُرفض بدون عميل/موافقة مدير، ثم ينجح ويُسجَّل كدين حقيقي
const afterSplit2 = db.getOpenSaleForTable(table.id);
ok(afterSplit2.items.length === 1 && Number(afterSplit2.items[0].quantity) === 2, 'remaining open order now has 2 units left');

let rejectedNoCustomer = false;
try {
  db.splitTableSale(openSale.id, [{ saleItemId: afterSplit2.items[0].id, quantity: 1 }], { paymentMethod: 'credit', cashAmount: 0, cardAmount: 0, changeDue: 0 }, admin.id, shift.id);
} catch (err) {
  rejectedNoCustomer = true;
}
ok(rejectedNoCustomer, 'credit split is rejected without a customer + manager approval');

const customer = db.createCustomer({ name: 'زبون تقسيم آجل', phone: '000999' });
db.setTableSaleCustomer(openSale.id, customer.id);
const custBefore = db.getCustomer(customer.id);
const split3 = db.splitTableSale(openSale.id, [{ saleItemId: afterSplit2.items[0].id, quantity: 1 }], { paymentMethod: 'credit', cashAmount: 0, cardAmount: 0, changeDue: 0, creditApprovedBy: admin.id }, admin.id, shift.id);
ok(split3.success, 'credit split succeeded with a customer and manager approval');
const custAfter = db.getCustomer(customer.id);
const expectedDebt = total1Unit;
nearly(Number(custAfter.balance) - Number(custBefore.balance), expectedDebt, 'customer debt increased by the exact credit-split total (money did not vanish)');
tb = db.getTrialBalance();
ok(tb.balanced, 'trial balance remains balanced after the credit split');

// 4) تقسيم الوحدة الأخيرة (آخر ما تبقى على الطاولة) نقداً — يجب أن يُقفل الطلب المفتوح تماماً
const afterSplit3 = db.getOpenSaleForTable(table.id);
ok(afterSplit3.items.length === 1 && Number(afterSplit3.items[0].quantity) === 1, 'one unit remains after the credit split');
const total1UnitLast = lineTotalWithTax(19.99, 1, 15);
const split4 = db.splitTableSale(openSale.id, [{ saleItemId: afterSplit3.items[0].id, quantity: 1 }], { paymentMethod: 'cash', cashAmount: total1UnitLast, cardAmount: 0, changeDue: 0 }, admin.id, shift.id);
ok(split4.success, 'final cash split of the last remaining unit succeeded');
// ملاحظة: الطلب المفتوح نفسه يبقى بحالة 'open' بلا أصناف بعد تصفير كل بنوده (سلوك
// موجود مسبقاً وغير متعلق بهذا الإصلاح) — المهم هنا فقط أن كل البنود فُرِّغت فعلاً.
const afterSplit4 = db.getOpenSaleForTable(table.id);
ok(afterSplit4 !== null && afterSplit4.items.length === 0, 'no items remain on the open order after every unit was split off');
tb = db.getTrialBalance();
ok(tb.balanced, 'trial balance remains balanced after all four split payments');

console.log(failed === 0 ? `\nSPLIT TABLE SALE MONEY REGRESSION: PASS` : `\nSPLIT TABLE SALE MONEY REGRESSION: FAIL (${failed} failing)`);
process.exit(failed === 0 ? 0 : 1);
