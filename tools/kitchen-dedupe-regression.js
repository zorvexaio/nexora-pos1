// Kitchen ticket de-duplication for table orders (needs native SQLite).
// Reported problem: every Save re-sent the whole order to the kitchen. Now only real changes print:
//   Save, Save, Save (no change) -> exactly 1 ticket; add / more / less / remove / note change -> a delta ticket;
//   a failed print is retried with the SAME delta on the next save; split and merge do not create phantom tickets.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexora-kitchen-'));
const originalLoad = Module._load;
Module._load = function (request) {
  if (request === 'electron') return { app: { getPath: () => dataDir }, safeStorage: { isEncryptionAvailable: () => true, encryptString: (v) => Buffer.from(String(v)), decryptString: (v) => Buffer.from(v).toString('utf8') } };
  return originalLoad.apply(this, arguments);
};
const db = require('../database/db');
const { planKitchenTicket } = require('../core/kitchen-plan');

let checks = 0;
const ok = (c, m) => { assert.ok(c, m); checks++; console.log('PASS:', m); };

// unit: the planner
assert.deepEqual(planKitchenTicket({ kitchenDelta: [], kitchenFirst: true }), { action: 'none' });
assert.deepEqual(planKitchenTicket(null), { action: 'none' });
assert.equal(planKitchenTicket({ kitchenDelta: [{}], kitchenFirst: true }).action, 'full');
assert.equal(planKitchenTicket({ kitchenDelta: [{}], kitchenFirst: false }).action, 'delta');
console.log('PASS: planner decisions (none / full / delta)'); checks++;

