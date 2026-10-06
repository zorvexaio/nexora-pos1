'use strict';
/** Auto-extracted domain module — refactor batch 3–5. Do not call until h.db is initialized. */
module.exports = function createDomain(h) {
  const money = h.money;
  const accounting = h.accounting;
  const crypto = h.crypto;
  const path = h.path;
  const fs = h.fs;
  const app = h.app;
  const MAX_LINE_QUANTITY = h.MAX_LINE_QUANTITY;

/* ---------------- المبيعات ---------------- */
// أمان: لا نثق بأي سعر/ضريبة/إجمالي قادم من الواجهة (renderer). كل ما يُخزَّن يُعاد
// حسابه هنا من بيانات المنتج الفعلية في القاعدة والقواعد المسموحة للخصم، حتى لو
// عبثت الواجهة (مثلاً عبر DevTools) بالقيم قبل إرسالها لهذا الاستدعاء.
// يُسعِّر عناصر السلة من قاعدة البيانات مباشرة (لا يثق بأي سعر قادم من الواجهة)، ويتحقق من توفر
// مخزون كافٍ فقط للمنتجات "بكمية محددة" (track_inventory=1). المنتجات "المفتوحة" (بدون تتبع
// كمية — خدمات، أصناف بلا حدّ مخزون) تُستثنى بالكامل من هذا التحقق مهما كانت الكمية المطلوبة.
function priceItemsFromDatabase(items, branchId) {
  const getPrice = h.db.prepare(`SELECT p.id, p.price, p.cost, COALESCE(i.unit_cost, p.cost, 0) AS branch_cost, p.tax_rate, p.tax_profile_id, p.name, p.track_inventory, COALESCE(i.quantity, 0) AS available, tp.code AS tax_profile_code, tp.rate AS profile_rate, tp.is_inclusive AS profile_inclusive FROM products p LEFT JOIN inventory i ON i.product_id=p.id AND i.branch_id=? LEFT JOIN tax_profiles tp ON tp.id=p.tax_profile_id AND tp.branch_id=? AND tp.is_active=1 WHERE p.id=? AND p.is_active=1`);
  const global=h.getGlobalProfile(); const minorUnit=Number(global?.currency_minor_unit ?? 2); let subtotalMinor=0; let taxTotalMinor=0; const priced=[]; const requestedByProduct=new Map();
  for(const item of items||[]){ const productId=Number(item.productId); const quantity=Number(item.quantity); if(!Number.isInteger(productId)||productId<=0) throw new Error('معرّف المنتج غير صالح.'); if(!(Number.isFinite(quantity)&&quantity>0)) throw new Error('كمية غير صالحة في السلة'); if(quantity>MAX_LINE_QUANTITY) throw new Error(`الكمية المطلوبة تتجاوز الحد الأقصى المسموح (${MAX_LINE_QUANTITY}).`); requestedByProduct.set(productId,(requestedByProduct.get(productId)||0)+quantity); }
  for(const [productId,requestedQty] of requestedByProduct){ const product=getPrice.get(branchId,branchId,productId); if(!product) throw new Error('منتج غير موجود ضمن السلة'); if(product.track_inventory&&product.available<requestedQty) throw new Error(`الكمية المتوفرة من "${product.name}" غير كافية (المتوفر: ${product.available}). فعّل "بيع مفتوح بدون تتبّع كمية" لهذا الصنف إن لم ترد التحقق من كميته.`); }
  for(const item of items||[]){ const product=getPrice.get(branchId,branchId,Number(item.productId)); const unitPriceMinor=money.toMinor(product.price,minorUnit); const unitCostMinor=money.toMinor(Math.max(0,Number(product.branch_cost??product.cost??0)),minorUnit); const taxRate=product.profile_rate==null?Number(product.tax_rate||0):Number(product.profile_rate); const inclusive=product.profile_rate!=null?Number(product.profile_inclusive)===1:global.tax_mode==='inclusive'; const lineGrossMinor=money.multiplyMinorQuantity(unitPriceMinor,Number(item.quantity)); const lineTaxMinor=money.taxMinor(lineGrossMinor,taxRate,inclusive); const lineNetMinor=inclusive?Math.max(0,lineGrossMinor-lineTaxMinor):lineGrossMinor; subtotalMinor+=lineNetMinor; taxTotalMinor+=lineTaxMinor; priced.push({productId:item.productId,quantity:Number(item.quantity),unitPrice:money.fromMinor(unitPriceMinor,minorUnit),unitPriceMinor,taxRate,taxProfileId:product.tax_profile_id||null,taxProfileCode:product.tax_profile_code||null,taxInclusive:inclusive,lineTotal:money.fromMinor(lineGrossMinor,minorUnit),lineTotalMinor:lineGrossMinor,notes:item.notes||null,costAtSale:money.fromMinor(unitCostMinor,minorUnit),costAtSaleMinor:unitCostMinor,trackInventory:Boolean(product.track_inventory)}); }
  return {priced,subtotalMinor,taxTotalMinor,subtotal:money.fromMinor(subtotalMinor,minorUnit),taxTotal:money.fromMinor(taxTotalMinor,minorUnit),minorUnit};
}

// تسعير مسبق (quote) قبل إنشاء البيع فعلياً — تستخدمه شاشة الكاشير السريع لعرض
// نفس الإجمالي الذي سيحسبه createSaleTx بالضبط (بضريبته وتقريبه)، بدل أن تحسب
// الواجهة إجمالياً تقريبياً محلياً قد لا يطابق ما يُحفظ فعلياً عند الدفع.
function quoteSale(items, branchId) {
  const branch = branchId || h.getCurrentBranch().id;
  const { subtotal, taxTotal, subtotalMinor, taxTotalMinor, minorUnit, priced } = priceItemsFromDatabase(items, branch);
  const grandTotalMinor = subtotalMinor + taxTotalMinor;
  const grandTotal = money.fromMinor(grandTotalMinor, minorUnit);
  return { subtotal, taxTotal, subtotalMinor, taxTotalMinor, grandTotal, grandTotalMinor, minorUnit, priced };
}

// يتحقق أن الخصم الإجمالي المطلوب لا يتجاوز حد الكاشير، إلا بموافقة مدير/مدير عام
// حقيقية (نتحقق من هوية الموافق في القاعدة، لا نثق بالـ id القادم من الواجهة فقط)
// يُرجع { discountTotal, discountApprovedBy } — يُصفّر معرّف الموافق إن لم يكن صالحاً فعلياً
function assertDiscountAllowed(subtotal, discountType, discountValue, discountApprovedBy) {
  const normalizedType = discountType == null || discountType === '' ? 'none' : String(discountType);
  // شاشة "الكاشير السريع" (quick-cashier) لا تملك أصلاً واجهة خصم، فترسل sale
  // بدون discountValue إطلاقاً (undefined) — لا نعامل غياب الحقل كقيمة خاطئة،
  // بل كخصم صفري، تماماً كما تفعل شاشة تعديل الفاتورة (سطر ~4901) أصلاً.
  const rawValue = discountValue == null || discountValue === '' ? 0 : Number(discountValue);
  if (!['none', 'percent', 'fixed'].includes(normalizedType)) throw new Error('نوع الخصم غير صالح.');
  if (!Number.isFinite(rawValue) || rawValue < 0) throw new Error('قيمة الخصم غير صالحة.');
  if (normalizedType === 'none' || rawValue <= 0 || subtotal <= 0) {
    return { discountTotal: 0, discountType: null, discountValue: 0, discountApprovedBy: null };
  }

  const requested = normalizedType === 'percent'
    ? subtotal * (Math.min(rawValue, 100) / 100)
    : Math.min(rawValue, subtotal);
  const capped = Math.max(0, Math.min(requested, subtotal));
  const maxPercent = h.getMaxCashierDiscountPercent();
  const effectivePercent = subtotal > 0 ? (capped / subtotal) * 100 : 0;
  if (effectivePercent <= maxPercent + 0.001) {
    return { discountTotal: capped, discountType: normalizedType, discountValue: rawValue, discountApprovedBy: null };
  }

  if (discountApprovedBy) {
    const branch = h.getCurrentBranch();
    const approver = h.db
      .prepare(`SELECT role, is_active FROM users WHERE id = ? AND branch_id = ?`)
      .get(discountApprovedBy, branch.id);
    if (approver && approver.is_active && ['admin', 'manager'].includes(approver.role)) {
      return { discountTotal: capped, discountType: normalizedType, discountValue: rawValue, discountApprovedBy };
    }
  }
  // لا موافقة صالحة: نُقلِّص الخصم إلى الحد الأقصى المسموح للكاشير، مهما كانت قيمة الواجهة.
  return { discountTotal: subtotal * (maxPercent / 100), discountType: normalizedType, discountValue: rawValue, discountApprovedBy: null };
}

function assertCreditSaleAllowed(sale) {
  if (sale.paymentMethod !== 'credit') return;
  if (!sale.customerId) throw new Error('البيع الآجل يتطلب اختيار عميل.');
  const branch = h.getCurrentBranch();
  const approver = sale.creditApprovedBy && h.db.prepare('SELECT role, is_active FROM users WHERE id = ? AND branch_id = ?').get(sale.creditApprovedBy, branch.id);
  if (!approver || !approver.is_active || !['admin', 'manager'].includes(approver.role)) {
    throw new Error('البيع الآجل يتطلب موافقة مدير أو مدير عام.');
  }
}

function getTerminalInvoiceToken() {
  const filePath = path.join(app.getPath('userData'), 'terminal-invoice-id.txt');
  try {
    if (fs.existsSync(filePath)) {
      const existing = fs.readFileSync(filePath, 'utf8').trim().toUpperCase();
      if (/^[A-Z0-9]{8}$/.test(existing)) return existing;
    }
  } catch (_) {}
  const token = crypto.randomBytes(6).toString('base64url').replace(/[^A-Z0-9]/gi, '').slice(0, 8).toUpperCase().padEnd(8, '0');
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, token, { mode: 0o600 });
  } catch (_) {}
  return token;
}

