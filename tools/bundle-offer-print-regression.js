// Offers (Bundles / "العروض") must be visible on BOTH printers:
//  - kitchen ticket: framed block with the word "عرض" + the offer's items,
//  - customer receipt: framed block + an explicit "offer discount" row so the printed arithmetic adds up.
// The applied offers are stored per invoice as a snapshot (sale_bundles), so later edits/deletes of the
// offer do not change old invoices, and they travel with the sale in sync. Needs native SQLite.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');

const root = path.join(__dirname, '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexora-offer-'));
const originalLoad = Module._load;
Module._load = function (request) {
  if (request === 'electron') return { app: { getPath: () => dataDir }, safeStorage: { isEncryptionAvailable: () => true, encryptString: (v) => Buffer.from(String(v)), decryptString: (v) => Buffer.from(v).toString('utf8') } };
  return originalLoad.apply(this, arguments);
};
const db = require('../database/db');
let checks = 0;
const ok = (c, m) => { assert.ok(c, m); checks++; console.log('PASS:', m); };

// ---- renderers under a stub DOM ----
function stubDoc(el) {
  return {
    body: { dataset: {} }, documentElement: { getAttribute: () => 'ar' },
    getElementById: (id) => (id === 'receipt' || id === 'ticket' ? el : null),
    createElement: () => { let t = ''; return { set textContent(v) { t = String(v); }, get innerHTML() { return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); } }; },
    addEventListener() {},
  };
}
const TR = { 'kitchen.offer': 'عرض', 'receipt.offer': 'عرض', 'receipt.bundleDiscount': 'خصم العروض', 'kitchen.title': 'طلب مطبخ', 'kitchen.orderNumber': 'طلب', 'common.subtotal': 'المجموع', 'common.tax': 'الضريبة' };
function renderKitchen(sale) {
  const el = { innerHTML: '', textContent: '', dataset: {} };
  const doc = stubDoc(el);
  const ctx = { document: doc, URLSearchParams, console, Intl, Date, JSON, Math, Number, String, Array, Map, Set, Object, atob,
    window: { location: { search: '?saleId=1&paperWidth=80' }, api: { sales: { get: async () => sale }, language: { get: async () => 'ar' } } },
    t: (k) => TR[k] || k, applyTranslations() {} };
  vm.createContext(ctx);
  const src = fs.readFileSync(path.join(root, 'renderer', 'kitchen-ticket.js'), 'utf8').replace(/\ninit\(\);\s*$/, '\nglobalThis.__done = init();');
  vm.runInContext(src, ctx);
  return ctx.__done.then(() => el.innerHTML);
}
function renderReceipt(sale) {
  const el = { innerHTML: '', textContent: '' };
  const ctx = { document: stubDoc(el), URLSearchParams, console, Intl, Date, JSON, Math, Number, String, Array, Map, Set, Object,
    window: { location: { search: '' }, api: {} }, t: (k) => TR[k] || k, applyTranslations() {} };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(root, 'renderer', 'receipt.js'), 'utf8'), ctx);
  ctx.__sale = sale;
  vm.runInContext('renderReceipt(__sale, {}, { minorUnit: 2, base: "USD" })', ctx);
  return el.innerHTML;
}

