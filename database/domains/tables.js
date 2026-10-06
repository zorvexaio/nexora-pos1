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

/* ---------------- طاولات المطعم والطلبات المفتوحة ---------------- */
// الكرسون يطلب الحساب من موبايله بدل ما يمشي يقول للكاشير — لا ينفّذ أي دفع ولا
// يقفل الطاولة، مجرد علامة تظهر لشاشة الطاولات الرئيسية.
function requestBillForTable(saleId) {
  const branch = h.getCurrentBranch();
  const sale = h.db.prepare("SELECT id FROM sales WHERE id=? AND branch_id=? AND status='open'").get(Number(saleId), branch.id);
  if (!sale) throw new Error('الطلب المفتوح غير موجود.');
  h.db.prepare("UPDATE sales SET bill_requested_at=datetime('now') WHERE id=?").run(sale.id);
  return { success: true };
}

// الكاشير/النادل الرئيسي يُقرّ الطلب (رآه واستجاب له) فتختفي العلامة، دون أي تأثير
// على الطلب أو الطاولة نفسها.
function acknowledgeBillRequest(saleId) {
  const branch = h.getCurrentBranch();
  const sale = h.db.prepare('SELECT id FROM sales WHERE id=? AND branch_id=?').get(Number(saleId), branch.id);
  if (!sale) throw new Error('الطلب غير موجود.');
  h.db.prepare('UPDATE sales SET bill_requested_at=NULL WHERE id=?').run(sale.id);
  return { success: true };
}

function listTables() {
  const branch = h.getCurrentBranch();
  const tables = h.db.prepare('SELECT * FROM restaurant_tables WHERE branch_id = ? ORDER BY name').all(branch.id);
  return tables.map((t) => {
    // مجرد فتح شاشة الطاولة يُنشئ طلباً "open" فارغاً (لعرض/بدء الطلب)، فلا يجوز اعتبار
    // الطاولة "مشغولة" إلا إذا كان هذا الطلب المفتوح يحتوي فعلاً على صنف واحد على الأقل.
    // هذا يمنع مشكلة بقاء الطاولة "مشغولة" للأبد لمجرد أن أحداً فتحها ثم رجع دون إضافة شيء.
    const openSale = h.db
      .prepare(`SELECT s.id, s.grand_total, s.created_at, s.bill_requested_at,
                       (SELECT COUNT(*) FROM sale_items si WHERE si.sale_id = s.id) AS item_count
                FROM sales s WHERE s.branch_id = ? AND s.table_id = ? AND s.status = 'open'`)
      .get(branch.id, t.id);
    const hasItems = !!openSale && Number(openSale.item_count) > 0;
    return {
      ...t,
      occupied: hasItems,
      openSaleId: openSale ? openSale.id : null,
      openTotal: hasItems ? openSale.grand_total : 0,
      openSince: hasItems ? openSale.created_at : null,
      billRequested: hasItems && !!openSale.bill_requested_at,
    };
  });
}

// تحرير يدوي لطاولة عالقة: يُلغي (void) أي طلب مفتوح فارغ (بلا أصناف) عليها.
// لا يمكن استخدامها إن كان هناك طلب مفتوح يحتوي أصنافاً فعلاً — تلك حالة طبيعية ويجب
// إغلاقها عبر الدفع أو نقل/دمج الطاولة، وليس عبر "تحرير" قسري قد يُضيّع الطلب.
function releaseEmptyTable(tableId) {
  const branch = h.getCurrentBranch();
  const table = h.db.prepare('SELECT id FROM restaurant_tables WHERE id=? AND branch_id=?').get(Number(tableId), branch.id);
  if (!table) throw new Error('الطاولة غير موجودة في الفرع الحالي.');
  const openSale = h.db.prepare(`SELECT id FROM sales WHERE branch_id=? AND table_id=? AND status='open'`).get(branch.id, table.id);
  if (!openSale) return { success: true, released: false };
  const itemCount = h.db.prepare('SELECT COUNT(*) c FROM sale_items WHERE sale_id=?').get(openSale.id).c;
  if (Number(itemCount) > 0) return { success: false, message: 'لا يمكن تحرير طاولة عليها طلب يحتوي أصنافاً. أكمل الدفع أو أفرغ السلة أولاً.' };
  h.db.prepare(`UPDATE sales SET status='void' WHERE id=?`).run(openSale.id);
  return { success: true, released: true };
}

function createTable(t) {
  const branch = h.getCurrentBranch();
  const name = String(t?.name || '').trim();
  const seats = t?.seats === undefined || t.seats === '' ? 4 : Number(t.seats);
  if (!name) throw new Error('اسم الطاولة مطلوب.');
  if (!Number.isInteger(seats) || seats < 1 || seats > 100) throw new Error('عدد مقاعد الطاولة يجب أن يكون بين 1 و100.');
  const duplicate = h.db.prepare('SELECT id FROM restaurant_tables WHERE branch_id=? AND lower(trim(name))=lower(trim(?)) LIMIT 1').get(branch.id, name);
  if (duplicate) throw new Error('اسم الطاولة مستخدم بالفعل في الفرع الحالي.');
  const info = h.db.prepare(`INSERT INTO restaurant_tables (uuid, branch_id, name, seats, status, updated_at, synced) VALUES (?, ?, ?, ?, 'free', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 0)`).run(h.uuid(), branch.id, name, seats);
  return { id: info.lastInsertRowid };
}

function deleteTable(id) {
  // يُمنع حذف طاولة عليها طلب مفتوح حالياً
  const branch = h.getCurrentBranch();
  const openSale = h.db
    .prepare(`SELECT id FROM sales WHERE branch_id = ? AND table_id = ? AND status = 'open'`)
    .get(branch.id, id);
  if (openSale) return { success: false, message: 'لا يمكن حذف طاولة عليها طلب مفتوح' };
  const historical = h.db.prepare('SELECT COUNT(*) AS c FROM sales WHERE table_id=?').get(id).c;
  if (Number(historical) > 0) {
    h.db.prepare(`UPDATE restaurant_tables SET status='reserved', name = name || ' (محذوف)', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), synced=0 WHERE id=? AND branch_id=?`).run(id, branch.id);
    return { success: true, archived: true };
  }
  h.db.prepare('DELETE FROM restaurant_tables WHERE id = ? AND branch_id=?').run(id, branch.id);
  return { success: true };
}