function nextInvoiceNumber() {
  const branch = h.getCurrentBranch();
  const year = new Date().getFullYear();
  const branchToken = String(branch.uuid || branch.id).replace(/[^a-z0-9]/gi, '').slice(0, 6).toUpperCase() || String(branch.id);
  const terminalToken = getTerminalInvoiceToken();
  const key = `invoice_sequence_${branch.uuid || branch.id}_${terminalToken}_${year}`;
  let next = Number(h.getSetting(key, '0')) + 1;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = `${branchToken}-${year}-${terminalToken}-${String(next).padStart(6, '0')}`;
    const collision = h.db.prepare('SELECT id FROM sales WHERE invoice_number = ? LIMIT 1').get(candidate);
    if (!collision) {
      h.setSetting(key, String(next));
      return candidate;
    }
    next += 1;
  }
  throw new Error('تعذّر توليد رقم فاتورة فريد على هذا الجهاز.');
}

// يحسب خصم العروض ويُرجع أيضاً تفاصيل كل عرض طُبِّق (للطباعة والـ Snapshot).
// minorUnit اختياري: لو لم يُمرَّر (مثلاً عند استدعاء قديم لا يعرفه) تُقرأ دقة
// العملة من الإعداد العام — لكن كل المستدعين الحاليين بـcreateSaleTx/updateSaleTx
// يمرّرونها فعلياً لأنها متوفرة أصلاً لديهم من priceItemsFromDatabase.
function resolveBundlesFromDatabase(items, bundleIds, branchId, minorUnit) {
  const unit = Number.isInteger(minorUnit) ? minorUnit : Number(h.getGlobalProfile()?.currency_minor_unit ?? 2);
  const empty = { total: 0, totalMinor: 0, applied: [] };
  const ids = [...new Set((Array.isArray(bundleIds) ? bundleIds : []).map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))];
  if (!ids.length || !Array.isArray(items) || items.length === 0) return empty;

  const placeholders = ids.map(() => '?').join(',');
  const bundles = h.db.prepare(`SELECT * FROM bundles WHERE branch_id = ? AND is_active = 1 AND id IN (${placeholders}) ORDER BY id`).all(branchId, ...ids);
  const itemRows = h.db.prepare(`SELECT bi.bundle_id, bi.product_id, bi.quantity, p.price, p.name AS product_name, p.uuid AS product_uuid
    FROM bundle_items bi JOIN products p ON p.id = bi.product_id
    WHERE bi.bundle_id IN (${placeholders}) ORDER BY bi.bundle_id, bi.id`).all(...ids);
  const byBundle = new Map();
  for (const row of itemRows) {
    if (!byBundle.has(row.bundle_id)) byBundle.set(row.bundle_id, []);
    byBundle.get(row.bundle_id).push(row);
  }
  const qtyByProduct = new Map();
  for (const item of items) qtyByProduct.set(Number(item.productId), (qtyByProduct.get(Number(item.productId)) || 0) + Number(item.quantity));

  // نفس منطق الواجهة تماماً: نجرّب ترتيبات تطبيق الحزم ونختار الأكبر خصماً للزبون،
  // حتى لا يختلف إجمالي الشاشة عن الفاتورة المحفوظة. الحساب كله بوحدات صغرى صحيحة.
  const candidates = [];
  for (const bundle of bundles) {
    const bundleItems = byBundle.get(bundle.id) || [];
    if (!bundleItems.length || bundleItems.some((i) => !(i.quantity > 0))) continue;
    const bundleSubtotalPerAppMinor = bundleItems.reduce((sum, item) => sum + money.toMinor(Number(item.price || 0), unit) * Number(item.quantity), 0);
    const value = Number(bundle.discount_value) || 0;
    const discountPerAppMinor = bundle.discount_type === 'fixed_price'
      ? Math.max(0, bundleSubtotalPerAppMinor - money.toMinor(value, unit))
      : Math.round(bundleSubtotalPerAppMinor * (Math.min(Math.max(value, 0), 100) / 100));
    if (discountPerAppMinor > 0) candidates.push({ bundle, bundleItems, discountPerAppMinor });
  }
  const runOrder = (order) => {
    const remaining = new Map(qtyByProduct);
    let totalMinor = 0;
    const applied = [];
    for (const { bundle, bundleItems, discountPerAppMinor } of order) {
      let maxApplications = Infinity;
      for (const item of bundleItems) maxApplications = Math.min(maxApplications, Math.floor((remaining.get(item.product_id) || 0) / item.quantity));
      if (!Number.isFinite(maxApplications) || maxApplications < 1) continue;
      for (const item of bundleItems) remaining.set(item.product_id, (remaining.get(item.product_id) || 0) - item.quantity * maxApplications);
      const bundleTotalDiscountMinor = discountPerAppMinor * maxApplications;
      totalMinor += bundleTotalDiscountMinor;
      applied.push({
        bundleId: bundle.id,
        bundleUuid: bundle.uuid,
        name: bundle.name,
        applications: maxApplications,
        discount: money.fromMinor(bundleTotalDiscountMinor, unit),
        discountMinor: bundleTotalDiscountMinor,
        items: bundleItems.map((i) => ({ product_id: i.product_id, product_uuid: i.product_uuid, product_name: i.product_name, quantity: Number(i.quantity) })),
      });
    }
    return { totalMinor, applied };
  };
  let best = null;
  if (candidates.length <= 6) {
    const permute = (arr, cur = []) => {
      if (!arr.length) { const r = runOrder(cur); if (!best || r.totalMinor > best.totalMinor) best = r; return; }
      arr.forEach((x, i) => permute([...arr.slice(0, i), ...arr.slice(i + 1)], [...cur, x]));
    };
    permute(candidates);
  } else {
    best = runOrder([...candidates].sort((a, b) => b.discountPerAppMinor - a.discountPerAppMinor));
  }
  const totalDiscountMinor = best ? best.totalMinor : 0;
  const applied = best ? best.applied : [];
  const capMinor = Math.max(0, items.reduce((sum, item) => sum + money.toMinor(Number(item.unitPrice || 0), unit) * Number(item.quantity || 0), 0));
  const finalTotalMinor = Math.min(totalDiscountMinor, capMinor);
  return { total: money.fromMinor(finalTotalMinor, unit), totalMinor: finalTotalMinor, applied };
}

