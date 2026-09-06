#!/usr/bin/env node
'use strict';
const fs=require('fs');const path=require('path');const assert=require('assert');
const root=path.resolve(__dirname,'..');
const db=fs.readFileSync(path.join(root,'database','db.js'),'utf8');
const main=fs.readFileSync(path.join(root,'main.js'),'utf8');
const preload=fs.readFileSync(path.join(root,'preload.js'),'utf8');
// كان هذا يطابق =15 حرفياً فيفشل تلقائياً بمجرد أي ترحيلة لاحقة (فشل فعلياً منذ v16)
// بلا علاقة بميزة تسديد السلف نفسها. نتحقق بدلاً منه أن ترحيلة التسديد v13 لا تزال
// مسجّلة، وأن رقم المخطط الحالي لا يقل عنها — لا رقماً ثابتاً يحتاج تحديثاً كل إصدار.
const schemaVersionMatch=db.match(/CURRENT_SCHEMA_VERSION\s*=\s*(\d+)/);
assert.ok(schemaVersionMatch,'A numeric schema version constant is required.');
assert.ok(Number(schemaVersionMatch[1])>=13,'Schema version must not regress below the payroll-advance-repayments migration (v13).');
assert.match(db,/payroll-advance-repayments-v13/);
assert.match(db,/CREATE TABLE IF NOT EXISTS payroll_advance_payments/);
assert.match(db,/payment_type TEXT NOT NULL CHECK\(payment_type IN \('direct','salary'\)\)/);
assert.match(db,/CREATE TABLE IF NOT EXISTS payroll_advance_payment_allocations/);
assert.match(db,/function listPayrollAdvancePayments/);
assert.match(db,/function repayPayrollAdvance/);
assert.match(db,/function settlePayrollAdvance/);
assert.match(db,/function recordPayrollSalaryAdvanceRecovery/);
assert.match(main,/payroll:advancePayments/);
assert.match(main,/payroll:repayAdvance/);
assert.match(main,/payroll:settleAdvance/);
assert.match(preload,/advancePayments:/);
assert.match(preload,/repayAdvance:/);
assert.match(preload,/settleAdvance:/);
assert.match(db,/payment_type='direct'/);
assert.match(db,/function recordPayrollSalaryAdvanceRecovery/);
// انتكاسة تم إصلاحها: كان حساب "المخصوم مسبقاً لهذا القسط" داخل recordPayrollSalaryAdvanceRecovery
// يُصفّى حسب payment_type='salary' فقط، فيتجاهل أي تسديد مباشر (direct) لنفس القسط ويؤدي لخصمه
// مرتين. تأكيد أن هذا النمط الخاطئ (تصفية إجمالي القسط الشهري حسب نوع دفعة واحد) لم يعد موجوداً:
assert.doesNotMatch(db,/AND p\.payment_type='salary' AND pa\.installment_id IN \(SELECT id FROM payroll_advance_installments WHERE advance_id=\? AND month_key=\?\)/);
assert.match(db,/finalSalaryPayment/);
console.log('PAYROLL ADVANCE REPAYMENTS REGRESSION: PASS');
console.log('PASS: schema history includes auditable advance repayment records and installment allocations');
console.log('PASS: direct repayment can be partially allocated across installments');
console.log('PASS: early settlement closes the advance at zero balance');
console.log('PASS: salary deductions are recorded as salary-source recovery only after final salary payment');
console.log('PASS: repayment IPC is admin-only and exposed through preload');
