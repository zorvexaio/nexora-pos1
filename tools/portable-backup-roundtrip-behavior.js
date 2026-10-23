// اختبار سلوكي للنسخة المحمولة المشفّرة: إنشاء -> تغيير البيانات -> استعادة بكلمة صحيحة ثم فتح في عملية جديدة،
// ومحاولة استعادة بكلمة خاطئة لا يجب أن تغيّر البيانات.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const Module = require('module');

const root = path.resolve(__dirname, '..');
const CHILD_FLAG = '--read-after-restore';
const dataDir = process.env.NEXORA_TEST_DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'nexora-portable-behavior-'));
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

const SECRET = 'portable-secret-123';
db.createProduct({ name: 'Portable before', price: 20, cost: 5, initialStock: 10, trackInventory: true });
const file = path.join(dataDir, 'portable.nexbk');

(async () => {
  const created = await db.createPortableBackup(file, SECRET);
  check('portable backup created', fs.existsSync(file) && fs.statSync(file).size > 0, JSON.stringify(created).slice(0, 160));
  const raw = fs.readFileSync(file);
  check('portable backup is not plaintext SQLite', !raw.slice(0, 16).toString('utf8').startsWith('SQLite format'));

  db.createProduct({ name: 'Portable after', price: 30, cost: 6, initialStock: 10, trackInventory: true });

  // كلمة خاطئة: لا يجب أن تُغيّر البيانات الحالية
  let wrongOk = false;
  try {
    const r = db.restorePortableBackup(file, 'wrong-password-999');
    wrongOk = !(r && r.valid);
  } catch (_) { wrongOk = true; }
  check('wrong passphrase is rejected', wrongOk);
  const stillHasAfter = db.listProducts({}).map((p) => p.name).includes('Portable after');
  check('wrong passphrase leaves current data untouched', stillHasAfter);

  // كلمة صحيحة: نفس تسلسل main.js (إغلاق، ثم استعادة، ثم إعادة تشغيل بعملية جديدة)
  const safety = path.join(dataDir, 'safety.db');
  await db.backupTo(safety);
  db.closeDatabase();
  const restored = db.restorePortableBackup(file, SECRET);
  check('correct passphrase restores', restored && restored.valid === true, JSON.stringify(restored).slice(0, 160));

  const child = spawnSync(process.execPath, [__filename, CHILD_FLAG], {
    env: { ...process.env, NEXORA_TEST_DATA_DIR: dataDir }, encoding: 'utf8',
  });
  const line = (child.stdout || '').split('\n').find((l) => l.startsWith('NAMES:'));
  const names = line ? JSON.parse(line.slice(6)) : [];
  check('fresh process opens the restored database', child.status === 0 && !!line, (child.stderr || '').slice(0, 200));
  check('restored data is the portable snapshot', names.includes('Portable before') && !names.includes('Portable after'), names.join(', '));

  if (failures) { console.log(`PORTABLE BACKUP ROUNDTRIP: ${failures} FAILED`); process.exit(1); }
  console.log('PORTABLE BACKUP ROUNDTRIP: PASS');
})().catch((e) => { console.log('FAIL: exception — ' + String(e && e.stack || e).slice(0, 400)); process.exit(1); });
