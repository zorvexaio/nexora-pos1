// Receipt formatting regression: amounts follow the currency's minor unit (0/2/3),
// and tax-inclusive invoices carry an explicit "prices include tax" note that is
// derived from the stored invoice items (historical sales stay as stored).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'receipt.js'), 'utf8');

function render(sale, currency) {
  const receipt = { innerHTML: '', textContent: '' };
  const ctx = {
    URLSearchParams,
    window: { location: { search: '' }, api: {} },
    document: {
      body: { dataset: {} },
      documentElement: { getAttribute: () => 'en' },
      getElementById: (id) => (id === 'receipt' ? receipt : null),
      createElement: () => {
        let text = '';
        return { set textContent(v) { text = String(v); }, get innerHTML() { return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); } };
      },
    },
    t: (k) => k,
    applyTranslations: () => {},
    console,
  };
  ctx.window.document = ctx.document;
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  vm.runInContext('renderReceipt(__sale, {}, __cur)', Object.assign(ctx, { __sale: sale, __cur: currency }));
  return receipt.innerHTML;
}
const row = (html, label, value) => new RegExp(`${label}</span><span>${value}</span>`).test(html);
const base = { id: 1, invoice_number: 'INV-1', created_at: '2026-09-21 10:00:00', payment_method: 'cash', cash_amount: 0, change_due: 0, card_amount: 0, discount_total: 0, order_type: 'dine_in' };
let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks++; console.log('PASS:', msg); };

// Inclusive 450 @ 10% -> net 409.09 + tax 40.91 = 450.00 (standard extraction, not 405 + 45)
let html = render({ ...base, subtotal: 409.09, tax_total: 40.91, grand_total: 450, cash_amount: 450,
  items: [{ product_name: 'A', quantity: 1, unit_price: 450, line_total: 450, tax_rate: 10, tax_inclusive: 1 }] }, { minorUnit: 2, base: 'USD' });
ok(row(html, 'common.subtotal', '409.09') && row(html, 'common.tax', '40.91'), 'inclusive receipt shows 409.09 + 40.91');
ok(html.includes('450.00 USD'), 'inclusive receipt total is 450.00');
ok(html.includes('receipt.pricesIncludeTax'), 'inclusive receipt states that prices include tax');

// Exclusive: no inclusive note
html = render({ ...base, subtotal: 100, tax_total: 10, grand_total: 110, cash_amount: 110,
  items: [{ product_name: 'A', quantity: 1, unit_price: 100, line_total: 100, tax_rate: 10, tax_inclusive: 0 }] }, { minorUnit: 2 });
ok(!html.includes('receipt.pricesIncludeTax') && !html.includes('receipt.someItemsIncludeTax'), 'exclusive receipt has no inclusive note');

// Mixed invoice
html = render({ ...base, subtotal: 190.91, tax_total: 19.09, grand_total: 210, cash_amount: 210,
  items: [{ product_name: 'A', quantity: 1, unit_price: 110, line_total: 110, tax_rate: 10, tax_inclusive: 1 },
          { product_name: 'B', quantity: 1, unit_price: 100, line_total: 100, tax_rate: 0, tax_inclusive: 0 }] }, { minorUnit: 2 });
ok(html.includes('receipt.pricesIncludeTax'), 'zero-rate items do not hide the inclusive note');
html = render({ ...base, subtotal: 200, tax_total: 20, grand_total: 220, cash_amount: 220,
  items: [{ product_name: 'A', quantity: 1, unit_price: 110, line_total: 110, tax_rate: 10, tax_inclusive: 1 },
          { product_name: 'B', quantity: 1, unit_price: 100, line_total: 100, tax_rate: 10, tax_inclusive: 0 }] }, { minorUnit: 2 });
ok(html.includes('receipt.someItemsIncludeTax'), 'mixed inclusive/exclusive invoice gets the mixed note');

// No tax -> no note
html = render({ ...base, subtotal: 50, tax_total: 0, grand_total: 50, cash_amount: 50,
  items: [{ product_name: 'A', quantity: 1, unit_price: 50, line_total: 50, tax_rate: 0, tax_inclusive: 1 }] }, { minorUnit: 2 });
ok(!html.includes('receipt.pricesIncludeTax'), 'no tax -> no inclusive note');

// Minor units
html = render({ ...base, subtotal: 2997, tax_total: 150, grand_total: 3147, cash_amount: 3200, change_due: 53,
  items: [{ product_name: 'A', quantity: 3, unit_price: 999, line_total: 2997, tax_rate: 5, tax_inclusive: 0 }] }, { minorUnit: 0, base: 'JPY' });
ok(html.includes('3 × 999<') && row(html, 'common.tax', '150') && html.includes('3147 JPY') && !/\d\.00/.test(html), '0-decimal currency prints whole numbers (no .00)');
html = render({ ...base, subtotal: 93.303, tax_total: 4.665, grand_total: 97.968, cash_amount: 97.968,
  items: [{ product_name: 'A', quantity: 3, unit_price: 31.101, line_total: 93.303, tax_rate: 5, tax_inclusive: 0 }] }, { minorUnit: 3, base: 'KWD' });
ok(row(html, 'common.subtotal', '93.303') && row(html, 'common.tax', '4.665') && html.includes('97.968 KWD'), '3-decimal currency prints 3 decimals');

// Missing minorUnit falls back to 2 decimals (old behaviour)
html = render({ ...base, subtotal: 10, tax_total: 0, grand_total: 10, cash_amount: 10, items: [] }, {});
ok(row(html, 'common.subtotal', '10.00'), 'missing minor unit falls back to 2 decimals');

console.log(`RECEIPT FORMAT REGRESSION: PASS ${checks}/${checks}`);
