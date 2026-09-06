const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexora-accounting-e2e-'));
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
db.init();

let failed = 0;
function ok(cond, msg) {
  if (cond) { console.log(`PASS: ${msg}`); }
  else { console.log(`FAIL: ${msg}`); failed++; }
}
function nearly(actual, expected, msg) {
  ok(Math.abs(Number(actual) - expected) < 0.011, `${msg} (expected ${expected}, got ${actual})`);
}

const admin = db.listUsers().find((u) => u.role === 'admin');
ok(!!admin, 'seed admin exists');
const shift = db.openShift(0, admin.id);
ok(shift.success, 'opened cash shift');

// 0) baseline trial balance is balanced before anything happens
let tb = db.getTrialBalance();
ok(tb.balanced, 'trial balance balanced at baseline (empty ledger)');

// 1) Sale (pre-existing posting, sanity check it still works)
const product = db.createProduct({ name: 'قلم', price: 10, cost: 4, initialStock: 100, trackInventory: true });
const customer = db.createCustomer({ name: 'زبون تجريبي', phone: '000111' });
const sale = db.createSale({
  items: [{ productId: product.id, quantity: 5 }], paymentMethod: 'cash', cashAmount: 50, cardAmount: 0,
  changeDue: 0, discountType: null, discountValue: 0, customerId: customer.id, userId: admin.id, shiftId: shift.id,
});
ok(!!sale && !!sale.id, 'cash sale created');

// 2) Purchase order (createPurchaseOrder receives immediately by default -> new posting point)
const supplier = db.createSupplier({ name: 'مورد تجريبي', phone: '000222' });
const po = db.createPurchaseOrder({
  supplierId: supplier.id, items: [{ productId: product.id, quantity: 20, unitCost: 4 }],
  paymentMethod: 'cash', paidAmount: 40, userId: admin.id, shiftId: shift.id,
});
ok(!!po && po.success !== false, 'purchase order created and received (partial cash, rest on credit)');

// 3) Supplier debt payment (new posting point)
const supplierAfterPO = db.listSuppliers().find((s) => s.id === supplier.id);
let supplierPayment = null;
if (supplierAfterPO && Number(supplierAfterPO.balance) > 0) {
  supplierPayment = db.paySupplierDebt({ supplierId: supplier.id, amount: Number(supplierAfterPO.balance), paymentMethod: 'cash', shiftId: shift.id, userId: admin.id });
  ok(supplierPayment.success, 'supplier debt payment posted');
} else {
  ok(false, `supplier had an outstanding balance to pay after PO (setup assumption) - balance was ${supplierAfterPO && supplierAfterPO.balance}`);
}

// 4) Credit sale + customer debt payment (new posting point)
const creditSale = db.createSale({
  items: [{ productId: product.id, quantity: 2 }], paymentMethod: 'credit', cashAmount: 0, cardAmount: 0,
  changeDue: 0, discountType: null, discountValue: 0, customerId: customer.id, userId: admin.id, shiftId: shift.id, creditApprovedBy: admin.id,
});
ok(!!creditSale && !!creditSale.id, 'credit sale created');
const custAfter = db.getCustomer(customer.id);
const custPayment = db.receiveCustomerPayment({ customerId: customer.id, amount: Number(custAfter.balance), paymentMethod: 'cash', shiftId: shift.id, userId: admin.id });
ok(custPayment.success, 'customer debt payment posted');

// 5) Return (new posting point) - return part of the first cash sale
const soldSale = db.getSale(sale.id);
const saleItemId = soldSale.items[0].id;
const ret = db.createReturn({
  saleId: sale.id, items: [{ saleItemId, quantity: 1 }], refundMethod: 'cash', userId: admin.id, shiftId: shift.id,
});
ok(!!ret && (ret.success !== false), 'return processed');

// 6) Payroll: create employee, month, recalc, pay salary (new posting point)
let payrollOk = false;
try {
  const empResult = db.addPayrollV2Employee('موظف تجريبي', 'كاشير', 'monthly', 300);
  ok(empResult.success, 'payroll employee created');
  const monthKey = new Date().toISOString().slice(0, 7);
  const month = db.getOrCreatePayrollMonth(monthKey, admin.id);
  const recalced = db.getPayrollV2Employee(month.id, empResult.id).employee;
  ok(Number(recalced.net_salary) > 0, `payroll month recalculated (net_salary=${recalced.net_salary})`);
  const pay = db.recordPayrollPayment({ monthId: month.id, employeeId: empResult.id, amount: recalced.net_salary, method: 'cash', createdBy: admin.id });
  // ^ intentionally NOT passing paymentDate here: this reproduces the exact bug found
  // during review (payrollTodayLocal() returned a Date object, not a 'YYYY-MM-DD' string,
  // so the default path always threw). Fixed in database/db.js line ~4625.
  payrollOk = !!pay && pay.success;
} catch (e) {
  console.log('FAIL: payroll flow threw an error:', e.message);
  failed++;
}
ok(payrollOk, 'payroll salary payment posted');

// ---- Core financial checks ----
tb = db.getTrialBalance();
console.log('Trial balance accounts:', tb.accounts.filter(a => a.debit || a.credit).map(a => `${a.code} ${a.name}: D${a.debit} C${a.credit}`).join(' | '));
ok(tb.balanced, `trial balance balanced after all postings (totalDebit=${tb.totalDebit}, totalCredit=${tb.totalCredit})`);

const bs = db.getBalanceSheet();
ok(bs.balanced, `balance sheet balanced (assets=${bs.totalAssets}, liab+equity=${bs.totalLiabilities + bs.totalEquity})`);

const is = db.getIncomeStatement();
console.log('Income statement: revenue=', is.totalRevenue, 'expense=', is.totalExpense, 'netIncome=', is.netIncome);

// Account ledger sanity: cash account should have multiple lines
const cashAccount = db.listAccountingAccounts().find((a) => a.code === '1000');
const ledger = db.getAccountLedger(cashAccount.id);
ok(ledger.rows.length >= 3, `cash account ledger has multiple entries (${ledger.rows.length})`);

// ---- Period lock behavior ----
const todayKey = new Date().toISOString().slice(0, 7);
const lockResult = db.lockAccountingPeriod(todayKey, admin.id);
ok(lockResult.success, 'current period locked');
let rejected = false;
try {
  db.postJournalEntry({
    memo: 'قيد يدوي بعد القفل', lines: [
      { accountId: cashAccount.id, debitMinor: 100, creditMinor: 0 },
      { accountId: db.listAccountingAccounts().find(a => a.code === '3000').id, debitMinor: 0, creditMinor: 100 },
    ],
  });
} catch (e) {
  rejected = true;
  ok(/مقفلة/.test(e.message), 'locked-period rejection message is the expected one');
}
ok(rejected, 'posting into a locked period is rejected');
const reopen = db.reopenAccountingPeriod(todayKey, admin.id, 'اختبار إعادة فتح فترة لأغراض المراجعة');
ok(reopen.success, 'period reopened with a valid reason');

console.log(failed === 0 ? `\nALL PASS (0 failures)` : `\n${failed} FAILURE(S)`);
process.exit(failed === 0 ? 0 : 1);
