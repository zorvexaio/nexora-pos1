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
   تقارير الدليفري والوردية
   ========================================================== */
function getDeliverySummary(range = {}) {
  const branch = h.getCurrentBranch();
  const { from, to } = h.dateRangeParams(range);
  const totals = h.db
    .prepare(
      `SELECT COUNT(*) AS orderCount, COALESCE(SUM(delivery_fee),0) AS deliveryFees,
              COALESCE(SUM(subtotal + tax_total - discount_total),0) AS productsRevenue,
              COALESCE(SUM(grand_total),0) AS grandTotal
       FROM sales
       WHERE branch_id = ? AND order_type = 'delivery' AND status IN ('completed','partially_refunded')
         AND created_at BETWEEN ? AND ?`
    )
    .get(branch.id, from, to);

  const byPerson = h.db
    .prepare(
      `SELECT COALESCE(delivery_person,'غير محدد') AS deliveryPerson, COUNT(*) AS orderCount,
              COALESCE(SUM(delivery_fee),0) AS deliveryFees
       FROM sales
       WHERE branch_id = ? AND order_type = 'delivery' AND status IN ('completed','partially_refunded')
         AND created_at BETWEEN ? AND ?
       GROUP BY deliveryPerson ORDER BY deliveryFees DESC`
    )
    .all(branch.id, from, to);

  return { ...totals, byPerson, from, to };
}


  return {
    getDeliverySummary
  };
};
