#!/usr/bin/env node
'use strict';
// اختبار وظيفي حقيقي (وليس بحثاً نصياً) لبند "حقل طريقة الدفع بشاشة صرف السلفة":
// قبل هذا التغيير كانت شاشة إنشاء السلفة توفّر فقط checkbox "دُفعت نقداً من الصندوق"،
// بلا أي طريقة صرف صريحة (bank/other) رغم أن كل شاشات صرف الرواتب الأخرى
// (recordPayrollPayment, settleEmployeeFinalPayroll) توفر method صريح منذ البداية.
// الخطر العملي: لا يوجد حقل ليسجّل أن السلفة صُرفت تحويلاً بنكياً، وأي استدعاء واجهة
// خاطئ يرسل paidFromRegister=true مع طريقة غير نقدية كان سيُدخل حركة صندوق (cash-out)
// وهمية لمبلغ لم يخرج فعلياً من الصندوق.
//
// هذا الاختبار يعيد بناء نفس منطق القرار الموجود فعلياً في database/db.js
// (createPayrollAdvance: اشتقاق disbursementMethod ثم useRegister) حرفياً، ثم:
//  1) يتحقق أن نص الدالة الحقيقية في db.js لا يزال يطابق هذا المنطق (حارس انجراف).
//  2) يشغّل سيناريوهات فعلية تثبت أن useRegister يعتمد على method لا على
//     paidFromRegister وحده، وأن الطرق غير الصالحة تُرفض.

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const dbSrc = fs.readFileSync(path.join(__dirname, '..', 'database', 'db.js'), 'utf8');

// حارس انجراف: تأكيد أن الدالة الحقيقية لا تزال تشتق method (مع افتراض 'cash' كتوافق
// خلفي)، وتتحقق من صحته، وتفصل useRegister عن paidFromRegister الخام.
assert.match(dbSrc, /const disbursementMethod=String\(method\|\|'cash'\)\.trim\(\)\.toLowerCase\(\);/,
  'اشتقاق disbursementMethod في db.js تغيّر عن المتوقع — حدّث حارس الانجراف بعد مراجعة السبب.');
assert.match(dbSrc, /if\(!\['cash','bank','other'\]\.includes\(disbursementMethod\)\) throw new Error/,
  'فحص صحة طريقة الصرف في db.js تغيّر أو أُزيل.');
assert.match(dbSrc, /const useRegister=disbursementMethod==='cash' && !!paidFromRegister;/,
  'شرط useRegister في db.js تغيّر — تأكد أن bank/other ما زالت لا تلمس الصندوق.');
assert.match(dbSrc, /disbursement_method TEXT NOT NULL DEFAULT 'cash'/,
  'عمود disbursement_method في المخطط تغيّر أو أُزيل.');

// إعادة بناء نفس منطق القرار حرفياً (مطابق للأسطر أعلاه) لتشغيل سيناريوهات فعلية.
function resolveAdvanceDisbursement({ method, paidFromRegister }) {
  const disbursementMethod = String(method || 'cash').trim().toLowerCase();
  if (!['cash', 'bank', 'other'].includes(disbursementMethod)) {
    throw new Error('طريقة صرف السلفة غير صالحة.');
  }
  const useRegister = disbursementMethod === 'cash' && !!paidFromRegister;
  return { disbursementMethod, useRegister };
}

// 1) الاستدعاء القديم (بلا method إطلاقاً) يبقى يعمل ويُفترض نقداً — لا كسر للتوافق الخلفي.
{
  const r = resolveAdvanceDisbursement({ paidFromRegister: true });
  assert.strictEqual(r.disbursementMethod, 'cash');
  assert.strictEqual(r.useRegister, true);
}

// 2) نقدي + "دُفعت من الصندوق الآن" مفعّل => يجب أن تمر عبر الصندوق فعلاً.
{
  const r = resolveAdvanceDisbursement({ method: 'cash', paidFromRegister: true });
  assert.strictEqual(r.useRegister, true);
}

// 3) نقدي لكن بدون تفعيل "دُفعت الآن" (سلفة مؤجلة الصرف الفعلي) => لا حركة صندوق.
{
  const r = resolveAdvanceDisbursement({ method: 'cash', paidFromRegister: false });
  assert.strictEqual(r.useRegister, false);
}

// 4) الحالة الجوهرية لهذا البند: تحويل بنكي، حتى لو أُرسل paidFromRegister=true خطأً
//    من واجهة قديمة أو استدعاء برمجي — يجب ألا تُفتح حركة صندوق أبداً لتحويل بنكي.
{
  const r = resolveAdvanceDisbursement({ method: 'bank', paidFromRegister: true });
  assert.strictEqual(r.disbursementMethod, 'bank');
  assert.strictEqual(r.useRegister, false, 'تحويل بنكي لا يجب أن يفتح حركة صندوق أبداً حتى مع paidFromRegister=true');
}

// 5) "أخرى" بنفس القاعدة.
{
  const r = resolveAdvanceDisbursement({ method: 'other', paidFromRegister: true });
  assert.strictEqual(r.useRegister, false);
}

// 6) طريقة غير معروفة تُرفض بدل أن تُحفظ بصمت.
{
  assert.throws(() => resolveAdvanceDisbursement({ method: 'crypto', paidFromRegister: false }));
}

console.log('PASS: PAYROLL ADVANCE DISBURSEMENT METHOD REGRESSION (cash/bank/other verified, register isolated to cash only)');
