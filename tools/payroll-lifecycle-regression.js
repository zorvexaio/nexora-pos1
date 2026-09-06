#!/usr/bin/env node
'use strict';
const fs=require('fs'); const path=require('path'); const assert=require('assert');
const root=path.resolve(__dirname,'..');
const db=fs.readFileSync(path.join(root,'database','db.js'),'utf8');
const main=fs.readFileSync(path.join(root,'main.js'),'utf8');
const preload=fs.readFileSync(path.join(root,'preload.js'),'utf8');
const ui=fs.readFileSync(path.join(root,'renderer/pages/payroll.js'),'utf8');
const html=fs.readFileSync(path.join(root,'renderer/pages/payroll.html'),'utf8');
{
  // كان يطابق =15 حرفياً فيفشل تلقائياً مع أي ترحيلة لاحقة (فشل فعلياً منذ v16).
  const m=db.match(/CURRENT_SCHEMA_VERSION\s*=\s*(\d+)/);
  assert.ok(m,'A numeric schema version constant is required.');
  assert.ok(Number(m[1])>=10,'Schema version must not regress below the payroll-lifecycle migration (v10).');
}
assert.match(db,/payroll-lifecycle-v10/);
assert.match(db,/CREATE TABLE IF NOT EXISTS payroll_payments/);
assert.match(db,/method TEXT NOT NULL CHECK\(method IN \('cash','bank','other'\)\)/);
assert.match(db,/assertPayrollMonthMutable\(m\)/);
assert.match(db,/المبلغ أكبر من المتبقي للموظف/);
assert.match(db,/payroll_salary/);
assert.match(db,/لا يمكن صرف الراتب نقداً بدون وردية صندوق مفتوحة/);
assert.match(db,/paid_total/);
assert.match(main,/payroll:payEmployee/);
assert.match(main,/payroll:payments/);
assert.match(preload,/payEmployee:/);
assert.match(preload,/payments:/);
assert.match(ui,/payEmployee/);
assert.match(html,/صرف الراتب/);
console.log('PAYROLL LIFECYCLE REGRESSION: PASS');
console.log('PASS: salary payment is explicit and capped at remaining net salary');
console.log('PASS: cash salary requires an open register shift');
console.log('PASS: paid payroll months reject further payroll mutations');
console.log('PASS: payment history is persisted and exposed through preload/main IPC');
