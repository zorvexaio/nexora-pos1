'use strict';
/** Auto-extracted domain module — refactor batch 3–5. Do not call until h.db is initialized. */
module.exports = function createDomain(h) {
  const money = h.money;
  const accounting = h.accounting;
  const crypto = h.crypto;
  const path = h.path;
  const fs = h.fs;
  const app = h.app;

/* ---------------- الموردون وفواتير الشراء ---------------- */
function listSuppliers() { const b=h.getCurrentBranch(); return h.db.prepare('SELECT * FROM suppliers WHERE branch_id=? ORDER BY name').all(b.id); }
function createSupplier(s) {
  const b=h.getCurrentBranch();
  const name = String(s?.name || '').trim();
  if (!name) throw new Error('اسم المورد مطلوب.');
  const info = h.db.prepare(`INSERT INTO suppliers (uuid, branch_id, name, phone, address, notes, synced) VALUES (?, ?, ?, ?, ?, ?, 0)`)
    .run(h.uuid(), b.id, name, s.phone || null, s.address || null, s.notes || null);
  return { id: info.lastInsertRowid };
}
function updateSupplier(s) {
  if (!String(s.name || '').trim()) throw new Error('اسم المورد مطلوب.');
  const b=h.getCurrentBranch();
  const result=h.db.prepare(`UPDATE suppliers SET name=?,phone=?,address=?,notes=?,updated_at=datetime('now'),synced=0 WHERE id=? AND branch_id=?`)
    .run(s.name.trim(),s.phone||null,s.address||null,s.notes||null,Number(s.id),b.id);
  if(!result.changes) throw new Error('المورد غير موجود في الفرع الحالي.');
  return { success: true };
}
function createPurchaseOrder(order) {
  if (!order.supplierId || !Array.isArray(order.items) || !order.items.length) throw new Error('اختر المورد وأضف بند شراء واحداً على الأقل.');
  const branch = h.getCurrentBranch();
  const items = order.items.map((i) => ({ productId: Number(i.productId), quantity: Number(i.quantity), unitCost: Number(i.unitCost) }));
  if (items.some((i) => !i.productId || !(i.quantity > 0) || !(i.unitCost >= 0))) throw new Error('بيانات بنود الشراء غير صالحة.');
  const total = h.roundMoney(items.reduce((sum, i) => sum + Number(i.quantity) * Number(i.unitCost), 0));
  const paidAmount = h.roundMoney(Math.max(0, Number(order.paidAmount) || 0));
  const paymentMethod = String(order.paymentMethod || (paidAmount > 0 ? 'cash' : 'credit')).trim();
  if (!['cash', 'card', 'credit'].includes(paymentMethod)) throw new Error('طريقة دفع المورد غير صالحة.');
  if (paidAmount > total + 0.01) throw new Error('المبلغ المدفوع للمورد أكبر من إجمالي فاتورة الشراء.');
  if (paymentMethod === 'credit' && paidAmount > 0.01) throw new Error('اختر نقداً أو بطاقة لتسجيل دفعة للمورد.');
  const supplier = h.db.prepare('SELECT id FROM suppliers WHERE id=? AND branch_id=?').get(Number(order.supplierId), branch.id);
  if(!supplier) throw new Error('المورد غير موجود.');
  const productCheck = h.db.prepare('SELECT id, is_active FROM products WHERE id=?');
  for (const item of items) {
    const product = productCheck.get(item.productId);
    if (!product || !product.is_active) throw new Error('يوجد منتج شراء غير موجود أو غير نشط.');
  }
  const tx = h.db.transaction(() => {
    const info = h.db.prepare(`INSERT INTO purchase_orders (uuid, branch_id, supplier_id, total, paid_amount, payment_method, notes, synced) VALUES (?, ?, ?, ?, ?, ?, ?, 0)`)
      .run(h.uuid(), branch.id, Number(order.supplierId), total, paidAmount, paymentMethod, order.notes || null);
    const insert = h.db.prepare(`INSERT INTO purchase_order_items (purchase_order_id, product_id, quantity, unit_cost) VALUES (?, ?, ?, ?)`);
    for (const item of items) insert.run(info.lastInsertRowid, item.productId, item.quantity, item.unitCost);
    // الفاتورة التي ينشئها المستخدم هي عملية شراء مكتملة وليست "مسودة" مخفية:
    // الاستلام يحدّث المخزون والحسابات في نفس transaction. يبقى خيار المسودة
    // متاحاً فقط لاستيراد/تكاملات مستقبلية عبر receiveImmediately=false.
    if (order.receiveImmediately !== false) {
      return receivePurchaseOrderCore(info.lastInsertRowid, branch.id, { paymentMethod, userId: order.userId || null, shiftId: order.shiftId || null });
    }
    return { id: info.lastInsertRowid, total, status: 'draft' };
  });
  return tx();
}
function receivePurchaseOrderCore(purchaseOrderId, branchId, context = {}) {
  const po = h.db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(purchaseOrderId);
  if (!po) throw new Error('فاتورة الشراء غير موجودة.');
  // حماية: فاتورة شراء أُنشئت بفرع آخر ووصلت هالجهاز عبر المزامنة (للعرض فقط) — لا يجوز
  // استلامها من هون، لأن الاستلام يُحرّك مخزون هذا الجهاز ورصيد المورد المشترك، وفرع تاني
  // هو المسؤول الوحيد عن قرار استلام فاتورته هو.
  if (po.branch_id !== branchId) throw new Error('لا يمكن استلام فاتورة شراء تخص فرعاً آخر. راجع الفرع الذي أنشأها.');
  if (po.invoice_type === 'expense') throw new Error('فاتورة المصروف لا تُستلم كبضاعة.');
  if (po.status !== 'draft') throw new Error('لا يمكن استلام فاتورة تم التعامل معها سابقاً.');
  const items = h.db.prepare('SELECT * FROM purchase_order_items WHERE purchase_order_id = ?').all(purchaseOrderId);
  const upsertInventory = h.db.prepare(`INSERT INTO inventory (branch_id, product_id, quantity, unit_cost, min_quantity, updated_at, synced) VALUES (?, ?, ?, ?, 0, datetime('now'), 0)
    ON CONFLICT(branch_id, product_id) DO UPDATE SET quantity=inventory.quantity + excluded.quantity, unit_cost=excluded.unit_cost, updated_at=datetime('now'), synced=0`);
  const productStock = h.db.prepare('SELECT quantity, unit_cost FROM inventory WHERE branch_id=? AND product_id=?');
  const movement = h.db.prepare(`INSERT INTO inventory_movements (uuid, branch_id, product_id, change_qty, reason, ref_id, notes, unit_cost_after, synced) VALUES (?, ?, ?, ?, 'purchase', ?, ?, ?, 0)`);
  let trackedPurchaseValue = 0; // قيمة البنود المتتبَّعة مخزونياً فقط (بسعر الشراء الفعلي، وليس المتوسط المرجّح) — هذا ما يُضاف لحساب المخزون محاسبياً
  for (const item of items) {
    const product = h.db.prepare('SELECT track_inventory,is_active FROM products WHERE id=?').get(item.product_id);
    if (!product || !product.is_active) throw new Error('يوجد منتج شراء غير صالح.');
    if (!product.track_inventory) continue;
    const quantity = Number(item.quantity);
    const unitCost = Number(item.unit_cost);
    if (!(quantity > 0) || !Number.isFinite(unitCost) || unitCost < 0) throw new Error('بيانات بند فاتورة الشراء غير صالحة.');
    const stockRow = productStock.get(po.branch_id, item.product_id);
    const before = Number(stockRow?.quantity || 0);
    const oldCost = Number(stockRow?.unit_cost ?? h.db.prepare('SELECT cost FROM products WHERE products.id=?').get(item.product_id)?.cost ?? 0);
    const weightedCost = (before + quantity) > 0 ? ((before * oldCost) + (quantity * unitCost)) / (before + quantity) : unitCost;
    upsertInventory.run(po.branch_id, item.product_id, quantity, weightedCost);
    movement.run(h.uuid(), po.branch_id, item.product_id, quantity, po.id, 'استلام فاتورة شراء', weightedCost);
    trackedPurchaseValue += quantity * unitCost;
  }
  const paidAmount = Math.min(Number(po.total), Math.max(0, Number(po.paid_amount) || 0));
  const paymentMethod = String(context.paymentMethod || po.payment_method || (paidAmount > 0 ? 'cash' : 'credit')).trim();
  if (!['cash', 'card', 'credit'].includes(paymentMethod)) throw new Error('طريقة دفع المورد غير صالحة.');
  if (paymentMethod === 'credit' && paidAmount > 0.01) throw new Error('فاتورة المورد الآجلة لا يمكن أن تحتوي دفعة مسجلة.');
  const due = Math.max(0, Number(po.total) - paidAmount);
  const supplier = h.db.prepare('SELECT balance FROM suppliers WHERE id=? AND branch_id=?').get(po.supplier_id, branchId);
  if (!supplier) throw new Error('المورد غير موجود في الفرع الحالي.');
  const balanceAfterPurchase = Number(supplier.balance || 0) + Number(po.total);
  const balanceAfter = balanceAfterPurchase - paidAmount;
  h.db.prepare(`UPDATE suppliers SET balance=?, updated_at=datetime('now'), synced=0 WHERE id=? AND branch_id=?`).run(balanceAfter, po.supplier_id, branchId);
  if (Number(po.total) > 0) h.db.prepare(`INSERT INTO supplier_ledger (uuid, branch_id, supplier_id, purchase_order_id, entry_type, amount, balance_after, notes, synced) VALUES (?, ?, ?, ?, 'purchase', ?, ?, ?, 0)`)
    .run(h.uuid(), po.branch_id, po.supplier_id, po.id, Number(po.total), balanceAfterPurchase, 'فاتورة شراء مستلمة');
  if (paidAmount > 0) h.db.prepare(`INSERT INTO supplier_ledger (uuid, branch_id, supplier_id, purchase_order_id, entry_type, amount, balance_after, notes, synced) VALUES (?, ?, ?, ?, 'payment', ?, ?, ?, 0)`)
    .run(h.uuid(), po.branch_id, po.supplier_id, po.id, -paidAmount, balanceAfter, `دفعة ${paymentMethod === 'cash' ? 'نقدية' : 'بطاقة'} للمورد`);

  const actorId = context.userId || null;
  const shiftId = context.shiftId || null;
  if (paidAmount > 0) {
    const currency = String(h.getGlobalProfile().currency_code || 'USD').trim().toUpperCase();
    h.db.prepare(`INSERT INTO payment_transactions(uuid,branch_id,shift_id,method,currency_code,amount,exchange_rate,external_id,masked_descriptor,created_by) VALUES(?,?,?,?,?,?,?,?,?,?)`)
      .run(h.uuid(), po.branch_id, shiftId, paymentMethod, currency, -paidAmount, 1, `purchase:${po.id}`, `دفعة مورد #${po.id}`, actorId);
    if (paymentMethod === 'cash' && shiftId) {
      const shift = h.db.prepare("SELECT id FROM shifts WHERE id=? AND branch_id=? AND status='open'").get(shiftId, po.branch_id);
      if (!shift) throw new Error('جلسة الصندوق المحددة مغلقة أو لا تخص الفرع الحالي.');
      h.db.prepare(`INSERT INTO cash_movements(uuid,branch_id,shift_id,type,amount,reason,reference,created_by) VALUES(?,?,?,?,?,?,?,?)`)
        .run(h.uuid(), po.branch_id, shiftId, 'cash_out', paidAmount, 'دفعة فاتورة شراء', `purchase:${po.id}`, actorId);
    }
  }
  // قيد محاسبي: مدين مخزون بالبنود المتتبَّعة + مدين مصروف مباشر بالبنود غير المتتبَّعة
  // (لأنها لا تدخل حساب المخزون أصلاً)، ودائن حساب التسوية (نقد/بطاقة) بالمدفوع فوراً
  // ودائن ذمم دائنة (موردون) بالباقي الآجل.
  if (Number(po.total) > 0) {
    const unit = Number(h.getGlobalProfile()?.currency_minor_unit ?? 2);
    const totalMinor = money.toMinor(Number(po.total), unit);
    const paidMinor = money.toMinor(paidAmount, unit);
    const inventoryMinor = money.toMinor(Math.min(trackedPurchaseValue, Number(po.total)), unit);
    const directExpenseMinor = Math.max(0, totalMinor - inventoryMinor);
    const settleCode = paymentMethod === 'card' ? '1100' : '1000';
    const lines = [];
    if (inventoryMinor > 0) lines.push({ accountId: h.getAccountingAccountId(po.branch_id, '1300'), debitMinor: inventoryMinor, creditMinor: 0, memo: `مخزون مستلم من فاتورة شراء #${po.id}` });
    if (directExpenseMinor > 0) lines.push({ accountId: h.getAccountingAccountId(po.branch_id, '6000'), debitMinor: directExpenseMinor, creditMinor: 0, memo: `بنود شراء غير مخزنية #${po.id}` });
    if (paidMinor > 0) lines.push({ accountId: h.getAccountingAccountId(po.branch_id, settleCode), debitMinor: 0, creditMinor: paidMinor, memo: `دفعة فورية لمورد #${po.id}` });
    const remainderMinor = totalMinor - paidMinor;
    if (remainderMinor > 0) lines.push({ accountId: h.getAccountingAccountId(po.branch_id, '2000'), debitMinor: 0, creditMinor: remainderMinor, memo: `آجل مورد #${po.id}` });
    h.insertPostedJournalEntry({ branchId: po.branch_id, memo: `فاتورة شراء #${po.id}`, referenceType: 'purchase_order', referenceId: po.id, lines, createdBy: actorId });
  }
  h.db.prepare(`UPDATE purchase_orders SET status='received', payment_method=?, received_at=datetime('now'), updated_at=datetime('now'), synced=0 WHERE id=?`).run(paymentMethod, po.id);
  return { success: true, id: po.id, total: po.total, paidAmount, due, balanceAfter, cashMovementRecorded: paymentMethod === 'cash' && !!shiftId };
}
const receivePurchaseOrderTx = h.db.transaction(receivePurchaseOrderCore);
function receivePurchaseOrder(id, context = {}) { return receivePurchaseOrderTx(id, h.getCurrentBranch().id, context); }
function listPurchaseOrders() { const b=h.getCurrentBranch(); return h.db.prepare(`SELECT p.*, s.name AS supplier_name, b.name AS branch_name FROM purchase_orders p JOIN suppliers s ON s.id=p.supplier_id JOIN branches b ON b.id=p.branch_id WHERE p.branch_id=? ORDER BY p.created_at DESC`).all(b.id); }
// شاشة الموردين كانت تعرض "الرصيد المستحق لهم" بدون أي زر لتسجيل دفعة تسدّده خارج
// إنشاء فاتورة شراء جديدة (الدفع كان مربوطاً فقط بـ purchasePaid عند الشراء) — نفس فجوة
// دفعات العملاء التي عولجت بـ receiveCustomerPayment. هذه الدالة تقابلها لجهة الموردين.
const paySupplierDebtTx = h.db.transaction((payload) => {
  const amount = Number(payload.amount);
  if (!(amount > 0)) throw new Error('مبلغ الدفعة غير صالح.');
  const branch = h.getCurrentBranch();
  const supplier = h.db.prepare('SELECT balance FROM suppliers WHERE id=? AND branch_id=?').get(Number(payload.supplierId), branch.id);
  if (!supplier) throw new Error('المورد غير موجود في الفرع الحالي.');
  const balanceAfter = Math.max(0, Number(supplier.balance || 0) - amount);
  const applied = Number(supplier.balance || 0) - balanceAfter;
  if (!(applied > 0)) throw new Error('لا يوجد رصيد مستحق لهذا المورد.');
  const paymentMethod = String(payload.paymentMethod || 'cash').trim();
  if (!['cash', 'card'].includes(paymentMethod)) throw new Error('طريقة دفع المورد غير صالحة.');
  h.db.prepare(`UPDATE suppliers SET balance=?,updated_at=datetime('now'),synced=0 WHERE id=? AND branch_id=?`).run(balanceAfter, Number(payload.supplierId), branch.id);
  h.db.prepare(`INSERT INTO supplier_ledger (uuid, branch_id, supplier_id, purchase_order_id, entry_type, amount, balance_after, notes, synced) VALUES (?, ?, ?, NULL, 'payment', ?, ?, ?, 0)`)
    .run(h.uuid(), branch.id, Number(payload.supplierId), -applied, balanceAfter, payload.notes || `دفعة ${paymentMethod === 'cash' ? 'نقدية' : 'بطاقة'} للمورد`);
  const currency = String(h.getGlobalProfile().currency_code || 'USD').trim().toUpperCase();
  const shiftId = payload.shiftId || null;
  h.db.prepare(`INSERT INTO payment_transactions(uuid,branch_id,shift_id,method,currency_code,amount,exchange_rate,external_id,masked_descriptor,created_by) VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .run(h.uuid(), branch.id, shiftId, paymentMethod, currency, -applied, 1, `supplier-payment:${payload.supplierId}`, 'دفعة لمورد', payload.userId || null);
  let cashMovementRecorded = false;
  if (paymentMethod === 'cash' && shiftId) {
    const shift = h.db.prepare("SELECT id FROM shifts WHERE id=? AND branch_id=? AND status='open'").get(shiftId, branch.id);
    if (!shift) throw new Error('جلسة الصندوق المحددة مغلقة أو لا تخص الفرع الحالي.');
    h.db.prepare(`INSERT INTO cash_movements(uuid,branch_id,shift_id,type,amount,reason,reference,created_by) VALUES(?,?,?,?,?,?,?,?)`)
      .run(h.uuid(), branch.id, shiftId, 'cash_out', applied, 'دفعة لمورد', `supplier:${payload.supplierId}`, payload.userId || null);
    cashMovementRecorded = true;
  }
  const unit = Number(h.getGlobalProfile()?.currency_minor_unit ?? 2);
  const appliedMinor = money.toMinor(applied, unit);
  h.insertPostedJournalEntry({
    branchId: branch.id, memo: `دفعة لمورد #${payload.supplierId}`, referenceType: 'supplier_payment', referenceId: payload.supplierId,
    lines: [
      { accountId: h.getAccountingAccountId(branch.id, '2000'), debitMinor: appliedMinor, creditMinor: 0, memo: 'تسديد ذمم دائنة' },
      { accountId: h.getAccountingAccountId(branch.id, paymentMethod === 'card' ? '1100' : '1000'), debitMinor: 0, creditMinor: appliedMinor, memo: 'دفعة لمورد' },
    ], createdBy: payload.userId || null,
  });
  return { success: true, applied, balanceAfter, cashMovementRecorded };
});
function paySupplierDebt(payload) { return paySupplierDebtTx(payload); }
/* ---------------- مصروفات تشغيلية (بلا بضاعة) ---------------- */
// فئات جاهزة لكل فرع. لكل فئة حساب مصروف خاص (6200..6290) حتى تظهر منفصلة عن تكلفة البضاعة (COGS 5000) والمخزون.
const DEFAULT_EXPENSE_CATEGORIES = Object.freeze([
  ['6200', 'إيجار المحل'], ['6210', 'كهرباء'], ['6220', 'ماء'], ['6230', 'إنترنت / هاتف'], ['6240', 'صيانة'],
  ['6250', 'نظافة'], ['6260', 'نقل وتوصيل'], ['6270', 'رسوم حكومية / رخص'], ['6280', 'تسويق وإعلان'], ['6290', 'أخرى'],
]);
function ensureExpenseCategories(branchId) {
  const has = h.db.prepare('SELECT 1 FROM expense_categories WHERE branch_id=? LIMIT 1').get(branchId);
  if (has) return;
  const currency = String(h.getGlobalProfile()?.currency_code || 'USD').toUpperCase();
  const insertAccount = h.db.prepare('INSERT OR IGNORE INTO accounting_accounts(uuid,branch_id,code,name,account_type,currency_code) VALUES(?,?,?,?,?,?)');
  const insertCategory = h.db.prepare('INSERT OR IGNORE INTO expense_categories(uuid,branch_id,name,account_code,synced) VALUES(?,?,?,?,0)');
  for (const [code, name] of DEFAULT_EXPENSE_CATEGORIES) {
    insertAccount.run(h.uuid(), branchId, code, name, 'expense', currency);
    insertCategory.run(h.uuid(), branchId, name, code);
  }
}
function listExpenseCategories(includeInactive = false) {
  const branch = h.getCurrentBranch();
  ensureExpenseCategories(branch.id);
  return h.db.prepare(`SELECT id, uuid, name, account_code, is_active FROM expense_categories WHERE branch_id=? ${includeInactive ? '' : 'AND is_active=1'} ORDER BY account_code, name`).all(branch.id);
}
// إضافة فئة جديدة (أو تعديل اسم/تفعيل فئة). الفئة الجديدة تأخذ حساب مصروف جديداً من المدى 6300..6899.
const saveExpenseCategoryTx = h.db.transaction((payload) => {
  const branch = h.getCurrentBranch();
  ensureExpenseCategories(branch.id);
  const name = String(payload?.name || '').trim();
  if (!name || name.length > 80) throw new Error('اسم فئة المصروف مطلوب (حتى 80 حرفاً).');
  const currency = String(h.getGlobalProfile()?.currency_code || 'USD').toUpperCase();
  const id = Number(payload?.id || 0);
  if (id) {
    const row = h.db.prepare('SELECT id, account_code FROM expense_categories WHERE id=? AND branch_id=?').get(id, branch.id);
    if (!row) throw new Error('فئة المصروف غير موجودة.');
    const clash = h.db.prepare('SELECT id FROM expense_categories WHERE branch_id=? AND name=? AND id<>?').get(branch.id, name, id);
    if (clash) throw new Error('اسم الفئة مستخدم مسبقاً.');
    h.db.prepare("UPDATE expense_categories SET name=?, is_active=?, updated_at=datetime('now'), synced=0 WHERE id=?").run(name, payload.isActive === false ? 0 : 1, id);
    h.db.prepare("UPDATE accounting_accounts SET name=? WHERE branch_id=? AND code=? AND account_type='expense'").run(name, branch.id, row.account_code);
    return { success: true, id };
  }
  if (h.db.prepare('SELECT 1 FROM expense_categories WHERE branch_id=? AND name=?').get(branch.id, name)) throw new Error('اسم الفئة مستخدم مسبقاً.');
  const last = h.db.prepare("SELECT MAX(CAST(code AS INTEGER)) AS c FROM accounting_accounts WHERE branch_id=? AND CAST(code AS INTEGER) BETWEEN 6300 AND 6899").get(branch.id)?.c;
  const code = String(last ? Number(last) + 10 : 6300);
  if (Number(code) > 6899) throw new Error('تجاوزت الحد الأقصى لفئات المصروف.');
  h.db.prepare('INSERT INTO accounting_accounts(uuid,branch_id,code,name,account_type,currency_code) VALUES(?,?,?,?,?,?)').run(h.uuid(), branch.id, code, name, 'expense', currency);
  const info = h.db.prepare('INSERT INTO expense_categories(uuid,branch_id,name,account_code,synced) VALUES(?,?,?,?,0)').run(h.uuid(), branch.id, name, code);
  return { success: true, id: info.lastInsertRowid, accountCode: code };
});
function saveExpenseCategory(payload) { return saveExpenseCategoryTx(payload); }

