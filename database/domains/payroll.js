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
   Payroll v2 — مستقل تماماً عن حسابات المستخدمين
   ========================================================== */
function normalizePayrollMonth(monthKey) {
  const m = String(monthKey || '').trim();
  if (!/^\d{4}-\d{2}$/.test(m)) throw new Error('الشهر غير صالح.');
  const [year, month] = m.split('-').map(Number);
  if (month < 1 || month > 12) throw new Error('الشهر غير صالح.');
  return m;
}
function daysInPayrollMonth(monthKey) { const [y,m] = normalizePayrollMonth(monthKey).split('-').map(Number); return new Date(y,m,0).getDate(); }
// يحوّل سلسلة "YYYY-MM-DD" إلى Date محلي (بدون قراءتها كـ UTC كما يفعل new Date(str)
// افتراضياً)، حتى تُقارَن بشكل صحيح مع تواريخ أخرى مبنية بنفس الطريقة (new Date(y,m,d)).
function parsePayrollDateLocal(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || '').trim());
  if (!match) return null;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}
// "اليوم" حسب المنطقة الزمنية للمؤسسة (لا حسب UTC الخاص بعملية Electron)، لنفس السبب
// الموثّق أعلى h.dateRangeParams(): لا نريد يوم العمل ينقلب عند منتصف الليل UTC.
function payrollTodayLocal() {
  const profile = h.getGlobalProfile();
  const timeZone = profile?.timezone || 'UTC';
  let str;
  try { str = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
  catch (_) { str = new Date().toISOString().slice(0, 10); }
  return parsePayrollDateLocal(str);
}
// عدد الأيام "المستحقة" فعلياً لعامل ضمن شهر الرواتب، بدءاً من تاريخ التحاقه (start_date،
// أو أول الشهر افتراضياً) وحتى اليوم الحالي (أو آخر الشهر إن كان الشهر قد انتهى فعلاً).
// هذا هو أساس احتساب الراتب تلقائياً يوماً بيوم بدل افتراض شهر كامل من أول يوم.
function daysElapsedInPayrollPeriod(monthKey, startDateValue) {
  const dim = daysInPayrollMonth(monthKey);
  const [year, month] = normalizePayrollMonth(monthKey).split('-').map(Number);
  const periodStart = new Date(year, month - 1, 1);
  const periodEnd = new Date(year, month - 1, dim);
  let start = parsePayrollDateLocal(startDateValue) || periodStart;
  if (start < periodStart) start = periodStart;
  if (start > periodEnd) return 0; // لم يلتحق العامل بعد ضمن هذا الشهر
  const today = payrollTodayLocal();
  const asOf = today < start ? null : (today > periodEnd ? periodEnd : today);
  if (!asOf) return 0;
  const msPerDay = 24 * 60 * 60 * 1000;
  const days = Math.round((asOf - start) / msPerDay) + 1;
  return Math.max(0, Math.min(dim, days));
}
function payrollDaysElapsedThrough(monthKey, startDateValue, asOfDateValue) {
  const [year, month] = normalizePayrollMonth(monthKey).split('-').map(Number);
  const dim = daysInPayrollMonth(monthKey);
  const periodStart = new Date(year, month - 1, 1);
  const periodEnd = new Date(year, month - 1, dim);
  let start = parsePayrollDateLocal(startDateValue) || periodStart;
  if (start < periodStart) start = periodStart;
  if (start > periodEnd) return 0;
  let asOf = parsePayrollDateLocal(asOfDateValue) || payrollTodayLocal();
  if (asOf < start) return 0;
  if (asOf > periodEnd) asOf = periodEnd;
  const msPerDay = 24 * 60 * 60 * 1000;
  const days = Math.round((asOf - start) / msPerDay) + 1;
  return Math.max(0, Math.min(dim, days));
}

function payrollMonth(monthId) {
  const b = h.getCurrentBranch();
  const row = h.db.prepare('SELECT * FROM payroll_months WHERE id=? AND branch_id=?').get(Number(monthId), b.id);
  if (!row) throw new Error('سجل الشهر غير موجود.');
  return row;
}
function getOrCreatePayrollMonth(monthKey, createdBy=null) {
  const key = normalizePayrollMonth(monthKey); const b = h.getCurrentBranch();
  let month = h.db.prepare('SELECT * FROM payroll_months WHERE branch_id=? AND month_key=?').get(b.id,key);
  if (!month) {
    try {
      const info = h.db.prepare('INSERT INTO payroll_months(uuid,branch_id,month_key) VALUES(?,?,?)').run(h.uuid(),b.id,key);
      month = h.db.prepare('SELECT * FROM payroll_months WHERE id=?').get(info.lastInsertRowid);
    } catch (error) {
      if (!/UNIQUE constraint failed.*payroll_months/i.test(String(error?.message || ''))) throw error;
      month = h.db.prepare('SELECT * FROM payroll_months WHERE branch_id=? AND month_key=?').get(b.id,key);
    }
  }
  const active = h.db.prepare('SELECT * FROM payroll_employees WHERE branch_id=? AND is_active=1 ORDER BY full_name COLLATE NOCASE').all(b.id);
  const existing = new Set(h.db.prepare('SELECT employee_id FROM payroll_employee_months WHERE month_id=?').all(month.id).map(r=>Number(r.employee_id)));
  // start_date الافتراضي هو أول يوم من الشهر (عامل مستمر منذ بداية الشهر) — إلا إذا
  // كان العامل نفسه قد أُضيف (created_at) بعد بداية هذا الشهر، وعندها نفترض بداية
  // استحقاقه من تاريخ إضافته فعلياً، لا من أول الشهر. هذا يمنع احتساب راتب شهر كامل
  // تلقائياً لعامل جديد أُضيف في منتصف الشهر. المدير يستطيع لاحقاً تعديل التاريخ يدوياً
  // من واجهة الرواتب إذا احتاج تصحيحه، وعندها يُعاد احتساب الراتب يوماً بيوم من ذلك التاريخ.
  const periodStartStr = `${key}-01`;
  const insert = h.db.prepare(`INSERT INTO payroll_employee_months(month_id,employee_id,pay_type,pay_rate,base_amount,start_date) VALUES(?,?,?,?,?,?)`);
  const tx = h.db.transaction(() => {
    for (const e of active) {
      if (existing.has(Number(e.id))) continue;
      const type = ['monthly','daily','hourly'].includes(e.pay_type) ? e.pay_type : 'monthly';
      const rate = Math.max(0, Number(e.pay_rate || 0));
      const createdLocal = String(e.hire_date || e.created_at || '').slice(0, 10); // YYYY-MM-DD
      const startDate = createdLocal > periodStartStr ? createdLocal : periodStartStr;
      insert.run(month.id,e.id,type,rate,0,startDate);
    }
  });
  tx();
  return month;
}
function payrollMultiplyDivideMinor(valueMinor, quantity, multiplier = 1, divisor = 1) {
  const value = BigInt(Math.trunc(Number(valueMinor || 0)));
  const q = BigInt(Math.max(0, Math.trunc(Number(money.toMinor(String(Number(quantity || 0)), 6)) || 0)));
  const m = BigInt(Math.max(0, Math.trunc(Number(money.toMinor(String(Number(multiplier || 0)), 6)) || 0)));
  const divisorScaled = BigInt(Math.max(1, Math.trunc(Number(money.toMinor(String(Number(divisor || 1)), 6)) || 0)));
  const d = divisorScaled * 1000000n;
  const numerator = value * q * m;
  if (numerator === 0n) return 0;
  return Number((numerator + d / 2n) / d);
}
function payrollRatioMinor(valueMinor, numerator, denominator) {
  return payrollMultiplyDivideMinor(valueMinor, numerator, 1, denominator);
}

function recalcPayrollEmployeeMonth(monthId, employeeId, options = {}) {
  const b = h.getCurrentBranch(); const month = payrollMonth(monthId);
  const em = h.db.prepare(`SELECT m.*,e.full_name,e.job_title,e.pay_type employee_pay_type,e.pay_rate employee_pay_rate,e.is_active
    FROM payroll_employee_months m JOIN payroll_employees e ON e.id=m.employee_id
    WHERE m.month_id=? AND m.employee_id=? AND e.branch_id=?`).get(Number(monthId),Number(employeeId),b.id);
  if (!em) throw new Error('العامل غير موجود في هذا الشهر.');
  const tx = h.db.prepare(`SELECT type,COALESCE(SUM(amount),0) amount,COALESCE(SUM(quantity),0) quantity,COALESCE(SUM(overtime_hours),0) overtime_hours,AVG(COALESCE(overtime_multiplier,1.5)) overtime_multiplier
    FROM payroll_transactions WHERE month_id=? AND employee_id=? AND branch_id=? GROUP BY type`).all(month.id,em.employee_id,b.id);
  const sums = Object.fromEntries(tx.map(x=>[x.type,{amount:Number(x.amount||0),quantity:Number(x.quantity||0)}]));
  const scheduledAdvanceMinor = Number(h.db.prepare(`
    SELECT COALESCE(SUM(i.amount_minor - COALESCE((SELECT SUM(CASE WHEN p.payment_type='direct' THEN pa.amount_minor ELSE 0 END) FROM payroll_advance_payment_allocations pa JOIN payroll_advance_payments p ON p.id=pa.payment_id WHERE p.voided_at IS NULL AND pa.installment_id=i.id),0)),0) amount_minor
    FROM payroll_advance_installments i
    JOIN payroll_advances a ON a.id=i.advance_id
    WHERE a.branch_id=? AND a.employee_id=? AND a.status='active' AND i.month_key=?
  `).get(b.id, em.employee_id, month.month_key)?.amount_minor || 0);
  const unit = Number(h.getGlobalProfile()?.currency_minor_unit ?? 2);
  const scheduledAdvance = money.fromMinor(scheduledAdvanceMinor, unit);
  const absDays = sums.absence?.quantity || 0;
  // ساعات العمل الفعلية لهذا الشهر = مجموع سجلات "ساعات يوم" التي أدخلها المدير يوماً بيوم
  // (نوع الحركة 'hours'، حيث quantity = عدد الساعات في ذلك اليوم). إن لم تُسجَّل أي حركة
  // بعد هذا الشهر (مثلاً بيانات قديمة قبل هذه الميزة)، نستخدم regular_hours المُدخل يدوياً
  // كقيمة احتياطية للتوافق العكسي فقط.
  const loggedHours = sums.hours?.quantity || 0;
  const hoursForPay = loggedHours > 0 ? loggedHours : Number(em.regular_hours||0);
  const type = em.pay_type;
  const rateMinor = Number(em.pay_rate_minor || money.toMinor(Number(em.pay_rate||0),unit));
  const dim = daysInPayrollMonth(month.month_key);
  const elapsedDays = options.asOfDate ? payrollDaysElapsedThrough(month.month_key, em.start_date, options.asOfDate) : daysElapsedInPayrollPeriod(month.month_key, em.start_date);
  let baseMinor = 0;
  if (type==='hourly') baseMinor = payrollMultiplyDivideMinor(rateMinor, hoursForPay, 1, 1);
  else if (type==='monthly') baseMinor = payrollRatioMinor(rateMinor, elapsedDays, dim);
  else if (type==='daily') baseMinor = payrollMultiplyDivideMinor(rateMinor, elapsedDays, 1, 1);
  else baseMinor = Number(em.base_amount_minor || money.toMinor(Number(em.base_amount||0),unit));
  const absenceMinor = type==='monthly' ? payrollRatioMinor(rateMinor, absDays, dim) : type==='daily' ? payrollMultiplyDivideMinor(rateMinor, absDays, 1, 1) : 0;
  const bonusMinor = money.add(...tx.filter(x=>x.type==='bonus').map(x=>money.toMinor(Number(x.amount||0),unit)));
  const deductionMinor = money.add(...tx.filter(x=>x.type==='deduction').map(x=>money.toMinor(Number(x.amount||0),unit)));
  const overtimeRows = tx.filter(x=>x.type==='overtime');
  const overtimeHours = overtimeRows.reduce((sum,x)=>sum+Number(x.overtime_hours||0),0);
  const overtimeLegacyMinor = money.add(...overtimeRows.filter(x=>!Number(x.overtime_hours||0)).map(x=>money.toMinor(Number(x.amount||0),unit)));
  const workHoursPerDay=Number(h.getSetting('payroll_work_hours_per_day','8'))||8;
  const overtimeMinor = overtimeHours>0 ? overtimeRows.reduce((sum,x)=>{
    const hours=Number(x.overtime_hours||0), mult=Number(x.overtime_multiplier||1.5);
    const divisor = type==='hourly' ? 1 : (type==='daily' ? workHoursPerDay : dim*workHoursPerDay);
    return sum + payrollMultiplyDivideMinor(rateMinor, hours, mult, divisor);
  },0) : overtimeLegacyMinor;
  const beforeAdvancesMinor = Math.max(0, rateMinor ? money.add(baseMinor, -absenceMinor, -deductionMinor, bonusMinor, overtimeMinor) : 0);
  const netBeforeDebtMinor = money.add(beforeAdvancesMinor, -Number(scheduledAdvanceMinor||0));
  const debtMinor = Math.max(0,-netBeforeDebtMinor);
  const netMinor = Math.max(0,netBeforeDebtMinor);
  const rounded = n=>Math.round(Number(n||0)*100)/100;
  h.db.prepare(`UPDATE payroll_employee_months SET base_amount=?,base_amount_minor=?,absence_days=?,absence_deduction=?,bonus_total=?,deduction_total=?,advance_total=?,overtime_total=?,net_salary=?,net_salary_minor=?,debt_carry=?,debt_carry_minor=?,regular_hours=?,updated_at=datetime('now') WHERE id=?`)
    .run(money.fromMinor(baseMinor,unit),baseMinor,rounded(absDays),money.fromMinor(absenceMinor,unit),money.fromMinor(bonusMinor,unit),money.fromMinor(deductionMinor,unit),money.fromMinor(Number(scheduledAdvanceMinor),unit),money.fromMinor(overtimeMinor,unit),money.fromMinor(netMinor,unit),netMinor,money.fromMinor(debtMinor,unit),debtMinor,Math.round(hoursForPay*100)/100,em.id);
  return h.db.prepare(`SELECT m.*,e.full_name,e.job_title,e.pay_type employee_pay_type,e.pay_rate employee_pay_rate,e.is_active
    FROM payroll_employee_months m JOIN payroll_employees e ON e.id=m.employee_id WHERE m.id=?`).get(em.id);
}
function listPayrollV2Employees(includeInactive=false) {
  const b=h.getCurrentBranch();
  return h.db.prepare(`SELECT id,uuid,full_name,job_title,pay_type,pay_rate,pay_rate_minor,is_active,national_id,hire_date,phone,department,iban,country_code,payroll_notes,created_at,updated_at FROM payroll_employees WHERE branch_id=? ${includeInactive?'':'AND is_active=1'} ORDER BY full_name COLLATE NOCASE`).all(b.id);
}
function addPayrollV2Employee(fullName,jobTitle,payType,payRate,meta={}) {
  const name=String(fullName||'').trim(), title=String(jobTitle||'').trim(), type=['monthly','daily','hourly'].includes(payType)?payType:'monthly', rate=Number(payRate);
  if(!name) return {success:false,message:'اسم العامل مطلوب.'};
  if(!title) return {success:false,message:'المسمى الوظيفي مطلوب.'};
  if(!Number.isFinite(rate)||rate<=0) return {success:false,message:'قيمة الأجر يجب أن تكون أكبر من صفر.'};
  const b=h.getCurrentBranch(), rateMinor=money.toMinor(rate,Number(h.getGlobalProfile()?.currency_minor_unit ?? 2)), v=money.fromMinor(rateMinor,Number(h.getGlobalProfile()?.currency_minor_unit ?? 2));
  const info=h.db.prepare(`INSERT INTO payroll_employees(uuid,branch_id,full_name,job_title,pay_type,pay_rate,pay_rate_minor,is_active,national_id,hire_date,phone,department,iban,country_code,payroll_notes) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(h.uuid(),b.id,name,title,type,v,rateMinor,1,String(meta.nationalId||'').trim()||null,String(meta.hireDate||'').trim()||null,String(meta.phone||'').trim()||null,String(meta.department||'').trim()||null,String(meta.iban||'').trim()||null,String(meta.countryCode||'').trim()||null,String(meta.payrollNotes||'').trim()||null);
  return {success:true,id:Number(info.lastInsertRowid)};
}
function updatePayrollV2Employee(employeeId, fullName, jobTitle, payType, payRate, meta={}) {
  const b=h.getCurrentBranch(), id=Number(employeeId), name=String(fullName||'').trim(), title=String(jobTitle||'').trim(), type=['monthly','daily','hourly'].includes(payType)?payType:'monthly', rate=Number(payRate);
  if(!name||!title) return {success:false,message:'الاسم والوظيفة مطلوبان.'};
  if(!Number.isFinite(rate)||rate<=0) return {success:false,message:'قيمة الأجر يجب أن تكون أكبر من صفر.'};
  const row=h.db.prepare('SELECT id FROM payroll_employees WHERE id=? AND branch_id=?').get(id,b.id); if(!row) return {success:false,message:'العامل غير موجود.'};
  const unit=Number(h.getGlobalProfile()?.currency_minor_unit ?? 2); const rateMinor=money.toMinor(rate,unit);
  const metaValues=[String(meta.nationalId||'').trim()||null,String(meta.hireDate||'').trim()||null,String(meta.phone||'').trim()||null,String(meta.department||'').trim()||null,String(meta.iban||'').trim()||null,String(meta.countryCode||'').trim()||null,String(meta.payrollNotes||'').trim()||null];
  h.db.prepare('UPDATE payroll_employees SET full_name=?,job_title=?,pay_type=?,pay_rate=?,pay_rate_minor=?,national_id=?,hire_date=?,phone=?,department=?,iban=?,country_code=?,payroll_notes=?,updated_at=datetime(\'now\'),synced=0 WHERE id=? AND branch_id=?').run(name,title,type,money.fromMinor(rateMinor,unit),rateMinor,...metaValues,id,b.id);
  return {success:true,id};
}
function setPayrollV2EmployeeActive(employeeId,isActive){ const b=h.getCurrentBranch(); const r=h.db.prepare('SELECT id FROM payroll_employees WHERE id=? AND branch_id=?').get(Number(employeeId),b.id); if(!r)return{success:false,message:'العامل غير موجود.'}; h.db.prepare('UPDATE payroll_employees SET is_active=?,updated_at=datetime(\'now\'),synced=0 WHERE id=?').run(isActive?1:0,r.id); return{success:true,isActive:!!isActive}; }
// حذف نهائي — مسموح فقط إذا العامل ما إله ولا سجل راتب واحد بأي شهر (يعني انضاف بالغلط
// ولم يُصرف له شيء بعد). إذا إله تاريخ، نرفض الحذف حتى لا تُفقد سجلات رواتب مدفوعة فعلياً
// أو ينكسر أي تقرير قديم يعتمد عليها — الخيار الصحيح حينها هو تعطيله (setPayrollV2EmployeeActive).
function deletePayrollV2Employee(employeeId){
  const b=h.getCurrentBranch();
  const r=h.db.prepare('SELECT id,full_name FROM payroll_employees WHERE id=? AND branch_id=?').get(Number(employeeId),b.id);
  if(!r) return {success:false,message:'العامل غير موجود.'};
  const historyCount=h.db.prepare('SELECT COUNT(*) c FROM payroll_employee_months WHERE employee_id=?').get(r.id).c;
  if(historyCount>0) return {success:false,message:`لا يمكن حذف "${r.full_name}" لأن له سجل رواتب سابق (${historyCount} شهر). عطّله بدلاً من ذلك للحفاظ على دقة التقارير القديمة.`};
  h.db.prepare('DELETE FROM payroll_employees WHERE id=? AND branch_id=?').run(r.id,b.id);
  return {success:true};
}
function getPayrollV2Report(monthKey) {
  const month = getPayrollV2Month(monthKey);
  const unit = Number(h.getGlobalProfile()?.currency_minor_unit ?? 2);
  const rows = month.items.map((x) => {
    const paidMinor = Number(x.paid_total_minor || 0);
    const netMinor = Number(x.net_salary_minor || 0);
    return {
      employeeId: x.employee_id, fullName: x.full_name, jobTitle: x.job_title,
      nationalId: x.national_id || '', department: x.department || '', iban: x.iban || '',
      payType: x.employee_pay_type || x.pay_type, payRate: money.fromMinor(Number(x.pay_rate_minor || 0), unit),
      base: money.fromMinor(Number(x.base_amount_minor || 0), unit),
      absence: Number(x.absence_days || 0), absenceDeduction: Number(x.absence_deduction || 0),
      bonuses: Number(x.bonus_total || 0), deductions: Number(x.deduction_total || 0),
      advances: Number(x.advance_total || 0), overtime: Number(x.overtime_total || 0),
      net: money.fromMinor(netMinor, unit), debtCarry: money.fromMinor(Number(x.debt_carry_minor || 0), unit),
      paid: money.fromMinor(paidMinor, unit), remaining: money.fromMinor(Math.max(0, netMinor-paidMinor), unit),
      status: x.payment_status || 'unpaid', active: Number(x.is_active) !== 0
    };
  });
  return { monthKey: month.month_key, status: month.status, generatedAt: new Date().toISOString(), total: rows.reduce((n,r)=>n+r.net,0), rows };
}

function getPayrollV2Month(monthKey) {
  const m=getOrCreatePayrollMonth(monthKey); const b=h.getCurrentBranch();
  const rows=h.db.prepare(`SELECT m.*,e.uuid employee_uuid,e.full_name,e.job_title,e.pay_type employee_pay_type,e.pay_rate employee_pay_rate,e.is_active
    FROM payroll_employee_months m JOIN payroll_employees e ON e.id=m.employee_id WHERE m.month_id=? AND e.branch_id=? ORDER BY e.full_name COLLATE NOCASE`).all(m.id,b.id);
  for(const r of rows) recalcPayrollEmployeeMonth(m.id,r.employee_id);
  const items=h.db.prepare(`SELECT m.*,e.uuid employee_uuid,e.full_name,e.job_title,e.pay_type employee_pay_type,e.pay_rate employee_pay_rate,e.is_active
    FROM payroll_employee_months m JOIN payroll_employees e ON e.id=m.employee_id WHERE m.month_id=? AND e.branch_id=? ORDER BY e.full_name COLLATE NOCASE`).all(m.id,b.id);
  const paymentRows=h.db.prepare(`SELECT employee_id,COALESCE(SUM(amount_minor),0) paid_minor,COALESCE(SUM(amount),0) paid_amount FROM payroll_payments WHERE branch_id=? AND month_id=? GROUP BY employee_id`).all(b.id,m.id);
  const paymentMap=new Map(paymentRows.map(x=>[Number(x.employee_id),x]));
  const unit=Number(h.getGlobalProfile()?.currency_minor_unit ?? 2);
  const transactions=h.db.prepare('SELECT * FROM payroll_transactions WHERE month_id=? AND branch_id=? ORDER BY event_date DESC,id DESC').all(m.id,b.id);
  const enrichedItems=items.map(x=>{const paid=paymentMap.get(Number(x.employee_id));const paidMinor=Number(paid?.paid_minor||0);const netMinor=Number(x.net_salary_minor||money.toMinor(Number(x.net_salary||0),unit));return {...x,paid_total:money.fromMinor(paidMinor,unit),paid_total_minor:paidMinor,remaining_salary:money.fromMinor(Math.max(0,netMinor-paidMinor),unit),remaining_salary_minor:Math.max(0,netMinor-paidMinor),payment_status:paidMinor>=netMinor?'paid':paidMinor>0?'partial':'unpaid'};});
  const payableItems=enrichedItems.filter(x=>Number(x.is_active)!==0);
  return {id:m.id,uuid:m.uuid,month_key:m.month_key,status:m.status||'open',closed_at:m.closed_at||null,items:enrichedItems,transactions,total:money.fromMinor(payableItems.reduce((s,x)=>s+Number(x.net_salary_minor||money.toMinor(Number(x.net_salary||0),unit)),0),unit)};
}
function assertPayrollMonthMutable(month) {
  if (String(month.status || 'open') === 'paid') {
    throw new Error('تم صرف هذا الشهر بالكامل ولا يمكن تعديل مستحقاته. إذا كان هناك خطأ، استخدم قيد تصحيح مستقل ولا تعدّل السجل التاريخي.');
  }
}

function getPayrollEmployeePaymentState(monthId, employeeId) {
  const b = h.getCurrentBranch();
  const month = payrollMonth(monthId);
  const item = h.db.prepare(`SELECT m.*,e.full_name,e.is_active FROM payroll_employee_months m JOIN payroll_employees e ON e.id=m.employee_id WHERE m.month_id=? AND m.employee_id=? AND e.branch_id=?`).get(month.id, Number(employeeId), b.id);
  if (!item) throw new Error('العامل غير موجود في هذا الشهر.');
  const unit = Number(h.getGlobalProfile()?.currency_minor_unit ?? 2);
  const netMinor = money.toMinor(Number(item.net_salary || 0), unit);
  const paid = h.db.prepare('SELECT COALESCE(SUM(amount_minor),0) paid_minor FROM payroll_payments WHERE branch_id=? AND month_id=? AND employee_id=?').get(b.id, month.id, item.employee_id);
  const paidMinor = Number(paid?.paid_minor || 0);
  return { item, netMinor, paidMinor, remainingMinor: Math.max(0, netMinor - paidMinor), currencyMinorUnit: unit };
}

// يطابق المصروف المُرحَّل بدفتر اليومية (6100) مع صافي الراتب المستحق الحالي للموظف بهذا
// الشهر (net_salary_minor بعد إعادة الحساب)، عبر قيد بالفرق مقابل التزام "رواتب مستحقة"
// (2300). يُستخدم قبل أي صرف فعلي (recordPayrollPayment) لضمان أن ما يُصرف مغطّى دائماً
// باستحقاق مُعترف به مسبقاً بالمحاسبة، ويُستخدم أيضاً بشكل مستقل (accruePayrollMonth)
// كإجراء استحقاق شهري صريح يستطيع المحاسب تشغيله وقتما يريد (مثلاً لإقفال شهري) دون
// انتظار صرف فعلي لأي عامل. إن قلّ المستحق عن آخر مبلغ مُرحَّل (تعديل حضور/خصم لاحق)
// يُرحَّل قيد عكسي بالفرق تلقائياً بنفس الطريقة.
function syncPayrollEmployeeAccrual(monthId, employeeId, { createdBy = null, entryDate = null } = {}) {
  const b = h.getCurrentBranch();
  const m = payrollMonth(monthId);
  const em = recalcPayrollEmployeeMonth(m.id, Number(employeeId));
  const netMinor = Number(em.net_salary_minor || 0);
  const accruedMinor = Number(em.accrued_minor || 0);
  const deltaMinor = netMinor - accruedMinor;
  if (deltaMinor === 0) return { netMinor, accruedMinor, deltaMinor: 0 };
  const date = String(entryDate || payrollTodayLocal().toISOString().slice(0, 10)).slice(0, 10);
  const absMinor = Math.abs(deltaMinor);
  const lines = deltaMinor > 0
    ? [
        { accountId: h.getAccountingAccountId(b.id, '6100'), debitMinor: absMinor, creditMinor: 0, memo: `استحقاق راتب ${em.full_name} — ${m.month_key}` },
        { accountId: h.getAccountingAccountId(b.id, '2300'), debitMinor: 0, creditMinor: absMinor, memo: `التزام راتب مستحق ${em.full_name} — ${m.month_key}` },
      ]
    : [
        { accountId: h.getAccountingAccountId(b.id, '2300'), debitMinor: absMinor, creditMinor: 0, memo: `تصحيح نزولي لالتزام راتب ${em.full_name} — ${m.month_key}` },
        { accountId: h.getAccountingAccountId(b.id, '6100'), debitMinor: 0, creditMinor: absMinor, memo: `تصحيح نزولي لمصروف راتب ${em.full_name} — ${m.month_key}` },
      ];
  h.insertPostedJournalEntry({
    branchId: b.id, memo: `استحقاق راتب: ${em.full_name} (${m.month_key})`, referenceType: 'payroll_accrual', referenceId: em.id, entryDate: date,
    lines, createdBy,
  });
  h.db.prepare('UPDATE payroll_employee_months SET accrued_minor=?,synced=0 WHERE id=?').run(netMinor, em.id);
  return { netMinor, accruedMinor: netMinor, deltaMinor };
}

// إجراء استحقاق صريح لكل عمال شهر رواتب معيّن دفعة واحدة — يسمح للمحاسب بترحيل كامل
// مصروف الشهر بقائمة الدخل فوراً (وإظهار الالتزام المقابل بالمركز المالي) دون انتظار أي
// صرف فعلي. آمن للتشغيل عدة مرات (يرحّل الفرق فقط إن تغيّر شيء منذ آخر تشغيل).
function accruePayrollMonth(monthId, { createdBy = null } = {}) {
  const b = h.getCurrentBranch();
  const m = payrollMonth(monthId);
  const rows = h.db.prepare('SELECT m.employee_id FROM payroll_employee_months m JOIN payroll_employees e ON e.id=m.employee_id WHERE m.month_id=? AND e.branch_id=?').all(m.id, b.id);
  const tx = h.db.transaction(() => {
    let totalDeltaMinor = 0, employeesAccrued = 0;
    for (const r of rows) {
      const result = syncPayrollEmployeeAccrual(m.id, r.employee_id, { createdBy });
      if (result.deltaMinor !== 0) { totalDeltaMinor += result.deltaMinor; employeesAccrued += 1; }
    }
    h.db.prepare(`UPDATE payroll_months SET accrued_at=datetime('now'),accrued_by=?,synced=0 WHERE id=?`).run(createdBy || null, m.id);
    return { employeesAccrued, totalDeltaMinor };
  });
  return tx();
}

function addPayrollV2Transaction({monthId,employeeId,type,amount,quantity,eventDate,reason,createdBy,paidFromRegister,overtimeMultiplier=1.5}) {
  const b=h.getCurrentBranch(), m=payrollMonth(monthId);
  const unit = Number(h.getGlobalProfile()?.currency_minor_unit ?? 2);
  assertPayrollMonthMutable(m);
  // 'hours' = سجل ساعات عمل ليوم واحد بالتحديد (quantity = عدد الساعات)، يُستخدم مع
  // العاملين بالساعة بدل إدخال إجمالي شهري يدوي واحد عرضة للخطأ.
  if(type==='advance') throw new Error('السلف تُدار حصراً من سجل السلف المجدولة.');
  if(!['absence','bonus','deduction','overtime','hours'].includes(type)) throw new Error('نوع الحركة غير صالح.');
  const amt=Number(amount||0), qty=Number(quantity==null?1:quantity), date=String(eventDate||'').trim();
  const overtimeMultiplierValue=Number(overtimeMultiplier);
  if(!Number.isFinite(amt)||amt<0) throw new Error('مبلغ الحركة غير صالح.');
  const zeroAmountTypes = type==='absence' || type==='hours' || type==='overtime';
  if(!Number.isFinite(qty)||qty<=0) throw new Error(type==='hours' ? 'عدد الساعات غير صالح.' : 'الكمية غير صالحة.');
  if(type==='hours' && qty>24) throw new Error('لا يمكن أن يتجاوز عدد ساعات اليوم الواحد 24 ساعة.');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('تاريخ الحركة غير صالح.');
  const key=m.month_key; if(date.slice(0,7)!==key) throw new Error('تاريخ الحركة يجب أن يكون ضمن الشهر المحدد.');
  if(zeroAmountTypes && amt!==0) throw new Error(type==='absence' ? 'الغياب لا يحتاج مبلغًا؛ يُحسب الخصم تلقائيًا.' : type==='overtime' ? 'الإضافي لا يحتاج مبلغًا يدوياً؛ يُحسب تلقائياً من الساعات والمعامل.' : 'ساعات العمل لا تحتاج مبلغًا؛ يُحسب الراتب تلقائياً من الساعات والأجر بالساعة.');
  if(!zeroAmountTypes && amt<=0) throw new Error('المبلغ يجب أن يكون أكبر من صفر.');
  const e=h.db.prepare('SELECT id,pay_type,full_name FROM payroll_employees WHERE id=? AND branch_id=?').get(Number(employeeId),b.id); if(!e)throw new Error('العامل غير موجود.');
  if(type==='hours' && e.pay_type!=='hourly') throw new Error('تسجيل الساعات متاح فقط للعاملين بنظام الأجر بالساعة.');
  // السلفة ممكن تتسجل كصرف نقدي فوري من الصندوق (لو الموظف استلمها كاش دلوقتي)، أو كقيد
  // رواتب بحت (لو هتتسوى لاحقاً بطريقة تانية). لو "من الصندوق"، لازم يكون فيه وردية مفتوحة
  // فعلاً عشان الفلوس فعلياً تخصم من رصيد الصندوق وتظهر في التقارير المالية.
  const wantsCashOut = false;
  const result=h.db.transaction(()=>{
    let cashMovementId=null;
    if(wantsCashOut){
      const openShift=h.getOpenShift();
      if(!openShift) throw new Error('لا يمكن تسجيل السلفة كصرف من الصندوق لعدم وجود وردية مفتوحة حالياً. افتح وردية أولاً، أو سجّل السلفة كقيد رواتب بدون خصمها من الصندوق الآن.');
      const cm=h.addCashMovement({shiftId:openShift.id,type:'cash_out',amount:amt,reason:`سلفة موظف: ${e.full_name}`,reference:'payroll_advance',createdBy});
      cashMovementId=cm.id;
    }
    const exists=h.db.prepare('SELECT id FROM payroll_employee_months WHERE month_id=? AND employee_id=?').get(m.id,e.id);
    if(!exists) h.db.prepare(`INSERT INTO payroll_employee_months(month_id,employee_id,pay_type,pay_rate,base_amount) SELECT ?,id,pay_type,pay_rate,CASE WHEN pay_type='monthly' THEN pay_rate WHEN pay_type='daily' THEN pay_rate*? ELSE 0 END FROM payroll_employees WHERE id=?`).run(m.id,daysInPayrollMonth(key),e.id);
    if(type==='absence') { const dup=h.db.prepare("SELECT id FROM payroll_transactions WHERE month_id=? AND employee_id=? AND type=\'absence\' AND event_date=?").get(m.id,e.id,date); if(dup) throw new Error('يوم الغياب هذا مسجل بالفعل.'); }
    if(type==='hours') { const dup=h.db.prepare("SELECT id FROM payroll_transactions WHERE month_id=? AND employee_id=? AND type=\'hours\' AND event_date=?").get(m.id,e.id,date); if(dup) throw new Error('ساعات هذا اليوم مسجلة بالفعل. احذف السجل القديم إن أردت تعديله.'); }
    const amountMinor = money.toMinor(amt, unit);
    const overtimeHoursValue = type === 'overtime' ? qty : 0;
    const overtimeMultiplierDb = type === 'overtime' ? overtimeMultiplierValue : 1.5;
    if (type === 'overtime') {
      if (!Number.isFinite(overtimeMultiplierValue) || overtimeMultiplierValue <= 0 || overtimeMultiplierValue > 10) {
        throw new Error('معامل الإضافي يجب أن يكون أكبر من صفر ولا يتجاوز 10.');
      }
    }
    const info=h.db.prepare(`INSERT INTO payroll_transactions(uuid,branch_id,month_id,employee_id,type,amount,amount_minor,quantity,event_date,reason,created_by,cash_movement_id,overtime_multiplier,overtime_hours) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      h.uuid(),b.id,m.id,e.id,type,money.fromMinor(amountMinor,unit),amountMinor,Math.round(qty*100)/100,date,String(reason||'').trim()||null,createdBy||null,cashMovementId,overtimeMultiplierDb,overtimeHoursValue
    );
    return {success:true,id:Number(info.lastInsertRowid),cashMovementId,item:recalcPayrollEmployeeMonth(m.id,e.id)};
  })();
  return result;
}
function removePayrollV2Transaction(transactionId,deletedBy){
  const b=h.getCurrentBranch();
  const t=h.db.prepare('SELECT id,month_id,employee_id,amount,cash_movement_id FROM payroll_transactions WHERE id=? AND branch_id=?').get(Number(transactionId),b.id);
  if(!t)throw new Error('الحركة غير موجودة.');
  assertPayrollMonthMutable(payrollMonth(t.month_id));
  const result=h.db.transaction(()=>{
    // لو السلفة دي كانت اتخصمت فعلياً من الصندوق، لازم نرجّع المبلغ للصندوق (حركة إدخال
    // معاكسة) قبل حذف القيد، وإلا هيفضل رصيد الصندوق ناقص فلوس من غير سبب. نسيب حركة النقد
    // الأصلية زي ما هي (سجل تاريخي ثابت، متسقّ مع باقي جداول الصندوق) ونضيف حركة عكسية.
    if(t.cash_movement_id){
      const openShift=h.getOpenShift();
      if(!openShift) throw new Error('هذه السلفة مسجَّلة كصرف من الصندوق. لحذفها لازم تفتح وردية أولاً حتى يُعاد المبلغ للصندوق.');
      h.addCashMovement({shiftId:openShift.id,type:'cash_in',amount:t.amount,reason:'إلغاء/حذف سلفة موظف (تصحيح)',reference:`payroll_advance_reversal:${t.id}`,createdBy:deletedBy||null});
    }
    h.db.prepare('DELETE FROM payroll_transactions WHERE id=?').run(t.id);
    return recalcPayrollEmployeeMonth(t.month_id,t.employee_id);
  })();
  return {success:true,item:result};
}
// يحدّد تاريخ التحاق العامل ضمن هذا الشهر تحديداً (متى بدأ يستحق راتباً هذا الشهر).
// بعدها يُعاد احتساب صافي الراتب فوراً على أساس عدد الأيام من هذا التاريخ وحتى اليوم.
function setPayrollEmployeeMonthStartDate(monthId,employeeId,startDate){
  const b=h.getCurrentBranch(); const m=payrollMonth(monthId);
  assertPayrollMonthMutable(m);
  const date=String(startDate||'').trim();
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)) return {success:false,message:'تاريخ البدء غير صالح.'};
  const row=h.db.prepare(`SELECT m.id FROM payroll_employee_months m JOIN payroll_employees e ON e.id=m.employee_id WHERE m.month_id=? AND m.employee_id=? AND e.branch_id=?`).get(m.id,Number(employeeId),b.id);
  if(!row) return {success:false,message:'العامل غير موجود في هذا الشهر.'};
  h.db.prepare(`UPDATE payroll_employee_months SET start_date=?,updated_at=datetime('now'),synced=0 WHERE id=?`).run(date,row.id);
  return {success:true,item:recalcPayrollEmployeeMonth(m.id,Number(employeeId))};
}

