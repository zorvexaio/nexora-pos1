// اختبار: update:installNow يرفض التثبيت إن لم يكن هناك تحديث اكتمل تنزيله فعلياً،
// ولا يكتفي بفحص صلاحية الأدمن فقط.
// شغّله: node tools/update-install-guard-regression.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');

// متغيّر تتبّع حالة التنزيل يجب أن يُصفَّر عند بدء أي دورة فحص/تنزيل جديدة، ويُملأ فقط
// من حدث update-downloaded الفعلي.
assert.match(main, /let downloadedUpdateInfo = null;/, 'A module-level flag must track whether a real download completed.');
assert.match(main, /autoUpdater\.on\('checking-for-update',\s*\(\)\s*=>\s*\{\s*downloadedUpdateInfo = null;/, 'Starting a new update check must reset the downloaded-update flag.');
assert.match(main, /autoUpdater\.on\('update-downloaded',\s*\(info\)\s*=>\s*\{\s*downloadedUpdateInfo = info;/, 'Only the real update-downloaded event may set the downloaded-update flag.');

// المقطع الخاص بـ installNow: يجب أن يتحقق من العلم قبل استدعاء quitAndInstall، لا أن
// يكتفي بفحص صلاحية الأدمن ثم يثبّت مباشرة. نحدّد حدود الدالة بأول تعريف handle تالٍ
// بدل regex هش قد يتوقف عند أول '});' داخلياً (مثل نهاية استدعاء db.logAudit).
const startIdx = main.indexOf("ipcMain.handle('update:installNow'");
assert.ok(startIdx !== -1, 'update:installNow handler must exist.');
const nextHandleIdx = main.indexOf("ipcMain.handle(", startIdx + 1);
const handler = main.slice(startIdx, nextHandleIdx === -1 ? undefined : nextHandleIdx);
assert.match(handler, /if\s*\(!downloadedUpdateInfo\)\s*throw new Error/, 'installNow must reject when no update has actually been downloaded.');
const guardIndex = handler.indexOf('if (!downloadedUpdateInfo)');
// نبحث عن الاستدعاء الفعلي autoUpdater.quitAndInstall() تحديداً لا عن أي ذكر لكلمة
// quitAndInstall (قد تُذكر داخل تعليق توضيحي قبل الحارس نفسه).
const quitIndex = handler.indexOf('autoUpdater.quitAndInstall()');
assert.ok(guardIndex !== -1 && quitIndex !== -1 && guardIndex < quitIndex, 'The downloaded-update guard must run before quitAndInstall() is called.');

console.log('UPDATE INSTALL GUARD REGRESSION: PASS (installNow requires a real completed download before quitAndInstall)');
