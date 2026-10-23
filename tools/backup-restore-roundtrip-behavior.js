// اختبار سلوكي لدورة النسخ الاحتياطي والاستعادة كاملة على قاعدة بيانات مؤقتة.
// الاستعادة الحقيقية تُتبَع بإعادة تشغيل التطبيق (app.relaunch)، لذلك يُفتح الملف المستعاد
// في عملية Node جديدة — وهذا ما يفعله التطبيق بالضبط.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const Module = require('module');

const root = path.resolve(__dirname, '..');
const CHILD_FLAG = '--read-after-restore';

// في العملية الفرعية نعيد استخدام المجلد نفسه تماماً
const dataDir = process.env.NEXORA_TEST_DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'nexora-restore-behavior-'));
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

if (process.argv.includes(CHILD_FLAG)) {
  const db = require(path.join(root, 'database', 'db'));
  db.init();
  const names = db.listProducts({}).map((p) => p.name);
  process.stdout.write('NAMES:' + JSON.stringify(names) + '\n');
  process.exit(0);
}

const db = require(path.join(root, 'database', 'db'));
db.init();

let failures = 0;
function check(name, condition, detail = '') {
  if (condition) console.log(`PASS: ${name}`);
  else { failures += 1; console.log(`FAIL: ${name}${detail ? ' — ' + detail : ''}`); }
}

db.createProduct({ name: 'Before backup product', price: 20, cost: 5, initialStock: 10, trackInventory: true });
const backupPath = path.join(dataDir, 'roundtrip.db');

(async () => {
  await db.backupTo(backupPath);
  check('backup file created', fs.existsSync(backupPath) && fs.statSync(backupPath).size > 0);
  check('backup validates', db.validateBackupFile(backupPath).valid === true);

  db.createProduct({ name: 'After backup product', price: 30, cost: 6, initialStock: 10, trackInventory: true });

  // نفس تسلسل main.js: إغلاق، نسخ الملف فوق قاعدة البيانات، التحقق منه
  db.closeDatabase();
  fs.copyFileSync(backupPath, db.getDbPath());
  check('restored file validates', db.validateBackupFile(db.getDbPath()).valid === true);

  // إعادة التشغيل: عملية جديدة تفتح الملف المستعاد
  const child = spawnSync(process.execPath, [__filename, CHILD_FLAG], {
    env: { ...process.env, NEXORA_TEST_DATA_DIR: dataDir }, encoding: 'utf8',
  });
  const line = (child.stdout || '').split('\n').find((l) => l.startsWith('NAMES:'));
  const names = line ? JSON.parse(line.slice(6)) : [];
  check('child process opens restored database', child.status === 0 && !!line, (child.stderr || '').slice(0, 200));
  check('restored data contains the pre-backup product', names.includes('Before backup product'), names.join(', '));
  check('restored data does not contain the post-backup change', !names.includes('After backup product'), names.join(', '));

  if (failures) { console.log(`BACKUP RESTORE ROUNDTRIP: ${failures} FAILED`); process.exit(1); }
  console.log('BACKUP RESTORE ROUNDTRIP: PASS');
})().catch((e) => { console.log('FAIL: exception — ' + String(e && e.stack || e).slice(0, 400)); process.exit(1); });