function normalizePayrollFirstDeductionMonth(monthKey) {
  return normalizePayrollMonth(monthKey || currentPayrollMonthKey());
}
function currentPayrollMonthKey() { const d=payrollTodayLocal(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`; }
function addMonthsToPayrollMonth(monthKey, offset) {
  const [y,m]=normalizePayrollMonth(monthKey).split('-').map(Number);
  const d=new Date(y,m-1+Number(offset),1);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
}
function createPayrollAdvance({monthId,employeeId,amount,installmentCount=1,firstDeductionMonth,reason,paidFromRegister=false,method,createdBy}) {
  const b=h.getCurrentBranch(); const m=payrollMonth(monthId); assertPayrollMonthMutable(m);
  const employee=h.db.prepare('SELECT id,full_name,is_active FROM payroll_employees WHERE id=? AND branch_id=?').get(Number(employeeId),b.id);
  if(!employee) throw new Error('العامل غير موجود.');
  if(!employee.is_active) throw new Error('لا يمكن إنشاء سلفة لعامل معطّل.');
  const unit=Number(h.getGlobalProfile()?.currency_minor_unit ?? 2);
  const principalMinor=money.toMinor(Number(amount),unit);
  if(principalMinor<=0) throw new Error('قيمة السلفة يجب أن تكون أكبر من صفر.');
  const count=Number(installmentCount);
  if(!Number.isInteger(count)||count<1||count>36) throw new Error('عدد أقساط السلفة يجب أن يكون بين 1 و36.');
  const first=normalizePayrollFirstDeductionMonth(firstDeductionMonth || m.month_key);
  if(first < m.month_key) throw new Error('شهر بدء الخصم لا يمكن أن يكون قبل شهر السلفة.');
  // التوافق مع الواجهة القديمة: كانت ترسل فقط paidFromRegister (checkbox) وتفترض النقد ضمنياً.
  // الحقل الجديد method صريح؛ إن لم يُرسَل نشتقّه من paidFromRegister حتى لا تنكسر أي استدعاءات قديمة.
  const disbursementMethod=String(method||'cash').trim().toLowerCase();
  if(!['cash','bank','other'].includes(disbursementMethod)) throw new Error('طريقة صرف السلفة غير صالحة.');
  // فقط 'cash' يمرّ عبر الصندوق فعلياً؛ paidFromRegister مع bank/other لا معنى له (لا حركة صندوق لتحويل بنكي).
  const useRegister=disbursementMethod==='cash' && !!paidFromRegister;
  // مصروفة فعلاً الآن (يجب أن تُرحَّل محاسبياً) إن كانت نقداً من الصندوق، أو بأي طريقة
  // غير نقدية (bank/other تُعتبر دائماً مصروفة فوراً بوسيلة خارج الصندوق — راجع التعليق
  // أعلاه). سلفة نقدية بلا صرف فوري (useRegister=false) تبقى مجرد تسجيل بلا أثر نقدي بعد.
  const isDisbursedNow = disbursementMethod !== 'cash' || useRegister;
  const regularMinor=Math.floor(principalMinor/count);
  const remainder=principalMinor-(regularMinor*count);
  const tx=h.db.transaction(()=>{
    let cashMovementId=null;
    if(useRegister){
      const shift=h.getOpenShift();
      if(!shift) throw new Error('لا يمكن دفع السلفة نقداً من الصندوق دون وردية مفتوحة. افتح وردية أولاً أو سجّلها بدون صرف فوري.');
      const cm=h.addCashMovement({shiftId:shift.id,type:'cash_out',amount:money.fromMinor(principalMinor,unit),reason:`سلفة موظف: ${employee.full_name}`,reference:'payroll_advance',createdBy});
      cashMovementId=cm.id;
    }
    const advanceInfo=h.db.prepare(`INSERT INTO payroll_advances(uuid,branch_id,employee_id,principal,principal_minor,installment_count,installment_amount,installment_amount_minor,first_deduction_month,reason,cash_movement_id,disbursement_method,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(h.uuid(),b.id,employee.id,money.fromMinor(principalMinor,unit),principalMinor,count,money.fromMinor(regularMinor,unit),regularMinor,first,String(reason||'').trim()||null,cashMovementId,disbursementMethod,createdBy||null);
    const advanceId=Number(advanceInfo.lastInsertRowid);
    if(isDisbursedNow && principalMinor>0){
      const settleCode = disbursementMethod==='cash' ? '1000' : '1100';
      h.insertPostedJournalEntry({
        branchId: b.id, memo: `سلفة موظف: ${employee.full_name}`, referenceType: 'payroll_advance', referenceId: advanceId,
        lines: [
          { accountId: h.getAccountingAccountId(b.id, '1400'), debitMinor: principalMinor, creditMinor: 0, memo: `سلفة ${employee.full_name}` },
          { accountId: h.getAccountingAccountId(b.id, settleCode), debitMinor: 0, creditMinor: principalMinor, memo: `صرف سلفة ${employee.full_name}` },
        ], createdBy: createdBy || null,
      });
    }
    const ins=h.db.prepare(`INSERT INTO payroll_advance_installments(advance_id,month_key,installment_no,amount,amount_minor) VALUES(?,?,?,?,?)`);
    for(let n=1;n<=count;n++){
      const minor=regularMinor+(n===count?remainder:0); const month=addMonthsToPayrollMonth(first,n-1);
      ins.run(advanceId,month,n,money.fromMinor(minor,unit),minor);
    }
    return {advanceId,cashMovementId,principalMinor};
  })();
  return {success:true,id:tx.advanceId,cashMovementId:tx.cashMovementId,principal:money.fromMinor(tx.principalMinor,unit),installmentCount:count,firstDeductionMonth:first,disbursementMethod};
}
function listPayrollAdvances(employeeId=null){
  const b=h.getCurrentBranch(); const unit=Number(h.getGlobalProfile()?.currency_minor_unit ?? 2);
  const where=employeeId!=null?'AND a.employee_id=?':''; const params=employeeId!=null?[b.id,Number(employeeId)]:[b.id];
  const rows=h.db.prepare(`SELECT a.*,e.full_name employee_name FROM payroll_advances a JOIN payroll_employees e ON e.id=a.employee_id WHERE a.branch_id=? ${where} ORDER BY a.created_at DESC,a.id DESC`).all(...params);
  return rows.map(a=>{
    const paid=h.db.prepare(`SELECT COALESCE(SUM(CASE WHEN p.payment_type='direct' THEN pa.amount_minor ELSE 0 END),0) direct_paid_minor,COALESCE(SUM(pa.amount_minor),0) recovered_minor FROM payroll_advance_payment_allocations pa JOIN payroll_advance_payments p ON p.id=pa.payment_id WHERE p.voided_at IS NULL AND p.advance_id=?`).get(a.id);
    const directPaidMinor=Number(paid?.direct_paid_minor||0);
    const recoveredMinor=Number(paid?.recovered_minor||0);
    const remainingMinor=Math.max(0,Number(a.principal_minor||0)-recoveredMinor);
    const current= h.db.prepare(`SELECT COALESCE(SUM(i.amount_minor),0) scheduled_minor,
      COALESCE(SUM(CASE WHEN i.month_key<=? THEN i.amount_minor ELSE 0 END),0) accrued_minor,
      COALESCE(SUM(CASE WHEN i.month_key<=? THEN (i.amount_minor-COALESCE((SELECT SUM(CASE WHEN p.payment_type='direct' THEN pa.amount_minor ELSE 0 END) FROM payroll_advance_payment_allocations pa JOIN payroll_advance_payments p ON p.id=pa.payment_id WHERE p.voided_at IS NULL AND pa.installment_id=i.id),0)) ELSE 0 END),0) overdue_direct_adjusted_minor
      FROM payroll_advance_installments i WHERE i.advance_id=?`).get(currentPayrollMonthKey(),currentPayrollMonthKey(),a.id);
    const status=remainingMinor<=0?'completed':'active';
    if (String(a.status)!==status) h.db.prepare(`UPDATE payroll_advances SET status=?,updated_at=datetime('now'),synced=0 WHERE id=? AND branch_id=?`).run(status,a.id,b.id);
    return {...a,status,principal:money.fromMinor(Number(a.principal_minor||0),unit),installment_amount:money.fromMinor(Number(a.installment_amount_minor||0),unit),scheduled_minor:Number(current?.scheduled_minor||0),scheduled:money.fromMinor(Number(current?.scheduled_minor||0),unit),accrued_minor:Number(current?.accrued_minor||0),accrued:money.fromMinor(Number(current?.accrued_minor||0),unit),direct_paid_minor:directPaidMinor,direct_paid:money.fromMinor(directPaidMinor,unit),recovered_minor:recoveredMinor,recovered:money.fromMinor(recoveredMinor,unit),remaining_minor:remainingMinor,remaining:money.fromMinor(remainingMinor,unit)};
  });
}