(async () => {
  try {
    db.init();
    const admin = db.listUsers().find((u) => u.role === 'admin');
    const shift = db.openShift(0, admin.id);
    const mk = (name, price) => db.createProduct({ name, price, cost: 0, taxRate: 0, trackInventory: false });
    const A = mk('برجر', 10), B = mk('بطاطا', 5), C = mk('عصير', 3);
    const bundle = db.createBundle({ name: 'وجبة العرض', discountType: 'percent', discountValue: 20, items: [{ productId: A.id, quantity: 1 }, { productId: B.id, quantity: 2 }] });

    // Offer applied twice (A x2, B x4) + one loose item C; A carries a kitchen note
    const sale = db.createSale({
      items: [{ productId: A.id, quantity: 2, notes: 'بدون بصل' }, { productId: B.id, quantity: 4 }, { productId: C.id, quantity: 1 }],
      bundleIds: [bundle.id], paymentMethod: 'cash', cashAmount: 100, cardAmount: 0, changeDue: 65, discountType: null, discountValue: 0, userId: admin.id, shiftId: shift.id,
    });
    const s = db.getSale(sale.id);
    // (10 + 2x5) = 20 per application, 20% -> 4 x 2 = 8 ; subtotal 2x10 + 4x5 + 3 = 43 ; total 35
    ok(Math.abs(Number(s.bundle_discount_total) - 8) < 1e-9, 'sale stores the offer discount (8.00)');
    ok(Array.isArray(s.bundles) && s.bundles.length === 1 && s.bundles[0].name === 'وجبة العرض' && s.bundles[0].applications === 2, 'sale carries the applied-offer snapshot (name + x2)');
    ok(s.bundles[0].items.find((i) => i.product_name === 'برجر')?.quantity === 2 && s.bundles[0].items.find((i) => i.product_name === 'بطاطا')?.quantity === 4, 'snapshot lists the offer components with total quantities');

    // Snapshot survives editing / deleting the offer
    db.updateBundle({ id: bundle.id, name: 'اسم جديد', discountType: 'percent', discountValue: 50, items: [{ productId: C.id, quantity: 1 }] });
    ok(db.getSale(sale.id).bundles[0].name === 'وجبة العرض' && db.getSale(sale.id).bundles[0].items.length === 2, 'old invoice keeps the original offer after the offer is edited');

    // ---- kitchen ticket ----
    const k = await renderKitchen(db.getSale(sale.id));
    ok(k.includes('kitchen-offer') && k.includes('*** عرض ***') && k.includes('وجبة العرض') && k.includes('×2'), 'kitchen ticket shows a framed "عرض" block with the offer name and x2');
    ok(k.includes('2×') && k.includes('4×') && k.includes('برجر') && k.includes('بطاطا'), 'kitchen ticket lists the offer items inside the block');
    ok((k.match(/kitchen-item-name">برجر/g) || []).length === 1 && (k.match(/kitchen-item-name">بطاطا/g) || []).length === 1 && (k.match(/kitchen-item-name">عصير/g) || []).length === 1, 'each item prints once: offer components only inside the block, the loose item as a normal line');

    // partial consumption: 3 burgers ordered, the offer covers 1 -> 2 remain as normal lines
    const partial = { id: 9, created_at: '2026-09-21 10:00:00', order_type: 'takeaway',
      items: [{ id: 1, product_id: A.id, product_name: 'برجر', quantity: 3, notes: '' }, { id: 2, product_id: B.id, product_name: 'بطاطا', quantity: 2, notes: '' }],
      bundles: [{ name: 'وجبة', applications: 1, items: [{ product_id: A.id, product_name: 'برجر', quantity: 1 }, { product_id: B.id, product_name: 'بطاطا', quantity: 2 }] }] };
    const kpart = await renderKitchen(partial);
    const afterBlock = kpart.slice(kpart.indexOf('</div></div>'));
    ok(/2×<\/span><span class="kitchen-item-name">برجر/.test(afterBlock) && !/kitchen-item-name">بطاطا/.test(afterBlock), 'partial: 3 burgers with a 1-burger offer -> block shows 1, normal line shows the remaining 2');
    ok(k.includes('بدون بصل'), 'item note still reaches the kitchen (inside the offer block)');

    // ---- receipt ----
    const r = renderReceipt(db.getSale(sale.id));
    ok(r.includes('receipt-offer') && r.includes('*** عرض ***') && r.includes('وجبة العرض'), 'receipt shows a framed "عرض" block');
    ok(/خصم العروض<\/span><span>-8\.00/.test(r), 'receipt shows the offer discount row -8.00 so the arithmetic adds up (43.00 - 8.00 = 35.00)');

    // sale without offers: nothing extra
    const plain = db.createSale({ items: [{ productId: C.id, quantity: 1 }], paymentMethod: 'cash', cashAmount: 3, cardAmount: 0, changeDue: 0, discountType: null, discountValue: 0, userId: admin.id, shiftId: shift.id });
    const kp = await renderKitchen(db.getSale(plain.id));
    const rp = renderReceipt(db.getSale(plain.id));
    ok(!kp.includes('kitchen-offer') && !rp.includes('receipt-offer') && !rp.includes('خصم العروض'), 'sale without an offer prints exactly as before (no offer block)');

    // ---- sync: the snapshot travels with the sale ----
    const payload = db.syncPayload();
    const sent = (payload.changes.sales || []).find((x) => x.uuid === s.uuid);
    ok(sent && Array.isArray(sent.bundles_applied) && sent.bundles_applied.length === 1 && sent.bundles_applied[0].bundle_name === 'وجبة العرض', 'sync payload includes the applied-offer snapshot');

    // ---- invoice modification refreshes the snapshot (same invoice, new offer count) ----
    const bundle2 = db.createBundle({ name: 'عرض ثاني', discountType: 'percent', discountValue: 20, items: [{ productId: A.id, quantity: 1 }, { productId: B.id, quantity: 2 }] });
    const s2 = db.createSale({ items: [{ productId: A.id, quantity: 1 }, { productId: B.id, quantity: 2 }], bundleIds: [bundle2.id], paymentMethod: 'cash', cashAmount: 16, cardAmount: 0, changeDue: 0, discountType: null, discountValue: 0, userId: admin.id, shiftId: shift.id });
    assert.equal(db.getSale(s2.id).bundles[0].applications, 1);
    db.modifyCompletedSaleItems({ saleId: s2.id, actorUserId: admin.id, reason: 'زيادة كمية', items: [{ productId: A.id, quantity: 2 }, { productId: B.id, quantity: 4 }], bundleIds: [bundle2.id] });
    const m = db.getSale(s2.id);
    ok(m.bundles.length === 1 && m.bundles[0].applications === 2 && Math.abs(Number(m.bundle_discount_total) - 8) < 1e-9, 'after modifying items the snapshot follows the invoice (offer x2, discount 8.00)');

    // receiving side: apply a copy of the payload sale (new identifiers) and read the snapshot back
    const clone = JSON.parse(JSON.stringify(sent));
    const suffix = '-copy';
    clone.uuid += suffix; clone.invoice_number = `${clone.invoice_number}${suffix}`; clone.client_request_id = null;
    clone.items = clone.items.map((i, n) => ({ ...i, uuid: `${i.uuid}${suffix}` }));
    clone.bundles_applied = clone.bundles_applied.map((b) => ({ ...b, uuid: `${b.uuid}${suffix}` }));
    db.applyRemoteChanges({ sales: [clone] });
    const rs = db.getSale(Number(s2.id) + 1); // the copy is the next inserted sale
    assert.ok(rs && rs.uuid === clone.uuid, 'received copy found');
    ok(rs.bundles.length === 1 && rs.bundles[0].name === 'وجبة العرض' && rs.bundles[0].applications === 2 && rs.bundles[0].items.length === 2, 'receiving side stores the offer snapshot from sync');
    // idempotent
    db.applyRemoteChanges({ sales: [clone] });
    ok(db.getSale(rs.id).bundles.length === 1, 'applying the same sale again does not duplicate the snapshot');

    console.log(`BUNDLE OFFER PRINT REGRESSION: PASS (${checks} checks)`);
  } finally {
    try { db.closeDatabase(); } catch (_) {}
    try { fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch (_) {}
  }
})().catch((e) => { console.error(e); process.exit(1); });
