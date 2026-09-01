const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const mode = process.argv[2] || 'seed';
const dir = path.resolve(process.argv[3] || fs.mkdtempSync(path.join(os.tmpdir(), 'nexora-payroll-v2-')));
fs.mkdirSync(dir, { recursive: true });

// db.js requires Electron for userData and safeStorage. This isolated regression
// test provides a deterministic stand-in so the real database logic can run in Node.
const Module = require('module');
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'electron') {
    return {
      app: { getPath: () => dir },
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: value => Buffer.from(String(value), 'utf8'),
        decryptString: value => Buffer.from(value).toString('utf8'),
      },
    };
  }
  return originalLoad.apply(this, arguments);
};

const db = require('../database/db');

db.init();

function approx(actual, expected, epsilon = 0.02) {
  if (Math.abs(Number(actual) - Number(expected)) > epsilon) {
    throw new Error(`Expected ${expected}, received ${actual}`);
  }
}

if (mode === 'seed') {
  const branch = db.getCurrentBranch();
  const beforeUsers = db.listUsers(branch.id).length;

  const a = db.addPayrollV2Employee('أحمد محمد', 'طباخ', 'monthly', 3500);
  const b = db.addPayrollV2Employee('محمد علي', 'عامل نظافة', 'monthly', 2800);
  if (!a.success || !b.success) throw new Error('Worker creation failed.');

  const afterUsers = db.listUsers(branch.id).length;
  if (afterUsers !== beforeUsers) throw new Error('Payroll worker creation incorrectly created a login user.');

  // شهر بالكامل في الماضي (قبل شهرين من تاريخ التشغيل الفعلي) حتى يكون الاختبار حتمياً:
  // بما أن الشهر انتهى فعلاً، الأيام "المنقضية" تساوي كامل مدة الشهر بغض النظر عن تاريخ
  // تشغيل الاختبار — تماماً كما كان يُفترض بالمنطق القديم (راتب شهر كامل)، فيبقى الاختبار
  // قابلاً للمقارنة المباشرة مع القيم المتوقعة القديمة.
  const now = new Date();
  const pastMonthDate = new Date(now.getFullYear(), now.getMonth() - 2, 1);
  const monthKey = `${pastMonthDate.getFullYear()}-${String(pastMonthDate.getMonth() + 1).padStart(2, '0')}`;
  const dim = new Date(pastMonthDate.getFullYear(), pastMonthDate.getMonth() + 1, 0).getDate();

  const month = db.getPayrollV2Month(monthKey);
  if (!month.id || month.items.length !== 2) throw new Error('Workers were not materialized into the month.');

  const find = id => month.items.find(x => Number(x.employee_id) === Number(id));
  let item = find(a.id);
  if (!item) throw new Error('Ahmed is missing from month.');

  const day = (n) => `${monthKey}-${String(n).padStart(2, '0')}`;
  db.addPayrollV2Transaction({ monthId: month.id, employeeId: a.id, type: 'absence', amount: 0, quantity: 1, eventDate: day(10), reason: 'غياب' });
  db.addPayrollV2Transaction({ monthId: month.id, employeeId: a.id, type: 'advance', amount: 300, quantity: 1, eventDate: day(11), reason: 'سلفة' });
  db.addPayrollV2Transaction({ monthId: month.id, employeeId: a.id, type: 'deduction', amount: 100, quantity: 1, eventDate: day(12), reason: 'خصم' });
  db.addPayrollV2Transaction({ monthId: month.id, employeeId: a.id, type: 'overtime', amount: 100, quantity: 1, eventDate: day(13), reason: 'إضافي' });
  db.addPayrollV2Transaction({ monthId: month.id, employeeId: a.id, type: 'bonus', amount: 50, quantity: 1, eventDate: day(14), reason: 'مكافأة' });

  const expected = 3500 - (3500 / dim) - 300 - 100 + 100 + 50;
  item = db.getPayrollV2Month(monthKey).items.find(x => Number(x.employee_id) === Number(a.id));
  approx(item.net_salary, expected);
  approx(item.base_amount, 3500); // شهر منتهٍ بالكامل ولم يُحدَّد تاريخ بدء مخصص => راتب الشهر كامل
  approx(item.absence_deduction, 3500 / dim);
  approx(item.advance_total, 300);
  approx(item.deduction_total, 100);
  approx(item.overtime_total, 100);
  approx(item.bonus_total, 50);

  // تاريخ بدء مخصص (العامل الثاني التحق في اليوم العاشر من هذا الشهر تحديداً): يجب أن
  // يُحتسب أساس راتبه من ذلك اليوم فقط، لا من أول الشهر — هذا هو أساس ميزة الاحتساب
  // اليومي التلقائي التي طلبها المستخدم.
  const startDateResult = db.setPayrollEmployeeMonthStartDate(month.id, b.id, day(10));
  if (!startDateResult.success) throw new Error('Setting a custom start date failed: ' + startDateResult.message);
  const elapsedFromDay10 = dim - 10 + 1; // من اليوم 10 حتى آخر الشهر (شهر منتهٍ بالكامل)
  const expectedProratedBase = (2800 / dim) * elapsedFromDay10;
  approx(startDateResult.item.base_amount, expectedProratedBase);
  const itemB = db.getPayrollV2Month(monthKey).items.find(x => Number(x.employee_id) === Number(b.id));
  approx(itemB.base_amount, expectedProratedBase);
  if (itemB.start_date !== day(10)) throw new Error(`Expected start_date ${day(10)}, received ${itemB.start_date}`);

  let duplicateRejected = false;
  try {
    db.addPayrollV2Transaction({ monthId: month.id, employeeId: a.id, type: 'absence', amount: 0, quantity: 1, eventDate: day(10), reason: '' });
  } catch (e) {
    duplicateRejected = /مسجل بالفعل/.test(String(e.message));
  }
  if (!duplicateRejected) throw new Error('Duplicate absence was not rejected.');

  const out = path.join(dir, 'expected.json');
  fs.writeFileSync(out, JSON.stringify({ branchId: branch.id, employeeId: a.id, monthKey, expectedNet: expected }, null, 2));
  console.log('PASS: payroll v2 end-to-end mutation flow');
  console.log('PASS: payroll worker creation did not add a login user');
  console.log('PASS: absence + advance + deduction + overtime + bonus recalculated net salary');
  console.log('PASS: full-month base pay for a fully-elapsed past month with default start date');
  console.log('PASS: custom start date prorates base pay day-by-day from that date');
  console.log('PASS: duplicate absence rejected');
  console.log(`STATE_DIR=${dir}`);
} else if (mode === 'verify') {
  const state = JSON.parse(fs.readFileSync(path.join(dir, 'expected.json'), 'utf8'));
  const month = db.getPayrollV2Month(state.monthKey);
  const item = month.items.find(x => Number(x.employee_id) === Number(state.employeeId));
  if (!item) throw new Error('Persisted payroll employee/month record is missing after reopen.');
  approx(item.net_salary, state.expectedNet);
  const tx = month.transactions.filter(x => Number(x.employee_id) === Number(state.employeeId));
  if (tx.length !== 5) throw new Error(`Expected 5 persisted transactions after reopen, found ${tx.length}.`);
  console.log('PASS: payroll worker, month, transactions, and net salary survive process reopen');
} else {
  throw new Error(`Unknown mode: ${mode}`);
}
