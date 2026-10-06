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
   المرتجعات
   ========================================================== */
// يُرجع فاتورة كاملة مع بنودها وكمية كل بند التي أُرجعت سابقاً (لمنع إرجاع نفس الوحدة مرتين)
// يبحث برقم الفاتورة المطبوع على الإيصال (مثال: 2026-000123) بدل رقم الصف الداخلي
// بقاعدة البيانات، لأن هذا هو الرقم الوحيد الذي يعرفه المستخدم فعلياً.
function getSaleIdByInvoiceNumber(invoiceNumber) {
  const clean = String(invoiceNumber || '').trim();
  if (!clean) return null;
  const exact = h.db.prepare('SELECT id FROM sales WHERE invoice_number = ?').get(clean);
  if (exact) return exact.id;
  // رقم الفاتورة المطبوع فعلياً على الإيصال شكله طويل (فرع-سنة-جهاز-تسلسل)، لكن
  // المستخدم غالباً بيفتكر بيكتب بس الجزء الرقمي الأخير (مثلاً "20" بدل الرقم
  // الكامل). لو الإدخال أرقام فقط، ندوّر على فاتورة تنتهي بنفس هذا التسلسل
  // (بعد إضافة الأصفار المناسبة) ضمن الفرع الحالي فقط - وإن كان فيه أكثر من
  // تطابق محتمل (غموض)، نرفض ونرجع "غير موجود" بدل تخمين فاتورة عشوائية.
  if (/^\d+$/.test(clean)) {
    const branch = h.getCurrentBranch();
    const suffix = clean.padStart(6, '0');
    const matches = h.db.prepare(
      `SELECT id FROM sales WHERE branch_id = ? AND invoice_number LIKE '%-' || ? LIMIT 2`
    ).all(branch.id, suffix);
    if (matches.length === 1) return matches[0].id;
  }
  return null;
}

function getSaleForReturn(invoiceNumberOrId) {
  // نقبل فقط رقم الفاتورة (أو آخر أجزائه الرقمية) - لم نعد نقبل الرقم الداخلي
  // الخام لقاعدة البيانات كبديل احتياطي، لأنه كان يؤدي لمطابقة فاتورة عشوائية
  // خاطئة تماماً حين لا يُوجد تطابق حقيقي (خطر استرداد مبلغ لفاتورة غلط).
  const saleId = getSaleIdByInvoiceNumber(invoiceNumberOrId);
  if (!saleId) return null;
  const sale = h.getSale(saleId, h.getCurrentBranch().id);
  if (!sale) return null;
  const alreadyReturned = h.db
    .prepare(
      `SELECT ri.sale_item_id, COALESCE(SUM(ri.quantity),0) AS qty
       FROM return_items ri JOIN returns r ON r.id = ri.return_id
       WHERE r.sale_id = ? GROUP BY ri.sale_item_id`
    )
    .all(saleId);
  const returnedMap = Object.fromEntries(alreadyReturned.map((r) => [r.sale_item_id, r.qty]));
  sale.items = sale.items.map((i) => ({ ...i, already_returned: returnedMap[i.id] || 0 }));
  return sale;
}

