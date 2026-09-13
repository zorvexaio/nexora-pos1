#!/usr/bin/env node
// شغّلها مرة وحدة من جذر مشروعك (بعد ما تفكّ ضغط هذا الملف بحيث تحل مجلد tools/ عندك):
//   node tools/apply-all-fixes.js
// بتطبّق كل الإصلاحات اللي راجعناها بهالمحادثة بالترتيب، وحدة تلو الأخرى، وبتوقفك
// عند أول واحدة فيها مشكلة حقيقية بدل ما تكمل فوق كود غير متوقع.
'use strict';
const { execFileSync } = require('child_process');
const path = require('path');

const steps = [
  ['fix-v19-checksum.js', 'إرجاع migratePayrollAccrualV19 لنصها المنشور الأصلي (checksum)'],
  ['fix-tax-duplicate-key.js', 'دمج مفتاح tax المكرر بـ preload.js'],
  ['fix-qty-buffer-arabic-digits.js', 'خانة الكمية بالكاشير تقبل الأرقام العربية'],
  ['fix-arabic-digit-inputs.js', '~35 خانة رقمية تانية بكل التطبيق تقبل الأرقام العربية'],
  ['fix-category-tabs-always-show.js', 'تبويبات الفئات بالكاشير تظهر دايماً (صورة أو اسم نصي)'],
];

console.log('=== تطبيق إصلاحات v0.52.12 ===\n');
let failedAt = null;
for (const [script, label] of steps) {
  console.log(`--- ${label} (${script}) ---`);
  try {
    const out = execFileSync(process.execPath, [path.join(__dirname, script)], { encoding: 'utf8' });
    process.stdout.write(out);
  } catch (err) {
    process.stdout.write(err.stdout || '');
    process.stderr.write(err.stderr || String(err.message));
    failedAt = script;
    break;
  }
  console.log('');
}

if (failedAt) {
  console.error(`\nتوقفت عند ${failedAt} — راجع التحذيرات فوق وصلّحها يدوياً، بعدين أعد تشغيل هذا السكربت (باقي الخطوات آمنة تُعاد لأنها كلها idempotent).`);
  process.exitCode = 1;
} else {
  console.log('=== كل الإصلاحات اتطبّقت بنجاح ===\n');
  console.log('الخطوة التالية — تحقق نهائي:');
  console.log('  node tools/preload-duplicate-key-regression.js');
  console.log('  node tools/number-input-arabic-digit-regression.js');
  console.log('  node tools/payroll-accrual-v19-regression.js');
  console.log('  node tools/migration-chain-regression.js');
  console.log('  npm run check');
  console.log('\nثم أكمل: رفع رقم الإصدار، release-manifest.js --write، commit/tag/push، electron-builder --win --publish always.');
}
