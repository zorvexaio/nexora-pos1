const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexora-table-sale-'));
const originalLoad = Module._load;
Module._load = function loadWithElectronStub(request, parent, isMain) {
  if (request === 'electron') {
    return {
      app: { getPath: () => dataDir },
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (value) => Buffer.from(String(value), 'utf8'),
        decryptString: (value) => Buffer.from(value).toString('utf8'),
      },
    };
  }
  return originalLoad.apply(this, arguments);
};

const db = require('../database/db');

function nearly(actual, expected, message) {
  assert.ok(Math.abs(Number(actual) - expected) < 0.011, `${message}; expected ${expected}, received ${actual}`);
}

function inventoryQuantity(productId) {
  const row = db.listInventory({}).find((item) => Number(item.id) === Number(productId));
  assert.ok(row, `Inventory row for product ${productId} is missing.`);
  return Number(row.stock);
}

function cleanUp() {
  try { db.closeDatabase(); } catch (_) {}
  // Antivirus scanners can retain a very short-lived handle on a temporary SQLite
  // database on Windows. Leaving the OS temp file is safer than turning a passing
  // regression into a false failure during cleanup.
  try { fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch (_) {}
}

try {
  db.init();
  const admin = db.listUsers().find((user) => user.role === 'admin');
  assert.ok(admin, 'Seed admin was not created.');
  const shift = db.openShift(0, admin.id);
  assert.ok(shift.success, 'Could not open a test cash shift.');

  const product = db.createProduct({
    name: 'Table-sale regression product', price: 10, cost: 4, initialStock: 20, trackInventory: true,
  });

  // Saving a table order commits only the delta. Reducing the order restores stock,
  // and closing it must not deduct the already committed unit for a second time.
  const firstTable = db.createTable({ name: 'Regression table 1', seats: 2 });
  const firstOrder = db.getOrCreateOpenSale(firstTable.id, admin.id);
  db.setOpenSaleItems(firstOrder.id, [{ productId: product.id, quantity: 3 }]);
  nearly(inventoryQuantity(product.id), 17, 'Saving a table order must reserve inventory');
  db.setOpenSaleItems(firstOrder.id, [{ productId: product.id, quantity: 1 }]);
  nearly(inventoryQuantity(product.id), 19, 'Reducing a table order must restore only the removed quantity');
  const firstClose = db.closeTableSale(firstOrder.id, {
    paymentMethod: 'cash', cashAmount: 20, cardAmount: 0, changeDue: 10,
  }, admin.id, shift.id);
  const firstInvoice = db.getSale(firstClose.id);
  assert.equal(firstInvoice.status, 'completed', 'Closing a table order must complete the invoice.');
  nearly(firstInvoice.cash_amount, 20, 'Table close must preserve the full cash received');
  nearly(firstInvoice.change_due, 10, 'Table close must preserve change separately');
  nearly(inventoryQuantity(product.id), 19, 'Closing a committed table order must not deduct inventory twice');
  console.log('PASS: table save applies deltas and table close preserves committed inventory');

  // A partial bill follows the same cash/change rules, leaves the remainder open,
  // and must not take a second inventory deduction after the order was committed.
  const secondTable = db.createTable({ name: 'Regression table 2', seats: 2 });
  const secondOrder = db.getOrCreateOpenSale(secondTable.id, admin.id);
  db.setOpenSaleItems(secondOrder.id, [{ productId: product.id, quantity: 3 }]);
  nearly(inventoryQuantity(product.id), 16, 'Second table order must reserve three units');
  const itemToSplit = db.getOpenSaleForTable(secondTable.id).items[0];
  const split = db.splitTableSale(secondOrder.id, [{ saleItemId: itemToSplit.id, quantity: 2 }], {
    paymentMethod: 'cash', cashAmount: 30, cardAmount: 0, changeDue: 10,
  }, admin.id, shift.id);
  const splitInvoice = db.getSale(split.id);
  nearly(splitInvoice.grand_total, 20, 'Split invoice total must be recalculated from selected items');
  nearly(splitInvoice.cash_amount, 30, 'Split invoice must retain gross cash received');
  nearly(splitInvoice.change_due, 10, 'Split invoice must retain change due');
  const remainder = db.getOpenSaleForTable(secondTable.id);
  assert.ok(remainder && remainder.items.length === 1, 'Split must leave the unpaid items on the open table order.');
  nearly(remainder.items[0].quantity, 1, 'Split must leave the correct remaining quantity');
  nearly(inventoryQuantity(product.id), 16, 'Split of a committed order must not deduct stock twice');
  db.closeTableSale(remainder.id, { paymentMethod: 'cash', cashAmount: 10, cardAmount: 0, changeDue: 0 }, admin.id, shift.id);
  nearly(inventoryQuantity(product.id), 16, 'Closing the remainder must not deduct committed stock twice');
  console.log('PASS: split table payment preserves cash/change and keeps the remainder open');

  const summary = db.getShiftSummary(shift.id, null, admin.id, admin.role);
  nearly(summary.expectedCash, 40, 'Cash shift must count table sales net of change');
  console.log('PASS: cash shift totals use net table-sale cash after change');

  const movements = db.listInventoryMovements({ productId: product.id });
  nearly(movements.reduce((sum, movement) => sum + Number(movement.change_qty), 0), -4, 'Inventory movement ledger must match the four committed table units');
  console.log('TABLE/SALE REGRESSION: PASS (4 checks)');
} finally {
  cleanUp();
}
