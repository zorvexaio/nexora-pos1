// Open table orders keep the price / tax rate / tax mode (inclusive|exclusive) / cost they were
// added with. Changing the product price, tax rate or the organization tax mode afterwards must not
// re-price the order — not on re-save, not on split, not on close, not in the ledger.
// New lines added later use the values current at that moment (mixed cart). Needs native SQLite.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const RATES = [0, 5, 10, 15];
const MODES = ['exclusive', 'inclusive'];
const CURRENCIES = [
  { code: 'USD', minor: 2, prices: [9.99, 3.33] },
  { code: 'KWD', minor: 3, prices: [9.999, 3.333] },
  { code: 'JPY', minor: 0, prices: [999, 333] },
];
const QTY = [3, 2];

function refTax(gross, rate, inclusive) {
  if (!rate) return 0;
  const den = inclusive ? 100 + rate : 100;
  return Math.floor((gross * rate * 2 + den) / (2 * den));
}
// lines: [{ unitMinor, qty, rate, inclusive }]
function ref(lines) {
  let sub = 0, tax = 0;
  for (const l of lines) {
    const gross = Math.round(l.unitMinor * l.qty);
    const t = refTax(gross, l.rate, l.inclusive);
    tax += t; sub += l.inclusive ? gross - t : gross;
  }
  return { sub, tax, total: sub + tax };
}

if (process.argv[2] !== '--child') {
  let failed = 0;
  for (const c of CURRENCIES) {
    const r = spawnSync(process.execPath, [__filename, '--child', c.code], { encoding: 'utf8' });
    process.stdout.write(r.stdout || '');
    if (r.status !== 0) { failed++; process.stderr.write(r.stderr || ''); }
  }
  if (failed) { console.error('OPEN ORDER SNAPSHOT REGRESSION: FAIL'); process.exit(1); }
  console.log('OPEN ORDER SNAPSHOT REGRESSION: PASS');
  process.exit(0);
}

const Module = require('node:module');
const cur = CURRENCIES.find((c) => c.code === process.argv[3]);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexora-snapshot-'));
const originalLoad = Module._load;
Module._load = function (request) {
  if (request === 'electron') return { app: { getPath: () => dataDir }, safeStorage: { isEncryptionAvailable: () => true, encryptString: (v) => Buffer.from(String(v)), decryptString: (v) => Buffer.from(v).toString('utf8') } };
  return originalLoad.apply(this, arguments);
};
const db = require('../database/db');
const scale = 10 ** cur.minor;
const toMajor = (m) => m / scale;
const toMinorRef = (v) => Math.round(v * scale);
const tol = 0.5 / scale;
const close = (a, b, msg) => assert.ok(Math.abs(a - b) < tol, `${msg}: expected ${b}, got ${a}`);
const taxPayable = () => { const a = db.getTrialBalance().accounts.find((x) => x.code === '2100'); return a ? Number(a.credit || 0) - Number(a.debit || 0) : 0; };