function calculateBundleDiscountFromDatabase(items, bundleIds, branchId, minorUnit) {
  return resolveBundlesFromDatabase(items, bundleIds, branchId, minorUnit).total;
}

// Snapshot للعروض المطبَّقة على الفاتورة (يُستبدل كاملاً عند تعديل بنود الفاتورة).
function saveSaleBundleSnapshot(saleId, applied, minorUnit) {
  h.db.prepare('DELETE FROM sale_bundles WHERE sale_id = ?').run(saleId);
  const ins = h.db.prepare(`INSERT INTO sale_bundles (uuid, sale_id, bundle_id, bundle_uuid, bundle_name, applications, discount, discount_minor, items_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const b of applied || []) {
    // discountMinor يصل الآن جاهزاً صحيحاً (عدد صحيح) من resolveBundlesFromDatabase —
    // لا إعادة تحويل بفاصلة عائمة هنا. fallback للطريقة القديمة فقط لمصدر لا يزوّده.
    const discountMinor = Number.isInteger(b.discountMinor) ? b.discountMinor : money.toMinor(Number(b.discount || 0).toFixed(minorUnit + 6), minorUnit);
    ins.run(h.uuid(), saleId, b.bundleId || null, b.bundleUuid || null, String(b.name || ''), Number(b.applications || 1), money.fromMinor(discountMinor, minorUnit), discountMinor, JSON.stringify(b.items || []));
  }
}

function getSaleBundles(saleId) {
  return h.db.prepare('SELECT * FROM sale_bundles WHERE sale_id = ? ORDER BY id').all(saleId).map((row) => {
    let parsed = [];
    try { parsed = JSON.parse(row.items_json || '[]'); } catch (_) { parsed = []; }
    const apps = Math.max(1, Number(row.applications || 1));
    return {
      id: row.id,
      name: row.bundle_name,
      applications: apps,
      discount: Number(row.discount || 0),
      items: (Array.isArray(parsed) ? parsed : []).map((i) => {
        const local = i.product_uuid ? h.db.prepare('SELECT id FROM products WHERE uuid = ?').get(i.product_uuid) : null;
        return { product_id: local?.id ?? i.product_id ?? null, product_name: String(i.product_name || ''), quantity: Number(i.quantity || 0) * apps };
      }),
    };
  });
}

// يوزّع مبلغاً صحيحاً (وحدات صغرى) على عناصر بحسب أوزانها بطريقة "أكبر باقٍ" (Largest Remainder)
// بحيث يساوي مجموع الحصص المبلغ تماماً، بلا كسور ولا انجراف. entries = [[key, weightMinor], ...]
function allocateByWeight(totalMinor, entries) {
  const out = new Map(entries.map(([key]) => [key, 0]));
  const sumWeight = entries.reduce((n, [, w]) => n + Math.max(0, Number(w) || 0), 0);
  if (!(totalMinor > 0) || !(sumWeight > 0)) return out;
  let assigned = 0;
  const remainders = [];
  entries.forEach(([key, w0], index) => {
    const w = Math.max(0, Number(w0) || 0);
    const raw = totalMinor * w;
    const base = Math.floor(raw / sumWeight);
    out.set(key, base);
    assigned += base;
    remainders.push({ key, index, r: raw - base * sumWeight });
  });
  let left = totalMinor - assigned;
  remainders.sort((a, b) => b.r - a.r || a.index - b.index);
  for (let i = 0; left > 0 && i < remainders.length; i++, left--) out.set(remainders[i].key, out.get(remainders[i].key) + 1);
  return out;
}

// كان هذا المتحقق القديم يعمل بالفاصلة العشرية مع تسامح 0.01 (وهو 10 وحدات صغرى في عملة بثلاث خانات).
// صار غلافاً رقيقاً فوق validatePaymentAmountsMinor: كل مسارات الدفع تتحقق الآن بالوحدة الصغرى وبدقة تامة.
function validatePaymentAmounts(total, paymentMethod, cashAmount, cardAmount, changeDue) {
  const unit = Number(h.getGlobalProfile()?.currency_minor_unit ?? 2);
  const t = Number(total);
  if (!Number.isFinite(t) || t < 0) throw new Error('إجمالي الفاتورة غير صالح.');
  const toMinorChecked = (value) => {
    const n = Number(value) || 0;
    if (!Number.isFinite(n) || n < 0) throw new Error('بيانات الدفع غير صالحة.');
    return money.toMinor(n.toFixed(unit + 6), unit);
  };
  return validatePaymentAmountsMinor(money.toMinor(t.toFixed(unit + 6), unit), paymentMethod, toMinorChecked(cashAmount), toMinorChecked(cardAmount), toMinorChecked(changeDue));
}

function validatePaymentAmountsMinor(totalMinor, paymentMethod, cashMinor, cardMinor, changeMinor) {
  const total = Number(totalMinor);
  const cash = Number(cashMinor) || 0;
  const card = Number(cardMinor) || 0;
  const change = Number(changeMinor) || 0;
  if (!Number.isInteger(total) || total < 0) throw new Error('إجمالي الفاتورة غير صالح.');
  if (!['cash', 'card', 'mixed', 'credit', 'store_credit'].includes(paymentMethod)) throw new Error('طريقة الدفع غير صالحة.');
  if ([cash, card, change].some((n) => !Number.isInteger(n) || n < 0)) throw new Error('بيانات الدفع غير صالحة.');
  if (paymentMethod === 'store_credit') {
    if (cash !== 0 || card !== 0 || change !== 0) throw new Error('رصيد المتجر لا يقبل نقداً أو بطاقة في نفس العملية.');
    return;
  }
  if (paymentMethod === 'credit') {
    if (cash !== 0 || card !== 0 || change !== 0) throw new Error('البيع الآجل لا يقبل دفعة نقدية أو بطاقة في نفس العملية.');
    return;
  }
  if (paymentMethod === 'cash') {
    if (cash < total) throw new Error('المبلغ النقدي غير كافٍ لتغطية إجمالي الفاتورة.');
    if (cash - total !== change) throw new Error('الباقي النقدي غير مطابق للمبلغ المستلم.');
    return;
  }
  if (paymentMethod === 'card') {
    if (card !== total || cash !== 0 || change !== 0) throw new Error('مبلغ البطاقة غير متطابق مع إجمالي الفاتورة.');
    return;
  }
  if (cash + card !== total || change !== 0) throw new Error('مبالغ الدفع المختلط غير متطابقة مع إجمالي الفاتورة.');
}

function postSaleAccountingInTransaction(sale, saleId, branchId) {
  // Normalize DB rows (snake_case) and internal accounting DTOs (camelCase) to one
  // canonical shape. This is critical for correction flows, which intentionally read
  // the current sale directly from SQLite inside the same transaction.
  const canonicalSale = {
    ...sale,
    paymentMethod: sale.paymentMethod ?? sale.payment_method ?? 'cash',
    invoiceNumber: sale.invoiceNumber ?? sale.invoice_number ?? String(saleId),
    userId: sale.userId ?? sale.user_id ?? null,
    subtotalMinor: Number(sale.subtotalMinor ?? sale.subtotal_minor ?? 0),
    taxTotalMinor: Number(sale.taxTotalMinor ?? sale.tax_total_minor ?? 0),
    discountTotalMinor: Number(sale.discountTotalMinor ?? sale.discount_total_minor ?? 0),
    bundleDiscountTotalMinor: Number(sale.bundleDiscountTotalMinor ?? sale.bundle_discount_total_minor ?? 0),
    loyaltyRedeemedValueMinor: Number(sale.loyaltyRedeemedValueMinor ?? sale.loyalty_redeemed_value_minor ?? 0),
    deliveryFeeMinor: Number(sale.deliveryFeeMinor ?? sale.delivery_fee_minor ?? 0),
    grandTotalMinor: Number(sale.grandTotalMinor ?? sale.grand_total_minor ?? 0),
    cashAmountMinor: Number(sale.cashAmountMinor ?? sale.cash_amount_minor ?? 0),
    cardAmountMinor: Number(sale.cardAmountMinor ?? sale.card_amount_minor ?? 0),
    items: Array.isArray(sale.items) ? sale.items : [],
  };
  const accountRows = h.db.prepare('SELECT id,code FROM accounting_accounts WHERE branch_id=? AND is_active=1 AND code IN (?,?,?,?,?,?,?,?,?)').all(branchId, '1000','1100','1200','1300','2100','2200','4000','4100','5000');
  const byCode = new Map(accountRows.map((row) => [String(row.code), Number(row.id)]));
  const requireAccount = (code) => { const id = byCode.get(code); if (!id) throw new Error(`الحساب المحاسبي ${code} غير موجود.`); return id; };
  const revenueMinor = Math.max(0, Number(canonicalSale.subtotalMinor || 0) - Number(canonicalSale.discountTotalMinor || 0) - Number(canonicalSale.bundleDiscountTotalMinor || 0) - Number(canonicalSale.loyaltyRedeemedValueMinor || 0));
  const taxMinor = Math.max(0, Number(canonicalSale.taxTotalMinor || 0));
  const deliveryMinor = Math.max(0, Number(canonicalSale.deliveryFeeMinor || 0));
  const costMinor = canonicalSale.items.reduce((sum, item) => sum + money.multiplyMinorQuantity(Number(item.costAtSaleMinor || 0), Number(item.quantity || 0)), 0);
  const lines = [];
  const totalDebit = Number(canonicalSale.grandTotalMinor || 0);
  if (canonicalSale.paymentMethod === 'mixed') {
    if (Number(canonicalSale.cashAmountMinor || 0) > 0) lines.push({ accountId: requireAccount('1000'), debitMinor: Number(canonicalSale.cashAmountMinor), creditMinor: 0, memo: `Cash settlement ${canonicalSale.invoiceNumber}` });
    if (Number(canonicalSale.cardAmountMinor || 0) > 0) lines.push({ accountId: requireAccount('1100'), debitMinor: Number(canonicalSale.cardAmountMinor), creditMinor: 0, memo: `Card settlement ${canonicalSale.invoiceNumber}` });
  } else {
    let settlementAccountCode = '1000';
    if (canonicalSale.paymentMethod === 'card') settlementAccountCode = '1100';
    else if (canonicalSale.paymentMethod === 'credit') settlementAccountCode = '1200';
    else if (canonicalSale.paymentMethod === 'store_credit') settlementAccountCode = '2200';
    if (totalDebit > 0) lines.push({ accountId: requireAccount(settlementAccountCode), debitMinor: totalDebit, creditMinor: 0, memo: `Settlement ${canonicalSale.invoiceNumber}` });
  }
  if (revenueMinor > 0) lines.push({ accountId: requireAccount('4000'), debitMinor: 0, creditMinor: revenueMinor, memo: `Sales revenue ${canonicalSale.invoiceNumber}` });
  if (deliveryMinor > 0) lines.push({ accountId: requireAccount('4100'), debitMinor: 0, creditMinor: deliveryMinor, memo: `Delivery revenue ${canonicalSale.invoiceNumber}` });
  if (taxMinor > 0) lines.push({ accountId: requireAccount('2100'), debitMinor: 0, creditMinor: taxMinor, memo: `Tax payable ${canonicalSale.invoiceNumber}` });
  if (costMinor > 0) {
    lines.push({ accountId: requireAccount('5000'), debitMinor: costMinor, creditMinor: 0, memo: `COGS ${canonicalSale.invoiceNumber}` });
    lines.push({ accountId: requireAccount('1300'), debitMinor: 0, creditMinor: costMinor, memo: `Inventory ${canonicalSale.invoiceNumber}` });
  }
  // Revenue/tax settlement plus COGS/inventory form one balanced journal only when both sides match.
  // The settlement debit is the gross sale total; the revenue side is net of discounts plus tax and delivery.
  // COGS creates an equal additional debit/credit pair.
  const operatingLines = lines;
  const operatingDebit = operatingLines.reduce((n, l) => n + Number(l.debitMinor || 0), 0);
  const operatingCredit = operatingLines.reduce((n, l) => n + Number(l.creditMinor || 0), 0);
  if (operatingDebit !== operatingCredit) throw new Error(`القيد المحاسبي غير متوازن للفواتير ${canonicalSale.invoiceNumber}.`);
  const entry = h.insertPostedJournalEntry({ branchId, memo: `Sale ${canonicalSale.invoiceNumber}`, referenceType: 'sale', referenceId: saleId, lines: operatingLines, createdBy: canonicalSale.userId || null });
  return entry;
}

// عملية بيع كاملة داخل transaction واحدة: تسجيل الفاتورة + البنود + خصم المخزون
const createSaleTx = h.db.transaction((sale) => {
  const branch = h.getCurrentBranch();
  if (!Array.isArray(sale.items) || sale.items.length === 0) throw new Error('لا يمكن إنشاء عملية بيع بدون أصناف.');
  if (sale.customerId != null) {
    const customer = h.db.prepare('SELECT id FROM customers WHERE id=? AND branch_id=?').get(Number(sale.customerId), branch.id);
    if (!customer) throw new Error('العميل غير موجود في الفرع الحالي.');
  }
  if (sale.tableId != null) {
    const table = h.db.prepare("SELECT id FROM restaurant_tables WHERE id=? AND branch_id=?").get(Number(sale.tableId), branch.id);
    if (!table) throw new Error('الطاولة غير موجودة في الفرع الحالي.');
  }
  if (sale.shiftId != null) {
    const shift = h.db.prepare("SELECT id,status FROM shifts WHERE id=? AND branch_id=?").get(Number(sale.shiftId), branch.id);
    if (!shift) throw new Error('جلسة الصندوق غير موجودة في الفرع الحالي.');
    if (shift.status !== 'open') throw new Error('جلسة الصندوق مغلقة.');
  }
  if (sale.userId != null) {
    const user = h.db.prepare('SELECT id,is_active FROM users WHERE id=? AND branch_id=?').get(Number(sale.userId), branch.id);
    if (!user || !user.is_active) throw new Error('المستخدم الحالي غير صالح.');
  }
  const clientRequestId = String(sale.clientRequestId || '').trim();
  if (clientRequestId) {
    const existing = h.db.prepare('SELECT id, uuid, invoice_number FROM sales WHERE branch_id=? AND client_request_id=?').get(branch.id, clientRequestId);
    if (existing) return { ...existing, idempotent: true };
  }
  const saleUuid = h.uuid();

  const { priced, subtotal, taxTotal, subtotalMinor, taxTotalMinor, minorUnit } = priceItemsFromDatabase(sale.items, branch.id);
  assertCreditSaleAllowed(sale);
  const bundleResolved = resolveBundlesFromDatabase(priced, sale.bundleIds, branch.id, minorUnit);
  const { discountTotal, discountType, discountValue, discountApprovedBy } = assertDiscountAllowed(subtotal, sale.discountType, sale.discountValue, sale.discountApprovedBy);
  const discountTotalMinor = money.toMinor(discountTotal, minorUnit);
  const bundleDiscountTotalMinor = bundleResolved.totalMinor;
  const rawDeliveryFee = Number(sale.deliveryFee) || 0;
  if (!Number.isFinite(rawDeliveryFee) || rawDeliveryFee < 0) throw new Error('رسوم التوصيل غير صالحة.');
  const deliveryFeeMinor = money.toMinor(rawDeliveryFee, minorUnit);
  // المبلغ المستحق قبل استبدال نقاط الولاء: هو سقف قيمة الاستبدال المسموحة (حتى لا
  // يصير الإجمالي بالسالب). resolveLoyaltyRedemption يعيد التحقق الكامل من رصيد
  // العميل ومن هذا السقف بنفسه، بصرف النظر عمّا أرسلته الواجهة.
  const payableBeforeLoyaltyMinor = Math.max(0, subtotalMinor + taxTotalMinor - discountTotalMinor - bundleDiscountTotalMinor + deliveryFeeMinor);
  const loyaltyRedemption = h.resolveLoyaltyRedemption(sale.customerId, sale.loyaltyPointsToRedeem, payableBeforeLoyaltyMinor);
  const loyaltyRedeemedPoints = loyaltyRedemption.points;
  const loyaltyRedeemedValueMinor = loyaltyRedemption.valueMinor;
  const grandTotalMinor = Math.max(0, payableBeforeLoyaltyMinor - loyaltyRedeemedValueMinor);
  const grandTotal = money.fromMinor(grandTotalMinor, minorUnit);
  const deliveryFee = money.fromMinor(deliveryFeeMinor, minorUnit);
  const discountTotalMajor = money.fromMinor(discountTotalMinor, minorUnit);
  const bundleDiscountTotalMajor = money.fromMinor(bundleDiscountTotalMinor, minorUnit);
  const notes = String(sale.notes || '').trim().slice(0, 500) || null;
  // وقت التسليم: فاضي/غير موجود = "الآن" (فوري). لو الكاشير حدد وقت مستقبلي، لازم
  // يكون تاريخ/وقت صالح فعلاً، وإلا نرفضه بدل ما نخزّن قيمة تالفة تكسر شاشة المطبخ.
  // وقت مجدوَل مسبقاً (تحديد وقت بدل "الآن") متاح لأي نوع طلب — توصيل أو استلام/سفري
  // على حد سواء (عميل بيتصل يحجز استلام الساعة 7 مثلاً) — لم يعد مقصوراً على التوصيل
  // فقط كما كان، رغم أن واجهة الكاشير أصلاً تسمح باختياره لأي نوع طلب.
  let deliveryTime = null;
  if (sale.deliveryTime) {
    const d = new Date(sale.deliveryTime);
    if (Number.isNaN(d.getTime())) throw new Error('وقت التسليم غير صالح.');
    deliveryTime = d.toISOString();
  }

  const paymentMethod = sale.paymentMethod || 'cash';
  const cashAmountMinor = money.toMinor(sale.cashAmount || 0, minorUnit);
  const cardAmountMinor = money.toMinor(sale.cardAmount || 0, minorUnit);
  const changeDueMinor = money.toMinor(sale.changeDue || 0, minorUnit);
  const dueAmountMinor = paymentMethod === 'credit' ? grandTotalMinor : 0;
  validatePaymentAmountsMinor(grandTotalMinor, paymentMethod, cashAmountMinor, cardAmountMinor, changeDueMinor);
  // Legacy major-unit validation remains as a compatibility guard for older callers.
  validatePaymentAmounts(grandTotal, paymentMethod, money.fromMinor(cashAmountMinor, minorUnit), money.fromMinor(cardAmountMinor, minorUnit), money.fromMinor(changeDueMinor, minorUnit));
  const cashAmount = money.fromMinor(cashAmountMinor, minorUnit);
  const cardAmount = money.fromMinor(cardAmountMinor, minorUnit);
  const changeDue = money.fromMinor(changeDueMinor, minorUnit);
  const dueAmount = money.fromMinor(dueAmountMinor, minorUnit);

  sale = { ...sale, subtotal, taxTotal, discountTotal: discountTotalMajor, discountType, discountValue, discountApprovedBy, bundleDiscountTotal: bundleDiscountTotalMajor, grandTotal, deliveryFee, notes, deliveryTime, items: priced, subtotalMinor, taxTotalMinor, discountTotalMinor, bundleDiscountTotalMinor, deliveryFeeMinor, grandTotalMinor, minorUnit, cashAmount, cashAmountMinor, cardAmount, cardAmountMinor, changeDue, changeDueMinor, dueAmount, dueAmountMinor, loyaltyRedeemedPoints, loyaltyRedeemedValueMinor, loyaltyRedeemedValue: money.fromMinor(loyaltyRedeemedValueMinor, minorUnit) };

  const invoiceNumber = nextInvoiceNumber();
  sale.invoiceNumber = invoiceNumber;
  const saleInfo = h.db.prepare(`
    INSERT INTO sales (
      uuid, branch_id, user_id, customer_id, table_id, shift_id, order_type,
      delivery_fee, delivery_fee_minor, delivery_person, notes, delivery_time, customer_name_manual,
      subtotal, subtotal_minor, tax_total, tax_total_minor,
      discount_total, discount_total_minor, discount_type, discount_value, discount_approved_by,
      bundle_discount_total, bundle_discount_total_minor,
      grand_total, grand_total_minor, payment_method,
      cash_amount, cash_amount_minor, card_amount, card_amount_minor,
      change_due, change_due_minor, due_amount, due_amount_minor,
      exchange_rate, invoice_number, payment_reference, payment_provider, payment_currency,
      client_request_id, loyalty_points_awarded, loyalty_points_redeemed, loyalty_redeemed_value, loyalty_redeemed_value_minor, status
    ) VALUES (
      @uuid, @branch_id, @user_id, @customer_id, @table_id, @shift_id, @order_type,
      @delivery_fee, @delivery_fee_minor, @delivery_person, @notes, @delivery_time, @customer_name_manual,
      @subtotal, @subtotal_minor, @tax_total, @tax_total_minor,
      @discount_total, @discount_total_minor, @discount_type, @discount_value, @discount_approved_by,
      @bundle_discount_total, @bundle_discount_total_minor,
      @grand_total, @grand_total_minor, @payment_method,
      @cash_amount, @cash_amount_minor, @card_amount, @card_amount_minor,
      @change_due, @change_due_minor, @due_amount, @due_amount_minor,
      @exchange_rate, @invoice_number, @payment_reference, @payment_provider, @payment_currency,
      @client_request_id, @loyalty_points_awarded, @loyalty_points_redeemed, @loyalty_redeemed_value, @loyalty_redeemed_value_minor, 'completed'
    )
  `).run({
    uuid: saleUuid,
    branch_id: branch.id,
    user_id: sale.userId || null,
    customer_id: sale.customerId || null,
    table_id: sale.tableId || null,
    shift_id: sale.shiftId || null,
    order_type: sale.orderType || 'in_store',
    delivery_fee: deliveryFee,
    delivery_fee_minor: deliveryFeeMinor,
    delivery_person: sale.deliveryPerson || null,
    notes: sale.notes,
    delivery_time: sale.deliveryTime,
    customer_name_manual: String(sale.customerName || '').trim().slice(0, 120) || null,
    subtotal,
    subtotal_minor: subtotalMinor,
    tax_total: taxTotal,
    tax_total_minor: taxTotalMinor,
    discount_total: discountTotalMajor,
    discount_total_minor: discountTotalMinor,
    discount_type: sale.discountType || null,
    discount_value: sale.discountValue || 0,
    discount_approved_by: sale.discountApprovedBy || null,
    bundle_discount_total: bundleDiscountTotalMajor,
    bundle_discount_total_minor: bundleDiscountTotalMinor,
    grand_total: grandTotal,
    grand_total_minor: grandTotalMinor,
    payment_method: paymentMethod,
    cash_amount: cashAmount,
    cash_amount_minor: cashAmountMinor,
    card_amount: cardAmount,
    card_amount_minor: cardAmountMinor,
    change_due: changeDue,
    change_due_minor: changeDueMinor,
    due_amount: dueAmount,
    due_amount_minor: dueAmountMinor,
    exchange_rate: Math.max(0.000001, Number(sale.exchangeRate) || 1),
    invoice_number: invoiceNumber,
    payment_reference: String(sale.paymentReference || '').trim() || null,
    payment_provider: String(sale.paymentProvider || '').trim() || null,
    payment_currency: String(sale.paymentCurrency || h.getGlobalProfile().currency_code).trim().toUpperCase(),
    client_request_id: clientRequestId || null,
    loyalty_points_awarded: sale.customerId ? Math.floor(grandTotal / h.getLoyaltySettings().earnPerCurrencyUnit) : 0,
    loyalty_points_redeemed: loyaltyRedeemedPoints,
    loyalty_redeemed_value: sale.loyaltyRedeemedValue,
    loyalty_redeemed_value_minor: loyaltyRedeemedValueMinor,
  });

  const saleId = saleInfo.lastInsertRowid;
  saveSaleBundleSnapshot(saleId, bundleResolved.applied, minorUnit);

  const insertItem = h.db.prepare(
    `INSERT INTO sale_items (uuid, sale_id, product_id, quantity, unit_price, unit_price_minor, tax_rate, tax_profile_id, tax_inclusive, discount, line_total, line_total_minor, notes, cost_at_sale, cost_at_sale_minor)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const updateStock = h.db.prepare(
    `UPDATE inventory SET quantity = quantity - ?, updated_at = datetime('now'), synced = 0
     WHERE branch_id = ? AND product_id = ?`
  );
  const logMovement = h.db.prepare(
    `INSERT INTO inventory_movements (uuid, branch_id, product_id, change_qty, reason, ref_id, unit_cost_after, synced)
     VALUES (?, ?, ?, ?, 'sale', ?, ?, 0)`
  );

  for (const item of sale.items) {
    insertItem.run(
      h.uuid(),
      saleId,
      item.productId,
      item.quantity,
      item.unitPrice,
      item.unitPriceMinor,
      item.taxRate || 0,
      item.taxProfileId || null,
      item.taxInclusive ? 1 : 0,
      item.discount || 0,
      item.lineTotal,
      item.lineTotalMinor,
      item.notes || null,
      item.costAtSale || 0,
      item.costAtSaleMinor
    );
    if (item.trackInventory) {
      const stockResult = updateStock.run(item.quantity, branch.id, item.productId);
      if (stockResult.changes !== 1) throw new Error('تعذّر تحديث مخزون المنتج أثناء البيع.');
      logMovement.run(h.uuid(), branch.id, item.productId, -item.quantity, saleId, item.costAtSale || 0);
    }
  }

  postSaleAccountingInTransaction(sale, saleId, branch.id);
  h.recordSyncOutboxEvent({ entityType: 'sale', entityUuid: saleUuid, operation: 'create', payload: { id: saleId, uuid: saleUuid, invoiceNumber } });

  if (sale.paymentMethod === 'store_credit') {
    if (!sale.customerId) throw new Error('الدفع برصيد المتجر يتطلب اختيار عميل.');
    const customer = h.db.prepare('SELECT store_credit_balance FROM customers WHERE id=? AND branch_id=?').get(sale.customerId, branch.id);
    if (!customer) throw new Error('العميل المحدد غير موجود.');
    if (Number(customer.store_credit_balance || 0) + 0.01 < sale.grandTotal) throw new Error('رصيد المتجر غير كافٍ.');
    h.appendStoreCreditLedger({ customerId: sale.customerId, saleId, entryType: 'sale_spend', amount: -sale.grandTotal, createdBy: sale.userId, branchId: branch.id });
  }

  // دفتر مدفوعات عالمي: يسجل طريقة/عملة/مبلغ العملية فقط ولا يخزن PAN أو بيانات البطاقة الحساسة.
  const paymentCurrency = String(sale.paymentCurrency || h.getGlobalProfile().currency_code).trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(paymentCurrency)) throw new Error('رمز عملة الدفع غير صالح. استخدم رمز ISO من 3 أحرف.');
  const insertPayment = h.db.prepare(`INSERT INTO payment_transactions(uuid,branch_id,sale_id,shift_id,method,currency_code,amount,amount_minor,exchange_rate,provider,provider_reference,external_id,masked_descriptor,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  if (sale.paymentMethod === 'store_credit') insertPayment.run(h.uuid(), branch.id, saleId, sale.shiftId || null, 'store_credit', paymentCurrency, -sale.grandTotal, -grandTotalMinor, 1, null, null, null, null, sale.userId || null);
  // تسجّل sales.cash_amount المبلغ المستلَم فعلياً، أما دفتر المدفوعات وحساب
  // الصندوق فيسجّلان الصافي الذي بقي في الصندوق بعد إعادة الباقي للعميل.
  else if (sale.paymentMethod === 'cash') insertPayment.run(h.uuid(), branch.id, saleId, sale.shiftId || null, 'cash', paymentCurrency, sale.grandTotal, grandTotalMinor, 1, null, null, null, null, sale.userId || null);
  else if (sale.paymentMethod === 'card') insertPayment.run(h.uuid(), branch.id, saleId, sale.shiftId || null, 'card', paymentCurrency, sale.grandTotal, grandTotalMinor, 1, sale.paymentProvider || null, sale.paymentReference || null, null, null, sale.userId || null);
  else if (sale.paymentMethod === 'mixed') {
    if (Number(sale.cashAmount) > 0) insertPayment.run(h.uuid(), branch.id, saleId, sale.shiftId || null, 'cash', paymentCurrency, sale.cashAmount, cashAmountMinor, 1, null, null, null, null, sale.userId || null);
    if (Number(sale.cardAmount) > 0) insertPayment.run(h.uuid(), branch.id, saleId, sale.shiftId || null, 'card', paymentCurrency, sale.cardAmount, cardAmountMinor, 1, sale.paymentProvider || null, sale.paymentReference || null, null, null, sale.userId || null);
  }

  // نقاط ولاء: معدّل قابل للتعديل من الإعدادات (افتراضياً نقطة واحدة لكل 10 وحدات
  // عملة من إجمالي الفاتورة الفعلي — أي بعد خصم أي استبدال نقاط سابق على نفس الفاتورة،
  // فلا يمكن "تدوير" النقاط بلا نهاية عبر استبدالها ثم كسبها من نفس المبلغ).
  if (sale.customerId) {
    const points = Math.floor(sale.grandTotal / h.getLoyaltySettings().earnPerCurrencyUnit);
    if (points > 0) {
      h.db.prepare(`UPDATE customers SET loyalty_points = loyalty_points + ?, updated_at = datetime('now'), synced = 0 WHERE id = ? AND branch_id=?`).run(
        points, sale.customerId, branch.id
      );
    }
    if (loyaltyRedeemedPoints > 0) {
      h.db.prepare(`UPDATE customers SET loyalty_points = MAX(0, loyalty_points - ?), updated_at = datetime('now'), synced = 0 WHERE id = ? AND branch_id=?`).run(
        loyaltyRedeemedPoints, sale.customerId, branch.id
      );
    }
  }

  if (dueAmount > 0) {
    const customer = h.db.prepare('SELECT balance FROM customers WHERE id=? AND branch_id=?').get(sale.customerId, branch.id);
    if (!customer) throw new Error('العميل المحدد غير موجود.');
    const balanceAfter = Number(customer.balance || 0) + dueAmount;
    h.db.prepare(`UPDATE customers SET balance = ?, updated_at = datetime('now'), synced = 0 WHERE id = ? AND branch_id=?`).run(balanceAfter, sale.customerId, branch.id);
    h.appendCustomerLedger({ customerId: sale.customerId, saleId, entryType: 'credit_sale', amount: dueAmount, balanceAfter, notes: `فاتورة ${invoiceNumber}` });
  }

  return { id: saleId, uuid: saleUuid, invoiceNumber, grandTotal, grandTotalMinor };
});

function createSale(sale) {
  return createSaleTx(sale);
}

// أسماء مندوبي التوصيل اللي اتكتبوا يدوياً قبل كده في هذا الفرع - تُستخدم
// لاقتراحها تلقائياً (autocomplete) بدل إعادة كتابة نفس الاسم كل مرة.
function listKnownDeliveryPersons() {
  const branch = h.getCurrentBranch();
  return h.db.prepare(`
    SELECT DISTINCT delivery_person FROM sales
    WHERE branch_id = ? AND delivery_person IS NOT NULL AND TRIM(delivery_person) <> ''
    ORDER BY delivery_person COLLATE NOCASE
    LIMIT 50
  `).all(branch.id).map((r) => r.delivery_person);
}

function listSales(filters = {}) {
  const branch = h.getCurrentBranch();
  // LEFT JOIN للعميل: كانت قائمة الفواتير لا تعرض اسم العميل لأن sales لا تحمل الاسم.
  let sql = `SELECT s.*, COALESCE(c.name, s.customer_name_manual) AS customer_name FROM sales s LEFT JOIN customers c ON c.id = s.customer_id WHERE s.branch_id = ?`;
  const params = [branch.id];
  if (filters.from) {
    sql += ` AND s.created_at >= ?`;
    params.push(filters.from);
  }
  if (filters.to) {
    sql += ` AND s.created_at <= ?`;
    params.push(filters.to);
  }
  // قائمة المرتجعات/التعديل: الفواتير المكتملة والمرتجعة جزئياً فقط (لا طلبات مفتوحة ولا ملغاة ولا مرتجعة بالكامل).
  const allowedStatuses = ['open', 'completed', 'partially_refunded', 'refunded', 'voided', 'cancelled', 'draft'];
  const statuses = Array.isArray(filters.statuses) ? filters.statuses.filter((x) => allowedStatuses.includes(String(x))) : [];
  if (statuses.length) {
    sql += ` AND s.status IN (${statuses.map(() => '?').join(',')})`;
    params.push(...statuses);
  }
  const search = String(filters.search || '').trim();
  if (search) {
    const like = `%${search.replace(/[%_]/g, (ch) => `\\${ch}`)}%`;
    sql += ` AND (s.invoice_number LIKE ? ESCAPE '\\' OR COALESCE(c.name,'') LIKE ? ESCAPE '\\' OR s.created_at LIKE ? ESCAPE '\\')`;
    params.push(like, like, like);
  }
  sql += ' ORDER BY s.created_at DESC LIMIT 200';
  return h.db.prepare(sql).all(...params);
}

// جلب فاتورة واحدة كاملة (رأس الفاتورة + بنودها + اسم المنتج) لغرض الطباعة/العرض
function getSale(id, branchId = null) {
  const sale = h.db
    .prepare(
      `SELECT s.*, COALESCE(c.name, s.customer_name_manual) AS customer_name, c.phone AS customer_phone, t.name AS table_name,
              u.full_name AS cashier_name, u.username AS cashier_username
       FROM sales s
       LEFT JOIN customers c ON c.id = s.customer_id AND c.branch_id = s.branch_id
       LEFT JOIN restaurant_tables t ON t.id = s.table_id AND t.branch_id = s.branch_id
       LEFT JOIN users u ON u.id = s.user_id
       WHERE s.id = ? AND (? IS NULL OR s.branch_id = ?)`
    )
    .get(id, branchId, branchId);
  if (!sale) return null;

  const items = h.db
    .prepare(
      `SELECT si.*, p.name AS product_name, p.unit
       FROM sale_items si
       JOIN products p ON p.id = si.product_id
       WHERE si.sale_id = ?
       ORDER BY si.id`
    )
    .all(id);

  const branch = h.db.prepare('SELECT * FROM branches WHERE id = ?').get(sale.branch_id);

  return { ...sale, items, bundles: getSaleBundles(id), branch };
}


  return {
    priceItemsFromDatabase,
    quoteSale,
    assertDiscountAllowed,
    assertCreditSaleAllowed,
    getTerminalInvoiceToken,
    nextInvoiceNumber,
    resolveBundlesFromDatabase,
    calculateBundleDiscountFromDatabase,
    saveSaleBundleSnapshot,
    getSaleBundles,
    allocateByWeight,
    validatePaymentAmounts,
    validatePaymentAmountsMinor,
    postSaleAccountingInTransaction,
    createSale,
    listKnownDeliveryPersons,
    listSales,
    getSale
  };
};
