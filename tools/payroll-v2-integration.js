'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3-multiple-ciphers');

const schemaPath = path.join(__dirname, '..', 'database', 'schema.sql');
const schema = fs.readFileSync(schemaPath, 'utf8');
const dbFile = path.join(os.tmpdir(), `nexora-payroll-v2-${process.pid}-${Date.now()}.db`);

const requiredTables = [
  'payroll_employees',
  'payroll_months',
  'payroll_employee_months',
  'payroll_transactions',
  'payroll_advances',
  'payroll_advance_installments',
  'payroll_payments',
  'payroll_advance_payments',
  'payroll_advance_payment_allocations',
  'payroll_final_settlements'
];

let db;
try {
  db = new Database(dbFile);
  db.pragma('foreign_keys = ON');
  db.exec(schema);

  const tableExists = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name=?`
  );

  for (const table of requiredTables) {
    assert.ok(tableExists.get(table), `missing Payroll V2 table: ${table}`);
  }

  const branch = db.prepare(
    `INSERT INTO branches (uuid, name, business_type, is_current) VALUES (?, ?, ?, 1)`
  ).run('test-branch', 'Test Branch', 'general');
  const branchId = branch.lastInsertRowid;

  const employee = db.prepare(`
    INSERT INTO payroll_employees
      (uuid, branch_id, full_name, job_title, pay_type, pay_rate, pay_rate_minor, is_active)
    VALUES (?, ?, ?, ?, 'monthly', ?, ?, 1)
  `).run('employee-1', branchId, 'Test Employee', 'Cashier', 3500, 350000);
  const employeeId = employee.lastInsertRowid;

  const month = db.prepare(`
    INSERT INTO payroll_months (uuid, branch_id, month_key, status)
    VALUES (?, ?, '2026-09', 'open')
  `).run('month-1', branchId);
  const monthId = month.lastInsertRowid;

  db.prepare(`
    INSERT INTO payroll_employee_months
      (month_id, employee_id, pay_type, pay_rate, base_amount, base_amount_minor, net_salary, net_salary_minor)
    VALUES (?, ?, 'monthly', 3500, 3500, 350000, 3500, 350000)
  `).run(monthId, employeeId);

  const advance = db.prepare(`
    INSERT INTO payroll_advances
      (uuid, branch_id, employee_id, principal, principal_minor,
       installment_count, installment_amount, installment_amount_minor,
       first_deduction_month, status)
    VALUES (?, ?, ?, 600, 60000, 3, 200, 20000, '2026-09', 'active')
  `).run('advance-1', branchId, employeeId);
  const advanceId = advance.lastInsertRowid;

  db.prepare(`
    INSERT INTO payroll_advance_installments
      (advance_id, month_key, installment_no, amount, amount_minor)
    VALUES (?, '2026-09', 1, 200, 20000)
  `).run(advanceId);

  db.prepare(`
    INSERT INTO payroll_advance_payments
      (uuid, branch_id, advance_id, payment_type, amount, amount_minor, payment_date, method)
    VALUES (?, ?, ?, 'direct', 200, 20000, '2026-09-04', 'bank')
  `).run('repay-1', branchId, advanceId);

  const payment = db.prepare(`
    INSERT INTO payroll_payments
      (uuid, branch_id, month_id, employee_id, amount, amount_minor, method, payment_date)
    VALUES (?, ?, ?, ?, 3500, 350000, 'bank', '2026-09-04')
  `).run('salary-payment-1', branchId, monthId, employeeId);

  assert.strictEqual(payment.changes, 1);
  assert.strictEqual(db.prepare(
    'SELECT COUNT(*) AS c FROM payroll_advance_payments WHERE advance_id=?'
  ).get(advanceId).c, 1);

  db.prepare(`
    INSERT INTO payroll_final_settlements
      (uuid, branch_id, employee_id, month_id, settlement_date,
       gross_earned, deductions, advance_balance, additional_compensation,
       net_due, paid_amount,
       gross_earned_minor, deductions_minor, advance_balance_minor,
       additional_compensation_minor, net_due_minor, paid_amount_minor,
       method, status)
    VALUES (?, ?, ?, ?, '2026-09-04',
       3500, 0, 400, 0, 3100, 3100,
       350000, 0, 40000, 0, 310000, 310000,
       'bank', 'paid')
  `).run('settlement-1', branchId, employeeId, monthId);

  const fkViolations = db.prepare('PRAGMA foreign_key_check').all();
  assert.deepStrictEqual(fkViolations, [], 'foreign key violations detected');

  const schemaObjects = db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type IN ('table','index')
      AND name LIKE 'payroll_%'
    ORDER BY name
  `).all().map(r => r.name);

  assert.ok(schemaObjects.includes('payroll_final_settlements'));
  console.log('PAYROLL V2 SQLITE INTEGRATION: PASS');
  console.log(`Validated ${requiredTables.length} Payroll V2 tables, FK integrity, advance repayment, salary payment, and final settlement.`);
} finally {
  if (db) db.close();
  try { fs.rmSync(dbFile, { force: true }); } catch (_) {}
}
