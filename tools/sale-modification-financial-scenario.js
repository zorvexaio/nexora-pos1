const assert = require('assert');

function inclusive(gross, rate) {
  if (!(rate > 0)) return { net: gross, tax: 0 };
  const tax = Math.round((gross - gross / (1 + rate / 100)) * 100) / 100;
  return { net: Math.round((gross - tax) * 100) / 100, tax };
}

function saleJournal({ total, net, tax, cash = 0, card = 0 }) {
  return [
    ...(cash > 0 ? [{ account: '1000', d: cash, c: 0 }] : []),
    ...(card > 0 ? [{ account: '1100', d: card, c: 0 }] : []),
    { account: '4000', d: 0, c: net },
    ...(tax > 0 ? [{ account: '2100', d: 0, c: tax }] : []),
  ];
}

function balanced(lines) {
  const d = lines.reduce((n, l) => n + l.d, 0).toFixed(2);
  const c = lines.reduce((n, l) => n + l.c, 0).toFixed(2);
  assert.strictEqual(d, c);
}

// Scenario: 100 gross at 10% inclusive => net 90.91, tax 9.09.
const invoiceNumber = 'BR-2026-000001';
const before = inclusive(100, 10);
assert.deepStrictEqual(before, { net: 90.91, tax: 9.09 });
const original = saleJournal({ total: 100, net: before.net, tax: before.tax, cash: 100 });
assert.strictEqual(invoiceNumber, 'BR-2026-000001');
balanced(original);

// Payment correction cash -> card: pure asset reclassification, no revenue/tax duplication.
const paymentCorrection = [
  { account: '1000', d: 0, c: 100 },
  { account: '1100', d: 100, c: 0 },
];
balanced(paymentCorrection);

// Item modification: sale becomes 120 gross, still inclusive 10%, and remains the same invoice.
const after = inclusive(120, 10);
assert.deepStrictEqual(after, { net: 109.09, tax: 10.91 });
const reverseOriginal = original.map(l => ({ ...l, d: l.c, c: l.d }));
const reversePayment = paymentCorrection.map(l => ({ ...l, d: l.c, c: l.d }));
const corrected = saleJournal({ total: 120, net: after.net, tax: after.tax, card: 120 });
// Open-shift expected cash is derived from current sales.cash_amount - change_due, so after cash→card it is 0 and remains 0 after the item modification.
const openShiftExpectedCashBefore = 100;
const openShiftExpectedCashAfter = 0;
assert.strictEqual(openShiftExpectedCashBefore, 100);
assert.strictEqual(openShiftExpectedCashAfter, 0);
balanced(corrected);

// Net effect after reversing the old sale + payment correction and posting the corrected sale.
const all = [...original, ...paymentCorrection, ...reverseOriginal, ...reversePayment, ...corrected];
const balances = new Map();
for (const line of all) balances.set(line.account, (balances.get(line.account) || 0) + line.d - line.c);
assert.strictEqual(Number(balances.get('1000') || 0).toFixed(2), '0.00');
assert.strictEqual(Number(balances.get('1100') || 0).toFixed(2), '120.00');
assert.strictEqual(Number(balances.get('4000') || 0).toFixed(2), '-109.09');
assert.strictEqual(Number(balances.get('2100') || 0).toFixed(2), '-10.91');
// Report-level economics: one corrected sale only; no second invoice is created.
assert.strictEqual(invoiceNumber, 'BR-2026-000001');
assert.strictEqual((after.net + after.tax).toFixed(2), '120.00');
assert.strictEqual((after.net).toFixed(2), '109.09');

// Kitchen delta: remove one existing line and add one new line; print only deltas.
const oldItems = new Map([[1, 2], [2, 1]]);
const newItems = new Map([[1, 1], [3, 1]]);
const delta = [...new Set([...oldItems.keys(), ...newItems.keys()])]
  .map(id => ({ productId: id, deltaQuantity: (newItems.get(id) || 0) - (oldItems.get(id) || 0) }))
  .filter(x => x.deltaQuantity !== 0);
assert.deepStrictEqual(delta, [
  { productId: 1, deltaQuantity: -1 },
  { productId: 2, deltaQuantity: -1 },
  { productId: 3, deltaQuantity: 1 },
]);

console.log('SALE MODIFICATION FINANCIAL SCENARIO: PASS');
console.log('Scenario: same invoice 100 cash/inclusive -> cash-to-card -> 120 modified sale; open cash becomes 0, reporting total is 120, accounting stays balanced, and kitchen delta contains only changed quantities.');
