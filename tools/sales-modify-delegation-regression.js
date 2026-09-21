// "تعديل الفواتير" for cashiers: an administrator ticks a checkbox next to the user (with a mandatory reason).
// Covers the DB rules, the wiring in main.js / users / returns pages, and the improved invoice list
// used by the Returns area (completed + partially refunded only, customer name, payment method, safe search).
// Needs native SQLite.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexora-deleg-'));
const originalLoad = Module._load;
Module._load = function (request) {
  if (request === 'electron') return { app: { getPath: () => dataDir }, safeStorage: { isEncryptionAvailable: () => true, encryptString: (v) => Buffer.from(String(v)), decryptString: (v) => Buffer.from(v).toString('utf8') } };
  return originalLoad.apply(this, arguments);
};
const db = require('../database/db');
const { hasPermission } = require('../core/permissions');
let checks = 0;
const ok = (c, m) => { assert.ok(c, m); checks++; console.log('PASS:', m); };

try {
  db.init();
  const admin = db.listUsers().find((u) => u.role === 'admin');
  const cashier = db.createUser({ fullName: 'كاشير ١', username: 'cashier1', password: 'Passw0rd!x', role: 'cashier' });
  const cashier2 = db.createUser({ fullName: 'كاشير ٢', username: 'cashier2', password: 'Passw0rd!x', role: 'cashier' });
  const manager = db.createUser({ fullName: 'مدير فرع', username: 'manager1', password: 'Passw0rd!x', role: 'manager' });
  assert.ok(cashier.id && manager.id);

  // ---- role permission model ----
  ok(hasPermission('admin', 'sales.modify') && hasPermission('manager', 'sales.modify') && !hasPermission('cashier', 'sales.modify'), "'sales.modify' is a manager/admin permission by role; cashiers only via the delegation flag");

  // ---- default state ----
  ok(db.userCanModifySales(admin.id) === true && db.userCanModifySales(manager.id) === true, 'admin and manager can modify by role');
  ok(db.userCanModifySales(cashier.id) === false, 'a cashier cannot modify by default');

  // ---- grant requires a reason ----
  assert.throws(() => db.setUserSalesModify(cashier.id, true, admin.id, ''), /سبب/, 'reason required');
  assert.throws(() => db.setUserSalesModify(cashier.id, true, admin.id, 'ok'), /3 أحرف/, 'reason too short');
  assert.throws(() => db.setUserSalesModify(cashier.id, true, admin.id, 'x'.repeat(301)), /طويل/, 'reason too long');
  ok(db.userCanModifySales(cashier.id) === false, 'failed grants change nothing');
  assert.throws(() => db.setUserSalesModify(manager.id, true, admin.id, 'لا داعي'), /بحكم دوره/, 'managers/admins need no delegation');
  assert.throws(() => db.setUserSalesModify(999999, true, admin.id, 'سبب صحيح'), /غير موجود/, 'unknown user');

  db.setUserSalesModify(cashier.id, true, admin.id, 'الكاشير الأول يصحح أخطاء الطلبات أثناء غياب المدير');
  ok(db.userCanModifySales(cashier.id) === true, 'grant with a reason enables the cashier');
  ok(db.userCanModifySales(cashier2.id) === false, 'other cashiers are unaffected');
  const row = db.listUsers().find((u) => u.id === cashier.id);
  ok(row.can_modify_sales === 1 && row.modify_sales_reason.includes('غياب المدير') && row.modify_sales_granted_by_name === admin.full_name && !!row.modify_sales_granted_at, 'users list shows the flag, the reason, who granted it and when');
  const login = db.authenticate('cashier1', 'Passw0rd!x');
  ok(login && login.can_modify_sales === 1, 'login/session object carries the flag');

  // ---- revoke is immediate ----
  db.setUserSalesModify(cashier.id, false, admin.id);
  ok(db.userCanModifySales(cashier.id) === false, 'revoking removes the right immediately');
  const cleared = db.listUsers().find((u) => u.id === cashier.id);
  ok(cleared.can_modify_sales === 0 && cleared.modify_sales_reason == null && cleared.modify_sales_granted_by_name == null, 'revoking clears reason / granter / date');

  // ---- a deactivated user loses the right even if the flag is on ----
  db.setUserSalesModify(cashier.id, true, admin.id, 'تفويض مؤقت للاختبار');
  const upd = db.updateUser({ id: cashier.id, fullName: 'كاشير ١', username: 'cashier1', role: 'cashier', isActive: false });
  assert.ok(upd.success !== false, 'deactivate');
  ok(db.userCanModifySales(cashier.id) === false, 'deactivated user cannot modify even with the flag');
  db.updateUser({ id: cashier.id, fullName: 'كاشير ١', username: 'cashier1', role: 'cashier', isActive: true });
  ok(db.userCanModifySales(cashier.id) === true, 'reactivated user keeps the delegation');

  // ---- wiring (main / pages) ----
  const main = read('main.js'), users = read('renderer', 'pages', 'users.js'), returns = read('renderer', 'pages', 'returns.js'), common = read('renderer', 'common.js');
  const handler = (name) => { const i = main.indexOf(`ipcMain.handle('${name}'`); assert.ok(i >= 0, name); return main.slice(i, i + 900); };
  ok(/requireSalesModify\(\)/.test(handler('sales:modifyItems')) && /requireSalesModify\(\)/.test(handler('sales:correctPaymentMethod')), 'both invoice-modification IPC handlers use requireSalesModify');
  ok(!/requireManagerOrAdmin\(\)/.test(handler('sales:modifyItems').split('\n').slice(0, 3).join('\n')), 'modifyItems no longer hard-requires manager/admin');
  ok(/requireAdmin\(\)/.test(handler('users:setSalesModify')) && /user_sales_modify_granted/.test(main), 'only an administrator can set the flag, and it is audited');
  ok(/auditDelegatedModification\('sale_items_modification_by_delegated_user'/.test(main) && /auditDelegatedModification\('sale_payment_correction_by_delegated_user'/.test(main), 'delegated modifications are audited with the delegating administrator and the reason');
  ok(/db\.userCanModifySales\(currentUser\.id\)/.test(main), 'the right is read from the database on every call (revocation is immediate)');
  const refundHandler = main.slice(main.indexOf("ipcMain.handle('returns:create'"), main.indexOf("ipcMain.handle('returns:create'") + 400);
  ok(/pos\.refund|requireManagerOrAdmin|requirePermission/.test(refundHandler), 'refunds remain restricted (delegated cashiers cannot refund)');
  ok(/allowIf/.test(returns) && /canRefund/.test(returns) && /allowIf/.test(common), 'returns page admits delegated cashiers and hides the refund button for them');
  ok(/data-sales-modify/.test(users) && /promptDialog\(/.test(users) && /setSalesModify/.test(users), 'users page: checkbox next to the user + reason prompt');
  ok(/title="\$\{escapeHtml\(why\)\}"/.test(users), 'the checkbox carries the "why" explanation');

  // ---- invoice list for the Returns area ----
  const shift = db.openShift(0, admin.id);
  const prod = db.createProduct({ name: 'صنف', price: 10, cost: 1, taxRate: 0, trackInventory: false });
  const cust = db.createCustomer({ name: 'أحمد_100%', phone: '555' });
  const mk = (extra = {}) => db.createSale({ items: [{ productId: prod.id, quantity: 2 }], paymentMethod: 'cash', cashAmount: 20, cardAmount: 0, changeDue: 0, discountType: null, discountValue: 0, userId: admin.id, shiftId: shift.id, ...extra });
  const s1 = mk({ customerId: cust.id });
  const s2 = mk();
  const s3 = mk();
  const detail = db.getSale(s2.id);
  db.createReturn({ saleId: s2.id, items: [{ saleItemId: detail.items[0].id, quantity: 1 }], refundMethod: 'cash', userId: admin.id, shiftId: shift.id });   // partial
  const d3 = db.getSale(s3.id);
  db.createReturn({ saleId: s3.id, items: [{ saleItemId: d3.items[0].id, quantity: 2 }], refundMethod: 'cash', userId: admin.id, shiftId: shift.id });   // full
  const table = db.createTable({ name: 'T', seats: 2 });
  const open = db.getOrCreateOpenSale(table.id, admin.id);
  db.setOpenSaleItems(open.id, [{ productId: prod.id, quantity: 1 }]);

  const listed = db.listSales({ statuses: ['completed', 'partially_refunded'] });
  const ids = listed.map((s) => s.id);
  ok(ids.includes(s1.id) && ids.includes(s2.id) && !ids.includes(s3.id) && !ids.includes(open.id), 'list shows completed + partially refunded only (no fully refunded, no open table orders)');
  const withCustomer = listed.find((s) => s.id === s1.id);
  ok(withCustomer.customer_name === 'أحمد_100%' && withCustomer.payment_method === 'cash', 'list rows carry the customer name and the payment method');
  ok(listed.find((s) => s.id === s2.id).status === 'partially_refunded', 'partially refunded status is preserved');
  ok(db.listSales({ statuses: ['completed'], search: 'أحمد' }).map((s) => s.id).join() === String(s1.id), 'search by customer name');
  ok(db.listSales({ statuses: ['completed', 'partially_refunded'], search: withCustomer.invoice_number }).some((s) => s.id === s1.id), 'search by invoice number');
  ok(db.listSales({ search: '%' }).length === 1 && db.listSales({ search: '_' }).length === 1, "search treats % and _ literally (customer 'أحمد_100%' only)");
  ok(db.listSales({ statuses: ['bogus'] }).length >= 3, 'unknown status values are ignored, not injected');

  // ---- the delegated cashier can really perform the operations at the database level ----
  const s4 = mk();
  const cashierRow = db.listUsers().find((u) => u.username === 'cashier1');
  const modResult = db.modifyCompletedSaleItems({ saleId: s4.id, actorUserId: cashierRow.id, reason: 'الزبون طلب كمية أكبر', items: [{ productId: prod.id, quantity: 3 }], bundleIds: [] });
  ok(modResult.success !== false && Math.abs(Number(db.getSale(s4.id).grand_total) - 30) < 1e-9, 'delegated cashier: items modification works on the same invoice (2 -> 3 items, total 30.00)');
  const payResult = db.correctSalePaymentMethod({ saleId: s4.id, newMethod: 'card', cashAmount: 0, cardAmount: 30, reason: 'الزبون دفع بالبطاقة', actorUserId: cashierRow.id });
  ok(payResult.success !== false && db.getSale(s4.id).payment_method === 'card', 'delegated cashier: payment-method correction works on the same invoice');
  ok(db.getSale(s4.id).invoice_number === db.getSale(s4.id).invoice_number && db.listSales({ statuses: ['completed'] }).filter((x) => x.id === s4.id).length === 1, 'still the same single invoice (no new invoice created)');

  // ---- without the flag the DATABASE itself refuses (not just the IPC layer) ----
  const c2 = db.listUsers().find((u) => u.username === 'cashier2');
  const s5 = mk();
  assert.throws(() => db.modifyCompletedSaleItems({ saleId: s5.id, actorUserId: c2.id, reason: 'محاولة', items: [{ productId: prod.id, quantity: 1 }], bundleIds: [] }), /يتطلب مديراً/, 'undelegated cashier cannot modify items');
  assert.throws(() => db.correctSalePaymentMethod({ saleId: s5.id, newMethod: 'card', cashAmount: 0, cardAmount: 20, reason: 'محاولة', actorUserId: c2.id }), /يتطلب مديراً/, 'undelegated cashier cannot correct the payment method');
  ok(Math.abs(Number(db.getSale(s5.id).grand_total) - 20) < 1e-9 && db.getSale(s5.id).payment_method === 'cash', 'the rejected attempts left the invoice untouched');
  db.setUserSalesModify(c2.id, true, admin.id, 'تفويض اختباري');
  db.setUserSalesModify(c2.id, false, admin.id);
  assert.throws(() => db.modifyCompletedSaleItems({ saleId: s5.id, actorUserId: c2.id, reason: 'بعد السحب', items: [{ productId: prod.id, quantity: 1 }], bundleIds: [] }), /يتطلب مديراً/, 'after revocation the cashier is refused again');

  console.log(`SALES MODIFY DELEGATION REGRESSION: PASS (${checks} checks)`);
} finally {
  try { db.closeDatabase(); } catch (_) {}
  try { fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch (_) {}
}
