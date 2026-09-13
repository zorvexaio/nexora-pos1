#!/usr/bin/env node
// شغّلها مرة وحدة من جذر مشروعك: node tools/fix-arabic-digit-inputs.js
// بتصلّح كل خانات type="number" (36 خانة، ثابتة وديناميكية) اللي بترفض الأرقام
// العربية/الفارسية بصمت، بكل شاشات التطبيق دفعة وحدة. كل تعديل مستقل ومحمي:
// لو نص متوقع مش موجود بالضبط، بتطبع تحذير وتكمل الباقي بدل ما توقف بالكامل.
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
let okCount = 0, warnCount = 0, skipCount = 0;

function patch(relPath, old, next, label) {
  const full = path.join(root, relPath);
  if (!fs.existsSync(full)) { console.error(`تخطّي: ${relPath} غير موجود.`); warnCount++; return; }
  const src = fs.readFileSync(full, 'utf8');
  if (src.includes(next) && !src.includes(old)) { skipCount++; return; }
  if (!src.includes(old)) {
    console.error(`تحذير: لم يُعثر على النص المتوقع لـ ${label} بـ ${relPath} — راجعه يدوياً.`);
    warnCount++;
    return;
  }
  const n = src.split(old).length - 1;
  if (n !== 1) {
    console.error(`تحذير: النص لـ ${label} بـ ${relPath} ظهر ${n} مرة بدل مرة واحدة — تخطّي للأمان.`);
    warnCount++;
    return;
  }
  fs.writeFileSync(full, src.replace(old, next), 'utf8');
  okCount++;
}

// ---------- HTML: type="number" -> type="text" inputmode="numeric" ----------
const htmlFields = {
  'renderer/index.html': ['deliveryDistanceInput', 'deliveryFeeInput', 'discountValueInput', 'loyaltyPointsInput'],
  'renderer/pages/bundles.html': ['fieldDiscountValue', 'itemQuantityInput'],
  'renderer/pages/customers.html': ['debtPaymentAmount', 'fieldPoints'],
  'renderer/pages/inventory.html': ['transferQuantity', 'adjustValue'],
  'renderer/pages/payroll.html': ['overtimeMultiplier', 'workHoursPerDay'],
  'renderer/pages/products.html': ['fieldPrice', 'fieldCost', 'fieldTax', 'fieldStock', 'fieldMinQty'],
  'renderer/pages/settings.html': ['fieldMinorUnit', 'fieldExchangeRate', 'fieldMaxDiscountPercent',
    'fieldTaxDefaultRate', 'fieldLoyaltyEarnRate', 'fieldLoyaltyRedeemRate', 'fieldDeliveryDefaultFee', 'fieldDeliveryPricePerKm'],
  'renderer/pages/suppliers.html': ['supplierPaymentAmount', 'purchaseQty', 'purchaseCost', 'quickAddProductPrice', 'purchasePaid'],
  'renderer/pages/table-order.html': ['splitCashReceived', 'loyaltyPointsInput', 'cashReceivedInput', 'mixedCashInput', 'mixedCardInput'],
  'renderer/pages/tables.html': ['fieldTableSeats'],
};
for (const [rel, ids] of Object.entries(htmlFields)) {
  const full = path.join(root, rel);
  if (!fs.existsSync(full)) { console.error(`تخطّي: ${rel} غير موجود.`); warnCount++; continue; }
  let src = fs.readFileSync(full, 'utf8');
  for (const id of ids) {
    const re = new RegExp(`(<input id="${id}"[^>]*?)type="number"([^>]*>)`);
    if (!re.test(src)) {
      if (new RegExp(`<input id="${id}"[^>]*type="text"[^>]*inputmode="numeric"`).test(src)) { skipCount++; continue; }
      console.error(`تحذير: لم يُعثر على ${rel}#${id} بصيغة type="number" متوقعة — راجعه يدوياً.`);
      warnCount++;
      continue;
    }
    src = src.replace(re, (_m, a, b) => `${a}type="text" inputmode="numeric"${b}`);
    okCount++;
  }
  fs.writeFileSync(full, src, 'utf8');
}

// ---------- JS: قراءات القيمة (Number/parseFloat/parseInt -> parseLocaleNumber) ----------
patch('renderer/pos.js',
  'let val = Math.floor(Number(loyaltyPointsInput.value) || 0);',
  'let val = Math.floor(parseLocaleNumber(loyaltyPointsInput.value) || 0);', 'pos.js loyaltyPointsInput');

