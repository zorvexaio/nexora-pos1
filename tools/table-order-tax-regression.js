// Table-order screen (renderer/pages/table-order.js) tax regression.
// Release-blocker found in review: the screen always treated tax as exclusive
// (450 inclusive @10% showed 450 + 45 = 495 instead of 409.09 + 40.91 = 450) and the split
// bill used `price * (1 + tax/100)`. This test executes the real screen code against a stub DOM.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
const commonSrc = read('renderer', 'common.js');
const screenSrc = read('renderer', 'pages', 'table-order.js');

// ---- static guards: the old exclusive-only formulas must be gone ----
assert.ok(!/i\.taxRate \/ 100/.test(screenSrc), 'no exclusive-only cart tax formula remains');
assert.ok(!/1 \+ Number\(el\.dataset\.tax\) \/ 100/.test(screenSrc), 'no exclusive-only split formula remains');
assert.ok(!/toFixed\(2\)/.test(screenSrc), 'no hard-coded 2-decimal money formatting in table-order.js');
assert.ok(/sumCartTax\(cart, orgMinorUnit\)/.test(screenSrc), 'cart preview uses the shared tax engine');
assert.ok(/saved\?\.grandTotal/.test(screenSrc), 'checkout uses the backend total returned by the save');
console.log('PASS: static guards (no exclusive-only formulas, no fixed 2-decimals, shared engine, backend total)');

// ---- executable harness ----
function makeEl(id) {
  const el = {
    id, value: '', textContent: '', innerHTML: '', checked: false, disabled: false, style: {}, dataset: {},
    classList: (() => { const cls = new Set(['hidden']); return { add: (c) => cls.add(c), remove: (c) => cls.delete(c), toggle: (c) => (cls.has(c) ? cls.delete(c) : cls.add(c)), contains: (c) => cls.has(c) }; })(),
    addEventListener() {}, removeEventListener() {}, appendChild() {}, focus() {}, select() {}, remove() {}, click() {},
    setAttribute() {}, getAttribute: () => null,
    querySelector: () => makeEl('q'), querySelectorAll: () => [],
  };
  return el;
}
function boot(splitLines = []) {
  const els = new Map();
  const document = {
    body: makeEl('body'), documentElement: { getAttribute: () => 'ar', setAttribute() {} },
    getElementById: (id) => { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); },
    querySelector: () => makeEl('q'), querySelectorAll: () => [],
    createElement: () => makeEl('c'), addEventListener() {}, activeElement: null,
  };
  const api = new Proxy({}, { get: (t, ns) => (ns in t ? t[ns] : new Proxy({}, { get: (_, fn) => async () => ({}) })) });
  const state = { setItemsCalls: 0, toasts: [] };
  api.tables = new Proxy({}, { get: (_, fn) => fn === 'setItems'
    ? async () => { state.setItemsCalls++; if (state.failSave) throw new Error(state.failSave); return state.backendTotal == null ? {} : { grandTotal: state.backendTotal }; }
    : async () => ({}) });
  const ctx = { document, console, URLSearchParams, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {}, requestAnimationFrame: () => 0, performance, Promise, Map, Set, Array, Object, String, Boolean, parseInt, parseFloat, isNaN, encodeURIComponent, Error, Symbol, RegExp, Intl, Math, Number, Date, JSON,
    window: { location: { search: '?tableId=1', href: '' }, api, addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) },
    localStorage: { getItem: () => null, setItem() {} }, t: (k, f) => f || k, tf: (k) => k, showToast: (m, type) => state.toasts.push({ m, type }), };
  ctx.window.document = document;
  vm.createContext(ctx);
  // Swallow the async init() of the real screen: we drive the exported functions directly.
  process.on('unhandledRejection', () => {});
  vm.runInContext(commonSrc, ctx);
  ctx.showToast = (m, type) => state.toasts.push({ m, type }); // common.js defines the real one; capture instead
  vm.runInContext(screenSrc, ctx);
  return { ctx, els, state };
}
const run = (env, code) => vm.runInContext(code, env.ctx);
const flush = () => new Promise((r) => setTimeout(r, 20));

