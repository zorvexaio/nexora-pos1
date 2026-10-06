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
   تصحيح طريقة الدفع على فاتورة محفوظة (بعد إتمام البيع)
   ==========================================================
   ميزة حساسة تلمس سجلاً مالياً محفوظاً — الصلاحية تُتحقق أيضاً في main.js
   (دفاع بالعمق)، والسبب إلزامي، وكل تصحيح يُسجَّل كاملاً بـ audit_logs.
   لا تُغيّر subtotal/tax_total/discount_total/grand_total إطلاقاً؛ فقط
   توزيع الدفع (payment_method/cash_amount/card_amount/due_amount).
   لا تُعدَّل payment_transactions الأصلية (تبقى أثراً تاريخياً لما حصل
   فعلياً وقت البيع) — بدلاً من ذلك تُضاف حركة "تصحيح" جديدة توثّق الفرق.
   ملاحظة مهمة: لو الوردية المرتبطة بالفاتورة مقفولة أصلاً، تقرير إقفالها
   (expected_cash) لا يُعاد حسابه تلقائياً بهذا التصحيح — يبقى فرق موثّق
   فقط بسجل التدقيق، وهذا سلوك متوقّع وليس خللاً. */
const CORRECTABLE_PAYMENT_METHODS = ['cash', 'card', 'mixed', 'credit'];