// إنشاء مرتجع: يرجّع الكمية للمخزون تلقائياً، ويحدّث حالة الفاتورة الأصلية (مرتجع كلي/جزئي)
const createReturnTx = h.db.transaction((payload) => {
  const branch = h.getCurrentBranch();
  const clientRequestId = String(payload.clientRequestId || '').trim();
  if (clientRequestId) {
    const existing = h.db.prepare('SELECT id, uuid, total_refunded FROM returns WHERE branch_id=? AND client_request_id=?').get(branch.id, clientRequestId);
    if (existing) return { ...existing, idempotent: true };
  }
  const refundMethod = String(payload.refundMethod || 'cash');
  if (!['cash','card','store_credit'].includes(refundMethod)) throw new Error('طريقة الاسترداد غير صالحة.');
  const sale = h.db.prepare('SELECT * FROM sales WHERE id = ? AND branch_id = ?').get(payload.saleId, branch.id);
  if (!sale) throw new Error('الفاتورة غير موجودة في الفرع الحالي');
  if (!['completed', 'partially_refunded'].includes(String(sale.status))) {
    throw new Error('لا يمكن إرجاع فاتورة غير مكتملة أو غير مدفوعة. أغلق الطلب أولاً.');
  }
  if (payload.shiftId != null) {
    const shift = h.db.prepare('SELECT id, branch_id, status FROM shifts WHERE id=? AND branch_id=?').get(Number(payload.shiftId), branch.id);
    if (!shift) throw new Error('جلسة الصندوق غير موجودة في الفرع الحالي.');
    if (shift.status !== 'open') throw new Error('جلسة الصندوق مغلقة.');
  }

  if (!Array.isArray(payload.items) || payload.items.length === 0) throw new Error('اختر صنفاً واحداً على الأقل للمرتجع.');
  const returnUuid = h.uuid();
  const returnInfo = h.db
    .prepare(
      `INSERT INTO returns (uuid, branch_id, sale_id, user_id, shift_id, reason, refund_method, total_refunded, client_request_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      returnUuid,
      branch.id,
      payload.saleId,
      payload.userId || null,
      payload.shiftId || null,
      payload.reason || null,
      refundMethod,
      0,
      clientRequestId || null
    );
  const returnId = returnInfo.lastInsertRowid;

  const insertReturnItem = h.db.prepare(
    `INSERT INTO return_items (return_id, sale_item_id, product_id, quantity, refund_amount) VALUES (?, ?, ?, ?, ?)`
  );
  const updateStock = h.db.prepare(
    `UPDATE inventory SET quantity = quantity + ?, updated_at = datetime('now'), synced = 0
     WHERE branch_id = ? AND product_id = ?`
  );
  const logMovement = h.db.prepare(
    `INSERT INTO inventory_movements (uuid, branch_id, product_id, change_qty, reason, ref_id, unit_cost_after, synced)
     VALUES (?, ?, ?, ?, 'return', ?, ?, 0)`
  );

  const alreadyReturnedFor = h.db.prepare(
    `SELECT COALESCE(SUM(quantity),0) AS q FROM return_items WHERE sale_item_id = ?`
  );

  // (بالوحدات الصغرى) مجمع الخصم الموزَّع على البنود عند حساب المسترد: يشمل الخصم اليدوي وخصم "العروض"،
  // وأيضاً قيمة استبدال نقاط الولاء (loyalty_redeemed_value) — لأنها خصم فعلي أنقص ما
  // دفعه العميل حقاً. لولا هذا، كان العميل يُسترد له المبلغ الكامل قبل خصم النقاط (300
  // بدل 296 مثلاً)، أي أكثر مما دفع فعلياً — تسرّب مالي حقيقي، وليس مجرد فرق تقريب.
  const globalProfile = h.getGlobalProfile();
  const accountingUnit = Number(globalProfile.currency_minor_unit ?? 2);
  // كل حساب المرتجع بوحدات صغرى صحيحة: صافي ما دفعه العميل عن البند = (سعر السطر شامل الضريبة) − (حصته من الخصم).
  // المبلغ المسترد، مبلغ القيد المحاسبي، الضريبة، والمتبقي القابل للإرجاع كلها تخرج من نفس الأعداد الصحيحة.
  const minorOf = (minorValue, majorValue) => (minorValue != null && Number.isFinite(Number(minorValue)))
    ? Math.round(Number(minorValue))
    : money.toMinor(Number(majorValue || 0).toFixed(accountingUnit + 6), accountingUnit);
  const isInclusiveItem = (si) => (si.tax_inclusive != null ? Number(si.tax_inclusive) === 1 : globalProfile.tax_mode === 'inclusive');
  const allSaleItems = h.db.prepare('SELECT * FROM sale_items WHERE sale_id = ? ORDER BY id').all(sale.id);
  const merchandiseGrossMinorById = new Map(allSaleItems.map((si) => {
    const gross = minorOf(si.line_total_minor, si.line_total);
    return [si.id, isInclusiveItem(si) ? gross : gross + money.taxMinor(gross, Number(si.tax_rate || 0), false)];
  }));
  const saleItemsTotalBeforeDiscountMinor = [...merchandiseGrossMinorById.values()].reduce((n, v) => n + v, 0);
  const saleDiscountPoolMinor = Math.max(0, Math.min(
    saleItemsTotalBeforeDiscountMinor,
    minorOf(sale.discount_total_minor, sale.discount_total) + minorOf(sale.bundle_discount_total_minor, sale.bundle_discount_total) + minorOf(sale.loyalty_redeemed_value_minor, sale.loyalty_redeemed_value)
  ));
  const allocatedDiscountMinorById = h.allocateByWeight(saleDiscountPoolMinor, allSaleItems.map((si) => [si.id, merchandiseGrossMinorById.get(si.id)]));
  const netPaidMinorOf = (si) => Math.max(0, (merchandiseGrossMinorById.get(si.id) || 0) - (allocatedDiscountMinorById.get(si.id) || 0));
  const refundedRowsFor = h.db.prepare('SELECT refund_amount FROM return_items WHERE sale_item_id = ?');
  // المبلغ القابل للاسترداد لكمية من البند: نسبة كمية × صافي المدفوع، والقطعة الأخيرة تأخذ الباقي بالضبط
  // (فمجموع كل المرتجعات لبند ما = صافي ما دفعه العميل عنه، بلا فلس زائد أو ناقص).
  function refundableAmountMinor(saleItem, quantity, isLastPiece) {
    const soldQuantity = Number(saleItem.quantity);
    if (!(soldQuantity > 0) || !(quantity > 0)) return 0;
    const netPaid = netPaidMinorOf(saleItem);
    const previouslyRefunded = refundedRowsFor.all(saleItem.id).reduce((n, r) => n + minorOf(null, r.refund_amount), 0);
    const leftover = Math.max(0, netPaid - previouslyRefunded);
    return isLastPiece ? leftover : Math.min(leftover, Math.round(netPaid * quantity / soldQuantity));
  }

  let totalRefunded = 0;
  let totalRefundedMinor = 0;
  let totalTaxRefundedMinor = 0;
  let totalCostReversedMinor = 0;
  for (const item of payload.items) {
    const saleItem = h.db.prepare('SELECT * FROM sale_items WHERE id = ? AND sale_id = ?').get(item.saleItemId, payload.saleId);
    if (!saleItem) continue;

    const quantity = Number(item.quantity);
    if (!(quantity > 0)) continue;
    const alreadyReturned = alreadyReturnedFor.get(item.saleItemId).q;
    const remaining = saleItem.quantity - alreadyReturned;
    if (remaining <= 0) continue; // تم إرجاع هذا الصنف بالكامل من قبل
    const cappedQuantity = Math.min(quantity, remaining); // لا يمكن إرجاع أكثر مما بقي غير مُرتجَع
    item.quantity = cappedQuantity;

    const isLastPiece = remaining - cappedQuantity <= 1e-9;
    const refundMinor = refundableAmountMinor(saleItem, item.quantity, isLastPiece);
    const refundAmount = money.fromMinor(refundMinor, accountingUnit);
    insertReturnItem.run(returnId, item.saleItemId, saleItem.product_id, item.quantity, refundAmount);
    const product = h.db.prepare('SELECT track_inventory FROM products WHERE id=?').get(saleItem.product_id);
    if (product?.track_inventory) {
      const stockResult = updateStock.run(item.quantity, branch.id, saleItem.product_id);
      if (stockResult.changes !== 1) throw new Error('تعذّر إعادة الكمية إلى المخزون.');
      const currentCost = h.db.prepare('SELECT COALESCE(unit_cost,0) AS unit_cost FROM inventory WHERE branch_id=? AND product_id=?').get(branch.id, saleItem.product_id)?.unit_cost || 0;
      logMovement.run(h.uuid(), branch.id, saleItem.product_id, item.quantity, returnId, currentCost);
    }
    totalRefundedMinor += refundMinor;
    // نفس منطق tax-inclusive المستخدم أصلاً بحساب refundableUnitAmount: نسبة الضريبة
    // من إجمالي المسترد = rate/(100+rate) بغض النظر عن كون سعر البيع شامل الضريبة أم لا،
    // لأن refundAmount هنا هو المبلغ الإجمالي (شامل الضريبة) أصلاً في الحالتين.
    const rate = Number(saleItem.tax_rate || 0);
    if (rate > 0) totalTaxRefundedMinor += money.taxMinor(refundMinor, rate, true);
    // عكس التكلفة يعتمد على تكلفة هذا البند وقت البيع فعلياً (cost_at_sale) — وليس
    // تكلفة المخزون الحالية — حتى يكون عكساً دقيقاً لنفس قيد COGS الأصلي.
    totalCostReversedMinor += money.toMinor(Number(saleItem.cost_at_sale || 0) * item.quantity, accountingUnit);
  }

  totalRefunded = money.fromMinor(totalRefundedMinor, accountingUnit);
  if (!(totalRefunded > 0)) throw new Error('لم توجد كمية قابلة للإرجاع.');
  // ضريبة المرتجع بنسبة من ضريبة البيع الأصلية (كما رُحِّلت وقت البيع)، لا استخراج inclusive من مبلغ بعد الخصم
  {
    const saleGrandMinor = Math.max(0, minorOf(sale.grand_total_minor, sale.grand_total));
    const saleTaxMinor = Math.max(0, minorOf(sale.tax_total_minor, sale.tax_total));
    if (saleGrandMinor > 0 && saleTaxMinor > 0 && totalRefundedMinor > 0) {
      totalTaxRefundedMinor = Math.min(saleTaxMinor, Math.round((saleTaxMinor * totalRefundedMinor) / saleGrandMinor));
    } else {
      totalTaxRefundedMinor = 0;
    }
  }
  h.db.prepare(`UPDATE returns SET total_refunded = ? WHERE id = ?`).run(totalRefunded, returnId);
// بيع آجل: المرتجع يصفّي المدينين (1200) ورصيد العميل، ولا يدفع نقداً عن مبلغ لم يُحصَّل.
  const originalWasCredit = String(sale.payment_method || '') === 'credit' || Number(sale.due_amount_minor || sale.due_amount || 0) > 0;
  let arClearedMinor = 0;
  if (originalWasCredit && totalRefundedMinor > 0 && sale.customer_id) {
    const customer = h.db.prepare('SELECT balance, balance_minor FROM customers WHERE id=? AND branch_id=?').get(sale.customer_id, branch.id);
    if (customer) {
      const balMinor = customer.balance_minor != null
        ? Number(customer.balance_minor)
        : money.toMinor(Number(customer.balance || 0), accountingUnit);
      arClearedMinor = Math.min(totalRefundedMinor, Math.max(0, balMinor));
      if (arClearedMinor > 0) {
        const newBalMinor = Math.max(0, balMinor - arClearedMinor);
        const newBal = money.fromMinor(newBalMinor, accountingUnit);
        h.db.prepare(`UPDATE customers SET balance=?, balance_minor=?, updated_at=datetime('now'), synced=0 WHERE id=? AND branch_id=?`)
          .run(newBal, newBalMinor, sale.customer_id, branch.id);
        h.appendCustomerLedger({
          customerId: sale.customer_id, saleId: sale.id, entryType: 'return_credit_clear',
          amount: -money.fromMinor(arClearedMinor, accountingUnit), balanceAfter: newBal,
          notes: `تصفية دين مرتجع فاتورة ${sale.invoice_number}`
        });
        // تخفيض due_amount على الفاتورة بما يتناسب مع المُصفَّى
        const dueMinor = Math.max(0, Number(sale.due_amount_minor != null ? sale.due_amount_minor : money.toMinor(Number(sale.due_amount || 0), accountingUnit)));
        const newDueMinor = Math.max(0, dueMinor - arClearedMinor);
        h.db.prepare(`UPDATE sales SET due_amount=?, due_amount_minor=? WHERE id=? AND branch_id=?`)
          .run(money.fromMinor(newDueMinor, accountingUnit), newDueMinor, sale.id, branch.id);
      }
    }
  }

  
  // لا نسجّل حركة نقد/بطاقة عن الجزء الذي صُفِّي من دين العميل (لم يُحصَّل أصلاً)
  const cashRefundMajor = money.fromMinor(Math.max(0, totalRefundedMinor - arClearedMinor), accountingUnit);
  if ((refundMethod === 'cash' || refundMethod === 'card') && cashRefundMajor > 0) {
    h.db.prepare(`INSERT INTO payment_transactions(uuid,branch_id,return_id,shift_id,method,currency_code,amount,exchange_rate,provider,provider_reference,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
      .run(h.uuid(), branch.id, returnId, payload.shiftId || null, refundMethod, String(h.getGlobalProfile().currency_code).toUpperCase(), -cashRefundMajor, 1, null, null, payload.userId || null);
  }
  if (refundMethod === 'store_credit') {
    const customerId = sale.customer_id;
    if (!customerId) throw new Error('إرجاع كرَصيد متجر يتطلب أن تكون الفاتورة مرتبطة بعميل.');
    const customer = h.db.prepare('SELECT balance, store_credit_balance FROM customers WHERE id=? AND branch_id=?').get(customerId, branch.id);
    if (!customer) throw new Error('العميل المرتبط بالفاتورة غير موجود.');
    h.appendStoreCreditLedger({ customerId, saleId: sale.id, returnId, entryType: 'return_credit', amount: totalRefunded, createdBy: payload.userId, branchId: branch.id });
    h.db.prepare(`INSERT INTO payment_transactions(uuid,branch_id,return_id,shift_id,method,currency_code,amount,exchange_rate,provider,provider_reference,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
      .run(h.uuid(), branch.id, returnId, payload.shiftId || null, 'store_credit', String(h.getGlobalProfile().currency_code).toUpperCase(), -totalRefunded, 1, null, null, payload.userId || null);
    h.appendCustomerLedger({ customerId, saleId: sale.id, entryType: 'return_adjustment', amount: 0, balanceAfter: Number(customer.balance || 0), notes: `إصدار رصيد متجر ${totalRefunded.toFixed(2)} من الفاتورة ${sale.invoice_number}` });
  }
  // قيد محاسبي: مدين إيراد مبيعات (عكس) + مدين ضريبة مستحقة (عكس)، دائن حساب التسوية
  // بحسب طريقة الاسترداد الفعلية (نقد/بطاقة/رصيد متجر) — تطابق تماماً ما سُجِّل للتو
  // بـ payment_transactions/store_credit_ledger أعلاه. ثم عكس تكلفة البضاعة المباعة
  // بقيمتها الأصلية وقت البيع إن وُجدت.
  {
    const totalMinor = totalRefundedMinor;
    const taxMinorAmt = Math.min(totalTaxRefundedMinor, totalMinor);
    const revenueMinorAmt = Math.max(0, totalMinor - taxMinorAmt);
    // إن كان أصل البيع آجلاً وما زال هناك دين: سوِّ من 1200. الباقي (إن وُجد) بطريقة الاسترداد.
    const arPart = Math.min(arClearedMinor, totalMinor);
    const cashPart = Math.max(0, totalMinor - arPart);
    const settleCode = refundMethod === 'card' ? '1100' : refundMethod === 'store_credit' ? '2200' : '1000';
    const lines = [];
    if (revenueMinorAmt > 0) lines.push({ accountId: h.getAccountingAccountId(branch.id, '4000'), debitMinor: revenueMinorAmt, creditMinor: 0, memo: `مرتجع فاتورة ${sale.invoice_number}` });
    if (taxMinorAmt > 0) lines.push({ accountId: h.getAccountingAccountId(branch.id, '2100'), debitMinor: taxMinorAmt, creditMinor: 0, memo: `عكس ضريبة مرتجع ${sale.invoice_number}` });
    if (arPart > 0) lines.push({ accountId: h.getAccountingAccountId(branch.id, '1200'), debitMinor: 0, creditMinor: arPart, memo: `تصفية مدينين مرتجع ${sale.invoice_number}` });
    if (cashPart > 0) lines.push({ accountId: h.getAccountingAccountId(branch.id, settleCode), debitMinor: 0, creditMinor: cashPart, memo: `استرداد فاتورة ${sale.invoice_number}` });
    if (totalCostReversedMinor > 0) {
      lines.push({ accountId: h.getAccountingAccountId(branch.id, '1300'), debitMinor: totalCostReversedMinor, creditMinor: 0, memo: `إعادة تكلفة للمخزون ${sale.invoice_number}` });
      lines.push({ accountId: h.getAccountingAccountId(branch.id, '5000'), debitMinor: 0, creditMinor: totalCostReversedMinor, memo: `عكس تكلفة البضاعة المباعة ${sale.invoice_number}` });
    }
    h.insertPostedJournalEntry({ branchId: branch.id, memo: `مرتجع فاتورة ${sale.invoice_number}`, referenceType: 'return', referenceId: returnId, lines, createdBy: payload.userId || null });
  }

  // عكس نقاط الولاء المرتبطة فعلياً بالفاتورة عند الإرجاع، بنسبة قيمة السلع المرتجعة،
  // مع قفلها عند عدد النقاط التي سبق منحها/عكسها حتى لا يمكن تكرار الخصم عبر مرتجعات متتابعة.
  if (sale.customer_id) {
    const saleAward = Number(sale.loyalty_points_awarded || 0);
    const alreadyReversed = Number(sale.loyalty_points_reversed || 0);
    if (saleAward > alreadyReversed && sale.grand_total > 0) {
      const priorRefunded = h.db.prepare(`SELECT COALESCE(SUM(total_refunded),0) AS v FROM returns WHERE sale_id=? AND id<>?`).get(sale.id, returnId).v;
      const ratio = Math.min(1, Math.max(0, Number(totalRefunded + Number(priorRefunded || 0)) / Number(sale.grand_total)));
      const targetReversed = Math.floor(saleAward * ratio);
      const reverseNow = Math.max(0, targetReversed - alreadyReversed);
      if (reverseNow > 0) {
        h.db.prepare("UPDATE customers SET loyalty_points=MAX(0, loyalty_points-?), updated_at=datetime('now'), synced=0 WHERE id=? AND branch_id=?").run(reverseNow, sale.customer_id, branch.id);
        h.db.prepare('UPDATE sales SET loyalty_points_reversed=loyalty_points_reversed+? WHERE id=?').run(reverseNow, sale.id);
      }
    }
    // استعادة نقاط الولاء التي سبق للعميل استبدالها بهذه الفاتورة، بنفس منطق ونسبة
    // العكس أعلاه تماماً لكن بالاتجاه المعاكس: العميل دفع جزءاً من قيمة الفاتورة
    // بنقاطه، وبما إنه يُرجع (كل الفاتورة أو جزء منها) فمن العدل نرجّعله نقاطه بنفس
    // النسبة. loyalty_points_restored يمنع تكرار الاسترجاع على مرتجعات جزئية متتابعة.
    const saleRedeemed = Number(sale.loyalty_points_redeemed || 0);
    const alreadyRestored = Number(sale.loyalty_points_restored || 0);
    if (saleRedeemed > alreadyRestored && sale.grand_total > 0) {
      const priorRefunded = h.db.prepare(`SELECT COALESCE(SUM(total_refunded),0) AS v FROM returns WHERE sale_id=? AND id<>?`).get(sale.id, returnId).v;
      const ratio = Math.min(1, Math.max(0, Number(totalRefunded + Number(priorRefunded || 0)) / Number(sale.grand_total)));
      const targetRestored = Math.floor(saleRedeemed * ratio);
      const restoreNow = Math.max(0, targetRestored - alreadyRestored);
      if (restoreNow > 0) {
        h.db.prepare("UPDATE customers SET loyalty_points=loyalty_points+?, updated_at=datetime('now'), synced=0 WHERE id=? AND branch_id=?").run(restoreNow, sale.customer_id, branch.id);
        h.db.prepare('UPDATE sales SET loyalty_points_restored=loyalty_points_restored+? WHERE id=?').run(restoreNow, sale.id);
      }
    }
  }

  // تحديد إن كانت الفاتورة أصبحت مرتجعة بالكامل أو جزئياً
  const totalItemsQty = h.db.prepare('SELECT COALESCE(SUM(quantity),0) AS q FROM sale_items WHERE sale_id = ?').get(sale.id).q;
  const totalReturnedQty = h.db
    .prepare(
      `SELECT COALESCE(SUM(ri.quantity),0) AS q FROM return_items ri JOIN returns r ON r.id = ri.return_id WHERE r.sale_id = ?`
    )
    .get(sale.id).q;
  const newStatus = totalReturnedQty >= totalItemsQty ? 'refunded' : 'partially_refunded';
  h.db.prepare(`UPDATE sales SET status = ? WHERE id = ?`).run(newStatus, sale.id);

  return { id: returnId, uuid: returnUuid, totalRefunded };
});

function createReturn(payload) {
  return createReturnTx(payload);
}

function listReturns(filters = {}) {
  const branch = h.getCurrentBranch();
  let sql = `SELECT r.*, u.full_name AS user_name FROM returns r LEFT JOIN users u ON u.id = r.user_id WHERE r.branch_id = ?`;
  const params = [branch.id];
  if (filters.from) {
    sql += ' AND r.created_at >= ?';
    params.push(filters.from);
  }
  if (filters.to) {
    sql += ' AND r.created_at <= ?';
    params.push(filters.to);
  }
  sql += ' ORDER BY r.created_at DESC LIMIT 200';
  return h.db.prepare(sql).all(...params);
}

function getReturn(id) {
  const branch = h.getCurrentBranch();
  const ret = h.db.prepare('SELECT * FROM returns WHERE id = ? AND branch_id = ?').get(id, branch.id);
  if (!ret) return null;
  const items = h.db
    .prepare(
      `SELECT ri.*, p.name AS product_name FROM return_items ri JOIN products p ON p.id = ri.product_id WHERE ri.return_id = ?`
    )
    .all(id);
  return { ...ret, items };
}


  return {
    getSaleIdByInvoiceNumber,
    getSaleForReturn,
    createReturn,
    listReturns,
    getReturn
  };
};
