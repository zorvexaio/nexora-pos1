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
   الإعدادات العامة (app_settings)
   ========================================================== */
function getGlobalProfile(){
  const row=h.db.prepare('SELECT * FROM organization_profile WHERE id=1').get();
  return row || {country_code:'TR',locale:'ar',timezone:'Europe/Istanbul',currency_code:'TRY',currency_minor_unit:2,tax_mode:'exclusive',tax_registration_number:'',fiscalization_mode:'none',fiscal_provider:''};
}
// هل يوجد أي أثر مالي حقيقي بالنظام (مبيعات، قيود محاسبية، أو معاملات دفع)؟ يُستخدم
// لمنع تغيير عملة/دقة النظام بعد بدء التشغيل الفعلي — تغييرها لاحقاً يُفسد كل الأرقام
// التاريخية المخزَّنة بالعملة/الدقة القديمة دون أي طريقة موثوقة لإعادة حسابها رجعياً.
function organizationHasFinancialHistory() {
  const salesCount = h.db.prepare('SELECT COUNT(*) AS c FROM sales').get().c;
  if (salesCount > 0) return true;
  const journalCount = h.db.prepare('SELECT COUNT(*) AS c FROM accounting_journal_entries').get().c;
  if (journalCount > 0) return true;
  const paymentsCount = h.db.prepare('SELECT COUNT(*) AS c FROM payment_transactions').get().c;
  if (paymentsCount > 0) return true;
  return false;
}