// يفتح طلباً جديداً للطاولة إن لم يوجد طلب مفتوح بالفعل، أو يُرجع الموجود
const getOrCreateOpenSaleTx = h.db.transaction((tableId, userId) => {
  const branch = h.getCurrentBranch();
  const table = h.db.prepare('SELECT id FROM restaurant_tables WHERE id=? AND branch_id=?').get(Number(tableId), branch.id);
  if (!table) throw new Error('الطاولة غير موجودة في الفرع الحالي.');
  let sale = h.db
    .prepare(`SELECT * FROM sales WHERE branch_id = ? AND table_id = ? AND status = 'open'`)
    .get(branch.id, table.id);
  if (sale) return sale;

  const saleUuid = h.uuid();
  const info = h.db
    .prepare(
      `INSERT INTO sales (uuid, branch_id, user_id, table_id, subtotal, tax_total, discount_total, grand_total, payment_method, status)
       VALUES (?, ?, ?, ?, 0, 0, 0, 0, 'cash', 'open')`
    )
    .run(saleUuid, branch.id, userId || null, tableId);
  return h.db.prepare('SELECT * FROM sales WHERE id = ?').get(info.lastInsertRowid);
});

function getOrCreateOpenSale(tableId, userId) {
  return getOrCreateOpenSaleTx(tableId, userId);
}

// ربط عميل بطلب طاولة مفتوح: مطلوب لتفعيل الدفع الآجل (على الحساب) واستبدال نقاط
// الولاء بطلبات المطاعم — كانت شاشة الطاولة لا تحتوي على أي وسيلة لاختيار عميل إطلاقاً،
// فتعذّر الدفع الآجل واستبدال النقاط كلاهما على هذا النوع من الطلبات تحديداً.
function setTableSaleCustomer(saleId, customerId) {
  const branch = h.getCurrentBranch();
  const sale = h.db.prepare("SELECT id FROM sales WHERE id=? AND branch_id=? AND status='open'").get(Number(saleId), branch.id);
  if (!sale) throw new Error('الطلب المفتوح غير موجود.');
  if (customerId != null) {
    const customer = h.db.prepare('SELECT id FROM customers WHERE id=? AND branch_id=?').get(Number(customerId), branch.id);
    if (!customer) throw new Error('العميل غير موجود.');
  }
  h.db.prepare('UPDATE sales SET customer_id=? WHERE id=? AND branch_id=?').run(customerId == null ? null : Number(customerId), Number(saleId), branch.id);
  return { success: true };
}

function getOpenSaleForTable(tableId) {
  const branch = h.getCurrentBranch();
  const table = h.db.prepare('SELECT id FROM restaurant_tables WHERE id=? AND branch_id=?').get(Number(tableId), branch.id);
  if (!table) return null;
  const sale = h.db
    .prepare(`SELECT * FROM sales WHERE branch_id = ? AND table_id = ? AND status = 'open'`)
    .get(branch.id, table.id);
  if (!sale) return null;
  const items = h.db
    .prepare(
      `SELECT si.*, p.name AS product_name, p.unit
       FROM sale_items si JOIN products p ON p.id = si.product_id
       WHERE si.sale_id = ? ORDER BY si.id`
    )
    .all(sale.id);
  return { ...sale, items };
}

