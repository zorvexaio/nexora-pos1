// اختبار انحدار حقيقي (تنفيذي فعلي على SQLite حقيقية، وليس نصياً/تخمينياً) لميزة
// استبدال نقاط الولاء الجديدة بالكامل: المنح، الاستبدال، القيود المحاسبية، والمرتجعات.
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexora-loyalty-e2e-'));
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
function check(name, cond, extra) {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${name}${extra !== undefined ? ' -> ' + JSON.stringify(extra) : ''}`);
  if (!cond) failed++;
}
function nearly(actual, expected, msg) {
  check(msg, Math.abs(Number(actual) - Number(expected)) < 0.011, { actual, expected });
}

const admin = db.listUsers().find((u) => u.role === 'admin');
const shift = db.openShift(0, admin.id);
check('فتح جلسة صندوق للاختبار', shift.success);

const product = db.createProduct({ name: 'منتج اختبار الولاء', price: 100, cost: 40, initialStock: 1000, trackInventory: true });
const customer = db.createCustomer({ name: 'عميل اختبار الولاء', phone: '000999' });

// 0) الإعدادات الافتراضية: نقطة لكل 10 وحدات عملة منحاً، و10 نقاط = وحدة عملة استبدالاً
const settings = db.getLoyaltySettings();
check('الإعدادات الافتراضية: منح نقطة لكل 10 وحدات', settings.earnPerCurrencyUnit === 10, settings);
check('الإعدادات الافتراضية: استبدال 10 نقاط = وحدة عملة واحدة', settings.redeemPointsPerCurrencyUnit === 10, settings);

// 1) فاتورة أولى بدون استبدال: 500 (5 قطع بسعر 100) -> يكسب العميل floor(500/10)=50 نقطة
const sale1 = db.createSale({
  items: [{ productId: product.id, quantity: 5 }], paymentMethod: 'cash', cashAmount: 500, cardAmount: 0,
  changeDue: 0, discountType: null, discountValue: 0, customerId: customer.id, userId: admin.id, shiftId: shift.id,
});
check('الفاتورة الأولى (بدون استبدال) أُنشئت', !!sale1 && !!sale1.id);
let cust = db.listCustomers().find((c) => c.id === customer.id) || db.getCustomer?.(customer.id);
if (!cust) cust = { loyalty_points: undefined };
const customerAfterSale1 = db.searchCustomers ? db.searchCustomers('اختبار الولاء')[0] : null;
// نقرأ الرصيد مباشرة عبر قائمة العملاء لضمان قراءة صحيحة بصرف النظر عن اسم الدالة المتاحة
const custRow1 = db.listCustomers().find((c) => c.id === customer.id);
check('بعد الفاتورة الأولى: رصيد النقاط = 50 (500/10)', Number(custRow1.loyalty_points) === 50, custRow1.loyalty_points);

// 2) عرض الحد الأقصى القابل للاستبدال قبل فاتورة ثانية بقيمة 300 (subtotal فقط، بلا ضريبة هنا)
const quote = db.getLoyaltyRedemptionQuote(customer.id, 30000); // 300.00 بالوحدة الصغرى (سنت افتراضياً)
check('العرض: النقاط المتاحة = 50', quote.availablePoints === 50, quote);
check('العرض: أقصى نقاط قابلة للاستبدال بفاتورة 300 = 50 (القيمة 5 <= 300، الرصيد هو القيد)', quote.maxRedeemablePoints === 50, quote);

// 3) فاتورة ثانية بقيمة 300 مع استبدال 40 نقطة (تساوي 4 وحدات عملة خصماً)
const sale2 = db.createSale({
  items: [{ productId: product.id, quantity: 3 }], paymentMethod: 'cash', cashAmount: 300, cardAmount: 0,
  changeDue: 4, discountType: null, discountValue: 0, customerId: customer.id, userId: admin.id, shiftId: shift.id,
  loyaltyPointsToRedeem: 40,
});
check('الفاتورة الثانية (باستبدال 40 نقطة) أُنشئت', !!sale2 && !!sale2.id);
const saleRow2 = db.getSaleForReturn ? db.getSaleForReturn(sale2.id) : null;
nearly(sale2.grandTotal !== undefined ? sale2.grandTotal : (saleRow2 && saleRow2.grand_total), 296, 'الفاتورة الثانية: الإجمالي بعد الاستبدال = 300 - 4 = 296');

const custRow2 = db.listCustomers().find((c) => c.id === customer.id);
// 50 (رصيد سابق) - 40 (مستبدَلة) + floor(296/10)=29 (مكتسَبة من الفاتورة الثانية) = 39
check('بعد الفاتورة الثانية: رصيد النقاط = 39 (50-40+29)', Number(custRow2.loyalty_points) === 39, custRow2.loyalty_points);

// 4) القيد المحاسبي: ميزان المراجعة لازم يبقى متوازن تماماً رغم خصم الاستبدال
const trial = db.getTrialBalance();
check('ميزان المراجعة متوازن بعد فاتورة فيها استبدال نقاط', trial.balanced === true, { totalDebit: trial.totalDebit, totalCredit: trial.totalCredit });

// 5) رفض استبدال أكثر من الرصيد المتاح
let rejectedOverBalance = false;
try {
  db.createSale({
    items: [{ productId: product.id, quantity: 1 }], paymentMethod: 'cash', cashAmount: 100, cardAmount: 0,
    changeDue: 0, discountType: null, discountValue: 0, customerId: customer.id, userId: admin.id, shiftId: shift.id,
    loyaltyPointsToRedeem: 9999,
  });
} catch (e) { rejectedOverBalance = /رصيد نقاط العميل غير كافٍ/.test(e.message); }
check('رفض استبدال نقاط أكثر من رصيد العميل الفعلي', rejectedOverBalance);

// 6) رفض استبدال قيمة أكبر من المبلغ المستحق بالفاتورة (يجعل الإجمالي بالسالب)
let rejectedOverPayable = false;
try {
  db.createSale({
    items: [{ productId: product.id, quantity: 1 }], paymentMethod: 'cash', cashAmount: 100, cardAmount: 0,
    changeDue: 3.9, discountType: null, discountValue: 0, customerId: customer.id, userId: admin.id, shiftId: shift.id,
    loyaltyPointsToRedeem: 39, // العميل يملك 39، لكن قيمتها (3.9) قريبة من فاتورة الـ 100 فهي مقبولة فعلياً - نجرب سيناريو أوضح تحت
  });
} catch (e) { /* متوقع النجاح هنا فعلياً */ }
const custRowAfter6 = db.listCustomers().find((c) => c.id === customer.id);
// بعد الفاتورة 6 (نجحت): كان 39 - 39(مستبدلة) + floor((100-3.9)/10)=9 => 0+9=9
check('استبدال كل الرصيد المتاح ضمن فاتورة كافية القيمة يعمل بلا خطأ', Number(custRowAfter6.loyalty_points) === 9, custRowAfter6.loyalty_points);

// سيناريو مرفوض حقيقي منفصل: عميل جديد برصيد نقاط كبير كفاية، لكن بفاتورة صغيرة القيمة —
// يجب أن يُرفض الاستبدال إذا تجاوزت قيمته المبلغ المستحق نفسه، حتى لو رصيد النقاط يكفي
// نظرياً. نستخدم منتجاً رخيصاً منفصلاً لضمان فاتورة صغيرة واضحة.
const cheapProduct = db.createProduct({ name: 'منتج رخيص للاختبار', price: 5, cost: 2, initialStock: 100, trackInventory: true });
const customerC = db.createCustomer({ name: 'عميل اختبار المبلغ المستحق', phone: '000777' });
db.createSale({
  items: [{ productId: product.id, quantity: 10 }], paymentMethod: 'cash', cashAmount: 1000, cardAmount: 0,
  changeDue: 0, discountType: null, discountValue: 0, customerId: customerC.id, userId: admin.id, shiftId: shift.id,
}); // يمنح العميل 100 نقطة، رصيد كبير يكفي نظرياً لأي اختبار تالٍ
const custC = db.listCustomers().find((c) => c.id === customerC.id);
check('العميل الثالث كسب 100 نقطة (رصيد كافٍ لاختبار قيد المبلغ المستحق بمعزل عن قيد الرصيد)', Number(custC.loyalty_points) === 100, custC.loyalty_points);

// استبدال كبير (100 نقطة = 10 وحدات عملة) على فاتورة قيمتها 5 وحدات فقط - يجب أن يُرفض
// تحديداً برسالة "المبلغ المستحق"، رغم أن رصيد العميل (100 نقطة) يكفي نظرياً. نفّذ هذا
// الاختبار أولاً، قبل أي استبدال ناجح آخر يستهلك من رصيده.
let rejectedOverPayable2 = false;
try {
  db.createSale({
    items: [{ productId: cheapProduct.id, quantity: 1 }], paymentMethod: 'cash', cashAmount: 5, cardAmount: 0,
    changeDue: 0, discountType: null, discountValue: 0, customerId: customerC.id, userId: admin.id, shiftId: shift.id,
    loyaltyPointsToRedeem: 100,
  });
} catch (e) { rejectedOverPayable2 = /لا يمكن استبدال أكثر من/.test(e.message); }
check('رفض استبدال قيمة تتجاوز المبلغ المستحق (بمعزل عن كفاية الرصيد)', rejectedOverPayable2);

// استبدال صغير (20 نقطة = 2 وحدة عملة) على فاتورة قيمتها 5 وحدات فقط - يجب أن ينجح
// (الرصيد ما زال 100 لأن المحاولة أعلاه رُفضت بالكامل داخل معاملة واحدة ولم تُخصم أي نقطة)
let smallRedeemFailed = false;
try {
  db.createSale({
    items: [{ productId: cheapProduct.id, quantity: 1 }], paymentMethod: 'cash', cashAmount: 5, cardAmount: 0,
    changeDue: 2, discountType: null, discountValue: 0, customerId: customerC.id, userId: admin.id, shiftId: shift.id,
    loyaltyPointsToRedeem: 20,
  });
} catch (e) { smallRedeemFailed = true; }
check('استبدال 20 نقطة (=2) على فاتورة بقيمة 5 ينجح كما هو متوقع', smallRedeemFailed === false);

// 7) استرداد كامل لفاتورة فيها استبدال نقاط: نستخدم عميلاً جديداً منفصلاً تماماً عن
// العميل الأساسي، حتى نتحقق من الحساب بمعزل عن أي إنفاق لاحق للنقاط قد "يستهلكها"
// قبل إرجاعها (تلك حالة حدّية مختلفة تتعامل معها القاعدة الأصلية أصلاً بعدم السماح
// للرصيد بالسالب — سلوك سليم، لكنه يجعل حساب "الفرق الصافي المتوقع" غير مباشر).
const customerD = db.createCustomer({ name: 'عميل اختبار الاسترداد', phone: '000666' });
db.createSale({
  items: [{ productId: product.id, quantity: 5 }], paymentMethod: 'cash', cashAmount: 500, cardAmount: 0,
  changeDue: 0, discountType: null, discountValue: 0, customerId: customerD.id, userId: admin.id, shiftId: shift.id,
}); // يمنح 50 نقطة بلا أي استبدال، لضمان رصيد كافٍ للفاتورة القادمة
const saleD = db.createSale({
  items: [{ productId: product.id, quantity: 3 }], paymentMethod: 'cash', cashAmount: 300, cardAmount: 0,
  changeDue: 4, discountType: null, discountValue: 0, customerId: customerD.id, userId: admin.id, shiftId: shift.id,
  loyaltyPointsToRedeem: 40,
});
const custBeforeReturn = db.listCustomers().find((c) => c.id === customerD.id).loyalty_points;
check('قبل الاسترداد: رصيد العميل = 39 (50-40+29 بالضبط كما بالفاتورة الثانية سابقاً)', Number(custBeforeReturn) === 39, custBeforeReturn);

const saleForReturn = db.getSaleForReturn(saleD.invoiceNumber);
check('جلب الفاتورة لإرجاعها نجح ولها بند واحد', !!saleForReturn && saleForReturn.items.length === 1, saleForReturn && saleForReturn.items.length);
const returnResult = db.createReturn({
  saleId: saleD.id,
  items: [{ saleItemId: saleForReturn.items[0].id, quantity: 3 }],
  refundMethod: 'cash', userId: admin.id, shiftId: shift.id,
});
check('استرداد الفاتورة بالكامل نجح', !!returnResult && !!returnResult.id, returnResult);
nearly(returnResult.totalRefunded, 296, 'مبلغ الاسترداد = 296 بالضبط (صافي ما دفعه العميل فعلاً بعد خصم النقاط، لا 300)');
const custAfterReturn = db.listCustomers().find((c) => c.id === customerD.id);
nearly(Number(custAfterReturn.loyalty_points) - Number(custBeforeReturn), 40 - 29, 'الاسترداد الكامل: +40 نقطة مستعادة (استبدال) - 29 نقطة معكوسة (مكتسَبة) = +11 صافي');

const trialAfterReturn = db.getTrialBalance();
check('ميزان المراجعة لا يزال متوازناً بعد استرداد فاتورة فيها استبدال نقاط', trialAfterReturn.balanced === true, { totalDebit: trialAfterReturn.totalDebit, totalCredit: trialAfterReturn.totalCredit });

// 8) لا استبدال بلا عميل محدد بالفاتورة
let rejectedNoCustomer = false;
try {
  db.createSale({
    items: [{ productId: product.id, quantity: 1 }], paymentMethod: 'cash', cashAmount: 100, cardAmount: 0,
    changeDue: 0, discountType: null, discountValue: 0, customerId: null, userId: admin.id, shiftId: shift.id,
    loyaltyPointsToRedeem: 5,
  });
} catch (e) { rejectedNoCustomer = /يتطلب اختيار عميل/.test(e.message); }
check('رفض استبدال النقاط بفاتورة بلا عميل محدد', rejectedNoCustomer);

// 9) تعديل إعدادات معدّل الاستبدال ثم التأكد أنه يُطبَّق على فاتورة جديدة فقط
const saved = db.saveLoyaltySettings({ earnPerCurrencyUnit: 10, redeemPointsPerCurrencyUnit: 20 }); // 20 نقطة = وحدة عملة (أغلى بالاستبدال)
check('حفظ إعدادات ولاء جديدة نجح', saved.success === true, saved);
db.createSale({
  items: [{ productId: product.id, quantity: 5 }], paymentMethod: 'cash', cashAmount: 500, cardAmount: 0,
  changeDue: 0, discountType: null, discountValue: 0, customerId: customer.id, userId: admin.id, shiftId: shift.id,
}); // تعزيز رصيد العميل الأساسي (كان 9 فقط) ليكفي لاختبار المعدل الجديد بمعزل عن قيد الرصيد
const sale3 = db.createSale({
  items: [{ productId: product.id, quantity: 1 }], paymentMethod: 'cash', cashAmount: 100, cardAmount: 0,
  changeDue: 1, discountType: null, discountValue: 0, customerId: customer.id, userId: admin.id, shiftId: shift.id,
  loyaltyPointsToRedeem: 20, // بالمعدل الجديد: 20 نقطة = وحدة عملة واحدة فقط
});
const saleRow3 = db.getSaleForReturn(sale3.invoiceNumber);
nearly(saleRow3 ? saleRow3.grand_total : sale3.grandTotal, 99, 'بعد تغيير المعدل: استبدال 20 نقطة = خصم وحدة عملة واحدة فقط (100-1=99)');

// القيمة المخزَّنة بفاتورة سابقة (sale2) يجب ألا تتأثر بتغيير الإعداد لاحقاً (قيمة تاريخية ثابتة)
const saleRow2Check = db.getSaleForReturn(sale2.invoiceNumber);
if (saleRow2Check) nearly(saleRow2Check.loyalty_redeemed_value, 4, 'قيمة الاستبدال التاريخية بالفاتورة الثانية تبقى 4 رغم تغيير الإعداد لاحقاً');

console.log(failed ? `\n${failed} فحص/فحوصات فشلت` : '\nكل الفحوصات ناجحة — استبدال نقاط الولاء يعمل بشكل صحيح بالكامل (المنح، الاستبدال، المحاسبة، الاسترداد).');
process.exit(failed ? 1 : 0);