function setGlobalProfile(profile){
  const current = h.getGlobalProfile();
  const country=String(profile.countryCode||'TR').trim().toUpperCase();
  const locale=String(profile.locale||'en').trim();
  const timezone=String(profile.timezone||'UTC').trim();
  const currency=String(profile.currencyCode||'USD').trim().toUpperCase();
  const minor=Number(profile.currencyMinorUnit);
  const taxMode=String(profile.taxMode||'exclusive');
  const fiscalMode=String(profile.fiscalizationMode||'none');
  if(!/^[A-Z]{2}$/.test(country)) throw new Error('رمز الدولة يجب أن يكون ISO من حرفين.');
  if(!/^[A-Z]{3}$/.test(currency)) throw new Error('رمز العملة يجب أن يكون ISO من 3 أحرف.');
  if(![0,1,2,3].includes(minor)) throw new Error('عدد الخانات العشرية للعملة غير صالح.');
  if(!['exclusive','inclusive'].includes(taxMode)) throw new Error('وضع الضريبة غير صالح.');
  if(!['none','adapter'].includes(fiscalMode)) throw new Error('وضع الفوترة الإلكترونية غير صالح.');
  // العملة ودقتها العشرية أساس كل رقم مالي محفوظ سابقاً (مبيعات، قيود محاسبية، مدفوعات).
  // تغييرهما بعد وجود تاريخ مالي حقيقي يجعل الأرقام القديمة والجديدة غير قابلة للمقارنة
  // أو التجميع بشكل صحيح — لذلك نمنع هذا التغيير تحديداً، ونسمح بباقي الحقول كالمعتاد.
  const changingMoney = currency !== String(current.currency_code || '').toUpperCase()
    || minor !== Number(current.currency_minor_unit);
  if (changingMoney && organizationHasFinancialHistory()) {
    throw new Error('لا يمكن تغيير عملة النظام أو عدد خاناتها العشرية بعد وجود تاريخ مالي (مبيعات أو قيود محاسبية أو مدفوعات مسجّلة).');
  }
  h.db.prepare(`UPDATE organization_profile SET country_code=?,locale=?,timezone=?,currency_code=?,currency_minor_unit=?,tax_mode=?,tax_registration_number=?,fiscalization_mode=?,fiscal_provider=?,updated_at=datetime('now') WHERE id=1`).run(country,locale,timezone,currency,minor,taxMode,String(profile.taxRegistrationNumber||'').trim()||null,fiscalMode,String(profile.fiscalProvider||'').trim()||null);
  return h.getGlobalProfile();
}
function listTaxProfiles(){ const b=h.getCurrentBranch(); return h.db.prepare('SELECT * FROM tax_profiles WHERE branch_id=? ORDER BY code').all(b.id); }
function saveTaxProfile(p){
  const b=h.getCurrentBranch(); const code=String(p.code||'').trim().toUpperCase(); const name=String(p.name||'').trim(); const rate=Number(p.rate);
  if(!code||!name) throw new Error('رمز واسم الضريبة مطلوبان.');
  if(!Number.isFinite(rate)||rate<0||rate>100) throw new Error('نسبة الضريبة غير صالحة.');
  const id=Number(p.id||0);
  if(id){ const exists=h.db.prepare('SELECT id FROM tax_profiles WHERE id=? AND branch_id=?').get(id,b.id); if(!exists) throw new Error('ملف الضريبة غير موجود.');
    h.db.prepare(`UPDATE tax_profiles SET code=?,name=?,rate=?,tax_category=?,country_code=?,is_inclusive=?,is_active=?,updated_at=datetime('now'),synced=0 WHERE id=? AND branch_id=?`).run(code,name,rate,String(p.taxCategory||'').trim()||null,String(p.countryCode||h.getGlobalProfile().country_code).toUpperCase(),p.isInclusive?1:0,p.isActive===false?0:1,id,b.id);
    return h.db.prepare('SELECT * FROM tax_profiles WHERE id=?').get(id); }
  const row=h.db.prepare(`INSERT INTO tax_profiles(uuid,branch_id,code,name,rate,tax_category,country_code,is_inclusive,is_active) VALUES(?,?,?,?,?,?,?,?,?)`).run(h.uuid(),b.id,code,name,rate,String(p.taxCategory||'').trim()||null,String(p.countryCode||h.getGlobalProfile().country_code).toUpperCase(),p.isInclusive?1:0,p.isActive===false?0:1);
  return h.db.prepare('SELECT * FROM tax_profiles WHERE id=?').get(row.lastInsertRowid);
}
function listPaymentTransactions(range={}){ const b=h.getCurrentBranch(); let sql='SELECT pt.*,u.full_name user_name FROM payment_transactions pt LEFT JOIN users u ON u.id=pt.created_by WHERE pt.branch_id=?'; const args=[b.id]; if(range.from){sql+=' AND pt.created_at>=?';args.push(range.from);} if(range.to){sql+=' AND pt.created_at<=?';args.push(range.to);} return h.db.prepare(sql+' ORDER BY pt.created_at DESC LIMIT 1000').all(...args); }
function getShiftCashMovements(shiftId, viewerUserId = null, viewerRole = null){ const b=h.getCurrentBranch(); const shift=h.db.prepare('SELECT opened_by FROM shifts WHERE id=? AND branch_id=?').get(Number(shiftId), b.id); if(!shift) throw new Error('جلسة الصندوق غير موجودة.'); if(viewerUserId!=null && Number(shift.opened_by)!==Number(viewerUserId) && !['admin','manager'].includes(viewerRole)) throw new Error('لا تملك صلاحية عرض حركات جلسة موظف آخر.'); return h.db.prepare('SELECT * FROM cash_movements WHERE shift_id=? AND branch_id=? ORDER BY created_at').all(Number(shiftId),b.id); }
function addCashMovement({shiftId,type,amount,reason,reference,createdBy}){ const b=h.getCurrentBranch(); const shift=h.db.prepare('SELECT id,status,opened_by FROM shifts WHERE id=? AND branch_id=?').get(Number(shiftId),b.id); if(!shift) throw new Error('جلسة الصندوق غير موجودة.'); if(shift.status!=='open') throw new Error('جلسة الصندوق مغلقة.'); const actor=h.db.prepare('SELECT role,is_active FROM users WHERE id=? AND branch_id=?').get(Number(createdBy),b.id); if(!actor || !actor.is_active) throw new Error('المستخدم الحالي غير صالح.'); if(Number(shift.opened_by)!==Number(createdBy) && !['admin','manager'].includes(actor.role)) throw new Error('لا يمكن إضافة حركة نقد إلا لمن فتح الجلسة أو لمدير.'); if(!['cash_in','cash_out'].includes(type)) throw new Error('نوع حركة النقد غير صالح.'); const n=Number(amount); if(!Number.isFinite(n)||n<=0) throw new Error('المبلغ يجب أن يكون أكبر من صفر.'); const row=h.db.prepare(`INSERT INTO cash_movements(uuid,branch_id,shift_id,type,amount,reason,reference,created_by) VALUES(?,?,?,?,?,?,?,?)`).run(h.uuid(),b.id,Number(shiftId),type,n,String(reason||'').trim()||'غير محدد',String(reference||'').trim()||null,createdBy||null); h.logAudit({userId:createdBy||null,branchId:b.id,action:'cash_movement_added',entityType:'cash_movement',entityId:row.lastInsertRowid,details:{type,amount:n}}); return h.db.prepare('SELECT * FROM cash_movements WHERE id=?').get(row.lastInsertRowid); }



  return {
    getGlobalProfile,
    organizationHasFinancialHistory,
    setGlobalProfile,
    listTaxProfiles,
    saveTaxProfile,
    listPaymentTransactions,
    getShiftCashMovements,
    addCashMovement
  };
};