// يحفظ طلب الطاولة ويزامن المخزون مع الكمية المحفوظة فعلياً. يطبّق فرق الكمية فقط، فلا يحدث خصم مزدوج.
const setOpenSaleItemsTx = h.db.transaction((saleId, items) => {
  const branch = h.getCurrentBranch();
  const sale = h.db.prepare(`SELECT id, status, branch_id FROM sales WHERE id=? AND branch_id=? AND status='open'`).get(Number(saleId), branch.id);
  if (!sale) throw new Error('الطلب المفتوح غير موجود في الفرع الحالي.');
  if (!Array.isArray(items)) throw new Error('قائمة الأصناف غير صالحة.');

  const getProduct = h.db.prepare(`SELECT p.id,p.price,p.cost,p.tax_rate,p.tax_profile_id,p.name,
      tp.rate AS profile_rate,tp.is_inclusive AS profile_inclusive
      FROM products p
      LEFT JOIN tax_profiles tp ON tp.id=p.tax_profile_id AND tp.branch_id=? AND tp.is_active=1
      WHERE p.id=? AND p.is_active=1`).pluck(false);
  const getProductRow = h.db.prepare(`SELECT p.id,p.price,p.cost,COALESCE(i.unit_cost,p.cost,0) AS branch_cost,p.tax_rate,p.tax_profile_id,p.name,p.track_inventory,
      tp.rate AS profile_rate,tp.is_inclusive AS profile_inclusive
      FROM products p
      LEFT JOIN inventory i ON i.product_id=p.id AND i.branch_id=?
      LEFT JOIN tax_profiles tp ON tp.id=p.tax_profile_id AND tp.branch_id=? AND tp.is_active=1
      WHERE p.id=? AND p.is_active=1`);
  const global = h.getGlobalProfile();
  const appliedRows = h.db.prepare(`SELECT product_id, COALESCE(SUM(-change_qty),0) AS applied_qty FROM inventory_movements WHERE branch_id=? AND ref_id=? AND reason='table_order' GROUP BY product_id`).all(branch.id, Number(saleId));
  const appliedByProduct = new Map(appliedRows.map((r) => [Number(r.product_id), Number(r.applied_qty || 0)]));
  const normalized=[];
  const minorUnit = Number(global?.currency_minor_unit ?? 2);
  let subtotalMinor=0, taxTotalMinor=0;
  // Snapshot: البند الموجود مسبقاً في الطلب يحتفظ بسعره ونسبة/نوع ضريبته وتكلفته كما سُجّلت لحظة إضافته.
  // تغيير سعر المنتج أو ملف الضريبة أو وضع الشمول لاحقاً لا يعيد تسعير الطلب المفتوح؛ يُقرأ المنتج فقط للبنود الجديدة.
  const existingRows=h.db.prepare('SELECT * FROM sale_items WHERE sale_id=? ORDER BY id').all(Number(saleId));
  const usedExisting=new Set();
  const takeExisting=(productId,wantedUuid)=>{
    let row=wantedUuid?existingRows.find((r)=>!usedExisting.has(r.id)&&r.uuid===String(wantedUuid)&&Number(r.product_id)===productId):null;
    if(!row) row=existingRows.find((r)=>!usedExisting.has(r.id)&&Number(r.product_id)===productId);
    if(row) usedExisting.add(row.id);
    return row||null;
  };
  for (const raw of items) {
    const productId=Number(raw.productId ?? raw.product_id);
    const quantity=Number(raw.quantity);
    if (!Number.isInteger(productId) || productId<=0 || !(Number.isFinite(quantity) && quantity>0)) throw new Error('بيانات صنف غير صالحة.');
    if (quantity>MAX_LINE_QUANTITY) throw new Error(`الكمية المطلوبة تتجاوز الحد الأقصى المسموح (${MAX_LINE_QUANTITY}).`);
    const prior=takeExisting(productId,raw.saleItemUuid??raw.uuid);
    const product=getProductRow.get(branch.id,branch.id,productId);
    if (!prior && !product) throw new Error('منتج غير موجود أو غير نشط.');
    let taxRate, inclusive, unitPriceMinor, taxProfileId, costAtSale, itemUuid=null;
    if (prior) {
      taxRate=Number(prior.tax_rate||0);
      inclusive=Number(prior.tax_inclusive)===1;
      unitPriceMinor=money.toMinor(prior.unit_price,minorUnit);
      taxProfileId=prior.tax_profile_id||null;
      costAtSale=Math.max(0,Number(prior.cost_at_sale||0));
      itemUuid=prior.uuid;
    } else {
      taxRate=product.profile_rate==null ? Number(product.tax_rate||0) : Number(product.profile_rate);
      inclusive=product.profile_rate!=null ? Number(product.profile_inclusive)===1 : global.tax_mode==='inclusive';
      unitPriceMinor=money.toMinor(product.price,minorUnit);
      taxProfileId=product.tax_profile_id||null;
      costAtSale=Math.max(0,Number(product.branch_cost ?? product.cost ?? 0));
    }
    // نفس منطق priceItemsFromDatabase: كل الحساب بوحدات صغرى عبر money.taxMinor (تقريب لكل سطر)
    // حتى يتطابق مجموع الطلب المفتوح مع الفاتورة النهائية دون فرق وحدة صغرى.
    const lineGrossMinor=money.multiplyMinorQuantity(unitPriceMinor,quantity);
    const lineTaxMinor=money.taxMinor(lineGrossMinor,taxRate,inclusive);
    subtotalMinor += inclusive ? Math.max(0,lineGrossMinor-lineTaxMinor) : lineGrossMinor;
    taxTotalMinor += lineTaxMinor;
    normalized.push({uuid:itemUuid,productId,quantity,unitPrice:money.fromMinor(unitPriceMinor,minorUnit),taxRate,taxProfileId,taxInclusive:inclusive,discount:0,lineTotal:money.fromMinor(lineGrossMinor,minorUnit),notes:String(raw.notes||'').slice(0,1000),costAtSale,kitchenSentQty:prior?Number(prior.kitchen_sent_qty||0):0,priorNotes:prior?String(prior.notes||''):null});
  }
  // فرق المطبخ: ما تغيّر فعلاً عمّا وصل للمطبخ سابقاً (إضافة/إلغاء/تغيير ملاحظة). حفظ بلا تغيير = لا تذكرة.
  const productNameOf=h.db.prepare('SELECT name FROM products WHERE id=?');
  const kitchenDelta=[];
  let anyKitchenSent=false;
  for (const item of normalized) {
    if (item.kitchenSentQty>0) anyKitchenSent=true;
    const d=Math.round((item.quantity-item.kitchenSentQty)*1e6)/1e6;
    const noteChanged=item.kitchenSentQty>0 && item.priorNotes!==null && item.priorNotes!==String(item.notes||'');
    if (Math.abs(d)>1e-9 || noteChanged) kitchenDelta.push({productId:item.productId,productName:productNameOf.get(item.productId)?.name||'',deltaQuantity:d,notes:item.notes||null,noteOnly:Math.abs(d)<=1e-9});
  }
  for (const row of existingRows) {
    if (!usedExisting.has(row.id) && Number(row.kitchen_sent_qty||0)>0) {
      anyKitchenSent=true;
      kitchenDelta.push({productId:row.product_id,productName:productNameOf.get(row.product_id)?.name||'',deltaQuantity:-Number(row.kitchen_sent_qty),notes:null,noteOnly:false});
    }
  }
  const desiredByProduct = new Map();
  for (const item of normalized) desiredByProduct.set(item.productId, (desiredByProduct.get(item.productId) || 0) + item.quantity);
  const allProductIds = new Set([...appliedByProduct.keys(), ...desiredByProduct.keys()]);
  const getInventoryProduct = h.db.prepare('SELECT id, track_inventory FROM products WHERE id=?');
  const getInventory = h.db.prepare('SELECT quantity FROM inventory WHERE branch_id=? AND product_id=?');
  const decrementStock = h.db.prepare(`UPDATE inventory SET quantity=quantity-?,updated_at=datetime('now'),synced=0 WHERE branch_id=? AND product_id=?`);
  const incrementStock = h.db.prepare(`UPDATE inventory SET quantity=quantity+?,updated_at=datetime('now'),synced=0 WHERE branch_id=? AND product_id=?`);
  const getCost = h.db.prepare(`SELECT COALESCE(i.unit_cost,p.cost,0) AS cost FROM inventory i JOIN products p ON p.id=i.product_id WHERE i.branch_id=? AND i.product_id=?`);
  const logTableOrderMovement = h.db.prepare(`INSERT INTO inventory_movements (uuid,branch_id,product_id,change_qty,reason,ref_id,notes,unit_cost_after,synced) VALUES (?,?,?,?, 'table_order',?,?,?,0)`);
  for (const productId of allProductIds) {
    const applied = Number(appliedByProduct.get(productId) || 0);
    const desired = Number(desiredByProduct.get(productId) || 0);
    const delta = desired - applied;
    if (Math.abs(delta) < 0.000001) continue;
    const product = getInventoryProduct.get(productId);
    if (!product) throw new Error('أحد منتجات الطلب غير موجود.');
    if (!Number(product.track_inventory)) continue;
    const cost = Number(getCost.get(branch.id, productId)?.cost || 0);
    if (delta > 0) {
      const inv = getInventory.get(branch.id, productId);
      if (!inv || Number(inv.quantity) < delta) throw new Error(`المخزون غير كافٍ للصنف #${productId}. المتاح ${Number(inv?.quantity || 0)} والمطلوب ${delta}.`);
      if (decrementStock.run(delta, branch.id, productId).changes !== 1) throw new Error('تعذّر خصم المخزون أثناء حفظ طلب الطاولة.');
      logTableOrderMovement.run(h.uuid(), branch.id, productId, -delta, saleId, 'خصم عند حفظ طلب الطاولة', cost);
    } else {
      const restore = Math.abs(delta);
      if (incrementStock.run(restore, branch.id, productId).changes !== 1) throw new Error('تعذّر إعادة المخزون عند تعديل طلب الطاولة.');
      logTableOrderMovement.run(h.uuid(), branch.id, productId, restore, saleId, 'إعادة مخزون عند تعديل طلب الطاولة', cost);
    }
  }
  h.db.prepare("UPDATE sales SET inventory_committed=1 WHERE id=? AND branch_id=? AND status='open'").run(Number(saleId), branch.id);
  h.db.prepare('DELETE FROM sale_items WHERE sale_id=?').run(Number(saleId));
  const insertItem=h.db.prepare(`INSERT INTO sale_items (uuid,sale_id,product_id,quantity,unit_price,tax_rate,tax_profile_id,tax_inclusive,discount,line_total,notes,cost_at_sale,kitchen_sent_qty) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for(const item of normalized) insertItem.run(item.uuid||h.uuid(),Number(saleId),item.productId,item.quantity,item.unitPrice,item.taxRate,item.taxProfileId,item.taxInclusive ? 1 : 0,item.discount,item.lineTotal,item.notes,item.costAtSale,item.kitchenSentQty);
  const subtotal=money.fromMinor(subtotalMinor,minorUnit);
  const taxTotal=money.fromMinor(taxTotalMinor,minorUnit);
  const grandTotal=money.fromMinor(subtotalMinor+taxTotalMinor,minorUnit);
  h.db.prepare(`UPDATE sales SET subtotal=?,tax_total=?,grand_total=? WHERE id=? AND branch_id=? AND status='open'`).run(subtotal,taxTotal,grandTotal,Number(saleId),branch.id);
  return { success:true, subtotal,taxTotal,grandTotal,items:normalized.length,kitchenDelta,kitchenFirst:!anyKitchenSent };
});

function setOpenSaleItems(saleId, items) {
  return setOpenSaleItemsTx(saleId, items);
}

// بعد نجاح طباعة تذكرة المطبخ فقط: نُسجّل أن كل كميات الطلب الحالية وصلت للمطبخ.
function markKitchenSent(saleId) {
  const branch = h.getCurrentBranch();
  const sale = h.db.prepare(`SELECT id FROM sales WHERE id=? AND branch_id=? AND status='open'`).get(Number(saleId), branch.id);
  if (!sale) return { success: false };
  h.db.prepare('UPDATE sale_items SET kitchen_sent_qty=quantity WHERE sale_id=?').run(sale.id);
  return { success: true };
}

function recalculateOpenSale(saleId) {
  const sale = h.db.prepare("SELECT branch_id FROM sales WHERE id=? AND status='open'").get(Number(saleId));
  if (!sale) throw new Error('الطلب المفتوح غير موجود.');
  const global = h.getGlobalProfile();
  // الضريبة من Snapshot البند المخزَّن (tax_rate/tax_inclusive) وليس من ملف الضريبة الحالي أو وضع المنشأة الحالي.
  const rows = h.db.prepare(`
    SELECT si.quantity, si.unit_price, si.tax_rate, si.tax_inclusive
    FROM sale_items si
    WHERE si.sale_id=?
  `).all(Number(saleId));
  const minorUnit = Number(global?.currency_minor_unit ?? 2);
  let subtotalMinor = 0, taxMinorTotal = 0;
  for (const row of rows) {
    const grossMinor = money.multiplyMinorQuantity(money.toMinor(row.unit_price, minorUnit), Number(row.quantity));
    const rate = Number(row.tax_rate || 0);
    const inclusive = Number(row.tax_inclusive) === 1;
    const lineTaxMinor = money.taxMinor(grossMinor, rate, inclusive);
    subtotalMinor += inclusive ? Math.max(0, grossMinor - lineTaxMinor) : grossMinor;
    taxMinorTotal += lineTaxMinor;
  }
  const subtotal = money.fromMinor(subtotalMinor, minorUnit);
  const tax = money.fromMinor(taxMinorTotal, minorUnit);
  const grandTotal = money.fromMinor(subtotalMinor + taxMinorTotal, minorUnit);
  h.db.prepare(`UPDATE sales SET subtotal=?, tax_total=?, grand_total=? WHERE id=? AND status='open'`).run(subtotal, tax, grandTotal, Number(saleId));
  return { subtotal, tax, grand_total: grandTotal };
}

// يدمج الطلب المفتوح من طاولة إلى طاولة أخرى داخل نفس الفرع. لا يدمج أي فاتورة مدفوعة.
const mergeTablesTx = h.db.transaction((sourceTableId, targetTableId, userId) => {
  if (Number(sourceTableId) === Number(targetTableId)) throw new Error('اختر طاولتين مختلفتين.');
  const branch = h.getCurrentBranch();
  const source = h.db.prepare(`SELECT * FROM sales WHERE branch_id=? AND table_id=? AND status='open'`).get(branch.id, sourceTableId);
  if (!source) throw new Error('الطاولة المصدر لا تحتوي طلباً مفتوحاً.');
  const sourceInventoryCommitted = Number(source.inventory_committed || 0) === 1;
  const targetTable = h.db.prepare(`SELECT id FROM restaurant_tables WHERE branch_id=? AND id=?`).get(branch.id, targetTableId);
  if (!targetTable) throw new Error('الطاولة الهدف غير صالحة.');
  let target = h.db.prepare(`SELECT * FROM sales WHERE branch_id=? AND table_id=? AND status='open'`).get(branch.id, targetTableId);
  if (!target) {
    const created = h.db.prepare(`INSERT INTO sales (uuid,branch_id,user_id,table_id,subtotal,tax_total,discount_total,grand_total,payment_method,status)
      VALUES (?,?,?,?,0,0,0,0,'cash','open')`).run(h.uuid(), branch.id, userId || null, targetTableId);
    target = h.db.prepare('SELECT * FROM sales WHERE id=?').get(created.lastInsertRowid);
  }
  const targetInventoryCommitted = Number(target.inventory_committed || 0) === 1;
  const insert = h.db.prepare(`INSERT INTO sale_items (uuid,sale_id,product_id,quantity,unit_price,tax_rate,tax_profile_id,tax_inclusive,discount,line_total,notes,cost_at_sale,kitchen_sent_qty) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const item of h.db.prepare('SELECT * FROM sale_items WHERE sale_id=?').all(source.id)) {
    insert.run(h.uuid(), target.id, item.product_id, item.quantity, item.unit_price, item.tax_rate, item.tax_profile_id || null, item.tax_inclusive ? 1 : 0, item.discount, item.line_total, item.notes, item.cost_at_sale || 0, item.kitchen_sent_qty || 0);
  }
  h.db.prepare(`UPDATE inventory_movements SET ref_id=? WHERE branch_id=? AND ref_id=? AND reason='table_order'`).run(target.id, branch.id, source.id);
  h.db.prepare('DELETE FROM sale_items WHERE sale_id=?').run(source.id);
  h.db.prepare(`UPDATE sales SET status='void' WHERE id=?`).run(source.id);
  h.db.prepare('UPDATE sales SET inventory_committed=? WHERE id=? AND branch_id=?').run((sourceInventoryCommitted || targetInventoryCommitted) ? 1 : 0, target.id, branch.id);
  recalculateOpenSale(target.id);
  h.logAudit({ userId, action: 'tables_merged', entityType: 'sale', entityId: target.id, details: { sourceTableId, targetTableId, sourceSaleId: source.id } });
  return { success: true, saleId: target.id };
});