// فاتورة مصروف تشغيلي: لا بنود ولا مخزون إطلاقاً. تدخل رصيد المورد والذمم والصندوق والقيود كأي فاتورة مورد،
// لكن القيد مدين حساب مصروف الفئة (وليس المخزون 1300 ولا COGS 5000).
const createExpenseInvoiceTx = h.db.transaction((payload = {}) => {
  const branch = h.getCurrentBranch();
  ensureExpenseCategories(branch.id);
  const unit = Number(h.getGlobalProfile()?.currency_minor_unit ?? 2);
  const toMinorStrict = (value, label) => {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) throw new Error(`${label} غير صالح.`);
    return money.toMinor(n.toFixed(unit + 6), unit);
  };
  const supplier = h.db.prepare('SELECT id, balance FROM suppliers WHERE id=? AND branch_id=?').get(Number(payload.supplierId), branch.id);
  if (!supplier) throw new Error('اختر مورداً صالحاً.');
  const category = h.db.prepare('SELECT * FROM expense_categories WHERE id=? AND branch_id=? AND is_active=1').get(Number(payload.categoryId), branch.id);
  if (!category) throw new Error('اختر فئة مصروف صالحة.');
  const totalMinor = toMinorStrict(payload.amount, 'مبلغ المصروف');
  if (!(totalMinor > 0)) throw new Error('مبلغ المصروف يجب أن يكون أكبر من صفر.');
  const paymentMethod = String(payload.paymentMethod || 'credit').trim();
  if (!['cash', 'card', 'credit'].includes(paymentMethod)) throw new Error('طريقة الدفع غير صالحة.');
  let paidMinor = 0;
  if (paymentMethod !== 'credit') {
    paidMinor = payload.paidAmount == null || payload.paidAmount === '' ? totalMinor : toMinorStrict(payload.paidAmount, 'المبلغ المدفوع');
    if (paidMinor > totalMinor) throw new Error('المبلغ المدفوع أكبر من مبلغ المصروف.');
  }
  const reference = String(payload.referenceNumber || '').trim().slice(0, 100) || null;
  const notes = String(payload.notes || '').trim().slice(0, 1000) || null;
  const invoiceDate = /^\d{4}-\d{2}-\d{2}$/.test(String(payload.invoiceDate || '')) ? String(payload.invoiceDate) : h.db.prepare("SELECT date('now','localtime') AS d").get().d;
  const actorId = payload.userId || null;
  const shiftId = payload.shiftId || null;
  // الدفع النقدي يجب أن ينقص الصندوق فعلاً: نتطلب وردية مفتوحة بدل تسجيل دفع نقدي بلا أثر على الصندوق.
  if (paymentMethod === 'cash' && paidMinor > 0) {
    const shift = shiftId ? h.db.prepare("SELECT id FROM shifts WHERE id=? AND branch_id=? AND status='open'").get(shiftId, branch.id) : null;
    if (!shift) throw new Error('افتح وردية (جلسة صندوق) لتسجيل مصروف مدفوع نقداً.');
  }
  const total = money.fromMinor(totalMinor, unit);
  const paid = money.fromMinor(paidMinor, unit);
  const info = h.db.prepare(`INSERT INTO purchase_orders (uuid, branch_id, supplier_id, status, total, paid_amount, payment_method, received_at, notes, invoice_type, expense_category_id, expense_category_name, invoice_date, reference_number, synced)
    VALUES (?, ?, ?, 'received', ?, ?, ?, datetime('now'), ?, 'expense', ?, ?, ?, ?, 0)`)
    .run(h.uuid(), branch.id, supplier.id, total, paid, paymentMethod, notes, category.id, category.name, invoiceDate, reference);
  const poId = info.lastInsertRowid;

  const balanceAfterInvoice = Number(supplier.balance || 0) + total;
  const balanceAfter = balanceAfterInvoice - paid;
  h.db.prepare("UPDATE suppliers SET balance=?, updated_at=datetime('now'), synced=0 WHERE id=? AND branch_id=?").run(balanceAfter, supplier.id, branch.id);
  h.db.prepare(`INSERT INTO supplier_ledger (uuid, branch_id, supplier_id, purchase_order_id, entry_type, amount, balance_after, notes, synced) VALUES (?, ?, ?, ?, 'purchase', ?, ?, ?, 0)`)
    .run(h.uuid(), branch.id, supplier.id, poId, total, balanceAfterInvoice, `فاتورة مصروف: ${category.name}`);
  let cashMovementRecorded = false;
  if (paidMinor > 0) {
    h.db.prepare(`INSERT INTO supplier_ledger (uuid, branch_id, supplier_id, purchase_order_id, entry_type, amount, balance_after, notes, synced) VALUES (?, ?, ?, ?, 'payment', ?, ?, ?, 0)`)
      .run(h.uuid(), branch.id, supplier.id, poId, -paid, balanceAfter, `دفعة ${paymentMethod === 'cash' ? 'نقدية' : 'بطاقة'} لفاتورة مصروف`);
    const currency = String(h.getGlobalProfile().currency_code || 'USD').trim().toUpperCase();
    h.db.prepare(`INSERT INTO payment_transactions(uuid,branch_id,shift_id,method,currency_code,amount,exchange_rate,external_id,masked_descriptor,created_by) VALUES(?,?,?,?,?,?,?,?,?,?)`)
      .run(h.uuid(), branch.id, shiftId, paymentMethod, currency, -paid, 1, `expense:${poId}`, `مصروف: ${category.name}`, actorId);
    if (paymentMethod === 'cash') {
      h.db.prepare(`INSERT INTO cash_movements(uuid,branch_id,shift_id,type,amount,reason,reference,created_by) VALUES(?,?,?,?,?,?,?,?)`)
        .run(h.uuid(), branch.id, shiftId, 'cash_out', paid, `مصروف: ${category.name}`, `expense:${poId}`, actorId);
      cashMovementRecorded = true;
    }
  }
  // القيد: مدين مصروف الفئة بكامل المبلغ / دائن الصندوق أو البنك بالمدفوع / دائن ذمم الموردين بالباقي الآجل.
  const lines = [{ accountId: h.getAccountingAccountId(branch.id, category.account_code), debitMinor: totalMinor, creditMinor: 0, memo: `مصروف ${category.name} #${poId}` }];
  if (paidMinor > 0) lines.push({ accountId: h.getAccountingAccountId(branch.id, paymentMethod === 'card' ? '1100' : '1000'), debitMinor: 0, creditMinor: paidMinor, memo: `دفع مصروف #${poId}` });
  if (totalMinor - paidMinor > 0) lines.push({ accountId: h.getAccountingAccountId(branch.id, '2000'), debitMinor: 0, creditMinor: totalMinor - paidMinor, memo: `مصروف آجل #${poId}` });
  h.insertPostedJournalEntry({ branchId: branch.id, memo: `فاتورة مصروف ${category.name} #${poId}`, referenceType: 'expense_invoice', referenceId: poId, lines, createdBy: actorId });

  h.logAudit({ userId: actorId, action: 'expense_invoice_created', entityType: 'purchase_order', entityId: poId, details: { supplierId: supplier.id, category: category.name, total, paid, paymentMethod, invoiceDate, reference } });
  if (paidMinor > 0) h.logAudit({ userId: actorId, action: 'expense_invoice_payment', entityType: 'purchase_order', entityId: poId, details: { method: paymentMethod, amount: paid, shiftId } });
  return { success: true, id: poId, total, paidAmount: paid, due: money.fromMinor(totalMinor - paidMinor, unit), balanceAfter, cashMovementRecorded };
});
function createExpenseInvoice(payload) { return createExpenseInvoiceTx(payload); }

