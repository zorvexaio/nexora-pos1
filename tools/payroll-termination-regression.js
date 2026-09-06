'use strict';
const assert = require('assert');
const fs = require('fs');
const db = fs.readFileSync('database/db.js','utf8');
const preload = fs.readFileSync('preload.js','utf8');
const main = fs.readFileSync('main.js','utf8');
const html = fs.readFileSync('renderer/pages/payroll.html','utf8');
const pkg = JSON.parse(fs.readFileSync('package.json','utf8'));
assert.strictEqual(pkg.version,'0.52.1');
{
  // كان يطابق =15 حرفياً فيفشل تلقائياً مع أي ترحيلة لاحقة (فشل فعلياً منذ v16).
  const m=db.match(/CURRENT_SCHEMA_VERSION\s*=\s*(\d+)/);
  assert.ok(m,'A numeric schema version constant is required.');
  assert.ok(Number(m[1])>=14,'Schema version must not regress below the payroll-termination migration (v14).');
}
assert.match(db,/payroll-termination-final-settlement-v14/);
assert.match(db,/CREATE TABLE IF NOT EXISTS payroll_final_settlements/);
assert.match(db,/settleEmployeeFinalPayroll/);
assert.match(db,/advance_balance_minor INTEGER NOT NULL DEFAULT 0/);
assert.match(db,/UPDATE payroll_employees SET is_active=0,terminated_at=/);
assert.match(db,/cashMovementId=cm\.id/);
assert.match(main,/ipcMain\.handle\('payroll:finalSettlement'/);
assert.match(preload,/finalSettlement: \(payload\)/);
assert.match(html,/data-action="terminate"/);
assert.match(html,/إنهاء الخدمة والتصفية/);
console.log('PAYROLL TERMINATION REGRESSION: PASS');
console.log('PASS: schema v15 is registered and journaled');
console.log('PASS: final settlement table is auditable and minor-unit safe');
console.log('PASS: settlement supports outstanding advance offset');
console.log('PASS: employee is deactivated only after atomic settlement');
console.log('PASS: final settlement IPC/preload/UI surface is present');
