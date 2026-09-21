// Tax parity regression (v0.52.17 sprint-2 follow-up).
// Verifies that the direct-sale path, the open-order (table) save path and the
// table-close recalculation all produce the SAME subtotal/tax/total as an
// independent integer reference, for 0/5/10/15 % in inclusive AND exclusive mode,
// on awkward amounts, for 0/2/3-decimal currencies. Also checks that the ledger
// stays balanced and that "Tax payable" (2100) receives exactly the invoice tax.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const RATES = [0, 5, 10, 15];
const MODES = ['exclusive', 'inclusive'];
const CURRENCIES = [
  { code: 'USD', minor: 2, prices: [9.99, 3.33, 0.05, 19.95] },
  { code: 'KWD', minor: 3, prices: [9.999, 3.333, 0.005, 19.955] },
  { code: 'JPY', minor: 0, prices: [999, 333, 5, 1995] },
];
const QTY = [3, 7, 13, 2];

// Independent integer reference (does not call core/money).
function refTax(grossMinor, rate, inclusive) {
  if (!rate) return 0;
  const den = inclusive ? 100 + rate : 100;
  return Math.floor((grossMinor * rate * 2 + den) / (2 * den)); // half-up
}
function refTotals(unitMinors, rate, inclusive) {
  let sub = 0, tax = 0;
  unitMinors.forEach((u, i) => {
    const gross = u * QTY[i];
    const t = refTax(gross, rate, inclusive);
    tax += t;
    sub += inclusive ? gross - t : gross;
  });
  return { sub, tax, total: sub + tax };
}

if (process.argv[2] !== '--child') {
  // Parent: one child process (own temp data dir) per currency.
  let failed = 0;
  for (const c of CURRENCIES) {
    const r = spawnSync(process.execPath, [__filename, '--child', c.code], { encoding: 'utf8' });
    process.stdout.write(r.stdout || '');
    if (r.status !== 0) { failed++; process.stderr.write(r.stderr || ''); }
  }
  if (failed) { console.error('TAX PARITY REGRESSION: FAIL'); process.exit(1); }
  console.log(`TAX PARITY REGRESSION: PASS (${CURRENCIES.length} currencies x ${RATES.length} rates x ${MODES.length} modes x 3 paths)`);
  process.exit(0);
}

const Module = require('node:module');
const cur = CURRENCIES.find((c) => c.code === process.argv[3]);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexora-tax-parity-'));
const originalLoad = Module._load;
Module._load = function (request) {
  if (request === 'electron') {
    return { app: { getPath: () => dataDir }, safeStorage: { isEncryptionAvailable: () => true, encryptString: (v) => Buffer.from(String(v)), decryptString: (v) => Buffer.from(v).toString('utf8') } };
  }
  return originalLoad.apply(this, arguments);
};
const db = require('../database/db');
const toMajor = (m) => m / 10 ** cur.minor;
const toMinorRef = (v) => Math.round(v * 10 ** cur.minor);
const taxPayable = () => {
  const a = db.getTrialBalance().accounts.find((x) => x.code === '2100');
  return a ? Number(a.credit || 0) - Number(a.debit || 0) : 0;
};
const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 0.5 / 10 ** cur.minor, `${msg}: expected ${b}, got ${a}`);

try {
  db.init();
  const admin = db.listUsers().find((u) => u.role === 'admin');
  const shift = db.openShift(0, admin.id);
  assert.ok(shift.success, 'shift');
  const base = db.getGlobalProfile();
  const setMode = (taxMode) => db.setGlobalProfile({
    countryCode: base.country_code, locale: base.locale, timezone: base.timezone,
    currencyCode: cur.code, currencyMinorUnit: cur.minor, taxMode,
    taxRegistrationNumber: base.tax_registration_number || '', fiscalizationMode: base.fiscalization_mode || 'none', fiscalProvider: base.fiscal_provider || '',
  });
  const unitMinors = cur.prices.map(toMinorRef);
  let n = 0;
  for (const mode of MODES) {
    setMode(mode);
    const inclusive = mode === 'inclusive';
    for (const rate of RATES) {
      const exp = refTotals(unitMinors, rate, inclusive);
      const label = `${cur.code} ${mode} ${rate}%`;
      const products = cur.prices.map((price, i) => db.createProduct({ name: `tp-${cur.code}-${mode}-${rate}-${i}`, price, cost: 0, taxRate: rate, trackInventory: false }));
      const items = products.map((p, i) => ({ productId: p.id, quantity: QTY[i] }));

      // Path 1: direct sale
      const before1 = taxPayable();
      const plBefore1 = db.getProfitLoss({}).revenue;
      const s1 = db.createSale({ items, paymentMethod: 'cash', cashAmount: toMajor(exp.total), cardAmount: 0, changeDue: 0, discountType: null, discountValue: 0, userId: admin.id, shiftId: shift.id });
      const d = db.getSale(s1.id);
      close(Number(d.subtotal), toMajor(exp.sub), `${label} direct subtotal`);
      close(Number(d.tax_total), toMajor(exp.tax), `${label} direct tax`);
      close(Number(d.grand_total), toMajor(exp.total), `${label} direct total`);
      close(taxPayable() - before1, toMajor(exp.tax), `${label} direct tax payable delta`);
      close(db.getProfitLoss({}).revenue - plBefore1, toMajor(exp.sub), `${label} profit&loss revenue delta (net of tax)`);

      // Path 2: open table order (save) then Path 3: close (recalculate)
      const table = db.createTable({ name: `tp-${label}`, seats: 2 });
      const order = db.getOrCreateOpenSale(table.id, admin.id);
      const saved = db.setOpenSaleItems(order.id, items);
      close(saved.subtotal, toMajor(exp.sub), `${label} open-order subtotal`);
      close(saved.taxTotal, toMajor(exp.tax), `${label} open-order tax`);
      close(saved.grandTotal, toMajor(exp.total), `${label} open-order total`);
      const before2 = taxPayable();
      const plBefore2 = db.getProfitLoss({}).revenue;
      const closed = db.closeTableSale(order.id, { paymentMethod: 'cash', cashAmount: toMajor(exp.total), cardAmount: 0, changeDue: 0 }, admin.id, shift.id);
      const c = db.getSale(closed.id);
      close(Number(c.subtotal), toMajor(exp.sub), `${label} closed subtotal`);
      close(Number(c.tax_total), toMajor(exp.tax), `${label} closed tax`);
      close(Number(c.grand_total), toMajor(exp.total), `${label} closed total`);
      close(taxPayable() - before2, toMajor(exp.tax), `${label} closed tax payable delta`);
      close(db.getProfitLoss({}).revenue - plBefore2, toMajor(exp.sub), `${label} closed profit&loss revenue delta`);
      assert.ok(db.getTrialBalance().balanced, `${label} trial balance balanced`);
      n++;
    }
  }
  console.log(`PASS: ${cur.code} (${cur.minor} decimals) - ${n} rate/mode combos: direct == open-order == table-close == integer reference; ledger + P&L consistent`);
} finally {
  try { db.closeDatabase(); } catch (_) {}
  try { fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch (_) {}
}
