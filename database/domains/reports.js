'use strict';
/** Auto-extracted domain module — refactor batch 3–5. Do not call until h.db is initialized. */
module.exports = function createDomain(h) {
  const money = h.money;
  const accounting = h.accounting;
  const crypto = h.crypto;
  const path = h.path;
  const fs = h.fs;
  const app = h.app;

/* ---------------- التقارير ---------------- */
// كانت هذه الحركات (سلف موظفين، دفعات موردين...الخ) تُخصم فعلياً من "الكاش المتوقع" بشاشة
// الصندوق بدون أي عرض منفصل لها بشاشة "التقارير" — فكان صاحب المحل يشوف الرقم الكلي بس
// من غير ما يعرف وين راح تفصيله. هذه الدالة تجمّعها حسب السبب لعرضها بوضوح بالتقارير.
function getCashMovementsSummary(range = {}) {
  const branch = h.getCurrentBranch();
  const { from, to } = dateRangeParams(range);
  const rows = h.db.prepare(`SELECT type, reference, reason, amount, created_at FROM cash_movements WHERE branch_id=? AND created_at BETWEEN ? AND ? ORDER BY created_at DESC`).all(branch.id, from, to);
  const groups = new Map();
  let cashIn = 0, cashOut = 0;
  for (const row of rows) {
    const amount = Number(row.amount || 0);
    if (row.type === 'cash_in') cashIn += amount; else cashOut += amount;
    const key = String(row.reference || '').split(':')[0] || 'other';
    const current = groups.get(key) || { key, type: row.type, count: 0, total: 0 };
    current.count += 1;
    current.total += amount;
    groups.set(key, current);
  }
  return { from, to, cashIn, cashOut, net: cashIn - cashOut, groups: [...groups.values()].sort((a, b) => b.total - a.total) };
}

// صاحب المحل كان يفتح "التقارير" ويشوف أرقام الفترة المحددة (مبيعات/ربح/خسارة) مع أرقام
// "لحظية" (الكاش المتوقع بالصندوق الآن، رصيد السلف، رصيد الموردين) بدون أي فاصل بينها، فتختلط
// عليه ولا يعرف شقد لازم يكون معه كاش فعلياً أو شقد ضل من سلفة دفعها أو دين مورد. هذه الدالة
// ترجع "الوضع المالي الآن" بمعزل عن أي فترة تاريخية ليُعرض بقسم منفصل وواضح أعلى صفحة التقارير.
function getBalancesSnapshot() {
  const branch = h.getCurrentBranch();
  const unit = Number(h.getGlobalProfile()?.currency_minor_unit ?? 2);

  const openShift = h.getOpenShift();
  const expectedCash = openShift ? h.computeExpectedCash(openShift) : null;

  const supplierRow = h.db
    .prepare(`SELECT COALESCE(SUM(balance),0) AS total, COUNT(*) AS cnt FROM suppliers WHERE branch_id=? AND balance>0`)
    .get(branch.id);

  const customerRow = h.db
    .prepare(`SELECT COALESCE(SUM(balance),0) AS total, COUNT(*) AS cnt FROM customers WHERE branch_id=? AND balance>0`)
    .get(branch.id);

  const advanceRows = h.db
    .prepare(`SELECT a.id, a.principal_minor,
        COALESCE((SELECT SUM(pa.amount_minor) FROM payroll_advance_payment_allocations pa
                  JOIN payroll_advance_payments p ON p.id=pa.payment_id
                  WHERE p.voided_at IS NULL AND p.advance_id=a.id),0) AS recovered_minor
      FROM payroll_advances a WHERE a.branch_id=? AND a.status='active'`)
    .all(branch.id);
  let advanceRemainingMinor = 0;
  for (const a of advanceRows) {
    advanceRemainingMinor += Math.max(0, Number(a.principal_minor || 0) - Number(a.recovered_minor || 0));
  }

  return {
    expectedCash: expectedCash === null ? null : h.roundMoney(expectedCash),
    shiftOpen: !!openShift,
    supplierDebt: { total: Number(supplierRow.total || 0), count: supplierRow.cnt },
    customerDebt: { total: Number(customerRow.total || 0), count: customerRow.cnt },
    employeeAdvances: { total: money.fromMinor(advanceRemainingMinor, unit), count: advanceRows.filter(a => (Number(a.principal_minor || 0) - Number(a.recovered_minor || 0)) > 0).length },
  };
}

function dateRangeParams(range = {}) {
  // تقارير اليوم/الأسبوع/الشهر يجب أن تُفسَّر حسب المنطقة الزمنية للمؤسسة،
  // لا حسب UTC الخاص بعملية Electron. هذا يمنع انقسام يوم العمل عند منتصف الليل.
  const profile = h.getGlobalProfile();
  const timeZone = profile?.timezone || 'UTC';
  const localDate = (() => {
    try {
      return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    } catch (_) {
      return new Date().toISOString().slice(0, 10);
    }
  })();

  function zonedLocalToUtcSql(value, endOfDay = false) {
    const raw = String(value || '').trim();
    const match = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2}))?$/.exec(raw);
    if (!match) return raw;
    const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
    const hour = match[4] == null ? (endOfDay ? 23 : 0) : Number(match[4]);
    const minute = match[5] == null ? (endOfDay ? 59 : 0) : Number(match[5]);
    const second = match[6] == null ? (endOfDay ? 59 : 0) : Number(match[6]);
    const naive = Date.UTC(year, month - 1, day, hour, minute, second);
    let guess = naive;
    try {
      for (let i = 0; i < 4; i += 1) {
        const parts = new Intl.DateTimeFormat('en-US', {
          timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
        }).formatToParts(new Date(guess));
        const p = Object.fromEntries(parts.filter(x => x.type !== 'literal').map(x => [x.type, x.value]));
        const shownAsUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
        const offset = shownAsUtc - guess;
        guess = naive - offset;
      }
    } catch (_) {
      // إذا كانت المنطقة الزمنية غير صالحة نستخدم UTC كحل آمن ومتوقع.
      guess = naive;
    }
    const d = new Date(guess);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  }

  let from = range.from || `${localDate} 00:00:00`;
  let to = range.to || `${localDate} 23:59:59`;
  // شاشة التقارير ترسل تواريخ محلية على شكل YYYY-MM-DD؛ نحولها هنا إلى UTC.
  if (/^\d{4}-\d{2}-\d{2}(?:[ T]00:00:00)?$/.test(String(from))) from = zonedLocalToUtcSql(String(from).slice(0, 10), false);
  if (/^\d{4}-\d{2}-\d{2}(?:[ T]23:59:59)?$/.test(String(to))) to = zonedLocalToUtcSql(String(to).slice(0, 10), true);
  return { from, to, timeZone };
}