try {
  db.init();
  const admin = db.listUsers().find((u) => u.role === 'admin');
  const shift = db.openShift(0, admin.id);
  const mk = (name, price) => ({ ...db.createProduct({ name, price, cost: 0, taxRate: 0, trackInventory: false }), name });
  const A = mk('برجر', 10), B = mk('بطاطا', 4), C = mk('عصير', 3);

  // helper that behaves like main.js sendKitchenForTableSave, with a switchable printer
  const tickets = [];
  let printerOk = true;
  const save = (saleId, items) => {
    const result = db.setOpenSaleItems(saleId, items);
    const plan = planKitchenTicket(result);
    if (plan.action !== 'none') {
      tickets.push({ action: plan.action, items: plan.items || null });
      if (printerOk) db.markKitchenSent(saleId);
    }
    return { result, plan };
  };
  const current = (saleId) => db.getSale(saleId).items.map((i) => ({ productId: i.product_id, quantity: i.quantity, notes: i.notes || null }));
  const table = db.createTable({ name: 'K1', seats: 2 });
  const order = db.getOrCreateOpenSale(table.id, admin.id);

  // 1) Save x3 without change -> 1 ticket
  const base = [{ productId: A.id, quantity: 2 }, { productId: B.id, quantity: 1 }];
  save(order.id, base); save(order.id, base); save(order.id, base);
  ok(tickets.length === 1 && tickets[0].action === 'full', 'Save, Save, Save without changes -> exactly 1 kitchen ticket (the full one)');

  // 2) add a new item -> delta with only the new item
  save(order.id, [...base, { productId: C.id, quantity: 1 }]);
  ok(tickets.length === 2 && tickets[1].action === 'delta' && tickets[1].items.length === 1 && tickets[1].items[0].productName === 'عصير' && tickets[1].items[0].deltaQuantity === 1, 'adding an item prints a delta ticket with ONLY the new item');

  // 3) more of an existing item -> +N only
  save(order.id, [{ productId: A.id, quantity: 4 }, { productId: B.id, quantity: 1 }, { productId: C.id, quantity: 1 }]);
  ok(tickets.length === 3 && tickets[2].items.length === 1 && tickets[2].items[0].productName === 'برجر' && tickets[2].items[0].deltaQuantity === 2, 'increasing a quantity by 2 prints "+2" for that item only');

  // 4) less of an item -> cancellation
  save(order.id, [{ productId: A.id, quantity: 3 }, { productId: B.id, quantity: 1 }, { productId: C.id, quantity: 1 }]);
  ok(tickets.length === 4 && tickets[3].items[0].deltaQuantity === -1, 'decreasing a quantity prints a cancellation (-1)');

  // 5) remove a line -> cancellation of everything that was sent for it
  save(order.id, [{ productId: A.id, quantity: 3 }, { productId: B.id, quantity: 1 }]);
  ok(tickets.length === 5 && tickets[4].items.length === 1 && tickets[4].items[0].productName === 'عصير' && tickets[4].items[0].deltaQuantity === -1, 'removing a line prints its cancellation');

  // 6) note change only
  save(order.id, [{ productId: A.id, quantity: 3, notes: 'بدون بصل' }, { productId: B.id, quantity: 1 }]);
  ok(tickets.length === 6 && tickets[5].items.length === 1 && tickets[5].items[0].noteOnly === true && tickets[5].items[0].notes === 'بدون بصل', 'changing only a note prints a note-update line');
  save(order.id, [{ productId: A.id, quantity: 3, notes: 'بدون بصل' }, { productId: B.id, quantity: 1 }]);
  ok(tickets.length === 6, 'saving again with the same note prints nothing');

  // 7) printer failure: same delta is retried, then cleared after success
  printerOk = false;
  save(order.id, [{ productId: A.id, quantity: 3, notes: 'بدون بصل' }, { productId: B.id, quantity: 2 }]);
  ok(tickets.length === 7 && tickets[6].items[0].deltaQuantity === 1, 'printer failure: the ticket is attempted');
  printerOk = true;
  save(order.id, [{ productId: A.id, quantity: 3, notes: 'بدون بصل' }, { productId: B.id, quantity: 2 }]);
  ok(tickets.length === 8 && tickets[7].items.length === 1 && tickets[7].items[0].productName === 'بطاطا' && tickets[7].items[0].deltaQuantity === 1, 'after a failed print the SAME delta is re-sent on the next save');
  save(order.id, [{ productId: A.id, quantity: 3, notes: 'بدون بصل' }, { productId: B.id, quantity: 2 }]);
  ok(tickets.length === 8, 'once printed, further saves print nothing');

  // 8) hostile product price change does not create tickets
  db.updateProduct({ id: A.id, name: A.name, price: 99, cost: 0, taxRate: 0, trackInventory: false });
  save(order.id, current(order.id));
  ok(tickets.length === 8, 'changing a product price does not re-print the order');

  // 9) split: the paid part leaves; the remainder must not trigger a phantom cancellation
  const before = tickets.length;
  const line = db.getSale(order.id).items.find((i) => Number(i.product_id) === A.id);
  db.splitTableSale(order.id, [{ saleItemId: line.id, quantity: 1 }], { paymentMethod: 'cash', cashAmount: 10, cardAmount: 0, changeDue: 0 }, admin.id, shift.id);
  save(order.id, current(order.id));
  ok(tickets.length === before, 'after a split the remaining order saves without a phantom "cancel" ticket');

  // 10) merge: items already sent from the source table are not re-sent from the target
  const t2 = db.createTable({ name: 'K2', seats: 2 });
  const o2 = db.getOrCreateOpenSale(t2.id, admin.id);
  save(o2.id, [{ productId: C.id, quantity: 2 }]);
  const t3 = db.createTable({ name: 'K3', seats: 2 });
  const o3 = db.getOrCreateOpenSale(t3.id, admin.id);
  save(o3.id, [{ productId: B.id, quantity: 1 }]);
  const beforeMerge = tickets.length;
  db.mergeTables(t2.id, t3.id, admin.id);
  save(o3.id, current(o3.id));
  ok(tickets.length === beforeMerge, 'after merging tables the already-sent items are not printed again');

  console.log(`KITCHEN DEDUPE REGRESSION: PASS (${checks} checks)`);
} finally {
  try { db.closeDatabase(); } catch (_) {}
  try { fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch (_) {}
}