const correctSalePaymentMethodTx = h.db.transaction((payload) => {
  const branch = h.getCurrentBranch();
  const saleId = Number(payload.saleId);
  const sale = h.db.prepare(`SELECT * FROM sales WHERE id=? AND branch_id=?`).get(saleId, branch.id);
  if (!sale) throw new Error('الفاتورة غير موجودة في الفرع الحالي.');
  if (!['completed', 'partially_refunded'].includes(sale.status)) {
    throw new Error('لا يمكن تصحيح طريقة الدفع إلا على فاتورة مكتملة أو مرتجعة جزئياً.');
  }

  if (payload.actorUserId != null && !userCanModifySales(payload.actorUserId)) throw new Error('تصحيح طريقة الدفع يتطلب مديراً أو مديراً عاماً أو كاشيراً فوّضه المدير العام.');
  const reason = String(payload.reason || '').trim();
  if (!reason) throw new Error('سبب التصحيح مطلوب.');
  if (reason.length > 500) throw new Error('سبب التصحيح طويل جداً.');

  const newMethod = String(payload.newMethod || '').trim();
  if (!CORRECTABLE_PAYMENT_METHODS.includes(newMethod)) throw new Error('طريقة الدفع الجديدة غير صالحة.');

  const total = Number(sale.grand_total) || 0;
  let cashAmount = 0;
  let cardAmount = 0;
  let dueAmount = 0;

  if (newMethod === 'credit') {
    if (!sale.customer_id) throw new Error('لا يمكن تحويل الفاتورة إلى "آجل" بدون عميل مرتبط بها.');
    dueAmount = total;
  } else if (newMethod === 'cash') {
    cashAmount = total;
  } else if (newMethod === 'card') {
    cardAmount = total;
  } else {
    // mixed: يحدّد المدير التوزيع يدوياً
    const mixedUnit = Number(h.getGlobalProfile()?.currency_minor_unit ?? 2);
    const roundToUnit = (v) => money.fromMinor(money.toMinor((Number(v) || 0).toFixed(mixedUnit + 6), mixedUnit), mixedUnit);
    cashAmount = roundToUnit(payload.cashAmount);
    cardAmount = roundToUnit(payload.cardAmount);
  }
  h.validatePaymentAmounts(total, newMethod, cashAmount, cardAmount, 0);

  const oldMethod = sale.payment_method;
  const oldDue = Number(sale.due_amount) || 0;
  const oldCash = Number(sale.cash_amount) || 0;
  const oldCard = Number(sale.card_amount) || 0;
  const unchanged = oldMethod === newMethod && Math.abs(oldDue - dueAmount) < 0.01
    && Math.abs(oldCash - cashAmount) < 0.01 && Math.abs(oldCard - cardAmount) < 0.01;
  if (unchanged) throw new Error('طريقة الدفع الجديدة مطابقة للحالية، لا يوجد ما يُصحَّح.');

  // تسوية دفتر حساب العميل ورصيده لو تغيّر مبلغ "الآجل" (دخولاً أو خروجاً من الدين)
  let customerBalanceAfter = null;
  const dueDelta = h.roundMoney(dueAmount - oldDue);
  if (Math.abs(dueDelta) > 0.01) {
    const customerId = sale.customer_id;
    if (!customerId) throw new Error('تعذّر تسوية دين العميل: لا يوجد عميل مرتبط بهذه الفاتورة.');
    const customer = h.db.prepare('SELECT balance FROM customers WHERE id=? AND branch_id=?').get(customerId, branch.id);
    if (!customer) throw new Error('العميل المرتبط بالفاتورة لم يعد موجوداً.');
    customerBalanceAfter = h.roundMoney(Number(customer.balance || 0) + dueDelta);
    h.db.prepare(`UPDATE customers SET balance=?, updated_at=datetime('now'), synced=0 WHERE id=? AND branch_id=?`)
      .run(customerBalanceAfter, customerId, branch.id);
    h.appendCustomerLedger({
      customerId, saleId, entryType: 'credit_correction', amount: dueDelta, balanceAfter: customerBalanceAfter,
      notes: `تصحيح طريقة دفع الفاتورة ${sale.invoice_number || saleId}: ${reason}`, branchId: branch.id,
    });
  }

  h.db.prepare(`UPDATE sales SET payment_method=?, cash_amount=?, card_amount=?, change_due=0, due_amount=?, synced=0 WHERE id=? AND branch_id=?`)
    .run(newMethod, cashAmount, cardAmount, dueAmount, saleId, branch.id);

  // قيد محاسبي لتصحيح توزيع أصل الدين/النقد/البطاقة فقط. لا نعيد تسجيل الإيراد أو الضريبة؛
  // القيد الأصلي يبقى تاريخياً، وهذا القيد ينقل الرصيد من الحساب القديم إلى الجديد.
  const paymentAccountCodes = { cash: '1000', card: '1100', credit: '1200', mixed: null };
  const paymentAccountIds = h.db.prepare("SELECT id,code FROM accounting_accounts WHERE branch_id=? AND is_active=1 AND code IN ('1000','1100','1200')").all(branch.id);
  const paymentAccountByCode = new Map(paymentAccountIds.map((row) => [String(row.code), Number(row.id)]));
  const requirePaymentAccount = (code) => {
    const id = paymentAccountByCode.get(String(code));
    if (!id) throw new Error(`الحساب المحاسبي ${code} غير موجود.`);
    return id;
  };
  const paymentMinorUnit = Number(h.getGlobalProfile().currency_minor_unit ?? 2);
  const settlementLegs = (method, cash, card, due) => {
    if (method === 'mixed') return [
      ...(cash > 0 ? [{ code: paymentAccountCodes.cash, amount: cash }] : []),
      ...(card > 0 ? [{ code: paymentAccountCodes.card, amount: card }] : []),
    ];
    const code = paymentAccountCodes[method];
    if (!code) return [];
    const amount = method === 'credit' ? due : (method === 'cash' ? cash : card);
    return amount > 0 ? [{ code, amount }] : [];
  };
  const oldSettlement = settlementLegs(oldMethod, oldCash, oldCard, oldDue);
  const newSettlement = settlementLegs(newMethod, cashAmount, cardAmount, dueAmount);
  const correctionLines = [
    ...oldSettlement.map((leg) => ({ accountId: requirePaymentAccount(leg.code), debitMinor: 0, creditMinor: money.toMinor(leg.amount, paymentMinorUnit), memo: `عكس توزيع الدفع ${sale.invoice_number}` })),
    ...newSettlement.map((leg) => ({ accountId: requirePaymentAccount(leg.code), debitMinor: money.toMinor(leg.amount, paymentMinorUnit), creditMinor: 0, memo: `توزيع الدفع المصحح ${sale.invoice_number}` })),
  ];
  if (correctionLines.length) {
    h.insertPostedJournalEntry({
      branchId: branch.id,
      memo: `تصحيح طريقة دفع ${sale.invoice_number}`,
      referenceType: 'sale_payment_method_correction',
      referenceId: saleId,
      lines: correctionLines,
      createdBy: payload.actorUserId || null,
    });
  }

  // حركة تصحيحية توثيقية بدفتر المدفوعات (بدون لمس الحركات الأصلية) — لا حركة لطريقة "آجل" لأنه لا مال فعلي تحرّك
  const currency = String(h.getGlobalProfile().currency_code || 'USD').trim().toUpperCase();
  const insertCorrectionPayment = h.db.prepare(
    `INSERT INTO payment_transactions(uuid,branch_id,sale_id,shift_id,method,currency_code,amount,exchange_rate,masked_descriptor,created_by)
     VALUES(?,?,?,?,?,?,?,?,?,?)`
  );
  const descriptor = `تصحيح دفع: ${oldMethod} → ${newMethod}`;
  if (newMethod === 'cash') insertCorrectionPayment.run(h.uuid(), branch.id, saleId, sale.shift_id || null, 'cash', currency, cashAmount, 1, descriptor, payload.actorUserId || null);
  else if (newMethod === 'card') insertCorrectionPayment.run(h.uuid(), branch.id, saleId, sale.shift_id || null, 'card', currency, cardAmount, 1, descriptor, payload.actorUserId || null);
  else if (newMethod === 'mixed') {
    if (cashAmount > 0) insertCorrectionPayment.run(h.uuid(), branch.id, saleId, sale.shift_id || null, 'cash', currency, cashAmount, 1, descriptor, payload.actorUserId || null);
    if (cardAmount > 0) insertCorrectionPayment.run(h.uuid(), branch.id, saleId, sale.shift_id || null, 'card', currency, cardAmount, 1, descriptor, payload.actorUserId || null);
  }

  const relatedShift = sale.shift_id ? h.db.prepare('SELECT status FROM shifts WHERE id=?').get(sale.shift_id) : null;

  h.logAudit({
    userId: payload.actorUserId || null,
    branchId: branch.id,
    action: 'sale_payment_method_corrected',
    entityType: 'sale',
    entityId: saleId,
    level: 'warning',
    details: {
      invoiceNumber: sale.invoice_number,
      oldMethod, newMethod,
      oldCash, oldCard, oldDue,
      newCash: cashAmount, newCard: cardAmount, newDue: dueAmount,
      reason,
      relatedShiftClosed: relatedShift ? relatedShift.status === 'closed' : null,
    },
  });

  return {
    sale: h.db.prepare('SELECT * FROM sales WHERE id=?').get(saleId),
    customerBalanceAfter,
    relatedShiftClosed: relatedShift ? relatedShift.status === 'closed' : false,
  };
});

