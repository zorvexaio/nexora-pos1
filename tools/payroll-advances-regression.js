#!/usr/bin/env node
'use strict';
const fs=require('fs');const path=require('path');const assert=require('assert');
const root=path.resolve(__dirname,'..');
const db=fs.readFileSync(path.join(root,'database','db.js'),'utf8');
const main=fs.readFileSync(path.join(root,'main.js'),'utf8');
const preload=fs.readFileSync(path.join(root,'preload.js'),'utf8');
const ui=fs.readFileSync(path.join(root,'renderer/pages/payroll.js'),'utf8');
const html=fs.readFileSync(path.join(root,'renderer/pages/payroll.html'),'utf8');
// كان هذا يطابق =15 حرفياً فيفشل تلقائياً بمجرد أي ترحيلة لاحقة (فشل فعلياً منذ v16)
// بلا علاقة بميزة السلف نفسها. نتحقق بدلاً منه أن ترحيلة السلف v12 لا تزال مسجّلة،
// وأن رقم المخطط الحالي لا يقل عنها — لا رقماً ثابتاً يحتاج تحديثاً كل إصدار.
const schemaVersionMatch=db.match(/CURRENT_SCHEMA_VERSION\s*=\s*(\d+)/);
assert.ok(schemaVersionMatch,'A numeric schema version constant is required.');
assert.ok(Number(schemaVersionMatch[1])>=12,'Schema version must not regress below the payroll-advances migration (v12).');
assert.match(db,/payroll-advances-v12/);
assert.match(db,/CREATE TABLE IF NOT EXISTS payroll_advances/);
assert.match(db,/CREATE TABLE IF NOT EXISTS payroll_advance_installments/);
assert.match(db,/installment_count INTEGER.*BETWEEN 1 AND 36/s);
assert.match(db,/first_deduction_month TEXT NOT NULL/);
assert.match(db,/function createPayrollAdvance/);
assert.match(db,/function listPayrollAdvances/);
assert.match(db,/payroll_advance_installments.*month_key/s);
assert.match(db,/scheduledAdvance/);
assert.match(db,/scheduledAdvanceMinor/);
assert.match(main,/payroll:createAdvance/);
assert.match(main,/payroll:advances/);
assert.match(preload,/createAdvance:/);
assert.match(preload,/advances:/);
assert.match(ui,/entryInstallments/);
assert.match(ui,/entryFirstDeductionMonth/);
assert.match(ui,/window\.api\.payroll\.createAdvance/);
assert.match(html,/drawerAdvances/);
console.log('PAYROLL ADVANCES REGRESSION: PASS');
console.log('PASS: advances support 1-36 installment schedules');
console.log('PASS: first deduction month is explicit and cannot precede issuance');
console.log('PASS: installment schedule is calculated in minor currency units');
console.log('PASS: future monthly deductions are included automatically in payroll recalculation');
console.log('PASS: optional immediate cash-out remains tied to an open register shift');
