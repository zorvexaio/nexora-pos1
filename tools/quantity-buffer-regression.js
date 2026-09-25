#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { MAX_QUANTITY, parseQuickQuantity, canAccumulateQuantity } = require('../renderer/quantity-buffer.js');

assert.strictEqual(MAX_QUANTITY, 9999, 'The quick-quantity ceiling must remain 9,999.');
assert.deepStrictEqual(parseQuickQuantity('1'), { ok: true, quantity: 1 });
assert.deepStrictEqual(parseQuickQuantity('9999'), { ok: true, quantity: 9999 });
assert.deepStrictEqual(parseQuickQuantity('٤٢'), { ok: true, quantity: 42 }, 'Arabic-Indic digits must work.');
assert.deepStrictEqual(parseQuickQuantity('۴۲'), { ok: true, quantity: 42 }, 'Persian digits must work.');
assert.strictEqual(parseQuickQuantity('10000').reason, 'maximum');
assert.strictEqual(parseQuickQuantity('0').reason, 'invalid');
assert.strictEqual(parseQuickQuantity('1.5').reason, 'invalid');
assert.strictEqual(parseQuickQuantity('12x').reason, 'invalid');
assert.strictEqual(canAccumulateQuantity(9995, 4), true);
assert.strictEqual(canAccumulateQuantity(9995, 5), false, 'A line must not accumulate above 9,999.');
assert.strictEqual(canAccumulateQuantity(9999, 1), false);

// يحاكي منطق التحقق المسبق في addBundleToCart (renderer/pos.js): يفحص كل
// أصناف الحزمة أولاً — بما فيها تكرار نفس المنتج داخل الحزمة نفسها — قبل أي
// تعديل على السلة، ويرفض الإضافة بالكامل إن كان أي صنف سيتجاوز 9999.
function wouldBundleBeAccepted(cartLines, bundleItems) {
  const pendingQuantities = new Map();
  for (const item of bundleItems) {
    const existing = cartLines.find((i) => i.productId === item.product_id);
    const currentQuantity = pendingQuantities.has(item.product_id)
      ? pendingQuantities.get(item.product_id)
      : (existing?.quantity ?? 0);
    if (!canAccumulateQuantity(currentQuantity, item.quantity)) return false;
    pendingQuantities.set(item.product_id, currentQuantity + item.quantity);
  }
  return true;
}

// سلة فارغة + حزمة عادية => تُقبل
assert.strictEqual(
  wouldBundleBeAccepted([], [{ product_id: 1, quantity: 2 }, { product_id: 2, quantity: 3 }]),
  true
);
// صنف موجود مسبقاً بكمية قريبة من السقف + الحزمة تضيف ما يتجاوزه => تُرفض بالكامل
assert.strictEqual(
  wouldBundleBeAccepted([{ productId: 1, quantity: 9998 }], [{ product_id: 1, quantity: 5 }]),
  false,
  'Bundle add must be rejected entirely when it would push a line past 9,999.'
);
// نفس المنتج مكرر مرتين داخل تعريف الحزمة نفسها يجب أن يُجمع قبل المقارنة بالسقف
assert.strictEqual(
  wouldBundleBeAccepted([], [{ product_id: 1, quantity: 6000 }, { product_id: 1, quantity: 4000 }]),
  false,
  'Duplicate product lines within one bundle must accumulate before the 9,999 check.'
);
// حالة حدّية: تصل بالضبط إلى 9999 يجب أن تُقبل
assert.strictEqual(
  wouldBundleBeAccepted([{ productId: 1, quantity: 9997 }], [{ product_id: 1, quantity: 2 }]),
  true
);

console.log('QUANTITY BUFFER REGRESSION: PASS (input parsing, 9,999 accumulation guard, bundle-add path)');