function listPayrollAdvancePayments(advanceId){
  const b=h.getCurrentBranch(); const a=h.db.prepare('SELECT id FROM payroll_advances WHERE id=? AND branch_id=?').get(Number(advanceId),b.id); if(!a) throw new Error('السلفة غير موجودة.');
  return h.db.prepare(`SELECT p.*,COALESCE(SUM(pa.amount_minor),0) allocated_minor FROM payroll_advance_payments p LEFT JOIN payroll_advance_payment_allocations pa ON pa.payment_id=p.id WHERE p.advance_id=? AND p.branch_id=? GROUP BY p.id ORDER BY p.payment_date DESC,p.id DESC`).all(a.id,b.id);
}

function repayPayrollAdvance({advanceId,amount,paymentDate,method='cash',reference,notes,createdBy,paidFromRegister=false}){
  const b=h.getCurrentBranch(); const unit=Number(h.getGlobalProfile()?.currency_minor_unit ?? 2);
  const advance=h.db.prepare('SELECT * FROM payroll_advances WHERE id=? AND branch_id=?').get(Number(advanceId),b.id);
  if(!advance) throw new Error('السلفة غير موجودة.');
  if(String(advance.status)==='completed') throw new Error('هذه السلفة مسددة بالكامل.');
  const date = String(paymentDate || payrollTodayLocal().toISOString().slice(0,10)).slice(0,10);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('تاريخ تسديد السلفة غير صالح.');
  const amountMinor=money.toMinor(Number(amount),unit); if(amountMinor<=0) throw new Error('قيمة التسديد يجب أن تكون أكبر من صفر.');
  const recovered=Number(h.db.prepare('SELECT COALESCE(SUM(pa.amount_minor),0) x FROM payroll_advance_payment_allocations pa JOIN payroll_advance_payments p ON p.id=pa.payment_id WHERE p.voided_at IS NULL AND p.advance_id=?').get(advance.id).x||0);
  const remaining=Math.max(0,Number(advance.principal_minor||0)-recovered);
  if(amountMinor>remaining) throw new Error(`مبلغ التسديد أكبر من الرصيد المتبقي (${money.fromMinor(remaining,unit)}).`);
  const tx=h.db.transaction(()=>{
    let cashMovementId=null;
    if(paidFromRegister){
      const shift=h.getOpenShift(); if(!shift) throw new Error('لا يمكن تسجيل التسديد نقداً من الصندوق دون وردية مفتوحة.');
      const cm=h.addCashMovement({shiftId:shift.id,type:'cash_in',amount:money.fromMinor(amountMinor,unit),reason:'تسديد سلفة موظف',reference:`payroll_advance_repayment:${advance.id}`,createdBy}); cashMovementId=cm.id;
    }
    const paymentInfo=h.db.prepare(`INSERT INTO payroll_advance_payments(uuid,branch_id,advance_id,payment_type,amount,amount_minor,payment_date,method,reference,notes,cash_movement_id,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(h.uuid(),b.id,advance.id,'direct',money.fromMinor(amountMinor,unit),amountMinor,date,String(method||'cash'),String(reference||'payroll_advance_repayment'),String(notes||'').trim()||null,cashMovementId,createdBy||null);
    const paymentId=Number(paymentInfo.lastInsertRowid);
    let left=amountMinor;
    const installments=h.db.prepare(`SELECT i.* FROM payroll_advance_installments i WHERE i.advance_id=? ORDER BY i.month_key,i.installment_no`).all(advance.id);
    for(const i of installments){
      if(left<=0) break;
      const already=Number(h.db.prepare(`SELECT COALESCE(SUM(CASE WHEN p.payment_type='direct' THEN pa.amount_minor ELSE 0 END),0) x FROM payroll_advance_payment_allocations pa JOIN payroll_advance_payments p ON p.id=pa.payment_id WHERE p.voided_at IS NULL AND pa.installment_id=?`).get(i.id).x||0);
      const open=Math.max(0,Number(i.amount_minor)-already); if(open<=0) continue;
      const alloc=Math.min(open,left); const ins=h.db.prepare(`INSERT INTO payroll_advance_payment_allocations(payment_id,installment_id,amount,amount_minor) VALUES(?,?,?,?)`).run(paymentId,i.id,money.fromMinor(alloc,unit),alloc); left-=alloc;
    }
    if(left>0) throw new Error('تعذر توزيع مبلغ التسديد على أقساط السلفة.');
    const newRecovered=recovered+amountMinor;
    if(newRecovered>=Number(advance.principal_minor)) h.db.prepare(`UPDATE payroll_advances SET status='completed',updated_at=datetime('now'),synced=0 WHERE id=? AND branch_id=?`).run(advance.id,b.id);
    // قيد محاسبي: مدين حساب التسوية (نقد/بطاقة) حسب طريقة التسديد، دائن "سلف موظفين"
    // (تخفيض الأصل) — يطابق نفس نمط receiveCustomerPayment/paySupplierDebt.
    const settleCode = String(method)==='card' ? '1100' : '1000';
    h.insertPostedJournalEntry({
      branchId: b.id, memo: `تسديد سلفة موظف #${advance.employee_id}`, referenceType: 'payroll_advance_repayment', referenceId: advance.id, entryDate: date,
      lines: [
        { accountId: h.getAccountingAccountId(b.id, settleCode), debitMinor: amountMinor, creditMinor: 0, memo: 'تسديد سلفة موظف' },
        { accountId: h.getAccountingAccountId(b.id, '1400'), debitMinor: 0, creditMinor: amountMinor, memo: 'تخفيض سلف موظفين' },
      ], createdBy: createdBy || null,
    });
    return {id:paymentId,cashMovementId,amountMinor,remainingMinor:Math.max(0,Number(advance.principal_minor)-newRecovered)};
  })();
  return {success:true,id:tx.id,cashMovementId:tx.cashMovementId,amount:money.fromMinor(tx.amountMinor,unit),remaining:money.fromMinor(tx.remainingMinor,unit),status:tx.remainingMinor<=0?'completed':'active'};
}

