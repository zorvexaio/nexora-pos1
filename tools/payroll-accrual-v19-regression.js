// اختبار انحدار حقيقي (تنفيذي، وليس نصياً فقط) لإصلاح v19: يحاكي بالضبط حالة المستخدم
// المُبلَّغ عنها — راتب مستحق 8400 مقابل 3500 مصروف فعلياً فقط — ويتحقق من أن قسم
// المحاسبة (قائمة الدخل + ميزان المراجعة) يعكس المستحق الحقيقي 8400 كمصروف، مع ظهور
// الفرق كالتزام "رواتب مستحقة" (2300) بدل أن يكون مفقوداً تماماً كما كان سابقاً.
const assert = require('assert');
const db = require('../database/db.js');
db.init(); // إنشاء الجداول إن لم تكن موجودة — بالضبط كما يفعل main.js عند الإقلاع.

const MONTH_KEY = '2025-01'; // شهر ماضٍ بالكامل لضمان استحقاق كامل الراتب (لا تناسب أيام).
let failed = 0;
function check(name, cond, extra) { console.log(`${cond ? 'PASS' : 'FAIL'}: ${name}${extra !== undefined ? ' -> ' + JSON.stringify(extra) : ''}`); if (!cond) failed++; }

// 1) إعداد عامل براتب شهري 8400 بدءاً من أول الشهر المُختبَر.
const emp = db.addPayrollV2Employee('عامل الاختبار', 'محاسبة', 'monthly', 8400, { hireDate: `${MONTH_KEY}-01` });
assert.ok(emp.success, 'فشل إنشاء العامل: ' + emp.message);
const employeeId = emp.id;

const monthBefore = db.getPayrollV2Month(MONTH_KEY);
db.setPayrollEmployeeMonthStartDate(monthBefore.id, employeeId, `${MONTH_KEY}-01`);
const monthAfterStart = db.getPayrollV2Month(MONTH_KEY);
const item = monthAfterStart.items.find(x => Number(x.employee_id) === Number(employeeId));
check('صافي الراتب المحسوب = 8400 تماماً', Number(item.net_salary) === 8400, item.net_salary);

// 2) صرف دفعة جزئية فقط 3500 (بالضبط سيناريو المستخدم).
const pay = db.recordPayrollPayment({ monthId: monthAfterStart.id, employeeId, amount: 3500, method: 'bank', paymentDate: `${MONTH_KEY}-15`, reference: 'test' });
check('تم تسجيل دفعة 3500 بنجاح', !!pay && pay.success !== false, pay);

// 3) قائمة الدخل: يجب أن يظهر مصروف الرواتب (6100) = 8400 كاملة، وليس 3500 فقط — هذا هو الإصلاح الأساسي.
const income = db.getIncomeStatement(`${MONTH_KEY}-01`, `${MONTH_KEY}-31`);
const expenseLine = income.expense.find(x => x.code === '6100');
check('قائمة الدخل: مصروف الرواتب = 8400 (المستحق الكامل، لا 3500)', !!expenseLine && Math.abs(Number(expenseLine.amount) - 8400) < 0.01, expenseLine);

// 4) الالتزام المتبقي بحساب "رواتب مستحقة" (2300) = 8400 - 3500 = 4900 (جانب دائن).
const trial = db.getTrialBalance(`${MONTH_KEY}-31`);
const payableRow = trial.accounts.find(x => x.code === '2300');
check('حساب "رواتب مستحقة" (2300) موجود بميزان المراجعة', !!payableRow, payableRow);
if (payableRow) check('رصيد "رواتب مستحقة" = 4900 دائن (الفرق غير المدفوع بعد)', Math.abs(Number(payableRow.credit) - 4900) < 0.01, payableRow);

// 5) لا ازدواجية عند إعادة تشغيل ترحيل الاستحقاق الصريح بلا تغيير جديد (idempotent).
const accrueResult = db.accruePayrollMonth(monthAfterStart.id, { createdBy: null });
check('لا استحقاق إضافي عند إعادة التشغيل بلا تغيير جديد (idempotent)', accrueResult.employeesAccrued === 0, accrueResult);

// 6) صرف باقي المبلغ (4900) ثم التأكد أن إجمالي مصروف 6100 لا يزال 8400 بالضبط (لا ازدواج مصروف عند التسوية النهائية).
db.recordPayrollPayment({ monthId: monthAfterStart.id, employeeId, amount: 4900, method: 'bank', paymentDate: `${MONTH_KEY}-28`, reference: 'test2' });
const incomeAfterFullPayment = db.getIncomeStatement(`${MONTH_KEY}-01`, `${MONTH_KEY}-31`);
const expenseLine2 = incomeAfterFullPayment.expense.find(x => x.code === '6100');
check('بعد اكتمال الصرف: مصروف 6100 لا يزال 8400 بالضبط (لا ازدواج)', !!expenseLine2 && Math.abs(Number(expenseLine2.amount) - 8400) < 0.01, expenseLine2);

const trialAfterFull = db.getTrialBalance(`${MONTH_KEY}-31`);
const payableAfterFull = trialAfterFull.accounts.find(x => x.code === '2300');
check('بعد اكتمال الصرف: رصيد "رواتب مستحقة" = صفر (الالتزام تسوّى بالكامل)', !payableAfterFull || (Number(payableAfterFull.credit) === 0 && Number(payableAfterFull.debit) === 0), payableAfterFull);

check('ميزان المراجعة متوازن (مدين = دائن) بعد كل القيود الجديدة', trialAfterFull.balanced === true, { totalDebit: trialAfterFull.totalDebit, totalCredit: trialAfterFull.totalCredit });

console.log(failed ? `\n${failed} فحص/فحوصات فشلت` : '\nكل الفحوصات ناجحة — الإصلاح يعمل تماماً كما هو مطلوب (8400 تظهر بالكامل بالمحاسبة)');
process.exit(failed ? 1 : 0);
