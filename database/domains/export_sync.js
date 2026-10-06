'use strict';
/** Auto-extracted domain module — refactor batch 3–5. Do not call until h.db is initialized. */
module.exports = function createDomain(h) {
  const money = h.money;
  const accounting = h.accounting;
  const crypto = h.crypto;
  const path = h.path;
  const fs = h.fs;
  const app = h.app;

/* ---------------- بيانات التصدير ---------------- */
function getReportExport(range = {}) {
  const summary = h.getSalesSummary(range);
  const topProducts = h.getTopProducts({ ...range, limit: 100 });
  const daily = h.getDailySales(range);
  const delivery = h.getDeliverySummary(range);
  const profitLoss = h.getProfitLoss(range);
  const balances = h.getBalancesSnapshot();
  return { summary, topProducts, daily, delivery, profitLoss, balances, range };
}

/* ---------------- إعدادات ومحتوى المزامنة ---------------- */
function getSyncConfig() {
  return {
    serverUrl: h.getSetting('sync_server_url', ''),
    token: h.getSetting('sync_token', ''),
    enabled: h.getSetting('sync_enabled', '0') === '1',
    cursor: h.getSetting('sync_cursor', '0'),
    lastSyncAt: h.getSetting('sync_last_at', ''),
    // بصمة SHA-256 لشهادة TLS مُثبَّتة (pinning) — تُملأ فقط عند الاتصال بخادم LAN مُضمَّن ذاتي
    // التوقيع (راجع server/lan-tls.js وserver/pinned-request.js). فارغة لخادم مركزي حقيقي خلف
    // TLS بشهادة مرجع ثقة عادي (عندها sync-client.js يستخدم تحقق TLS القياسي بدلاً من التثبيت).
    tlsFingerprint: h.getSetting('sync_tls_fingerprint', ''),
  };
}
function saveSyncConfig(config = {}) {
  const url = String(config.serverUrl || '').trim().replace(/\/$/, '');
  if (config.enabled && !String(config.token || '').trim()) {
    throw new Error('لا يمكن تفعيل المزامنة بدون رمز وصول للفرع.');
  }
  if (url) {
    let parsed;
    try { parsed = new URL(url); } catch { throw new Error('عنوان الخادم غير صالح.'); }
    const isLoopbackHost = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(String(parsed.hostname).toLowerCase());
    if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('عنوان الخادم يجب أن يستخدم HTTPS أو HTTP محلي فقط.');
    if (parsed.protocol === 'http:' && !isLoopbackHost) {
      throw new Error('المزامنة إلى خادم بعيد يجب أن تستخدم HTTPS لحماية بيانات المبيعات والمفاتيح. HTTP مسموح فقط على الجهاز المحلي.');
    }
  }
  h.setSetting('sync_server_url', url);
  h.setSetting('sync_token', String(config.token || '').trim());
  h.setSetting('sync_enabled', config.enabled ? '1' : '0');
  // إدخال عنوان خادم يدوياً من شاشة الإعدادات (خادم مركزي حقيقي، لا اقتران LAN) يعني شهادة
  // TLS عادية من مرجع ثقة معروف — نُلغي أي بصمة LAN مثبَّتة سابقاً حتى تُستخدم آلية التحقق
  // القياسية بدل التثبيت (والعكس: الاقتران بالجهاز الرئيسي يضبط sync_tls_fingerprint بنفسه)
  h.setSetting('sync_tls_fingerprint', '');
  return { success: true };
}
function syncPayload() {
  const branch = h.getCurrentBranch();
  const categoryRows = h.db.prepare(`SELECT c.*,pc.uuid AS parent_uuid FROM categories c LEFT JOIN categories pc ON pc.id=c.parent_id WHERE c.synced=0`).all();
  const productRows = h.db.prepare(`SELECT p.*,c.uuid AS category_uuid,pp.uuid AS parent_product_uuid,tp.uuid AS tax_profile_uuid FROM products p LEFT JOIN categories c ON c.id=p.category_id LEFT JOIN products pp ON pp.id=p.parent_product_id LEFT JOIN tax_profiles tp ON tp.id=p.tax_profile_id AND tp.branch_id=? WHERE p.synced=0`).all(branch.id);
  const customerRows = h.db.prepare(`SELECT c.*,b.uuid AS branch_uuid FROM customers c JOIN branches b ON b.id=c.branch_id WHERE c.branch_id=? AND c.synced=0`).all(branch.id);
  const customerLedgerRows = h.db.prepare(`SELECT cl.*,c.uuid AS customer_uuid,s.uuid AS sale_uuid,b.uuid AS branch_uuid FROM customer_ledger cl JOIN customers c ON c.id=cl.customer_id LEFT JOIN sales s ON s.id=cl.sale_id JOIN branches b ON b.id=cl.branch_id WHERE cl.branch_id=? AND cl.synced=0 AND cl.uuid IS NOT NULL`).all(branch.id);
  const storeCreditLedgerRows = h.db.prepare(`SELECT scl.*,c.uuid AS customer_uuid,s.uuid AS sale_uuid,r.uuid AS return_uuid,b.uuid AS branch_uuid,u.username AS created_by_username
    FROM store_credit_ledger scl JOIN customers c ON c.id=scl.customer_id LEFT JOIN sales s ON s.id=scl.sale_id LEFT JOIN returns r ON r.id=scl.return_id JOIN branches b ON b.id=scl.branch_id LEFT JOIN users u ON u.id=scl.created_by
    WHERE scl.branch_id=? AND scl.synced=0`).all(branch.id);
  const inventoryRows = h.db.prepare(`SELECT i.*,p.uuid AS product_uuid,b.uuid AS branch_uuid FROM inventory i JOIN products p ON p.id=i.product_id JOIN branches b ON b.id=i.branch_id WHERE i.branch_id=? AND i.synced=0`).all(branch.id);
  const saleRows = h.db.prepare('SELECT * FROM sales WHERE branch_id=? AND synced=0').all(branch.id).map((sale) => ({
    ...sale, branch_uuid: branch.uuid,
    customer_uuid: sale.customer_id ? h.db.prepare('SELECT uuid FROM customers WHERE id=? AND branch_id=?').get(sale.customer_id, branch.id)?.uuid : null,
    shift_uuid: sale.shift_id ? h.db.prepare('SELECT uuid FROM shifts WHERE id=? AND branch_id=?').get(sale.shift_id, branch.id)?.uuid : null,
    user_username: sale.user_id ? h.db.prepare('SELECT username FROM users WHERE id=? AND branch_id=?').get(sale.user_id, branch.id)?.username : null,
    table_uuid: sale.table_id ? h.db.prepare('SELECT uuid FROM restaurant_tables WHERE id=? AND branch_id=?').get(sale.table_id, branch.id)?.uuid : null,
    items: h.db.prepare(`SELECT si.*,p.uuid AS product_uuid,tp.uuid AS tax_profile_uuid FROM sale_items si JOIN products p ON p.id=si.product_id LEFT JOIN tax_profiles tp ON tp.id=si.tax_profile_id AND tp.branch_id=? WHERE si.sale_id=?`).all(branch.id,sale.id),
    bundles_applied: h.db.prepare('SELECT uuid,bundle_uuid,bundle_name,applications,discount,discount_minor,items_json FROM sale_bundles WHERE sale_id=? ORDER BY id').all(sale.id),
  }));
  const paymentRows = h.db.prepare(`SELECT pt.*,b.uuid AS branch_uuid,s.uuid AS sale_uuid,r.uuid AS return_uuid,sh.uuid AS shift_uuid,u.username AS created_by_username FROM payment_transactions pt JOIN branches b ON b.id=pt.branch_id LEFT JOIN sales s ON s.id=pt.sale_id LEFT JOIN returns r ON r.id=pt.return_id LEFT JOIN shifts sh ON sh.id=pt.shift_id LEFT JOIN users u ON u.id=pt.created_by WHERE pt.branch_id=? AND pt.synced=0`).all(branch.id);
  const cashMovementRows = h.db.prepare(`SELECT cm.*,b.uuid AS branch_uuid,sh.uuid AS shift_uuid,u.username AS created_by_username FROM cash_movements cm JOIN branches b ON b.id=cm.branch_id JOIN shifts sh ON sh.id=cm.shift_id LEFT JOIN users u ON u.id=cm.created_by WHERE cm.branch_id=? AND cm.synced=0`).all(branch.id);
  const shiftRows = h.db.prepare(`SELECT sh.*,b.uuid AS branch_uuid,uo.username AS opened_by_username,uc.username AS closed_by_username FROM shifts sh JOIN branches b ON b.id=sh.branch_id LEFT JOIN users uo ON uo.id=sh.opened_by LEFT JOIN users uc ON uc.id=sh.closed_by WHERE sh.branch_id=? AND sh.synced=0`).all(branch.id);
  const inventoryMovementRows = h.db.prepare(`SELECT im.*,p.uuid AS product_uuid,b.uuid AS branch_uuid FROM inventory_movements im JOIN products p ON p.id=im.product_id JOIN branches b ON b.id=im.branch_id WHERE im.branch_id=? AND im.synced=0 AND im.uuid IS NOT NULL`).all(branch.id);
  const supplierRows = h.db.prepare(`SELECT s.*,b.uuid AS branch_uuid FROM suppliers s JOIN branches b ON b.id=s.branch_id WHERE s.branch_id=? AND s.synced=0`).all(branch.id);
  const supplierLedgerRows = h.db.prepare(`SELECT sl.*,s.uuid AS supplier_uuid,b.uuid AS branch_uuid,po.uuid AS purchase_order_uuid FROM supplier_ledger sl JOIN suppliers s ON s.id=sl.supplier_id JOIN branches b ON b.id=sl.branch_id LEFT JOIN purchase_orders po ON po.id=sl.purchase_order_id WHERE sl.branch_id=? AND sl.synced=0 AND sl.uuid IS NOT NULL`).all(branch.id);
  const purchaseOrderRows = h.db.prepare(`SELECT po.*,s.uuid AS supplier_uuid,b.uuid AS branch_uuid FROM purchase_orders po JOIN suppliers s ON s.id=po.supplier_id JOIN branches b ON b.id=po.branch_id WHERE po.branch_id=? AND po.synced=0`).all(branch.id).map((po) => ({...po,items: h.db.prepare(`SELECT poi.*,p.uuid AS product_uuid FROM purchase_order_items poi JOIN products p ON p.id=poi.product_id WHERE poi.purchase_order_id=?`).all(po.id)}));
  const returnRows = h.db.prepare(`SELECT r.*,b.uuid AS branch_uuid,s.uuid AS sale_uuid,sh.uuid AS shift_uuid,u.username AS user_username FROM returns r JOIN branches b ON b.id=r.branch_id JOIN sales s ON s.id=r.sale_id LEFT JOIN shifts sh ON sh.id=r.shift_id LEFT JOIN users u ON u.id=r.user_id WHERE r.branch_id=? AND r.synced=0`).all(branch.id).map((r) => ({...r,items: h.db.prepare(`SELECT ri.*,si.uuid AS sale_item_uuid,p.uuid AS product_uuid FROM return_items ri JOIN products p ON p.id=ri.product_id JOIN sale_items si ON si.id=ri.sale_item_id WHERE ri.return_id=?`).all(r.id)}));
  const tableRows = h.db.prepare(`SELECT t.*,b.uuid AS branch_uuid FROM restaurant_tables t JOIN branches b ON b.id=t.branch_id WHERE t.branch_id=? AND t.synced=0`).all(branch.id);
  const bundleRows = h.db.prepare(`SELECT bu.*,b.uuid AS branch_uuid FROM bundles bu JOIN branches b ON b.id=bu.branch_id WHERE bu.branch_id=? AND bu.synced=0`).all(branch.id).map((b) => ({...b,items: h.db.prepare(`SELECT bi.*,p.uuid AS product_uuid FROM bundle_items bi JOIN products p ON p.id=bi.product_id WHERE bi.bundle_id=?`).all(b.id)}));
  const taxProfileRows = h.db.prepare(`SELECT tp.*,b.uuid AS branch_uuid FROM tax_profiles tp JOIN branches b ON b.id=tp.branch_id WHERE tp.branch_id=? AND tp.synced=0`).all(branch.id);
  const inventoryTransferRows = h.db.prepare(`SELECT t.* FROM inventory_transfers t WHERE t.local_branch_id=? AND t.source_branch_uuid=? AND t.synced=0`).all(branch.id, branch.uuid).map((t)=>({
    ...t, branch_uuid: branch.uuid,
    items: h.db.prepare(`SELECT product_uuid,quantity,unit_cost FROM inventory_transfer_items WHERE transfer_id=? ORDER BY id`).all(t.id)
  }));
  const payrollEmployeeRows = h.db.prepare(`SELECT e.*,b.uuid AS branch_uuid FROM payroll_employees e JOIN branches b ON b.id=e.branch_id WHERE e.branch_id=? AND e.synced=0`).all(branch.id);
  const payrollMonthRows = h.db.prepare(`SELECT m.*,b.uuid AS branch_uuid FROM payroll_months m JOIN branches b ON b.id=m.branch_id WHERE m.branch_id=? AND m.synced=0`).all(branch.id);
  const payrollEmployeeMonthRows = h.db.prepare(`SELECT em.*,m.uuid AS month_uuid,e.uuid AS employee_uuid,b.uuid AS branch_uuid FROM payroll_employee_months em JOIN payroll_months m ON m.id=em.month_id JOIN payroll_employees e ON e.id=em.employee_id JOIN branches b ON b.id=? WHERE em.synced=0`).all(branch.id);
  const payrollTransactionRows = h.db.prepare(`SELECT t.*,m.uuid AS month_uuid,e.uuid AS employee_uuid,b.uuid AS branch_uuid FROM payroll_transactions t JOIN payroll_months m ON m.id=t.month_id JOIN payroll_employees e ON e.id=t.employee_id JOIN branches b ON b.id=t.branch_id WHERE t.branch_id=? AND t.synced=0`).all(branch.id);
  const payrollAdvanceRows = h.db.prepare(`SELECT a.*,e.uuid AS employee_uuid,b.uuid AS branch_uuid FROM payroll_advances a JOIN payroll_employees e ON e.id=a.employee_id JOIN branches b ON b.id=a.branch_id WHERE a.branch_id=? AND a.synced=0`).all(branch.id);
  const payrollInstallmentRows = h.db.prepare(`SELECT i.*,a.uuid AS advance_uuid,b.uuid AS branch_uuid FROM payroll_advance_installments i JOIN payroll_advances a ON a.id=i.advance_id JOIN branches b ON b.id=a.branch_id WHERE a.branch_id=? AND i.synced=0`).all(branch.id);
  const payrollAdvancePaymentRows = h.db.prepare(`SELECT p.*,a.uuid AS advance_uuid,b.uuid AS branch_uuid FROM payroll_advance_payments p JOIN payroll_advances a ON a.id=p.advance_id JOIN branches b ON b.id=p.branch_id WHERE p.branch_id=? AND p.synced=0`).all(branch.id);
  const payrollAllocationRows = h.db.prepare(`SELECT pa.*,p.uuid AS payment_uuid,i.advance_id,a.uuid AS advance_uuid,i.month_key,b.uuid AS branch_uuid FROM payroll_advance_payment_allocations pa JOIN payroll_advance_payments p ON p.id=pa.payment_id JOIN payroll_advance_installments i ON i.id=pa.installment_id JOIN payroll_advances a ON a.id=i.advance_id JOIN branches b ON b.id=a.branch_id WHERE a.branch_id=? AND pa.synced=0`).all(branch.id);
  const payrollPaymentRows = h.db.prepare(`SELECT p.*,m.uuid AS month_uuid,e.uuid AS employee_uuid,b.uuid AS branch_uuid FROM payroll_payments p JOIN payroll_months m ON m.id=p.month_id JOIN payroll_employees e ON e.id=p.employee_id JOIN branches b ON b.id=p.branch_id WHERE p.branch_id=? AND p.synced=0`).all(branch.id);
  const payrollSettlementRows = h.db.prepare(`SELECT s.*,m.uuid AS month_uuid,e.uuid AS employee_uuid,b.uuid AS branch_uuid FROM payroll_final_settlements s JOIN payroll_months m ON m.id=s.month_id JOIN payroll_employees e ON e.id=s.employee_id JOIN branches b ON b.id=s.branch_id WHERE s.branch_id=? AND s.synced=0`).all(branch.id);
  const inventoryTransferReceiptRows = h.db.prepare(`SELECT r.* FROM inventory_transfer_receipts r WHERE r.local_branch_id=? AND r.destination_branch_uuid=? AND r.synced=0`).all(branch.id, branch.uuid).map((r)=>({
    ...r, branch_uuid: branch.uuid,
    items: h.db.prepare(`SELECT product_uuid,quantity_received FROM inventory_transfer_receipt_items WHERE receipt_id=? ORDER BY id`).all(r.id)
  }));
  return { branch, changes: { categories: categoryRows, products: productRows, tables: tableRows, customers: customerRows, inventory: inventoryRows, sales: saleRows, payments: paymentRows, cash_movements: cashMovementRows, shifts: shiftRows, inventory_movements: inventoryMovementRows, suppliers: supplierRows, supplier_ledger: supplierLedgerRows, purchase_orders: purchaseOrderRows, returns: returnRows, bundles: bundleRows, customer_ledger: customerLedgerRows, store_credit_ledger: storeCreditLedgerRows, tax_profiles: taxProfileRows, inventory_transfers: inventoryTransferRows, inventory_transfer_receipts: inventoryTransferReceiptRows, payroll_employees: payrollEmployeeRows, payroll_months: payrollMonthRows, payroll_employee_months: payrollEmployeeMonthRows, payroll_transactions: payrollTransactionRows, payroll_advances: payrollAdvanceRows, payroll_advance_installments: payrollInstallmentRows, payroll_advance_payments: payrollAdvancePaymentRows, payroll_advance_payment_allocations: payrollAllocationRows, payroll_payments: payrollPaymentRows, payroll_final_settlements: payrollSettlementRows } };
}
function markSynced(payload) {
  const set = (table, rows) => {
    const uuids=(rows||[]).map(r=>r.uuid).filter(Boolean); if(!uuids.length)return;
    h.db.prepare(`UPDATE ${table} SET synced=1 WHERE uuid IN (${uuids.map(()=>'?').join(',')})`).run(...uuids);
  };
  ['categories','products','restaurant_tables','customers','sales','payments','cash_movements','shifts','inventory_movements','suppliers','supplier_ledger','purchase_orders','customer_ledger','store_credit_ledger','returns','bundles','tax_profiles','inventory_transfers','inventory_transfer_receipts','payroll_employees','payroll_months','payroll_employee_months','payroll_transactions','payroll_advances','payroll_advance_installments','payroll_advance_payments','payroll_advance_payment_allocations','payroll_payments','payroll_final_settlements'].forEach((entity)=>{
    const table = entity==='payments' ? 'payment_transactions' : entity==='restaurant_tables' ? 'restaurant_tables' : entity;
    set(table,payload.changes?.[entity]);
  });
  const ids=(payload.changes?.inventory||[]).map(r=>r.id).filter(Boolean); if(ids.length)h.db.prepare(`UPDATE inventory SET synced=1 WHERE id IN (${ids.map(()=>'?').join(',')})`).run(...ids);
  const transferUuids=(payload.changes?.inventory_transfers||[]).map(r=>r.uuid).filter(Boolean); if(transferUuids.length)h.db.prepare(`UPDATE inventory_transfers SET synced=1 WHERE uuid IN (${transferUuids.map(()=>'?').join(',')})`).run(...transferUuids);
  const receiptUuids=(payload.changes?.inventory_transfer_receipts||[]).map(r=>r.uuid).filter(Boolean); if(receiptUuids.length)h.db.prepare(`UPDATE inventory_transfer_receipts SET synced=1 WHERE uuid IN (${receiptUuids.map(()=>'?').join(',')})`).run(...receiptUuids);
}
function applyRemoteChanges(changes={}) {
  const currentBranch=h.getCurrentBranch();
  const currentBranchUuid=currentBranch?.uuid||null;
  const branchOwnedEntities = ['tables','inventory','sales','customers','suppliers','purchase_orders','returns','bundles','customer_ledger','payments','cash_movements','shifts','inventory_movements','supplier_ledger','store_credit_ledger','tax_profiles','payroll_employees','payroll_months','payroll_employee_months','payroll_transactions','payroll_advances','payroll_advance_installments','payroll_advance_payments','payroll_advance_payment_allocations','payroll_payments','payroll_final_settlements'];
  const transferEntities = ['inventory_transfers','inventory_transfer_receipts'];
  const own=(rows, entity)=> (rows||[]).filter(r=>{
    if (transferEntities.includes(entity)) {
      return !!r?.source_branch_uuid && !!r?.destination_branch_uuid && (r.source_branch_uuid===currentBranchUuid || r.destination_branch_uuid===currentBranchUuid);
    }
    if (branchOwnedEntities.includes(entity)) {
      if (!r?.branch_uuid) throw new Error(`رفضت المزامنة: ${entity} يحتوي سجلاً بلا branch_uuid.`);
      if (r.branch_uuid !== currentBranchUuid) throw new Error('رفضت المزامنة سجلات تخص فرعاً آخر.');
      return true;
    }
    return !r?.branch_uuid || r.branch_uuid===currentBranchUuid;
  });
  const foreign=(rows)=>(rows||[]).filter(r=>r?.branch_uuid&&r.branch_uuid!==currentBranchUuid).length;
  if(
    foreign(changes.tables)||foreign(changes.inventory)||foreign(changes.sales)||foreign(changes.customers)||
    foreign(changes.suppliers)||foreign(changes.purchase_orders)||foreign(changes.returns)||foreign(changes.bundles)||
    foreign(changes.customer_ledger)||foreign(changes.payments)||foreign(changes.cash_movements)||foreign(changes.shifts)||
    foreign(changes.inventory_movements)||foreign(changes.supplier_ledger)||foreign(changes.store_credit_ledger)||foreign(changes.tax_profiles)||foreign(changes.payroll_employees)||foreign(changes.payroll_months)||foreign(changes.payroll_employee_months)||foreign(changes.payroll_transactions)||foreign(changes.payroll_advances)||foreign(changes.payroll_advance_installments)||foreign(changes.payroll_advance_payments)||foreign(changes.payroll_advance_payment_allocations)||foreign(changes.payroll_payments)||foreign(changes.payroll_final_settlements)
  ) throw new Error('رفضت المزامنة سجلات تخص فرعاً آخر.');

  const findOrCreateBranch=(uuidValue,name='فرع مُزامَن')=>{
    if(!uuidValue)return currentBranch.id;
    const found=h.db.prepare('SELECT id FROM branches WHERE uuid=?').get(uuidValue);
    if(found)return found.id;
    return h.db.prepare('INSERT INTO branches (uuid,name,business_type,is_current) VALUES (?,?,?,0)')
      .run(uuidValue,name,'general').lastInsertRowid;
  };

  const tx=h.db.transaction(()=>{
    // 1) tax profiles first: products/sale items reference them by UUID.
    for(const tp of own(changes.tax_profiles||[], 'tax_profiles')){
      const branchId=findOrCreateBranch(tp.branch_uuid);
      if(branchId!==currentBranch.id) continue;
      h.db.prepare(`
        INSERT INTO tax_profiles(uuid,branch_id,code,name,rate,tax_category,country_code,is_inclusive,is_active,updated_at,synced)
        VALUES(@uuid,@branchId,@code,@name,@rate,@tax_category,@country_code,@is_inclusive,@is_active,@updated_at,1)
        ON CONFLICT(uuid) DO UPDATE SET
          code=excluded.code,name=excluded.name,rate=excluded.rate,tax_category=excluded.tax_category,
          country_code=excluded.country_code,is_inclusive=excluded.is_inclusive,is_active=excluded.is_active,
          updated_at=excluded.updated_at,synced=1`).run({...tp,branchId,updated_at:tp.updated_at||new Date().toISOString()});
    }

    // 2) categories, two-pass so parent hierarchy is preserved even when order differs.
    for(const c of changes.categories||[]){
      h.db.prepare(`
        INSERT INTO categories(uuid,name,parent_id,updated_at,synced)
        VALUES(@uuid,@name,NULL,@updated_at,1)
        ON CONFLICT(uuid) DO UPDATE SET name=excluded.name,updated_at=excluded.updated_at,synced=1`)
        .run({...c,updated_at:c.updated_at||new Date().toISOString()});
    }
    for(const c of changes.categories||[]){
      const parentId=c.parent_uuid?h.db.prepare('SELECT id FROM categories WHERE uuid=?').get(c.parent_uuid)?.id||null:null;
      h.db.prepare('UPDATE categories SET parent_id=?,synced=1 WHERE uuid=?').run(parentId,c.uuid);
    }

    // Payroll branch-owned records: resolve UUID relationships locally before insert/upsert.
    for(const pe of own(changes.payroll_employees||[], 'payroll_employees')) h.db.prepare(`INSERT INTO payroll_employees(uuid,branch_id,full_name,job_title,pay_type,pay_rate,pay_rate_minor,is_active,legacy_user_id,terminated_at,termination_reason,national_id,hire_date,phone,department,iban,country_code,payroll_notes,created_at,updated_at,synced) VALUES(@uuid,@branchId,@full_name,@job_title,@pay_type,@pay_rate,@pay_rate_minor,@is_active,NULL,@terminated_at,@termination_reason,@national_id,@hire_date,@phone,@department,@iban,@country_code,@payroll_notes,@created_at,@updated_at,1) ON CONFLICT(uuid) DO UPDATE SET full_name=excluded.full_name,job_title=excluded.job_title,pay_type=excluded.pay_type,pay_rate=excluded.pay_rate,pay_rate_minor=excluded.pay_rate_minor,is_active=excluded.is_active,terminated_at=excluded.terminated_at,termination_reason=excluded.termination_reason,national_id=excluded.national_id,hire_date=excluded.hire_date,phone=excluded.phone,department=excluded.department,iban=excluded.iban,country_code=excluded.country_code,payroll_notes=excluded.payroll_notes,updated_at=excluded.updated_at,synced=1`).run({...pe,branchId:currentBranch.id});
    for(const pm of own(changes.payroll_months||[], 'payroll_months')) h.db.prepare(`INSERT INTO payroll_months(uuid,branch_id,month_key,status,closed_at,closed_by,created_at,synced) VALUES(@uuid,@branchId,@month_key,@status,@closed_at,NULL,@created_at,1) ON CONFLICT(uuid) DO UPDATE SET month_key=excluded.month_key,status=excluded.status,closed_at=excluded.closed_at,synced=1`).run({...pm,branchId:currentBranch.id});
    for(const pem of own(changes.payroll_employee_months||[], 'payroll_employee_months')) { const monthId=h.db.prepare('SELECT id FROM payroll_months WHERE uuid=?').get(pem.month_uuid)?.id; const employeeId=h.db.prepare('SELECT id FROM payroll_employees WHERE uuid=?').get(pem.employee_uuid)?.id; if(!monthId||!employeeId) continue; h.db.prepare(`INSERT INTO payroll_employee_months(month_id,employee_id,pay_type,pay_rate,base_amount,base_amount_minor,regular_hours,absence_days,absence_deduction,bonus_total,deduction_total,advance_total,overtime_total,net_salary,net_salary_minor,start_date,debt_carry,debt_carry_minor,created_at,updated_at,synced) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(month_id,employee_id) DO UPDATE SET pay_type=excluded.pay_type,pay_rate=excluded.pay_rate,base_amount=excluded.base_amount,base_amount_minor=excluded.base_amount_minor,regular_hours=excluded.regular_hours,absence_days=excluded.absence_days,absence_deduction=excluded.absence_deduction,bonus_total=excluded.bonus_total,deduction_total=excluded.deduction_total,advance_total=excluded.advance_total,overtime_total=excluded.overtime_total,net_salary=excluded.net_salary,net_salary_minor=excluded.net_salary_minor,start_date=excluded.start_date,debt_carry=excluded.debt_carry,debt_carry_minor=excluded.debt_carry_minor,updated_at=excluded.updated_at,synced=1`).run(monthId,employeeId,pem.pay_type,pem.pay_rate,pem.base_amount,pem.base_amount_minor,pem.regular_hours,pem.absence_days,pem.absence_deduction,pem.bonus_total,pem.deduction_total,pem.advance_total,pem.overtime_total,pem.net_salary,pem.net_salary_minor,pem.start_date,pem.debt_carry||0,pem.debt_carry_minor||0,pem.created_at,pem.updated_at); }
    for(const pt of own(changes.payroll_transactions||[], 'payroll_transactions')) { const monthId=h.db.prepare('SELECT id FROM payroll_months WHERE uuid=?').get(pt.month_uuid)?.id; const employeeId=h.db.prepare('SELECT id FROM payroll_employees WHERE uuid=?').get(pt.employee_uuid)?.id; if(!monthId||!employeeId) continue; h.db.prepare(`INSERT INTO payroll_transactions(uuid,branch_id,month_id,employee_id,type,amount,amount_minor,quantity,event_date,reason,created_by,cash_movement_id,overtime_multiplier,overtime_hours,created_at,synced) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1) ON CONFLICT(uuid) DO UPDATE SET type=excluded.type,amount=excluded.amount,amount_minor=excluded.amount_minor,quantity=excluded.quantity,event_date=excluded.event_date,reason=excluded.reason,overtime_multiplier=excluded.overtime_multiplier,overtime_hours=excluded.overtime_hours,synced=1`).run(pt.uuid,currentBranch.id,monthId,employeeId,pt.type,pt.amount,pt.amount_minor||0,pt.quantity,pt.event_date,pt.reason,null,null,pt.overtime_multiplier||1.5,pt.overtime_hours||0,pt.created_at); }
    for(const pa of own(changes.payroll_advances||[], 'payroll_advances')) { const employeeId=h.db.prepare('SELECT id FROM payroll_employees WHERE uuid=?').get(pa.employee_uuid)?.id; if(!employeeId) continue; h.db.prepare(`INSERT INTO payroll_advances(uuid,branch_id,employee_id,principal,principal_minor,installment_count,installment_amount,installment_amount_minor,first_deduction_month,reason,cash_movement_id,created_by,status,created_at,updated_at,synced) VALUES(@uuid,@branchId,?,?,?,?,?,?,?,?,?,?,@status,@created_at,@updated_at,1) ON CONFLICT(uuid) DO UPDATE SET employee_id=excluded.employee_id,principal=excluded.principal,principal_minor=excluded.principal_minor,installment_count=excluded.installment_count,installment_amount=excluded.installment_amount,installment_amount_minor=excluded.installment_amount_minor,first_deduction_month=excluded.first_deduction_month,reason=excluded.reason,status=excluded.status,updated_at=excluded.updated_at,synced=1`).run({...pa,branchId:currentBranch.id}); }
    for(const pi of own(changes.payroll_advance_installments||[], 'payroll_advance_installments')) { const advanceId=h.db.prepare('SELECT id FROM payroll_advances WHERE uuid=?').get(pi.advance_uuid)?.id; if(!advanceId) continue; h.db.prepare(`INSERT INTO payroll_advance_installments(advance_id,month_key,installment_no,amount,amount_minor,created_at,synced) VALUES(?,?,?,?,?,?,1) ON CONFLICT(advance_id,installment_no) DO UPDATE SET month_key=excluded.month_key,amount=excluded.amount,amount_minor=excluded.amount_minor,synced=1`).run(advanceId,pi.month_key,pi.installment_no,pi.amount,pi.amount_minor||0,pi.created_at); }
    for(const pp of own(changes.payroll_advance_payments||[], 'payroll_advance_payments')) { const advanceId=h.db.prepare('SELECT id FROM payroll_advances WHERE uuid=?').get(pp.advance_uuid)?.id; if(!advanceId) continue; h.db.prepare(`INSERT INTO payroll_advance_payments(uuid,branch_id,advance_id,payment_type,amount,amount_minor,payment_date,method,reference,notes,cash_movement_id,created_by,voided_at,void_reason,created_at,synced) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1) ON CONFLICT(uuid) DO UPDATE SET advance_id=excluded.advance_id,amount=excluded.amount,amount_minor=excluded.amount_minor,payment_date=excluded.payment_date,method=excluded.method,reference=excluded.reference,notes=excluded.notes,voided_at=excluded.voided_at,void_reason=excluded.void_reason,synced=1`).run(pp.uuid,currentBranch.id,advanceId,pp.payment_type,pp.amount,pp.amount_minor,pp.payment_date,pp.method,pp.reference,pp.notes,null,null,pp.voided_at,pp.void_reason,pp.created_at); }
    for(const al of own(changes.payroll_advance_payment_allocations||[], 'payroll_advance_payment_allocations')) { const paymentId=h.db.prepare('SELECT id FROM payroll_advance_payments WHERE uuid=?').get(al.payment_uuid)?.id; const installmentId=h.db.prepare('SELECT i.id FROM payroll_advance_installments i JOIN payroll_advances a ON a.id=i.advance_id WHERE i.month_key=? AND a.uuid=?').get(al.month_key,al.advance_uuid)?.id; if(!paymentId||!installmentId) continue; h.db.prepare(`INSERT INTO payroll_advance_payment_allocations(payment_id,installment_id,amount,amount_minor,created_at,synced) VALUES(?,?,?,?,?,1) ON CONFLICT(payment_id,installment_id) DO UPDATE SET amount=excluded.amount,amount_minor=excluded.amount_minor,synced=1`).run(paymentId,installmentId,al.amount,al.amount_minor,al.created_at); }
    for(const pp of own(changes.payroll_payments||[], 'payroll_payments')) { const monthId=h.db.prepare('SELECT id FROM payroll_months WHERE uuid=?').get(pp.month_uuid)?.id; const employeeId=h.db.prepare('SELECT id FROM payroll_employees WHERE uuid=?').get(pp.employee_uuid)?.id; if(!monthId||!employeeId) continue; h.db.prepare(`INSERT INTO payroll_payments(uuid,branch_id,month_id,employee_id,amount,amount_minor,method,payment_date,reference,notes,created_by,cash_movement_id,created_at,synced) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,1) ON CONFLICT(uuid) DO UPDATE SET amount=excluded.amount,amount_minor=excluded.amount_minor,method=excluded.method,payment_date=excluded.payment_date,reference=excluded.reference,notes=excluded.notes,synced=1`).run(pp.uuid,currentBranch.id,monthId,employeeId,pp.amount,pp.amount_minor||0,pp.method,pp.payment_date,pp.reference,pp.notes,null,null,pp.created_at); }
    for(const fsr of own(changes.payroll_final_settlements||[], 'payroll_final_settlements')) { const monthId=h.db.prepare('SELECT id FROM payroll_months WHERE uuid=?').get(fsr.month_uuid)?.id; const employeeId=h.db.prepare('SELECT id FROM payroll_employees WHERE uuid=?').get(fsr.employee_uuid)?.id; if(!monthId||!employeeId) continue; h.db.prepare(`INSERT INTO payroll_final_settlements(uuid,branch_id,employee_id,month_id,settlement_date,gross_earned,deductions,advance_balance,additional_compensation,net_due,paid_amount,gross_earned_minor,deductions_minor,advance_balance_minor,additional_compensation_minor,net_due_minor,paid_amount_minor,method,cash_movement_id,notes,created_by,status,voided_at,void_reason,created_at,updated_at,synced) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1) ON CONFLICT(uuid) DO UPDATE SET settlement_date=excluded.settlement_date,net_due=excluded.net_due,net_due_minor=excluded.net_due_minor,paid_amount=excluded.paid_amount,paid_amount_minor=excluded.paid_amount_minor,status=excluded.status,voided_at=excluded.voided_at,void_reason=excluded.void_reason,updated_at=excluded.updated_at,synced=1`).run(fsr.uuid,currentBranch.id,employeeId,monthId,fsr.settlement_date,fsr.gross_earned,fsr.deductions,fsr.advance_balance,fsr.additional_compensation,fsr.net_due,fsr.paid_amount,fsr.gross_earned_minor,fsr.deductions_minor,fsr.advance_balance_minor,fsr.additional_compensation_minor,fsr.net_due_minor,fsr.paid_amount_minor,fsr.method,null,fsr.notes,null,fsr.status,fsr.voided_at,fsr.void_reason,fsr.created_at,fsr.updated_at); }

    // 3) products first, then parent-product references.
    for(const prod of changes.products||[]){
      const branchId=currentBranch.id;
      const categoryId=prod.category_uuid?h.db.prepare('SELECT id FROM categories WHERE uuid=?').get(prod.category_uuid)?.id||null:null;
      const taxProfileId=prod.tax_profile_uuid?h.db.prepare('SELECT id FROM tax_profiles WHERE uuid=? AND branch_id=?').get(prod.tax_profile_uuid,branchId)?.id||null:null;
      h.db.prepare(`
        INSERT INTO products(
          uuid,sku,barcode,name,category_id,price,cost,tax_rate,tax_profile_id,unit,track_inventory,is_active,
          image_path,variant_size,variant_color,parent_product_id,is_recipe,is_weighted,plu_code,updated_at,synced
        ) VALUES(
          @uuid,@sku,@barcode,@name,@categoryId,@price,@cost,@tax_rate,@taxProfileId,@unit,@track_inventory,@is_active,
          @image_path,@variant_size,@variant_color,NULL,@is_recipe,@is_weighted,@plu_code,@updated_at,1
        )
        ON CONFLICT(uuid) DO UPDATE SET
          sku=excluded.sku,barcode=excluded.barcode,name=excluded.name,category_id=excluded.category_id,price=excluded.price,
          cost=excluded.cost,tax_rate=excluded.tax_rate,tax_profile_id=excluded.tax_profile_id,unit=excluded.unit,
          track_inventory=excluded.track_inventory,is_active=excluded.is_active,image_path=excluded.image_path,
          variant_size=excluded.variant_size,variant_color=excluded.variant_color,is_recipe=excluded.is_recipe,
          is_weighted=excluded.is_weighted,plu_code=excluded.plu_code,updated_at=excluded.updated_at,synced=1`)
        .run({...prod,categoryId,taxProfileId,updated_at:prod.updated_at||new Date().toISOString()});
    }
    for(const prod of changes.products||[]){
      const parentProductId=prod.parent_product_uuid?h.db.prepare('SELECT id FROM products WHERE uuid=?').get(prod.parent_product_uuid)?.id||null:null;
      h.db.prepare('UPDATE products SET parent_product_id=?,synced=1 WHERE uuid=?').run(parentProductId,prod.uuid);
    }

    // 4) branch-owned masters before transactional documents.
    for(const t of own(changes.tables||[], 'tables')){
      const branchId=findOrCreateBranch(t.branch_uuid);
      if(branchId!==currentBranch.id) continue;
      h.db.prepare(`
        INSERT INTO restaurant_tables(uuid,branch_id,name,seats,status,updated_at,synced)
        VALUES(@uuid,@branchId,@name,@seats,@status,@updated_at,1)
        ON CONFLICT(uuid) DO UPDATE SET name=excluded.name,seats=excluded.seats,status=excluded.status,
          updated_at=excluded.updated_at,synced=1`).run({...t,branchId,updated_at:t.updated_at||new Date().toISOString()});
    }
    for(const c of own(changes.customers||[], 'customers')){
      const branchId=findOrCreateBranch(c.branch_uuid);
      if(branchId!==currentBranch.id) continue;
      h.db.prepare(`
        INSERT INTO customers(uuid,branch_id,name,phone,loyalty_points,balance,store_credit_balance,updated_at,synced)
        VALUES(@uuid,@branchId,@name,@phone,0,@balance,0,@updated_at,1)
        ON CONFLICT(uuid) DO UPDATE SET name=excluded.name,phone=excluded.phone,
          balance=excluded.balance,updated_at=excluded.updated_at,synced=1`)
        .run({...c,branchId,balance:Number(c.balance||0),updated_at:c.updated_at||new Date().toISOString()});
    }
    for(const sup of own(changes.suppliers||[], 'suppliers')){
      const branchId=findOrCreateBranch(sup.branch_uuid);
      if(branchId!==currentBranch.id) continue;
      h.db.prepare(`
        INSERT INTO suppliers(uuid,branch_id,name,phone,address,notes,balance,updated_at,synced)
        VALUES(@uuid,@branchId,@name,@phone,@address,@notes,@balance,@updated_at,1)
        ON CONFLICT(uuid) DO UPDATE SET name=excluded.name,phone=excluded.phone,address=excluded.address,notes=excluded.notes,
          balance=excluded.balance,updated_at=excluded.updated_at,synced=1`)
        .run({...sup,branchId,updated_at:sup.updated_at||new Date().toISOString()});
    }
    for(const sh of own(changes.shifts||[], 'shifts')){
      const branchId=findOrCreateBranch(sh.branch_uuid);
      if(branchId!==currentBranch.id) continue;
      const openedBy=sh.opened_by_username?h.db.prepare('SELECT id FROM users WHERE username=? AND branch_id=?').get(sh.opened_by_username,branchId)?.id:null;
      const closedBy=sh.closed_by_username?h.db.prepare('SELECT id FROM users WHERE username=? AND branch_id=?').get(sh.closed_by_username,branchId)?.id:null;
      h.db.prepare(`
        INSERT INTO shifts(uuid,branch_id,opened_by,closed_by,opening_amount,expected_cash,actual_cash,cash_difference,status,opened_at,closed_at,notes,synced)
        VALUES(@uuid,@branchId,@openedBy,@closedBy,@opening_amount,@expected_cash,@actual_cash,@cash_difference,@status,@opened_at,@closed_at,@notes,1)
        ON CONFLICT(uuid) DO UPDATE SET closed_by=excluded.closed_by,expected_cash=excluded.expected_cash,
          actual_cash=excluded.actual_cash,cash_difference=excluded.cash_difference,status=excluded.status,
          closed_at=excluded.closed_at,notes=excluded.notes,synced=1`)
        .run({...sh,branchId,openedBy,closedBy,opened_at:sh.opened_at||new Date().toISOString()});
    }

    // 5) purchase orders before supplier ledger so foreign keys can resolve.
    for(const po of own(changes.purchase_orders||[], 'purchase_orders')){
      const branchId=findOrCreateBranch(po.branch_uuid);
      if(branchId!==currentBranch.id) continue;
      const supplierId=po.supplier_uuid?h.db.prepare('SELECT id FROM suppliers WHERE uuid=? AND branch_id=?').get(po.supplier_uuid,branchId)?.id:null;
      if(!supplierId) continue;
      h.db.prepare(`
        INSERT INTO purchase_orders(uuid,branch_id,supplier_id,status,total,paid_amount,payment_method,received_at,notes,created_at,updated_at,invoice_type,expense_category_name,invoice_date,reference_number,synced)
        VALUES(@uuid,@branchId,@supplierId,@status,@total,@paid_amount,@payment_method,@received_at,@notes,@created_at,@updated_at,@invoice_type,@expense_category_name,@invoice_date,@reference_number,1)
        ON CONFLICT(uuid) DO UPDATE SET status=excluded.status,total=excluded.total,paid_amount=excluded.paid_amount,payment_method=excluded.payment_method,
          received_at=excluded.received_at,notes=excluded.notes,updated_at=excluded.updated_at,invoice_type=excluded.invoice_type,expense_category_name=excluded.expense_category_name,
          invoice_date=excluded.invoice_date,reference_number=excluded.reference_number,synced=1`)
        .run({...po,branchId,supplierId,payment_method:po.payment_method||'credit',created_at:po.created_at||new Date().toISOString(),updated_at:po.updated_at||new Date().toISOString(),
          invoice_type:po.invoice_type||'goods',expense_category_name:po.expense_category_name||null,invoice_date:po.invoice_date||null,reference_number:po.reference_number||null});
      const localPo=h.db.prepare('SELECT id FROM purchase_orders WHERE uuid=?').get(po.uuid);
      if(!localPo) continue;
      const hasItems=h.db.prepare('SELECT 1 FROM purchase_order_items WHERE purchase_order_id=? LIMIT 1').get(localPo.id);
      if(!hasItems){
        const ins=h.db.prepare('INSERT INTO purchase_order_items(purchase_order_id,product_id,quantity,unit_cost) VALUES(?,?,?,?)');
        for(const item of po.items||[]){
          const productId=h.db.prepare('SELECT id FROM products WHERE uuid=?').get(item.product_uuid)?.id;
          if(productId)ins.run(localPo.id,productId,item.quantity,item.unit_cost);
        }
      }
    }

    // 6) sales before returns/payments/ledgers so all references are resolvable.
    for(const sale of own(changes.sales||[], 'sales')){
      const branchId=findOrCreateBranch(sale.branch_uuid);
      if(branchId!==currentBranch.id) continue;
      const customerId=sale.customer_uuid?h.db.prepare('SELECT id FROM customers WHERE uuid=? AND branch_id=?').get(sale.customer_uuid,branchId)?.id||null:null;
      const userId=sale.user_username?h.db.prepare('SELECT id FROM users WHERE username=? AND branch_id=?').get(sale.user_username,branchId)?.id||null:null;
      const shiftId=sale.shift_uuid?h.db.prepare('SELECT id FROM shifts WHERE uuid=? AND branch_id=?').get(sale.shift_uuid,branchId)?.id||null:null;
      const tableId=sale.table_uuid?h.db.prepare('SELECT id FROM restaurant_tables WHERE uuid=? AND branch_id=?').get(sale.table_uuid,branchId)?.id||null:null;
      h.db.prepare(`
        INSERT INTO sales(
          uuid,branch_id,user_id,customer_id,table_id,shift_id,subtotal,tax_total,discount_total,discount_type,discount_value,
          discount_approved_by,bundle_discount_total,grand_total,payment_method,cash_amount,card_amount,change_due,due_amount,
          exchange_rate,invoice_number,payment_reference,payment_provider,payment_currency,client_request_id,loyalty_points_awarded,
          loyalty_points_reversed,status,order_type,delivery_fee,delivery_person,created_at,synced
        ) VALUES(
          @uuid,@branchId,@userId,@customerId,@tableId,@shiftId,@subtotal,@tax_total,@discount_total,@discount_type,@discount_value,
          NULL,@bundle_discount_total,@grand_total,@payment_method,@cash_amount,@card_amount,@change_due,@due_amount,
          @exchange_rate,@invoice_number,@payment_reference,@payment_provider,@payment_currency,@client_request_id,@loyalty_points_awarded,
          @loyalty_points_reversed,@status,@order_type,@delivery_fee,@delivery_person,@created_at,1
        ) ON CONFLICT(uuid) DO NOTHING`)
        .run({
          ...sale,branchId,userId,customerId,tableId,shiftId,
          loyalty_points_awarded:Number(sale.loyalty_points_awarded||0),
          loyalty_points_reversed:Number(sale.loyalty_points_reversed||0),
          created_at:sale.created_at||new Date().toISOString()
        });
      const localSale=h.db.prepare('SELECT id FROM sales WHERE uuid=? AND branch_id=?').get(sale.uuid,branchId);
      if(!localSale) continue;
      // لقطة العروض المطبَّقة (كلمة "عرض" على الطباعة): idempotent بمفتاح uuid.
      for(const b of Array.isArray(sale.bundles_applied)?sale.bundles_applied:[]){
        if(!b||!b.uuid) continue;
        const localBundleId=b.bundle_uuid?h.db.prepare('SELECT id FROM bundles WHERE uuid=? AND branch_id=?').get(b.bundle_uuid,branchId)?.id||null:null;
        h.db.prepare(`INSERT INTO sale_bundles(uuid,sale_id,bundle_id,bundle_uuid,bundle_name,applications,discount,discount_minor,items_json)
          VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(uuid) DO NOTHING`).run(String(b.uuid),localSale.id,localBundleId,b.bundle_uuid||null,String(b.bundle_name||''),Math.max(1,Number(b.applications||1)),Number(b.discount||0),Number(b.discount_minor||0),String(b.items_json||'[]'));
      }
      const hasItems=h.db.prepare('SELECT 1 FROM sale_items WHERE sale_id=? LIMIT 1').get(localSale.id);
      if(hasItems) continue;
      const ins=h.db.prepare('INSERT INTO sale_items(uuid,sale_id,product_id,quantity,unit_price,tax_rate,tax_profile_id,tax_inclusive,discount,line_total,notes,cost_at_sale) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)');
      for(const item of sale.items||[]){
        const productId=h.db.prepare('SELECT id FROM products WHERE uuid=?').get(item.product_uuid)?.id;
        const taxProfileId=item.tax_profile_uuid?h.db.prepare('SELECT id FROM tax_profiles WHERE uuid=? AND branch_id=?').get(item.tax_profile_uuid,branchId)?.id||null:null;
        if(productId)ins.run(item.uuid||h.uuid(),localSale.id,productId,item.quantity,item.unit_price,item.tax_rate||0,taxProfileId,item.tax_inclusive?1:0,item.discount||0,item.line_total,item.notes||null,Number(item.cost_at_sale||0));
      }
    }

    // 7) returns before payment_transactions because return payment rows reference return_id.
    for(const r of own(changes.returns||[], 'returns')){
      const branchId=findOrCreateBranch(r.branch_uuid);
      if(branchId!==currentBranch.id) continue;
      const saleId=r.sale_uuid?h.db.prepare('SELECT id FROM sales WHERE uuid=? AND branch_id=?').get(r.sale_uuid,branchId)?.id:null;
      if(!saleId) continue;
      const userId=r.user_username?h.db.prepare('SELECT id FROM users WHERE username=? AND branch_id=?').get(r.user_username,branchId)?.id||null:null;
      const shiftId=r.shift_uuid?h.db.prepare('SELECT id FROM shifts WHERE uuid=? AND branch_id=?').get(r.shift_uuid,branchId)?.id||null:null;
      const inserted=h.db.prepare(`
        INSERT INTO returns(uuid,branch_id,sale_id,user_id,shift_id,reason,refund_method,total_refunded,client_request_id,created_at,synced)
        VALUES(@uuid,@branchId,@saleId,@userId,@shiftId,@reason,@refund_method,@total_refunded,@client_request_id,@created_at,1)
        ON CONFLICT(uuid) DO NOTHING`).run({...r,branchId,saleId,userId,shiftId,created_at:r.created_at||new Date().toISOString()});
      const localReturn=h.db.prepare('SELECT id FROM returns WHERE uuid=? AND branch_id=?').get(r.uuid,branchId);
      if(!localReturn) continue;
      if(!inserted.changes) continue; // idempotent: no duplicate financial side effects.
      const ins=h.db.prepare('INSERT INTO return_items(return_id,sale_item_id,product_id,quantity,refund_amount) VALUES(?,?,?,?,?)');
      for(const item of r.items||[]){
        const productId=h.db.prepare('SELECT id FROM products WHERE uuid=?').get(item.product_uuid)?.id;
        const localSaleItemId=item.sale_item_uuid
          ?h.db.prepare('SELECT id FROM sale_items WHERE uuid=? AND sale_id=?').get(item.sale_item_uuid,saleId)?.id
          :(productId?h.db.prepare('SELECT id FROM sale_items WHERE sale_id=? AND product_id=? ORDER BY id LIMIT 1').get(saleId,productId)?.id:null);
        if(productId&&localSaleItemId)ins.run(localReturn.id,localSaleItemId,productId,item.quantity,item.refund_amount);
      }
      const saleRow=h.db.prepare('SELECT id,customer_id,grand_total,loyalty_points_awarded,loyalty_points_reversed FROM sales WHERE id=? AND branch_id=?').get(saleId,branchId);
      if(saleRow?.customer_id){
        const saleAward=Number(saleRow.loyalty_points_awarded||0);
        const currentReversed=Number(saleRow.loyalty_points_reversed||0);
        const prevRefunded=Number(h.db.prepare(`SELECT COALESCE(SUM(total_refunded),0) AS total FROM returns WHERE sale_id=? AND id<>?`).get(saleId,localReturn.id).total||0);
        const saleGrand=Math.max(Number(saleRow.grand_total||0),0.01);
        const ratio=Math.min(1,(prevRefunded+Number(r.total_refunded||0))/saleGrand);
        const target=Math.min(saleAward,Math.floor(saleAward*ratio+1e-9));
        const reverseNow=Math.max(0,target-currentReversed);
        if(reverseNow>0){
          h.db.prepare('UPDATE customers SET loyalty_points=MAX(0,loyalty_points-?),updated_at=? WHERE id=? AND branch_id=?').run(reverseNow,r.created_at||new Date().toISOString(),saleRow.customer_id,branchId);
          h.db.prepare('UPDATE sales SET loyalty_points_reversed=? WHERE id=? AND branch_id=?').run(currentReversed+reverseNow,saleId,branchId);
        }
      }
      const pending=h.db.prepare(`SELECT COALESCE(SUM(ri.quantity),0) AS returned FROM return_items ri WHERE ri.return_id IN (SELECT id FROM returns WHERE sale_id=?)`).get(saleId).returned;
      const sold=h.db.prepare('SELECT COALESCE(SUM(quantity),0) AS sold FROM sale_items WHERE sale_id=?').get(saleId).sold;
      if(Number(pending)>=Number(sold)&&Number(sold)>0) h.db.prepare('UPDATE sales SET status=\'refunded\',synced=1 WHERE id=? AND branch_id=?').run(saleId,branchId);
      else h.db.prepare('UPDATE sales SET status=\'partially_refunded\',synced=1 WHERE id=? AND branch_id=? AND status=\'completed\'').run(saleId,branchId);
    }

    // 8) store-credit ledger before payments: events are authoritative; customer snapshots never overwrite the balance.
    for(const l of own(changes.store_credit_ledger||[], 'store_credit_ledger')){
      const branchId=findOrCreateBranch(l.branch_uuid); if(branchId!==currentBranch.id) continue;
      const customerId=l.customer_uuid?h.db.prepare('SELECT id FROM customers WHERE uuid=? AND branch_id=?').get(l.customer_uuid,branchId)?.id:null;
      if(!customerId) continue;
      const saleId=l.sale_uuid?h.db.prepare('SELECT id FROM sales WHERE uuid=? AND branch_id=?').get(l.sale_uuid,branchId)?.id:null;
      const returnId=l.return_uuid?h.db.prepare('SELECT id FROM returns WHERE uuid=? AND branch_id=?').get(l.return_uuid,branchId)?.id:null;
      const createdBy=l.created_by_username?h.db.prepare('SELECT id FROM users WHERE username=? AND branch_id=?').get(l.created_by_username,branchId)?.id:null;
      const inserted=h.db.prepare(`INSERT INTO store_credit_ledger(uuid,branch_id,customer_id,sale_id,return_id,entry_type,amount,created_by,created_at,synced) VALUES(@uuid,@branchId,@customerId,@saleId,@returnId,@entry_type,@amount,@createdBy,@created_at,1) ON CONFLICT(uuid) DO NOTHING`).run({...l,branchId,customerId,saleId,returnId,createdBy,created_at:l.created_at||new Date().toISOString()});
      if(inserted.changes) h.recalcStoreCreditBalance(customerId,branchId,false);
    }

    // 9) payments/cash after their parents exist.
    for(const pt of own(changes.payments||[], 'payments')){
      const branchId=findOrCreateBranch(pt.branch_uuid); if(branchId!==currentBranch.id)continue;
      const saleId=pt.sale_uuid?h.db.prepare('SELECT id FROM sales WHERE uuid=? AND branch_id=?').get(pt.sale_uuid,branchId)?.id:null;
      const returnId=pt.return_uuid?h.db.prepare('SELECT id FROM returns WHERE uuid=? AND branch_id=?').get(pt.return_uuid,branchId)?.id:null;
      const shiftId=pt.shift_uuid?h.db.prepare('SELECT id FROM shifts WHERE uuid=? AND branch_id=?').get(pt.shift_uuid,branchId)?.id:null;
      const createdBy=pt.created_by_username?h.db.prepare('SELECT id FROM users WHERE username=? AND branch_id=?').get(pt.created_by_username,branchId)?.id:null;
      h.db.prepare(`
        INSERT INTO payment_transactions(uuid,branch_id,sale_id,return_id,shift_id,method,currency_code,amount,exchange_rate,provider,provider_reference,external_id,masked_descriptor,created_by,created_at,synced)
        VALUES(@uuid,@branchId,@saleId,@returnId,@shiftId,@method,@currency_code,@amount,@exchange_rate,@provider,@provider_reference,@external_id,@masked_descriptor,@createdBy,@created_at,1)
        ON CONFLICT(uuid) DO NOTHING`).run({...pt,branchId,saleId,returnId,shiftId,createdBy,created_at:pt.created_at||new Date().toISOString()});
    }
    for(const cm of own(changes.cash_movements||[], 'cash_movements')){
      const branchId=findOrCreateBranch(cm.branch_uuid); if(branchId!==currentBranch.id)continue;
      const shiftId=cm.shift_uuid?h.db.prepare('SELECT id FROM shifts WHERE uuid=? AND branch_id=?').get(cm.shift_uuid,branchId)?.id:null; if(!shiftId)continue;
      const createdBy=cm.created_by_username?h.db.prepare('SELECT id FROM users WHERE username=? AND branch_id=?').get(cm.created_by_username,branchId)?.id:null;
      h.db.prepare(`
        INSERT INTO cash_movements(uuid,branch_id,shift_id,type,amount,reason,reference,created_by,created_at,synced)
        VALUES(@uuid,@branchId,@shiftId,@type,@amount,@reason,@reference,@createdBy,@created_at,1)
        ON CONFLICT(uuid) DO NOTHING`).run({...cm,branchId,shiftId,createdBy,created_at:cm.created_at||new Date().toISOString()});
    }

    // 9) inventory snapshot first, then movements as the authoritative delta stream.
    for(const i of own(changes.inventory||[], 'inventory')){
      const productId=h.db.prepare('SELECT id FROM products WHERE uuid=?').get(i.product_uuid)?.id;
      if(!productId)continue;
      const branchId=findOrCreateBranch(i.branch_uuid); if(branchId!==currentBranch.id)continue;
      const local=h.db.prepare('SELECT id,updated_at FROM inventory WHERE branch_id=? AND product_id=?').get(branchId,productId);
      const incomingUpdatedAt = i.updated_at || new Date().toISOString();
      if(!local){
        h.db.prepare(`INSERT INTO inventory(branch_id,product_id,quantity,unit_cost,min_quantity,updated_at,synced) VALUES(?,?,?,?,?,?,1)`).run(branchId,productId,i.quantity,Number(i.unit_cost??0),i.min_quantity,incomingUpdatedAt);
      }else{
        const localIsNewer = local.updated_at && String(local.updated_at) > String(incomingUpdatedAt);
        h.db.prepare(`UPDATE inventory SET min_quantity=?,unit_cost=CASE WHEN ? THEN unit_cost ELSE COALESCE(?,unit_cost) END,updated_at=CASE WHEN ? THEN updated_at ELSE ? END,synced=1 WHERE branch_id=? AND product_id=?`).run(i.min_quantity, localIsNewer ? 1 : 0, i.unit_cost == null ? null : Number(i.unit_cost), localIsNewer ? 1 : 0, localIsNewer ? local.updated_at : incomingUpdatedAt, branchId, productId);
      }
    }
    for(const im of own(changes.inventory_movements||[], 'inventory_movements')){
      const branchId=findOrCreateBranch(im.branch_uuid); if(branchId!==currentBranch.id)continue;
      const productId=im.product_uuid?h.db.prepare('SELECT id FROM products WHERE uuid=?').get(im.product_uuid)?.id:null;
      if(!productId)continue;
      const stamp=im.created_at||new Date().toISOString();
      const inserted=h.db.prepare(`
        INSERT INTO inventory_movements(uuid,branch_id,product_id,change_qty,reason,ref_id,notes,unit_cost_after,created_at,synced)
        VALUES(@uuid,@branchId,@productId,@change_qty,@reason,@ref_id,@notes,@unit_cost_after,@created_at,1)
        ON CONFLICT(uuid) DO NOTHING`).run({...im,branchId,productId,created_at:stamp});
      if(!inserted.changes)continue;
      const localInv=h.db.prepare('SELECT quantity,updated_at FROM inventory WHERE branch_id=? AND product_id=?').get(branchId,productId);
      if(localInv){
        const localIsNewer = localInv.updated_at && String(localInv.updated_at) > stamp;
        const unitCost = (!localIsNewer && im.unit_cost_after != null) ? Number(im.unit_cost_after) : null;
        h.db.prepare(`UPDATE inventory SET quantity=quantity+?,unit_cost=COALESCE(?,unit_cost),updated_at=CASE WHEN ? THEN updated_at ELSE ? END,synced=1 WHERE branch_id=? AND product_id=?`)
          .run(Number(im.change_qty)||0, unitCost, localIsNewer ? 1 : 0, localIsNewer ? localInv.updated_at : stamp, branchId, productId);
      }else{
        h.db.prepare(`INSERT INTO inventory(branch_id,product_id,quantity,unit_cost,min_quantity,updated_at,synced) VALUES(?,?,?,?,0,?,1)`)
          .run(branchId,productId,Number(im.change_qty)||0,Number(im.unit_cost_after||0),stamp);
      }
    }

    // 10) ledgers after their referenced sales/purchase orders exist.
    for(const l of own(changes.customer_ledger||[], 'customer_ledger')){
      if(!l.uuid)continue;
      const branchId=l.branch_uuid?findOrCreateBranch(l.branch_uuid):currentBranch.id; if(branchId!==currentBranch.id)continue;
      const customerId=l.customer_uuid?h.db.prepare('SELECT id FROM customers WHERE uuid=? AND branch_id=?').get(l.customer_uuid,branchId)?.id:null; if(!customerId)continue;
      const saleId=l.sale_uuid?h.db.prepare('SELECT id FROM sales WHERE uuid=? AND branch_id=?').get(l.sale_uuid,branchId)?.id||null:null;
      h.db.prepare(`
        INSERT INTO customer_ledger(uuid,branch_id,customer_id,sale_id,entry_type,amount,balance_after,notes,created_at,synced)
        VALUES(@uuid,@branchId,@customerId,@saleId,@entry_type,@amount,@balance_after,@notes,@created_at,1)
        ON CONFLICT(uuid) DO NOTHING`).run({...l,branchId,customerId,saleId,created_at:l.created_at||new Date().toISOString()});
    }
    for(const sl of own(changes.supplier_ledger||[], 'supplier_ledger')){
      const branchId=findOrCreateBranch(sl.branch_uuid); if(branchId!==currentBranch.id)continue;
      const supplierId=sl.supplier_uuid?h.db.prepare('SELECT id FROM suppliers WHERE uuid=? AND branch_id=?').get(sl.supplier_uuid,branchId)?.id:null;
      const poId=sl.purchase_order_uuid?h.db.prepare('SELECT id FROM purchase_orders WHERE uuid=? AND branch_id=?').get(sl.purchase_order_uuid,branchId)?.id:null;
      if(!supplierId)continue;
      h.db.prepare(`
        INSERT INTO supplier_ledger(uuid,branch_id,supplier_id,purchase_order_id,entry_type,amount,balance_after,notes,created_at,synced)
        VALUES(@uuid,@branchId,@supplierId,@poId,@entry_type,@amount,@balance_after,@notes,@created_at,1)
        ON CONFLICT(uuid) DO NOTHING`).run({...sl,supplierId,poId,created_at:sl.created_at||new Date().toISOString()});
    }

    // 11) bundles after products exist.
    for(const bu of own(changes.bundles||[], 'bundles')){
      const branchId=findOrCreateBranch(bu.branch_uuid); if(branchId!==currentBranch.id)continue;
      h.db.prepare(`
        INSERT INTO bundles(uuid,branch_id,name,discount_type,discount_value,is_active,updated_at,synced)
        VALUES(@uuid,@branchId,@name,@discount_type,@discount_value,@is_active,@updated_at,1)
        ON CONFLICT(uuid) DO UPDATE SET name=excluded.name,discount_type=excluded.discount_type,
          discount_value=excluded.discount_value,is_active=excluded.is_active,updated_at=excluded.updated_at,synced=1`)
        .run({...bu,branchId,updated_at:bu.updated_at||new Date().toISOString()});
      const localBundle=h.db.prepare('SELECT id FROM bundles WHERE uuid=?').get(bu.uuid);
      if(!localBundle)continue;
      h.db.prepare('DELETE FROM bundle_items WHERE bundle_id=?').run(localBundle.id);
      const ins=h.db.prepare('INSERT INTO bundle_items(bundle_id,product_id,quantity) VALUES(?,?,?)');
      for(const item of bu.items||[]){
        const productId=h.db.prepare('SELECT id FROM products WHERE uuid=?').get(item.product_uuid)?.id;
        if(productId)ins.run(localBundle.id,productId,item.quantity);
      }
    }

    // 12) Cross-branch inventory transfers. The transfer document is visible to both
    // endpoints, while the receipt is the only event that mutates destination stock.
    for (const t of (changes.inventory_transfers || [])) {
      if (!t?.uuid || t.source_branch_uuid !== currentBranchUuid && t.destination_branch_uuid !== currentBranchUuid) continue;
      const local = h.db.prepare('SELECT id FROM inventory_transfers WHERE uuid=? AND local_branch_id=?').get(t.uuid,currentBranch.id);
      let localTransferId = local?.id || null;
      if (!localTransferId) {
        const result = h.db.prepare(`INSERT INTO inventory_transfers(uuid,source_branch_uuid,destination_branch_uuid,local_branch_id,status,notes,created_by,shipped_at,created_at,updated_at,synced)
          VALUES(?,?,?,?,?,?,?,?,?,?,1)`).run(t.uuid,t.source_branch_uuid,t.destination_branch_uuid,currentBranch.id,t.status==='cancelled'?'cancelled':'shipped',t.notes||null,null,t.shipped_at||t.created_at||new Date().toISOString(),t.created_at||new Date().toISOString(),t.updated_at||t.created_at||new Date().toISOString());
        localTransferId=result.lastInsertRowid;
        const ins=h.db.prepare(`INSERT OR IGNORE INTO inventory_transfer_items(transfer_id,product_id,product_uuid,quantity,unit_cost) VALUES(?,?,?,?,?)`);
        for(const item of t.items||[]) {
          const productId=h.db.prepare('SELECT id FROM products WHERE uuid=?').get(item.product_uuid)?.id;
          if(productId) ins.run(localTransferId,productId,item.product_uuid,Number(item.quantity)||0,Number(item.unit_cost)||0);
        }
      } else if (t.status === 'cancelled' && !h.db.prepare('SELECT 1 FROM inventory_transfer_receipts WHERE transfer_uuid=?').get(t.uuid)) {
        h.db.prepare(`UPDATE inventory_transfers SET status='cancelled',notes=?,updated_at=?,synced=1 WHERE id=?`).run(t.notes||null,t.updated_at||new Date().toISOString(),localTransferId);
      }
    }
    for (const r of (changes.inventory_transfer_receipts || [])) {
      if (!r?.uuid || (r.destination_branch_uuid !== currentBranchUuid && r.source_branch_uuid !== currentBranchUuid)) continue;
      const localReceipt=h.db.prepare('SELECT id FROM inventory_transfer_receipts WHERE uuid=?').get(r.uuid);
      if(localReceipt) continue;
      const transfer=h.db.prepare('SELECT * FROM inventory_transfers WHERE uuid=? AND local_branch_id=?').get(r.transfer_uuid,currentBranch.id);
      if(!transfer) continue;
      const receiptId=h.db.prepare(`INSERT INTO inventory_transfer_receipts(uuid,transfer_uuid,source_branch_uuid,destination_branch_uuid,local_branch_id,received_by,notes,received_at,created_at,updated_at,synced)
        VALUES(?,?,?,?,?,?,?, ?,?,?,1)`).run(r.uuid,r.transfer_uuid,r.source_branch_uuid,r.destination_branch_uuid,currentBranch.id,null,r.notes||null,r.received_at||r.created_at||new Date().toISOString(),r.created_at||new Date().toISOString(),r.updated_at||r.created_at||new Date().toISOString()).lastInsertRowid;
      const ins=h.db.prepare('INSERT OR IGNORE INTO inventory_transfer_receipt_items(receipt_id,product_uuid,quantity_received) VALUES(?,?,?)');
      for(const item of r.items||[]) ins.run(receiptId,item.product_uuid,Number(item.quantity_received)||0);
      if(transfer.source_branch_uuid===currentBranchUuid){
        h.db.prepare(`UPDATE inventory_transfers SET status='received',updated_at=? WHERE id=?`).run(r.received_at||r.created_at||new Date().toISOString(),transfer.id);
      }
    }

    recalcAllCustomerBalancesForBranch(currentBranch.id);
  });
  tx();
  recalcCustomerLoyaltyPointsForBranch(currentBranch.id);
}
function recalcCustomerLoyaltyPointsForBranch(branchId) {
  const customers = h.db.prepare('SELECT id, loyalty_points FROM customers WHERE branch_id=?').all(branchId);
  const pointsStmt = h.db.prepare(`
    SELECT COALESCE(SUM(COALESCE(loyalty_points_awarded,0) - COALESCE(loyalty_points_reversed,0)),0) AS points
    FROM sales WHERE branch_id=? AND customer_id=?`);
  const update = h.db.prepare('UPDATE customers SET loyalty_points=?, updated_at=datetime(\'now\'), synced=1 WHERE id=? AND branch_id=?');
  for (const customer of customers) {
    const points = Math.max(0, Math.floor(Number(pointsStmt.get(branchId, customer.id)?.points || 0)));
    if (Number(customer.loyalty_points || 0) !== points) update.run(points, customer.id, branchId);
  }
}
function recalcAllCustomerBalancesForBranch(branchId) {
  const rows=h.db.prepare('SELECT id, balance FROM customers WHERE branch_id=?').all(branchId);
  for(const r of rows){
    const total=h.db.prepare('SELECT COALESCE(SUM(amount),0) AS balance FROM customer_ledger WHERE customer_id=? AND branch_id=?').get(r.id,branchId).balance;
    const next=h.roundMoney(total);
    if (Math.abs(Number(r.balance||0)-next) > 0.005) {
      h.db.prepare('UPDATE customers SET balance=?,synced=1 WHERE id=? AND branch_id=?').run(next,r.id,branchId);
    }
  }
}


  return {
    getReportExport,
    getSyncConfig,
    saveSyncConfig,
    syncPayload,
    markSynced,
    applyRemoteChanges,
    recalcCustomerLoyaltyPointsForBranch,
    recalcAllCustomerBalancesForBranch
  };
};