// كانت هذه الدالة تستدعي listPayrollAdvances(advanceId) — وlistPayrollAdvances تفلتر حسب
// employee_id لا id السلفة نفسها (كما تُستخدم بكل الاستدعاءات الأخرى: main.js وlines 4363/4393
// أدناه). أي تمرير معرّف السلفة هناك كان يُبحث خطأً عن سلف موظف رقمه = معرّف السلفة، فتفشل
// شبه دائماً بخطأ "السلفة غير موجودة" حتى لو كانت السلفة موجودة فعلاً. نجلب السلفة مباشرة بمعرّفها.
function settlePayrollAdvance(advanceId,{paymentDate,method='cash',reference='payroll_advance_early_settlement',notes,createdBy,paidFromRegister=false}={}){
  const b=h.getCurrentBranch(); const unit=Number(h.getGlobalProfile()?.currency_minor_unit ?? 2);
  const advance=h.db.prepare('SELECT * FROM payroll_advances WHERE id=? AND branch_id=?').get(Number(advanceId),b.id);
  if(!advance) throw new Error('السلفة غير موجودة.');
  const recoveredMinor=Number(h.db.prepare(`SELECT COALESCE(SUM(pa.amount_minor),0) x FROM payroll_advance_payment_allocations pa JOIN payroll_advance_payments p ON p.id=pa.payment_id WHERE p.voided_at IS NULL AND p.advance_id=?`).get(advance.id).x||0);
  const remainingMinor=Math.max(0,Number(advance.principal_minor||0)-recoveredMinor);
  if(remainingMinor<=0) return {success:true,status:'completed',amount:'0.00',remaining:'0.00'};
  return repayPayrollAdvance({advanceId:advance.id,amount:money.fromMinor(remainingMinor,unit),paymentDate,method,reference,notes,createdBy,paidFromRegister});
}

