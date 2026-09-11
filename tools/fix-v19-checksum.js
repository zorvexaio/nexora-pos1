#!/usr/bin/env node
// شغّلها مرة وحدة من جذر مشروعك: node tools/fix-v19-checksum.js
// بتعدّل database/db.js فقط، وبترفض تلمس الملف لو ما لقت النص المتوقع بالضبط (أمان).
'use strict';
const fs = require('fs');
const path = require('path');

const dbPath = path.join(__dirname, '..', 'database', 'db.js');
const src = fs.readFileSync(dbPath, 'utf8');

const BROKEN = `    if (!accountRow || !expenseRow) continue; // فرع بلا وحدة محاسبية مفعّلة بعد — لا شيء لتصحيحه هنا.
    const currentMonthKeyGuard = \`\${payrollTodayLocal().getFullYear()}-\${String(payrollTodayLocal().getMonth() + 1).padStart(2, '0')}\`;
    const months = db.prepare("SELECT * FROM payroll_months WHERE branch_id=?").all(branch.id)
      .filter((m) => String(m.month_key) <= currentMonthKeyGuard); // لا تُرحّل استحقاقاً لشهر لم يبدأ بعد.`;

const FIXED = `    if (!accountRow || !expenseRow) continue; // فرع بلا وحدة محاسبية مفعّلة بعد — لا شيء لتصحيحه هنا.
    const months = db.prepare("SELECT * FROM payroll_months WHERE branch_id=?").all(branch.id);`;

if (src.includes(FIXED) && !src.includes(BROKEN)) {
  console.log('لا شيء لعمله — v19 مطابقة أصلاً للنص المنشور.');
  process.exit(0);
}
if (!src.includes(BROKEN)) {
  console.error('لم أجد النص المتوقع بالضبط داخل database/db.js — لم أعدّل أي شيء.');
  console.error('على الأغلب الكود عندك مختلف قليلاً عمّا توقعته؛ افتح الدالة migratePayrollAccrualV19 وقارن يدوياً.');
  process.exit(1);
}
const count = src.split(BROKEN).length - 1;
if (count !== 1) {
  console.error(`النص المستهدف ظهر ${count} مرة بدل مرة واحدة — توقفت للأمان (لازم يكون فريداً).`);
  process.exit(1);
}
fs.writeFileSync(dbPath, src.replace(BROKEN, FIXED), 'utf8');
console.log('تم: أُرجعت migratePayrollAccrualV19 لنصها المنشور الأصلي (بدون فلترة month_key).');
console.log('الخطوة التالية: node tools/migration-chain-regression.js && node tools/payroll-accrual-v19-regression.js');
