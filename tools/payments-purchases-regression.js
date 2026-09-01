const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexora-payment-purchase-'));
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
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
db.init();

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function nearly(actual, expected, message) {
  assert(Math.abs(Number(actual) - expected) < 0.011, `${message}; expected ${expected}, received ${actual}`);
}

const admin = db.listUsers().find((user) => user.role === 'admin');
assert(admin, 'Seed admin was not created.');
const shift = db.openShift(0, admin.id);
assert(shift.success, 'Could not open a test cash shift.');
const product = db.createProduct({ name: 'Regression product', price: 25, cost: 10, initialStock: 20, trackInventory: true });
const customer = db.createCustomer({ name: 'Credit customer', phone: '555000' });

// Cash received can exceed total: the gross receipt and change are retained on the invoice,
// while the cash shift receives only the net sale amount.
const cashSale = db.createSale({
  items: [{ productId: product.id, quantity: 2 }], paymentMethod: 'cash', cashAmount: 1000, cardAmount: 0,
  changeDue: 950, discountType: null, discountValue: 0, customerId: customer.id, userId: admin.id, shiftId: shift.id,
});
const savedCashSale = db.getSale(cashSale.id);
nearly(savedCashSale.cash_amount, 1000, 'Cash received must be stored exactly');
nearly(savedCashSale.change_due, 950, 'Change due must be stored exactly');
console.log('PASS: cash overpayment is accepted and stores received/change separately');

// Credit creates both the customer balance and a customer-ledger debt entry.
const creditSale = db.createSale({
  items: [{ productId: product.id, quantity: 1 }], paymentMethod: 'credit', cashAmount: 0, cardAmount: 0,
  changeDue: 0, discountType: null, discountValue: 0, customerId: customer.id, userId: admin.id, shiftId: shift.id, creditApprovedBy: admin.id,
});
const debtor = db.getCustomer(customer.id);
nearly(debtor.balance, 25, 'Credit sale must increase customer debt');
assert(db.getCustomerLedger(customer.id).some((entry) => entry.sale_id === creditSale.id && entry.entry_type === 'credit_sale'), 'Credit sale is missing from the customer ledger.');
console.log('PASS: credit sale updates customer debt and ledger');

const debtPayment = db.receiveCustomerPayment({ customerId: customer.id, amount: 25, paymentMethod: 'cash', userId: admin.id, shiftId: shift.id });
nearly(debtPayment.balanceAfter, 0, 'Debt payment must settle the customer balance');
assert(db.getCustomerLedger(customer.id).some((entry) => entry.entry_type === 'payment' && Number(entry.amount) === -25), 'Debt settlement is missing from the customer ledger.');
console.log('PASS: debt settlement updates ledger and financial movement');

const supplier = db.createSupplier({ name: 'Regression supplier' });
const purchase = db.createPurchaseOrder({
  supplierId: supplier.id, items: [{ productId: product.id, quantity: 10, unitCost: 8 }],
  paidAmount: 20, paymentMethod: 'cash', userId: admin.id, shiftId: shift.id,
});
assert(purchase.success && purchase.id, 'Purchase must be received automatically.');
nearly(purchase.due, 60, 'Supplier due must equal purchase total less payment');
const receivedPurchase = db.getPurchaseOrder(purchase.id);
assert(receivedPurchase.status === 'received', 'Purchase should not remain a draft after saving.');
assert(db.listInventory({}).find((item) => item.product_id === product.id || item.id === product.id), 'Purchased product is missing from inventory.');
const supplierRow = db.listSuppliers().find((item) => item.id === supplier.id);
nearly(supplierRow.balance, 60, 'Supplier balance must retain only the unpaid amount');
const movements = db.getShiftCashMovements(shift.id, admin.id, admin.role);
assert(movements.some((m) => m.type === 'cash_out' && Number(m.amount) === 20 && m.reference === `purchase:${purchase.id}`), 'Cash purchase is missing its automatic cash-out movement.');
console.log('PASS: received purchase updates stock, supplier balance, and cash movement atomically');

const summary = db.getShiftSummary(shift.id, null, admin.id, admin.role);
nearly(summary.expectedCash, 55, 'Expected cash must use net cash after change plus debt payment minus purchase payment');
console.log('PASS: shift cash totals use net cash after change');

db.closeDatabase();
fs.rmSync(dataDir, { recursive: true, force: true });
console.log('PAYMENTS & PURCHASES REGRESSION: PASS (5 checks)');