patch('renderer/pages/bundles.js',
  'const quantity = parseFloat(itemQuantityInput.value) || 0;',
  'const quantity = parseLocaleNumber(itemQuantityInput.value) || 0;', 'bundles.js itemQuantityInput');
patch('renderer/pages/bundles.js',
  'discountValue: parseFloat(fieldDiscountValue.value) || 0,',
  'discountValue: parseLocaleNumber(fieldDiscountValue.value) || 0,', 'bundles.js fieldDiscountValue');

patch('renderer/pages/customers.js',
  'loyaltyPoints: parseInt(fieldPoints.value, 10) || 0,',
  'loyaltyPoints: Math.floor(parseLocaleNumber(fieldPoints.value)) || 0,', 'customers.js fieldPoints');

patch('renderer/pages/inventory.js',
  'const value = parseFloat(adjustValue.value) || 0;',
  'const value = parseLocaleNumber(adjustValue.value) || 0;', 'inventory.js adjustValue');
patch('renderer/pages/inventory.js',
  'const productId=Number(transferProduct.value); const qty=Number(transferQuantity.value);',
  'const productId=Number(transferProduct.value); const qty=parseLocaleNumber(transferQuantity.value);', 'inventory.js transferQuantity');

patch('renderer/pages/payroll.js',
  `const r=await window.api.payroll.settings({save:true,overtimeMultiplier:Number($('overtimeMultiplier').value),workHoursPerDay:Number($('workHoursPerDay').value)});`,
  `const r=await window.api.payroll.settings({save:true,overtimeMultiplier:parsePayrollNumber($('overtimeMultiplier').value),workHoursPerDay:parsePayrollNumber($('workHoursPerDay').value)});`,
  'payroll.js settings');
// حقول payroll.js الديناميكية (innerHTML) — ما بتظهر بأي ملف .html ثابت
patch('renderer/pages/payroll.js',
  '<input id="entryInstallments" type="number" min="1" max="36" step="1" value="1" required>',
  '<input id="entryInstallments" type="text" inputmode="numeric" value="1" required>', 'payroll.js entryInstallments HTML');
patch('renderer/pages/payroll.js',
  '<input id="entryNumber" type="number" min="0" max="24" step="0.25" required placeholder="مثال: 8">',
  '<input id="entryNumber" type="text" inputmode="decimal" required placeholder="مثال: 8">', 'payroll.js entryNumber(regular) HTML');
patch('renderer/pages/payroll.js',
  '<input id="entryHours" type="number" min="0.25" max="24" step="0.25" value="1" required>',
  '<input id="entryHours" type="text" inputmode="decimal" value="1" required>', 'payroll.js entryHours HTML');
patch('renderer/pages/payroll.js',
  '<input id="entryOvertimeMultiplier" type="number" min="0.1" max="10" step="0.05" value="1.5" required>',
  '<input id="entryOvertimeMultiplier" type="text" inputmode="decimal" value="1.5" required>', 'payroll.js entryOvertimeMultiplier HTML');
patch('renderer/pages/payroll.js',
  `const amount=parsePayrollNumber($('entryNumber').value),installmentCount=Number($('entryInstallments').value),firstDeductionMonth=$('entryFirstDeductionMonth').value;`,
  `const amount=parsePayrollNumber($('entryNumber').value),installmentCount=Math.floor(parsePayrollNumber($('entryInstallments').value))||0,firstDeductionMonth=$('entryFirstDeductionMonth').value;`,
  'payroll.js entryInstallments read');
patch('renderer/pages/payroll.js',
  `const hours=Number($('entryNumber').value);if(!Number.isFinite(hours)||hours<=0)throw new Error('أدخل عدد ساعات أكبر من صفر.');`,
  `const hours=parsePayrollNumber($('entryNumber').value);if(!Number.isFinite(hours)||hours<=0)throw new Error('أدخل عدد ساعات أكبر من صفر.');`,
  'payroll.js entryNumber(regular) read');
patch('renderer/pages/payroll.js',
  `const amount=a==='absence'?0:parsePayrollNumber($('entryNumber').value);const r=await window.api.payroll.addTransaction({monthId:m,employeeId:u,type:a,amount:a==='overtime'?0:amount,quantity:a==='overtime'?Number($('entryHours').value):1,eventDate:$('entryDate').value,reason:($('entryReason')?.value||'').trim(),overtimeMultiplier:a==='overtime'?Number($('entryOvertimeMultiplier').value):1.5});`,
  `const amount=a==='absence'?0:parsePayrollNumber($('entryNumber').value);const r=await window.api.payroll.addTransaction({monthId:m,employeeId:u,type:a,amount:a==='overtime'?0:amount,quantity:a==='overtime'?parsePayrollNumber($('entryHours').value):1,eventDate:$('entryDate').value,reason:($('entryReason')?.value||'').trim(),overtimeMultiplier:a==='overtime'?parsePayrollNumber($('entryOvertimeMultiplier').value):1.5});`,
  'payroll.js entryHours/entryOvertimeMultiplier read');

