// Returns are computed in integer minor units only (0 / 2 / 3 decimal currencies).
// Randomized: 1,300+ sales (inclusive + exclusive, tax 0/5/10/15 % mixed per invoice, manual discount),
// each returned in several random partial returns until nothing is left. Invariants after every return:
//   * refund amount is an exact multiple of the minor unit (no float drift, no NaN/Infinity)
//   * returns.total_refunded == sum(return_items.refund_amount)  (in minor units)
//   * cumulative refunds never exceed what the customer paid
//   * after the last piece, cumulative refunds == the invoice grand total EXACTLY
//   * ledger stays balanced. Needs native SQLite.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CURRENCIES = [
  { code: 'USD', minor: 2, sales: 450 },
  { code: 'KWD', minor: 3, sales: 450 },
  { code: 'JPY', minor: 0, sales: 400 },
];

if (process.argv[2] !== '--child') {
  let failed = 0;
  for (const c of CURRENCIES) {
    const r = spawnSync(process.execPath, [__filename, '--child', c.code], { encoding: 'utf8', maxBuffer: 1 << 26 });
    process.stdout.write(r.stdout || '');
    if (r.status !== 0) { failed++; process.stderr.write(r.stderr || ''); }
  }
  if (failed) { console.error('RETURNS MINOR REGRESSION: FAIL'); process.exit(1); }
  console.log('RETURNS MINOR REGRESSION: PASS');
  process.exit(0);
}

const Module = require('node:module');
const cur = CURRENCIES.find((c) => c.code === process.argv[3]);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexora-returns-'));
const originalLoad = Module._load;
Module._load = function (request) {
  if (request === 'electron') return { app: { getPath: () => dataDir }, safeStorage: { isEncryptionAvailable: () => true, encryptString: (v) => Buffer.from(String(v)), decryptString: (v) => Buffer.from(v).toString('utf8') } };
  return originalLoad.apply(this, arguments);
};
const db = require('../database/db');
const money = require('../core/money');
const scale = 10 ** cur.minor;
const toMinor = (v) => Math.round(Number(v) * scale);
const isMinorInt = (v) => Number.isFinite(v) && Math.abs(Number(v) * scale - Math.round(Number(v) * scale)) < 1e-6;

let seed = 52017 + cur.minor;
const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