function getSalesSummary(range = {}) {
  const branch = h.getCurrentBranch();
  const { from, to } = dateRangeParams(range);

  const totals = h.db
    .prepare(
      `SELECT COUNT(*) AS count, COALESCE(SUM(subtotal),0) AS subtotal,
              COALESCE(SUM(tax_total),0) AS tax,
              COALESCE(SUM(discount_total + bundle_discount_total),0) AS discount,
              COALESCE(SUM(grand_total),0) AS total
       FROM sales
       WHERE branch_id = ? AND status IN ('completed','partially_refunded') AND created_at BETWEEN ? AND ?`
    )
    .get(branch.id, from, to);

  const byMethod = h.db
    .prepare(
      `SELECT payment_method, COUNT(*) AS count, COALESCE(SUM(grand_total),0) AS total
       FROM sales
       WHERE branch_id = ? AND status IN ('completed','partially_refunded') AND created_at BETWEEN ? AND ?
       GROUP BY payment_method`
    )
    .all(branch.id, from, to);

  const returns = h.db
    .prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(total_refunded),0) AS total
              FROM returns WHERE branch_id=? AND created_at BETWEEN ? AND ?`)
    .get(branch.id, from, to);

  return { ...totals, returnsCount: returns.count, returnsTotal: returns.total, byMethod, from, to };
}

// تُستخدم من تقرير الربح والخسارة لحساب إجمالي مصروف الرواتب الفعلي (للعاملين
// النشطين فقط، بما يطابق ما تعرضه شاشة الرواتب نفسها) خلال فترة التقرير. الراتب
// الشهري يُوزَّع على أيامه بالتناسب مع عدد الأيام المتداخلة بين الشهر وفترة التقرير،
// حتى لا يُحمَّل مدى جزئي (مثلاً أسبوع واحد) براتب الشهر كاملاً أو صفر منه.
function getPayrollExpenseForRange(fromLocalDate, toLocalDate) {
  const branch = h.getCurrentBranch();
  const parseLocal = (s) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''));
    return m ? { y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]) } : null;
  };
  const from = parseLocal(fromLocalDate);
  const to = parseLocal(toLocalDate);
  if (!from || !to) return 0;
  const fromUtc = Date.UTC(from.y, from.mo - 1, from.d);
  const toUtc = Date.UTC(to.y, to.mo - 1, to.d);
  if (toUtc < fromUtc) return 0;

  // net_salary لشهر الرواتب الجاري (لم يُقفل بعد) محسوب أصلاً يوماً بيوم حتى تاريخ اليوم
  // (daysElapsedInPayrollPeriod) — أي أنه مبلغ "مستحق فعلياً حتى الآن"، وليس راتباً شهرياً
  // كاملاً. ضربه هنا مرة أخرى بنسبة (أيام الفترة المطلوبة / أيام الشهر) كان يُطبّق تناسباً
  // فوق تناسب (double proration)، فيُنتج رقماً أصغر بكثير من المصروف الحقيقي. لذلك: الشهر
  // الجاري يُضاف كما هو بلا إعادة تناسب، وإعادة التناسب تبقى فقط للأشهر المُقفلة السابقة
  // (net_salary فيها رقم نهائي كامل للشهر ويصح توزيعه على الأيام المطلوبة منه).
  const todayLocal = h.payrollTodayLocal();
  const currentMonthKey = `${todayLocal.getFullYear()}-${String(todayLocal.getMonth() + 1).padStart(2, '0')}`;

  let total = 0;
  let cursor = new Date(Date.UTC(from.y, from.mo - 1, 1));
  const end = Date.UTC(to.y, to.mo - 1, 1);
  while (cursor.getTime() <= end) {
    const y = cursor.getUTCFullYear();
    const mo = cursor.getUTCMonth() + 1;
    const monthKey = `${y}-${String(mo).padStart(2, '0')}`;
    const monthRow = h.db.prepare('SELECT id FROM payroll_months WHERE branch_id=? AND month_key=?').get(branch.id, monthKey);
    if (monthRow) {
      const daysInMonth = h.daysInPayrollMonth(monthKey);
      const monthStartUtc = Date.UTC(y, mo - 1, 1);
      const monthEndUtc = Date.UTC(y, mo - 1, daysInMonth);
      const overlapStart = Math.max(fromUtc, monthStartUtc);
      const overlapEnd = Math.min(toUtc, monthEndUtc);
      const overlapDays = Math.floor((overlapEnd - overlapStart) / 86400000) + 1;
      if (overlapDays > 0) {
        const rows = h.db.prepare(`SELECT m.net_salary, e.is_active FROM payroll_employee_months m
          JOIN payroll_employees e ON e.id = m.employee_id
          WHERE m.month_id=? AND e.branch_id=?`).all(monthRow.id, branch.id);
        const monthTotal = rows.filter((r) => Number(r.is_active) !== 0).reduce((s, r) => s + Number(r.net_salary || 0), 0);
        total += (monthKey === currentMonthKey) ? monthTotal : monthTotal * (overlapDays / daysInMonth);
      }
    }
    cursor = new Date(Date.UTC(y, mo, 1));
  }
  return h.roundMoney(total);
}

// تقرير الربح والخسارة يحسب الإيراد قبل الضريبة من بيانات البيع التاريخية،
// ويوزع خصومات الفاتورة/الحزم على بنودها ثم يخصم المرتجعات في تاريخ حدوثها.
function getProfitLoss(range = {}) {
  const branch = h.getCurrentBranch();
  const { from, to } = dateRangeParams(range);
  const itemRows = h.db.prepare(`
    SELECT s.id AS sale_id, s.subtotal, s.tax_total, s.discount_total, s.bundle_discount_total,
           si.id AS sale_item_id, si.product_id, si.quantity, si.line_total, si.tax_rate,
           si.tax_inclusive, si.cost_at_sale, p.name AS product_name
    FROM sale_items si
    JOIN sales s ON s.id=si.sale_id
    JOIN products p ON p.id=si.product_id
    WHERE s.branch_id=? AND s.status IN ('completed','partially_refunded') AND s.created_at BETWEEN ? AND ?
    ORDER BY s.id, si.id`).all(branch.id, from, to);

  const plUnit = Number(h.getGlobalProfile()?.currency_minor_unit ?? 2);
  const salesMap = new Map();
  for (const row of itemRows) {
    if (!salesMap.has(row.sale_id)) salesMap.set(row.sale_id, []);
    const rows = salesMap.get(row.sale_id);
    const gross = Math.max(0, Number(row.line_total || 0));
    const rate = Math.max(0, Number(row.tax_rate || 0));
    const inclusive = Number(row.tax_inclusive) === 1;
    // نفس تقريب الفاتورة/القيد المحاسبي (لكل سطر بالوحدة الصغرى) حتى لا يختلف تقرير الأرباح عن دفتر الأستاذ.
    const grossMinorPl = money.toMinor(gross, plUnit);
    const net = inclusive ? money.fromMinor(Math.max(0, grossMinorPl - money.taxMinor(grossMinorPl, rate, true)), plUnit) : gross;
    rows.push({ ...row, gross, net, qty: Number(row.quantity || 0), cost: Math.max(0, Number(row.cost_at_sale || 0)) });
  }

  let revenue = 0;
  let cost = 0;
  let discountTotal = 0;
  const byProductMap = new Map();

  for (const [saleId, rows] of salesMap) {
    const totalNet = rows.reduce((sum, r) => sum + r.net, 0);
    const pool = Math.max(0, Math.min(totalNet, Number(rows[0].discount_total || 0) + Number(rows[0].bundle_discount_total || 0)));
    discountTotal += pool;
    for (const row of rows) {
      const allocated = totalNet > 0 ? pool * (row.net / totalNet) : 0;
      const netAfterDiscount = Math.max(0, row.net - allocated);
      revenue += row.net;
      cost += row.qty * row.cost;
      const current = byProductMap.get(row.product_id) || { id: row.product_id, name: row.product_name, qty: 0, revenue: 0, cost: 0 };
      current.qty += row.qty;
      current.revenue += netAfterDiscount;
      current.cost += row.qty * row.cost;
      byProductMap.set(row.product_id, current);
    }
  }

  const returnRows = h.db.prepare(`
    SELECT ri.sale_item_id, ri.quantity, r.total_refunded, r.created_at,
           si.sale_id, si.product_id, si.quantity AS sold_quantity, si.line_total, si.tax_rate, si.tax_inclusive, si.cost_at_sale,
           s.subtotal, s.tax_total, s.discount_total, s.bundle_discount_total
    FROM return_items ri
    JOIN returns r ON r.id=ri.return_id
    JOIN sale_items si ON si.id=ri.sale_item_id
    JOIN sales s ON s.id=si.sale_id
    WHERE r.branch_id=? AND r.created_at BETWEEN ? AND ?`).all(branch.id, from, to);

  // صافي الفاتورة قبل الخصم يُحسب هنا بنفس تقريب الوحدة الصغرى لكل سطر (بدل قسمة عشرية داخل SQL)
  // حتى يتطابق توزيع الخصم على المرتجعات مع توزيعه على المبيعات أعلاه.
  const saleNetBeforeDiscount = new Map();
  const returnSaleIds = [...new Set(returnRows.map((r) => Number(r.sale_id)))];
  if (returnSaleIds.length) {
    const lineRows = h.db.prepare(`SELECT sale_id, line_total, tax_rate, tax_inclusive FROM sale_items WHERE sale_id IN (${returnSaleIds.map(() => '?').join(',')})`).all(...returnSaleIds);
    for (const li of lineRows) {
      const grossMinorLine = money.toMinor(Math.max(0, Number(li.line_total || 0)), plUnit);
      const rateLine = Math.max(0, Number(li.tax_rate || 0));
      const netMinorLine = Number(li.tax_inclusive) === 1 ? Math.max(0, grossMinorLine - money.taxMinor(grossMinorLine, rateLine, true)) : grossMinorLine;
      saleNetBeforeDiscount.set(Number(li.sale_id), (saleNetBeforeDiscount.get(Number(li.sale_id)) || 0) + money.fromMinor(netMinorLine, plUnit));
    }
  }

  let returnsRevenue = 0;
  let returnsCost = 0;
  for (const row of returnRows) {
    const qty = Math.max(0, Number(row.quantity || 0));
    const soldQty = Number(row.sold_quantity || 0);
    const itemGross = Math.max(0, Number(row.line_total || 0));
    const rate = Math.max(0, Number(row.tax_rate || 0));
    const itemGrossMinorPl = money.toMinor(itemGross, plUnit);
    const itemNet = Number(row.tax_inclusive) === 1 ? money.fromMinor(Math.max(0, itemGrossMinorPl - money.taxMinor(itemGrossMinorPl, rate, true)), plUnit) : itemGross;
    const saleNet = Math.max(0, Number(saleNetBeforeDiscount.get(Number(row.sale_id)) || 0));
    const discountPool = Math.max(0, Math.min(saleNet, Number(row.discount_total || 0) + Number(row.bundle_discount_total || 0)));
    const allocated = saleNet > 0 ? discountPool * (itemNet / saleNet) : 0;
    const unitNetAfterDiscount = soldQty > 0 ? Math.max(0, itemNet - allocated) / soldQty : 0;
    const refundNetRevenue = qty * unitNetAfterDiscount;
    returnsRevenue += refundNetRevenue;
    returnsCost += qty * Math.max(0, Number(row.cost_at_sale || 0));
    const productId = Number(row.product_id);
    const current = byProductMap.get(productId);
    if (current) {
      current.revenue -= refundNetRevenue;
      current.cost -= qty * Math.max(0, Number(row.cost_at_sale || 0));
      current.qty = Math.max(0, current.qty - qty);
    }
  }

  const netRevenue = revenue - discountTotal - returnsRevenue;
  const netCost = cost - returnsCost;
  const grossProfit = netRevenue - netCost;
  const marginPercent = netRevenue > 0 ? (grossProfit / netRevenue) * 100 : 0;
  const byProduct = [...byProductMap.values()]
    .map((r) => ({ ...r, revenue: Math.max(0, r.revenue), cost: Math.max(0, r.cost), profit: Math.max(0, r.revenue) - Math.max(0, r.cost) }))
    .sort((a, b) => b.profit - a.profit);

  // نحسب مصروف الرواتب على التواريخ المحلية كما أدخلها المستخدم في شاشة التقارير
  // (وليس تواريخ from/to أعلاه بعد تحويلها لـ UTC)، لأن شهر الرواتب (month_key)
  // مبني أصلاً على التقويم المحلي للمنشأة.
  const profile = h.getGlobalProfile();
  const timeZone = profile?.timezone || 'UTC';
  const todayLocal = (() => {
    try { return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
    catch (_) { return new Date().toISOString().slice(0, 10); }
  })();
  const fromLocal = range.from ? String(range.from).slice(0, 10) : todayLocal;
  const toLocal = range.to ? String(range.to).slice(0, 10) : todayLocal;
  const payrollExpense = getPayrollExpenseForRange(fromLocal, toLocal);
  // مصروفات تشغيلية (إيجار، كهرباء...) منفصلة عن تكلفة البضاعة وعن الرواتب.
  const operatingExpenses = h.getOperatingExpensesSummary({ from: fromLocal, to: toLocal }).total;
  const netProfit = grossProfit - payrollExpense - operatingExpenses;

  return {
    from,
    to,
    revenue,
    discountTotal,
    netRevenue,
    cost: netCost,
    returnsRevenue,
    returnsCost,
    grossProfit,
    payrollExpense,
    operatingExpenses,
    netProfit,
    marginPercent,
    byProduct,
  };
}

// "الأكثر مبيعاً" يعني الأكثر كمية مباعة فعلياً (قطعة/وحدة)، لا الأكثر إيراداً — منتج رخيص
// يُباع بكثرة يجب أن يظهر قبل منتج غالٍ نادر البيع. كما نطرح الكميات المرتجعة من كل بند
// حتى لا تُحتسب وحدات أُعيدت لاحقاً ضمن "الأكثر مبيعاً".
function getTopProducts(range = {}) {
  const branch = h.getCurrentBranch();
  const { from, to } = dateRangeParams(range);
  const limit = range.limit || 10;

  return h.db
    .prepare(
      `SELECT p.id, p.name,
              COALESCE(SUM(si.quantity - COALESCE(ret.ret_qty,0)),0) AS qty,
              COALESCE(SUM(si.line_total - COALESCE(ret.ret_amount,0)),0) AS total
       FROM sale_items si
       JOIN sales s ON s.id = si.sale_id
       JOIN products p ON p.id = si.product_id
       LEFT JOIN (
         SELECT ri.sale_item_id, SUM(ri.quantity) AS ret_qty, SUM(ri.refund_amount) AS ret_amount
         FROM return_items ri
         JOIN returns r ON r.id = ri.return_id
         WHERE r.branch_id = ?
         GROUP BY ri.sale_item_id
       ) ret ON ret.sale_item_id = si.id
       WHERE s.branch_id = ? AND s.status IN ('completed','partially_refunded') AND s.created_at BETWEEN ? AND ?
       GROUP BY p.id
       HAVING qty > 0
       ORDER BY qty DESC
       LIMIT ?`
    )
    .all(branch.id, branch.id, from, to, limit);
}

// كانت هذه الدالة تُجمِّع المبيعات حسب date(created_at) مباشرة — وcreated_at مخزّن بتوقيت UTC،
// فأي فرع بمنطقة زمنية أمامية عن UTC (مثل تركيا UTC+3) كانت مبيعات ساعات الفجر المحلية (مثلاً
// 00:30-02:59) تُحسَب بالخطأ على اليوم السابق في هذا التقرير رغم وقوعها ضمن نطاق التاريخ المحلي
// الصحيح المفلتَر أعلاه بواسطة dateRangeParams. نجمع الآن يدوياً حسب التاريخ المحلي الفعلي.
function getDailySales(range = {}) {
  const branch = h.getCurrentBranch();
  const { from, to, timeZone } = dateRangeParams(range);

  const rows = h.db
    .prepare(
      `SELECT created_at, grand_total
       FROM sales
       WHERE branch_id = ? AND status IN ('completed','partially_refunded') AND created_at BETWEEN ? AND ?`
    )
    .all(branch.id, from, to);

  let formatter;
  try {
    formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  } catch (_) {
    formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' });
  }

  const byDay = new Map();
  for (const row of rows) {
    const utcDate = new Date(String(row.created_at).replace(' ', 'T') + 'Z');
    const day = Number.isNaN(utcDate.getTime()) ? String(row.created_at).slice(0, 10) : formatter.format(utcDate);
    const entry = byDay.get(day) || { day, count: 0, total: 0 };
    entry.count += 1;
    entry.total += Number(row.grand_total || 0);
    byDay.set(day, entry);
  }

  return [...byDay.values()]
    .map((entry) => ({ ...entry, total: h.roundMoney(entry.total) }))
    .sort((a, b) => a.day.localeCompare(b.day));
}

// قائمة الفواتير ضمن فترة معينة (رقم الفاتورة، التاريخ، العميل، طريقة الدفع، الإجمالي...)
// تُستخدم في شاشة التقارير لعرض كل فاتورة على حدة، مع إمكانية البحث برقم الفاتورة
function getInvoiceList(range = {}) {
  const branch = h.getCurrentBranch();
  const { from, to } = dateRangeParams(range);
  const limit = Math.min(Number(range.limit) || 200, 500);
  const search = String(range.search || '').trim();

  let sql = `SELECT s.id, s.invoice_number, s.created_at, s.payment_method, s.status,
                    s.subtotal, s.tax_total, s.discount_total, s.grand_total, s.due_amount,
                    COALESCE(c.name, s.customer_name_manual) AS customer_name
             FROM sales s LEFT JOIN customers c ON c.id = s.customer_id
             WHERE s.branch_id = ? AND s.created_at BETWEEN ? AND ?`;
  const params = [branch.id, from, to];
  if (search) {
    sql += ` AND s.invoice_number LIKE ?`;
    params.push(`%${search}%`);
  }
  sql += ` ORDER BY s.created_at DESC, s.id DESC LIMIT ?`;
  params.push(limit);

  return h.db.prepare(sql).all(...params);
}


  return {
    getCashMovementsSummary,
    getBalancesSnapshot,
    dateRangeParams,
    getSalesSummary,
    getPayrollExpenseForRange,
    getProfitLoss,
    getTopProducts,
    getDailySales,
    getInvoiceList
  };
};