patch('renderer/pages/products.js', 'price: parseFloat(fieldPrice.value) || 0,', 'price: parseLocaleNumber(fieldPrice.value) || 0,', 'products.js fieldPrice');
patch('renderer/pages/products.js', 'cost: parseFloat(fieldCost.value) || 0,', 'cost: parseLocaleNumber(fieldCost.value) || 0,', 'products.js fieldCost');
patch('renderer/pages/products.js', 'taxRate: parseFloat(fieldTax.value) || 0,', 'taxRate: parseLocaleNumber(fieldTax.value) || 0,', 'products.js fieldTax');
patch('renderer/pages/products.js',
  'payload.stock = fieldTrackInventory.checked ? parseFloat(fieldStock.value) || 0 : undefined;',
  'payload.stock = fieldTrackInventory.checked ? parseLocaleNumber(fieldStock.value) || 0 : undefined;', 'products.js fieldStock(1)');
patch('renderer/pages/products.js',
  'payload.minQuantity = fieldTrackInventory.checked ? parseFloat(fieldMinQty.value) || 0 : undefined;',
  'payload.minQuantity = fieldTrackInventory.checked ? parseLocaleNumber(fieldMinQty.value) || 0 : undefined;', 'products.js fieldMinQty(1)');
patch('renderer/pages/products.js', 'payload.initialStock = parseFloat(fieldStock.value) || 0;', 'payload.initialStock = parseLocaleNumber(fieldStock.value) || 0;', 'products.js fieldStock(2)');
patch('renderer/pages/products.js', 'payload.minQuantity = parseFloat(fieldMinQty.value) || 0;', 'payload.minQuantity = parseLocaleNumber(fieldMinQty.value) || 0;', 'products.js fieldMinQty(2)');

patch('renderer/pages/settings.js',
  'currencyCode: fieldGlobalCurrency.value, currencyMinorUnit: Number(fieldMinorUnit.value),',
  'currencyCode: fieldGlobalCurrency.value, currencyMinorUnit: parseLocaleNumber(fieldMinorUnit.value),', 'settings.js fieldMinorUnit');
patch('renderer/pages/settings.js',
  'await window.api.discount.setMaxCashierPercent(parseFloat(fieldMaxDiscountPercent.value) || 0);',
  'await window.api.discount.setMaxCashierPercent(parseLocaleNumber(fieldMaxDiscountPercent.value) || 0);', 'settings.js fieldMaxDiscountPercent');
patch('renderer/pages/settings.js',
  'await window.api.tax.defaultRate({ save: parseFloat(fieldTaxDefaultRate.value) || 0 });',
  'await window.api.tax.defaultRate({ save: parseLocaleNumber(fieldTaxDefaultRate.value) || 0 });', 'settings.js fieldTaxDefaultRate');
patch('renderer/pages/settings.js',
  'earnPerCurrencyUnit: parseFloat(fieldLoyaltyEarnRate.value) || 0,',
  'earnPerCurrencyUnit: parseLocaleNumber(fieldLoyaltyEarnRate.value) || 0,', 'settings.js fieldLoyaltyEarnRate');
patch('renderer/pages/settings.js',
  'redeemPointsPerCurrencyUnit: parseFloat(fieldLoyaltyRedeemRate.value) || 0,',
  'redeemPointsPerCurrencyUnit: parseLocaleNumber(fieldLoyaltyRedeemRate.value) || 0,', 'settings.js fieldLoyaltyRedeemRate');
patch('renderer/pages/settings.js',
  'await window.api.delivery.setPricing(parseFloat(fieldDeliveryDefaultFee.value) || 0, parseFloat(fieldDeliveryPricePerKm.value) || 0);',
  'await window.api.delivery.setPricing(parseLocaleNumber(fieldDeliveryDefaultFee.value) || 0, parseLocaleNumber(fieldDeliveryPricePerKm.value) || 0);', 'settings.js delivery pricing');

// suppliers.js كان أصلاً يستخدم parseLocaleNumber بكل مكان — لا تعديل مطلوب هناك.