function recordPayrollSalaryAdvanceRecovery({monthId,employeeId,amountMinor,createdBy,sourcePaymentId}){
  const b=h.getCurrentBranch(); const m=payrollMonth(monthId); const unit=Number(h.getGlobalProfile()?.currency_minor_unit ?? 2);
  const paidMinor=Math.max(0,Number(amountMinor||0)); if(!paidMinor) return {recoveredMinor:0};
  const advanceRows=h.db.prepare(`SELECT a.* FROM payroll_advances a WHERE a.branch_id=? AND a.employee_id=? AND a.status='active' ORDER BY a.first_deduction_month,a.created_at,a.id`).all(b.id,Number(employeeId));
  let left=paidMinor, recovered=0;
  for(const a of advanceRows){
    if(left<=0) break;
    const already=Number(h.db.prepare('SELECT COALESCE(SUM(pa.amount_minor),0) x FROM payroll_advance_payment_allocations pa JOIN payroll_advance_payments p ON p.id=pa.payment_id WHERE p.voided_at IS NULL AND p.advance_id=?').get(a.id).x||0);
    const remaining=Math.max(0,Number(a.principal_minor)-already); if(!remaining) continue;
    const dueThisMonth=Number(h.db.prepare(`SELECT COALESCE(SUM(i.amount_minor),0) x FROM payroll_advance_installments i WHERE i.advance_id=? AND i.month_key=?`).get(a.id,m.month_key).x||0); if(!dueThisMonth) continue;
    // ملاحظة: كانت هذه القيمة تُحسب من دفعات payment_type='salary' فقط، فتتجاهل أي تسديد
    // مباشر (direct) سُدد لنفس القسط بنفس الشهر — فيؤدي لخصم القسط مرة ثانية من الراتب رغم
    // سداده جزئياً أو كلياً مسبقاً. الصواب هو حساب كل ما خُصص لهذا القسط بغض النظر عن نوع الدفعة.
    const alreadyThisMonth=Number(h.db.prepare(`SELECT COALESCE(SUM(pa.amount_minor),0) x FROM payroll_advance_payment_allocations pa JOIN payroll_advance_payments p ON p.id=pa.payment_id WHERE p.voided_at IS NULL AND p.advance_id=? AND pa.installment_id IN (SELECT id FROM payroll_advance_installments WHERE advance_id=? AND month_key=?)`).get(a.id,a.id,m.month_key).x||0);
    const openDue=Math.max(0,dueThisMonth-alreadyThisMonth); if(!openDue) continue;
    const alloc=Math.min(openDue,left,remaining); const paymentInfo=h.db.prepare(`INSERT INTO payroll_advance_payments(uuid,branch_id,advance_id,payment_type,amount,amount_minor,payment_date,method,reference,notes,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(h.uuid(),b.id,a.id,'salary',money.fromMinor(alloc,unit),alloc,`${m.month_key}-01`,'payroll',String(sourcePaymentId||'payroll_payment'),`خصم سلفة من راتب ${m.month_key}`,createdBy||null); const pid=Number(paymentInfo.lastInsertRowid);
    const inst=h.db.prepare(`SELECT id,amount_minor FROM payroll_advance_installments WHERE advance_id=? AND month_key=? ORDER BY installment_no`).all(a.id,m.month_key);
    let il=alloc;
    for(const i of inst){ if(il<=0) break; const alreadyI=Number(h.db.prepare(`SELECT COALESCE(SUM(pa.amount_minor),0) x FROM payroll_advance_payment_allocations pa JOIN payroll_advance_payments p ON p.id=pa.payment_id WHERE p.voided_at IS NULL AND pa.installment_id=?`).get(i.id).x||0); const openI=Math.max(0,Number(i.amount_minor)-alreadyI); if(!openI) continue; const q=Math.min(openI,il); h.db.prepare(`INSERT INTO payroll_advance_payment_allocations(payment_id,installment_id,amount,amount_minor) VALUES(?,?,?,?)`).run(pid,i.id,money.fromMinor(q,unit),q); il-=q; }
    recovered+=alloc; left-=alloc; const totalRecovered=already+alloc; if(totalRecovered>=Number(a.principal_minor)) h.db.prepare(`UPDATE payroll_advances SET status='completed',updated_at=datetime('now'),synced=0 WHERE id=? AND branch_id=?`).run(a.id,b.id);
  }
  return {recoveredMinor:recovered};
}


// إعدادات برنامج الولاء: معدّل منح النقاط عند البيع، ومعدّل استبدالها كخصم نقدي.
// نفس نمط getPayrollSettings/savePayrollSettings تماماً — قيمة افتراضية معقولة
// (10 = نقطة واحدة لكل 10 وحدات عملة إنفاقاً، و10 نقاط = وحدة عملة واحدة استبدالاً؛
// أي تعادل تام بين المنح والاستبدال افتراضياً) قابلة للتعديل من الإعدادات.
function getLoyaltySettings(){
  const unit=Number(h.getGlobalProfile()?.currency_minor_unit ?? 2);
  const earnRate=Number(h.getSetting('loyalty_earn_per_currency_unit','10'));
  const redeemRate=Number(h.getSetting('loyalty_points_per_currency_unit','10'));
  return{
    earnPerCurrencyUnit:Number.isFinite(earnRate)&&earnRate>0?earnRate:10,
    redeemPointsPerCurrencyUnit:Number.isFinite(redeemRate)&&redeemRate>0?redeemRate:10,
    currencyMinorUnit:unit,
  };
}
function saveLoyaltySettings({earnPerCurrencyUnit,redeemPointsPerCurrencyUnit}={}){
  const e=Number(earnPerCurrencyUnit),r=Number(redeemPointsPerCurrencyUnit);
  if(!Number.isFinite(e)||e<=0||e>100000) throw new Error('معدّل منح نقاط الولاء غير صالح.');
  if(!Number.isFinite(r)||r<=0||r>100000) throw new Error('معدّل استبدال نقاط الولاء غير صالح.');
  h.setSetting('loyalty_earn_per_currency_unit',String(e));
  h.setSetting('loyalty_points_per_currency_unit',String(r));
  return{success:true,earnPerCurrencyUnit:e,redeemPointsPerCurrencyUnit:r};
}

// أقصى عدد نقاط يمكن للعميل استبدالها فعلياً بفاتورة قيمتها المستحقة (قبل الاستبدال)
// payableMinor: محدود بأمرين معاً - (أ) رصيد نقاطه الفعلي بقاعدة البيانات، و(ب) ألا
// تجعل قيمة الاستبدال الإجمالي المستحق بالسالب. تُستخدم من الواجهة لعرض السقف مسبقاً،
// ومن resolveLoyaltyRedemption كمصدر الحقيقة الوحيد وقت إنشاء الفاتورة الفعلي.
function getLoyaltyRedemptionQuote(customerId, payableMinor){
  const branch=h.getCurrentBranch();
  const settings=getLoyaltySettings();
  const payable=Math.max(0,Number(payableMinor)||0);
  if(!customerId) return{availablePoints:0,redeemPointsPerCurrencyUnit:settings.redeemPointsPerCurrencyUnit,maxRedeemablePoints:0,maxRedeemableValueMinor:0};
  const customer=h.db.prepare('SELECT loyalty_points FROM customers WHERE id=? AND branch_id=?').get(Number(customerId),branch.id);
  if(!customer) throw new Error('العميل غير موجود.');
  const availablePoints=Math.max(0,Math.floor(Number(customer.loyalty_points||0)));
  const payableMajor=money.fromMinor(payable,settings.currencyMinorUnit);
  const maxPointsByPayable=Math.floor(payableMajor*settings.redeemPointsPerCurrencyUnit);
  const maxRedeemablePoints=Math.max(0,Math.min(availablePoints,maxPointsByPayable));
  const maxRedeemableValueMinor=maxRedeemablePoints>0?money.toMinor(maxRedeemablePoints/settings.redeemPointsPerCurrencyUnit,settings.currencyMinorUnit):0;
  return{availablePoints,redeemPointsPerCurrencyUnit:settings.redeemPointsPerCurrencyUnit,maxRedeemablePoints,maxRedeemableValueMinor};
}

// نسخة مريحة للواجهة الأمامية (pos.js لا يتعامل مع الوحدة الصغرى إطلاقاً بأي مكان تاني
// بكل الملف، فكل حساباته بالعملة الرئيسية مباشرة). تأخذ المبلغ المستحق بالعملة الرئيسية
// وتعيد أيضاً قيمة الاستبدال الأقصى بالعملة الرئيسية جاهزة للعرض مباشرة بدون أي تحويل
// إضافي بالواجهة. المنطق الفعلي نفسه بالكامل (نفس القيود والأسقف) — هذه غلاف عرض فقط.
function getLoyaltyRedemptionQuoteMajor(customerId, payableMajor){
  const unit=Number(h.getGlobalProfile()?.currency_minor_unit ?? 2);
  const payableMinor=money.toMinor(Math.max(0,Number(payableMajor)||0),unit);
  const quote=getLoyaltyRedemptionQuote(customerId,payableMinor);
  return{...quote,maxRedeemableValue:money.fromMinor(quote.maxRedeemableValueMinor,unit)};
}

// نقطة الحقيقة الوحيدة لتحويل عدد نقاط مطلوب إلى قيمته النقدية وقت إنشاء الفاتورة
// فعلياً — لا نثق أبداً برقم جاهز قادم من الواجهة، نعيد التحقق الكامل هنا دائماً.
function resolveLoyaltyRedemption(customerId, requestedPoints, payableMinor){
  const requested=Math.max(0,Math.floor(Number(requestedPoints)||0));
  if(requested<=0) return{points:0,valueMinor:0};
  if(!customerId) throw new Error('استبدال نقاط الولاء يتطلب اختيار عميل بالفاتورة.');
  const quote=getLoyaltyRedemptionQuote(customerId,payableMinor);
  if(requested>quote.availablePoints) throw new Error(`رصيد نقاط العميل غير كافٍ. المتاح حالياً: ${quote.availablePoints} نقطة.`);
  if(requested>quote.maxRedeemablePoints) throw new Error(`لا يمكن استبدال أكثر من ${quote.maxRedeemablePoints} نقطة بهذه الفاتورة (قيمة الاستبدال لا يمكن أن تتجاوز المبلغ المستحق).`);
  const unit=Number(h.getGlobalProfile()?.currency_minor_unit ?? 2);
  const valueMinor=money.toMinor(requested/quote.redeemPointsPerCurrencyUnit,unit);
  return{points:requested,valueMinor};
}

// نسبة الضريبة الافتراضية العامة: تُستخدم كقيمة مبدئية تُملأ تلقائياً عند إنشاء منتج
// جديد فقط (لا تُغيّر أي منتج موجود بأثر رجعي) — توفيراً لإدخالها يدوياً بكل منتج في
// الدول اللي عندها نسبة ضريبة موحدة على أغلب المنتجات. الضريبة الفعلية للفاتورة تبقى
// دائماً كما كانت: مأخوذة من tax_rate/الملف الضريبي الخاص بكل منتج لحاله وقت البيع.
// إظهار/إخفاء رمز QR على فاتورة العميل — بعض المحلات لا تحتاجه (لا رابط تتبع أو تقييم
// مرتبط به مثلاً) وتفضّل فاتورة أبسط وأقصر مساحة على الطابعة الحرارية.
function getReceiptBarcodeEnabled(){
  return h.getSetting('receipt_barcode_enabled','1') !== '0';
}
function setReceiptBarcodeEnabled(enabled){
  h.setSetting('receipt_barcode_enabled', enabled ? '1' : '0');
  return{success:true,enabled:!!enabled};
}

// إظهار/إخفاء رابط "الكاشير السريع" (شاشة بيع تعمل باللمس فقط: لوحة أرقام لإدخال
// الباركود/الكود يدوياً + شبكة صور للأصناف الشائعة بلا كتابة اسم) — مخصّصة لمحلات
// كالبقالة حيث الكاشير قد لا يملك لوحة مفاتيح أو لا يجيد القراءة/الكتابة. مطفأة
// افتراضياً، ويُفعِّلها المدير لكل فرع يحتاجها من الإعدادات، ويُخفيها عن باقي المحلات.
function getQuickCashierEnabled(){
  return h.getSetting('quick_cashier_enabled','0') === '1';
}
function setQuickCashierEnabled(enabled){
  h.setSetting('quick_cashier_enabled', enabled ? '1' : '0');
  return{success:true,enabled:!!enabled};
}

// إظهار/إخفاء تبويب "العروض" (الحزم النشطة) في شاشة الكاشير — بعض المحلات لا
// تستخدم نظام الحزم إطلاقاً وتفضّل شريط أقسام أبسط بدون هذا التبويب الإضافي.
function getOffersCategoryEnabled(){
  return h.getSetting('pos_offers_category_enabled','1') !== '0';
}
function setOffersCategoryEnabled(enabled){
  h.setSetting('pos_offers_category_enabled', enabled ? '1' : '0');
  return{success:true,enabled:!!enabled};
}

// صورة مخصّصة لتبويب "العروض" نفسه (وليس لأي حزمة بمفردها) — تُحفظ كنص مسار
// عادي بجدول الإعدادات لأن "العروض" ليست فئة حقيقية بجدول categories.
function getOffersCategoryImage(){
  const v = h.getSetting('pos_offers_category_image', '');
  return v || null;
}
function setOffersCategoryImage(imagePath){
  h.setSetting('pos_offers_category_image', imagePath ? String(imagePath) : '');
  return{success:true,imagePath: imagePath ? String(imagePath) : null};
}

function getTaxDefaultRate(){
  const v=Number(h.getSetting('default_tax_rate','0'));
  return Number.isFinite(v)&&v>=0&&v<=100?v:0;
}
function saveTaxDefaultRate(rate){
  const v=Number(rate);
  if(!Number.isFinite(v)||v<0||v>100) throw new Error('نسبة الضريبة الافتراضية يجب أن تكون بين 0 و100.');
  h.setSetting('default_tax_rate',String(v));
  return{success:true,defaultTaxRate:v};
}

function getPayrollSettings(){const unit=Number(h.getGlobalProfile()?.currency_minor_unit ?? 2),m=Number(h.getSetting('payroll_overtime_multiplier','1.5')),h=Number(h.getSetting('payroll_work_hours_per_day','8'));return{overtimeMultiplier:Number.isFinite(m)&&m>0?m:1.5,workHoursPerDay:Number.isFinite(h)&&h>0?h:8,currencyMinorUnit:unit};}
function savePayrollSettings({overtimeMultiplier,workHoursPerDay}={}){const m=Number(overtimeMultiplier),h=Number(workHoursPerDay);if(!Number.isFinite(m)||m<=0||m>10)throw new Error('معامل الإضافي يجب أن يكون بين 0 و10.');if(!Number.isFinite(h)||h<=0||h>24)throw new Error('ساعات العمل اليومية يجب أن تكون بين 0 و24.');h.setSetting('payroll_overtime_multiplier',String(m));h.setSetting('payroll_work_hours_per_day',String(h));return{success:true,overtimeMultiplier:m,workHoursPerDay:h};}
function setPayrollV2RegularHours(monthId,employeeId,hours){ const b=h.getCurrentBranch(); const m=payrollMonth(monthId); assertPayrollMonthMutable(m); const n=Number(hours); if(!Number.isFinite(n)||n<0||n>744)throw new Error('ساعات العمل غير صالحة.'); const e=h.db.prepare('SELECT id,pay_type,pay_rate FROM payroll_employees WHERE id=? AND branch_id=?').get(Number(employeeId),b.id); if(!e)throw new Error('العامل غير موجود.'); h.db.prepare(`INSERT INTO payroll_employee_months(month_id,employee_id,pay_type,pay_rate,base_amount) VALUES(?,?,?,?,0) ON CONFLICT(month_id,employee_id) DO NOTHING`).run(m.id,e.id,e.pay_type,e.pay_rate); h.db.prepare('UPDATE payroll_employee_months SET regular_hours=?,updated_at=datetime(\'now\'),synced=0 WHERE month_id=? AND employee_id=?').run(Math.round(n*100)/100,m.id,e.id); return{success:true,item:recalcPayrollEmployeeMonth(m.id,e.id)}; }
function recordPayrollPayment({monthId, employeeId, amount, method='cash', paymentDate, reference, notes, createdBy}) {
  const b = h.getCurrentBranch(); const unit=Number(h.getGlobalProfile()?.currency_minor_unit ?? 2);
  const m = payrollMonth(monthId);
  assertPayrollMonthMutable(m);
  const state = getPayrollEmployeePaymentState(m.id, employeeId);
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) throw new Error('مبلغ صرف الراتب غير صالح.');
  if (!['cash','bank','other'].includes(String(method))) throw new Error('طريقة صرف الراتب غير صالحة.');
  const amountMinor = money.toMinor(value, unit);
  if (amountMinor <= 0) throw new Error('مبلغ صرف الراتب يجب أن يكون أكبر من صفر.');
  if (amountMinor > state.remainingMinor) throw new Error(`المبلغ أكبر من المتبقي للموظف. المتبقي: ${money.fromMinor(state.remainingMinor, unit)}`);
  const date = String(paymentDate || payrollTodayLocal().toISOString().slice(0, 10)).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('تاريخ صرف الراتب غير صالح.');
  if (date.slice(0,7) !== m.month_key) throw new Error('تاريخ صرف الراتب يجب أن يكون ضمن الشهر المحدد.');
  const tx = h.db.transaction(() => {
    // نضمن أولاً أن كامل المستحق الحالي للموظف هذا الشهر مُعترف به مصروفاً بدفتر اليومية
    // (مدين 6100 / دائن 2300 "رواتب مستحقة") قبل أي صرف فعلي — هذا يمنع نهائياً ظهور
    // مصروف رواتب أقل من المستحق الحقيقي بقائمة الدخل (كان يظهر فقط بقدر ما صُرف نقداً).
    syncPayrollEmployeeAccrual(m.id, employeeId, { createdBy, entryDate: date });
    let cashMovementId = null;
    if (method === 'cash') {
      const shift = h.getOpenShift();
      if (!shift) throw new Error('لا يمكن صرف الراتب نقداً بدون وردية صندوق مفتوحة. افتح وردية أولاً أو اختر التحويل/أخرى.');
      const cm = h.addCashMovement({shiftId: shift.id, type:'cash_out', amount:money.fromMinor(amountMinor, unit), reason:`صرف راتب: ${state.item.full_name}`, reference:reference || 'payroll_salary', createdBy});
      cashMovementId = cm.id;
    }
    const info = h.db.prepare(`INSERT INTO payroll_payments(uuid,branch_id,month_id,employee_id,amount,amount_minor,method,payment_date,reference,notes,created_by,cash_movement_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(h.uuid(), b.id, m.id, state.item.employee_id, money.fromMinor(amountMinor, unit), amountMinor, method, date, String(reference||'').trim()||null, String(notes||'').trim()||null, createdBy||null, cashMovementId);
    const nextPaid = state.paidMinor + amountMinor;
    const monthItems = h.db.prepare(`SELECT m.employee_id,m.net_salary,e.is_active FROM payroll_employee_months m JOIN payroll_employees e ON e.id=m.employee_id WHERE m.month_id=?`).all(m.id);
    let allPaid = true;
    for (const row of monthItems.filter(x => Number(x.is_active)!==0)) {
      const net = money.toMinor(Number(row.net_salary||0), unit);
      const paid = h.db.prepare('SELECT COALESCE(SUM(amount_minor),0) x FROM payroll_payments WHERE branch_id=? AND month_id=? AND employee_id=?').get(b.id,m.id,row.employee_id).x;
      if (Number(paid) < net) { allPaid = false; break; }
    }
    if (allPaid && monthItems.some(x => Number(x.is_active)!==0)) {
      h.db.prepare(`UPDATE payroll_months SET status='paid',closed_at=datetime('now'),closed_by=?,synced=0 WHERE id=? AND branch_id=?`).run(createdBy||null,m.id,b.id);
    }
    const finalSalaryPayment = nextPaid >= state.netMinor;
    const scheduledRecoveryMinor = finalSalaryPayment ? money.toMinor(Number(state.item.advance_total || 0), unit) : 0;
    const recovery = scheduledRecoveryMinor > 0 ? recordPayrollSalaryAdvanceRecovery({monthId:m.id,employeeId:Number(employeeId),amountMinor:scheduledRecoveryMinor,createdBy,sourcePaymentId:Number(info.lastInsertRowid)}) : {recoveredMinor:0};
    // قيد محاسبي: صرف صافي الراتب يسوّي 2300 نقداً. استرداد السلفة من الراتب يغلق 1400
    // ويزيد المصروف 6100 بمقدار المسترد (لأن الاستحقاق كان على الصافي بعد خصم السلفة).
    const settleCode = method === 'cash' ? '1000' : '1100';
    const recoveredMinor = Math.max(0, Number(recovery.recoveredMinor || 0));
    const payLines = [
      { accountId: h.getAccountingAccountId(b.id, '2300'), debitMinor: amountMinor, creditMinor: 0, memo: `تسوية مستحق راتب ${state.item.full_name}` },
      { accountId: h.getAccountingAccountId(b.id, settleCode), debitMinor: 0, creditMinor: amountMinor, memo: `صرف راتب ${state.item.full_name}` },
    ];
    if (recoveredMinor > 0) {
      payLines.push({ accountId: h.getAccountingAccountId(b.id, '6100'), debitMinor: recoveredMinor, creditMinor: 0, memo: `استرداد سلفة من راتب ${state.item.full_name}` });
      payLines.push({ accountId: h.getAccountingAccountId(b.id, '1400'), debitMinor: 0, creditMinor: recoveredMinor, memo: `إغلاق سلف موظفين ${state.item.full_name}` });
    }
    h.insertPostedJournalEntry({
      branchId: b.id, memo: `صرف راتب: ${state.item.full_name}`, referenceType: 'payroll_payment', referenceId: Number(info.lastInsertRowid), entryDate: date,
      lines: payLines, createdBy,
    });
    return {success:true,id:Number(info.lastInsertRowid),cashMovementId,amountMinor,remainingMinor:Math.max(0,state.remainingMinor-amountMinor),monthStatus:allPaid?'paid':'open',advanceRecoveredMinor:recovery.recoveredMinor};
  })();
  return tx;
}

function calculatePayrollFinalSettlement(monthId, employeeId, settlementDate, additionalCompensation=0) {
  const b=h.getCurrentBranch(); const m=payrollMonth(monthId);
  const date=String(settlementDate||'').slice(0,10);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date) || date.slice(0,7)!==m.month_key) throw new Error('تاريخ إنهاء الخدمة يجب أن يكون ضمن شهر الرواتب المحدد.');
  const employee=h.db.prepare('SELECT * FROM payroll_employees WHERE id=? AND branch_id=?').get(Number(employeeId),b.id);
  if(!employee) throw new Error('العامل غير موجود.');
  const existing=h.db.prepare("SELECT id FROM payroll_final_settlements WHERE branch_id=? AND employee_id=? AND status='paid' ORDER BY id DESC LIMIT 1").get(b.id,employee.id);
  if(existing) throw new Error('تمت تسوية الموظف سابقاً.');
  const item=recalcPayrollEmployeeMonth(m.id,employee.id,{asOfDate:date});
  const unit=Number(h.getGlobalProfile()?.currency_minor_unit ?? 2);
  const grossEarned=Number(item.base_amount||0)-Number(item.absence_deduction||0)+Number(item.bonus_total||0)+Number(item.overtime_total||0);
  const deductions=Number(item.deduction_total||0);
  const advanceRows=listPayrollAdvances(employee.id);
  const advanceBalanceMinor=advanceRows.reduce((sum,a)=>sum+Number(a.remaining_minor||0),0);
  const paidMinor=Number(h.db.prepare('SELECT COALESCE(SUM(amount_minor),0) x FROM payroll_payments WHERE branch_id=? AND month_id=? AND employee_id=?').get(b.id,m.id,employee.id).x||0);
  const additionalMinor=money.toMinor(Number(additionalCompensation||0),unit);
  if(additionalMinor<0) throw new Error('التعويض الإضافي غير صالح.');
  const grossMinor=Math.max(0,money.toMinor(grossEarned,unit));
  const deductionsMinor=Math.max(0,money.toMinor(deductions,unit));
  const finalGrossAfterDeductions=Math.max(0,grossMinor-deductionsMinor);
  const netDueBeforePaid=Math.max(0,finalGrossAfterDeductions+additionalMinor-advanceBalanceMinor);
  const netDueMinor=Math.max(0,netDueBeforePaid-paidMinor);
  return {employee,month:m,item,date,unit,grossMinor,deductionsMinor,advanceBalanceMinor,additionalMinor,paidMinor,netDueMinor,
    grossEarned:money.fromMinor(grossMinor,unit),deductions:money.fromMinor(deductionsMinor,unit),advanceBalance:money.fromMinor(advanceBalanceMinor,unit),
    additionalCompensation:money.fromMinor(additionalMinor,unit),paidAmount:money.fromMinor(paidMinor,unit),netDue:money.fromMinor(netDueMinor,unit)};
}

