// Operating-expense invoices ("مصروف تشغيلي") in the Suppliers area (needs native SQLite).
// Acceptance scenarios from the brief, in 0 / 2 / 3-decimal currencies:
//   6) electricity 500 cash  -> drawer -500, inventory untouched, Dr expense / Cr cash
//   7) rent 2000 on credit   -> supplier balance +2000, no inventory, Dr expense / Cr accounts payable
//   8) later payment 2000    -> drawer and balance down, Dr accounts payable / Cr cash
// plus: card, partial payment, custom categories, validation, audit trail, goods purchases unchanged,
// operating expenses separate from COGS/inventory in the reports, and sync of the new fields.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CURRENCIES = [{ code: 'USD', minor: 2 }, { code: 'KWD', minor: 3 }, { code: 'JPY', minor: 0 }];

if (process.argv[2] !== '--child') {
  let failed = 0;
  for (const c of CURRENCIES) {
    const r = spawnSync(process.execPath, [__filename, '--child', c.code], { encoding: 'utf8' });
    process.stdout.write(r.stdout || '');
    if (r.status !== 0) { failed++; process.stderr.write(r.stderr || ''); }
  }
  if (failed) { console.error('EXPENSE INVOICE REGRESSION: FAIL'); process.exit(1); }
  console.log('EXPENSE INVOICE REGRESSION: PASS');
  process.exit(0);
}

const Module = require('node:module');
const cur = CURRENCIES.find((c) => c.code === process.argv[3]);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexora-expense-'));
const originalLoad = Module._load;
Module._load = function (request) {
  if (request === 'electron') return { app: { getPath: () => dataDir }, safeStorage: { isEncryptionAvailable: () => true, encryptString: (v) => Buffer.from(String(v)), decryptString: (v) => Buffer.from(v).toString('utf8') } };
  return originalLoad.apply(this, arguments);
};
const db = require('../database/db');
const scale = 10 ** cur.minor;
const near = (a, b, msg) => assert.ok(Math.abs(Number(a) - Number(b)) < 0.5 / scale, `${msg}: expected ${b}, got ${a}`);
const acct = (code) => {
  const a = db.getTrialBalance().accounts.find((x) => x.code === code);
  return { debit: Number(a?.debit || 0), credit: Number(a?.credit || 0) };
};
const net = (code) => { const a = acct(code); return a.debit - a.credit; };
let checks = 0;
const ok = (c, m) => { assert.ok(c, m); checks++; };