patch('renderer/pages/table-order.js', 'const received = Number(splitCashReceived.value) || 0;', 'const received = parseLocaleNumber(splitCashReceived.value) || 0;', 'table-order.js splitCashReceived');
patch('renderer/pages/table-order.js', 'let val = Math.floor(Number(loyaltyPointsInput.value) || 0);', 'let val = Math.floor(parseLocaleNumber(loyaltyPointsInput.value) || 0);', 'table-order.js loyaltyPointsInput');
patch('renderer/pages/table-order.js', 'const received = parseFloat(cashReceivedInput.value) || 0;', 'const received = parseLocaleNumber(cashReceivedInput.value) || 0;', 'table-order.js cashReceivedInput(1)');
patch('renderer/pages/table-order.js', 'const cashPart = parseFloat(mixedCashInput.value) || 0;', 'const cashPart = parseLocaleNumber(mixedCashInput.value) || 0;', 'table-order.js mixedCashInput(1)');
patch('renderer/pages/table-order.js',
  'effectiveTotal() - (parseFloat(mixedCashInput.value) || 0) - (parseFloat(mixedCardInput.value) || 0)',
  'effectiveTotal() - (parseLocaleNumber(mixedCashInput.value) || 0) - (parseLocaleNumber(mixedCardInput.value) || 0)', 'table-order.js remaining calc');
patch('renderer/pages/table-order.js', 'cashAmount = parseFloat(cashReceivedInput.value) || 0;', 'cashAmount = parseLocaleNumber(cashReceivedInput.value) || 0;', 'table-order.js cashReceivedInput(2)');
patch('renderer/pages/table-order.js', 'cashAmount = parseFloat(mixedCashInput.value) || 0;', 'cashAmount = parseLocaleNumber(mixedCashInput.value) || 0;', 'table-order.js mixedCashInput(2)');
patch('renderer/pages/table-order.js', 'cardAmount = parseFloat(mixedCardInput.value) || 0;', 'cardAmount = parseLocaleNumber(mixedCardInput.value) || 0;', 'table-order.js mixedCardInput(2)');
// خانة الكمية الديناميكية بمودال "تقسيم الفاتورة" (data-item-id، بدون id ثابت)
patch('renderer/pages/table-order.js',
  'data-tax="${i.taxRate || 0}" type="number" min="0" max="${i.quantity}" value="0" step="1" style="width:75px"',
  'data-tax="${i.taxRate || 0}" type="text" inputmode="numeric" data-max="${i.quantity}" value="0" style="width:75px"',
  'table-order.js split-qty HTML');
patch('renderer/pages/table-order.js',
  `splitItems.querySelectorAll('.split-qty').forEach(el => { const q = Math.min(Number(el.max), Math.max(0, Number(el.value) || 0)); el.value = q; total += q * Number(el.dataset.price) * (1 + Number(el.dataset.tax) / 100); });`,
  `splitItems.querySelectorAll('.split-qty').forEach(el => { const q = Math.min(Number(el.dataset.max), Math.max(0, parseLocaleNumber(el.value) || 0)); el.value = q; total += q * Number(el.dataset.price) * (1 + Number(el.dataset.tax) / 100); });`,
  'table-order.js split-qty total calc');
patch('renderer/pages/table-order.js',
  `const selected = [...splitItems.querySelectorAll('.split-qty')].map(el => ({ saleItemId: Number(el.dataset.itemId), quantity: Number(el.value) || 0 })).filter(x => x.quantity > 0);`,
  `const selected = [...splitItems.querySelectorAll('.split-qty')].map(el => ({ saleItemId: Number(el.dataset.itemId), quantity: parseLocaleNumber(el.value) || 0 })).filter(x => x.quantity > 0);`,
  'table-order.js split-qty selection');

patch('renderer/pages/tables.js', 'seats: parseInt(fieldTableSeats.value, 10) || 4,', 'seats: Math.floor(parseLocaleNumber(fieldTableSeats.value)) || 4,', 'tables.js fieldTableSeats');

console.log(`\nتم: ${okCount} تعديل مطبَّق، ${skipCount} كان مطبَّقاً أصلاً، ${warnCount} تحذير.`);
if (warnCount > 0) {
  console.error('راجع التحذيرات فوق يدوياً — على الأغلب الكود عندك مختلف بمكان بسيط عمّا كان متوقعاً.');
  process.exitCode = 1;
} else {
  console.log('شغّل الآن: node tools/number-input-arabic-digit-regression.js');
}
