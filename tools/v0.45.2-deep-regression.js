const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const i18n = fs.readFileSync(path.join(root, 'renderer', 'i18n.js'), 'utf8');
const payroll = fs.readFileSync(path.join(root, 'renderer', 'pages', 'payroll.js'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
let passed = 0;
const requiredRuntimeDialogTranslations = [
  ['الراتب غير صالح.', 'Invalid salary.', 'Geçersiz maaş.'],
  ['دورة الرواتب غير موجودة.', 'Payroll period not found.', 'Maaş dönemi bulunamadı.'],
  ['اعتماد دورة الرواتب نهائياً؟ لن يمكن تعديل أيام العمل أو التسويات بعدها.', 'Approve this payroll period permanently?', 'Bu maaş dönemi kalıcı olarak onaylansın mı?'],
  ['تسجيل صرف هذه الرواتب؟', 'Record payment for these salaries?', 'Bu maaş ödemeleri kaydedilsin mi?'],
  ['عدد أيام العمل غير صالح.', 'Invalid number of work days.', 'Geçersiz çalışma günü sayısı.'],
  ['هل أنت متأكد من إغلاق جلسة الصندوق؟ لن تتوقف المبيعات؛ الإغلاق يخص جلسة متابعة الكاش فقط.', 'Are you sure you want to close the cash session?', 'Kasa oturumunu kapatmak istediğinizden emin misiniz?'],
  ['كلمة المرور مطلوبة للمستخدم الجديد', 'A password is required for a new user.', 'Yeni kullanıcı için parola gereklidir.'],
  ['لا يوجد رصيد مستحق على هذا العميل.', 'This customer has no outstanding balance.', 'Bu müşterinin ödenmemiş bakiyesi yok.'],
  ['سيُضاف المخزون وتُحدّث التكلفة. متابعة؟', 'This will add stock and update the cost. Continue?', 'Stok eklenecek ve maliyet güncellenecek. Devam edilsin mi?'],
  ['أدخل بند شراء صحيحاً.', 'Enter a valid purchase item.', 'Geçerli bir satın alma kalemi girin.'],
  ['لا توجد فاتورة بهذا الرقم', 'No invoice found with this number.', 'Bu numaraya ait fatura bulunamadı.'],
  ['هذه الفاتورة مرتجعة بالكامل مسبقاً', 'This invoice has already been fully returned.', 'Bu fatura zaten tamamen iade edilmiş.'],
  ['حدد كمية إرجاع لصنف واحد على الأقل', 'Select a return quantity for at least one item.', 'En az bir ürün için iade miktarı seçin.'],
  ['هل تريد تنفيذ هذا المرتجع؟ سيتم إرجاع الكمية للمخزون تلقائياً.', 'Do you want to process this return?', 'Bu iadeyi işlemek istiyor musunuz?'],
  ['سيتم نقل كل الأصناف إلى الطاولة الهدف. متابعة؟', 'All items will be moved to the target table. Continue?', 'Tüm ürünler hedef masaya taşınacak. Devam edilsin mi?'],
  ['الحزمة لازم تحتوي على منتجين على الأقل (وإلا مافيش داعي لخصم "تجميعي").', 'A bundle must contain at least two products;', 'Bir paket en az iki ürün içermelidir;']
];
const hasBothRuntimeDialogDictionaries = requiredRuntimeDialogTranslations.every(([ar, en, tr]) =>
  i18n.includes(`'${ar.replaceAll("'", "\\'")}': '${en}`) && i18n.includes(`'${ar.replaceAll("'", "\\'")}': '${tr}`)
);
const checks = [
  ['all literal Arabic runtime dialogs have EN/TR coverage', hasBothRuntimeDialogDictionaries],
  ['release version is synchronized', pkg.version === pkg.version && lock.version === pkg.version && lock.packages?.['']?.version === pkg.version],
  ['runtime alert is translated before native dialog', /window\.alert\s*=\s*\(message\)\s*=> nativeAlert\(translateRuntimeMessage\(message\)\)/.test(i18n)],
  ['runtime confirm is translated before native dialog', /window\.confirm\s*=\s*\(message\)\s*=> nativeConfirm\(translateRuntimeMessage\(message\)\)/.test(i18n)],
  ['runtime dialog patch is idempotent', /!window\.__nexoraRuntimeDialogsPatched/.test(i18n) && /window\.__nexoraRuntimeDialogsPatched = true/.test(i18n)],
  ['runtime translator preserves Arabic', /if \(lang === 'ar'\) return text;/.test(i18n)],
  ['runtime translator handles dynamic Arabic substrings', /result = result\.split\(source\)\.join\(translated\)/.test(i18n)],
  ['payroll renderer does not shadow translation function with table variable', !/const\s+t\s*=\s*document\.createElement\(['"]table['"]\)/.test(payroll)],
];
for (const [name, ok] of checks) {
  if (ok) { passed++; console.log('PASS:', name); }
  else { console.error('FAIL:', name); process.exitCode = 1; }
}
console.log(`V${pkg.version} DEEP REGRESSION: ${passed}/${checks.length} passed`);