(async () => {
  let checks = 0;
  const ok = (c, m) => { assert.ok(c, m); checks++; console.log('PASS:', m); };

  // 1) The review example: 450 inclusive @10%
  let env = boot();
  await flush();
  run(env, "orgTaxMode='exclusive'; orgMinorUnit=2; cart=[{lineId:1,productId:1,name:'A',price:450,taxRate:10,taxInclusive:true,quantity:1,notes:''}]; renderCart();");
  ok(env.els.get('sumSubtotal')?.textContent === '409.09' && env.els.get('sumTax')?.textContent === '40.91' && env.els.get('sumTotal')?.textContent === '450.00',
    'inclusive 450 @10% shows 409.09 + 40.91 = 450.00 (not 495)');

  // 2) Exclusive unchanged
  run(env, "cart=[{lineId:1,productId:1,name:'A',price:450,taxRate:10,taxInclusive:false,quantity:1,notes:''}]; renderCart();");
  ok(env.els.get('sumSubtotal').textContent === '450.00' && env.els.get('sumTax').textContent === '45.00' && env.els.get('sumTotal').textContent === '495.00',
    'exclusive 450 @10% still adds tax on top (450 + 45 = 495)');

  // 3) Mixed cart
  run(env, "cart=[{lineId:1,productId:1,name:'A',price:450,taxRate:10,taxInclusive:true,quantity:1,notes:''},{lineId:2,productId:2,name:'B',price:100,taxRate:10,taxInclusive:false,quantity:1,notes:''},{lineId:3,productId:3,name:'C',price:50,taxRate:0,taxInclusive:true,quantity:1,notes:''}]; renderCart();");
  ok(env.els.get('sumSubtotal').textContent === '559.09' && env.els.get('sumTax').textContent === '50.91' && env.els.get('sumTotal').textContent === '610.00',
    'mixed inclusive / exclusive / zero-rate cart totals 610.00');

  // 4) Lines built from stored sale items and from products follow backend rules
  ok(run(env, "cartLineFromSaleItem({product_id:1,product_name:'A',unit_price:450,tax_rate:10,tax_inclusive:1,quantity:1,id:9}).taxInclusive") === true, 'stored sale item keeps its inclusive flag (historical sales as stored)');
  run(env, "orgTaxMode='inclusive'");
  ok(run(env, "productTaxInfo({tax_rate:10}).taxInclusive") === true, 'product without profile follows the organization mode (inclusive)');
  ok(run(env, "productTaxInfo({tax_rate:10, tax_profile_rate:5, tax_profile_inclusive:0})").taxInclusive === false, 'product tax profile overrides the organization mode');
  run(env, "orgTaxMode='exclusive'");

  // 5) Checkout uses the backend total (sentinel value proves it is not recomputed locally)
  env.state.backendTotal = 123.45;
  run(env, "orgTaxMode='exclusive'; cart=[{lineId:1,productId:1,name:'A',price:450,taxRate:10,taxInclusive:true,quantity:1,notes:''}]; currentSaleId=1;");
  await run(env, 'checkout()');
  ok(run(env, 'currentTotal') === 123.45 && env.state.setItemsCalls === 1, 'checkout total is the backend grandTotal returned by the save');
  env.state.backendTotal = null;
  await run(env, 'checkout()');
  ok(run(env, 'currentTotal') === 450, 'fallback preview (inclusive 450 @10%) is 450, not 495, if the save returns no total');

  // 5b) A failed save must NOT open the payment modal (no phantom total), and must tell the user why
  env = boot(); await flush();
  env.state.failSave = 'المخزون غير كافٍ للصنف #1. المتاح 0 والمطلوب 1.';
  run(env, "orgMinorUnit=2; cart=[{lineId:1,productId:1,name:'A',price:450,taxRate:10,taxInclusive:true,quantity:1,notes:''}]; currentSaleId=1; currentTotal=-1;");
  await run(env, 'checkout()');
  ok(run(env, "paymentModal.classList.contains('hidden')") === true, 'save failure -> payment modal stays closed');
  ok(env.state.toasts.some((x) => x.type === 'error' && x.m.includes('المخزون غير كافٍ')), 'save failure -> the reason is shown to the user');
  ok(run(env, 'currentTotal') === -1, 'save failure -> no stale total is adopted');
  await run(env, 'openSplitBill()');
  ok(run(env, "splitBillModal.classList.contains('hidden')") === true, 'save failure -> split modal stays closed');
  env.state.failSave = null; env.state.backendTotal = 450;
  await run(env, 'checkout()');
  ok(run(env, "paymentModal.classList.contains('hidden')") === false, 'retry after the failure opens the payment modal');
  // double click: only one save
  env = boot(); await flush(); env.state.backendTotal = 450;
  run(env, "cart=[{lineId:1,productId:1,name:'A',price:450,taxRate:10,taxInclusive:true,quantity:1,notes:''}]; currentSaleId=1;");
  await Promise.all([run(env, 'checkout()'), run(env, 'checkout()')]);
  ok(env.state.setItemsCalls === 1, 'double click on checkout saves once');

  // 6) Split bill: inclusive / exclusive / mixed, 3 currencies
  const cases = [
    { unit: 2, lines: [{ price: 450, qty: 1, rate: 10, inc: 1 }], total: 450 },
    { unit: 2, lines: [{ price: 450, qty: 1, rate: 10, inc: 0 }], total: 495 },
    { unit: 2, lines: [{ price: 9.99, qty: 3, rate: 15, inc: 1 }, { price: 3.33, qty: 7, rate: 5, inc: 0 }, { price: 0.05, qty: 13, rate: 10, inc: 1 }], total: null },
    { unit: 0, lines: [{ price: 999, qty: 3, rate: 5, inc: 0 }], total: 3147 },
    { unit: 3, lines: [{ price: 31.101, qty: 3, rate: 5, inc: 0 }], total: 97.968 },
  ];
  for (const c of cases) {
    env = boot(); await flush();
    const rows = c.lines.map((l) => ({ dataset: { price: String(l.price), tax: String(l.rate), inclusive: String(l.inc), max: String(l.qty) }, value: String(l.qty) }));
    run(env, 'splitItems').querySelectorAll = () => rows;
    run(env, `orgMinorUnit=${c.unit}`);
    run(env, 'updateSplitTotal()');
    // independent reference (integer, per line)
    const scale = 10 ** c.unit;
    const ref = c.lines.reduce((s, l) => {
      const gross = Math.round(Math.round(l.price * scale) * l.qty);
      const den = l.inc ? 100 + l.rate : 100;
      const tax = Math.floor((gross * l.rate * 2 + den) / (2 * den));
      return s + (l.inc ? gross : gross + tax);
    }, 0) / scale;
    const shown = run(env, 'splitTotal').textContent;
    assert.equal(shown, ref.toFixed(c.unit), `split total unit=${c.unit}`);
    if (c.total != null) assert.equal(Number(shown), c.total, `split total expected ${c.total}`);
    checks++;
    console.log(`PASS: split bill (${c.unit} decimals, ${c.lines.length} line/s) = ${shown}`);
  }

  // 7) 0 / 3 decimal display in the cart
  for (const [unit, exp] of [[0, '3147'], [3, '97.968']]) {
    env = boot(); await flush();
    const price = unit === 0 ? 999 : 31.101;
    run(env, `orgMinorUnit=${unit}; cart=[{lineId:1,productId:1,name:'A',price:${price},taxRate:5,taxInclusive:false,quantity:3,notes:''}]; renderCart();`);
    assert.equal(env.els.get('sumTotal').textContent, exp);
    checks++; console.log(`PASS: cart total shows ${exp} for a ${unit}-decimal currency`);
  }
  console.log(`TABLE-ORDER TAX REGRESSION: PASS (${checks + 5} checks)`);
})().catch((e) => { console.error(e); process.exit(1); });