try {
  db.init();
  const admin = db.listUsers().find((u) => u.role === 'admin');
  const shift = db.openShift(0, admin.id);
  const base = db.getGlobalProfile();
  const setMode = (taxMode) => db.setGlobalProfile({ countryCode: base.country_code, locale: base.locale, timezone: base.timezone, currencyCode: cur.code, currencyMinorUnit: cur.minor, taxMode, taxRegistrationNumber: '', fiscalizationMode: 'none', fiscalProvider: '' });
  const other = (m) => (m === 'inclusive' ? 'exclusive' : 'inclusive');
  const bump = (v) => Math.round(v * 1.5 * scale) / scale;
  const mkp = (name, price, taxRate) => ({ ...db.createProduct({ name, price, cost: 0, taxRate, trackInventory: false }), name });
  let n = 0;
  const mutateProducts = (products, prices) => products.forEach((p, i) => db.updateProduct({ id: p.id, name: p.name, price: bump(prices[i]), cost: 0, taxRate: 20, trackInventory: false }));

  for (const mode of MODES) {
    for (const rate of RATES) {
      const label = `${cur.code} ${mode} ${rate}%`;
      setMode(mode);
      const inc = mode === 'inclusive';
      const products = cur.prices.map((price, i) => mkp(`snap-${cur.code}-${mode}-${rate}-${i}`, price, rate));
      const items = products.map((p, i) => ({ productId: p.id, quantity: QTY[i] }));
      const E = ref(cur.prices.map((pr, i) => ({ unitMinor: toMinorRef(pr), qty: QTY[i], rate, inclusive: inc })));

      const table = db.createTable({ name: `snap-${label}`, seats: 2 });
      const order = db.getOrCreateOpenSale(table.id, admin.id);
      const first = db.setOpenSaleItems(order.id, items);
      close(first.grandTotal, toMajor(E.total), `${label} initial total`);

      // hostile changes after the items were added: price x1.5, tax 20 %, opposite organization tax mode
      mutateProducts(products, cur.prices);
      setMode(other(mode));
      const again = db.setOpenSaleItems(order.id, items);
      close(again.subtotal, toMajor(E.sub), `${label} re-save subtotal`);
      close(again.taxTotal, toMajor(E.tax), `${label} re-save tax`);
      close(again.grandTotal, toMajor(E.total), `${label} re-save total`);
      const stored = db.getSale(order.id).items;
      stored.forEach((it, i) => { close(Number(it.unit_price), cur.prices[i], `${label} stored unit price`); assert.equal(Number(it.tax_rate), rate, `${label} stored tax rate`); assert.equal(Number(it.tax_inclusive), inc ? 1 : 0, `${label} stored inclusive flag`); });

      // quantity change on an existing line keeps the snapshot price/tax
      const items2 = [{ productId: products[0].id, quantity: QTY[0] + 1 }, items[1]];
      const E2 = ref(cur.prices.map((pr, i) => ({ unitMinor: toMinorRef(pr), qty: i === 0 ? QTY[0] + 1 : QTY[1], rate, inclusive: inc })));
      close(db.setOpenSaleItems(order.id, items2).grandTotal, toMajor(E2.total), `${label} quantity change total`);

      // close: sale row + ledger follow the snapshot
      const before = taxPayable();
      const closed = db.closeTableSale(order.id, { paymentMethod: 'cash', cashAmount: toMajor(E2.total), cardAmount: 0, changeDue: 0 }, admin.id, shift.id);
      const sale = db.getSale(closed.id);
      close(Number(sale.grand_total), toMajor(E2.total), `${label} closed total`);
      close(Number(sale.tax_total), toMajor(E2.tax), `${label} closed tax`);
      close(taxPayable() - before, toMajor(E2.tax), `${label} tax payable delta`);
      assert.ok(db.getTrialBalance().balanced, `${label} ledger balanced`);
      n++;
    }
  }

  // ---- mixed cart: line 1 added under inclusive, line 2 under exclusive (different mode/price at add time) ----
  setMode('inclusive');
  const p1 = mkp(`mix1-${cur.code}`, cur.prices[0], 10);
  const p2 = mkp(`mix2-${cur.code}`, cur.prices[1], 15);
  const mixTable = db.createTable({ name: `mix-${cur.code}`, seats: 2 });
  const mixOrder = db.getOrCreateOpenSale(mixTable.id, admin.id);
  db.setOpenSaleItems(mixOrder.id, [{ productId: p1.id, quantity: 2 }]);
  setMode('exclusive');
  db.updateProduct({ id: p1.id, name: p1.name, price: bump(cur.prices[0]), cost: 0, taxRate: 5, trackInventory: false });
  const mixItems = [{ productId: p1.id, quantity: 2 }, { productId: p2.id, quantity: 3 }];
  const EM = ref([{ unitMinor: toMinorRef(cur.prices[0]), qty: 2, rate: 10, inclusive: true }, { unitMinor: toMinorRef(cur.prices[1]), qty: 3, rate: 15, inclusive: false }]);
  const mixSaved = db.setOpenSaleItems(mixOrder.id, mixItems);
  close(mixSaved.grandTotal, toMajor(EM.total), `${cur.code} mixed cart total (old line inclusive/old price + new line exclusive/current price)`);
  setMode('inclusive'); mutateProducts([p1, p2], cur.prices);
  close(db.setOpenSaleItems(mixOrder.id, mixItems).grandTotal, toMajor(EM.total), `${cur.code} mixed cart stable after hostile changes`);

  // ---- split bill keeps the snapshot ----
  const items3 = db.getSale(mixOrder.id).items;
  const pick = items3.find((i) => Number(i.product_id) === p1.id);
  const ES = ref([{ unitMinor: toMinorRef(cur.prices[0]), qty: 1, rate: 10, inclusive: true }]);
  const paidTotal = toMajor(ES.total);
  const split = db.splitTableSale(mixOrder.id, [{ saleItemId: pick.id, quantity: 1 }], { paymentMethod: 'cash', cashAmount: paidTotal, cardAmount: 0, changeDue: 0 }, admin.id, shift.id);
  const splitSale = db.getSale(split.id);
  close(Number(splitSale.grand_total), paidTotal, `${cur.code} split part total uses the snapshot`);
  close(Number(splitSale.tax_total), toMajor(ES.tax), `${cur.code} split part tax uses the snapshot`);
  const ER = ref([{ unitMinor: toMinorRef(cur.prices[0]), qty: 1, rate: 10, inclusive: true }, { unitMinor: toMinorRef(cur.prices[1]), qty: 3, rate: 15, inclusive: false }]);
  const remaining = db.setOpenSaleItems(mixOrder.id, db.getSale(mixOrder.id).items.map((i) => ({ productId: i.product_id, quantity: i.quantity })));
  close(remaining.grandTotal, toMajor(ER.total), `${cur.code} remainder after split still on the snapshot`);
  console.log(`PASS: ${cur.code} (${cur.minor} decimals) - ${n} rate/mode combos + mixed cart + split: price/tax/mode snapshot holds after product price, tax rate and tax mode changes`);

  // ---- product deactivated after being added: existing line stays editable, new inactive product rejected ----
  const gone = mkp(`gone-${cur.code}`, cur.prices[0], 0);
  const goneTable = db.createTable({ name: `gone-${cur.code}`, seats: 2 });
  const goneOrder = db.getOrCreateOpenSale(goneTable.id, admin.id);
  db.setOpenSaleItems(goneOrder.id, [{ productId: gone.id, quantity: 1 }]);
  db.deleteProduct(gone.id);
  assert.ok(db.setOpenSaleItems(goneOrder.id, [{ productId: gone.id, quantity: 2 }]).success, 'existing line of a deactivated product can still be saved');
  const goneTable2 = db.createTable({ name: `gone2-${cur.code}`, seats: 2 });
  const goneOrder2 = db.getOrCreateOpenSale(goneTable2.id, admin.id);
  assert.throws(() => db.setOpenSaleItems(goneOrder2.id, [{ productId: gone.id, quantity: 1 }]), /غير موجود أو غير نشط/, 'a deactivated product cannot be ADDED as a new line');
  console.log(`PASS: ${cur.code} deactivated product: existing line kept, new line rejected`);
} finally {
  try { db.closeDatabase(); } catch (_) {}
  try { fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch (_) {}
}
