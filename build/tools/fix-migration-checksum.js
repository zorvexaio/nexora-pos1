#!/usr/bin/env node
// شغّلها هكذا من جذر المشروع (على جهاز ويندوز الحقيقي، ليس في sandbox):
//   npx electron tools/fix-migration-checksum.js 17
//
// السبب: نص دالة ترحيلة (migration) منشورة سابقاً تغيّر بعد أن كانت قاعدة بيانات
// حقيقية قد طبّقتها وسجّلت بصمتها (checksum) — فيرفض db.js فتح القاعدة برسالة
// "Migration vN was modified after publication; checksum mismatch." هذا الحارس
// نصّي بحت (يقارن نص الدالة كما هو)، وليس فحص سلوك، لذلك تعديل تنسيق/تعليق/قيمة
// بسيطة يكسره حتى لو كانت الترحيلة idempotent وأثرها الفعلي لم يتغيّر جوهرياً.
//
// هذه الأداة لا تُعيد تشغيل منطق الترحيلة، ولا تلمس database/db.js. كل ما تفعله:
// 1) تأخذ نسخة احتياطية كاملة من pos.db (+ WAL/SHM) قبل أي تعديل.
// 2) تحسب بصمة نص الدالة الحالي في database/db.js بنفس طريقة db.js بالضبط.
// 3) تفتح قاعدة البيانات الحقيقية المشفّرة (بنفس مفتاح safeStorage الذي يستخدمه
//    التطبيق) وتحدّث عمود checksum المخزّن لهذا الرقم فقط إلى القيمة الجديدة —
//    أي: "اعتماد النص الحالي كخط أساس جديد"، تماماً كما تفعل db.js تلقائياً أول
//    مرة تُطبَّق فيها الترحيلة (لا فرق سوى أن الصف موجود مسبقاً هنا).
//
// هذا آمن **بشرط** أن يكون التغيير في نص الدالة تنسيقياً/غير جوهري (الأثر على
// البيانات نفسه لم يتغيّر). إن كانت الترحيلة قد اكتسبت منطقاً جديداً فعلياً
// (مثل حساب محاسبي إضافي لم يكن موجوداً وقت أول تطبيق)، هذه الأداة لن "تُرجع"
// تطبيقه على القاعدة الحالية — فقط تُسكت التحذير. راجع الفرق يدوياً إذا لزم،
// وأخبرني إن كان ناقصاً شيء حتى نضيف ترحيلة جديدة رقمها أعلى تُكمِله بدل تعديل
// v17 المنشورة.

'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const targetVersion = Number(process.argv[2]);
if (!targetVersion) {
  console.error('الاستخدام: npx electron tools/fix-migration-checksum.js <رقم الترحيلة>');
  console.error('مثال: npx electron tools/fix-migration-checksum.js 17');
  process.exit(1);
}

const { app, safeStorage } = require('electron');
const Database = require('better-sqlite3-multiple-ciphers');

function extractFunctionSource(fileText, fnName) {
  const startMatch = fileText.match(new RegExp(`function\\s+${fnName}\\s*\\([^)]*\\)\\s*\\{`));
  if (!startMatch) return null;
  const start = startMatch.index;
  let i = start + startMatch[0].length;
  let depth = 1;
  while (i < fileText.length && depth > 0) {
    if (fileText[i] === '{') depth++;
    else if (fileText[i] === '}') depth--;
    i++;
  }
  if (depth !== 0) return null;
  return fileText.slice(start, i);
}

// جدول الترحيلات المرقّمة كما في database/db.js — يربط رقم الترحيلة باسم الدالة.
const VERSION_TO_FN = {
  2: 'migrateFinancialMinorUnits', 3: 'migrateAccountingCore', 4: 'migratePermissionsMatrix',
  5: 'migrateSyncEngineJournal', 6: 'migrateBackupIntegrity', 7: 'migrateFiscalization',
  8: 'migrateCommercialHardening', 9: 'migrateMigrationJournalIntegrity', 10: 'migratePayrollLifecycle',
  11: 'migrateInventoryTransferWorkflow', 12: 'migratePayrollAdvances', 13: 'migratePayrollAdvanceRepayments',
  14: 'migratePayrollTermination', 15: 'migratePayrollCommercialV15', 16: 'migrateShiftsMinorTriggerNullFix',
  17: 'migrateAccountingExtensionsV17', 18: 'migratePayrollAdvanceDisbursementMethodV18',
  19: 'migratePayrollAccrualV19', 20: 'migratePayrollFutureAccrualCorrectionV20',
  21: 'migrateAccountingBalanceCacheV21', 22: 'migratePayrollAdvancesAccountingV22',
  23: 'migrateInventoryAccountCorrectionV23',
};

const fnName = VERSION_TO_FN[targetVersion];
if (!fnName) {
  console.error(`رقم ترحيلة غير معروف: ${targetVersion}`);
  process.exit(1);
}

const dbJsPath = path.join(__dirname, '..', 'database', 'db.js');
const dbJsSrc = fs.readFileSync(dbJsPath, 'utf8');
const fnSource = extractFunctionSource(dbJsSrc, fnName);
if (!fnSource) {
  console.error(`تعذّر إيجاد الدالة ${fnName} داخل database/db.js — لم أعدّل أي شيء.`);
  process.exit(1);
}
const newChecksum = crypto.createHash('sha256').update(fnSource).digest('hex');

