// اختبار: منع تغيير عملة/دقة النظام بعد وجود تاريخ مالي حقيقي (مبيعات/قيود/مدفوعات).
// شغّله: node tools/currency-lock-regression.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexora-currency-lock-'));
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

let failed = 0;
function ok(cond, msg) {
  if (cond) console.log(`PASS: ${msg}`);
  else { console.log(`FAIL: ${msg}`); failed++; }
}

const admin = db.listUsers().find((u) => u.role === 'admin');
ok(!!admin, 'seed admin exists');

// 1) قبل أي تاريخ مالي: يجب أن يُسمح بتغيير العملة/الدقة بحرية.
const before = db.getGlobalProfile();
const changed = db.setGlobalProfile({
  countryCode: before.country_code, locale: before.locale, timezone: before.timezone,
  currencyCode: 'EGP', currencyMinorUnit: 2, taxMode: before.tax_mode,
  taxRegistrationNumber: before.tax_registration_number, fiscalizationMode: before.fiscalization_mode,
  fiscalProvider: before.fiscal_provider,
});
ok(changed.currency_code === 'EGP', 'currency change allowed before any financial history exists');

// غيّر رقم الخانات العشرية أيضاً (يفترض يُسمح لأنه لا يوجد تاريخ مالي بعد)
const changedMinor = db.setGlobalProfile({
  countryCode: before.country_code, locale: before.locale, timezone: before.timezone,
  currencyCode: 'EGP', currencyMinorUnit: 3, taxMode: before.tax_mode,
  taxRegistrationNumber: before.tax_registration_number, fiscalizationMode: before.fiscalization_mode,
  fiscalProvider: before.fiscal_provider,
});
ok(changedMinor.currency_minor_unit === 3, 'minor-unit change allowed before any financial history exists');

// أعد الدقة لقيمة معتادة (2) قبل بدء أي عمليات بيع حتى لا تتعارض مع بقية النظام
db.setGlobalProfile({
  countryCode: before.country_code, locale: before.locale, timezone: before.timezone,
  currencyCode: 'EGP', currencyMinorUnit: 2, taxMode: before.tax_mode,
  taxRegistrationNumber: before.tax_registration_number, fiscalizationMode: before.fiscalization_mode,
  fiscalProvider: before.fiscal_provider,
});

// 2) أنشئ تاريخاً مالياً حقيقياً (بيع واحد).
const shift = db.openShift(0, admin.id);
ok(shift.success, 'opened cash shift');
const product = db.createProduct({ name: 'اختبار قفل العملة', price: 10, cost: 4, initialStock: 100, trackInventory: true });
const sale = db.createSale({
  items: [{ productId: product.id, quantity: 1 }], paymentMethod: 'cash', cashAmount: 10, cardAmount: 0,
  changeDue: 0, discountType: null, discountValue: 0, customerId: null, userId: admin.id, shiftId: shift.id,
});
ok(!!sale && !!sale.id, 'a real sale was created (financial history now exists)');

// 3) بعد وجود تاريخ مالي: يجب أن يُرفض تغيير العملة أو الدقة، وتُقبل بقية الحقول.
let blockedCurrency = false;
try {
  db.setGlobalProfile({
    countryCode: 'TR', locale: 'ar', timezone: 'Europe/Istanbul',
    currencyCode: 'USD', currencyMinorUnit: 2, taxMode: 'exclusive',
    taxRegistrationNumber: '', fiscalizationMode: 'none', fiscalProvider: '',
  });
} catch (err) {
  blockedCurrency = /عملة النظام/.test(err.message);
}
ok(blockedCurrency, 'currency change is rejected once financial history exists');

let blockedMinor = false;
try {
  db.setGlobalProfile({
    countryCode: 'TR', locale: 'ar', timezone: 'Europe/Istanbul',
    currencyCode: 'EGP', currencyMinorUnit: 0, taxMode: 'exclusive',
    taxRegistrationNumber: '', fiscalizationMode: 'none', fiscalProvider: '',
  });
} catch (err) {
  blockedMinor = /عملة النظام/.test(err.message);
}
ok(blockedMinor, 'minor-unit change is rejected once financial history exists');

// 4) تغيير حقل غير مالي (المنطقة الزمنية) يجب أن يظل مسموحاً بدون أي مشاكل.
const tzChanged = db.setGlobalProfile({
  countryCode: 'TR', locale: 'ar', timezone: 'Asia/Riyadh',
  currencyCode: 'EGP', currencyMinorUnit: 2, taxMode: 'exclusive',
  taxRegistrationNumber: '', fiscalizationMode: 'none', fiscalProvider: '',
});
ok(tzChanged.timezone === 'Asia/Riyadh', 'non-monetary fields (timezone etc.) remain freely editable after financial history exists');
ok(tzChanged.currency_code === 'EGP' && Number(tzChanged.currency_minor_unit) === 2, 'currency/minor unit stayed untouched by the allowed update');

console.log(failed === 0 ? `\nCURRENCY LOCK REGRESSION: PASS (${5} checks)` : `\nCURRENCY LOCK REGRESSION: FAIL (${failed} failing)`);
process.exit(failed === 0 ? 0 : 1);
