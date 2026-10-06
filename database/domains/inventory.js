'use strict';
/** Auto-extracted domain module — refactor batch 3–5. Do not call until h.db is initialized. */
module.exports = function createDomain(h) {
  const money = h.money;
  const accounting = h.accounting;
  const crypto = h.crypto;
  const path = h.path;
  const fs = h.fs;
  const app = h.app;

/* ---------------- تحويلات المخزون بين الفروع ---------------- */
function listTransferBranches() {
  const current = h.getCurrentBranch();
  return h.db.prepare(`
    SELECT uuid, name, notes, CASE WHEN uuid=? THEN 1 ELSE 0 END AS is_current
    FROM branch_directory
    WHERE uuid <> ?
    UNION ALL
    SELECT uuid, name, address AS notes, 1 AS is_current
    FROM branches WHERE uuid=?
    ORDER BY is_current DESC, name
  `).all(current.uuid, current.uuid, current.uuid);
}

function upsertTransferBranch({ branchUuid, name, notes = null }) {
  const current = h.getCurrentBranch();
  const cleanUuid = String(branchUuid || '').trim();
  const cleanName = String(name || '').trim();
  if (!/^[A-Za-z0-9_-]{8,200}$/.test(cleanUuid)) throw new Error('معرّف الفرع غير صالح.');
  if (!cleanName || cleanName.length > 160) throw new Error('اسم الفرع مطلوب وطوله غير صالح.');
  if (cleanUuid === current.uuid) throw new Error('لا يمكن إضافة الفرع الحالي كفرع مستلم.');
  h.db.prepare(`INSERT INTO branch_directory(uuid,name,notes,updated_at) VALUES(?,?,?,datetime('now'))
    ON CONFLICT(uuid) DO UPDATE SET name=excluded.name,notes=excluded.notes,updated_at=datetime('now')`)
    .run(cleanUuid, cleanName, notes ? String(notes).trim().slice(0,500) : null);
  return h.db.prepare('SELECT * FROM branch_directory WHERE uuid=?').get(cleanUuid);
}

function getInventoryTransferByUuid(transferUuid) {
  const branch = h.getCurrentBranch();
  const transfer = h.db.prepare(`SELECT t.*, sb.name AS source_branch_name, dbb.name AS destination_branch_name,
    u.full_name AS created_by_name,
    CASE WHEN EXISTS(SELECT 1 FROM inventory_transfer_receipts r WHERE r.transfer_uuid=t.uuid) THEN 'received' ELSE t.status END AS effective_status
    FROM inventory_transfers t
    LEFT JOIN branches sb ON sb.uuid=t.source_branch_uuid
    LEFT JOIN branches dbb ON dbb.uuid=t.destination_branch_uuid
    LEFT JOIN users u ON u.id=t.created_by
    WHERE t.uuid=? AND t.local_branch_id=?`).get(String(transferUuid||''), branch.id);
  if (!transfer) return null;
  const items = h.db.prepare(`SELECT ti.*,p.name AS product_name,p.unit FROM inventory_transfer_items ti JOIN products p ON p.id=ti.product_id WHERE ti.transfer_id=? ORDER BY ti.id`).all(transfer.id);
  const receipt = h.db.prepare(`SELECT r.*,u.full_name AS received_by_name FROM inventory_transfer_receipts r LEFT JOIN users u ON u.id=r.received_by WHERE r.transfer_uuid=?`).get(transfer.uuid) || null;
  const receiptItems = receipt ? h.db.prepare('SELECT * FROM inventory_transfer_receipt_items WHERE receipt_id=? ORDER BY id').all(receipt.id) : [];
  return { ...transfer, items, receipt: receipt ? { ...receipt, items: receiptItems } : null };
}

function listInventoryTransfers(filters = {}) {
  const branch = h.getCurrentBranch();
  let sql = `SELECT t.*, sb.name AS source_branch_name, dbb.name AS destination_branch_name,
    CASE WHEN EXISTS(SELECT 1 FROM inventory_transfer_receipts r WHERE r.transfer_uuid=t.uuid) THEN 'received' ELSE t.status END AS effective_status
    FROM inventory_transfers t
    LEFT JOIN branches sb ON sb.uuid=t.source_branch_uuid
    LEFT JOIN branches dbb ON dbb.uuid=t.destination_branch_uuid
    WHERE t.local_branch_id=?`;
  const params=[branch.id];
  if (filters.status) sql += ' AND (CASE WHEN EXISTS(SELECT 1 FROM inventory_transfer_receipts r WHERE r.transfer_uuid=t.uuid) THEN \'received\' ELSE t.status END)=?', params.push(String(filters.status));
  sql += ' ORDER BY t.created_at DESC LIMIT 500';
  const rows=h.db.prepare(sql).all(...params);
  return rows.map((row)=>({ ...row, items: h.db.prepare(`SELECT ti.product_uuid,ti.quantity,p.name AS product_name,p.unit FROM inventory_transfer_items ti JOIN products p ON p.id=ti.product_id WHERE ti.transfer_id=? ORDER BY ti.id`).all(row.id) }));
}

const createInventoryTransferTx = h.db.transaction((payload = {}) => {
  const branch=h.getCurrentBranch();
  h.assertAccountingPeriodOpen(branch.id);
  const destinationBranchUuid=String(payload.destinationBranchUuid||'').trim();
  if (!destinationBranchUuid || destinationBranchUuid === branch.uuid) throw new Error('فرع الاستلام غير صالح.');
  const destination=h.db.prepare('SELECT uuid,name FROM branch_directory WHERE uuid=?').get(destinationBranchUuid);
  if (!destination) throw new Error('فرع الاستلام غير موجود في قائمة الفروع المعروفة. أضفه أولاً من إعدادات التحويلات.');
  const rawItems=Array.isArray(payload.items)?payload.items:[];
  if (!rawItems.length) throw new Error('أضف منتجاً واحداً على الأقل للتحويل.');

  const merged=new Map();
  for (const raw of rawItems) {
    const productId=Number(raw.productId); const quantity=Number(raw.quantity);
    if (!Number.isInteger(productId) || productId<=0 || !Number.isFinite(quantity) || quantity<=0) throw new Error('بيانات منتج أو كمية غير صالحة.');
    merged.set(productId,(merged.get(productId)||0)+quantity);
  }

  const transferUuid=h.uuid();
  const result=h.db.prepare(`INSERT INTO inventory_transfers(uuid,source_branch_uuid,destination_branch_uuid,local_branch_id,status,notes,created_by,shipped_at,updated_at,synced)
    VALUES(?,?,?,?,?,?,?,?,datetime('now'),0)`).run(transferUuid,branch.uuid,destinationBranchUuid,branch.id,'shipped',payload.notes?String(payload.notes).trim().slice(0,1000):null,payload.createdBy||null,new Date().toISOString());
  const transferId=result.lastInsertRowid;
  const stockStmt=h.db.prepare('SELECT i.quantity,i.unit_cost FROM inventory i WHERE i.branch_id=? AND i.product_id=?');
  const productStmt=h.db.prepare('SELECT id,uuid,name,is_active,track_inventory FROM products WHERE id=?');
  const updateStock=h.db.prepare(`UPDATE inventory SET quantity=quantity-?,updated_at=datetime('now'),synced=0 WHERE branch_id=? AND product_id=? AND quantity>=?`);
  const itemStmt=h.db.prepare('INSERT INTO inventory_transfer_items(transfer_id,product_id,product_uuid,quantity,unit_cost) VALUES(?,?,?,?,?)');
  const movementStmt=h.db.prepare(`INSERT INTO inventory_movements(uuid,branch_id,product_id,change_qty,reason,ref_id,notes,unit_cost_after,synced) VALUES(?,?,?,?,?,?,?,?,0)`);
  for (const [productId,quantity] of merged.entries()) {
    const product=productStmt.get(productId);
    if (!product || !product.is_active || !product.track_inventory) throw new Error(`المنتج رقم ${productId} غير صالح للتحويل.`);
    const stock=stockStmt.get(branch.id,productId);
    const available=Number(stock?.quantity||0);
    if (available < quantity) throw new Error(`المخزون غير كافٍ للصنف: ${product.name}. المتاح ${available}.`);
    const changed=updateStock.run(quantity,branch.id,productId,quantity);
    if (!changed.changes) throw new Error(`تعذر حجز كمية الصنف: ${product.name}.`);
    itemStmt.run(transferId,productId,product.uuid,quantity,Number(stock?.unit_cost||product.cost||0));
    movementStmt.run(h.uuid(),branch.id,productId,-quantity,'transfer_out',transferId,`تحويل إلى الفرع ${destination.name}`,Number(stock?.unit_cost||product.cost||0));
  }
  // قيد: يخفض 1300 على فرع المصدر مقابل حقوق الملكية (تحويل بين فروع)
  {
    const unit = Number(h.getGlobalProfile()?.currency_minor_unit ?? 2);
    let totalCostMinor = 0;
    for (const [productId, quantity] of merged.entries()) {
      const item = h.db.prepare('SELECT unit_cost FROM inventory_transfer_items WHERE transfer_id=? AND product_id=?').get(transferId, productId);
      totalCostMinor += Math.round(Math.abs(Number(quantity)) * money.toMinor(Number(item?.unit_cost || 0), unit));
    }
    if (totalCostMinor > 0) {
      h.insertPostedJournalEntry({
        branchId: branch.id,
        memo: `تحويل مخزون صادر ${transferUuid}`,
        referenceType: 'inventory_transfer_out',
        referenceId: transferId,
        lines: [
          { accountId: h.getAccountingAccountId(branch.id, '3000'), debitMinor: totalCostMinor, creditMinor: 0, memo: 'تحويل بين فروع' },
          { accountId: h.getAccountingAccountId(branch.id, '1300'), debitMinor: 0, creditMinor: totalCostMinor, memo: 'إخراج مخزون تحويل' },
        ],
        createdBy: payload.createdBy || null,
      });
    }
  }
  return transferId;
});
function createInventoryTransfer(payload={}) { const id=createInventoryTransferTx(payload); const row=h.db.prepare('SELECT uuid FROM inventory_transfers WHERE id=?').get(id); return getInventoryTransferByUuid(row.uuid); }
const receiveInventoryTransferTx = h.db.transaction((payload = {}) => {
  const branch=h.getCurrentBranch();
  h.assertAccountingPeriodOpen(branch.id);
  const transferUuid=String(payload.transferUuid||'').trim();
  const transfer=h.db.prepare('SELECT * FROM inventory_transfers WHERE uuid=? AND local_branch_id=?').get(transferUuid,branch.id);
  if (!transfer) throw new Error('التحويل غير موجود على هذا الفرع.');
  if (transfer.destination_branch_uuid !== branch.uuid) throw new Error('هذا الفرع ليس فرع الاستلام.');
  const exists=h.db.prepare('SELECT id FROM inventory_transfer_receipts WHERE transfer_uuid=?').get(transferUuid);
  if (exists) throw new Error('تم استلام هذا التحويل مسبقاً.');
  if (transfer.status === 'cancelled') throw new Error('لا يمكن استلام تحويل ملغى.');
  const items=h.db.prepare('SELECT ti.*,p.name,p.is_active,p.track_inventory FROM inventory_transfer_items ti JOIN products p ON p.uuid=ti.product_uuid WHERE ti.transfer_id=?').all(transfer.id);
  if (!items.length) throw new Error('التحويل لا يحتوي أصنافاً.');
  const receiptUuid=h.uuid();
  const receiptId=h.db.prepare(`INSERT INTO inventory_transfer_receipts(uuid,transfer_uuid,source_branch_uuid,destination_branch_uuid,local_branch_id,received_by,notes,synced)
    VALUES(?,?,?,?,?,?,?,0)`).run(receiptUuid,transfer.source_branch_uuid,transfer.destination_branch_uuid,branch.id,payload.receivedBy||null,payload.notes?String(payload.notes).trim().slice(0,1000):null).lastInsertRowid;
  const upsertInv=h.db.prepare(`INSERT INTO inventory(branch_id,product_id,quantity,unit_cost,min_quantity,updated_at,synced) VALUES(?,?,?,?,0,datetime('now'),0)
    ON CONFLICT(branch_id,product_id) DO UPDATE SET quantity=inventory.quantity+excluded.quantity,unit_cost=CASE WHEN excluded.unit_cost>0 THEN excluded.unit_cost ELSE inventory.unit_cost END,updated_at=datetime('now'),synced=0`);
  const receiptItem=h.db.prepare('INSERT INTO inventory_transfer_receipt_items(receipt_id,product_uuid,quantity_received) VALUES(?,?,?)');
  const movement=h.db.prepare(`INSERT INTO inventory_movements(uuid,branch_id,product_id,change_qty,reason,ref_id,notes,unit_cost_after,synced) VALUES(?,?,?,?,?,?,?,?,0)`);
  for(const item of items){
    if(!item.is_active || !item.track_inventory) throw new Error(`الصنف ${item.name} لم يعد صالحاً للاستلام.`);
    const qty=Number(item.quantity); if(!(qty>0)) continue;
    upsertInv.run(branch.id,item.product_id,qty,Number(item.unit_cost||0));
    receiptItem.run(receiptId,item.product_uuid,qty);
    movement.run(h.uuid(),branch.id,item.product_id,qty,'transfer_in',receiptId,`استلام تحويل ${transferUuid}`,Number(item.unit_cost||0));
  }
  h.db.prepare(`UPDATE inventory_transfers SET status='received',updated_at=datetime('now') WHERE id=?`).run(transfer.id);
  // قيد: يرفع 1300 على فرع الاستلام
  {
    const unit = Number(h.getGlobalProfile()?.currency_minor_unit ?? 2);
    let totalCostMinor = 0;
    for (const item of items) {
      const qty = Number(item.quantity) || 0;
      if (!(qty > 0)) continue;
      totalCostMinor += Math.round(qty * money.toMinor(Number(item.unit_cost || 0), unit));
    }
    if (totalCostMinor > 0) {
      h.insertPostedJournalEntry({
        branchId: branch.id,
        memo: `تحويل مخزون وارد ${transferUuid}`,
        referenceType: 'inventory_transfer_in',
        referenceId: receiptId,
        lines: [
          { accountId: h.getAccountingAccountId(branch.id, '1300'), debitMinor: totalCostMinor, creditMinor: 0, memo: 'إدخال مخزون تحويل' },
          { accountId: h.getAccountingAccountId(branch.id, '3000'), debitMinor: 0, creditMinor: totalCostMinor, memo: 'تحويل بين فروع' },
        ],
        createdBy: payload.receivedBy || null,
      });
    }
  }
  return receiptUuid;
});
function receiveInventoryTransfer(payload={}) {
  receiveInventoryTransferTx(payload);
  return getInventoryTransferByUuid(payload.transferUuid);
}

function cancelInventoryTransfer(transferUuid) {
  h.assertAccountingPeriodOpen(h.getCurrentBranch().id);
  const branch=h.getCurrentBranch();
  return h.db.transaction(()=>{
    const transfer=h.db.prepare('SELECT * FROM inventory_transfers WHERE uuid=? AND local_branch_id=?').get(String(transferUuid||''),branch.id);
    if(!transfer) throw new Error('التحويل غير موجود.');
    if(transfer.source_branch_uuid!==branch.uuid) throw new Error('لا يمكن إلغاء تحويل ليس مرسلاً من هذا الفرع.');
    if(transfer.status!=='shipped') throw new Error('لا يمكن إلغاء تحويل تم استلامه أو إلغاؤه سابقاً.');
    if(Number(transfer.synced)!==0) throw new Error('تم إرسال التحويل إلى المزامنة؛ لا يمكن إلغاؤه الآن. أنشئ تحويلاً عكسياً بدلاً من تعديل السجل التاريخي.');
    if(h.db.prepare('SELECT 1 FROM inventory_transfer_receipts WHERE transfer_uuid=?').get(transfer.uuid)) throw new Error('لا يمكن إلغاء تحويل تم استلامه.');
    const items=h.db.prepare('SELECT * FROM inventory_transfer_items WHERE transfer_id=?').all(transfer.id);
    for(const item of items){
      h.db.prepare('UPDATE inventory SET quantity=quantity+?,updated_at=datetime(\'now\'),synced=0 WHERE branch_id=? AND product_id=?').run(item.quantity,branch.id,item.product_id);
      h.db.prepare(`INSERT INTO inventory_movements(uuid,branch_id,product_id,change_qty,reason,ref_id,notes,unit_cost_after,synced) VALUES(?,?,?,?,?,?,?,?,0)`).run(h.uuid(),branch.id,item.product_id,item.quantity,'transfer_cancel',transfer.id,`إلغاء تحويل ${transfer.uuid}`,item.unit_cost);
    }
    h.db.prepare(`UPDATE inventory_transfers SET status='cancelled',updated_at=datetime('now'),synced=0 WHERE id=?`).run(transfer.id);
    return getInventoryTransferByUuid(transfer.uuid);
  })();
}


/* ---------------- المخزون ---------------- */
// قائمة كل المنتجات التي تتبّع المخزون مع كمياتها، مرتبة بحيث تظهر المنتجات المنخفضة أولاً
function listInventory(filters = {}) {
  const branch = h.getCurrentBranch();
  let sql = `
    SELECT p.id, p.name, p.sku, p.barcode, p.unit, p.cost, cat.name AS category_name,
           COALESCE(i.quantity, 0) AS stock, COALESCE(i.min_quantity, 0) AS min_quantity,
           i.updated_at AS stock_updated_at
    FROM products p
    LEFT JOIN inventory i ON i.product_id = p.id AND i.branch_id = ?
    LEFT JOIN categories cat ON cat.id = p.category_id
    WHERE p.is_active = 1 AND p.track_inventory = 1`;
  const params = [branch.id];

  if (filters.search) {
    sql += ` AND (p.name LIKE ? OR p.barcode = ? OR p.sku = ?)`;
    params.push(`%${filters.search}%`, filters.search, filters.search);
  }
  if (filters.lowOnly) {
    sql += ` AND COALESCE(i.quantity, 0) <= COALESCE(i.min_quantity, 0)`;
  }
  sql += ' ORDER BY (COALESCE(i.quantity,0) <= COALESCE(i.min_quantity,0)) DESC, p.name';
  return h.db.prepare(sql).all(...params);
}

// تسوية/تعديل يدوي للمخزون (جرد، تالف، شراء بضاعة جديدة...) — عملية واحدة داخل transaction
const adjustInventoryTx = h.db.transaction((payload) => {
  const branch = h.getCurrentBranch();
  h.assertAccountingPeriodOpen(branch.id);
  const product = h.db.prepare('SELECT id, is_active, track_inventory, cost FROM products WHERE id=?').get(Number(payload.productId));
  if (!product || !product.is_active) throw new Error('المنتج غير موجود أو غير نشط.');
  const changeQty=Number(payload.changeQty);
  if (!Number.isFinite(changeQty) || changeQty===0) throw new Error('كمية التسوية غير صالحة.');
  const existing = h.db
    .prepare('SELECT id FROM inventory WHERE branch_id = ? AND product_id = ?')
    .get(branch.id, payload.productId);

  if (existing) {
    h.db.prepare(
      `UPDATE inventory SET quantity = quantity + ?, updated_at = datetime('now'), synced = 0
       WHERE branch_id = ? AND product_id = ?`
    ).run(changeQty, branch.id, payload.productId);
  } else {
    h.db.prepare(
      `INSERT INTO inventory (branch_id, product_id, quantity, min_quantity, unit_cost) VALUES (?, ?, ?, 0, ?)`
    ).run(branch.id, payload.productId, changeQty, product.cost || 0);
  }

  const movementId = h.db.prepare(
    `INSERT INTO inventory_movements (uuid, branch_id, product_id, change_qty, reason, ref_id, notes, synced)
     VALUES (?, ?, ?, ?, ?, NULL, ?, 0)`
  ).run(h.uuid(), branch.id, payload.productId, payload.changeQty, payload.reason || 'adjustment', payload.notes || null).lastInsertRowid;

  const costMinor = money.toMinor(Number(product.cost || 0), Number(h.getGlobalProfile()?.currency_minor_unit ?? 2));
  const valueMinor = Math.round(Math.abs(changeQty) * costMinor);
  if (product.track_inventory && valueMinor > 0) {
    const adjustmentAccountId = h.ensureInventoryAdjustmentAccount(branch.id);
    const inventoryAccountId = h.getAccountingAccountId(branch.id, '1300');
    h.insertPostedJournalEntry({
      branchId: branch.id,
      memo: `تسوية مخزون: ${payload.reason || 'adjustment'}`,
      referenceType: 'inventory_adjustment',
      referenceId: movementId,
      lines: changeQty > 0
        ? [
            { accountId: inventoryAccountId, debitMinor: valueMinor, creditMinor: 0 },
            { accountId: adjustmentAccountId, debitMinor: 0, creditMinor: valueMinor },
          ]
        : [
            { accountId: adjustmentAccountId, debitMinor: valueMinor, creditMinor: 0 },
            { accountId: inventoryAccountId, debitMinor: 0, creditMinor: valueMinor },
          ],
    });
  }

  return { success: true };
});

function adjustInventory(payload) {
  return adjustInventoryTx(payload);
}

function listInventoryMovements(filters = {}) {
  const branch = h.getCurrentBranch();
  let sql = `
    SELECT m.*, p.name AS product_name
    FROM inventory_movements m
    JOIN products p ON p.id = m.product_id
    WHERE m.branch_id = ?`;
  const params = [branch.id];
  if (filters.productId) {
    sql += ' AND m.product_id = ?';
    params.push(filters.productId);
  }
  sql += ' ORDER BY m.created_at DESC LIMIT 300';
  return h.db.prepare(sql).all(...params);
}


  return {
    listTransferBranches,
    upsertTransferBranch,
    getInventoryTransferByUuid,
    listInventoryTransfers,
    createInventoryTransfer,
    receiveInventoryTransfer,
    cancelInventoryTransfer,
    listInventory,
    adjustInventory,
    listInventoryMovements
  };
};
