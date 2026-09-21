// The POS cart / invoice-modification preview must round tax exactly like the backend
// (core/money.js: per-line, minor units, half-up). Compares renderer/common.js helpers with
// core/money.js on a large deterministic sample for 0/2/3-decimal currencies.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const money = require('../core/money');

const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'common.js'), 'utf8');
const start = src.indexOf('function computeCartLineTax');
const end = src.indexOf('function escapeHtml');
assert.ok(start >= 0 && end > start, 'cart tax helpers are present in renderer/common.js');
const ctx = {};
vm.createContext(ctx);
vm.runInContext(src.slice(start, end), ctx);

// deterministic PRNG
let seed = 20260921;
const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
const RATES = [0, 5, 10, 15, 7.5, 14, 18, 20];
const QTYS = [1, 2, 3, 7, 13, 0.5, 2.5, 0.333, 1.25, 10];
let n = 0;
for (const unit of [0, 2, 3]) {
  const scale = 10 ** unit;
  for (let k = 0; k < 4000; k++) {
    const priceMinor = Math.floor(rnd() * 200000) + (rnd() < 0.3 ? 0 : 1);
    const price = priceMinor / scale;
    const qty = QTYS[Math.floor(rnd() * QTYS.length)];
    const rate = RATES[Math.floor(rnd() * RATES.length)];
    const inclusive = rnd() < 0.5;
    const ui = ctx.computeCartLineTax(price, qty, rate, inclusive, unit);
    const grossMinor = money.multiplyMinorQuantity(money.toMinor(price, unit), qty);
    const taxMinor = money.taxMinor(grossMinor, rate, inclusive);
    assert.equal(ui.grossMinor, grossMinor, `gross unit=${unit} price=${price} qty=${qty}`);
    assert.equal(ui.taxMinor, taxMinor, `tax unit=${unit} price=${price} qty=${qty} rate=${rate} inclusive=${inclusive}`);
    assert.equal(ui.netMinor, inclusive ? Math.max(0, grossMinor - taxMinor) : grossMinor, 'net');
    n++;
  }
}
console.log(`PASS: cart preview == backend rounding on ${n} lines (units 0/2/3, rates 0-20%, inclusive+exclusive)`);

// Example from the review: 450 inclusive @10% -> 409.09 + 40.91 (not 405 + 45)
const one = ctx.sumCartTax([{ price: 450, quantity: 1, taxRate: 10, taxInclusive: true }], 2);
assert.equal(one.subtotal, 409.09);
assert.equal(one.tax, 40.91);
console.log('PASS: 450 inclusive @10% -> 409.09 + 40.91');

// Multi-line invoice where summing unrounded floats differs from per-line rounding
const lines = [{ price: 3.33, quantity: 3, taxRate: 5, taxInclusive: false }, { price: 0.05, quantity: 13, taxRate: 5, taxInclusive: false }, { price: 9.99, quantity: 7, taxRate: 5, taxInclusive: false }];
const sum = ctx.sumCartTax(lines, 2);
const expTax = lines.reduce((s, l) => s + money.taxMinor(money.multiplyMinorQuantity(money.toMinor(l.price, 2), l.quantity), 5, false), 0) / 100;
assert.equal(sum.tax, expTax);
console.log('PASS: multi-line total tax equals sum of per-line rounded taxes');
console.log('CART TAX UI PARITY REGRESSION: PASS');