function mergeTables(sourceTableId, targetTableId, userId) { return mergeTablesTx(sourceTableId, targetTableId, userId); }

// يدفع جزءاً محدداً من طلب الطاولة، ويُبقي الباقي مفتوحاً على الطاولة نفسها.
const splitTableSaleTx = h.db.transaction((saleId, selected, payment, userId, shiftId) => {
  const branch = h.getCurrentBranch();
  const source = h.db.prepare(`SELECT * FROM sales WHERE id=? AND branch_id=? AND status='open'`).get(saleId, branch.id);
  if (!source) throw new Error('الطلب المفتوح غير موجود.');
  const sourceItems = h.db.prepare('SELECT * FROM sale_items WHERE sale_id=?').all(saleId);
  const sourceInventoryCommitted = Number(source.inventory_committed || 0) === 1;
  const wanted = new Map((selected || []).map(x => [Number(x.saleItemId), Number(x.quantity)]));
  const picked = [];
  for (const item of sourceItems) {
    const qty = wanted.get(item.id) || 0;
    if (qty < 0 || qty > item.quantity) throw new Error('كمية التقسيم غير صالحة.');
    if (qty > 0) picked.push({ ...item, quantity: qty });
  }
  if (!picked.length) throw new Error('اختر صنفاً واحداً على الأقل للتقسيم.');
  const sourceQtyById = new Map(sourceItems.map((s) => [s.id, Number(s.quantity)]));
  const global = h.getGlobalProfile();
  const minorUnit = Number(global?.currency_minor_unit ?? 2);
  // نفس منطق priceItemsFromDatabase تماماً لكن بأسعار البنود المخزَّنة أصلاً بالطلب
  // (لا نعيد التسعير من سعر المنتج الحالي؛ الطلب سُعِّر وقت الإضافة له). كل الحساب
  // بوحدات صغرى (money.toMinor/taxMinor) بدل التقريب العشري المباشر (Math.round(x*100)/100)
  // الذي كان يراكم فروقاً صغيرة ويكسر توازن القيد المحاسبي لاحقاً.
  let subtotalMinor = 0;
  let taxTotalMinor = 0;
  const pricedItems = [];
  for (const i of picked) {
    const unitPriceMinor = money.toMinor(i.unit_price, minorUnit);
    // Snapshot: نسبة الضريبة ونوعها (شامل/حصري) كما خُزّنت مع البند لحظة إضافته، لا كما هي الآن في ملف الضريبة.
    const rate = Number(i.tax_rate || 0);
    const inclusive = Number(i.tax_inclusive) === 1;
    const lineGrossMinor = money.multiplyMinorQuantity(unitPriceMinor, Number(i.quantity));
    const lineTaxMinor = money.taxMinor(lineGrossMinor, rate, inclusive);
    const lineNetMinor = inclusive ? Math.max(0, lineGrossMinor - lineTaxMinor) : lineGrossMinor;
    subtotalMinor += lineNetMinor;
    taxTotalMinor += lineTaxMinor;
    const costAtSaleMinor = money.toMinor(Math.max(0, Number(i.cost_at_sale || 0)), minorUnit);
    pricedItems.push({ ...i, unitPriceMinor, lineGrossMinor, lineTaxMinor, costAtSaleMinor, taxRate: rate, taxInclusive: inclusive });
  }
  const grandTotalMinor = subtotalMinor + taxTotalMinor;
  const subtotal = money.fromMinor(subtotalMinor, minorUnit);
  const tax = money.fromMinor(taxTotalMinor, minorUnit);
  const total = money.fromMinor(grandTotalMinor, minorUnit);
  if (!sourceInventoryCommitted) {
    for (const item of picked) {
      const product = h.db.prepare('SELECT id,track_inventory,is_active FROM products WHERE id=?').get(item.product_id);
      if (!product || !product.is_active) throw new Error('أحد منتجات الطلب لم يعد صالحًا.');
      if (product.track_inventory) {
        const inv = h.db.prepare('SELECT quantity FROM inventory WHERE branch_id=? AND product_id=?').get(branch.id, item.product_id);
        if (!inv || Number(inv.quantity) < Number(item.quantity)) throw new Error('الكمية المتوفرة لم تعد كافية لتقسيم الطلب.');
      }
    }
  }
  const method = payment.paymentMethod || 'cash';
  // البيع الآجل بالتقسيم يتطلب نفس شرط البيع الآجل بأي مسار آخر: عميل محدَّد + موافقة
  // مدير/مدير عام حقيقية — لم يكن هذا التحقق موجوداً هنا إطلاقاً سابقاً.
  h.assertCreditSaleAllowed({ paymentMethod: method, customerId: source.customer_id, creditApprovedBy: payment.creditApprovedBy });
  const cashAmountMinor = money.toMinor(payment.cashAmount || 0, minorUnit);
  const cardAmountMinor = money.toMinor(payment.cardAmount || 0, minorUnit);
  const changeDueMinor = money.toMinor(payment.changeDue || 0, minorUnit);
  h.validatePaymentAmountsMinor(grandTotalMinor, method, cashAmountMinor, cardAmountMinor, changeDueMinor);
  // فحص توافقي إضافي بوحدة كبرى (نفس نمط createSaleTx) — طبقة أمان ثانية لا تُغيّر أي سلوك.
  h.validatePaymentAmounts(total, method, money.fromMinor(cashAmountMinor, minorUnit), money.fromMinor(cardAmountMinor, minorUnit), money.fromMinor(changeDueMinor, minorUnit));
  const cashAmount = money.fromMinor(cashAmountMinor, minorUnit);
  const cardAmount = money.fromMinor(cardAmountMinor, minorUnit);
  const changeDue = money.fromMinor(changeDueMinor, minorUnit);
  const dueAmountMinor = method === 'credit' ? grandTotalMinor : 0;
  const dueAmount = money.fromMinor(dueAmountMinor, minorUnit);
  const invoiceNumber = h.nextInvoiceNumber();
  const info = h.db.prepare(`INSERT INTO sales (
      uuid,branch_id,user_id,customer_id,table_id,shift_id,order_type,
      subtotal,subtotal_minor,tax_total,tax_total_minor,grand_total,grand_total_minor,
      payment_method,cash_amount,cash_amount_minor,card_amount,card_amount_minor,
      change_due,change_due_minor,due_amount,due_amount_minor,invoice_number,status)
    VALUES (?,?,?,?,?,?,'table_split',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'completed')`).run(
    h.uuid(), branch.id, userId, source.customer_id || null, source.table_id, shiftId,
    subtotal, subtotalMinor, tax, taxTotalMinor, total, grandTotalMinor,
    method, cashAmount, cashAmountMinor, cardAmount, cardAmountMinor,
    changeDue, changeDueMinor, dueAmount, dueAmountMinor, invoiceNumber);
  const paidSaleId = info.lastInsertRowid;
  const ins = h.db.prepare(`INSERT INTO sale_items (uuid,sale_id,product_id,quantity,unit_price,unit_price_minor,tax_rate,tax_profile_id,tax_inclusive,discount,line_total,line_total_minor,notes,cost_at_sale,cost_at_sale_minor) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const stock = h.db.prepare(`UPDATE inventory SET quantity=quantity-?,updated_at=datetime('now'),synced=0 WHERE branch_id=? AND product_id=?`);
  const movement = h.db.prepare(`INSERT INTO inventory_movements (uuid,branch_id,product_id,change_qty,reason,ref_id,unit_cost_after,synced) VALUES (?,?,?,?, 'sale',?,?,0)`);
  const updateSource = h.db.prepare('UPDATE sale_items SET kitchen_sent_qty=MIN(kitchen_sent_qty, quantity-?), quantity=quantity-?, line_total=unit_price*(quantity-?), line_total_minor=? WHERE id=?');
  for (const item of pricedItems) {
    ins.run(h.uuid(), paidSaleId, item.product_id, item.quantity, item.unit_price, item.unitPriceMinor, item.taxRate, item.tax_profile_id || null, item.taxInclusive ? 1 : 0, item.discount, money.fromMinor(item.lineGrossMinor, minorUnit), item.lineGrossMinor, item.notes, item.cost_at_sale || 0, item.costAtSaleMinor);
    const remainingQty = sourceQtyById.get(item.id) - item.quantity;
    const remainingLineTotalMinor = money.multiplyMinorQuantity(item.unitPriceMinor, remainingQty);
    updateSource.run(item.quantity, item.quantity, item.quantity, remainingLineTotalMinor, item.id);
    if (!sourceInventoryCommitted) {
      const product = h.db.prepare('SELECT track_inventory FROM products WHERE id=? AND is_active=1').get(item.product_id);
      if (product?.track_inventory) {
        const stockResult = stock.run(item.quantity, branch.id, item.product_id);
        if (stockResult.changes !== 1) throw new Error('تعذّر تحديث مخزون المنتج أثناء تقسيم الطلب.');
        movement.run(h.uuid(), branch.id, item.product_id, -item.quantity, paidSaleId, Number(item.cost_at_sale || 0));
      }
    }
  }
  h.db.prepare('DELETE FROM sale_items WHERE sale_id=? AND quantity<=0').run(saleId);
  recalculateOpenSale(saleId);
  const currency = String(global.currency_code || 'USD').toUpperCase();
  const ptx = h.db.prepare(`INSERT INTO payment_transactions(uuid,branch_id,sale_id,shift_id,method,currency_code,amount,amount_minor,exchange_rate,provider,provider_reference,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
  if (method === 'cash') ptx.run(h.uuid(), branch.id, paidSaleId, shiftId || null, 'cash', currency, total, grandTotalMinor, 1, null, null, userId || null);
  else if (method === 'card') ptx.run(h.uuid(), branch.id, paidSaleId, shiftId || null, 'card', currency, total, grandTotalMinor, 1, payment.paymentProvider || null, payment.paymentReference || null, userId || null);
  else if (method === 'mixed') {
    if (cashAmountMinor > 0) ptx.run(h.uuid(), branch.id, paidSaleId, shiftId || null, 'cash', currency, cashAmount, cashAmountMinor, 1, null, null, userId || null);
    if (cardAmountMinor > 0) ptx.run(h.uuid(), branch.id, paidSaleId, shiftId || null, 'card', currency, cardAmount, cardAmountMinor, 1, payment.paymentProvider || null, payment.paymentReference || null, userId || null);
  } else if (method === 'store_credit') {
    const customer = source.customer_id ? h.db.prepare('SELECT store_credit_balance FROM customers WHERE id=? AND branch_id=?').get(source.customer_id, branch.id) : null;
    if (!customer || Number(customer.store_credit_balance || 0) + 0.01 < total) throw new Error('رصيد المتجر غير كافٍ للدفع المجزأ.');
    h.appendStoreCreditLedger({ customerId: source.customer_id, saleId: paidSaleId, entryType: 'sale_spend', amount: -total, createdBy: userId, branchId: branch.id });
    ptx.run(h.uuid(), branch.id, paidSaleId, shiftId || null, 'store_credit', currency, -total, -grandTotalMinor, 1, null, null, userId || null);
  } else if (method === 'credit') {
    // لا حركة نقدية فعلية هنا — يُضاف المبلغ لدين العميل بدل تحصيله الآن (لم يكن هذا
    // المسار يسجّل أي شيء إطلاقاً سابقاً؛ كان مبلغ الفاتورة المجزّأة يختفي بصمت).
    const customer = h.db.prepare('SELECT balance FROM customers WHERE id=? AND branch_id=?').get(source.customer_id, branch.id);
    if (!customer) throw new Error('العميل المحدد غير موجود.');
    const balanceAfter = Number(customer.balance || 0) + total;
    h.db.prepare(`UPDATE customers SET balance = ?, updated_at = datetime('now'), synced = 0 WHERE id = ? AND branch_id=?`).run(balanceAfter, source.customer_id, branch.id);
    h.appendCustomerLedger({ customerId: source.customer_id, saleId: paidSaleId, entryType: 'credit_sale', amount: total, balanceAfter, notes: `فاتورة مجزّأة ${invoiceNumber}` });
  }
  // ترحيل محاسبي: تقسيم فاتورة الطاولة لم يكن يمرّ على postSaleAccountingInTransaction
  // إطلاقاً (خلافاً للبيع المباشر وإغلاق الطاولة الكامل) — يعني الجزء المدفوع من أي
  // فاتورة مُجزّأة كان غائباً تماماً عن دفتر الأستاذ رغم ظهوره بالتقارير.
  const accountingSale = {
    subtotalMinor, taxTotalMinor, discountTotalMinor: 0, bundleDiscountTotalMinor: 0,
    deliveryFeeMinor: 0, loyaltyRedeemedValueMinor: 0, grandTotalMinor,
    paymentMethod: method, cashAmountMinor, cardAmountMinor, invoiceNumber, userId,
    items: pricedItems.map((it) => ({ costAtSaleMinor: it.costAtSaleMinor, quantity: it.quantity })),
  };
  h.postSaleAccountingInTransaction(accountingSale, paidSaleId, branch.id);
  h.logAudit({ userId, action: 'table_bill_split', entityType: 'sale', entityId: paidSaleId, details: { sourceSaleId: saleId, total, items: picked.length } });
  return { success: true, id: paidSaleId, invoiceNumber };
});

function splitTableSale(saleId, selected, payment, userId, shiftId) { return splitTableSaleTx(saleId, selected, payment, userId, shiftId); }

// إغلاق طاولة: يخصم المخزون فعلياً لأول مرة، يسجّل الدفع، ويحوّل الفاتورة من open إلى completed
const closeTableSaleTx = h.db.transaction((saleId, payment, actorUserId, shiftId = null) => {
  const branch = h.getCurrentBranch();
  const sale = h.db.prepare("SELECT * FROM sales WHERE id=? AND branch_id=? AND status='open'").get(saleId, branch.id);
  if (!sale) throw new Error('الطلب المفتوح غير موجود.');
  let paymentShiftId = sale.shift_id || null;
  if (shiftId != null) {
    const shift = h.db.prepare("SELECT id FROM shifts WHERE id=? AND branch_id=? AND status='open'").get(Number(shiftId), branch.id);
    if (!shift) throw new Error('جلسة الصندوق المحددة مغلقة أو لا تخص الفرع الحالي.');
    paymentShiftId = shift.id;
  }
  const items = h.db.prepare('SELECT * FROM sale_items WHERE sale_id = ?').all(saleId);
  const inventoryAlreadyCommitted = Number(sale.inventory_committed || 0) === 1;
  const updateStock = h.db.prepare(
    `UPDATE inventory SET quantity = quantity - ?, updated_at = datetime('now'), synced = 0
     WHERE branch_id = ? AND product_id = ?`
  );
  const logMovement = h.db.prepare(
    `INSERT INTO inventory_movements (uuid, branch_id, product_id, change_qty, reason, ref_id, unit_cost_after, synced)
     VALUES (?, ?, ?, ?, 'sale', ?, ?, 0)`
  );
  if (!inventoryAlreadyCommitted) {
    for (const item of items) {
      const inv = h.db.prepare('SELECT quantity FROM inventory WHERE branch_id=? AND product_id=?').get(branch.id,item.product_id);
      const product = h.db.prepare('SELECT track_inventory FROM products WHERE id=? AND is_active=1').get(item.product_id);
      if (!product) throw new Error('المنتج الموجود في الطلب لم يعد صالحًا.');
      if (product.track_inventory && (!inv || Number(inv.quantity) < Number(item.quantity))) {
        throw new Error('الكمية المتوفرة لم تعد كافية لإغلاق الطلب.');
      }
    }
  }
  // إعادة حساب الإجمالي من البنود المخزنة بدل الوثوق بأي قيمة قديمة.
  recalculateOpenSale(saleId);
  const refreshed = h.db.prepare('SELECT * FROM sales WHERE id=? AND branch_id=? AND status=\'open\'').get(saleId,branch.id);
  const payableBeforeLoyalty = Number(refreshed?.grand_total) || 0;
  // استبدال نقاط الولاء بطلبات الطاولات: نفس منطق البيع المباشر تماماً (resolveLoyaltyRedemption
  // هي مصدر الحقيقة الوحيد ولا تثق بأي رقم قادم من الواجهة). كانت هذه الميزة تعمل فقط بالكاشير
  // المباشر (createSaleTx) دون طلبات الطاولات — نفس فجوة الترحيل المحاسبي التي أُصلحت سابقاً.
  const minorUnitForLoyalty = Number(h.getGlobalProfile()?.currency_minor_unit ?? 2);
  const payableBeforeLoyaltyMinor = money.toMinor(payableBeforeLoyalty, minorUnitForLoyalty);
  const loyaltyRedemption = h.resolveLoyaltyRedemption(sale.customer_id, payment.loyaltyPointsToRedeem, payableBeforeLoyaltyMinor);
  const loyaltyRedeemedPoints = loyaltyRedemption.points;
  const loyaltyRedeemedValueMinor = loyaltyRedemption.valueMinor;
  const loyaltyRedeemedValue = money.fromMinor(loyaltyRedeemedValueMinor, minorUnitForLoyalty);
  const total = Math.max(0, payableBeforeLoyalty - loyaltyRedeemedValue);
  // الدفع الآجل بطلبات الطاولات: كان غير متاح إطلاقاً (لا خيار بالواجهة ولا تحقق هنا) —
  // بخلاف البيع المباشر من الكاشير الذي يدعمه منذ البداية. نفس شرط الاعتماد بالضبط
  // (عميل محدَّد + موافقة مدير/مدير عام) قبل قبول الطلب.
  h.assertCreditSaleAllowed({ paymentMethod: payment.paymentMethod, customerId: sale.customer_id, creditApprovedBy: payment.creditApprovedBy });
  h.validatePaymentAmounts(total, payment.paymentMethod || 'cash', payment.cashAmount, payment.cardAmount, payment.changeDue);
  if (!inventoryAlreadyCommitted) {
    for (const item of items) {
      const product = h.db.prepare('SELECT track_inventory FROM products WHERE id=? AND is_active=1').get(item.product_id);
      if (product?.track_inventory) {
        const stockResult = updateStock.run(item.quantity, branch.id, item.product_id);
        if (stockResult.changes !== 1) throw new Error('تعذّر تحديث مخزون المنتج أثناء إغلاق الطلب.');
        logMovement.run(h.uuid(), branch.id, item.product_id, -item.quantity, saleId, Number(item.cost_at_sale || 0));
      }
    }
    h.db.prepare('UPDATE sales SET inventory_committed=1 WHERE id=? AND branch_id=?').run(saleId, branch.id);
  }
  const dueAmount = (payment.paymentMethod === 'credit') ? total : 0;
  h.db.prepare(
    `UPDATE sales SET payment_method = ?, cash_amount = ?, card_amount = ?, change_due = ?, shift_id = ?, status = 'completed',
     grand_total = ?, grand_total_minor = ?, loyalty_points_redeemed = ?, loyalty_redeemed_value = ?, loyalty_redeemed_value_minor = ?,
     due_amount = ?, due_amount_minor = ?
     WHERE id = ? AND branch_id = ? AND status='open'`
  ).run(payment.paymentMethod || 'cash', payment.cashAmount || 0, payment.cardAmount || 0, payment.changeDue || 0, paymentShiftId,
    total, money.toMinor(total, minorUnitForLoyalty), loyaltyRedeemedPoints, loyaltyRedeemedValue, loyaltyRedeemedValueMinor,
    dueAmount, money.toMinor(dueAmount, minorUnitForLoyalty),
    saleId, branch.id);
  if (sale.customer_id) {
    if (loyaltyRedeemedPoints > 0) {
      h.db.prepare("UPDATE customers SET loyalty_points = MAX(0, loyalty_points - ?), updated_at = datetime('now'), synced = 0 WHERE id = ? AND branch_id=?").run(
        loyaltyRedeemedPoints, sale.customer_id, branch.id
      );
    }
    const earnedPoints = Math.floor(total / h.getLoyaltySettings().earnPerCurrencyUnit);
    if (earnedPoints > 0) {
      h.db.prepare("UPDATE customers SET loyalty_points = loyalty_points + ?, updated_at = datetime('now'), synced = 0 WHERE id = ? AND branch_id=?").run(
        earnedPoints, sale.customer_id, branch.id
      );
    }
  }

  const method = payment.paymentMethod || 'cash';
  const currency=String(h.getGlobalProfile().currency_code||'USD').toUpperCase();
  const pt=h.db.prepare(`INSERT INTO payment_transactions(uuid,branch_id,sale_id,shift_id,method,currency_code,amount,exchange_rate,provider,provider_reference,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
  const createdBy = actorUserId || sale.user_id || null;
  if(method==='cash') pt.run(h.uuid(),branch.id,saleId,paymentShiftId,'cash',currency,total,1,null,null,createdBy);
  else if(method==='card') pt.run(h.uuid(),branch.id,saleId,paymentShiftId,'card',currency,total,1,payment.paymentProvider||null,payment.paymentReference||null,createdBy);
  else if(method==='mixed'){ if(Number(payment.cashAmount)>0) pt.run(h.uuid(),branch.id,saleId,paymentShiftId,'cash',currency,Number(payment.cashAmount),1,null,null,createdBy); if(Number(payment.cardAmount)>0) pt.run(h.uuid(),branch.id,saleId,paymentShiftId,'card',currency,Number(payment.cardAmount),1,payment.paymentProvider||null,payment.paymentReference||null,createdBy); }
  else if(method==='store_credit') {
    if (!sale.customer_id) throw new Error('الدفع برصيد المتجر يتطلب عميلًا مرتبطًا بالطلب.');
    const customer = h.db.prepare('SELECT store_credit_balance FROM customers WHERE id=? AND branch_id=?').get(sale.customer_id, branch.id);
    if (!customer || Number(customer.store_credit_balance || 0) + 0.01 < total) throw new Error('رصيد المتجر غير كافٍ.');
    h.appendStoreCreditLedger({ customerId: sale.customer_id, saleId, entryType: 'sale_spend', amount: -total, createdBy: createdBy, branchId: branch.id });
    pt.run(h.uuid(),branch.id,saleId,sale.shift_id||null,'store_credit',currency,-total,1,null,null,createdBy);
  }
  else if(method==='credit') {
    // لا حركة نقدية فعلية هنا إطلاقاً (بلا pt.run) — نفس معاملة البيع الآجل المباشر
    // تمامًا: يُضاف المبلغ لدين العميل بدل تحصيله الآن.
    const customer = h.db.prepare('SELECT balance FROM customers WHERE id=? AND branch_id=?').get(sale.customer_id, branch.id);
    if (!customer) throw new Error('العميل المحدد غير موجود.');
    const balanceAfter = Number(customer.balance || 0) + total;
    h.db.prepare(`UPDATE customers SET balance = ?, updated_at = datetime('now'), synced = 0 WHERE id = ? AND branch_id=?`).run(balanceAfter, sale.customer_id, branch.id);
    h.appendCustomerLedger({ customerId: sale.customer_id, saleId, entryType: 'credit_sale', amount: total, balanceAfter, notes: `فاتورة طاولة ${refreshed.invoice_number || saleId}` });
  }

  // إغلاق طلب الطاولة لم يكن يمرّ على القيد المحاسبي (postSaleAccountingInTransaction) إطلاقاً،
  // خلافاً للبيع المباشر (createSaleTx). هذا يعني أن مبيعات المطاعم/الطاولات لم تكن تظهر في
  // دفتر الأستاذ (المحاسبة > نظرة عامة) رغم ظهورها في صفحة التقارير — تم إصلاحه هنا.
  const minorUnit = Number(h.getGlobalProfile()?.currency_minor_unit ?? 2);
  // ملاحظة مهمة: recalculateOpenSale (المستخدمة حصراً لطلبات الطاولات) تُحدّث الأعمدة
  // الرئيسية (subtotal/tax_total/grand_total) فقط، ولا تلمس أعمدة الوحدة الصغرى
  // (*_minor) إطلاقاً — تلك تبقى صفراً دائماً لأي طلب طاولة (بخلاف createSaleTx الذي
  // يملأها صراحةً عند الإنشاء). القراءة السابقة من refreshed.subtotal_minor وأخواتها
  // كانت تعيد صفراً دوماً هنا، فينكسر توازن القيد المحاسبي لأي طلب طاولة فيه ضريبة أو
  // خصم أو استبدال نقاط. الإصلاح: نشتق قيم الوحدة الصغرى من الأعمدة الرئيسية الموثوقة
  // مباشرة عبر money.toMinor بدل الاعتماد على أعمدة لم تُملأ أصلاً لهذا المسار.
  const accountingSale = {
    subtotalMinor: money.toMinor(Number(refreshed.subtotal || 0), minorUnit),
    taxTotalMinor: money.toMinor(Number(refreshed.tax_total || 0), minorUnit),
    discountTotalMinor: money.toMinor(Number(refreshed.discount_total || 0), minorUnit),
    bundleDiscountTotalMinor: money.toMinor(Number(refreshed.bundle_discount_total || 0), minorUnit),
    deliveryFeeMinor: money.toMinor(Number(refreshed.delivery_fee || 0), minorUnit),
    grandTotalMinor: money.toMinor(total, minorUnit),
    loyaltyRedeemedValueMinor,
    paymentMethod: method,
    cashAmountMinor: money.toMinor(Number(payment.cashAmount || 0), minorUnit),
    cardAmountMinor: money.toMinor(Number(payment.cardAmount || 0), minorUnit),
    invoiceNumber: refreshed.invoice_number,
    userId: createdBy,
    items: items.map((it) => ({ costAtSaleMinor: Number(it.cost_at_sale_minor || 0), quantity: Number(it.quantity || 0) })),
  };
  h.postSaleAccountingInTransaction(accountingSale, saleId, branch.id);

  return { id: saleId };
});

function closeTableSale(saleId, payment, actorUserId, shiftId = null) {
  return closeTableSaleTx(saleId, payment, actorUserId, shiftId);
}


  return {
    requestBillForTable,
    acknowledgeBillRequest,
    listTables,
    releaseEmptyTable,
    createTable,
    deleteTable,
    getOrCreateOpenSale,
    setTableSaleCustomer,
    getOpenSaleForTable,
    setOpenSaleItems,
    markKitchenSent,
    recalculateOpenSale,
    mergeTables,
    splitTableSale,
    closeTableSale
  };
};
