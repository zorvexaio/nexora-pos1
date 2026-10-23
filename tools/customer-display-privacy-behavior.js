// اختبار سلوكي لشاشة الزبون: التنقية تُسقط أي حقل داخلي (تكلفة، ربح، دين...)،
// وتقصّ النصوص الطويلة، وتقبل الحالات المعروفة فقط.
const path = require('path');
const { sanitizeCustomerDisplayState } = require(path.join(__dirname, '..', 'lib', 'customer-display-state.js'));

let failures = 0;
function check(name, condition, detail = '') {
  if (condition) console.log(`PASS: ${name}`);
  else { failures += 1; console.log(`FAIL: ${name}${detail ? ' — ' + detail : ''}`); }
}

const hostile = {
  state: 'cart', lang: 'ar', cost: 9991, profit: 7777, customerDebt: 6666, loyaltyPoints: 5555,
  items: [{ name: 'Milk', qty: '2', unit: '5.00', line: '10.00', cost: 4444, costPerUnit: 2222, note: 'secret-note' }],
  totals: [{ label: 'Total', value: '10.00', strong: 1, internal: 'x' }],
};
const out = sanitizeCustomerDisplayState(hostile);
const json = JSON.stringify(out);
check('internal cost fields are dropped', !/9991|4444|2222/.test(json));
check('profit / debt / loyalty fields are dropped', !/7777|6666|5555/.test(json));
check('item internal note is dropped', !json.includes('secret-note'));
check('only whitelisted item keys remain', Object.keys(out.items[0]).sort().join(',') === 'line,name,qty,unit');
check('only whitelisted total keys remain', Object.keys(out.totals[0]).sort().join(',') === 'label,strong,value');
check('strong flag is coerced to boolean', out.totals[0].strong === true);

const longName = 'x'.repeat(500);
const clipped = sanitizeCustomerDisplayState({ items: [{ name: longName, qty: '1', unit: '1', line: '1' }] });
check('overlong item name is clipped to 80 chars', clipped.items[0].name.length === 80);

const many = sanitizeCustomerDisplayState({ items: Array.from({ length: 1000 }, (_, i) => ({ name: 'i' + i })) });
check('item list is capped at 200 rows', many.items.length === 200);

const badState = sanitizeCustomerDisplayState({ state: 'hacked', lang: 'fr' });
check('unknown state falls back to cart', badState.state === 'cart');
check('unknown language falls back to Arabic', badState.lang === 'ar');

const nothing = sanitizeCustomerDisplayState(null);
check('null input yields an empty cart state', nothing.state === 'cart' && nothing.items.length === 0 && nothing.totals.length === 0);

if (failures) { console.log(`CUSTOMER DISPLAY PRIVACY: ${failures} FAILED`); process.exit(1); }
console.log('CUSTOMER DISPLAY PRIVACY: PASS');