// ملخص المصروفات التشغيلية (منفصل عن مشتريات البضاعة): إجمالي + حسب الفئة لفترة بتاريخ الفاتورة.
function getOperatingExpensesSummary(range = {}) {
  const branch = h.getCurrentBranch();
  const unit = Number(h.getGlobalProfile()?.currency_minor_unit ?? 2);
  const today = h.db.prepare("SELECT date('now','localtime') AS d").get().d;
  const from = /^\d{4}-\d{2}-\d{2}/.test(String(range.from || '')) ? String(range.from).slice(0, 10) : today.slice(0, 8) + '01';
  const to = /^\d{4}-\d{2}-\d{2}/.test(String(range.to || '')) ? String(range.to).slice(0, 10) : today;
  const rows = h.db.prepare(`SELECT expense_category_name AS name, total FROM purchase_orders
    WHERE branch_id=? AND invoice_type='expense' AND status='received' AND COALESCE(invoice_date, date(created_at)) BETWEEN ? AND ?`).all(branch.id, from, to);
  const byCategory = new Map();
  let totalMinor = 0;
  for (const r of rows) {
    const m = money.toMinor(Number(r.total || 0).toFixed(unit + 6), unit);
    totalMinor += m;
    const key = r.name || 'أخرى';
    const cur = byCategory.get(key) || { name: key, totalMinor: 0, count: 0 };
    cur.totalMinor += m; cur.count += 1; byCategory.set(key, cur);
  }
  return {
    from, to, count: rows.length, total: money.fromMinor(totalMinor, unit),
    byCategory: [...byCategory.values()].sort((a, b) => b.totalMinor - a.totalMinor).map((c) => ({ name: c.name, count: c.count, total: money.fromMinor(c.totalMinor, unit) })),
  };
}

function getPurchaseOrder(id) { const b=h.getCurrentBranch(); const order = h.db.prepare(`SELECT p.*, s.name AS supplier_name, b.name AS branch_name FROM purchase_orders p JOIN suppliers s ON s.id=p.supplier_id JOIN branches b ON b.id=p.branch_id WHERE p.id=? AND p.branch_id=? AND s.branch_id=?`).get(id,b.id,b.id); return order ? { ...order, items: h.db.prepare(`SELECT i.*, pr.name AS product_name FROM purchase_order_items i JOIN products pr ON pr.id=i.product_id WHERE i.purchase_order_id=?`).all(id) } : null; }


  return {
    listSuppliers,
    createSupplier,
    updateSupplier,
    createPurchaseOrder,
    receivePurchaseOrderCore,
    receivePurchaseOrder,
    listPurchaseOrders,
    paySupplierDebt,
    ensureExpenseCategories,
    listExpenseCategories,
    saveExpenseCategory,
    createExpenseInvoice,
    getOperatingExpensesSummary,
    getPurchaseOrder
  };
};
