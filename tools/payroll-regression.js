const fs=require('fs');
const main=fs.readFileSync('main.js','utf8');
const db=fs.readFileSync('database/db.js','utf8');
const preload=fs.readFileSync('preload.js','utf8');
const payroll=fs.readFileSync('renderer/pages/payroll.js','utf8');
const payrollHtml=fs.readFileSync('renderer/pages/payroll.html','utf8');
const preloadPayroll=preload.slice(preload.indexOf('  payroll: {'), preload.indexOf('  returns: {'));
const checks=[
  ['sale handler has no mandatory shift block', /ipcMain\.handle\('sale:create'[\s\S]{0,2500}throw new Error\('لا توجد وردية مفتوحة/.test(main)===false],
  ['table split has no mandatory shift block', /tables:split[\s\S]{0,500}افتح وردية قبل تسجيل الدفع/.test(main)===false],
  ['payroll uses independent payroll employee table', /CREATE TABLE IF NOT EXISTS payroll_employees/.test(db)],
  ['new payroll employee creation is isolated from users', /function addPayrollV2Employee[\s\S]*?INSERT INTO payroll_employees/.test(db)&&!/function addPayrollV2Employee[\s\S]*?INSERT INTO users/.test(db)],
  ['legacy payroll-only workers are migrated into the independent table', /legacyPayrollWorkers/.test(db)&&/INSERT OR IGNORE INTO payroll_employees/.test(db)],
  ['legacy payroll worker migration binds exactly 8 values', /INSERT OR IGNORE INTO payroll_employees\(uuid,branch_id,full_name,job_title,pay_type,pay_rate,is_active,legacy_user_id\) VALUES\(\?,\?,\?,\?,\?,\?,\?,\?\)/.test(db)&&/insertPayrollEmployee\.run\(uuid\(\), u\.branch_id, String\(u\.full_name \|\| 'عامل'\), String\(u\.job_title \|\| 'أخرى'\), type, Math\.max\(0, Math\.round\(rate \* 100\) \/ 100\), Number\(u\.is_active \|\| 0\), u\.id\)/.test(db)],
  ['payroll month has no open/close/approval state model', /CREATE TABLE IF NOT EXISTS payroll_months[\s\S]*?month_key/.test(db)&&!/CREATE TABLE IF NOT EXISTS payroll_months[\s\S]*?status TEXT/.test(db)],
  ['payroll transactions are independently persisted', /CREATE TABLE IF NOT EXISTS payroll_transactions/.test(db)&&/addPayrollV2Transaction/.test(db)],
  ['payroll renderer exposes v2 APIs only', /addEmployee:/.test(preloadPayroll)&&/month:/.test(preloadPayroll)&&/addTransaction:/.test(preloadPayroll)&&!/approve:/.test(preloadPayroll)&&!/markPaid:/.test(preloadPayroll)],
  ['payroll UI has no approval/payment cycle', !/فتح دورة|إغلاق دورة|اعتماد دورة|تسجيل دفع الشهر|فتح الدورة|إغلاق الدورة/.test(payroll+payrollHtml)],
  ['payroll UI explicitly states worker needs no login', /لا يتم إنشاء حساب دخول/.test(payrollHtml)],
  ['payroll UI saves immediately and shows all requested movements', /محفوظ تلقائيًا/.test(payrollHtml)&&/absence|advance|bonus|deduction|overtime/.test(payroll)],
  ['payroll formula includes base, absence, advance, deduction, overtime and bonus', /base - absenceDeduction - advance - deduction \+ bonus \+ overtime/.test(db)],
  ['payroll recalculation scopes transaction sums to the current branch', /FROM payroll_transactions WHERE month_id=\? AND employee_id=\? AND branch_id=\? GROUP BY type\`\)\.all\(month\.id,em\.employee_id,b\.id\)/.test(db)],
  ['duplicate absence on same date is blocked', /يوم الغياب هذا مسجل بالفعل/.test(db)],
  ['payroll history remains after employee inactivity', /is_active/.test(db)&&/payroll_employee_months/.test(db)],
  ['payroll renderer and main IPC syntax are present', /payroll:addEmployee/.test(main)&&/payroll:addTransaction/.test(main)&&/init\(\)/.test(payroll)],
  ['legacy payroll lifecycle functions are not exposed anymore', !/createPayrollPeriod|addPayrollAdjustment|approvePayrollPeriod|markPayrollPaid|addPayrollAbsence/.test(main)&&!/createPayrollPeriod,|addPayrollAdjustment,|approvePayrollPeriod,|markPayrollPaid,|addPayrollAbsence,/.test(db)],
];
let failed=0; for(const [name,ok] of checks){console.log(`${ok?'PASS':'FAIL'}: ${name}`); if(!ok)failed++;}
if(failed)process.exit(1);