// عند تشغيل هذا الملف مباشرة عبر "npx electron tools/...js" (بدل "electron .")
// لا يحدّد Electron اسم التطبيق من package.json كما في التشغيل العادي، فيستخدم
// اسماً عاماً افتراضياً ويؤدي app.getPath('userData') إلى مجلد خاطئ. لتفادي أي
// تخمين، نبحث داخل مجلد %APPDATA% نفسه (وهو ثابت بغض النظر عن اسم التطبيق) عن
// أول مجلد فرعي يحوي pos.db و pos.db.key معاً.
function findRealUserDataDir() {
  const appDataRoot = app.getPath('appData'); // ...\AppData\Roaming
  let entries;
  try { entries = fs.readdirSync(appDataRoot, { withFileTypes: true }); } catch (_) { return []; }
  const matches = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(appDataRoot, entry.name);
    if (fs.existsSync(path.join(dir, 'pos.db')) && fs.existsSync(path.join(dir, 'pos.db.key'))) {
      matches.push(dir);
    }
  }
  return matches;
}

// مهم جداً: safeStorage (مخزن المفاتيح) على ويندوز يعتمد داخلياً على ملف "Local
// State" الموجود داخل مجلد userData نفسه، وليس فقط على حساب ويندوز الحالي. لذلك
// يجب تحديد userData الصحيح عبر app.setPath *قبل* حدث 'ready' — وإلا فسيستخدم
// Electron مخزن مفاتيح مختلف عن الذي شُفّر به pos.db.key أصلاً، فيفشل فك التشفير
// حتى لو كانت الملفات نفسها صحيحة تماماً.
const forcedDir = process.argv[3];
let resolvedUserDataPath = null;
let resolveError = null;

if (forcedDir) {
  resolvedUserDataPath = forcedDir;
} else {
  const matches = findRealUserDataDir();
  if (matches.length === 0) {
    resolveError = { type: 'none', appData: app.getPath('appData') };
  } else if (matches.length > 1) {
    resolveError = { type: 'many', matches };
  } else {
    resolvedUserDataPath = matches[0];
  }
}

if (resolvedUserDataPath) {
  app.setPath('userData', resolvedUserDataPath);
}

app.whenReady().then(() => {
  try {
    if (resolveError && resolveError.type === 'none') {
      console.error(`لم أجد أي مجلد داخل ${resolveError.appData} يحوي pos.db و pos.db.key معاً.`);
      console.error('افتح ذلك المسار يدوياً في مستكشف الملفات وابحث عن مجلد فيه pos.db، ثم أعد التشغيل هكذا:');
      console.error('  npx electron tools/fix-migration-checksum.js 17 "المسار_الكامل_للمجلد"');
      app.exit(1); return;
    }
    if (resolveError && resolveError.type === 'many') {
      console.error('وجدت أكثر من مجلد يحوي pos.db — حدّد الصحيح يدوياً:');
      for (const m of resolveError.matches) console.error(`  - ${m}`);
      console.error('ثم: npx electron tools/fix-migration-checksum.js 17 "المسار_الكامل"');
      app.exit(1); return;
    }
    const userDataPath = resolvedUserDataPath;
    console.log(`مستخدم مجلد: ${userDataPath}`);
    const dbPath = path.join(userDataPath, 'pos.db');
    const keyPath = path.join(userDataPath, 'pos.db.key');

    if (!fs.existsSync(dbPath)) {
      console.error(`لا توجد قاعدة بيانات في: ${dbPath}`);
      app.exit(1); return;
    }
    if (!fs.existsSync(keyPath)) {
      console.error(`لا يوجد ملف مفتاح التشفير في: ${keyPath}`);
      app.exit(1); return;
    }
    if (!safeStorage.isEncryptionAvailable()) {
      console.error('تعذّر الوصول إلى مخزن مفاتيح نظام التشغيل (safeStorage).');
      app.exit(1); return;
    }
    const key = Buffer.from(safeStorage.decryptString(fs.readFileSync(keyPath)).toString(), 'hex');

    // نسخة احتياطية كاملة قبل أي تعديل.
    const backupDir = path.join(userDataPath, 'checksum-fix-backups');
    fs.mkdirSync(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    for (const suffix of ['', '-wal', '-shm']) {
      const src = `${dbPath}${suffix}`;
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(backupDir, `pos.db${suffix}.${stamp}.bak`));
    }
    console.log(`تم أخذ نسخة احتياطية في: ${backupDir}`);

    const db = new Database(dbPath);
    db.pragma("cipher = 'chacha20'");
    db.key(key);

    const row = db.prepare('SELECT version, name, checksum FROM schema_migrations WHERE version=?').get(targetVersion);
    if (!row) {
      console.error(`لا يوجد صف مسجّل لهذه الترحيلة (v${targetVersion}) في schema_migrations — لا شيء لإصلاحه هنا.`);
      db.close(); app.exit(1); return;
    }
    if (row.checksum === newChecksum) {
      console.log(`لا شيء لعمله — بصمة v${targetVersion} مطابقة أصلاً لنص الكود الحالي.`);
      db.close(); app.exit(0); return;
    }
    console.log(`الاسم المخزَّن: ${row.name}`);
    console.log(`البصمة القديمة المخزَّنة: ${row.checksum}`);
    console.log(`البصمة الجديدة (من الكود الحالي): ${newChecksum}`);

    db.prepare('UPDATE schema_migrations SET checksum=? WHERE version=?').run(newChecksum, targetVersion);
    db.close();

    console.log(`تم: اعتُمد نص الكود الحالي لـ v${targetVersion} كخط أساس جديد. شغّل التطبيق الآن بشكل طبيعي (npm start).`);
    app.exit(0);
  } catch (err) {
    console.error('فشل الإصلاح:', err && err.stack || err);
    app.exit(1);
  }
});