try {
  db.init();
  const admin = db.listUsers().find((u) => u.role === 'admin');
  const shift = db.openShift(0, admin.id);
  const base = db.getGlobalProfile();
  const setMode = (taxMode) => db.setGlobalProfile({ countryCode: base.country_code, locale: base.locale, timezone: base.timezone, currencyCode: cur.code, currencyMinorUnit: cur.minor, taxMode, taxRegistrationNumber: '', fiscalizationMode: 'none', fiscalProvider: '' });

  // product pool: tax rate x random price (with at most `minor` decimals)
  const products = [];
  for (const rate of [0, 5, 10, 15]) {
    for (let k = 0; k < 4; k++) {
      const priceMinor = Math.max(1, Math.floor(rnd() * 5000 * Math.max(1, scale / 100)) + 3);
      products.push({ id: db.createProduct({ name: `ret-${cur.code}-${rate}-${k}`, price: priceMinor / scale, cost: 0, taxRate: rate, trackInventory: false }).id });
    }
  }

  let salesN = 0, returnsN = 0;
  for (let s = 0; s < cur.sales; s++) {
    setMode(rnd() < 0.5 ? 'inclusive' : 'exclusive');
    const lines = [];
    const used = new Set();
    const count = 1 + Math.floor(rnd() * 3);
    while (lines.length < count) {
      const p = pick(products);
      if (used.has(p.id)) continue;
      used.add(p.id);
      lines.push({ productId: p.id, quantity: 1 + Math.floor(rnd() * 7) });
    }
    // exact cash for the discounted total: create the sale with a generous cash amount and exact change
    const discountType = rnd() < 0.5 ? 'percent' : null;
    const discountValue = discountType ? pick([5, 10, 15, 25]) : 0;
    // ask the backend for the total by pricing through a dry run (open table order) — simpler: overpay and return change
    const cash = 10 ** 9 / scale;
    let sale;
    // first create with a big tender; the backend computes the total, change must equal cash - total, so create in 2 steps
    const probeTotal = (() => {
      const t = db.createTable({ name: `probe-${s}`, seats: 1 });
      const o = db.getOrCreateOpenSale(t.id, admin.id);
      const r = db.setOpenSaleItems(o.id, lines);
      // discount is applied by the direct-sale path only; compute it the same way here
      const sub = toMinor(r.subtotal) + toMinor(r.taxTotal);
      db.closeTableSale(o.id, { paymentMethod: 'cash', cashAmount: r.grandTotal, cardAmount: 0, changeDue: 0 }, admin.id, shift.id);
      return { gross: sub, subMajor: r.subtotal };
    })();
    // same rounding path as the backend: percent of the NET subtotal (major float) -> minor units
    const discountMinor = discountType ? money.toMinor(probeTotal.subMajor * (discountValue / 100), cur.minor) : 0;
    const totalMinor = probeTotal.gross - discountMinor;
    sale = db.createSale({ items: lines, paymentMethod: 'cash', cashAmount: totalMinor / scale, cardAmount: 0, changeDue: 0, discountType, discountValue, discountApprovedBy: admin.id, userId: admin.id, shiftId: shift.id });
    const detail = db.getSale(sale.id);
    const grandMinor = toMinor(detail.grand_total);
    assert.ok(isMinorInt(detail.grand_total), 'grand total is a whole number of minor units');
    salesN++;

    // random partial returns until everything is back
    const state = detail.items.map((i) => ({ id: i.id, left: Number(i.quantity) }));
    let cumulative = 0;
    while (state.some((x) => x.left > 0)) {
      const open = state.filter((x) => x.left > 0);
      const chosen = [];
      for (const x of open) { if (rnd() < 0.7 || chosen.length === 0) chosen.push({ saleItemId: x.id, quantity: 1 + Math.floor(rnd() * x.left) }); }
      const ret = db.createReturn({ saleId: sale.id, items: chosen, refundMethod: 'cash', userId: admin.id, shiftId: shift.id });
      returnsN++;
      for (const c of chosen) state.find((x) => x.id === c.saleItemId).left -= Math.min(c.quantity, state.find((x) => x.id === c.saleItemId).left + c.quantity);
      const r = db.getReturn(ret.id);
      assert.ok(isMinorInt(r.total_refunded), `total_refunded is whole minor units (${r.total_refunded})`);
      const sumItems = r.items.reduce((n, i) => { assert.ok(isMinorInt(i.refund_amount), `item refund whole minor units (${i.refund_amount})`); return n + toMinor(i.refund_amount); }, 0);
      assert.equal(sumItems, toMinor(r.total_refunded), `sum of item refunds == total_refunded (sale ${sale.id})`);
      cumulative += toMinor(r.total_refunded);
      assert.ok(cumulative <= grandMinor, `cumulative refunds ${cumulative} exceed what was paid ${grandMinor}`);
      assert.ok(Number.isFinite(cumulative), 'no NaN/Infinity');
    }
    assert.equal(cumulative, grandMinor, `sale ${sale.id}: after the last piece the refunds equal the invoice total exactly (${cumulative} vs ${grandMinor})`);
    assert.equal(db.getSale(sale.id).status, 'refunded', 'fully returned invoice is marked refunded');
    if (s % 25 === 0) assert.ok(db.getTrialBalance().balanced, `ledger balanced after sale ${s}`);
  }
  assert.ok(db.getTrialBalance().balanced, 'ledger balanced at the end');
  console.log(`PASS: ${cur.code} (${cur.minor} decimals) - ${salesN} sales, ${returnsN} partial returns: whole minor units, exact totals, never over-refunded, ledger balanced`);
} finally {
  try { db.closeDatabase(); } catch (_) {}
  try { fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch (_) {}
}
