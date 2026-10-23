// اختبار سلوكي لتجميع الأصناف المكررة وحساب الضريبة الشاملة في طلب الطاولة، على قاعدة بيانات مؤقتة.
// ملاحظة تصميمية مقصودة: البند الموجود في الطلب يحتفظ بلقطة ضريبته وسعره لحظة إضافته،
// لذلك يُختبر وضع الضريبة على طلب جديد بعد تغييره.
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const root = path.resolve(__dirname, '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexora-pricing-behavior-'));
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

const db = require(path.join(root, 'database', 'db'));
db.init();

let failures = 0;
function check(name, condition, detail = '') {
  if (condition) console.log(`PASS: ${name}`);
  else { failures += 1; console.log(`FAIL: ${name}${detail ? ' — ' + detail : ''}`); }
}

const admin = db.listUsers().find((u) => u.role === 'admin');
const profile = db.getGlobalProfile();
const product = db.createProduct({ name: 'Pricing product', price: 110, cost: 40, initialStock: 50, trackInventory: true, taxRate: 10 });
db.createTable({ name: 'PRC-A', seats: 4 });
db.createTable({ name: 'PRC-B', seats: 4 });
const tables = db.listTables();
const tableA = tables.find((t) => t.name === 'PRC-A').id;
const tableB = tables.find((t) => t.name === 'PRC-B').id;

// --- تكرار الصنف في الإدخال: الإجماليات صحيحة ---
const sale = db.getOrCreateOpenSale(tableA, admin.id);
db.setOpenSaleItems(sale.id, [
  { productId: product.id, quantity: 2 },
  { productId: product.id, quantity: 3 },
]);
const detail = db.getSale(sale.id, db.getCurrentBranch().id);
const qty = detail.items.reduce((s, i) => s + Number(i.quantity || 0), 0);
check('duplicate product entries: quantity adds up to 5', qty === 5, `quantity=${qty}`);
check('duplicate product entries: exclusive subtotal is 5 x 110', Number(detail.subtotal) === 550, `subtotal=${detail.subtotal}`);
check('duplicate product entries: exclusive tax 55 added, grand total 605', Number(detail.grand_total) === 605, `grand_total=${detail.grand_total}`);

// --- الضريبة الشاملة على طلب جديد بعد تفعيلها ---
db.setGlobalProfile({
  countryCode: profile.country_code || 'TR', locale: profile.locale || 'tr', timezone: profile.timezone || 'Europe/Istanbul',
  currencyCode: profile.currency_code || 'TRY', currencyMinorUnit: profile.currency_minor_unit ?? 2,
  taxMode: 'inclusive', fiscalizationMode: profile.fiscalization_mode || 'none',
  fiscalProvider: profile.fiscal_provider || null, taxRegistrationNumber: profile.tax_registration_number || null,
});
const sale2 = db.getOrCreateOpenSale(tableB, admin.id);
db.setOpenSaleItems(sale2.id, [{ productId: product.id, quantity: 1 }]);
const inclusive = db.getSale(sale2.id, db.getCurrentBranch().id);
check('inclusive tax: grand total stays at the shelf price (110), not 121', Number(inclusive.grand_total) === 110, `grand_total=${inclusive.grand_total}`);
check('inclusive tax: tax portion is 10 of 110', Math.abs(Number(inclusive.tax_total) - 10) < 0.01, `tax_total=${inclusive.tax_total}`);

if (failures) { console.log(`OPEN ORDER PRICING BEHAVIOR: ${failures} FAILED`); process.exit(1); }
console.log('OPEN ORDER PRICING BEHAVIOR: PASS');