try {
  db.init();
  const admin = db.listUsers().find((u) => u.role === 'admin');
  const base = db.getGlobalProfile();
  db.setGlobalProfile({ countryCode: base.country_code, locale: base.locale, timezone: base.timezone, currencyCode: cur.code, currencyMinorUnit: cur.minor, taxMode: 'exclusive', taxRegistrationNumber: '', fiscalizationMode: 'none', fiscalProvider: '' });
  const shift = db.openShift(10000 / (cur.minor === 0 ? 1 : 1), admin.id);
  assert.ok(shift.success);
  const sid = shift.id ?? db.getOpenShift().id;
  const supplier = db.createSupplier({ name: 'مؤسسة الخدمات' });
  const landlord = db.createSupplier({ name: 'المالك' });
  const money500 = 500, money2000 = 2000;

  // ---- categories ----
  const cats = db.listExpenseCategories();
  ok(cats.length === 10 && cats.some((c) => c.name === 'كهرباء') && cats.some((c) => c.name === 'إيجار المحل') && cats.some((c) => c.name === 'أخرى'), 'ten default categories (rent, electricity, water, internet, maintenance, cleaning, transport, fees, marketing, other)');
  const electricity = cats.find((c) => c.name === 'كهرباء'), rent = cats.find((c) => c.name === 'إيجار المحل'), water = cats.find((c) => c.name === 'ماء');
  ok(electricity.account_code !== rent.account_code, 'every category has its own expense account');

  // baseline
  const goodsProduct = db.createProduct({ name: 'بضاعة', price: 10, cost: 5, taxRate: 0, trackInventory: true });
  const goodsPo = db.createPurchaseOrder({ supplierId: supplier.id, items: [{ productId: goodsProduct.id, quantity: 10, unitCost: 5 }], paidAmount: 0, paymentMethod: 'credit', userId: admin.id, shiftId: sid });
  ok(goodsPo.success !== false, 'goods purchase still works');
  const invBefore = net('1300');
  const stockRows = () => db.listInventory ? db.listInventory() : null;
  const cashBefore = db.getShiftSummary(sid).expectedCash;
  const movementsBefore = db.getShiftCashMovements(sid).length;
  const apBefore = net('2000');
  ok(Math.abs(invBefore - 50) < 0.5 / scale, 'goods purchase put 50.00 into inventory account (baseline)');

  // ---- 6) electricity, cash ----
  const e1 = db.createExpenseInvoice({ supplierId: supplier.id, categoryId: electricity.id, amount: money500, paymentMethod: 'cash', invoiceDate: '2026-09-15', referenceNumber: 'EL-1', notes: 'فاتورة أيلول', userId: admin.id, shiftId: sid });
  ok(e1.success && e1.cashMovementRecorded === true, 'cash expense records a cash movement');
  near(db.getShiftSummary(sid).expectedCash, cashBefore - money500, 'cash drawer decreased by the expense');
  ok(db.getShiftCashMovements(sid).length === movementsBefore + 1, 'exactly one cash-out movement');
  near(net('1300'), invBefore, 'inventory account untouched by an expense');
  near(net('2000'), apBefore, 'cash expense creates no payable');
  near(acct(electricity.account_code).debit, money500, 'expense account debited with the amount');
  near(supplier && db.listSuppliers().find((s) => s.id === supplier.id).balance, 250 * 0 + 50, 'supplier balance unchanged by a cash-paid expense (only the goods purchase remains: 50)');
  const po1 = db.getPurchaseOrder(e1.id);
  ok(po1.invoice_type === 'expense' && po1.expense_category_name === 'كهرباء' && po1.invoice_date === '2026-09-15' && po1.reference_number === 'EL-1' && (po1.items || []).length === 0, 'expense invoice has type, category, date, reference and NO items');
  ok(db.getTrialBalance().balanced, 'ledger balanced');
  const logs = db.listAuditLogs(50);
  ok(logs.some((l) => l.action === 'expense_invoice_created' && String(l.entity_id) === String(e1.id)) && logs.some((l) => l.action === 'expense_invoice_payment' && String(l.entity_id) === String(e1.id)), 'audit: invoice creation and its payment are both logged');

  // ---- 7) rent on credit ----
  const supplierBefore = Number(db.listSuppliers().find((s) => s.id === landlord.id).balance);
  const cashMid = db.getShiftSummary(sid).expectedCash;
  const e2 = db.createExpenseInvoice({ supplierId: landlord.id, categoryId: rent.id, amount: money2000, paymentMethod: 'credit', userId: admin.id, shiftId: sid });
  near(db.listSuppliers().find((s) => s.id === landlord.id).balance, supplierBefore + money2000, 'credit rent raises the supplier balance by 2000');
  near(db.getShiftSummary(sid).expectedCash, cashMid, 'credit expense does not touch the drawer');
  near(net('2000'), apBefore - money2000, 'accounts payable credited with 2000');
  near(acct(rent.account_code).debit, money2000, 'rent account debited with 2000');
  near(net('1300'), invBefore, 'inventory still untouched');
  ok(db.getPurchaseOrder(e2.id).invoice_type === 'expense', 'rent invoice stored as expense');

  // ---- 8) later payment ----
  const pay = db.paySupplierDebt({ supplierId: landlord.id, amount: money2000, paymentMethod: 'cash', userId: admin.id, shiftId: sid });
  ok(pay.success && pay.cashMovementRecorded === true, 'later payment recorded');
  near(db.listSuppliers().find((s) => s.id === landlord.id).balance, 0, 'supplier balance back to 0');
  near(db.getShiftSummary(sid).expectedCash, cashMid - money2000, 'drawer decreased by the later payment');
  near(net('2000'), apBefore, 'accounts payable cleared');
  ok(db.getTrialBalance().balanced, 'ledger balanced after payment');

  // ---- card + partial ----
  const bankBefore = net('1100');
  db.createExpenseInvoice({ supplierId: supplier.id, categoryId: water.id, amount: 300, paymentMethod: 'card', userId: admin.id, shiftId: sid });
  near(net('1100'), bankBefore - 300, 'card expense credits the bank account');
  const supBefore = Number(db.listSuppliers().find((s) => s.id === supplier.id).balance);
  db.createExpenseInvoice({ supplierId: supplier.id, categoryId: water.id, amount: 300, paymentMethod: 'cash', paidAmount: 100, userId: admin.id, shiftId: sid });
  near(db.listSuppliers().find((s) => s.id === supplier.id).balance, supBefore + 200, 'partial payment leaves the remainder on the supplier');

  // ---- custom category ----
  const custom = db.saveExpenseCategory({ name: 'اشتراك برنامج' });
  ok(custom.success && Number(custom.accountCode) >= 6300, 'custom category gets its own account in the 6300+ range');
  assert.throws(() => db.saveExpenseCategory({ name: 'اشتراك برنامج' }), /مستخدم/, 'duplicate category name rejected');
  db.createExpenseInvoice({ supplierId: supplier.id, categoryId: custom.id, amount: 40, paymentMethod: 'credit', userId: admin.id, shiftId: sid });
  near(acct(custom.accountCode).debit, 40, 'custom category posts to its own account');
  db.saveExpenseCategory({ id: custom.id, name: 'اشتراك برنامج', isActive: false });
  assert.throws(() => db.createExpenseInvoice({ supplierId: supplier.id, categoryId: custom.id, amount: 1, paymentMethod: 'credit', userId: admin.id, shiftId: sid }), /فئة مصروف صالحة/, 'inactive category rejected');

  // ---- validation ----
  const bad = (payload, re, msg) => assert.throws(() => db.createExpenseInvoice({ supplierId: supplier.id, categoryId: electricity.id, paymentMethod: 'credit', userId: admin.id, shiftId: sid, amount: 10, ...payload }), re, msg);
  bad({ amount: 0 }, /أكبر من صفر|غير صالح/, 'zero amount');
  bad({ amount: -5 }, /غير صالح/, 'negative amount');
  bad({ amount: 'abc' }, /غير صالح/, 'non-numeric amount');
  bad({ paymentMethod: 'cash', paidAmount: 11 }, /أكبر من مبلغ المصروف/, 'paid more than the invoice');
  bad({ paymentMethod: 'crypto' }, /طريقة الدفع/, 'unknown payment method');
  bad({ supplierId: 999999 }, /مورداً صالحاً/, 'unknown supplier');
  bad({ categoryId: 999999 }, /فئة مصروف صالحة/, 'unknown category');
  bad({ paymentMethod: 'cash', shiftId: null }, /وردية/, 'cash expense needs an open shift');
  ok(db.getTrialBalance().balanced, 'failed attempts left the ledger balanced and untouched');

  // ---- reports: separate from COGS / inventory ----
  const summary = db.getOperatingExpensesSummary({ from: '2026-01-01', to: '2099-12-31' });
  const expectedTotal = money500 + money2000 + 300 + 300 + 40;
  near(summary.total, expectedTotal, 'operating-expense summary total');
  ok(summary.byCategory.find((c) => c.name === 'كهرباء')?.total === money500 && summary.byCategory.find((c) => c.name === 'ماء')?.count === 2, 'summary grouped by category');
  ok(!summary.byCategory.some((c) => c.name === 'بضاعة'), 'goods purchases are not counted as operating expenses');
  const pl = db.getProfitLoss({ from: '2000-01-01', to: '2099-12-31' });
  near(pl.operatingExpenses, expectedTotal, 'profit & loss reports operating expenses separately');
  near(pl.cost, 0, 'cost of goods sold not polluted by expenses');
  near(pl.netProfit, 0 - pl.payrollExpense - expectedTotal, 'net profit is reduced by operating expenses');
  near(net('5000'), 0, 'COGS account untouched');

  // ---- listing + sync ----
  const list = db.listPurchaseOrders();
  ok(list.filter((p) => p.invoice_type === 'expense').length === 5 && list.filter((p) => p.invoice_type === 'goods').length === 1, 'invoice list carries the type (goods vs expense)');
  const payload = db.syncPayload();
  const sent = payload.changes.purchase_orders.find((p) => p.uuid === po1.uuid);
  ok(sent && sent.invoice_type === 'expense' && sent.expense_category_name === 'كهرباء' && sent.reference_number === 'EL-1', 'sync payload carries the expense fields');
  const clone = JSON.parse(JSON.stringify(sent));
  clone.uuid = `${clone.uuid}-copy`;
  db.applyRemoteChanges({ purchase_orders: [clone] });
  const copy = db.listPurchaseOrders().find((p) => p.uuid === clone.uuid);
  ok(copy && copy.invoice_type === 'expense' && copy.expense_category_name === 'كهرباء' && copy.invoice_date === '2026-09-15', 'receiving device keeps type, category and date');
  assert.throws(() => db.receivePurchaseOrder(e1.id, {}), /تم التعامل|لا تُستلم/, 'an expense invoice can never be "received" into stock');

  console.log(`PASS: ${cur.code} (${cur.minor} decimals) - ${checks} checks (cash / credit / later payment / card / partial / categories / validation / audit / reports / sync)`);
} finally {
  try { db.closeDatabase(); } catch (_) {}
  try { fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch (_) {}
}
