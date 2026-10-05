// اختبار: مسارا استعادة النسخة الاحتياطية (backup:restore و backup:restorePortable) لا
// يتركان اتصال قاعدة البيانات مغلقاً بصمت عند فشل التحقق — يُعاد تشغيل التطبيق بعملية
// نظيفة بعد استرجاع نسخة الأمان (أو تحذير واضح صريح إن فشل حتى الاسترجاع نفسه).
// شغّله: node tools/backup-restore-rollback-regression.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');

function extractHandler(name) {
  const startIdx = main.indexOf(`ipcMain.handle('${name}'`);
  assert.ok(startIdx !== -1, `${name} handler must exist.`);
  const nextHandleIdx = main.indexOf("ipcMain.handle(", startIdx + 1);
  return main.slice(startIdx, nextHandleIdx === -1 ? undefined : nextHandleIdx);
}

for (const name of ['backup:restore', 'backup:restorePortable']) {
  const handler = extractHandler(name);
  const catchIdx = handler.indexOf('} catch (error) {');
  assert.ok(catchIdx !== -1, `${name}: must have a catch block around the restore attempt.`);
  const catchBlock = handler.slice(catchIdx);

  // يجب أن يتحقق فعلياً من نجاح استرجاع نسخة الأمان (rolledBack) بدل افتراض نجاحه دائماً.
  assert.match(catchBlock, /let rolledBack = false;/, `${name}: must track whether the safety-copy rollback actually succeeded.`);
  assert.match(catchBlock, /rolledBack = true;/, `${name}: must mark rollback as successful only after the copy actually succeeds.`);

  // في حالة النجاح بالاسترجاع: يجب أن يُعاد تشغيل التطبيق (لا يُترك الاتصال مغلقاً بصمت).
  const rolledBackBranch = catchBlock.slice(catchBlock.indexOf('if (rolledBack)'));
  assert.match(rolledBackBranch, /app\.relaunch\(\);\s*app\.exit\(0\);/, `${name}: must restart the app after a successful rollback, instead of leaving the DB connection closed.`);

  // في حالة فشل الاسترجاع نفسه أيضاً: يجب تحذير المستخدم بوضوح بدل رمي خطأ صامت فقط.
  assert.match(catchBlock, /تعذّر أيضاً استرجاع النسخة الأصلية تلقائياً/, `${name}: must clearly warn the user when even the rollback itself fails.`);
}

console.log('BACKUP RESTORE ROLLBACK REGRESSION: PASS (both restore paths reopen safely via relaunch, and warn clearly if rollback itself fails)');
