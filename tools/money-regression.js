#!/usr/bin/env node
'use strict';
const assert = require('assert');
const money = require('../core/money');

const cases = [
  ['10.50', 2, 1050],
  ['10.505', 2, 1051],
  ['-10.505', 2, -1051],
  ['0.004', 2, 0],
  ['0.005', 2, 1],
  ['123', 0, 123],
  ['123.456', 3, 123456],
];
for (const [value, unit, expected] of cases) assert.strictEqual(money.toMinor(value, unit), expected);
assert.strictEqual(money.add(9007199254740000, 100), 9007199254740100);
assert.throws(() => money.add(9007199254740991, 1), /out of range/);
assert.strictEqual(money.subtract(1000, 1), 999);
assert.strictEqual(money.multiplyMinorQuantity(123, 0.5), 62);
assert.strictEqual(money.taxMinor(11800, 18, true), 1800);
assert.strictEqual(money.taxMinor(10000, 18, false), 1800);
assert.strictEqual(money.percentageMinor(10000, 12.5), 1250);
console.log('MONEY REGRESSION: PASS');
