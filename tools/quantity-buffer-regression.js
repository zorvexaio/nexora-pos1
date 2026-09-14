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

console.log('QUANTITY BUFFER REGRESSION: PASS (input parsing and 9,999 accumulation guard)');