function settleEmployeeFinalPayroll({monthId,employeeId,settlementDate,additionalCompensation=0,method='cash',notes,createdBy,paidFromRegister=true,terminationReason}) {
  const b=h.getCurrentBranch(); const unit=Number(h.getGlobalProfile()?.currency_minor_unit ?? 2);
  const data=calculatePayrollFinalSettlement(monthId,employeeId,settlementDate,additionalCompensation);
  if(!['cash','bank','other'].includes(String(method))) throw new Error('طريقة دفع التسوية غير صالحة.');
  const tx=h.db.transaction(()=>{
    let cashMovementId=null;
    if(data.netDueMinor>0 && method==='cash') {
      if(!paidFromRegister) throw new Error('التسوية النقدية يجب أن تُسجل من الصندوق حفاظاً على دقة النقدية.');
      const shift=h.getOpenShift(); if(!shift) throw new Error('لا يمكن دفع التسوية نقداً دون وردية صندوق مفتوحة.');
      const cm=h.addCashMovement({shiftId:shift.id,type:'cash_out',amount:money.fromMinor(data.netDueMinor,unit),reason:`تصفية موظف: ${data.employee.full_name}`,reference:`payroll_final_settlement:${data.employee.id}`,createdBy});
      cashMovementId=cm.id;
    }
    // التسوية النهائية تسدد كامل رصيد السلف ضمنياً. نسجلها كدفعة direct بدون حركة cash-in
    // لأنها جزء من المقاصة على مستحق الراتب، وليست مبلغاً عاد إلى الصندوق من الموظف.
    let left=data.advanceBalanceMinor;
    const advances=listPayrollAdvances(data.employee.id).filter(a=>Number(a.remaining_minor||0)>0);
    for(const a of advances){
      if(left<=0) break;
      let remainingA=Number(a.remaining_minor||0);
      const paymentInfo=h.db.prepare(`INSERT INTO payroll_advance_payments(uuid,branch_id,advance_id,payment_type,amount,amount_minor,payment_date,method,reference,notes,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
        .run(h.uuid(),b.id,a.id,'direct',money.fromMinor(remainingA,unit),remainingA,data.date,'settlement',`payroll_final_settlement:${data.employee.id}`,'تسوية رصيد السلفة ضمن التصفية النهائية',createdBy||null);
      const pid=Number(paymentInfo.lastInsertRowid);
      const installments=h.db.prepare(`SELECT i.* FROM payroll_advance_installments i WHERE i.advance_id=? ORDER BY i.month_key,i.installment_no`).all(a.id);
      let allocLeft=remainingA;
      for(const i of installments){
        if(allocLeft<=0) break;
        const already=Number(h.db.prepare(`SELECT COALESCE(SUM(CASE WHEN p.payment_type='direct' THEN pa.amount_minor ELSE 0 END),0) x FROM payroll_advance_payment_allocations pa JOIN payroll_advance_payments p ON p.id=pa.payment_id WHERE p.voided_at IS NULL AND pa.installment_id=?`).get(i.id).x||0);
        const openI=Math.max(0,Number(i.amount_minor)-already); if(!openI) continue;
        const q=Math.min(openI,allocLeft);
        h.db.prepare(`INSERT INTO payroll_advance_payment_allocations(payment_id,installment_id,amount,amount_minor) VALUES(?,?,?,?)`).run(pid,i.id,money.fromMinor(q,unit),q);
        allocLeft-=q;
      }
      h.db.prepare(`UPDATE payroll_advances SET status='completed',updated_at=datetime('now'),synced=0 WHERE id=? AND branch_id=?`).run(a.id,b.id);
      left-=remainingA;
    }
    const info=h.db.prepare(`INSERT INTO payroll_final_settlements(uuid,branch_id,employee_id,month_id,settlement_date,gross_earned,deductions,advance_balance,additional_compensation,net_due,paid_amount,gross_earned_minor,deductions_minor,advance_balance_minor,additional_compensation_minor,net_due_minor,paid_amount_minor,method,cash_movement_id,notes,created_by,status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(h.uuid(),b.id,data.employee.id,data.month.id,data.date,data.grossEarned,data.deductions,data.advanceBalance,data.additionalCompensation,data.netDue,data.netDue,
        data.grossMinor,data.deductionsMinor,data.advanceBalanceMinor,data.additionalMinor,data.netDueMinor,data.netDueMinor,method,cashMovementId,String(notes||'').trim()||null,createdBy||null,'paid');
    h.db.prepare(`UPDATE payroll_employees SET is_active=0,terminated_at=?,termination_reason=?,updated_at=datetime('now'),synced=0 WHERE id=? AND branch_id=?`).run(data.date,String(terminationReason||'').trim()||null,data.employee.id,b.id);
    // قيد محاسبي للتصفية النهائية: صرف المستحق نقداً + إغلاق سلف 1400
    {
      const settleCode = method === 'cash' ? '1000' : '1100';
      const lines = [];
      const payMinor = Math.max(0, Number(data.netDueMinor || 0));
      const advMinor = Math.max(0, Number(data.advanceBalanceMinor || 0));
      if (payMinor > 0) {
        lines.push({ accountId: h.getAccountingAccountId(b.id, '6100'), debitMinor: payMinor, creditMinor: 0, memo: `تصفية نهائية راتب ${data.employee.full_name}` });
        lines.push({ accountId: h.getAccountingAccountId(b.id, settleCode), debitMinor: 0, creditMinor: payMinor, memo: `صرف تصفية ${data.employee.full_name}` });
      }
      if (advMinor > 0) {
        lines.push({ accountId: h.getAccountingAccountId(b.id, '6100'), debitMinor: advMinor, creditMinor: 0, memo: `إغلاق سلف ضمن تصفية ${data.employee.full_name}` });
        lines.push({ accountId: h.getAccountingAccountId(b.id, '1400'), debitMinor: 0, creditMinor: advMinor, memo: `تصفية سلف موظفين ${data.employee.full_name}` });
      }
      if (lines.length) {
        h.insertPostedJournalEntry({
          branchId: b.id, memo: `تصفية نهائية: ${data.employee.full_name}`, referenceType: 'payroll_final_settlement',
          referenceId: Number(info.lastInsertRowid), entryDate: data.date, lines, createdBy: createdBy || null,
        });
      }
    }
    return {id:Number(info.lastInsertRowid),cashMovementId};
  })();
  return {success:true,id:tx.id,employeeId:data.employee.id,employeeName:data.employee.full_name,netDue:data.netDue,advanceSettled:data.advanceBalance,paidAmount:data.netDue,status:'paid',cashMovementId:tx.cashMovementId};
}

function listPayrollFinalSettlements(employeeId=null) {
  const b=h.getCurrentBranch(); const unit=Number(h.getGlobalProfile()?.currency_minor_unit ?? 2);
  const rows=h.db.prepare(`SELECT s.*,e.full_name employee_name,m.month_key FROM payroll_final_settlements s JOIN payroll_employees e ON e.id=s.employee_id JOIN payroll_months m ON m.id=s.month_id WHERE s.branch_id=? ${employeeId!=null?'AND s.employee_id=?':''} ORDER BY s.settlement_date DESC,s.id DESC`).all(...(employeeId!=null?[b.id,Number(employeeId)]:[b.id]));
  return rows.map(r=>({...r,grossEarned:money.fromMinor(Number(r.gross_earned_minor||0),unit),deductions:money.fromMinor(Number(r.deductions_minor||0),unit),advanceBalance:money.fromMinor(Number(r.advance_balance_minor||0),unit),additionalCompensation:money.fromMinor(Number(r.additional_compensation_minor||0),unit),netDue:money.fromMinor(Number(r.net_due_minor||0),unit),paidAmount:money.fromMinor(Number(r.paid_amount_minor||0),unit)}));
}

function listPayrollPayments(monthId, employeeId=null) {
  const b=h.getCurrentBranch(); const m=payrollMonth(monthId);
  const rows=h.db.prepare(`SELECT p.*,e.full_name employee_name FROM payroll_payments p JOIN payroll_employees e ON e.id=p.employee_id WHERE p.branch_id=? AND p.month_id=? ${employeeId!=null?'AND p.employee_id=?':''} ORDER BY p.payment_date DESC,p.id DESC`).all(...(employeeId!=null?[b.id,m.id,Number(employeeId)]:[b.id,m.id]));
  return rows;
}

function voidPayrollFinalSettlement(settlementId, reason, voidedBy) {
  const b=h.getCurrentBranch(); const id=Number(settlementId); const text=String(reason||'').trim();
  if(!Number.isInteger(id)||id<=0) throw new Error('معرّف التسوية غير صالح.');
  if(text.length<10) throw new Error('سبب إلغاء التصفية يجب ألا يقل عن 10 محارف.');
  const s=h.db.prepare('SELECT * FROM payroll_final_settlements WHERE id=? AND branch_id=?').get(id,b.id);
  if(!s) throw new Error('التصفية النهائية غير موجودة.');
  if(String(s.status)!=='paid') throw new Error('هذه التصفية ملغاة بالفعل.');
  h.db.transaction(()=>{
    h.db.prepare(`UPDATE payroll_final_settlements SET status='voided',voided_at=datetime('now'),void_reason=?,updated_at=datetime('now'),synced=0 WHERE id=? AND branch_id=?`).run(text,id,b.id);
    h.db.prepare("UPDATE payroll_employees SET is_active=1,terminated_at=NULL,termination_reason=NULL,updated_at=datetime('now') WHERE id=? AND branch_id=?").run(Number(s.employee_id),b.id);
    if(Number(s.cash_movement_id)>0){
      const cm=h.db.prepare('SELECT * FROM cash_movements WHERE id=? AND branch_id=?').get(Number(s.cash_movement_id),b.id);
      if(cm){
        const openShift=h.getOpenShift();
        if(!openShift) throw new Error('لا يمكن إلغاء تصفية نقدية بدون وردية مفتوحة لتسجيل حركة العكس في الصندوق.');
        h.db.prepare(`INSERT INTO cash_movements(uuid,branch_id,shift_id,type,amount,amount_minor,reason,reference,created_by,created_at,synced) VALUES(?,?,?,?,?,?,?,?,?,datetime('now'),0)`).run(h.uuid(),b.id,openShift.id,'cash_in',cm.amount,cm.amount_minor,'عكس تصفية موظف',`void:payroll_final_settlement:${id}`,voidedBy||null);
      }
    }
    const refs=[`payroll_final_settlement:${s.employee_id}`, `payroll_final_settlement:${Number(s.employee_id)}`];
    const aps=h.db.prepare(`SELECT id FROM payroll_advance_payments WHERE branch_id=? AND reference=? AND voided_at IS NULL`).all(b.id,refs[0]);
    for(const ap of aps) h.db.prepare(`UPDATE payroll_advance_payments SET voided_at=datetime('now'),void_reason=? WHERE id=?`).run(`إلغاء التصفية النهائية ${id}`,ap.id);
  })();
  return {success:true,id,status:'voided'};
}

function reopenPayrollMonth(monthId, reason, reopenedBy) {
  const b=h.getCurrentBranch(); const m=payrollMonth(monthId);
  if (String(m.status)!=='paid') return {success:true,status:m.status};
  const text=String(reason||'').trim(); if(text.length<10) throw new Error('سبب إعادة فتح شهر الرواتب يجب ألا يقل عن 10 محارف.');
  // لا نحذف ولا نعدل دفعات سابقة. إعادة الفتح تسمح فقط بتسجيل تصحيح جديد.
  h.db.prepare(`UPDATE payroll_months SET status='open',closed_at=NULL,closed_by=NULL,synced=0 WHERE id=? AND branch_id=?`).run(m.id,b.id);
  return {success:true,status:'open',reason:text};
}

function getPayrollV2Employee(monthId,employeeId){ const m=payrollMonth(monthId), b=h.getCurrentBranch(); recalcPayrollEmployeeMonth(m.id,Number(employeeId)); const employee=h.db.prepare(`SELECT e.*,m.month_id,pm.month_key,m.pay_type,m.pay_rate,m.base_amount,m.base_amount_minor,m.regular_hours,m.absence_days,m.absence_deduction,m.bonus_total,m.deduction_total,m.advance_total,m.overtime_total,m.net_salary,m.net_salary_minor,m.debt_carry,m.debt_carry_minor FROM payroll_employee_months m JOIN payroll_employees e ON e.id=m.employee_id JOIN payroll_months pm ON pm.id=m.month_id WHERE m.month_id=? AND m.employee_id=? AND e.branch_id=?`).get(m.id,Number(employeeId),b.id); if(!employee)throw new Error('العامل غير موجود في هذا الشهر.'); const unit=Number(h.getGlobalProfile()?.currency_minor_unit ?? 2); const paid=h.db.prepare('SELECT COALESCE(SUM(amount_minor),0) paid_minor,COALESCE(SUM(amount),0) paid_amount FROM payroll_payments WHERE branch_id=? AND month_id=? AND employee_id=?').get(b.id,m.id,Number(employeeId)); const paidMinor=Number(paid?.paid_minor||0),netMinor=money.toMinor(Number(employee.net_salary||0),unit); employee.paid_total=money.fromMinor(paidMinor,unit); employee.paid_total_minor=paidMinor; employee.remaining_salary=money.fromMinor(Math.max(0,netMinor-paidMinor),unit); employee.remaining_salary_minor=Math.max(0,netMinor-paidMinor); employee.payment_status=paidMinor>=netMinor?'paid':paidMinor>0?'partial':'unpaid'; const transactions=h.db.prepare('SELECT * FROM payroll_transactions WHERE month_id=? AND employee_id=? ORDER BY event_date DESC,id DESC').all(m.id,Number(employeeId)); const payments=listPayrollPayments(m.id,Number(employeeId)); return {employee,transactions,payments,monthStatus:m.status||'open'}; }


  return {
    normalizePayrollMonth,
    daysInPayrollMonth,
    parsePayrollDateLocal,
    payrollTodayLocal,
    daysElapsedInPayrollPeriod,
    payrollDaysElapsedThrough,
    payrollMonth,
    getOrCreatePayrollMonth,
    payrollMultiplyDivideMinor,
    payrollRatioMinor,
    recalcPayrollEmployeeMonth,
    listPayrollV2Employees,
    addPayrollV2Employee,
    updatePayrollV2Employee,
    setPayrollV2EmployeeActive,
    deletePayrollV2Employee,
    getPayrollV2Report,
    getPayrollV2Month,
    assertPayrollMonthMutable,
    getPayrollEmployeePaymentState,
    syncPayrollEmployeeAccrual,
    accruePayrollMonth,
    addPayrollV2Transaction,
    removePayrollV2Transaction,
    setPayrollEmployeeMonthStartDate,
    normalizePayrollFirstDeductionMonth,
    currentPayrollMonthKey,
    addMonthsToPayrollMonth,
    createPayrollAdvance,
    listPayrollAdvances,
    listPayrollAdvancePayments,
    repayPayrollAdvance,
    settlePayrollAdvance,
    recordPayrollSalaryAdvanceRecovery,
    getLoyaltySettings,
    saveLoyaltySettings,
    getLoyaltyRedemptionQuote,
    getLoyaltyRedemptionQuoteMajor,
    resolveLoyaltyRedemption,
    getReceiptBarcodeEnabled,
    setReceiptBarcodeEnabled,
    getQuickCashierEnabled,
    setQuickCashierEnabled,
    getOffersCategoryEnabled,
    setOffersCategoryEnabled,
    getOffersCategoryImage,
    setOffersCategoryImage,
    getTaxDefaultRate,
    saveTaxDefaultRate,
    getPayrollSettings,
    savePayrollSettings,
    setPayrollV2RegularHours,
    recordPayrollPayment,
    calculatePayrollFinalSettlement,
    settleEmployeeFinalPayroll,
    listPayrollFinalSettlements,
    listPayrollPayments,
    voidPayrollFinalSettlement,
    reopenPayrollMonth,
    getPayrollV2Employee
  };
};
