'use strict';
/** Auto-extracted domain module — refactor batch 3–5. Do not call until h.db is initialized. */
module.exports = function createDomain(h) {
  const money = h.money;
  const accounting = h.accounting;
  const crypto = h.crypto;
  const path = h.path;
  const fs = h.fs;
  const app = h.app;

/* ==========================================================
   الورديات (فتح/إغلاق الصندوق)
   ========================================================== */
function getOpenShift() {
  const branch = h.getCurrentBranch();
  return h.db.prepare(`SELECT * FROM shifts WHERE branch_id = ? AND status = 'open' LIMIT 1`).get(branch.id);
}

function openShift(openingAmount, userId) {
  const existing = getOpenShift();
  if (existing) return { success: false, message: 'يوجد وردية مفتوحة بالفعل', shift: existing };
  const branch = h.getCurrentBranch();
  const amount = Number(openingAmount ?? 0);
  const actor = h.db.prepare('SELECT id,is_active FROM users WHERE id=? AND branch_id=?').get(Number(userId), branch.id);
  if (!actor || !actor.is_active) throw new Error('المستخدم الذي يفتح جلسة الصندوق غير صالح.');
  if (!Number.isFinite(amount) || amount < 0) throw new Error('مبلغ افتتاح الصندوق غير صالح.');
  const info = h.db
    .prepare(`INSERT INTO shifts (uuid, branch_id, opened_by, opening_amount, status) VALUES (?, ?, ?, ?, 'open')`)
    .run(h.uuid(), branch.id, actor.id, h.roundMoney(amount));
  return { success: true, id: info.lastInsertRowid };
}

// يحسب الكاش المتوقع في الصندوق: الافتتاحي + صافي المبيعات النقدية (بعد الباقي)
// + حركات الإدخال - المرتجعات النقدية - حركات الإخراج. cash_amount هو المبلغ
// المستلَم فعلياً، لهذا نطرح change_due هنا مرة واحدة.
function computeExpectedCash(shift) {
  const cashSales = h.db
    .prepare(
      `SELECT COALESCE(SUM(cash_amount - change_due),0) AS c FROM sales
       WHERE shift_id = ? AND status IN ('completed','partially_refunded')`
    )
    .get(shift.id).c;
  const cashReturns = h.db
    .prepare(
      `SELECT COALESCE(SUM(r.total_refunded),0) AS c FROM returns r
       WHERE r.shift_id = ? AND r.refund_method = 'cash'`
    )
    .get(shift.id).c;
  const cashIn = h.db.prepare(`SELECT COALESCE(SUM(amount),0) AS c FROM cash_movements WHERE shift_id=? AND type='cash_in'`).get(shift.id).c;
  const cashOut = h.db.prepare(`SELECT COALESCE(SUM(amount),0) AS c FROM cash_movements WHERE shift_id=? AND type='cash_out'`).get(shift.id).c;
  return shift.opening_amount + cashSales - cashReturns + cashIn - cashOut;
}

function getShiftSummary(shiftId, branchId = null, viewerUserId = null, viewerRole = null) {
  const shift = h.db.prepare('SELECT * FROM shifts WHERE id = ? AND (? IS NULL OR branch_id = ?)').get(shiftId, branchId, branchId);
  if (!shift) return null;
  if (viewerUserId != null && Number(shift.opened_by) !== Number(viewerUserId) && !['admin', 'manager'].includes(viewerRole)) {
    throw new Error('لا تملك صلاحية عرض تفاصيل جلسة صندوق فتحها موظف آخر.');
  }
  const sales = h.db
    .prepare(
      `SELECT COUNT(*) AS count, COALESCE(SUM(grand_total),0) AS total,
              COALESCE(SUM(cash_amount - change_due),0) AS cash, COALESCE(SUM(card_amount),0) AS card,
              COALESCE(SUM(delivery_fee),0) AS deliveryFees
       FROM sales WHERE shift_id = ? AND status IN ('completed','partially_refunded')`
    )
    .get(shiftId);
  const returns = h.db
    .prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(total_refunded),0) AS total FROM returns WHERE shift_id = ?`)
    .get(shiftId);
  // كانت "الكاش المتوقع" تحسب صحيح داخلياً (تشمل حركات الصندوق cash_in/cash_out)، لكن الشاشة
  // ما كانت تعرض تفاصيل هالحركات (سلف موظفين، دفعات موردين...الخ) — فيبدو للمستخدم إنها "اختفت"
  // رغم إنها فعلياً مخصومة من الرقم الإجمالي. نرجّع القائمة صراحة ليتم عرضها.
  const movements = h.db.prepare(`SELECT id, type, amount, reason, reference, created_at FROM cash_movements WHERE shift_id=? ORDER BY created_at DESC, id DESC`).all(shiftId);
  return {
    ...shift,
    sales,
    returns,
    movements,
    expectedCash: shift.status === 'closed' ? shift.expected_cash : computeExpectedCash(shift),
  };
}

const closeShiftTx = h.db.transaction((shiftId, actualCash, userId, notes, branchId = null) => {
  const shift = h.db.prepare('SELECT * FROM shifts WHERE id = ? AND (? IS NULL OR branch_id = ?)').get(shiftId, branchId, branchId);
  if (!shift || shift.status !== 'open') throw new Error('لا توجد وردية مفتوحة بهذا المعرّف');
  const branch = h.getCurrentBranch();
  const actor = h.db.prepare('SELECT id,role,is_active FROM users WHERE id=? AND branch_id=?').get(Number(userId), branch.id);
  if (!actor || !actor.is_active) throw new Error('المستخدم الذي يغلق جلسة الصندوق غير صالح.');
  if (Number(shift.opened_by) !== actor.id && !['admin','manager'].includes(actor.role)) throw new Error('لا يمكن إغلاق جلسة صندوق فتحها موظف آخر إلا بواسطة مدير.');
  const actual = Number(actualCash);
  if (!Number.isFinite(actual) || actual < 0) throw new Error('المبلغ الفعلي في الصندوق غير صالح.');
  const expected = computeExpectedCash(shift);
  const diff = actual - expected;
  h.db.prepare(
    `UPDATE shifts SET status='closed', closed_by=?, expected_cash=?, actual_cash=?, cash_difference=?, closed_at=datetime('now'), notes=?
     WHERE id = ?`
  ).run(userId || null, expected, actualCash, diff, notes || null, shiftId);
  return { success: true, expected, actual: actualCash, difference: diff };
});

function closeShift(shiftId, actualCash, userId, notes) {
  const branchId = h.getCurrentBranch().id;
  const shift = h.db.prepare('SELECT opened_by, status FROM shifts WHERE id=? AND branch_id=?').get(Number(shiftId), branchId);
  if (!shift || shift.status !== 'open') throw new Error('لا توجد جلسة صندوق مفتوحة بهذا المعرّف.');
  const actor = h.db.prepare('SELECT role FROM users WHERE id=? AND branch_id=? AND is_active=1').get(Number(userId), branchId);
  if (!actor) throw new Error('المستخدم الحالي غير صالح.');
  if (Number(shift.opened_by) !== Number(userId) && !['admin','manager'].includes(actor.role)) throw new Error('لا يمكن إلا لمن فتح جلسة الصندوق أو لمدير إغلاقها.');
  return closeShiftTx(shiftId, actualCash, userId, notes, branchId);
}

function listShifts(filters = {}) {
  const branch = h.getCurrentBranch();
  let sql = `SELECT s.*, uo.full_name AS opened_by_name, uc.full_name AS closed_by_name
             FROM shifts s
             LEFT JOIN users uo ON uo.id = s.opened_by
             LEFT JOIN users uc ON uc.id = s.closed_by
             WHERE s.branch_id = ?`;
  const params = [branch.id];
  if (filters.from) {
    sql += ' AND s.opened_at >= ?';
    params.push(filters.from);
  }
  if (filters.to) {
    sql += ' AND s.opened_at <= ?';
    params.push(filters.to);
  }
  sql += ' ORDER BY s.opened_at DESC LIMIT 100';
  return h.db.prepare(sql).all(...params);
}

/* ==========================================================
   موديول الرواتب — راتب شهري ثابت + إضافات/خصميات/سلف
   ========================================================== */

  return {
    getOpenShift,
    openShift,
    computeExpectedCash,
    getShiftSummary,
    closeShift,
    listShifts
  };
};
