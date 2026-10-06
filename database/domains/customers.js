'use strict';
/** Auto-extracted domain module — refactor batch 3–5. Do not call until h.db is initialized. */
module.exports = function createDomain(h) {
  const money = h.money;
  const accounting = h.accounting;
  const crypto = h.crypto;
  const path = h.path;
  const fs = h.fs;
  const app = h.app;

/* ---------------- العملاء ---------------- */
function listCustomers(filters = {}) {
  const branch = h.getCurrentBranch();
  const search = String(filters.search || '').trim();
  const limit = Math.max(1, Math.min(Number(filters.limit) || (search ? 40 : 250), 500));
  let sql = `SELECT * FROM customers WHERE branch_id=?`;
  const params = [branch.id];
  if (search) {
    sql += ` AND (name LIKE ? OR phone LIKE ?)`;
    params.push(`%${search}%`, `${search}%`);
  }
  sql += ' ORDER BY name LIMIT ?';
  params.push(limit);
  return h.db.prepare(sql).all(...params);
}

function getCustomer(id) {
  const branch = h.getCurrentBranch();
  return h.db.prepare('SELECT * FROM customers WHERE id=? AND branch_id=?').get(Number(id), branch.id);
}

function createCustomer(c) {
  const branch = h.getCurrentBranch();
  const info = h.db.prepare(`INSERT INTO customers (uuid,branch_id,name,phone,loyalty_points) VALUES (?,?,?,?,0)`)
    .run(h.uuid(), branch.id, c.name || null, c.phone || null);
  return { id: info.lastInsertRowid };
}

function updateCustomer(c) {
  const branch = h.getCurrentBranch();
  const result = h.db.prepare(`UPDATE customers SET name=?,phone=?,updated_at=datetime('now'),synced=0 WHERE id=? AND branch_id=?`)
    .run(c.name || null, c.phone || null, Number(c.id), branch.id);
  if (!result.changes) throw new Error('العميل غير موجود في الفرع الحالي.');
  return { success: true };
}

function appendStoreCreditLedger({ customerId, saleId = null, returnId = null, entryType, amount, createdBy = null, branchId = null }) {
  const branch = Number(branchId || h.getCurrentBranch().id);
  const customer = h.db.prepare('SELECT id FROM customers WHERE id=? AND branch_id=?').get(Number(customerId), branch);
  if (!customer) throw new Error('العميل غير موجود في الفرع الحالي.');
  const delta = h.roundMoney(amount);
  if (!Number.isFinite(delta) || delta === 0) throw new Error('حركة رصيد المتجر غير صالحة.');
  const result = h.db.prepare(`INSERT INTO store_credit_ledger(uuid,branch_id,customer_id,sale_id,return_id,entry_type,amount,created_by,synced) VALUES(?,?,?,?,?,?,?,?,0)`).run(h.uuid(), branch, Number(customerId), saleId, returnId, entryType, delta, createdBy || null);
  const balance = h.db.prepare('SELECT COALESCE(SUM(amount),0) AS balance FROM store_credit_ledger WHERE branch_id=? AND customer_id=?').get(branch, Number(customerId)).balance;
  h.db.prepare(`UPDATE customers SET store_credit_balance=?,updated_at=datetime('now'),synced=0 WHERE id=? AND branch_id=?`).run(h.roundMoney(balance), Number(customerId), branch);
  return { id: result.lastInsertRowid, balance: h.roundMoney(balance) };
}

function recalcStoreCreditBalance(customerId, branchId = null, touchSync = false) {
  const branch = Number(branchId || h.getCurrentBranch().id);
  const balance = h.db.prepare('SELECT COALESCE(SUM(amount),0) AS balance FROM store_credit_ledger WHERE branch_id=? AND customer_id=?').get(branch, Number(customerId)).balance;
  const rounded = h.roundMoney(balance);
  if (touchSync) h.db.prepare(`UPDATE customers SET store_credit_balance=?,updated_at=datetime('now'),synced=0 WHERE id=? AND branch_id=?`).run(rounded,Number(customerId),branch);
  else h.db.prepare(`UPDATE customers SET store_credit_balance=? WHERE id=? AND branch_id=?`).run(rounded,Number(customerId),branch);
  return rounded;
}

function recalcCustomerBalance(customerId) {
  const branch = h.getCurrentBranch();
  if (!h.db.prepare('SELECT 1 FROM customers WHERE id=? AND branch_id=?').get(Number(customerId), branch.id)) throw new Error('العميل غير موجود في الفرع الحالي.');
  const result = h.db.prepare(`SELECT COALESCE(SUM(amount),0) AS balance FROM customer_ledger WHERE customer_id=? AND branch_id=?`).get(Number(customerId), branch.id);
  const balance = h.roundMoney(result?.balance);
  h.db.prepare(`UPDATE customers SET balance=?,updated_at=datetime('now'),synced=0 WHERE id=? AND branch_id=?`).run(balance, Number(customerId), branch.id);
  return balance;
}

function appendCustomerLedger({ customerId, saleId = null, entryType, amount, balanceAfter, notes = null, branchId = null }) {
  const branch = Number(branchId || h.getCurrentBranch().id);
  if (!h.db.prepare('SELECT 1 FROM customers WHERE id=? AND branch_id=?').get(Number(customerId), branch)) throw new Error('العميل غير موجود في الفرع الحالي.');
  const ledgerUuid = h.uuid();
  h.db.prepare(`INSERT INTO customer_ledger (uuid,branch_id,customer_id,sale_id,entry_type,amount,balance_after,notes,synced) VALUES (?,?,?,?,?,?,?,?,0)`)
    .run(ledgerUuid, branch, Number(customerId), saleId, entryType, Number(amount), Number(balanceAfter), notes);
  return ledgerUuid;
}

function getCustomerLedger(customerId) {
  const branch = h.getCurrentBranch();
  if (!h.db.prepare('SELECT 1 FROM customers WHERE id=? AND branch_id=?').get(Number(customerId), branch.id)) throw new Error('العميل غير موجود في الفرع الحالي.');
  const rows = h.db.prepare(`SELECT l.*, s.invoice_number, s.grand_total AS sale_grand_total, s.payment_method AS sale_payment_method
    FROM customer_ledger l
    LEFT JOIN sales s ON s.id = l.sale_id AND s.branch_id = l.branch_id
    WHERE l.customer_id=? AND l.branch_id=?
    ORDER BY l.created_at DESC, l.id DESC`).all(Number(customerId), branch.id);
  // لكل حركة مرتبطة بفاتورة: أرفق ملخص الأصناف (ماذا اشترى) بدون تحميل ثقيل
  const itemsStmt = h.db.prepare(`SELECT si.quantity, si.unit_price, si.line_total, p.name AS product_name
    FROM sale_items si JOIN products p ON p.id = si.product_id
    WHERE si.sale_id = ? ORDER BY si.id LIMIT 40`);
  return rows.map((row) => {
    if (!row.sale_id) return { ...row, items: [], items_summary: null };
    const items = itemsStmt.all(row.sale_id).map((it) => ({
      name: it.product_name,
      quantity: Number(it.quantity || 0),
      unitPrice: Number(it.unit_price || 0),
      lineTotal: Number(it.line_total || 0),
    }));
    const summary = items.map((it) => {
      const qty = it.quantity;
      const qtyLabel = Number.isInteger(qty) ? String(qty) : String(qty);
      return `${qtyLabel}× ${it.name}`;
    }).join(' · ');
    return { ...row, items, items_summary: summary || null };
  });
}

const receiveCustomerPaymentTx = h.db.transaction((payload) => {
  const amount = Number(payload.amount);
  if (!(amount > 0)) throw new Error('مبلغ التسديد غير صالح.');
  const branch = h.getCurrentBranch();
  const customer = h.db.prepare('SELECT balance FROM customers WHERE id=? AND branch_id=?').get(Number(payload.customerId), branch.id);
  if (!customer) throw new Error('العميل غير موجود في الفرع الحالي.');
  const balanceAfter = Math.max(0, Number(customer.balance || 0) - amount);
  const applied = Number(customer.balance || 0) - balanceAfter;
  if (!(applied > 0)) throw new Error('لا يوجد رصيد مستحق على هذا العميل.');
  const paymentMethod = String(payload.paymentMethod || 'cash').trim();
  if (!['cash', 'card'].includes(paymentMethod)) throw new Error('طريقة تسديد دين العميل غير صالحة.');
  h.db.prepare(`UPDATE customers SET balance=?,updated_at=datetime('now'),synced=0 WHERE id=? AND branch_id=?`).run(balanceAfter, Number(payload.customerId), branch.id);
  appendCustomerLedger({ customerId: payload.customerId, entryType: 'payment', amount: -applied, balanceAfter, notes: payload.notes || 'تسديد دين' });
  const currency = String(h.getGlobalProfile().currency_code || 'USD').trim().toUpperCase();
  const shiftId = payload.shiftId || null;
  h.db.prepare(`INSERT INTO payment_transactions(uuid,branch_id,shift_id,method,currency_code,amount,exchange_rate,external_id,masked_descriptor,created_by) VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .run(h.uuid(), branch.id, shiftId, paymentMethod, currency, applied, 1, `customer-payment:${payload.customerId}`, 'تسديد دين عميل', payload.userId || null);
  let cashMovementRecorded = false;
  if (paymentMethod === 'cash' && shiftId) {
    const shift = h.db.prepare("SELECT id FROM shifts WHERE id=? AND branch_id=? AND status='open'").get(shiftId, branch.id);
    if (!shift) throw new Error('جلسة الصندوق المحددة مغلقة أو لا تخص الفرع الحالي.');
    h.db.prepare(`INSERT INTO cash_movements(uuid,branch_id,shift_id,type,amount,reason,reference,created_by) VALUES(?,?,?,?,?,?,?,?)`)
      .run(h.uuid(), branch.id, shiftId, 'cash_in', applied, 'تسديد دين عميل', `customer:${payload.customerId}`, payload.userId || null);
    cashMovementRecorded = true;
  }
  const unit = Number(h.getGlobalProfile()?.currency_minor_unit ?? 2);
  const appliedMinor = money.toMinor(applied, unit);
  h.insertPostedJournalEntry({
    branchId: branch.id, memo: `تسديد دين عميل #${payload.customerId}`, referenceType: 'customer_payment', referenceId: payload.customerId,
    lines: [
      { accountId: h.getAccountingAccountId(branch.id, paymentMethod === 'card' ? '1100' : '1000'), debitMinor: appliedMinor, creditMinor: 0, memo: 'تسديد دين عميل' },
      { accountId: h.getAccountingAccountId(branch.id, '1200'), debitMinor: 0, creditMinor: appliedMinor, memo: 'تخفيض ذمم مدينة' },
    ], createdBy: payload.userId || null,
  });
  return { success: true, applied, balanceAfter, cashMovementRecorded };
});
function receiveCustomerPayment(payload) { return receiveCustomerPaymentTx(payload); }
function getDebtAging() {
  const branch = h.getCurrentBranch();
  return h.db.prepare(`SELECT c.id,c.name,c.phone,c.balance,
    MIN(CASE WHEN l.entry_type='credit_sale' OR (l.entry_type='credit_correction' AND l.amount>0) THEN l.created_at END) AS oldest_debt_at,
    CAST(julianday('now')-julianday(MIN(CASE WHEN l.entry_type='credit_sale' OR (l.entry_type='credit_correction' AND l.amount>0) THEN l.created_at END)) AS INTEGER) AS age_days
    FROM customers c LEFT JOIN customer_ledger l ON l.customer_id=c.id AND l.branch_id=c.branch_id
    WHERE c.branch_id=? AND c.balance>0 GROUP BY c.id ORDER BY age_days DESC,c.balance DESC`).all(branch.id);
}


  return {
    listCustomers,
    getCustomer,
    createCustomer,
    updateCustomer,
    appendStoreCreditLedger,
    recalcStoreCreditBalance,
    recalcCustomerBalance,
    appendCustomerLedger,
    getCustomerLedger,
    receiveCustomerPayment,
    getDebtAging
  };
};