function correctSalePaymentMethod(payload) {
  return correctSalePaymentMethodTx(payload);
}


// تعديل بنود فاتورة مكتملة على نفس السجل (بدون إنشاء رقم فاتورة جديد).
// العملية كلها ذرّية: تسعير + مخزون + ذمم + ولاء + قيد تصحيحي + audit + sync.
const modifyCompletedSaleItemsTx = h.db.transaction((payload = {}) => {
  const branch = h.getCurrentBranch();
  const saleId = Number(payload.saleId);
  const sale = h.db.prepare('SELECT * FROM sales WHERE id=? AND branch_id=?').get(saleId, branch.id);
  if (!sale) throw new Error('الفاتورة غير موجودة في الفرع الحالي.');
  if (!['completed','partially_refunded'].includes(String(sale.status))) throw new Error('لا يمكن تعديل فاتورة ملغاة أو مرتجعة بالكامل.');
  if (!Array.isArray(payload.items) || payload.items.length === 0) throw new Error('يجب أن تحتوي الفاتورة المعدلة على صنف واحد على الأقل.');
  const reason = String(payload.reason || '').trim();
  if (!reason) throw new Error('سبب تعديل الفاتورة مطلوب.');
  if (reason.length > 500) throw new Error('سبب تعديل الفاتورة طويل جداً.');
  const actor = h.db.prepare('SELECT id, role, is_active FROM users WHERE id=? AND branch_id=?').get(Number(payload.actorUserId || 0), branch.id);
  // مدير/أدمن بحكم الدور، أو كاشير فوّضه المدير العام بعلامة "تعديل الفواتير" (تُقرأ من القاعدة هنا أيضاً: لا نثق بالواجهة).
  if (!actor || !actor.is_active || !userCanModifySales(actor.id)) throw new Error('تعديل الفاتورة يتطلب مديراً أو مديراً عاماً أو كاشيراً فوّضه المدير العام.');

  const oldItems = h.db.prepare('SELECT si.*, p.name AS product_name, p.track_inventory, p.unit FROM sale_items si JOIN products p ON p.id=si.product_id WHERE si.sale_id=? ORDER BY si.id').all(saleId);
  const returned = h.db.prepare(`SELECT sale_item_id, COALESCE(SUM(quantity),0) q FROM return_items ri JOIN returns r ON r.id=ri.return_id WHERE r.sale_id=? GROUP BY sale_item_id`).all(saleId);
  const returnedMap = new Map(returned.map(r => [Number(r.sale_item_id), Number(r.q||0)]));
  for (const item of oldItems) {
    const rq = returnedMap.get(Number(item.id)) || 0;
    if (rq >= Number(item.quantity) - 1e-9) throw new Error(`لا يمكن تعديل الصنف "${item.product_name}" لأنه مُرجع بالكامل.`);
  }

  const normalized = [];
  for (const raw of payload.items) {
    const productId = Number(raw.productId);
    const quantity = Number(raw.quantity);
    if (!Number.isInteger(productId) || productId <= 0 || !Number.isFinite(quantity) || quantity <= 0) throw new Error('بيانات صنف غير صالحة.');
    normalized.push({ productId, quantity, notes: String(raw.notes || '').trim().slice(0,500) || null });
  }
  // Merge duplicate product lines deterministically.
  const merged = new Map();
  for (const item of normalized) {
    const key = `${item.productId}`;
    const prev = merged.get(key);
    if (prev) prev.quantity += item.quantity;
    else merged.set(key, {...item});
  }
  const itemsForPricing = [...merged.values()];
  const { priced, subtotal, taxTotal, subtotalMinor, taxTotalMinor, minorUnit } = h.priceItemsFromDatabase(itemsForPricing, branch.id);

  const discountType = payload.discountType == null ? (sale.discount_type || 'none') : String(payload.discountType);
  const discountValue = payload.discountValue == null ? Number(sale.discount_value || 0) : Number(payload.discountValue);
  const trustedDiscountApprover = ['admin','manager'].includes(actor.role) ? actor.id : null;
  const { discountTotal, discountType: normalizedDiscountType, discountValue: normalizedDiscountValue, discountApprovedBy } =
    h.assertDiscountAllowed(subtotal, discountType, discountValue, trustedDiscountApprover);
  const discountTotalMinor = money.toMinor(discountTotal, minorUnit);
  const oldQtyByProduct = new Map();
  for (const old of oldItems) {
    const key = Number(old.product_id);
    oldQtyByProduct.set(key, (oldQtyByProduct.get(key) || 0) + Number(old.quantity || 0));
  }
  const returnedQtyByProduct = new Map();
  for (const old of oldItems) {
    const key = Number(old.product_id);
    returnedQtyByProduct.set(key, (returnedQtyByProduct.get(key) || 0) + (returnedMap.get(Number(old.id)) || 0));
  }
  for (const [productId, returnedQty] of returnedQtyByProduct) {
    const newQty = itemsForPricing.filter(i => Number(i.productId) === productId).reduce((n, i) => n + Number(i.quantity || 0), 0);
    if (newQty + 1e-9 < returnedQty) throw new Error(`لا يمكن خفض كمية المنتج ${productId} إلى أقل من الكمية المُرجعة سابقاً (${returnedQty}).`);
  }
  const bundleIds = Array.isArray(payload.bundleIds) ? payload.bundleIds : [];
  if (Number(sale.bundle_discount_total_minor || 0) > 0 && bundleIds.length === 0) throw new Error('هذه الفاتورة تحتوي خصم حزمة سابقاً. اختر الحزمة/الحزم نفسها في شاشة التعديل حتى لا يتغير الخصم بصمت.');
  const bundleResolved = h.resolveBundlesFromDatabase(priced, bundleIds, branch.id, minorUnit);
  h.saveSaleBundleSnapshot(saleId, bundleResolved.applied, minorUnit);
  // كان هذا السقف يقارن bundleDiscountTotal (وحدة كبرى) مباشرة بـsubtotalMinor+...
  // (وحدة صغرى) بـMath.min بلا أي تحويل — خطأ وحدات موجود أصلاً بالكود القديم،
  // يجعل السقف فعلياً بلا معنى لأي فاتورة أصغر من ~1 وحدة كبرى. صار الآن صغرى
  // مقابل صغرى بالكامل، متسقاً مع باقي الدالة.
  const bundleDiscountTotalMinor = Math.min(bundleResolved.totalMinor, Math.max(0, subtotalMinor + taxTotalMinor - discountTotalMinor));
  const deliveryFeeMinor = money.toMinor(Number(sale.delivery_fee || 0), minorUnit);
  const loyaltyRedeemedValueMinor = Math.min(Number(sale.loyalty_redeemed_value_minor || 0), Math.max(0, subtotalMinor + taxTotalMinor - discountTotalMinor - bundleDiscountTotalMinor + deliveryFeeMinor));
  const grandTotalMinor = Math.max(0, subtotalMinor + taxTotalMinor - discountTotalMinor - bundleDiscountTotalMinor + deliveryFeeMinor - loyaltyRedeemedValueMinor);
  const grandTotal = money.fromMinor(grandTotalMinor, minorUnit);

  let cashMinor=0, cardMinor=0, dueMinor=0, changeMinor=0;
  const method=String(sale.payment_method||'cash');
  if(method==='credit') dueMinor=grandTotalMinor;
  else if(method==='cash') cashMinor=grandTotalMinor;
  else if(method==='card') cardMinor=grandTotalMinor;
  else if(method==='mixed') {
    const oldTotal=Math.max(1, Number(sale.grand_total_minor||0));
    const oldCash=Math.max(0, Number(sale.cash_amount_minor||0));
    cashMinor=Math.round(grandTotalMinor*oldCash/oldTotal);
    cardMinor=grandTotalMinor-cashMinor;
  } else throw new Error('طريقة الدفع الحالية غير مدعومة لتعديل البنود.');
  h.validatePaymentAmountsMinor(grandTotalMinor,method,cashMinor,cardMinor,changeMinor);

  // Reverse the original sale's posted journal, then post the new economics under the same sale UUID.
  const oldEntries=h.db.prepare(`SELECT e.id FROM accounting_journal_entries e WHERE e.branch_id=? AND e.reference_id=? AND e.status='posted' AND e.reference_type IN ('sale','sale_payment_method_correction')`).all(branch.id,saleId);
  for(const entry of oldEntries){
    const lines=h.db.prepare('SELECT account_id,debit_minor,credit_minor,memo FROM accounting_journal_lines WHERE entry_id=?').all(entry.id);
    h.insertPostedJournalEntry({branchId:branch.id,memo:`عكس قيد تعديل الفاتورة ${sale.invoice_number}`,referenceType:'sale_modification_reversal',referenceId:saleId,lines:lines.map(l=>({accountId:l.account_id,debitMinor:Number(l.credit_minor||0),creditMinor:Number(l.debit_minor||0),memo:`عكس: ${l.memo||''}`})),createdBy:payload.actorUserId||null});
  }

  // Restore stock for the original sale, then consume stock for the corrected sale.
  const stockUpdate=h.db.prepare(`UPDATE inventory SET quantity=quantity+?,updated_at=datetime('now'),synced=0 WHERE branch_id=? AND product_id=?`);
  const movement=h.db.prepare(`INSERT INTO inventory_movements(uuid,branch_id,product_id,change_qty,reason,ref_id,unit_cost_after,synced) VALUES(?,?,?,?,?,?,?,0)`);
  for(const old of oldItems){
    if(!old.track_inventory) continue;
    const qty=Number(old.quantity||0);
    stockUpdate.run(qty,branch.id,old.product_id);
    movement.run(h.uuid(),branch.id,old.product_id,qty,'sale_modification_reverse',saleId,Number(old.cost_at_sale||0));
  }
  const insertItem=h.db.prepare(`INSERT INTO sale_items(uuid,sale_id,product_id,quantity,unit_price,unit_price_minor,tax_rate,tax_profile_id,tax_inclusive,discount,line_total,line_total_minor,notes,cost_at_sale,cost_at_sale_minor) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const updateItem=h.db.prepare(`UPDATE sale_items SET product_id=?,quantity=?,unit_price=?,unit_price_minor=?,tax_rate=?,tax_profile_id=?,tax_inclusive=?,discount=?,line_total=?,line_total_minor=?,notes=?,cost_at_sale=?,cost_at_sale_minor=? WHERE id=? AND sale_id=?`);
  const oldByProduct=new Map(oldItems.map(i=>[Number(i.product_id),i]));
  const newProductIds=new Set();
  for(const item of priced){
    newProductIds.add(Number(item.productId));
    const old=oldByProduct.get(Number(item.productId));
    if(old){
      updateItem.run(item.productId,item.quantity,item.unitPrice,item.unitPriceMinor,item.taxRate,item.taxProfileId,item.taxInclusive?1:0,0,item.lineTotal,item.lineTotalMinor,item.notes||null,item.costAtSale,item.costAtSaleMinor,old.id,saleId);
    } else {
      insertItem.run(h.uuid(),saleId,item.productId,item.quantity,item.unitPrice,item.unitPriceMinor,item.taxRate,item.taxProfileId,item.taxInclusive?1:0,0,item.lineTotal,item.lineTotalMinor,item.notes||null,item.costAtSale,item.costAtSaleMinor);
    }
    if(item.trackInventory){
      const r=stockUpdate.run(-item.quantity,branch.id,item.productId);
      if(r.changes!==1) throw new Error(`تعذر تحديث مخزون المنتج ${item.productId}.`);
      movement.run(h.uuid(),branch.id,item.productId,-item.quantity,'sale_modification',saleId,item.costAtSale);
    }
  }
  // Build a deterministic kitchen delta before mutating the sale. Positive values mean
  // additions/quantity increases; negative values mean removals/cancellations.
  const newByProduct = new Map(priced.map(item => [Number(item.productId), item]));
  const kitchenDeltaItems = [];
  const allProductIds = new Set([...oldByProduct.keys(), ...newByProduct.keys()]);
  for (const productId of allProductIds) {
    const old = oldByProduct.get(productId);
    const next = newByProduct.get(productId);
    const oldQty = Number(old?.quantity || 0);
    const newQty = Number(next?.quantity || 0);
    const deltaQty = newQty - oldQty;
    if (Math.abs(deltaQty) > 1e-9) {
      kitchenDeltaItems.push({
        productId,
        productName: next?.name || old?.product_name || String(productId),
        deltaQuantity: deltaQty,
        notes: next?.notes || old?.notes || null,
      });
    }
  }

  // Preserve IDs referenced by partial returns. A line with any prior return cannot disappear.
  for(const old of oldItems){
    const returnedQty=returnedMap.get(Number(old.id))||0;
    if(!newProductIds.has(Number(old.product_id))){
      if(returnedQty>0) throw new Error(`لا يمكن حذف الصنف "${old.product_name}" لأنه يحتوي على مرتجع جزئي مرتبط بالفاتورة.`);
      h.db.prepare('DELETE FROM sale_items WHERE id=? AND sale_id=?').run(old.id,saleId);
    }
  }

  const oldDueMinor=Number(sale.due_amount_minor||money.toMinor(sale.due_amount||0,minorUnit));
  const dueDeltaMinor=dueMinor-oldDueMinor;
  if(dueDeltaMinor!==0){
    if(!sale.customer_id) throw new Error('لا يمكن تعديل الدين بدون عميل مرتبط بالفاتورة.');
    const customer=h.db.prepare('SELECT balance FROM customers WHERE id=? AND branch_id=?').get(sale.customer_id,branch.id);
    if(!customer) throw new Error('العميل المرتبط بالفاتورة غير موجود.');
    const balanceAfterMinor=Number(customer.balance_minor ?? money.toMinor(customer.balance||0,minorUnit))+dueDeltaMinor;
    h.db.prepare('UPDATE customers SET balance=?,balance_minor=?,updated_at=datetime(\'now\'),synced=0 WHERE id=? AND branch_id=?').run(money.fromMinor(balanceAfterMinor,minorUnit),balanceAfterMinor,sale.customer_id,branch.id);
    h.appendCustomerLedger({customerId:sale.customer_id,saleId,entryType:'credit_correction',amount:money.fromMinor(dueDeltaMinor,minorUnit),balanceAfter:money.fromMinor(balanceAfterMinor,minorUnit),notes:`تعديل بنود الفاتورة ${sale.invoice_number}: ${reason}`,branchId:branch.id});
  }

  const earnUnit=Number(h.getLoyaltySettings().earnPerCurrencyUnit||10);
  const oldAward=Math.floor(Number(sale.grand_total||0)/earnUnit);
  const newAward=sale.customer_id?Math.floor(grandTotal/earnUnit):0;
  const pointsDelta=newAward-oldAward;
  if(sale.customer_id && pointsDelta!==0){
    h.db.prepare('UPDATE customers SET loyalty_points=MAX(0,loyalty_points+?),updated_at=datetime(\'now\'),synced=0 WHERE id=? AND branch_id=?').run(pointsDelta,sale.customer_id,branch.id);
  }

  h.db.prepare(`UPDATE sales SET subtotal=?,subtotal_minor=?,tax_total=?,tax_total_minor=?,discount_total=?,discount_total_minor=?,discount_type=?,discount_value=?,discount_approved_by=?,bundle_discount_total=?,bundle_discount_total_minor=?,grand_total=?,grand_total_minor=?,cash_amount=?,cash_amount_minor=?,card_amount=?,card_amount_minor=?,change_due=0,change_due_minor=0,due_amount=?,due_amount_minor=?,loyalty_points_awarded=?,synced=0 WHERE id=? AND branch_id=?`).run(
    money.fromMinor(subtotalMinor,minorUnit),subtotalMinor,money.fromMinor(taxTotalMinor,minorUnit),taxTotalMinor,money.fromMinor(discountTotalMinor,minorUnit),discountTotalMinor,normalizedDiscountType,normalizedDiscountValue,discountApprovedBy,money.fromMinor(bundleDiscountTotalMinor,minorUnit),bundleDiscountTotalMinor,grandTotal,grandTotalMinor,money.fromMinor(cashMinor,minorUnit),cashMinor,money.fromMinor(cardMinor,minorUnit),cardMinor,money.fromMinor(dueMinor,minorUnit),dueMinor,newAward,saleId,branch.id);

  const updated=h.db.prepare('SELECT * FROM sales WHERE id=?').get(saleId);
  updated.items=h.db.prepare('SELECT si.*,p.name AS product_name,p.unit FROM sale_items si JOIN products p ON p.id=si.product_id WHERE si.sale_id=? ORDER BY si.id').all(saleId);
  h.postSaleAccountingInTransaction(updated,saleId,branch.id);
  h.logAudit({userId:payload.actorUserId||null,branchId:branch.id,action:'sale_items_modified',entityType:'sale',entityId:saleId,level:'warning',details:{invoiceNumber:sale.invoice_number,reason,before:{subtotal:sale.subtotal,taxTotal:sale.tax_total,grandTotal:sale.grand_total,items:oldItems.map(i=>({id:i.id,productId:i.product_id,quantity:i.quantity,unitPrice:i.unit_price,notes:i.notes}))},after:{subtotal:updated.subtotal,taxTotal:updated.tax_total,grandTotal:updated.grand_total,items:updated.items.map(i=>({id:i.id,productId:i.product_id,quantity:i.quantity,unitPrice:i.unit_price,notes:i.notes}))},pointsDelta,dueDelta:money.fromMinor(dueDeltaMinor,minorUnit)}});
  h.recordSyncOutboxEvent({entityType:'sale',entityUuid:sale.uuid,operation:'update',payload:{id:saleId,uuid:sale.uuid,invoiceNumber:sale.invoice_number,reason:'sale_items_modified'}});
  return {sale:h.getSale(saleId,branch.id),invoiceNumber:sale.invoice_number,kitchenDeltaItems};
});
function modifyCompletedSaleItems(payload){ return modifyCompletedSaleItemsTx(payload); }


  return {
    correctSalePaymentMethod,
    modifyCompletedSaleItems
  };
};
