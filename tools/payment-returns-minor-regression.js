// Payment validation and Profit&Loss returns must work in minor units (needs native SQLite).
//  1) Table close in a 3-decimal currency: a cash amount short by 0.005 was accepted by the legacy
//     0.01 tolerance; it must now be rejected, while the exact amount passes.
//  2) 0-decimal currency: cash short by 1 unit is rejected.
//  3) P&L returns on a discounted tax-inclusive invoice equal the independent expectation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

if (process.argv[2] !== '--child') {
  let failed = 0;
  for (const mode of ['KWD', 'JPY', 'USD']) {
    const r = spawnSync(process.execPath, [__filename, '--child', mode], { encoding: 'utf8' });
    process.stdout.write(r.stdout || '');
    if (r.status !== 0) { failed++; process.stderr.write(r.stderr || ''); }
  }
  if (failed) { console.error('PAYMENT/RETURNS MINOR REGRESSION: FAIL'); process.exit(1); }
  console.log('PAYMENT/RETURNS MINOR REGRESSION: PASS');
  process.exit(0);
}

const Module = require('node:module');
const mode = process.argv[3];
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexora-pay-minor-'));
const originalLoad = Module._load;
Module._load = function (request) {
  if (request === 'electron') return { app: { getPath: () => dataDir }, safeStorage: { isEncryptionAvailable: () => true, encryptString: (v) => Buffer.from(String(v)), decryptString: (v) => Buffer.from(v).toString('utf8') } };
  return originalLoad.apply(this, arguments);
};
const db = require('../database/db');
const throwsMsg = (fn, re, msg) => assert.throws(fn, (e) => re.test(e.message), msg);

try {
  db.init();
  const admin = db.listUsers().find((u) => u.role === 'admin');
  const shift = db.openShift(0, admin.id);
  const base = db.getGlobalProfile();
  const cfg = { KWD: { minor: 3, price: 10.001 }, JPY: { minor: 0, price: 1000 }, USD: { minor: 2, price: 9.99 } }[mode];
  const setProfile = (taxMode) => db.setGlobalProfile({ countryCode: base.country_code, locale: base.locale, timezone: base.timezone, currencyCode: mode, currencyMinorUnit: cfg.minor, taxMode, taxRegistrationNumber: '', fiscalizationMode: 'none', fiscalProvider: '' });

  if (mode !== 'USD') {
    setProfile('exclusive');
    const product = db.createProduct({ name: `pay-${mode}`, price: cfg.price, cost: 0, taxRate: 0, trackInventory: false });
    const table = db.createTable({ name: `t-${mode}`, seats: 2 });
    const order = db.getOrCreateOpenSale(table.id, admin.id);
    db.setOpenSaleItems(order.id, [{ productId: product.id, quantity: 1 }]);
    const shortBy = mode === 'KWD' ? 0.005 : 1;   // legacy tolerance was 0.01
    throwsMsg(() => db.closeTableSale(order.id, { paymentMethod: 'cash', cashAmount: cfg.price - shortBy, cardAmount: 0, changeDue: 0 }, admin.id, shift.id), /غير كافٍ/, `${mode}: short cash rejected`);
    const closed = db.closeTableSale(order.id, { paymentMethod: 'cash', cashAmount: cfg.price, cardAmount: 0, changeDue: 0 }, admin.id, shift.id);
    assert.equal(db.getSale(closed.id).status, 'completed');
    console.log(`PASS: ${mode} table close rejects cash short by ${shortBy} and accepts the exact amount`);
  } else {
    // P&L returns on a tax-inclusive invoice (USD, 15% inclusive, awkward amount)
    setProfile('inclusive');
    const product = db.createProduct({ name: 'pl-return', price: 9.99, cost: 0, taxRate: 15, trackInventory: false });
    const sale = db.createSale({ items: [{ productId: product.id, quantity: 3 }], paymentMethod: 'cash', cashAmount: 29.97, cardAmount: 0, changeDue: 0, discountType: null, discountValue: 0, userId: admin.id, shiftId: shift.id });
    const detail = db.getSale(sale.id);
    const item = detail.items[0];
    const plBefore = db.getProfitLoss({});
    const ret = db.createReturn({ saleId: sale.id, items: [{ saleItemId: item.id, quantity: 1 }], refundMethod: 'cash', userId: admin.id, shiftId: shift.id });
    assert.ok(ret && ret.success !== false, 'return created');
    const pl = db.getProfitLoss({});
    // 3 x 9.99 = 29.97 inclusive @15% -> tax round(2997*15/115)=391 minor -> net 26.06 (per-line minor-unit rounding).
    // Returning 1 of 3 gives back 26.06/3 of net revenue. Unrounded float division would give 26.0608.../3.
    const expectedNet = 26.06;
    assert.ok(Math.abs((pl.returnsRevenue - plBefore.returnsRevenue) - expectedNet / 3) < 1e-9, `returnsRevenue delta expected ${expectedNet / 3}, got ${pl.returnsRevenue - plBefore.returnsRevenue}`);
    assert.ok(Math.abs(pl.revenue - expectedNet) < 1e-9, `revenue expected ${expectedNet}, got ${pl.revenue}`);
    console.log('PASS: USD P&L returns on a tax-inclusive invoice use per-line minor-unit net (26.06 net, 1 of 3 returned)');
  }
} finally {
  try { db.closeDatabase(); } catch (_) {}
  try { fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch (_) {}
}
