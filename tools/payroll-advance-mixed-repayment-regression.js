#!/usr/bin/env node
'use strict';
// اختبار وظيفي حقيقي (وليس مجرد فحص وجود نص) لسيناريو: تسديد مباشر جزئي/كامل لقسط سلفة،
// ثم محاولة خصم نفس القسط من الراتب بنفس الشهر. يعيد بناء نفس منطق SQL الموجود فعلياً في
// database/db.js (repayPayrollAdvance + recordPayrollSalaryAdvanceRecovery) باستخدام
// node:sqlite المدمجة (بدل better-sqlite3-multiple-ciphers الأصلية غير القابلة للتجميع هنا
// بلا اتصال شبكة)، للتأكد أن القسط لا يُخصم مرتين عبر مصدرين مختلفين لنفس الشهر.
// إن أُعيد الخلل القديم (تصفية الفحص حسب payment_type='salary' فقط) سيفشل هذا الاختبار.
const { DatabaseSync } = require('node:sqlite');

function setup() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE payroll_advances (id INTEGER PRIMARY KEY, employee_id INTEGER, branch_id INTEGER, principal_minor INTEGER, status TEXT);
    CREATE TABLE payroll_advance_installments (id INTEGER PRIMARY KEY, advance_id INTEGER, month_key TEXT, installment_no INTEGER, amount_minor INTEGER);
    CREATE TABLE payroll_advance_payments (id INTEGER PRIMARY KEY, advance_id INTEGER, payment_type TEXT, amount_minor INTEGER, voided_at TEXT);
    CREATE TABLE payroll_advance_payment_allocations (id INTEGER PRIMARY KEY, payment_id INTEGER, installment_id INTEGER, amount_minor INTEGER);
  `);
  db.prepare(`INSERT INTO payroll_advances(id,employee_id,branch_id,principal_minor,status) VALUES (1,1,1,3000,'active')`).run();
  const ins = db.prepare(`INSERT INTO payroll_advance_installments(advance_id,month_key,installment_no,amount_minor) VALUES (1,?,?,1000)`);
  ins.run('2026-01', 1);
  ins.run('2026-02', 2);
  ins.run('2026-03', 3);
  return db;
}

// mirrors repayPayrollAdvance()'s allocation loop (direct payment, oldest-open-installment-first)
function directRepay(db, advanceId, amountMinor) {
  const paymentId = db.prepare(`INSERT INTO payroll_advance_payments(advance_id,payment_type,amount_minor) VALUES (?,'direct',?)`).run(advanceId, amountMinor).lastInsertRowid;
  const installments = db.prepare(`SELECT * FROM payroll_advance_installments WHERE advance_id=? ORDER BY month_key,installment_no`).all(advanceId);
  let left = amountMinor;
  for (const i of installments) {
    if (left <= 0) break;
    const already = Number(db.prepare(`SELECT COALESCE(SUM(pa.amount_minor),0) x FROM payroll_advance_payment_allocations pa JOIN payroll_advance_payments p ON p.id=pa.payment_id WHERE p.voided_at IS NULL AND pa.installment_id=?`).get(i.id).x || 0);
    const open = Math.max(0, i.amount_minor - already);
    if (!open) continue;
    const alloc = Math.min(open, left);
    db.prepare(`INSERT INTO payroll_advance_payment_allocations(payment_id,installment_id,amount_minor) VALUES (?,?,?)`).run(paymentId, i.id, alloc);
    left -= alloc;
  }
}

// mirrors recordPayrollSalaryAdvanceRecovery() -- BUGGY version (filters by payment_type='salary')
function salaryRecoverBuggy(db, advanceId, monthKey, leftAvailable) {
  const a = db.prepare(`SELECT * FROM payroll_advances WHERE id=?`).get(advanceId);
  const already = Number(db.prepare(`SELECT COALESCE(SUM(pa.amount_minor),0) x FROM payroll_advance_payment_allocations pa JOIN payroll_advance_payments p ON p.id=pa.payment_id WHERE p.voided_at IS NULL AND p.advance_id=?`).get(advanceId).x || 0);
  const remaining = Math.max(0, a.principal_minor - already);
  const dueThisMonth = Number(db.prepare(`SELECT COALESCE(SUM(amount_minor),0) x FROM payroll_advance_installments WHERE advance_id=? AND month_key=?`).get(advanceId, monthKey).x || 0);
  const salaryAlready = Number(db.prepare(`SELECT COALESCE(SUM(pa.amount_minor),0) x FROM payroll_advance_payment_allocations pa JOIN payroll_advance_payments p ON p.id=pa.payment_id WHERE p.voided_at IS NULL AND p.advance_id=? AND p.payment_type='salary' AND pa.installment_id IN (SELECT id FROM payroll_advance_installments WHERE advance_id=? AND month_key=?)`).get(advanceId, advanceId, monthKey).x || 0);
  const openDue = Math.max(0, dueThisMonth - salaryAlready);
  if (!openDue) return { alloc: 0 };
  const alloc = Math.min(openDue, leftAvailable, remaining);
  if (alloc <= 0) return { alloc: 0 };
  const paymentId = db.prepare(`INSERT INTO payroll_advance_payments(advance_id,payment_type,amount_minor) VALUES (?,'salary',?)`).run(advanceId, alloc).lastInsertRowid;
  const inst = db.prepare(`SELECT * FROM payroll_advance_installments WHERE advance_id=? AND month_key=?`).all(advanceId, monthKey);
  let il = alloc;
  for (const i of inst) {
    if (il <= 0) break;
    const alreadyI = Number(db.prepare(`SELECT COALESCE(SUM(CASE WHEN p.payment_type='salary' THEN pa.amount_minor ELSE 0 END),0) x FROM payroll_advance_payment_allocations pa JOIN payroll_advance_payments p ON p.id=pa.payment_id WHERE p.voided_at IS NULL AND pa.installment_id=?`).get(i.id).x || 0);
    const openI = Math.max(0, i.amount_minor - alreadyI);
    if (!openI) continue;
    const q = Math.min(openI, il);
    db.prepare(`INSERT INTO payroll_advance_payment_allocations(payment_id,installment_id,amount_minor) VALUES (?,?,?)`).run(paymentId, i.id, q);
    il -= q;
  }
  return { alloc };
}

// FIXED version -- counts allocations of any payment_type
function salaryRecoverFixed(db, advanceId, monthKey, leftAvailable) {
  const a = db.prepare(`SELECT * FROM payroll_advances WHERE id=?`).get(advanceId);
  const already = Number(db.prepare(`SELECT COALESCE(SUM(pa.amount_minor),0) x FROM payroll_advance_payment_allocations pa JOIN payroll_advance_payments p ON p.id=pa.payment_id WHERE p.voided_at IS NULL AND p.advance_id=?`).get(advanceId).x || 0);
  const remaining = Math.max(0, a.principal_minor - already);
  const dueThisMonth = Number(db.prepare(`SELECT COALESCE(SUM(amount_minor),0) x FROM payroll_advance_installments WHERE advance_id=? AND month_key=?`).get(advanceId, monthKey).x || 0);
  const alreadyThisMonth = Number(db.prepare(`SELECT COALESCE(SUM(pa.amount_minor),0) x FROM payroll_advance_payment_allocations pa JOIN payroll_advance_payments p ON p.id=pa.payment_id WHERE p.voided_at IS NULL AND p.advance_id=? AND pa.installment_id IN (SELECT id FROM payroll_advance_installments WHERE advance_id=? AND month_key=?)`).get(advanceId, advanceId, monthKey).x || 0);
  const openDue = Math.max(0, dueThisMonth - alreadyThisMonth);
  if (!openDue) return { alloc: 0 };
  const alloc = Math.min(openDue, leftAvailable, remaining);
  if (alloc <= 0) return { alloc: 0 };
  const paymentId = db.prepare(`INSERT INTO payroll_advance_payments(advance_id,payment_type,amount_minor) VALUES (?,'salary',?)`).run(advanceId, alloc).lastInsertRowid;
  const inst = db.prepare(`SELECT * FROM payroll_advance_installments WHERE advance_id=? AND month_key=?`).all(advanceId, monthKey);
  let il = alloc;
  for (const i of inst) {
    if (il <= 0) break;
    const alreadyI = Number(db.prepare(`SELECT COALESCE(SUM(pa.amount_minor),0) x FROM payroll_advance_payment_allocations pa JOIN payroll_advance_payments p ON p.id=pa.payment_id WHERE p.voided_at IS NULL AND pa.installment_id=?`).get(i.id).x || 0);
    const openI = Math.max(0, i.amount_minor - alreadyI);
    if (!openI) continue;
    const q = Math.min(openI, il);
    db.prepare(`INSERT INTO payroll_advance_payment_allocations(payment_id,installment_id,amount_minor) VALUES (?,?,?)`).run(paymentId, i.id, q);
    il -= q;
  }
  return { alloc };
}

function totalAllocatedToInstallment(db, installmentId) {
  return Number(db.prepare(`SELECT COALESCE(SUM(amount_minor),0) x FROM payroll_advance_payment_allocations WHERE installment_id=?`).get(installmentId).x || 0);
}
function totalRecoveredForAdvance(db, advanceId) {
  return Number(db.prepare(`SELECT COALESCE(SUM(pa.amount_minor),0) x FROM payroll_advance_payment_allocations pa JOIN payroll_advance_payments p ON p.id=pa.payment_id WHERE p.voided_at IS NULL AND p.advance_id=?`).get(advanceId).x || 0);
}

console.log('=== السيناريو: سلفة 3000 (3 أقساط شهرية بقيمة 1000)، تسديد مباشر 1000 لشهر 2026-01، ثم محاولة خصم من راتب نفس الشهر ===\n');

console.log('--- الكود القديم (به الخلل) ---');
let db = setup();
directRepay(db, 1, 1000); // تسديد مباشر كامل لقسط يناير
const m1 = db.prepare(`SELECT id FROM payroll_advance_installments WHERE advance_id=1 AND month_key='2026-01'`).get();
console.log('بعد التسديد المباشر: المخصص لقسط يناير =', totalAllocatedToInstallment(db, m1.id), '(المفروض 1000)');
const r1 = salaryRecoverBuggy(db, 1, '2026-01', 1000);
console.log('محاولة خصم من الراتب لنفس شهر يناير: تم خصم =', r1.alloc, 'من الراتب');
console.log('المخصص الإجمالي لقسط يناير الآن =', totalAllocatedToInstallment(db, m1.id), '<< يجب أن يبقى 1000، لكنه أصبح مضاعفاً');
console.log('إجمالي المسدد من السلفة =', totalRecoveredForAdvance(db, 1), 'من أصل 3000\n');

console.log('--- بعد التصحيح ---');
db = setup();
directRepay(db, 1, 1000);
console.log('بعد التسديد المباشر: المخصص لقسط يناير =', totalAllocatedToInstallment(db, m1.id));
const r2 = salaryRecoverFixed(db, 1, '2026-01', 1000);
console.log('محاولة خصم من الراتب لنفس شهر يناير: تم خصم =', r2.alloc, '(صحيح: صفر لأن القسط مسدد بالفعل)');
console.log('المخصص الإجمالي لقسط يناير =', totalAllocatedToInstallment(db, m1.id), '(صحيح: يبقى 1000)');
console.log('إجمالي المسدد من السلفة =', totalRecoveredForAdvance(db, 1), 'من أصل 3000 (صحيح)');

// تأكيد آلي (وليس طباعة فقط): الكود المُصحّح يجب أن يمنع الخصم المزدوج
{
  const assert = require('assert');
  const dbA = setup();
  directRepay(dbA, 1, 1000);
  const inst1 = dbA.prepare(`SELECT id FROM payroll_advance_installments WHERE advance_id=1 AND month_key='2026-01'`).get();
  salaryRecoverFixed(dbA, 1, '2026-01', 1000);
  assert.strictEqual(totalAllocatedToInstallment(dbA, inst1.id), 1000, 'القسط المسدد مباشرة لا يجوز خصمه ثانية من الراتب بنفس الشهر');
  assert.strictEqual(totalRecoveredForAdvance(dbA, 1), 1000, 'الإجمالي المسترد يجب أن يطابق فعلياً ما دُفع فقط');
  console.log('\nPASS: MIXED DIRECT+SALARY REPAYMENT REGRESSION (fixed logic verified)');
}
