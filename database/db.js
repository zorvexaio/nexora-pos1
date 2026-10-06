const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3-multiple-ciphers');
const { app, safeStorage } = require('electron');
const { parseWeightedBarcode, buildWeightedBarcode } = require('./weighted-barcode');
const { parseGs1 } = require('./gs1-barcode');
const money = require('../core/money');
const accounting = require('../finance/accounting');
const {
  checkAuthRateLimit,
  recordAuthFailure,
  clearAuthFailures,
  hashPassword,
  verifyPassword,
} = require('./crypto-auth');
const settingsMod = require('./settings');
const branchesMod = require('./branches');
const auditMod = require('./audit');
const usersMod = require('./users');

// قاعدة البيانات تُخزَّن في مجلد بيانات المستخدم (يبقى بعد تحديث التطبيق).
// لا تحفظ أي بيانات عميل داخل مجلد التثبيت أو داخل asar، لأن المثبّت يستبدلهما بالكامل.
const userDataPath = app.getPath('userData');
const dbPath = path.join(userDataPath, 'pos.db');
const keyPath = path.join(userDataPath, 'pos.db.key');
const databaseExistedBeforeOpen = fs.existsSync(dbPath) && fs.statSync(dbPath).size > 0;
const CURRENT_SCHEMA_VERSION = 23;
// الحد الأقصى للكمية بالبند الواحد، مطابق للحد المستخدم بواجهة الكاشير السريع (quick-cashier.js)
// وquantity-buffer.js. يُفرض هنا على كل مسارات إنشاء/تعديل السلة (بيع عادي، تعديل فاتورة، طلب طاولة).
const MAX_LINE_QUANTITY = 9999;

// تقريب مبلغ بالوحدة الصغرى للعملة (0/2/3 خانات) — بديل آمن عن Math.round(x*100)/100
function roundMoney(value, unit = null) {
  const u = unit != null ? Number(unit) : Number(getGlobalProfile()?.currency_minor_unit ?? 2);
  try {
    return money.fromMinor(money.toMinor(Number(value || 0), u), u);
  } catch (_) {
    const n = Number(value || 0);
    if (!Number.isFinite(n)) return 0;
    const f = 10 ** u;
    return Math.round(n * f) / f;
  }
}


function getEncryptionKey() {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('تعذّر الوصول إلى مخزن مفاتيح نظام التشغيل؛ لا يمكن فتح قاعدة بيانات مشفّرة بأمان.');
  }
  if (fs.existsSync(keyPath)) {
    return safeStorage.decryptString(fs.readFileSync(keyPath)).toString();
  }
  const key = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(keyPath, safeStorage.encryptString(key), { mode: 0o600 });
  return key;
}

// نستخدم API الثنائية للحزمة بدلاً من PRAGMA النصية لتفادي اختلاف تفسير المفتاح
// بين إصدارات SQLite3 Multiple Ciphers. ملف المفتاح يبقى hex لكي يسهل نسخه آمناً.
const encryptionKey = Buffer.from(getEncryptionKey(), 'hex');
const SQLITE_HEADER = Buffer.from('SQLite format 3\u0000');

function isLegacyPlaintextDatabase(filePath) {
  if (!fs.existsSync(filePath) || fs.statSync(filePath).size < SQLITE_HEADER.length) return false;
  const header = Buffer.alloc(SQLITE_HEADER.length);
  const handle = fs.openSync(filePath, 'r');
  try { fs.readSync(handle, header, 0, header.length, 0); } finally { fs.closeSync(handle); }
  return header.equals(SQLITE_HEADER);
}

function applyDatabaseKey(handle) {
  // لا نعتمد على cipher الافتراضي لأنه اختلف بين إصدارات الحزمة.
  handle.pragma("cipher = 'chacha20'");
  handle.key(encryptionKey);
}

function encryptedDatabaseOpens(filePath) {
  if (!fs.existsSync(filePath) || fs.statSync(filePath).size === 0) return true;
  const handle = new Database(filePath, { readonly: true });
  try {
    applyDatabaseKey(handle);
    handle.pragma('schema_version'); // أول قراءة تُثبت صحة المفتاح فعلياً.
    return true;
  } catch (_) {
    return false;
  } finally {
    handle.close();
  }
}

// SQLite3MultipleCiphers يدعم rekey مباشرة لتحويل قاعدة SQLite عادية إلى قاعدة
// مشفّرة. ننشئ نسخة استرجاع بعد تفريغ WAL وقبل أي تعديل في الملف.
function migrateLegacyDatabase() {
  const legacyDb = new Database(dbPath);
  const backupPath = `${dbPath}.pre-encryption-backup`;
  try {
    legacyDb.pragma("cipher = 'chacha20'");
    legacyDb.pragma('wal_checkpoint(TRUNCATE)');
    legacyDb.pragma('journal_mode = DELETE');
    if (!fs.existsSync(backupPath)) fs.copyFileSync(dbPath, backupPath);
    legacyDb.rekey(encryptionKey);
  } finally {
    legacyDb.close();
  }
  // لا تسمح لملفات WAL القديمة غير المشفّرة أن تُلحق بالقاعدة المشفّرة الجديدة.
  for (const suffix of ['-wal', '-shm']) {
    const sidecar = `${dbPath}${suffix}`;
    const sidecarBackup = `${backupPath}${suffix}`;
    if (fs.existsSync(sidecar) && !fs.existsSync(sidecarBackup)) fs.renameSync(sidecar, sidecarBackup);
    else if (fs.existsSync(sidecar)) fs.unlinkSync(sidecar);
  }
}

class DatabaseKeyMismatchError extends Error {
  constructor(details) {
    super(
      'قاعدة البيانات موجودة لكن لا يمكن فتحها بالمفتاح الحالي (mismatch بين pos.db و pos.db.key). ' +
      'لم يتم حذف أو تعديل أي ملف — راجع الحقول التالية لمعرفة السبب.'
    );
    this.name = 'DatabaseKeyMismatchError';
    this.details = details;
  }
}

if (isLegacyPlaintextDatabase(dbPath)) {
  migrateLegacyDatabase();
} else if (!encryptedDatabaseOpens(dbPath)) {
  if (isLegacyPlaintextDatabase(`${dbPath}.pre-encryption-backup`)) {
    // إصلاح آمن لإصدار تجريبي قديم أنشأ ملفاً مشفراً بتنسيق خاطئ: لا نفقد النسخة الأصلية.
    const failedPath = `${dbPath}.failed-encryption-${Date.now()}`;
    fs.renameSync(dbPath, failedPath);
    fs.copyFileSync(`${dbPath}.pre-encryption-backup`, dbPath);
    migrateLegacyDatabase();
  } else {
    // لا يوجد مسار استرجاع معروف: الملف موجود، وله حجم فعلي، لكن المفتاح الحالي
    // لا يفتحه ولا يوجد نسخة قديمة غير مشفّرة لاستعادتها منها. غالباً pos.db.key
    // مفقود/مُعاد توليده، أو الملف نُسخ من جهاز/حساب مستخدم آخر (safeStorage
    // مرتبط بحساب ويندوز الحالي). نرفع خطأ واضح بدل ترك better-sqlite3 يفشل بشكل
    // مبهم — main.js يلتقطه ويعرض رسالة بدل الانهيار الصامت.
    throw new DatabaseKeyMismatchError({
      dbPath,
      keyPath,
      dbExists: fs.existsSync(dbPath),
      dbSizeBytes: fs.existsSync(dbPath) ? fs.statSync(dbPath).size : 0,
      keyFileExists: fs.existsSync(keyPath),
      preEncryptionBackupExists: fs.existsSync(`${dbPath}.pre-encryption-backup`),
    });
  }
}

const db = new Database(dbPath);
applyDatabaseKey(db);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function assertRuntimeSchemaCompatibility() {
  const required = {
    supplier_ledger: ['uuid','branch_id','supplier_id','purchase_order_id','entry_type','amount','balance_after','synced'],
    customer_ledger: ['uuid','branch_id','customer_id','sale_id','entry_type','amount','balance_after','synced'],
    store_credit_ledger: ['uuid','branch_id','customer_id','entry_type','amount','synced'],
  };
  for (const [table, columns] of Object.entries(required)) {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all();
    const set = new Set(rows.map(r => r.name));
    if (!rows.length) throw new Error(`Database schema missing required table: ${table}`);
    const missing = columns.filter(c => !set.has(c));
    if (missing.length) throw new Error(`Database schema mismatch in ${table}; missing: ${missing.join(', ')}`);
  }
  const fk = db.pragma('foreign_key_check');
  if (fk.length) throw new Error(`Database foreign-key check failed: ${fk.length} violation(s).`);
}

function init() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  const previousSchemaVersion = Number(db.pragma('user_version', { simple: true }) || 0);

  // قبل أول ترقية من قاعدة قديمة ننشئ لقطة كاملة قابلة للاسترجاع في userData.
  // تتم اللقطة قبل أي ALTER/UPDATE، وتضم قاعدة البيانات ومفتاحها والصور والترخيص
  // وباقي ملفات حالة العميل، لذلك لا تعتمد سلامة الترقية على نجاح المثبّت وحده.
  if (databaseExistedBeforeOpen && previousSchemaVersion < CURRENT_SCHEMA_VERSION) {
    createUpgradeSnapshot(`schema-v${previousSchemaVersion}-to-v${CURRENT_SCHEMA_VERSION}`);
  }

  // نقسّم المخطط إلى عبارات منفصلة، ونؤخّر تنفيذ الفهارس (CREATE INDEX) وأي عبارات أخرى غير
  // CREATE TABLE إلى ما بعد ensureLegacyBranchColumns (داخل runMigrations). السبب: بعض الفهارس
  // في المخطط الحالي تعتمد على أعمدة (مثل branch_id) أُضيفت لاحقاً في تاريخ المشروع لجداول كانت
  // موجودة من قبل — فتنفيذها مباشرة على قاعدة بيانات قديمة قبل إصلاح أعمدتها يفشل برسالة
  // "no such column: branch_id" حتى قبل أن تصل الترقيات (migrations) للتشغيل.
  const statements = splitSchemaStatements(schema);
  const tableStatements = statements.filter(isCreateTableStatement);
  const otherStatements = statements.filter((s) => !isCreateTableStatement(s));

  // كل تعديلات المخطط/البيانات ذرّية. إذا فشلت ترحيلة يبقى الملف كما كان قبلها،
  // واللقطة التلقائية السابقة تبقى متاحة للاسترجاع اليدوي أيضاً.
  db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    // Databases created by pre-v0.48.2 releases do not have a migration checksum.
    // Add it before applying the versioned migration journal so future changes to an
    // already-published migration are detected instead of silently changing history.
    addColumnIfMissing('schema_migrations', 'checksum TEXT');

    for (const stmt of tableStatements) db.exec(stmt);

    seedDefaultBranchIfEmpty();
    // هذه reconciliation متوافقة مع قواعد بيانات الإصدارات القديمة. أي تغيير جديد
    // لاحق يجب أن يضاف كتَرحيلة versioned عبر applyVersionedMigration أدناه.
    runMigrations();

    for (const stmt of otherStatements) db.exec(stmt);

    const versionedMigrations = [
      [2, 'financial-minor-units-v2', migrateFinancialMinorUnits],
      [3, 'accounting-core-v3', migrateAccountingCore],
      [4, 'permissions-matrix-v4', migratePermissionsMatrix],
      [5, 'sync-engine-journal-v5', migrateSyncEngineJournal],
      [6, 'backup-integrity-v6', migrateBackupIntegrity],
      [7, 'fiscalization-adapters-v7', migrateFiscalization],
      [8, 'commercial-hardening-v8', migrateCommercialHardening],
      [9, 'migration-journal-integrity-v9', migrateMigrationJournalIntegrity],
      [10, 'payroll-lifecycle-v10', migratePayrollLifecycle],
      [11, 'inventory-transfer-workflow-v11', migrateInventoryTransferWorkflow],
      [12, 'payroll-advances-v12', migratePayrollAdvances],
      [13, 'payroll-advance-repayments-v13', migratePayrollAdvanceRepayments],
      [14, 'payroll-termination-final-settlement-v14', migratePayrollTermination],
      [15, 'payroll-commercial-hardening-v15', migratePayrollCommercialV15],
      [16, 'shifts-minor-trigger-null-fix-v16', migrateShiftsMinorTriggerNullFix],
      [17, 'accounting-extensions-v17', migrateAccountingExtensionsV17],
      [18, 'payroll-advance-disbursement-method-v18', migratePayrollAdvanceDisbursementMethodV18],
      [19, 'payroll-accrual-v19', migratePayrollAccrualV19],
      [20, 'payroll-future-accrual-correction-v20', migratePayrollFutureAccrualCorrectionV20],
      [21, 'accounting-balance-cache-v21', migrateAccountingBalanceCacheV21],
      [22, 'payroll-advances-accounting-v22', migratePayrollAdvancesAccountingV22],
      [23, 'inventory-account-correction-v23', migrateInventoryAccountCorrectionV23],
    ];
    for (const [version, name, migration] of versionedMigrations) applyVersionedMigration(version, name, migration);
    assertMigrationJournalIntegrity(versionedMigrations);

    assertRuntimeSchemaCompatibility();
    seedDefaultAdminIfEmpty();
    db.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`);
  })();
}

// نقطة التوسعة الوحيدة للترقيات الجديدة. لا تعدّل ترحيلة منشورة؛ أضف رقماً أعلى
// وترحيلة idempotent أو تحويل بيانات واضحاً حتى تبقى كل قاعدة قابلة للترقية تدريجياً.
function migrationChecksum(migration) {
  return crypto.createHash('sha256').update(String(migration)).digest('hex');
}

function applyVersionedMigration(version, name, migration) {
  const numericVersion = Number(version);
  const checksum = migrationChecksum(migration);
  const existing = db.prepare('SELECT version, name, checksum FROM schema_migrations WHERE version=?').get(numericVersion);
  if (existing) {
    if (String(existing.name) !== String(name)) {
      throw new Error(`Migration journal name mismatch for v${numericVersion}: stored=${existing.name}, expected=${name}.`);
    }
    if (existing.checksum && String(existing.checksum) !== checksum) {
      throw new Error(`Migration v${numericVersion} was modified after publication; checksum mismatch.`);
    }
    if (!existing.checksum) {
      db.prepare('UPDATE schema_migrations SET checksum=? WHERE version=?').run(checksum, numericVersion);
    }
    return false;
  }
  migration();
  db.prepare('INSERT INTO schema_migrations(version, name, checksum) VALUES (?, ?, ?)').run(numericVersion, String(name), checksum);
  return true;
}

function migrateInventoryTransferWorkflow() {
  db.exec(`CREATE TABLE IF NOT EXISTS branch_directory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uuid TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_branch_directory_name ON branch_directory(name)`);

  db.exec(`CREATE TABLE IF NOT EXISTS inventory_transfers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uuid TEXT UNIQUE NOT NULL,
    source_branch_uuid TEXT NOT NULL,
    destination_branch_uuid TEXT NOT NULL,
    local_branch_id INTEGER NOT NULL REFERENCES branches(id),
    status TEXT NOT NULL DEFAULT 'shipped' CHECK(status IN ('shipped','received','cancelled')),
    notes TEXT,
    created_by INTEGER REFERENCES users(id),
    shipped_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    synced INTEGER NOT NULL DEFAULT 0,
    UNIQUE(uuid)
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_inventory_transfers_local_status ON inventory_transfers(local_branch_id,status,created_at DESC)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_inventory_transfers_route ON inventory_transfers(source_branch_uuid,destination_branch_uuid,created_at DESC)`);

  db.exec(`CREATE TABLE IF NOT EXISTS inventory_transfer_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    transfer_id INTEGER NOT NULL REFERENCES inventory_transfers(id) ON DELETE CASCADE,
    product_id INTEGER NOT NULL REFERENCES products(id),
    product_uuid TEXT NOT NULL,
    quantity REAL NOT NULL CHECK(quantity > 0),
    unit_cost REAL NOT NULL DEFAULT 0,
    UNIQUE(transfer_id, product_uuid)
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_inventory_transfer_items_transfer ON inventory_transfer_items(transfer_id)`);

  db.exec(`CREATE TABLE IF NOT EXISTS inventory_transfer_receipts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uuid TEXT UNIQUE NOT NULL,
    transfer_uuid TEXT NOT NULL,
    source_branch_uuid TEXT NOT NULL,
    destination_branch_uuid TEXT NOT NULL,
    local_branch_id INTEGER NOT NULL REFERENCES branches(id),
    received_by INTEGER REFERENCES users(id),
    notes TEXT,
    received_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    synced INTEGER NOT NULL DEFAULT 0,
    UNIQUE(transfer_uuid)
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_inventory_transfer_receipts_local ON inventory_transfer_receipts(local_branch_id,received_at DESC)`);

  db.exec(`CREATE TABLE IF NOT EXISTS inventory_transfer_receipt_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    receipt_id INTEGER NOT NULL REFERENCES inventory_transfer_receipts(id) ON DELETE CASCADE,
    product_uuid TEXT NOT NULL,
    quantity_received REAL NOT NULL CHECK(quantity_received > 0),
    UNIQUE(receipt_id, product_uuid)
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_inventory_transfer_receipt_items_receipt ON inventory_transfer_receipt_items(receipt_id)`);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_inventory_transfers_synced ON inventory_transfers(local_branch_id,synced,created_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_inventory_transfer_receipts_synced ON inventory_transfer_receipts(local_branch_id,synced,created_at)`);
}

function migratePayrollAdvances() {
  db.exec(`CREATE TABLE IF NOT EXISTS payroll_advances (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uuid TEXT UNIQUE NOT NULL,
    branch_id INTEGER NOT NULL REFERENCES branches(id),
    employee_id INTEGER NOT NULL REFERENCES payroll_employees(id),
    principal REAL NOT NULL CHECK(principal > 0),
    principal_minor INTEGER NOT NULL DEFAULT 0 CHECK(principal_minor > 0),
    installment_count INTEGER NOT NULL DEFAULT 1 CHECK(installment_count BETWEEN 1 AND 36),
    installment_amount REAL NOT NULL CHECK(installment_amount > 0),
    installment_amount_minor INTEGER NOT NULL DEFAULT 0 CHECK(installment_amount_minor > 0),
    first_deduction_month TEXT NOT NULL,
    reason TEXT,
    cash_movement_id INTEGER REFERENCES cash_movements(id),
    created_by INTEGER REFERENCES users(id),
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','completed')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS payroll_advance_installments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    advance_id INTEGER NOT NULL REFERENCES payroll_advances(id) ON DELETE CASCADE,
    month_key TEXT NOT NULL,
    installment_no INTEGER NOT NULL,
    amount REAL NOT NULL CHECK(amount > 0),
    amount_minor INTEGER NOT NULL DEFAULT 0 CHECK(amount_minor > 0),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(advance_id, installment_no),
    UNIQUE(advance_id, month_key)
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_payroll_advances_branch_employee_status ON payroll_advances(branch_id,employee_id,status,created_at DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_payroll_advance_installments_month ON payroll_advance_installments(month_key,advance_id)');
}

function migratePayrollAdvanceRepayments() {
  db.exec(`CREATE TABLE IF NOT EXISTS payroll_advance_payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uuid TEXT UNIQUE NOT NULL,
    branch_id INTEGER NOT NULL REFERENCES branches(id),
    advance_id INTEGER NOT NULL REFERENCES payroll_advances(id) ON DELETE CASCADE,
    payment_type TEXT NOT NULL CHECK(payment_type IN ('direct','salary')),
    amount REAL NOT NULL CHECK(amount > 0),
    amount_minor INTEGER NOT NULL CHECK(amount_minor > 0),
    payment_date TEXT NOT NULL,
    method TEXT,
    reference TEXT,
    notes TEXT,
    cash_movement_id INTEGER REFERENCES cash_movements(id),
    created_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS payroll_advance_payment_allocations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    payment_id INTEGER NOT NULL REFERENCES payroll_advance_payments(id) ON DELETE CASCADE,
    installment_id INTEGER NOT NULL REFERENCES payroll_advance_installments(id) ON DELETE CASCADE,
    amount REAL NOT NULL CHECK(amount > 0),
    amount_minor INTEGER NOT NULL CHECK(amount_minor > 0),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(payment_id, installment_id)
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_payroll_advance_payments_advance_date ON payroll_advance_payments(advance_id,payment_date,id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_payroll_advance_allocations_installment ON payroll_advance_payment_allocations(installment_id)');
}

function migratePayrollTermination() {
  addColumnIfMissing('payroll_employees', `terminated_at TEXT`);
  addColumnIfMissing('payroll_employees', `termination_reason TEXT`);
  db.exec(`CREATE TABLE IF NOT EXISTS payroll_final_settlements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uuid TEXT UNIQUE NOT NULL,
    branch_id INTEGER NOT NULL REFERENCES branches(id),
    employee_id INTEGER NOT NULL REFERENCES payroll_employees(id),
    month_id INTEGER NOT NULL REFERENCES payroll_months(id),
    settlement_date TEXT NOT NULL,
    gross_earned REAL NOT NULL DEFAULT 0,
    deductions REAL NOT NULL DEFAULT 0,
    advance_balance REAL NOT NULL DEFAULT 0,
    additional_compensation REAL NOT NULL DEFAULT 0,
    net_due REAL NOT NULL DEFAULT 0,
    paid_amount REAL NOT NULL DEFAULT 0,
    gross_earned_minor INTEGER NOT NULL DEFAULT 0,
    deductions_minor INTEGER NOT NULL DEFAULT 0,
    advance_balance_minor INTEGER NOT NULL DEFAULT 0,
    additional_compensation_minor INTEGER NOT NULL DEFAULT 0,
    net_due_minor INTEGER NOT NULL DEFAULT 0,
    paid_amount_minor INTEGER NOT NULL DEFAULT 0,
    method TEXT NOT NULL CHECK(method IN ('cash','bank','other')),
    cash_movement_id INTEGER REFERENCES cash_movements(id),
    notes TEXT,
    created_by INTEGER REFERENCES users(id),
    status TEXT NOT NULL DEFAULT 'paid' CHECK(status IN ('paid','voided')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(branch_id, uuid)
  );`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_payroll_final_settlements_employee_date ON payroll_final_settlements(branch_id,employee_id,settlement_date DESC,id DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_payroll_final_settlements_month ON payroll_final_settlements(branch_id,month_id,settlement_date DESC)');
}

function migratePayrollCommercialV15() {
  // Employee master-data needed for payroll documents, banking and future jurisdiction adapters.
  for (const def of [
    ['payroll_employees', `national_id TEXT`],
    ['payroll_employees', `hire_date TEXT`],
    ['payroll_employees', `phone TEXT`],
    ['payroll_employees', `department TEXT`],
    ['payroll_employees', `iban TEXT`],
    ['payroll_employees', `country_code TEXT`],
    ['payroll_employees', `payroll_notes TEXT`],
    ['payroll_employees', `synced INTEGER NOT NULL DEFAULT 0`],
    ['payroll_months', `synced INTEGER NOT NULL DEFAULT 0`],
    ['payroll_employee_months', `synced INTEGER NOT NULL DEFAULT 0`],
    ['payroll_transactions', `synced INTEGER NOT NULL DEFAULT 0`],
    ['payroll_advances', `synced INTEGER NOT NULL DEFAULT 0`],
    ['payroll_advance_installments', `synced INTEGER NOT NULL DEFAULT 0`],
    ['payroll_advance_payments', `synced INTEGER NOT NULL DEFAULT 0`],
    ['payroll_advance_payment_allocations', `synced INTEGER NOT NULL DEFAULT 0`],
    ['payroll_payments', `synced INTEGER NOT NULL DEFAULT 0`],
    ['payroll_final_settlements', `synced INTEGER NOT NULL DEFAULT 0`],
    ['payroll_employee_months', `debt_carry_minor INTEGER NOT NULL DEFAULT 0`],
    ['payroll_employee_months', `debt_carry REAL NOT NULL DEFAULT 0`],
    ['payroll_transactions', `amount_minor INTEGER NOT NULL DEFAULT 0`],
    ['payroll_transactions', `overtime_multiplier REAL NOT NULL DEFAULT 1.5`],
    ['payroll_transactions', `overtime_hours REAL NOT NULL DEFAULT 0`],
    ['payroll_final_settlements', `voided_at TEXT`],
    ['payroll_final_settlements', `void_reason TEXT`],
    ['payroll_advance_payments', `voided_at TEXT`],
    ['payroll_advance_payments', `void_reason TEXT`],
  ]) addColumnIfMissing(def[0], def[1]);

  // Fixed-point backfill for payroll transactions and historical employee rates.
  const unit = Number(getGlobalProfile()?.currency_minor_unit || 2);
  backfillMinorColumn('payroll_transactions', 'amount', 'amount_minor', unit);
  backfillMinorColumn('payroll_employees', 'pay_rate', 'pay_rate_minor', unit);
  backfillMinorColumn('payroll_employee_months', 'base_amount', 'base_amount_minor', unit);
  backfillMinorColumn('payroll_employee_months', 'net_salary', 'net_salary_minor', unit);
  backfillMinorColumn('payroll_employee_months', 'debt_carry', 'debt_carry_minor', unit);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_payroll_employees_national_id ON payroll_employees(branch_id,national_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_payroll_transactions_overtime ON payroll_transactions(month_id,employee_id,type,event_date);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_payroll_final_settlements_status ON payroll_final_settlements(branch_id,status,settlement_date DESC);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_payroll_advance_payments_active ON payroll_advance_payments(advance_id,voided_at,payment_date);`);
  db.prepare(`UPDATE payroll_employee_months SET debt_carry=COALESCE(debt_carry,0), debt_carry_minor=COALESCE(debt_carry_minor,0)`).run();
}

function migrateMigrationJournalIntegrity() {
  db.exec('CREATE INDEX IF NOT EXISTS idx_schema_migrations_applied_at ON schema_migrations(applied_at)');
}

// Payroll lifecycle v10: a month can be paid only through an immutable payment record.
// Advances remain deductions from the final net salary, while an advance paid from the
// register also creates a real cash-out. Once an employee/month is fully paid, payroll
// mutations are blocked so historical payroll cannot silently change.
function migratePayrollLifecycle() {
  addColumnIfMissing('payroll_months', `status TEXT NOT NULL DEFAULT 'open'`);
  addColumnIfMissing('payroll_months', `closed_at TEXT`);
  addColumnIfMissing('payroll_months', `closed_by INTEGER REFERENCES users(id)`);
  db.exec(`CREATE TABLE IF NOT EXISTS payroll_payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT UNIQUE NOT NULL, branch_id INTEGER NOT NULL REFERENCES branches(id),
    month_id INTEGER NOT NULL REFERENCES payroll_months(id), employee_id INTEGER NOT NULL REFERENCES payroll_employees(id),
    amount REAL NOT NULL CHECK(amount > 0), amount_minor INTEGER NOT NULL DEFAULT 0,
    method TEXT NOT NULL CHECK(method IN ('cash','bank','other')), payment_date TEXT NOT NULL,
    reference TEXT, notes TEXT, created_by INTEGER REFERENCES users(id),
    cash_movement_id INTEGER REFERENCES cash_movements(id), created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(branch_id, uuid)
  );`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_payroll_payments_month_employee ON payroll_payments(branch_id,month_id,employee_id,payment_date,id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_payroll_payments_cash_movement ON payroll_payments(cash_movement_id)');
  const unit = Number(getGlobalProfile()?.currency_minor_unit || 2);
  const rows = db.prepare('SELECT rowid, amount FROM payroll_payments').all();
  const update = db.prepare('UPDATE payroll_payments SET amount_minor=? WHERE rowid=?');
  for (const row of rows) update.run(money.toMinor(Number(row.amount || 0), unit), row.rowid);
  db.prepare("UPDATE payroll_months SET status=CASE WHEN status IN ('open','paid') THEN status ELSE 'open' END").run();
}

function assertMigrationJournalIntegrity(versionedMigrations) {
  const current = Number(db.pragma('user_version', { simple: true }) || 0);
  // إصلاح ذاتي لمرة واحدة: هذا الإصدار أزال تجربة "المستودعات + FIFO" (v24) بعد
  // طلب صريح من صاحب النظام بالتراجع عنها فوراً لأنها عطّلت تشغيل التطبيق على
  // جهاز كان قد جرّبها فعلاً (رسالة "schema vX أحدث من التطبيق"). إن كانت قاعدة
  // البيانات هذه بالذات هي الحالة المعروفة (وُصلت فعلاً لـv24 عبر تلك الترحيلة
  // بالضبط) نُرجع العدّاد لـ23 بدون لمس أي جدول أو بيانات — الجداول الإضافية
  // (warehouses...) تبقى بمكانها، فارغة الأثر، بانتظار نسخة قادمة تُفعّلها من جديد
  // إن رغب المستخدم بذلك لاحقاً.
  if (current === 24 && CURRENT_SCHEMA_VERSION === 23) {
    const knownRow = db.prepare("SELECT 1 FROM schema_migrations WHERE version=24 AND name='warehouses-fifo-v24'").get();
    if (knownRow) {
      db.pragma('user_version = 23');
      return assertMigrationJournalIntegrity(versionedMigrations);
    }
  }
  const rows = db.prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version').all();
  const byVersion = new Map(rows.map((r) => [Number(r.version), r]));
  for (const [version, name, migration] of versionedMigrations) {
    const row = byVersion.get(Number(version));
    if (!row) throw new Error(`Migration journal is incomplete: missing v${version}.`);
    if (String(row.name) !== String(name)) throw new Error(`Migration journal name mismatch at v${version}.`);
    if (!row.checksum) throw new Error(`Migration journal checksum missing at v${version}.`);
    if (String(row.checksum) !== migrationChecksum(migration)) throw new Error(`Migration journal checksum mismatch at v${version}.`);
  }
  if (current > CURRENT_SCHEMA_VERSION) {
    throw new Error(`Database schema v${current} is newer than this application v${CURRENT_SCHEMA_VERSION}.`);
  }
}

function addColumnIfMissing(table, columnDef) {
  const columnName = String(columnDef).trim().split(/\s+/)[0];
  const existing = db.prepare(`PRAGMA table_info(${table})`).all();
  if (existing.some((col) => col.name === columnName)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`);
  return true;
}

function backfillMinorColumn(table, sourceColumn, targetColumn, minorUnit = null) {
  const unit = minorUnit == null ? Number(getGlobalProfile()?.currency_minor_unit ?? 2) : Number(minorUnit);
  const rows = db.prepare(`SELECT rowid AS __rowid__, ${sourceColumn} AS value FROM ${table}`).all();
  const update = db.prepare(`UPDATE ${table} SET ${targetColumn}=? WHERE rowid=?`);
  for (const row of rows) update.run(money.toMinor(Number(row.value || 0), unit), row.__rowid__);
}

function migrateFinancialMinorUnits() {
  const specs = [
    ['products', 'price_minor INTEGER NOT NULL DEFAULT 0'], ['products', 'cost_minor INTEGER NOT NULL DEFAULT 0'],
    ['inventory', 'unit_cost_minor INTEGER NOT NULL DEFAULT 0'],
    ['sales', 'subtotal_minor INTEGER NOT NULL DEFAULT 0'], ['sales', 'tax_total_minor INTEGER NOT NULL DEFAULT 0'],
    ['sales', 'discount_total_minor INTEGER NOT NULL DEFAULT 0'], ['sales', 'bundle_discount_total_minor INTEGER NOT NULL DEFAULT 0'],
    ['sales', 'delivery_fee_minor INTEGER NOT NULL DEFAULT 0'], ['sales', 'grand_total_minor INTEGER NOT NULL DEFAULT 0'],
    ['sales', 'cash_amount_minor INTEGER NOT NULL DEFAULT 0'], ['sales', 'card_amount_minor INTEGER NOT NULL DEFAULT 0'],
    ['sales', 'change_due_minor INTEGER NOT NULL DEFAULT 0'], ['sales', 'due_amount_minor INTEGER NOT NULL DEFAULT 0'],
    ['sale_items', 'unit_price_minor INTEGER NOT NULL DEFAULT 0'], ['sale_items', 'line_total_minor INTEGER NOT NULL DEFAULT 0'],
    ['sale_items', 'cost_at_sale_minor INTEGER NOT NULL DEFAULT 0'], ['payment_transactions', 'amount_minor INTEGER NOT NULL DEFAULT 0'],
    ['cash_movements', 'amount_minor INTEGER NOT NULL DEFAULT 0'], ['customers', 'balance_minor INTEGER NOT NULL DEFAULT 0'],
    ['customers', 'store_credit_balance_minor INTEGER NOT NULL DEFAULT 0'], ['customer_ledger', 'amount_minor INTEGER NOT NULL DEFAULT 0'],
    ['customer_ledger', 'balance_after_minor INTEGER NOT NULL DEFAULT 0'], ['supplier_ledger', 'amount_minor INTEGER NOT NULL DEFAULT 0'],
    ['supplier_ledger', 'balance_after_minor INTEGER NOT NULL DEFAULT 0'], ['returns', 'total_refunded_minor INTEGER NOT NULL DEFAULT 0'],
    ['return_items', 'refund_amount_minor INTEGER NOT NULL DEFAULT 0'], ['shifts', 'opening_amount_minor INTEGER NOT NULL DEFAULT 0'],
    ['shifts', 'expected_cash_minor INTEGER NOT NULL DEFAULT 0'], ['shifts', 'actual_cash_minor INTEGER NOT NULL DEFAULT 0'],
    ['shifts', 'cash_difference_minor INTEGER NOT NULL DEFAULT 0'], ['purchase_orders', 'total_minor INTEGER NOT NULL DEFAULT 0'],
    ['purchase_orders', 'paid_amount_minor INTEGER NOT NULL DEFAULT 0'], ['purchase_order_items', 'unit_cost_minor INTEGER NOT NULL DEFAULT 0'],
    ['payroll_employees', 'pay_rate_minor INTEGER NOT NULL DEFAULT 0'], ['payroll_employee_months', 'base_amount_minor INTEGER NOT NULL DEFAULT 0'],
    ['payroll_employee_months', 'net_salary_minor INTEGER NOT NULL DEFAULT 0'],
  ];
  for (const [table, columnDef] of specs) addColumnIfMissing(table, columnDef);
  const pairs = [
    ['products','price','price_minor'], ['products','cost','cost_minor'], ['inventory','unit_cost','unit_cost_minor'],
    ['sales','subtotal','subtotal_minor'], ['sales','tax_total','tax_total_minor'], ['sales','discount_total','discount_total_minor'],
    ['sales','bundle_discount_total','bundle_discount_total_minor'], ['sales','delivery_fee','delivery_fee_minor'], ['sales','grand_total','grand_total_minor'],
    ['sales','cash_amount','cash_amount_minor'], ['sales','card_amount','card_amount_minor'], ['sales','change_due','change_due_minor'], ['sales','due_amount','due_amount_minor'],
    ['sale_items','unit_price','unit_price_minor'], ['sale_items','line_total','line_total_minor'], ['sale_items','cost_at_sale','cost_at_sale_minor'],
    ['payment_transactions','amount','amount_minor'], ['cash_movements','amount','amount_minor'], ['customers','balance','balance_minor'],
    ['customers','store_credit_balance','store_credit_balance_minor'], ['customer_ledger','amount','amount_minor'], ['customer_ledger','balance_after','balance_after_minor'],
    ['supplier_ledger','amount','amount_minor'], ['supplier_ledger','balance_after','balance_after_minor'], ['returns','total_refunded','total_refunded_minor'],
    ['return_items','refund_amount','refund_amount_minor'], ['shifts','opening_amount','opening_amount_minor'], ['shifts','expected_cash','expected_cash_minor'],
    ['shifts','actual_cash','actual_cash_minor'], ['shifts','cash_difference','cash_difference_minor'], ['purchase_orders','total','total_minor'],
    ['purchase_orders','paid_amount','paid_amount_minor'], ['purchase_order_items','unit_cost','unit_cost_minor'], ['payroll_employees','pay_rate','pay_rate_minor'],
    ['payroll_employee_months','base_amount','base_amount_minor'], ['payroll_employee_months','net_salary','net_salary_minor'],
  ];
  for (const [table, source, target] of pairs) backfillMinorColumn(table, source, target);

  // Compatibility triggers: legacy code paths still write REAL fields. Keep the new
  // minor-unit columns synchronized until every writer is migrated to fixed-point APIs.
  const multiplier = `(CASE COALESCE((SELECT currency_minor_unit FROM organization_profile LIMIT 1), 2)
    WHEN 0 THEN 1 WHEN 1 THEN 10 WHEN 2 THEN 100 WHEN 3 THEN 1000 WHEN 4 THEN 10000 WHEN 5 THEN 100000 WHEN 6 THEN 1000000 ELSE 100 END)`;
  const triggerSpecs = [
    ['products', [['price','price_minor'],['cost','cost_minor']]],
    ['inventory', [['unit_cost','unit_cost_minor']]],
    ['sales', [['subtotal','subtotal_minor'],['tax_total','tax_total_minor'],['discount_total','discount_total_minor'],['bundle_discount_total','bundle_discount_total_minor'],['delivery_fee','delivery_fee_minor'],['grand_total','grand_total_minor'],['cash_amount','cash_amount_minor'],['card_amount','card_amount_minor'],['change_due','change_due_minor'],['due_amount','due_amount_minor']]],
    ['sale_items', [['unit_price','unit_price_minor'],['line_total','line_total_minor'],['cost_at_sale','cost_at_sale_minor']]],
    ['payment_transactions', [['amount','amount_minor']]],
    ['cash_movements', [['amount','amount_minor']]],
    ['customers', [['balance','balance_minor'],['store_credit_balance','store_credit_balance_minor']]],
    ['customer_ledger', [['amount','amount_minor'],['balance_after','balance_after_minor']]],
    ['supplier_ledger', [['amount','amount_minor'],['balance_after','balance_after_minor']]],
    ['returns', [['total_refunded','total_refunded_minor']]],
    ['return_items', [['refund_amount','refund_amount_minor']]],
    ['shifts', [['opening_amount','opening_amount_minor'],['expected_cash','expected_cash_minor'],['actual_cash','actual_cash_minor'],['cash_difference','cash_difference_minor']]],
    ['purchase_orders', [['total','total_minor'],['paid_amount','paid_amount_minor']]],
    ['purchase_order_items', [['unit_cost','unit_cost_minor']]],
    ['payroll_employees', [['pay_rate','pay_rate_minor']]],
    ['payroll_employee_months', [['base_amount','base_amount_minor'],['net_salary','net_salary_minor']]],
  ];
  for (const [table, fields] of triggerSpecs) {
    const assignments = fields.map(([source, target]) => `${target}=CAST(ROUND(NEW.${source} * ${multiplier}) AS INTEGER)`).join(', ');
    const names = fields.map(([source]) => source).join(', ');
    db.exec(`CREATE TRIGGER IF NOT EXISTS trg_${table}_money_minor_ai AFTER INSERT ON ${table} BEGIN UPDATE ${table} SET ${assignments} WHERE rowid=NEW.rowid; END;`);
    db.exec(`CREATE TRIGGER IF NOT EXISTS trg_${table}_money_minor_au AFTER UPDATE OF ${names} ON ${table} BEGIN UPDATE ${table} SET ${assignments} WHERE rowid=NEW.rowid; END;`);
    // Also mirror writes made by the new fixed-point paths back into the legacy REAL
    // columns. This keeps old readers compatible without allowing the legacy fields
    // to remain stale after a minor-unit update. WHEN prevents recursive churn.
    for (const [source, target] of fields) {
      db.exec(`CREATE TRIGGER IF NOT EXISTS trg_${table}_${target}_to_${source} AFTER UPDATE OF ${target} ON ${table}
        WHEN ROUND(CAST(NEW.${target} AS REAL) / ${multiplier}, 9) <> ROUND(CAST(NEW.${source} AS REAL), 9)
        BEGIN UPDATE ${table} SET ${source}=CAST(NEW.${target} AS REAL) / ${multiplier} WHERE rowid=NEW.rowid; END;`);
    }
  }
}

// ترحيلة v16: تصلح المُطلِقين (triggers) اللي أنشأتهم الترحيلة v2 لجدول shifts.
// المُطلِقان الأصليان كانا يحسبان shifts.expected_cash_minor / actual_cash_minor /
// cash_difference_minor مباشرة من NEW.expected_cash / NEW.actual_cash / NEW.cash_difference.
// لكن الأعمدة النصية دي (REAL) تُترك عمداً NULL عند فتح وردية جديدة — لا تُملأ إلا عند
// إغلاقها. NULL * أي رقم = NULL في SQLite، وبما إن أعمدة الـ _minor معرَّفة NOT NULL
// DEFAULT 0، كانت أي محاولة لفتح وردية جديدة تفشل بخطأ:
//   NOT NULL constraint failed: shifts.expected_cash_minor
// الإصلاح: إعادة إنشاء نفس المُطلِقين بحماية COALESCE(..., 0). لا نعدّل ترحيلة v2
// المنشورة (checksum محمي)؛ نضيف ترحيلة جديدة idempotent بدل ذلك.
function migrateShiftsMinorTriggerNullFix() {
  const multiplier = `(CASE COALESCE((SELECT currency_minor_unit FROM organization_profile LIMIT 1), 2)
    WHEN 0 THEN 1 WHEN 1 THEN 10 WHEN 2 THEN 100 WHEN 3 THEN 1000 WHEN 4 THEN 10000 WHEN 5 THEN 100000 WHEN 6 THEN 1000000 ELSE 100 END)`;
  const fields = [
    ['opening_amount', 'opening_amount_minor'],
    ['expected_cash', 'expected_cash_minor'],
    ['actual_cash', 'actual_cash_minor'],
    ['cash_difference', 'cash_difference_minor'],
  ];
  const assignments = fields
    .map(([source, target]) => `${target}=CAST(ROUND(COALESCE(NEW.${source},0) * ${multiplier}) AS INTEGER)`)
    .join(', ');
  db.exec(`DROP TRIGGER IF EXISTS trg_shifts_money_minor_ai`);
  db.exec(`DROP TRIGGER IF EXISTS trg_shifts_money_minor_au`);
  db.exec(`CREATE TRIGGER trg_shifts_money_minor_ai AFTER INSERT ON shifts BEGIN UPDATE shifts SET ${assignments} WHERE rowid=NEW.rowid; END;`);
  db.exec(`CREATE TRIGGER trg_shifts_money_minor_au AFTER UPDATE OF opening_amount, expected_cash, actual_cash, cash_difference ON shifts BEGIN UPDATE shifts SET ${assignments} WHERE rowid=NEW.rowid; END;`);
  // أي وردية سبق وحاولت المرور بالمُطلِق القديم فشلت بالكامل (الـ INSERT اتلغى)، فمفيش
  // بيانات قديمة محتاجة تصحيح هنا — الإصلاح كافٍ لأي فتح وردية جديد من الآن.
}

function migrateAccountingCore() {
  db.exec(`CREATE TABLE IF NOT EXISTS accounting_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT UNIQUE NOT NULL, branch_id INTEGER NOT NULL REFERENCES branches(id),
    code TEXT NOT NULL, name TEXT NOT NULL, account_type TEXT NOT NULL CHECK(account_type IN ('asset','liability','equity','revenue','expense')),
    currency_code TEXT NOT NULL DEFAULT 'USD', opening_balance_minor INTEGER NOT NULL DEFAULT 0, is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')), synced INTEGER NOT NULL DEFAULT 0,
    UNIQUE(branch_id, code)
  );
  CREATE TABLE IF NOT EXISTS accounting_journal_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT UNIQUE NOT NULL, branch_id INTEGER NOT NULL REFERENCES branches(id),
    reference_type TEXT, reference_id TEXT, memo TEXT, currency_code TEXT NOT NULL, entry_date TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'posted' CHECK(status IN ('draft','posted','void')), created_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')), synced INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS accounting_journal_lines (
    id INTEGER PRIMARY KEY AUTOINCREMENT, entry_id INTEGER NOT NULL REFERENCES accounting_journal_entries(id) ON DELETE CASCADE,
    account_id INTEGER NOT NULL REFERENCES accounting_accounts(id), debit_minor INTEGER NOT NULL DEFAULT 0, credit_minor INTEGER NOT NULL DEFAULT 0, memo TEXT
  );
  CREATE TABLE IF NOT EXISTS accounting_periods (
    id INTEGER PRIMARY KEY AUTOINCREMENT, branch_id INTEGER NOT NULL REFERENCES branches(id), period_key TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','locked')), locked_at TEXT, locked_by INTEGER REFERENCES users(id), UNIQUE(branch_id, period_key)
  );
  CREATE INDEX IF NOT EXISTS idx_accounting_accounts_branch_type ON accounting_accounts(branch_id, account_type);
  CREATE INDEX IF NOT EXISTS idx_accounting_entries_branch_date ON accounting_journal_entries(branch_id, entry_date);
  CREATE INDEX IF NOT EXISTS idx_accounting_lines_account ON accounting_journal_lines(account_id);`);
  const branch = getCurrentBranch();
  const currency = String(getGlobalProfile()?.currency_code || 'USD').toUpperCase();
  const defaults = [['1000','Cash','asset'],['1100','Bank','asset'],['1200','Accounts Receivable','asset'],['1300','Inventory','asset'],['2000','Accounts Payable','liability'],['2100','Tax Payable','liability'],['2200','Customer Store Credit','liability'],['3000','Owner Equity','equity'],['4000','Sales Revenue','revenue'],['4100','Delivery Revenue','revenue'],['5000','Cost of Goods Sold','expense'],['6000','Operating Expenses','expense']];
  const insert = db.prepare('INSERT OR IGNORE INTO accounting_accounts(uuid,branch_id,code,name,account_type,currency_code) VALUES(?,?,?,?,?,?)');
  for (const row of defaults) insert.run(uuid(), branch.id, row[0], row[1], row[2], currency);
}

// ترحيلة v3 (migrateAccountingCore) منشورة فعلاً ومحسوبة بصمة (checksum) لمحتواها —
// لا يجوز تعديل جسمها لإضافة حسابات جديدة (يكسر ترقية أي قاعدة سبق وطبّقتها).
// أي حساب/دفتر جديد لاحقاً يُضاف هنا بترحيلة برقم أعلى بدلاً من ذلك.
// تشمل كل الفروع (وليس فرع العمل الحالي فقط) حتى لا يبقى فرع بلا الحسابات الجديدة.
function migratePayrollAdvanceDisbursementMethodV18() {
  // قواعد ما قبل v18 لا تميّز طريقة صرف السلفة: العمود الوحيد المتاح كان cash_movement_id
  // (يُملأ فقط عند الصرف نقداً من الصندوق). لذلك أي سلفة قديمة مربوطة بحركة صندوق تُعتبر
  // 'cash' بيقين، وأي سلفة قديمة بلا حركة صندوق تبقى 'cash' كقيمة افتراضية متحفظة (كانت
  // الشاشة القديمة تفترض النقد ضمنياً أصلاً) بدل تخمين 'bank' أو 'other' بلا دليل.
  addColumnIfMissing('payroll_advances', "disbursement_method TEXT NOT NULL DEFAULT 'cash'");
}

// إصلاح خلل جوهري: قبل v19 كان مصروف الرواتب (6100) يُرحَّل فقط بلحظة الصرف الفعلي
// وبقدر المبلغ المصروف حصراً (أساس نقدي). فإذا كان مستحق الشهر لعامل ما 8400 وصُرف له
// حتى الآن 3500 فقط، تظهر قائمة الدخل مصروف 3500 لا غير، والفرق 4900 غير معترف به
// بالمحاسبة أبداً (لا كمصروف ولا كالتزام) — هذا سبب شكوى "تناقض بين الحساب والدفع".
// v19 يحوّل الترحيل لأساس استحقاقي حقيقي:
//   1) عمود accrued_minor على payroll_employee_months: يحفظ كم من صافي الراتب
//      (net_salary_minor) تم الاعتراف به مصروفاً فعلياً بدفتر اليومية لهذا الموظف/الشهر.
//   2) حساب التزام جديد 2300 "رواتب مستحقة" — يقابل الفرق بين المستحق والمصروف فعلياً.
//   3) syncPayrollEmployeeAccrual/accruePayrollMonth (أدناه) يرحّلان الفرق: مدين 6100 /
//      دائن 2300 بكامل المستحق الجديد، بغض النظر عن توقيت الصرف الفعلي — والصرف الفعلي
//      (recordPayrollPayment) بعد v19 يسدد فقط الالتزام 2300 (مدين 2300 / دائن نقد) دون
//      إعادة تسجيل المصروف مرة ثانية.
//   4) تصحيح فوري (catch-up) هنا لكل شهر مفتوح حالياً: يعترف بالفرق (مستحق - مصروف فعلياً
//      حتى الآن عبر الدفعات التاريخية) كمصروف والتزام دفعة واحدة، بتاريخ اليوم (لا نُعدّل
//      قيود فترات سابقة قد تكون مقفلة). الشهور المُقفلة بحالة 'paid' لا تحتاج تصحيحاً:
//      إجمالي ما دُفع لها فعلياً يساوي المستحق بالتعريف (شرط إغلاق الشهر)، فمصروفها مُرحَّل
//      بالكامل أصلاً (تراكمياً عبر قيود الدفعات السابقة)، ونُثبّت accrued_minor فيها فقط
//      لضبط الحالة دون أي قيد جديد.
function migratePayrollAccrualV19() {
  addColumnIfMissing('payroll_employee_months', 'accrued_minor INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing('payroll_months', 'accrued_at TEXT');
  addColumnIfMissing('payroll_months', 'accrued_by INTEGER REFERENCES users(id)');
  const branches = db.prepare('SELECT id FROM branches').all();
  const currency = String(getGlobalProfile()?.currency_code || 'USD').toUpperCase();
  const insertAccount = db.prepare('INSERT OR IGNORE INTO accounting_accounts(uuid,branch_id,code,name,account_type,currency_code) VALUES(?,?,?,?,?,?)');
  const today = payrollTodayLocal().toISOString().slice(0, 10);
  for (const branch of branches) {
    insertAccount.run(uuid(), branch.id, '2300', 'رواتب مستحقة (التزام أجور)', 'liability', currency);
    const accountRow = db.prepare("SELECT id FROM accounting_accounts WHERE branch_id=? AND code='2300' AND is_active=1").get(branch.id);
    const expenseRow = db.prepare("SELECT id FROM accounting_accounts WHERE branch_id=? AND code='6100' AND is_active=1").get(branch.id);
    if (!accountRow || !expenseRow) continue; // فرع بلا وحدة محاسبية مفعّلة بعد — لا شيء لتصحيحه هنا.
    const months = db.prepare("SELECT * FROM payroll_months WHERE branch_id=?").all(branch.id);
    for (const month of months) {
      const employeeMonths = db.prepare('SELECT m.*,e.full_name FROM payroll_employee_months m JOIN payroll_employees e ON e.id=m.employee_id WHERE m.month_id=?').all(month.id);
      for (const em of employeeMonths) {
        // حارس أمان: لا تُعِد معالجة صف سبق ترحيله (accrued_minor محفوظ فعلاً) — يمنع
        // تكرار القيد التصحيحي لو نُفِّذت هذه الدالة أكثر من مرة (مثلاً يدوياً بالاختبار).
        if (Number(em.accrued_minor || 0) !== 0) continue;
        const netMinor = Number(em.net_salary_minor || 0);
        if (String(month.status || 'open') === 'paid') {
          // مصروفه بالكامل أصلاً عبر قيود الدفعات التاريخية — فقط نضبط العلامة، بلا قيد جديد.
          db.prepare('UPDATE payroll_employee_months SET accrued_minor=? WHERE id=?').run(netMinor, em.id);
          continue;
        }
        const paidMinor = Number(db.prepare('SELECT COALESCE(SUM(amount_minor),0) x FROM payroll_payments WHERE branch_id=? AND month_id=? AND employee_id=?').get(branch.id, month.id, em.employee_id).x || 0);
        const gapMinor = Math.max(0, netMinor - paidMinor); // الجزء المستحق غير المرحَّل محاسبياً بعد.
        if (gapMinor > 0) {
          db.prepare(`INSERT INTO accounting_journal_entries(uuid,branch_id,reference_type,reference_id,memo,currency_code,entry_date,status,created_by,synced) VALUES(?,?,?,?,?,?,?,'posted',NULL,0)`)
            .run(uuid(), branch.id, 'payroll_accrual', em.id, `تصحيح استحقاق راتب (ترحيل v19): ${em.full_name} — ${month.month_key}`, currency, today);
          const entryId = db.prepare('SELECT last_insert_rowid() id').get().id;
          const insertLine = db.prepare('INSERT INTO accounting_journal_lines(entry_id,account_id,debit_minor,credit_minor,memo) VALUES(?,?,?,?,?)');
          insertLine.run(entryId, expenseRow.id, gapMinor, 0, `استحقاق راتب غير مُرحَّل سابقاً: ${em.full_name} — ${month.month_key}`);
          insertLine.run(entryId, accountRow.id, 0, gapMinor, `التزام راتب مستحق: ${em.full_name} — ${month.month_key}`);
        }
        // accrued_minor = paidMinor + gapMinor = netMinor دائماً بعد التصحيح (سواء وُجد قيد جديد أو لا).
        db.prepare('UPDATE payroll_employee_months SET accrued_minor=? WHERE id=?').run(paidMinor + gapMinor, em.id);
      }
    }
  }
}

// v20: تصحيح خطأ حقيقي وقع في هجرة v19 — كانت تُرحّل استحقاق راتب حتى لأشهر لم تبدأ بعد
// (شهر مستقبلي) لأنها لم تكن تستثني الأشهر اللاحقة للشهر الحالي. هذه الدالة تعكس فقط
// القيود التي أُنشئت فعلاً لشهر مستقبلي (month_key أكبر من شهر اليوم وقت وجود القيد)،
// وتُصفّر accrued_minor المقابل لها. آمنة للتكرار: لا تُنشئ عكساً لقيد سبق عكسه.
function migratePayrollFutureAccrualCorrectionV20() {
  const currentMonthKey = `${payrollTodayLocal().getFullYear()}-${String(payrollTodayLocal().getMonth() + 1).padStart(2, '0')}`;
  const badRows = db.prepare(`
    SELECT e.id AS entry_id, e.branch_id, e.reference_id AS em_id, m.month_key, m.id AS month_id,
           em.employee_id, em.accrued_minor
    FROM accounting_journal_entries e
    JOIN payroll_employee_months em ON em.id = e.reference_id
    JOIN payroll_months m ON m.id = em.month_id
    WHERE e.reference_type = 'payroll_accrual' AND e.status = 'posted' AND m.month_key > ?
  `).all(currentMonthKey);
  const alreadyCorrected = new Set(
    db.prepare(`SELECT reference_id FROM accounting_journal_entries WHERE reference_type = 'payroll_accrual_future_correction_v20'`).all().map((r) => r.reference_id)
  );
  for (const row of badRows) {
    if (alreadyCorrected.has(row.entry_id)) continue; // سبق تصحيح هذا القيد.
    const lines = db.prepare('SELECT account_id, debit_minor, credit_minor FROM accounting_journal_lines WHERE entry_id=?').all(row.entry_id);
    if (!lines.length) continue;
    const reversedLines = lines.map((l) => ({ accountId: l.account_id, debitMinor: Number(l.credit_minor || 0), creditMinor: Number(l.debit_minor || 0), memo: `عكس استحقاق مستقبلي خاطئ (v20) — شهر ${row.month_key}` }));
    insertPostedJournalEntry({ branchId: row.branch_id, memo: `تصحيح v20: إلغاء استحقاق راتب لشهر مستقبلي (${row.month_key}) لم يبدأ بعد`, referenceType: 'payroll_accrual_future_correction_v20', referenceId: row.entry_id, lines: reversedLines, createdBy: null });
    const gap = lines.reduce((s, l) => s + Number(l.debit_minor || 0), 0);
    db.prepare('UPDATE payroll_employee_months SET accrued_minor = MAX(0, accrued_minor - ?) WHERE id=?').run(gap, row.em_id);
  }
}

function migrateInventoryAccountCorrectionV23() {
  const unit = Number(getGlobalProfile()?.currency_minor_unit ?? 2);
  db.prepare(`
    UPDATE inventory SET unit_cost = (SELECT p.cost FROM products p WHERE p.id = inventory.product_id)
    WHERE unit_cost = 0
      AND EXISTS (SELECT 1 FROM products p WHERE p.id = inventory.product_id AND p.cost > 0)
  `).run();

  const branches = db.prepare('SELECT id FROM branches').all();
  for (const branch of branches) {
    const inventoryAccount = db.prepare("SELECT id FROM accounting_accounts WHERE branch_id=? AND code='1300' AND is_active=1").get(branch.id);
    const equityAccount = db.prepare("SELECT id FROM accounting_accounts WHERE branch_id=? AND code='3000' AND is_active=1").get(branch.id);
    if (!inventoryAccount || !equityAccount) continue;

    const balRow = db.prepare(
      `SELECT COALESCE(SUM(l.debit_minor),0) AS d, COALESCE(SUM(l.credit_minor),0) AS c
       FROM accounting_journal_lines l JOIN accounting_journal_entries e ON e.id=l.entry_id
       WHERE l.account_id=? AND e.status='posted'`
    ).get(inventoryAccount.id);
    const currentBalanceMinor = Number(balRow.d || 0) - Number(balRow.c || 0);

    const realRow = db.prepare(
      `SELECT COALESCE(SUM(i.quantity * p.cost),0) AS v
       FROM inventory i JOIN products p ON p.id=i.product_id
       WHERE i.branch_id=? AND p.track_inventory=1 AND p.is_active=1`
    ).get(branch.id);
    const realValueMinor = Math.round(Number(realRow.v || 0) * (10 ** unit));

    const diffMinor = realValueMinor - currentBalanceMinor;
    if (diffMinor === 0) continue;

    insertPostedJournalEntry({
      branchId: branch.id,
      memo: `تصحيح رصيد حساب المخزون ليطابق القيمة الفعلية (ترحيلة v23)`,
      referenceType: 'inventory_account_correction_v23',
      referenceId: branch.id,
      lines: diffMinor > 0
        ? [
            { accountId: inventoryAccount.id, debitMinor: diffMinor, creditMinor: 0 },
            { accountId: equityAccount.id, debitMinor: 0, creditMinor: diffMinor },
          ]
        : [
            { accountId: equityAccount.id, debitMinor: Math.abs(diffMinor), creditMinor: 0 },
            { accountId: inventoryAccount.id, debitMinor: 0, creditMinor: Math.abs(diffMinor) },
          ],
    });
  }
}

// v24: مستودعات متعددة داخل الفرع الواحد + دفتر دفعات تكلفة FIFO. ترحيلة إضافية
// بحتة — لا تلمس جدول inventory (المتوسط المرجّح) ولا أي مسار بيع/مرتجع/طلب طاولة
// موجود، فمخاطرها على البيانات الحيّة شبه معدومة. تُنشئ لكل فرع مستودعاً افتراضياً
// واحداً (يمثّل تماماً رصيد inventory الحالي)، ثم تفتح لكل رصيد حالي >0 دفعة FIFO
// افتتاحية بنفس الكمية والتكلفة الحالية حتى لا يُفقد أي أثر للمخزون الموجود فعلاً.
// v21: تسريع تقارير المحاسبة (ميزان المراجعة/قائمة الدخل/الميزانية) بدون تغيير
// أي نتيجة — تضيف عمود current_balance_minor على accounting_accounts يخزّن صافي
// حركة الحساب التراكمية (مدين-دائن) من كل القيود المرحّلة، ويتحدّث تلقائياً بمُطلِقات
// (triggers) على accounting_journal_lines بدل إعادة جمعه من الصفر بكل استعلام.
// هذا العمود "صافي حركة فقط" (لا يشمل الرصيد الافتتاحي) حتى يصلح لحساب رصيد
// حسابات الأصول/الخصوم (بإضافة opening_balance_minor) ولحساب صافي الإيراد/المصروف
// بنفس الوقت دون افتراض قيمة الرصيد الافتتاحي.
// الاستعلامات القديمة (بالتواريخ التاريخية المحدَّدة) ما بتتغيّر إطلاقاً — راجع الحارس
// hasPostedEntriesAfter بدوال getTrialBalance/getBalanceSheet: لو في أي قيد مرحّل
// بتاريخ بعد حد الاستعلام (asOfDate)، بيرجع تلقائياً للاستعلام القديم الدقيق 100%،
// فمفيش خطر إنه يكسر أي تقرير أو فترة مقفولة.
function migrateAccountingBalanceCacheV21() {
  addColumnIfMissing('accounting_accounts', 'current_balance_minor INTEGER NOT NULL DEFAULT 0');
  // تصفير ثم إعادة بناء العمود من كل القيود المرحّلة الموجودة فعلياً — مرة وحيدة،
  // idempotent (تشتغل صح حتى لو أُعيد تشغيلها بالغلط).
  db.exec(`
    UPDATE accounting_accounts SET current_balance_minor = COALESCE((
      SELECT SUM(l.debit_minor - l.credit_minor) FROM accounting_journal_lines l
      JOIN accounting_journal_entries e ON e.id = l.entry_id
      WHERE l.account_id = accounting_accounts.id AND e.status = 'posted'
    ), 0);
    DROP TRIGGER IF EXISTS trg_accounting_balance_cache_ai;
    CREATE TRIGGER trg_accounting_balance_cache_ai AFTER INSERT ON accounting_journal_lines BEGIN
      UPDATE accounting_accounts SET current_balance_minor = current_balance_minor + (NEW.debit_minor - NEW.credit_minor)
      WHERE id = NEW.account_id AND (SELECT status FROM accounting_journal_entries WHERE id = NEW.entry_id) = 'posted';
    END;
  `);
}

// إصلاح خلل: صرف/تسديد سلف الموظفين (createPayrollAdvance/repayPayrollAdvance/
// settlePayrollAdvance) والتصفية النهائية (settleEmployeeFinalPayroll) كانت تسجّل حركة
// الصندوق (cash_movements) فقط، ولم تكن تُرحَّل محاسبياً بدفتر اليومية إطلاقاً — بعكس كل
// حركة نقد أخرى بالتطبيق (مبيعات/مشتريات/دفعات عملاء وموردين/صرف رواتب عادي) واللي كل
// واحدة منها ترحّل قيداً موازياً. النتيجة: حساب النقد/البنك بميزان المراجعة والمركز
// المالي ما كان يطابق نقدية الصندوق الفعلية كل ما تُستخدم هذه الميزات. هذه الترحيلة
// تضيف حساب أصل جديد "سلف موظفين" ليكون الطرف المقابل لهذه الحركات (خارج عن ترحيلة v3
// المنشورة والمحسوبة بصمة — لا يجوز تعديل تلك مباشرة).
function migratePayrollAdvancesAccountingV22() {
  const branches = db.prepare('SELECT id FROM branches').all();
  const currency = String(getGlobalProfile()?.currency_code || 'USD').toUpperCase();
  const insert = db.prepare('INSERT OR IGNORE INTO accounting_accounts(uuid,branch_id,code,name,account_type,currency_code) VALUES(?,?,?,?,?,?)');
  for (const branch of branches) insert.run(uuid(), branch.id, '1400', 'سلف موظفين (أصل)', 'asset', currency);
}

function migrateAccountingExtensionsV17() {
  const branches = db.prepare('SELECT id FROM branches').all();

  const currency = String(getGlobalProfile()?.currency_code || 'USD').toUpperCase();
  const extraAccounts = [
    ['6100', 'رواتب وأجور (مصروف)', 'expense'],
  ];
  const insert = db.prepare('INSERT OR IGNORE INTO accounting_accounts(uuid,branch_id,code,name,account_type,currency_code) VALUES(?,?,?,?,?,?)');
  for (const branch of branches) {
    for (const row of extraAccounts) insert.run(uuid(), branch.id, row[0], row[1], row[2], currency);
  }
}

function migratePermissionsMatrix() {
  db.exec(`CREATE TABLE IF NOT EXISTS permissions (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE NOT NULL, description TEXT NOT NULL); CREATE TABLE IF NOT EXISTS role_permissions (role TEXT NOT NULL, permission_id INTEGER NOT NULL REFERENCES permissions(id) ON DELETE CASCADE, PRIMARY KEY(role, permission_id));`);
  const { PERMISSIONS } = require('../core/permissions'); const ip=db.prepare('INSERT OR IGNORE INTO permissions(code,description) VALUES(?,?)'); const gp=db.prepare('SELECT id FROM permissions WHERE code=?'); const ir=db.prepare('INSERT OR IGNORE INTO role_permissions(role,permission_id) VALUES(?,?)');
  for (const code of Object.keys(PERMISSIONS)) { ip.run(code,code); const id=gp.get(code)?.id; for (const role of PERMISSIONS[code]) ir.run(role,id); }
}

function migrateSyncEngineJournal() {
  db.exec(`CREATE TABLE IF NOT EXISTS sync_outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT UNIQUE NOT NULL, branch_id INTEGER NOT NULL REFERENCES branches(id), entity_type TEXT NOT NULL, entity_uuid TEXT, operation TEXT NOT NULL CHECK(operation IN ('create','update','delete','event')), payload_json TEXT NOT NULL, payload_checksum TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sent','failed')), attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), sent_at TEXT); CREATE TABLE IF NOT EXISTS sync_inbox (event_id TEXT PRIMARY KEY, branch_id INTEGER NOT NULL REFERENCES branches(id), payload_checksum TEXT NOT NULL, received_at TEXT NOT NULL DEFAULT (datetime('now')), applied_at TEXT, status TEXT NOT NULL DEFAULT 'received', error TEXT); CREATE TABLE IF NOT EXISTS sync_conflicts (id INTEGER PRIMARY KEY AUTOINCREMENT, branch_id INTEGER NOT NULL REFERENCES branches(id), entity_type TEXT NOT NULL, entity_uuid TEXT, conflict_type TEXT NOT NULL, local_checksum TEXT, remote_checksum TEXT, resolution TEXT, details_json TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), resolved_at TEXT); CREATE INDEX IF NOT EXISTS idx_sync_outbox_pending ON sync_outbox(branch_id,status,created_at); CREATE INDEX IF NOT EXISTS idx_sync_conflicts_open ON sync_conflicts(branch_id,resolved_at,created_at);`);
}

function migrateBackupIntegrity() {
  db.exec(`CREATE TABLE IF NOT EXISTS backup_manifests (id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT UNIQUE NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('local','portable','restore')), path TEXT, file_size INTEGER, sha256 TEXT NOT NULL, schema_version INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), created_by INTEGER REFERENCES users(id), verified_at TEXT, verification_status TEXT NOT NULL DEFAULT 'verified', synced INTEGER NOT NULL DEFAULT 0); CREATE INDEX IF NOT EXISTS idx_backup_manifests_created ON backup_manifests(created_at DESC);`);
}

function migrateFiscalization() {
  db.exec(`CREATE TABLE IF NOT EXISTS fiscal_documents (id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT UNIQUE NOT NULL, branch_id INTEGER NOT NULL REFERENCES branches(id), sale_id INTEGER REFERENCES sales(id), provider TEXT NOT NULL, document_type TEXT NOT NULL DEFAULT 'invoice', status TEXT NOT NULL DEFAULT 'pending', external_id TEXT, external_number TEXT, request_payload TEXT, response_payload TEXT, error_message TEXT, issued_at TEXT, cancelled_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')), synced INTEGER NOT NULL DEFAULT 0); CREATE INDEX IF NOT EXISTS idx_fiscal_documents_sale ON fiscal_documents(sale_id); CREATE INDEX IF NOT EXISTS idx_fiscal_documents_status ON fiscal_documents(branch_id,status);`);
}

function migrateCommercialHardening() {
  db.exec(`CREATE TABLE IF NOT EXISTS financial_locks (entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, branch_id INTEGER NOT NULL REFERENCES branches(id), locked_at TEXT NOT NULL DEFAULT (datetime('now')), locked_by INTEGER REFERENCES users(id), reason TEXT, PRIMARY KEY(entity_type, entity_id)); CREATE INDEX IF NOT EXISTS idx_financial_locks_branch ON financial_locks(branch_id,entity_type); CREATE INDEX IF NOT EXISTS idx_sales_branch_created_status ON sales(branch_id, created_at, status); CREATE INDEX IF NOT EXISTS idx_inventory_branch_updated ON inventory(branch_id, updated_at); CREATE INDEX IF NOT EXISTS idx_audit_branch_action_created ON audit_logs(branch_id, action, created_at);`);
}

// يقسّم نص schema.sql إلى عبارات SQL منفصلة (كل عبارة تنتهي بفاصلة منقوطة في نهاية سطر)
function splitSchemaStatements(sql) {
  const lines = sql.split('\n');
  const statements = [];
  let buf = [];
  for (const line of lines) {
    buf.push(line);
    if (/;\s*$/.test(line.trim())) {
      statements.push(buf.join('\n'));
      buf = [];
    }
  }
  if (buf.some((l) => l.trim())) statements.push(buf.join('\n'));
  return statements;
}

function isCreateTableStatement(stmt) {
  const firstReal = stmt.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('--'));
  return !!firstReal && /^CREATE TABLE/i.test(firstReal);
}

/* ---------------- تشفير كلمات المرور + rate-limit ---------------- */
// نُقلت إلى database/crypto-auth.js (دفعة التفكيك 1) — تُستورد أعلى الملف.

// عند أول تشغيل بدون أي مستخدمين: نُنشئ حساب مديرٍ عام افتراضي حتى يمكن الدخول لأول مرة
function seedDefaultAdminIfEmpty() {
  const count = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (count === 0) {
    const branch = getCurrentBranch();
    const username = 'admin';
    const temporaryPassword = crypto.randomBytes(18).toString('base64url');
    db.prepare(
      `INSERT INTO users (uuid, full_name, username, password_hash, role, branch_id, is_active, must_change_password)
       VALUES (?, ?, ?, ?, 'admin', ?, 1, 1)`
    ).run(uuid(), 'المدير العام', username, hashPassword(temporaryPassword), branch.id);
    setSetting('bootstrap_admin_username', username);
    setSetting('bootstrap_admin_temp_password', temporaryPassword);
    setSetting('bootstrap_admin_pending', '1');
  }
}

function getBootstrapAdminInfo() {
  if (getSetting('bootstrap_admin_pending', '0') !== '1') return null;
  const password = getSetting('bootstrap_admin_temp_password', '');
  const username = getSetting('bootstrap_admin_username', 'admin');
  if (!password) return null;
  return { username, temporaryPassword: password };
}

function clearBootstrapAdminInfo() {
  setSetting('bootstrap_admin_temp_password', '');
  setSetting('bootstrap_admin_pending', '0');
}

// إضافة أعمدة جديدة بأمان لقواعد بيانات أُنشئت بنسخة أقدم من التطبيق
// (CREATE TABLE IF NOT EXISTS لا يضيف أعمدة لجدول موجود بالفعل، لذلك نضيفها يدوياً هنا)
const LEGACY_BRANCH_TABLES = Object.freeze([
  'audit_logs', 'users', 'inventory', 'restaurant_tables', 'tax_profiles',
  'payment_transactions', 'cash_movements', 'customers', 'customer_ledger',
  'store_credit_ledger', 'shifts', 'sales', 'payroll_periods', 'payroll_adjustments',
  'user_salary_history', 'suppliers', 'supplier_ledger', 'purchase_orders', 'returns',
  'inventory_movements', 'bundles',
]);

function ensureLegacyBranchColumns(tryAddColumn) {
  const defaultBranchId = getCurrentBranch().id;
  const specs = {
    audit_logs: 'branch_id INTEGER REFERENCES branches(id)',
    users: 'branch_id INTEGER REFERENCES branches(id)',
    inventory: 'branch_id INTEGER REFERENCES branches(id)',
    restaurant_tables: 'branch_id INTEGER REFERENCES branches(id)',
    tax_profiles: 'branch_id INTEGER REFERENCES branches(id)',
    payment_transactions: 'branch_id INTEGER REFERENCES branches(id)',
    cash_movements: 'branch_id INTEGER REFERENCES branches(id)',
    customers: 'branch_id INTEGER REFERENCES branches(id)',
    customer_ledger: 'branch_id INTEGER REFERENCES branches(id)',
    store_credit_ledger: 'branch_id INTEGER REFERENCES branches(id)',
    shifts: 'branch_id INTEGER REFERENCES branches(id)',
    sales: 'branch_id INTEGER REFERENCES branches(id)',
    payroll_periods: 'branch_id INTEGER REFERENCES branches(id)',
    payroll_adjustments: 'branch_id INTEGER REFERENCES branches(id)',
    user_salary_history: 'branch_id INTEGER REFERENCES branches(id)',
    suppliers: 'branch_id INTEGER REFERENCES branches(id)',
    supplier_ledger: 'branch_id INTEGER REFERENCES branches(id)',
    purchase_orders: 'branch_id INTEGER REFERENCES branches(id)',
    returns: 'branch_id INTEGER REFERENCES branches(id)',
    inventory_movements: 'branch_id INTEGER REFERENCES branches(id)',
    bundles: 'branch_id INTEGER REFERENCES branches(id)',
  };

  for (const [table, definition] of Object.entries(specs)) {
    tryAddColumn(table, definition);
  }

  // Legacy databases were single-branch before multi-branch support existed.
  // Preserve existing values and assign only previously-unowned rows to the current/default branch.
  const fallbackQueries = {
    users: 'UPDATE users SET branch_id=COALESCE(branch_id, ?) WHERE branch_id IS NULL',
    inventory: 'UPDATE inventory SET branch_id=COALESCE(branch_id, ?) WHERE branch_id IS NULL',
    restaurant_tables: 'UPDATE restaurant_tables SET branch_id=COALESCE(branch_id, ?) WHERE branch_id IS NULL',
    tax_profiles: 'UPDATE tax_profiles SET branch_id=COALESCE(branch_id, ?) WHERE branch_id IS NULL',
    customers: 'UPDATE customers SET branch_id=COALESCE(branch_id, ?) WHERE branch_id IS NULL',
    suppliers: 'UPDATE suppliers SET branch_id=COALESCE(branch_id, ?) WHERE branch_id IS NULL',
    shifts: 'UPDATE shifts SET branch_id=COALESCE(branch_id, ?) WHERE branch_id IS NULL',
    sales: 'UPDATE sales SET branch_id=COALESCE(branch_id, ?) WHERE branch_id IS NULL',
    payroll_periods: 'UPDATE payroll_periods SET branch_id=COALESCE(branch_id, ?) WHERE branch_id IS NULL',
    purchase_orders: 'UPDATE purchase_orders SET branch_id=COALESCE(branch_id, ?) WHERE branch_id IS NULL',
    returns: 'UPDATE returns SET branch_id=COALESCE(branch_id, ?) WHERE branch_id IS NULL',
    inventory_movements: 'UPDATE inventory_movements SET branch_id=COALESCE(branch_id, ?) WHERE branch_id IS NULL',
    bundles: 'UPDATE bundles SET branch_id=COALESCE(branch_id, ?) WHERE branch_id IS NULL',
    audit_logs: 'UPDATE audit_logs SET branch_id=COALESCE(branch_id, ?) WHERE branch_id IS NULL',
  };

  for (const query of Object.values(fallbackQueries)) db.prepare(query).run(defaultBranchId);

  // Prefer relationship-derived ownership where possible; fall back to the current branch for legacy single-branch data.
  db.prepare(`UPDATE customer_ledger SET branch_id=COALESCE(branch_id,(SELECT branch_id FROM customers WHERE customers.id=customer_ledger.customer_id),?) WHERE branch_id IS NULL`).run(defaultBranchId);
  db.prepare(`UPDATE supplier_ledger SET branch_id=COALESCE(branch_id,(SELECT branch_id FROM suppliers WHERE suppliers.id=supplier_ledger.supplier_id),?) WHERE branch_id IS NULL`).run(defaultBranchId);
  db.prepare(`UPDATE store_credit_ledger SET branch_id=COALESCE(branch_id,(SELECT branch_id FROM customers WHERE customers.id=store_credit_ledger.customer_id),?) WHERE branch_id IS NULL`).run(defaultBranchId);
  db.prepare(`UPDATE payment_transactions SET branch_id=COALESCE(branch_id,(SELECT branch_id FROM sales WHERE sales.id=payment_transactions.sale_id),(SELECT branch_id FROM returns WHERE returns.id=payment_transactions.return_id),(SELECT branch_id FROM shifts WHERE shifts.id=payment_transactions.shift_id),?) WHERE branch_id IS NULL`).run(defaultBranchId);
  db.prepare(`UPDATE cash_movements SET branch_id=COALESCE(branch_id,(SELECT branch_id FROM shifts WHERE shifts.id=cash_movements.shift_id),?) WHERE branch_id IS NULL`).run(defaultBranchId);
  db.prepare(`UPDATE payroll_adjustments SET branch_id=COALESCE(branch_id,(SELECT branch_id FROM payroll_periods WHERE payroll_periods.id=payroll_adjustments.period_id),?) WHERE branch_id IS NULL`).run(defaultBranchId);
  db.prepare(`UPDATE user_salary_history SET branch_id=COALESCE(branch_id,(SELECT branch_id FROM users WHERE users.id=user_salary_history.user_id),?) WHERE branch_id IS NULL`).run(defaultBranchId);

  const unresolved = [];
  for (const table of Object.keys(specs)) {
    const count = db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE branch_id IS NULL`).get().c;
    if (count) unresolved.push(`${table}:${count}`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_branch_id ON ${table}(branch_id)`);
  }
  if (unresolved.length) {
    throw new Error(`Legacy branch migration incomplete: ${unresolved.join(', ')}`);
  }
}

function runMigrations() {
  const tryAddColumn = (table, columnDef) => {
    const columnName = String(columnDef).trim().split(/\s+/)[0];
    const existing = db.prepare(`PRAGMA table_info(${table})`).all();
    if (existing.some((col) => col.name === columnName)) return false;
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`);
      return true;
    } catch (err) {
      // Only an already-present column is ignorable. Any other migration error
      // must stop startup rather than silently leaving a partially migrated DB.
      const refreshed = db.prepare(`PRAGMA table_info(${table})`).all();
      if (refreshed.some((col) => col.name === columnName)) return false;
      throw new Error(`Migration failed adding ${table}.${columnName}: ${err.message}`);
    }
  };
  // Multi-branch rollout safety: repair every branch_id column before any branch-scoped query runs.
  ensureLegacyBranchColumns(tryAddColumn);
  tryAddColumn('sales', `cash_amount REAL NOT NULL DEFAULT 0`);
  tryAddColumn('sales', `card_amount REAL NOT NULL DEFAULT 0`);
  tryAddColumn('sales', `change_due REAL NOT NULL DEFAULT 0`);
  tryAddColumn('inventory_movements', `notes TEXT`);
  const inventoryUnitCostAdded = tryAddColumn('inventory', `unit_cost REAL NOT NULL DEFAULT 0`);
  if (inventoryUnitCostAdded) db.prepare(`UPDATE inventory SET unit_cost = COALESCE((SELECT cost FROM products WHERE products.id = inventory.product_id), 0)`).run();
  // ترقيات: الورديات، الدليفري، الخصومات على مستوى الفاتورة، المرتجعات
  tryAddColumn('sales', `shift_id INTEGER REFERENCES shifts(id)`);
  tryAddColumn('sales', `order_type TEXT NOT NULL DEFAULT 'in_store'`);
  tryAddColumn('users', `is_payroll_only INTEGER NOT NULL DEFAULT 0`);
  tryAddColumn('users', `job_title TEXT NOT NULL DEFAULT ''`);
  tryAddColumn('users', `pay_type TEXT NOT NULL DEFAULT 'monthly'`);
  tryAddColumn('users', `pay_rate REAL NOT NULL DEFAULT 0`);
  tryAddColumn('payroll_items', `regular_hours REAL NOT NULL DEFAULT 0`);
  tryAddColumn('payroll_items', `pay_type TEXT NOT NULL DEFAULT 'monthly'`);
  tryAddColumn('payroll_items', `pay_rate REAL NOT NULL DEFAULT 0`);
  tryAddColumn('sales', `delivery_fee REAL NOT NULL DEFAULT 0`);
  tryAddColumn('sales', `delivery_person TEXT`);
  // ملاحظة عامة على مستوى الفاتورة كلها (مش على صنف واحد بعينه) — مثلاً "اترك الطلب
  // عند الباب"، "من غير أكياس بلاستيك". تُطبع بشكل بارز أعلى تذكرة المطبخ والفاتورة.
  tryAddColumn('sales', `notes TEXT`);
  // وقت التسليم المطلوب لطلبات التوصيل: NULL = الآن (فوري). غير ذلك = وقت محدد
  // بصيغة ISO يختاره الكاشير بناءً على طلب الزبون.
  tryAddColumn('sales', `delivery_time TEXT`);
  // اسم الزبون المكتوب يدوياً على شاشة الكاشير (بدون الحاجة لتسجيله كعميل ولاء).
  tryAddColumn('sales', `customer_name_manual TEXT`);
  tryAddColumn('sales', `discount_type TEXT`);
  tryAddColumn('sales', `discount_value REAL DEFAULT 0`);
  tryAddColumn('sales', `discount_approved_by INTEGER REFERENCES users(id)`);
  tryAddColumn('sales', `bundle_discount_total REAL NOT NULL DEFAULT 0`);
  tryAddColumn('customers', `balance REAL NOT NULL DEFAULT 0`);
  tryAddColumn('sales', `due_amount REAL NOT NULL DEFAULT 0`);
  tryAddColumn('sales', `exchange_rate REAL NOT NULL DEFAULT 1`);
  tryAddColumn('sales', `invoice_number TEXT`);
  tryAddColumn('sale_items', `cost_at_sale REAL NOT NULL DEFAULT 0`);
  tryAddColumn('payroll_periods', `payment_reference TEXT`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_invoice_number ON sales(invoice_number) WHERE invoice_number IS NOT NULL`);
  tryAddColumn('sales', `payment_reference TEXT`);
  tryAddColumn('sales', `payment_provider TEXT`);
  tryAddColumn('sales', `payment_currency TEXT`);
  tryAddColumn('sales', `loyalty_points_awarded REAL NOT NULL DEFAULT 0`);
  tryAddColumn('sales', `loyalty_points_reversed REAL NOT NULL DEFAULT 0`);
  tryAddColumn('sales', `inventory_committed INTEGER NOT NULL DEFAULT 0`);
  tryAddColumn('sale_items', `tax_profile_id INTEGER REFERENCES tax_profiles(id)`);
  tryAddColumn('sale_items', `tax_inclusive INTEGER NOT NULL DEFAULT 0`);
  // كمية كل بند التي وصلت فعلاً للمطبخ (لمنع تكرار تذكرة المطبخ عند كل حفظ للطلب)
  tryAddColumn('sale_items', `kitchen_sent_qty REAL NOT NULL DEFAULT 0`);
  // تفويض تعديل الفواتير للكاشير: علامة من المدير العام مع السبب ومن منحها ومتى.
  tryAddColumn('users', `can_modify_sales INTEGER NOT NULL DEFAULT 0`);
  tryAddColumn('users', `modify_sales_granted_by INTEGER`);
  tryAddColumn('users', `modify_sales_granted_at TEXT`);
  tryAddColumn('users', `modify_sales_reason TEXT`);
  // ترقية بيانات العملاء: رصيد متجر مستقل عن الدين، وسجل كشف حساب قابل للمزامنة event-by-event.
  tryAddColumn('customers', `store_credit_balance REAL NOT NULL DEFAULT 0`);
  tryAddColumn('customer_ledger', `uuid TEXT`);
  tryAddColumn('customer_ledger', `branch_id INTEGER`);
  tryAddColumn('customer_ledger', `synced INTEGER NOT NULL DEFAULT 0`);
  tryAddColumn('supplier_ledger', `uuid TEXT`);
  tryAddColumn('supplier_ledger', `branch_id INTEGER`);
  tryAddColumn('supplier_ledger', `synced INTEGER NOT NULL DEFAULT 0`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_supplier_ledger_branch ON supplier_ledger(branch_id)`);
  tryAddColumn('inventory_movements', `uuid TEXT`);
  tryAddColumn('inventory_movements', `synced INTEGER NOT NULL DEFAULT 0`);
  tryAddColumn('shifts', `synced INTEGER NOT NULL DEFAULT 0`);
  // Give legacy movement rows stable sync identities exactly once.
  db.prepare(`UPDATE supplier_ledger SET uuid=COALESCE(uuid, lower(hex(randomblob(16)))) WHERE uuid IS NULL OR uuid=''`).run();
  db.prepare(`UPDATE inventory_movements SET uuid=COALESCE(uuid, lower(hex(randomblob(16)))) WHERE uuid IS NULL OR uuid=''`).run();
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_supplier_ledger_uuid ON supplier_ledger(uuid);`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_movements_uuid ON inventory_movements(uuid);`);
  const legacyLedger = db.prepare(`SELECT id, customer_id, sale_id FROM customer_ledger WHERE uuid IS NULL OR uuid=''`).all();
  const setLedgerUuid = db.prepare(`UPDATE customer_ledger SET uuid=?, branch_id=COALESCE(branch_id, ?), synced=0 WHERE id=?`);
  for (const row of legacyLedger) {
    const branchId = row.sale_id ? (db.prepare('SELECT branch_id FROM sales WHERE id=?').get(row.sale_id)?.branch_id || getCurrentBranch().id) : getCurrentBranch().id;
    setLedgerUuid.run(uuid(), branchId, row.id);
  }
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_ledger_uuid_unique ON customer_ledger(uuid) WHERE uuid IS NOT NULL`);

  // Store Credit ledger: migrate the legacy balance into a single opening event, then use event deltas for all future changes.
  db.exec(`CREATE TABLE IF NOT EXISTS store_credit_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT UNIQUE NOT NULL, branch_id INTEGER NOT NULL REFERENCES branches(id),
    customer_id INTEGER NOT NULL REFERENCES customers(id), sale_id INTEGER REFERENCES sales(id), return_id INTEGER REFERENCES returns(id),
    entry_type TEXT NOT NULL CHECK(entry_type IN ('opening','sale_spend','return_credit','adjustment')), amount REAL NOT NULL,
    created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL DEFAULT (datetime('now')), synced INTEGER NOT NULL DEFAULT 0
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_store_credit_ledger_customer ON store_credit_ledger(branch_id, customer_id, created_at)`);
  db.prepare(`INSERT INTO store_credit_ledger(uuid,branch_id,customer_id,entry_type,amount,created_at,synced)
    SELECT lower(hex(randomblob(16))),branch_id,id,'opening',COALESCE(store_credit_balance,0),COALESCE(updated_at,datetime('now')),0
    FROM customers c
    WHERE COALESCE(store_credit_balance,0)<>0
      AND NOT EXISTS (SELECT 1 FROM store_credit_ledger l WHERE l.customer_id=c.id AND l.branch_id=c.branch_id AND l.entry_type='opening')`).run();

  db.exec(`CREATE TABLE IF NOT EXISTS organization_profile (
    id INTEGER PRIMARY KEY CHECK (id=1), country_code TEXT NOT NULL DEFAULT 'TR', locale TEXT NOT NULL DEFAULT 'ar',
    timezone TEXT NOT NULL DEFAULT 'Europe/Istanbul', currency_code TEXT NOT NULL DEFAULT 'TRY', currency_minor_unit INTEGER NOT NULL DEFAULT 2,
    tax_mode TEXT NOT NULL DEFAULT 'exclusive', tax_registration_number TEXT, fiscalization_mode TEXT NOT NULL DEFAULT 'none',
    fiscal_provider TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );`);
  db.exec(`INSERT OR IGNORE INTO organization_profile (id) VALUES (1);`);
  db.exec(`CREATE TABLE IF NOT EXISTS tax_profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT UNIQUE NOT NULL, branch_id INTEGER NOT NULL REFERENCES branches(id),
    code TEXT NOT NULL, name TEXT NOT NULL, rate REAL NOT NULL DEFAULT 0, tax_category TEXT, country_code TEXT,
    is_inclusive INTEGER NOT NULL DEFAULT 0, is_active INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    synced INTEGER NOT NULL DEFAULT 0, UNIQUE(branch_id, code)
  );`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tax_profiles_branch_active ON tax_profiles(branch_id, is_active);`);
  tryAddColumn('products', `tax_profile_id INTEGER REFERENCES tax_profiles(id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_products_tax_profile ON products(tax_profile_id);`);
  db.exec(`CREATE TABLE IF NOT EXISTS payment_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT UNIQUE NOT NULL, branch_id INTEGER NOT NULL REFERENCES branches(id),
    sale_id INTEGER REFERENCES sales(id), return_id INTEGER REFERENCES returns(id), shift_id INTEGER REFERENCES shifts(id),
    method TEXT NOT NULL, currency_code TEXT NOT NULL, amount REAL NOT NULL, exchange_rate REAL NOT NULL DEFAULT 1,
    provider TEXT, provider_reference TEXT, external_id TEXT, masked_descriptor TEXT, created_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')), synced INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_payment_transactions_branch_date ON payment_transactions(branch_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_payment_transactions_sale ON payment_transactions(sale_id);`);
  db.exec(`CREATE TABLE IF NOT EXISTS cash_movements (
    id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT UNIQUE NOT NULL, branch_id INTEGER NOT NULL REFERENCES branches(id),
    shift_id INTEGER NOT NULL REFERENCES shifts(id), type TEXT NOT NULL, amount REAL NOT NULL, reason TEXT NOT NULL, reference TEXT,
    created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL DEFAULT (datetime('now')), synced INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_cash_movements_shift ON cash_movements(shift_id, created_at);`);
  // فهارس تُسرّع تقارير المبيعات مع نمو حجم البيانات (بحث/تجميع حسب التاريخ والمنتج)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sales_created_at ON sales(created_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sale_items_product_id ON sale_items(product_id)`);
  // فهارس المزامنة (sync): كانت هذه الأعمدة (synced) بلا أي فهرس على أي جدول،
  // فكل دورة مزامنة (كل 5 ثوانٍ لجهاز "طرفية" LAN!) كانت تفحص الجدول كاملاً
  // سطراً سطراً في 18 استعلاماً مختلفاً - وهذا الفحص يعمل بشكل متزامن (synchronous)
  // على خيط العملية الرئيسية الوحيد في Electron، فيُجمّد التطبيق بأكمله (كل
  // النوافذ، كل حقول الإدخال) لحظياً في كل دورة، وتزداد المدة كلما كبرت
  // قاعدة البيانات مع الوقت. هذا كان على الأغلب السبب الرئيسي للتجمد المتكرر
  // "في أوقات عشوائية" الذي أبلغ عنه المستخدم.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_categories_synced ON categories(synced)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_products_synced ON products(synced)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_customers_branch_synced ON customers(branch_id, synced)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_customer_ledger_branch_synced ON customer_ledger(branch_id, synced)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_store_credit_ledger_branch_synced ON store_credit_ledger(branch_id, synced)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_inventory_branch_synced ON inventory(branch_id, synced)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sales_branch_synced ON sales(branch_id, synced)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_payment_transactions_branch_synced ON payment_transactions(branch_id, synced)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_cash_movements_branch_synced ON cash_movements(branch_id, synced)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_shifts_branch_synced ON shifts(branch_id, synced)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_inventory_movements_branch_synced ON inventory_movements(branch_id, synced)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_suppliers_branch_synced ON suppliers(branch_id, synced)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_supplier_ledger_branch_synced ON supplier_ledger(branch_id, synced)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_purchase_orders_branch_synced ON purchase_orders(branch_id, synced)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_returns_branch_synced ON returns(branch_id, synced)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_restaurant_tables_branch_synced ON restaurant_tables(branch_id, synced)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_bundles_branch_synced ON bundles(branch_id, synced)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tax_profiles_branch_synced ON tax_profiles(branch_id, synced)`);
  tryAddColumn('users', `must_change_password INTEGER NOT NULL DEFAULT 0`);
  // بيع بالوزن (خضار/فواكه): كود PLU + علامة "بيع بالوزن" لكل منتج
  tryAddColumn('products', `is_weighted INTEGER NOT NULL DEFAULT 0`);
  tryAddColumn('products', `plu_code TEXT`);
  // إظهار المنتج على شاشة "الكاشير السريع" (شبكة الصور باللمس فقط) — اختياري ومطفأ
  // افتراضياً لكل منتج، حتى يختار صاحب المحل بنفسه أصنافاً معدودة تظهر هناك (مثل
  // الأكياس/الخبز التي لا باركود لها) بدل أن تظهر كل المنتجات مكدّسة فوق بعضها.
  tryAddColumn('products', `quick_cashier_visible INTEGER NOT NULL DEFAULT 0`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_products_plu_code ON products(plu_code) WHERE plu_code IS NOT NULL`);
  // ترقية لمرة واحدة: كود PLU يجب أن يكون دائماً 5 خانات بأصفار بادئة (نفس صيغة الباركود
  // المطبوع من الميزان). منتجات أُنشئت قبل هذا الإصلاح قد يكون PLU إلها مُدخلاً بدون أصفار
  // بادئة (مثلاً "123" بدل "00123")، فيفشل مسح الباركود من الميزان عليها دون أي رسالة خطأ
  // واضحة. نطبّعها هنا تلقائياً مرة واحدة لكل صف قديم غير مطابق للصيغة الصحيحة بالفعل.
  const unpaddedPlu = db.prepare(`SELECT id, plu_code FROM products WHERE plu_code IS NOT NULL AND plu_code != '' AND plu_code GLOB '[0-9]*' AND length(plu_code) < 5`).all();
  if (unpaddedPlu.length) {
    const updatePlu = db.prepare(`UPDATE products SET plu_code = ? WHERE id = ?`);
    const tx = db.transaction(() => {
      for (const row of unpaddedPlu) {
        const padded = String(row.plu_code).padStart(5, '0');
        const clash = db.prepare('SELECT id FROM products WHERE plu_code = ? AND id != ?').get(padded, row.id);
        if (clash) continue; // نادر جداً؛ نتجنب فقط أي تعارض بدل تعطيل الترقية بالكامل
        updatePlu.run(padded, row.id);
      }
    });
    tx();
  }
  tryAddColumn('users', `pin_hash TEXT`);
  db.exec(`CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, branch_id INTEGER REFERENCES branches(id), user_id INTEGER REFERENCES users(id),
    action TEXT NOT NULL, entity_type TEXT, entity_id TEXT, details TEXT, level TEXT NOT NULL DEFAULT 'info',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at DESC)`);
  // توسعة المزامنة بين الفروع لتشمل الموردين وفواتير الشراء والمرتجعات والحزم
  tryAddColumn('suppliers', `synced INTEGER NOT NULL DEFAULT 0`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_customers_branch_name ON customers(branch_id, name)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_customers_branch_phone ON customers(branch_id, phone)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_suppliers_branch_name ON suppliers(branch_id, name)');
  tryAddColumn('purchase_orders', `synced INTEGER NOT NULL DEFAULT 0`);
  tryAddColumn('purchase_orders', `updated_at TEXT NOT NULL DEFAULT (datetime('now'))`);
  tryAddColumn('purchase_orders', `payment_method TEXT NOT NULL DEFAULT 'credit'`);
  // فواتير المصروفات التشغيلية (بلا بضاعة): نفس جدول فواتير الموردين مع نوع الفاتورة وفئة المصروف.
  tryAddColumn('purchase_orders', `invoice_type TEXT NOT NULL DEFAULT 'goods'`);
  tryAddColumn('purchase_orders', `expense_category_id INTEGER`);
  tryAddColumn('purchase_orders', `expense_category_name TEXT`);
  tryAddColumn('purchase_orders', `invoice_date TEXT`);
  tryAddColumn('purchase_orders', `reference_number TEXT`);
  tryAddColumn('returns', `synced INTEGER NOT NULL DEFAULT 0`);
  tryAddColumn('returns', `client_request_id TEXT`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_returns_branch_client_request ON returns(branch_id, client_request_id) WHERE client_request_id IS NOT NULL AND client_request_id <> ''`);
  // Legacy compatibility: hourly_rate — يُستخدم الآن فعلياً كأجر الساعة الذي يسجّله المدير
  // لكل موظف (يُستخدم في احتساب الساعات الإضافية بدل اشتقاقه من الراتب الشهري).
  tryAddColumn('users', `hourly_rate REAL NOT NULL DEFAULT 0`);
  tryAddColumn('users', `monthly_salary REAL NOT NULL DEFAULT 0`);
  tryAddColumn('sales', `client_request_id TEXT`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_branch_client_request ON sales(branch_id, client_request_id) WHERE client_request_id IS NOT NULL AND client_request_id <> ''`);
  tryAddColumn('sale_items', `uuid TEXT`);
  db.exec(`UPDATE sale_items SET uuid = lower(hex(randomblob(16))) WHERE uuid IS NULL OR uuid = ''`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_sale_items_uuid ON sale_items(uuid)`);
  tryAddColumn('restaurant_tables', `uuid TEXT`);
  db.exec(`UPDATE restaurant_tables SET uuid = lower(hex(randomblob(16))) WHERE uuid IS NULL OR uuid = ''`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_restaurant_tables_uuid ON restaurant_tables(uuid)`);
  tryAddColumn('restaurant_tables', `updated_at TEXT NOT NULL DEFAULT (datetime('now'))`);
  tryAddColumn('restaurant_tables', `synced INTEGER NOT NULL DEFAULT 0`);
  tryAddColumn('inventory_movements', `unit_cost_after REAL`);
  db.exec(`CREATE TABLE IF NOT EXISTS user_salary_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT UNIQUE NOT NULL, branch_id INTEGER NOT NULL REFERENCES branches(id),
    user_id INTEGER NOT NULL REFERENCES users(id), monthly_salary REAL NOT NULL, effective_from TEXT NOT NULL,
    changed_by INTEGER REFERENCES users(id), reason TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_salary_history_user_effective ON user_salary_history(user_id, effective_from DESC)`);
  // Backfill an initial salary record once for pre-existing employees.
  db.prepare(`INSERT INTO user_salary_history(uuid,branch_id,user_id,monthly_salary,effective_from,reason)
    SELECT lower(hex(randomblob(16))),branch_id,id,monthly_salary,created_at,'رصيد افتتاحي من الراتب الحالي' FROM users u
    WHERE NOT EXISTS (SELECT 1 FROM user_salary_history h WHERE h.user_id=u.id)`).run();
  db.exec(`CREATE TABLE IF NOT EXISTS payroll_periods (
    id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT UNIQUE NOT NULL, branch_id INTEGER NOT NULL REFERENCES branches(id),
    period_start TEXT NOT NULL, period_end TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft',
    created_by INTEGER REFERENCES users(id), approved_by INTEGER REFERENCES users(id), paid_by INTEGER REFERENCES users(id),
    approved_at TEXT, paid_at TEXT, notes TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(branch_id, period_start, period_end)
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_payroll_periods_branch_dates ON payroll_periods(branch_id, period_start, period_end)`);
  db.exec(`CREATE TABLE IF NOT EXISTS payroll_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT, period_id INTEGER NOT NULL REFERENCES payroll_periods(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id), base_salary REAL NOT NULL DEFAULT 0, bonus_total REAL NOT NULL DEFAULT 0,
    deduction_total REAL NOT NULL DEFAULT 0, advance_total REAL NOT NULL DEFAULT 0, net_salary REAL NOT NULL DEFAULT 0,
    notes TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(period_id, user_id)
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_payroll_items_period ON payroll_items(period_id)`);
  db.exec(`CREATE TABLE IF NOT EXISTS payroll_adjustments (
    id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT UNIQUE NOT NULL, branch_id INTEGER NOT NULL REFERENCES branches(id),
    period_id INTEGER NOT NULL REFERENCES payroll_periods(id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES users(id),
    type TEXT NOT NULL CHECK(type IN ('bonus','deduction','advance')), amount REAL NOT NULL CHECK(amount > 0),
    reason TEXT NOT NULL, created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_payroll_adjustments_period_user ON payroll_adjustments(period_id, user_id)`);
  tryAddColumn('payroll_periods', `payment_method TEXT`);
  tryAddColumn('payroll_periods', `payment_reference TEXT`);
  tryAddColumn('users', `shift_type TEXT NOT NULL DEFAULT 'morning'`);
  tryAddColumn('payroll_items', `absence_days REAL NOT NULL DEFAULT 0`);
  tryAddColumn('payroll_items', `days_worked REAL NOT NULL DEFAULT 30`);
  tryAddColumn('payroll_items', `overtime_hours REAL NOT NULL DEFAULT 0`);
  tryAddColumn('payroll_items', `overtime_amount REAL NOT NULL DEFAULT 0`);
  tryAddColumn('payroll_items', `absence_deduction REAL NOT NULL DEFAULT 0`);
  // سجل غياب دقيق بالتاريخ (يوم بيوم) لكل موظف بكل دورة راتب — يُستخدم لحساب خصم الغياب
  // تلقائياً بدل إدخال "عدد أيام العمل" كرقم مجرّد، حتى يظهر بوضوح أي يوم بالتحديد غاب فيه.
  db.exec(`CREATE TABLE IF NOT EXISTS payroll_absences (
    id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT UNIQUE NOT NULL, branch_id INTEGER NOT NULL REFERENCES branches(id),
    period_id INTEGER NOT NULL REFERENCES payroll_periods(id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES users(id),
    absence_date TEXT NOT NULL, reason TEXT, created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(period_id, user_id, absence_date)
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_payroll_absences_period_user ON payroll_absences(period_id, user_id)`);

  // Payroll v2: العامل في الرواتب كيان مستقل تماماً عن حسابات الدخول.
  db.exec(`CREATE TABLE IF NOT EXISTS payroll_employees (
    id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT UNIQUE NOT NULL,
    branch_id INTEGER NOT NULL REFERENCES branches(id), full_name TEXT NOT NULL, job_title TEXT NOT NULL,
    pay_type TEXT NOT NULL DEFAULT 'monthly' CHECK(pay_type IN ('monthly','daily','hourly')),
    pay_rate REAL NOT NULL DEFAULT 0 CHECK(pay_rate >= 0), is_active INTEGER NOT NULL DEFAULT 1,
    legacy_user_id INTEGER REFERENCES users(id), created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(branch_id, legacy_user_id)
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_payroll_employees_branch_active ON payroll_employees(branch_id, is_active, full_name)`);
  db.exec(`CREATE TABLE IF NOT EXISTS payroll_months (
    id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT UNIQUE NOT NULL, branch_id INTEGER NOT NULL REFERENCES branches(id),
    month_key TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(branch_id, month_key)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS payroll_employee_months (
    id INTEGER PRIMARY KEY AUTOINCREMENT, month_id INTEGER NOT NULL REFERENCES payroll_months(id) ON DELETE CASCADE,
    employee_id INTEGER NOT NULL REFERENCES payroll_employees(id), pay_type TEXT NOT NULL, pay_rate REAL NOT NULL DEFAULT 0,
    base_amount REAL NOT NULL DEFAULT 0, regular_hours REAL NOT NULL DEFAULT 0, absence_days REAL NOT NULL DEFAULT 0,
    absence_deduction REAL NOT NULL DEFAULT 0, bonus_total REAL NOT NULL DEFAULT 0, deduction_total REAL NOT NULL DEFAULT 0,
    advance_total REAL NOT NULL DEFAULT 0, overtime_total REAL NOT NULL DEFAULT 0, net_salary REAL NOT NULL DEFAULT 0,
    start_date TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(month_id, employee_id)
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_payroll_employee_months_month ON payroll_employee_months(month_id)`);
  // تاريخ بدء العامل ضمن هذا الشهر تحديداً (قد يختلف عن أول الشهر إذا التحق العامل
  // متأخراً). يُستخدم لحساب الراتب المستحق تلقائياً يوماً بيوم بدل احتساب الشهر كاملاً
  // من أول يوم — راجع daysElapsedInPayrollPeriod() و recalcPayrollEmployeeMonth().
  tryAddColumn('payroll_employee_months', `start_date TEXT`);
  db.exec(`CREATE TABLE IF NOT EXISTS payroll_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT UNIQUE NOT NULL, branch_id INTEGER NOT NULL REFERENCES branches(id),
    month_id INTEGER NOT NULL REFERENCES payroll_months(id) ON DELETE CASCADE, employee_id INTEGER NOT NULL REFERENCES payroll_employees(id),
    type TEXT NOT NULL CHECK(type IN ('absence','advance','bonus','deduction','overtime')), amount REAL NOT NULL DEFAULT 0 CHECK(amount >= 0),
    quantity REAL NOT NULL DEFAULT 1 CHECK(quantity >= 0), event_date TEXT NOT NULL, reason TEXT, created_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_payroll_transactions_month_employee ON payroll_transactions(month_id, employee_id, event_date, id)`);
  // ترقية: أُضيف نوع الحركة 'hours' (تسجيل ساعات عمل يومية للعاملين بالساعة) بعد إنشاء
  // الجدول أصلاً بقيد CHECK لا يسمح به. SQLite لا يدعم تعديل CHECK مباشرة، فنعيد بناء
  // الجدول بقيد جديد إن وجدنا القيد القديم فقط (مرة واحدة، بشكل آمن ومتوافق مع البيانات).
  const txTypeCheckSql = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='payroll_transactions'`).get()?.sql || '';
  if (txTypeCheckSql && !/'hours'/.test(txTypeCheckSql)) {
    db.exec(`
      CREATE TABLE payroll_transactions_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT UNIQUE NOT NULL, branch_id INTEGER NOT NULL REFERENCES branches(id),
        month_id INTEGER NOT NULL REFERENCES payroll_months(id) ON DELETE CASCADE, employee_id INTEGER NOT NULL REFERENCES payroll_employees(id),
        type TEXT NOT NULL CHECK(type IN ('absence','advance','bonus','deduction','overtime','hours')), amount REAL NOT NULL DEFAULT 0 CHECK(amount >= 0),
        quantity REAL NOT NULL DEFAULT 1 CHECK(quantity >= 0), event_date TEXT NOT NULL, reason TEXT, created_by INTEGER REFERENCES users(id),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO payroll_transactions_new SELECT * FROM payroll_transactions;
      DROP TABLE payroll_transactions;
      ALTER TABLE payroll_transactions_new RENAME TO payroll_transactions;
      CREATE INDEX IF NOT EXISTS idx_payroll_transactions_month_employee ON payroll_transactions(month_id, employee_id, event_date, id);
    `);
  }
  // يربط سلفة الموظف (لو اتدفعت كاش من الصندوق وقت تسجيلها) بحركة النقد المقابلة في
  // cash_movements، حتى تنعكس فعلياً على رصيد الصندوق والتقارير المالية بدل ما تفضل
  // معزولة جوه شاشة الرواتب بس. NULL لو السلفة اتسجلت كقيد رواتب فقط بدون صرف فوري.
  tryAddColumn('payroll_transactions', `cash_movement_id INTEGER REFERENCES cash_movements(id)`);
  // استبدال نقاط الولاء: عميل يدفع جزءاً من الفاتورة بنقاطه بدل نقود. نخزّن عدد
  // النقاط المستبدَلة وقيمتها النقدية باللحظة (بسعر التحويل وقتها، حتى لو تغيّر
  // السعر لاحقاً بالإعدادات لا يتأثر تاريخ الفواتير القديمة). loyalty_points_restored
  // يتتبّع كم نقطة أُعيدت للعميل بسبب مرتجعات جزئية/كاملة لاحقة على نفس الفاتورة —
  // نفس فكرة loyalty_points_reversed تماماً لكن بالاتجاه المعاكس (نقاط استُردّت
  // مش نقاط اتلغت) لمنع أي ازدواج عند مرتجعات متعددة على نفس الفاتورة.
  tryAddColumn('sales', `loyalty_points_redeemed REAL NOT NULL DEFAULT 0`);
  tryAddColumn('sales', `loyalty_points_restored REAL NOT NULL DEFAULT 0`);
  tryAddColumn('sales', `loyalty_redeemed_value REAL NOT NULL DEFAULT 0`);
  tryAddColumn('sales', `loyalty_redeemed_value_minor INTEGER NOT NULL DEFAULT 0`);
  // صورة الفئة: لعرض تبويبات بصرية بشاشة الكاشير (مثال: صورة شاورما، صورة مشروبات...)
  tryAddColumn('categories', `image_path TEXT`);
  tryAddColumn('categories', `sort_order INTEGER NOT NULL DEFAULT 0`);
  // إخفاء/إظهار تبويب الفئة من شاشة الكاشير دون حذف الفئة أو منتجاتها — تبقى
  // منتجاتها ظاهرة تحت "الكل"، فقط تبويبها السريع يختفي من الشريط.
  tryAddColumn('categories', `pos_hidden INTEGER NOT NULL DEFAULT 0`);
  // "طلب الحساب" من جهاز الكرسون: علامة زمنية فقط (متى طُلب) — لا تمنع أي تعديل
  // على الطلب، ومجرد تنبيه بصري لشاشة الطاولات عند الكاشير الرئيسي.
  tryAddColumn('sales', `bill_requested_at DATETIME`);

  // Migrate existing payroll-only workers once. Their login account remains legacy data for compatibility,
  // but all new payroll operations use payroll_employees and never create a users row.
  const legacyPayrollWorkers = db.prepare(`SELECT id,branch_id,full_name,job_title,pay_type,pay_rate,monthly_salary,hourly_rate,is_active FROM users WHERE is_payroll_only=1`).all();
  const insertPayrollEmployee = db.prepare(`INSERT OR IGNORE INTO payroll_employees(uuid,branch_id,full_name,job_title,pay_type,pay_rate,is_active,legacy_user_id) VALUES(?,?,?,?,?,?,?,?)`);
  for (const u of legacyPayrollWorkers) {
    const type = ['monthly','daily','hourly'].includes(u.pay_type) ? u.pay_type : 'monthly';
    const rate = Number(u.pay_rate || (type === 'monthly' ? u.monthly_salary : type === 'hourly' ? u.hourly_rate : 0) || 0);
    insertPayrollEmployee.run(uuid(), u.branch_id, String(u.full_name || 'عامل'), String(u.job_title || 'أخرى'), type, Math.max(0, Math.round(rate * 100) / 100), Number(u.is_active || 0), u.id);
  }
  // تحديث أمني لأول ترقية: أي مدير موجود من نسخة قديمة يُطلب منه تغيير كلمة المرور مرة واحدة.
  // لا نعتمد على معرفة كلمة المرور القديمة ولا نخزن أي كلمة افتراضية صريحة داخل الكود.
  if (getSetting('legacy_admin_passwords_reviewed', '0') !== '1') {
    db.prepare(`UPDATE users SET must_change_password = 1 WHERE role = 'admin' AND is_active = 1`).run();
    setSetting('legacy_admin_passwords_reviewed', '1');
  }
}

function logAudit(payload) {
  return auditMod.logAudit(db, getCurrentBranch, payload);
}

function listAuditLogs(limit = 500) {
  return auditMod.listAuditLogs(db, getCurrentBranch, limit);
}

function uuid() {
  return crypto.randomUUID();
}

// عند أول تشغيل: ننشئ فرعاً افتراضياً واحداً حتى يعمل التطبيق فوراً
function seedDefaultBranchIfEmpty() {
  return branchesMod.seedDefaultBranchIfEmpty(db, uuid);
}

/* ---------------- المصادقة وإدارة المستخدمين (database/users.js) ---------------- */
function sanitizeUser(u) { return usersMod.sanitizeUser(u); }
function authenticate(username, password) { return usersMod.authenticate(db, getCurrentBranch, username, password); }
function authenticateByPin(pin) { return usersMod.authenticateByPin(db, getCurrentBranch, pin); }
function authenticateManagerByPin(pin) { return usersMod.authenticateManagerByPin(db, getCurrentBranch, pin); }
function setUserPin(userId, pin) { return usersMod.setUserPin(db, getCurrentBranch, userId, pin); }
function clearUserPin(userId) { return usersMod.clearUserPin(db, getCurrentBranch, userId); }
function listUsers() { return usersMod.listUsers(db, getCurrentBranch); }
function setUserShiftType(userId, shiftType) { return usersMod.setUserShiftType(db, getCurrentBranch, userId, shiftType); }
function setUserSalesModify(userId, enabled, grantedBy, reason) { return usersMod.setUserSalesModify(db, getCurrentBranch, userId, enabled, grantedBy, reason); }
function userCanModifySales(userId) { return usersMod.userCanModifySales(db, getCurrentBranch, userId); }
function getUser(id) { return usersMod.getUser(db, getCurrentBranch, id); }
function createUser(u) { return usersMod.createUser(db, getCurrentBranch, uuid, u); }
function countActiveAdmins(branchId, excludeUserId) { return usersMod.countActiveAdmins(db, branchId, excludeUserId); }
function updateUser(u) { return usersMod.updateUser(db, getCurrentBranch, u); }
function deleteUser(userId, currentUserId) { return usersMod.deleteUser(db, getCurrentBranch, userId, currentUserId); }
function resetUserPassword(username, newPassword) { return usersMod.resetUserPassword(db, getCurrentBranch, username, newPassword); }
function changeOwnPassword(userId, currentPassword, newPassword) { return usersMod.changeOwnPassword(db, getCurrentBranch, userId, currentPassword, newPassword); }

/* ---------------- الفروع ---------------- */
function listBranches() { return branchesMod.listBranches(db); }
function getCurrentBranch() { return branchesMod.getCurrentBranch(db); }
function updateBranch(b) { return branchesMod.updateBranch(db, b); }

// يجعل هوية الفرع بهذا الجهاز (uuid/الاسم/نوع النشاط) مطابقة تماماً لفرع جهاز آخر — تُستخدم عند
// اقتران جهاز طرفية بجهاز رئيسي بنفس المحل، حتى تندمج بيانات الاثنين (مخزون، مبيعات، تقارير)
// تحت نفس هوية الفرع بدل أن يبقى كل جهاز "فرعاً" منفصلاً بتقاريره الخاصة.
function adoptSharedBranch({ uuid: sharedUuid, name, businessType }) {
  const branch = getCurrentBranch();
  db.prepare(`UPDATE branches SET uuid = ?, name = ?, business_type = ? WHERE id = ?`).run(
    sharedUuid,
    name || branch.name,
    businessType || branch.business_type,
    branch.id
  );
  return { success: true };
}



function getSetting(key, fallback = null) { return settingsMod.getSetting(db, key, fallback); }
function setSetting(key, value) { return settingsMod.setSetting(db, key, value); }
function getMaxCashierDiscountPercent() { return settingsMod.getMaxCashierDiscountPercent(db); }

/* ==========================================================================
   نطاقات الأعمال (database/domains/*) — دفعات التفكيك 3–5
   ========================================================================== */
const _domainHelpers = {
  get db() { return db; },
  get dbPath() { return dbPath; },
  get userDataPath() { return userDataPath; },
  get keyPath() { return keyPath; },
  get encryptionKey() { return encryptionKey; },
  CURRENT_SCHEMA_VERSION,
  Database,
  applyDatabaseKey,
  parseWeightedBarcode,
  buildWeightedBarcode,
  parseGs1,
  MAX_LINE_QUANTITY,
  money,
  accounting,
  crypto,
  path,
  fs,
  app,
  getCurrentBranch: (...a) => getCurrentBranch(...a),
  uuid: (...a) => uuid(...a),
  logAudit: (...a) => logAudit(...a),
  listAuditLogs: (...a) => listAuditLogs(...a),
  roundMoney: (...a) => roundMoney(...a),
  getSetting: (...a) => getSetting(...a),
  setSetting: (...a) => setSetting(...a),
  getMaxCashierDiscountPercent: (...a) => getMaxCashierDiscountPercent(...a),
  hashPassword: (...a) => hashPassword(...a),
  verifyPassword: (...a) => verifyPassword(...a),
  checkAuthRateLimit: (...a) => checkAuthRateLimit(...a),
  recordAuthFailure: (...a) => recordAuthFailure(...a),
  clearAuthFailures: (...a) => clearAuthFailures(...a),
  sanitizeUser: (...a) => sanitizeUser(...a),
};

const _domains = {
  catalog: require('./domains/catalog')(_domainHelpers),
  sales: require('./domains/sales')(_domainHelpers),
  inventory: require('./domains/inventory')(_domainHelpers),
  reports: require('./domains/reports')(_domainHelpers),
  customers: require('./domains/customers')(_domainHelpers),
  purchasing: require('./domains/purchasing')(_domainHelpers),
  tables: require('./domains/tables')(_domainHelpers),
  payments: require('./domains/payments')(_domainHelpers),
  profile: require('./domains/profile')(_domainHelpers),
  shifts: require('./domains/shifts')(_domainHelpers),
  payroll: require('./domains/payroll')(_domainHelpers),
  returns: require('./domains/returns')(_domainHelpers),
  delivery: require('./domains/delivery')(_domainHelpers),
  export_sync: require('./domains/export_sync')(_domainHelpers),
  accounting: require('./domains/accounting')(_domainHelpers),
  backup: require('./domains/backup')(_domainHelpers),
};

// ربط كل دوال النطاقات على المساعدات للسماح بالنداء المتبادل بين النطاقات
for (const _d of Object.values(_domains)) {
  for (const [_k, _v] of Object.entries(_d)) {
    if (typeof _v === 'function') _domainHelpers[_k] = _v;
  }
}

// أغلفة متوافقة مع الأسماء القديمة (نفس التوقيعات)
function listCategories(...args) { return _domains.catalog.listCategories(...args); }
function moveCategoryOrder(...args) { return _domains.catalog.moveCategoryOrder(...args); }
function createCategory(...args) { return _domains.catalog.createCategory(...args); }
function setCategoryImage(...args) { return _domains.catalog.setCategoryImage(...args); }
function setCategoryPosHidden(...args) { return _domains.catalog.setCategoryPosHidden(...args); }
function getOrCreateCategoryByName(...args) { return _domains.catalog.getOrCreateCategoryByName(...args); }
function bulkImportProducts(...args) { return _domains.catalog.bulkImportProducts(...args); }
function parseProductsCsv(...args) { return _domains.catalog.parseProductsCsv(...args); }
function listProducts(...args) { return _domains.catalog.listProducts(...args); }
function listProductVariants(...args) { return _domains.catalog.listProductVariants(...args); }
function listVariantParentOptions(...args) { return _domains.catalog.listVariantParentOptions(...args); }
function getProduct(...args) { return _domains.catalog.getProduct(...args); }
function getProductByPlu(...args) { return _domains.catalog.getProductByPlu(...args); }
function resolveGs1Barcode(...args) { return _domains.catalog.resolveGs1Barcode(...args); }
function resolveWeightedBarcode(...args) { return _domains.catalog.resolveWeightedBarcode(...args); }
function assertUniqueProductIdentifiers(...args) { return _domains.catalog.assertUniqueProductIdentifiers(...args); }
function parseNonNegativeNumber(...args) { return _domains.catalog.parseNonNegativeNumber(...args); }
function createProduct(...args) { return _domains.catalog.createProduct(...args); }
function updateProduct(...args) { return _domains.catalog.updateProduct(...args); }
function deleteProduct(...args) { return _domains.catalog.deleteProduct(...args); }
function listBundles(...args) { return _domains.catalog.listBundles(...args); }
function listActiveBundles(...args) { return _domains.catalog.listActiveBundles(...args); }
function createBundle(...args) { return _domains.catalog.createBundle(...args); }
function updateBundle(...args) { return _domains.catalog.updateBundle(...args); }
function deleteBundle(...args) { return _domains.catalog.deleteBundle(...args); }
function priceItemsFromDatabase(...args) { return _domains.sales.priceItemsFromDatabase(...args); }
function quoteSale(...args) { return _domains.sales.quoteSale(...args); }
function assertDiscountAllowed(...args) { return _domains.sales.assertDiscountAllowed(...args); }
function assertCreditSaleAllowed(...args) { return _domains.sales.assertCreditSaleAllowed(...args); }
function getTerminalInvoiceToken(...args) { return _domains.sales.getTerminalInvoiceToken(...args); }
function nextInvoiceNumber(...args) { return _domains.sales.nextInvoiceNumber(...args); }
function resolveBundlesFromDatabase(...args) { return _domains.sales.resolveBundlesFromDatabase(...args); }
function calculateBundleDiscountFromDatabase(...args) { return _domains.sales.calculateBundleDiscountFromDatabase(...args); }
function saveSaleBundleSnapshot(...args) { return _domains.sales.saveSaleBundleSnapshot(...args); }
function getSaleBundles(...args) { return _domains.sales.getSaleBundles(...args); }
function allocateByWeight(...args) { return _domains.sales.allocateByWeight(...args); }
function validatePaymentAmounts(...args) { return _domains.sales.validatePaymentAmounts(...args); }
function validatePaymentAmountsMinor(...args) { return _domains.sales.validatePaymentAmountsMinor(...args); }
function postSaleAccountingInTransaction(...args) { return _domains.sales.postSaleAccountingInTransaction(...args); }
function createSale(...args) { return _domains.sales.createSale(...args); }
function listKnownDeliveryPersons(...args) { return _domains.sales.listKnownDeliveryPersons(...args); }
function listSales(...args) { return _domains.sales.listSales(...args); }
function getSale(...args) { return _domains.sales.getSale(...args); }
function listTransferBranches(...args) { return _domains.inventory.listTransferBranches(...args); }
function upsertTransferBranch(...args) { return _domains.inventory.upsertTransferBranch(...args); }
function getInventoryTransferByUuid(...args) { return _domains.inventory.getInventoryTransferByUuid(...args); }
function listInventoryTransfers(...args) { return _domains.inventory.listInventoryTransfers(...args); }
function createInventoryTransfer(...args) { return _domains.inventory.createInventoryTransfer(...args); }
function receiveInventoryTransfer(...args) { return _domains.inventory.receiveInventoryTransfer(...args); }
function cancelInventoryTransfer(...args) { return _domains.inventory.cancelInventoryTransfer(...args); }
function listInventory(...args) { return _domains.inventory.listInventory(...args); }
function adjustInventory(...args) { return _domains.inventory.adjustInventory(...args); }
function listInventoryMovements(...args) { return _domains.inventory.listInventoryMovements(...args); }
function getCashMovementsSummary(...args) { return _domains.reports.getCashMovementsSummary(...args); }
function getBalancesSnapshot(...args) { return _domains.reports.getBalancesSnapshot(...args); }
function dateRangeParams(...args) { return _domains.reports.dateRangeParams(...args); }
function getSalesSummary(...args) { return _domains.reports.getSalesSummary(...args); }
function getPayrollExpenseForRange(...args) { return _domains.reports.getPayrollExpenseForRange(...args); }
function getProfitLoss(...args) { return _domains.reports.getProfitLoss(...args); }
function getTopProducts(...args) { return _domains.reports.getTopProducts(...args); }
function getDailySales(...args) { return _domains.reports.getDailySales(...args); }
function getInvoiceList(...args) { return _domains.reports.getInvoiceList(...args); }
function listCustomers(...args) { return _domains.customers.listCustomers(...args); }
function getCustomer(...args) { return _domains.customers.getCustomer(...args); }
function createCustomer(...args) { return _domains.customers.createCustomer(...args); }
function updateCustomer(...args) { return _domains.customers.updateCustomer(...args); }
function appendStoreCreditLedger(...args) { return _domains.customers.appendStoreCreditLedger(...args); }
function recalcStoreCreditBalance(...args) { return _domains.customers.recalcStoreCreditBalance(...args); }
function recalcCustomerBalance(...args) { return _domains.customers.recalcCustomerBalance(...args); }
function appendCustomerLedger(...args) { return _domains.customers.appendCustomerLedger(...args); }
function getCustomerLedger(...args) { return _domains.customers.getCustomerLedger(...args); }
function receiveCustomerPayment(...args) { return _domains.customers.receiveCustomerPayment(...args); }
function getDebtAging(...args) { return _domains.customers.getDebtAging(...args); }
function listSuppliers(...args) { return _domains.purchasing.listSuppliers(...args); }
function createSupplier(...args) { return _domains.purchasing.createSupplier(...args); }
function updateSupplier(...args) { return _domains.purchasing.updateSupplier(...args); }
function createPurchaseOrder(...args) { return _domains.purchasing.createPurchaseOrder(...args); }
function receivePurchaseOrderCore(...args) { return _domains.purchasing.receivePurchaseOrderCore(...args); }
function receivePurchaseOrder(...args) { return _domains.purchasing.receivePurchaseOrder(...args); }
function listPurchaseOrders(...args) { return _domains.purchasing.listPurchaseOrders(...args); }
function paySupplierDebt(...args) { return _domains.purchasing.paySupplierDebt(...args); }
function ensureExpenseCategories(...args) { return _domains.purchasing.ensureExpenseCategories(...args); }
function listExpenseCategories(...args) { return _domains.purchasing.listExpenseCategories(...args); }
function saveExpenseCategory(...args) { return _domains.purchasing.saveExpenseCategory(...args); }
function createExpenseInvoice(...args) { return _domains.purchasing.createExpenseInvoice(...args); }
function getOperatingExpensesSummary(...args) { return _domains.purchasing.getOperatingExpensesSummary(...args); }
function getPurchaseOrder(...args) { return _domains.purchasing.getPurchaseOrder(...args); }
function requestBillForTable(...args) { return _domains.tables.requestBillForTable(...args); }
function acknowledgeBillRequest(...args) { return _domains.tables.acknowledgeBillRequest(...args); }
function listTables(...args) { return _domains.tables.listTables(...args); }
function releaseEmptyTable(...args) { return _domains.tables.releaseEmptyTable(...args); }
function createTable(...args) { return _domains.tables.createTable(...args); }
function deleteTable(...args) { return _domains.tables.deleteTable(...args); }
function getOrCreateOpenSale(...args) { return _domains.tables.getOrCreateOpenSale(...args); }
function setTableSaleCustomer(...args) { return _domains.tables.setTableSaleCustomer(...args); }
function getOpenSaleForTable(...args) { return _domains.tables.getOpenSaleForTable(...args); }
function setOpenSaleItems(...args) { return _domains.tables.setOpenSaleItems(...args); }
function markKitchenSent(...args) { return _domains.tables.markKitchenSent(...args); }
function recalculateOpenSale(...args) { return _domains.tables.recalculateOpenSale(...args); }
function mergeTables(...args) { return _domains.tables.mergeTables(...args); }
function splitTableSale(...args) { return _domains.tables.splitTableSale(...args); }
function closeTableSale(...args) { return _domains.tables.closeTableSale(...args); }
function correctSalePaymentMethod(...args) { return _domains.payments.correctSalePaymentMethod(...args); }
function modifyCompletedSaleItems(...args) { return _domains.payments.modifyCompletedSaleItems(...args); }
function getGlobalProfile(...args) { return _domains.profile.getGlobalProfile(...args); }
function organizationHasFinancialHistory(...args) { return _domains.profile.organizationHasFinancialHistory(...args); }
function setGlobalProfile(...args) { return _domains.profile.setGlobalProfile(...args); }
function listTaxProfiles(...args) { return _domains.profile.listTaxProfiles(...args); }
function saveTaxProfile(...args) { return _domains.profile.saveTaxProfile(...args); }
function listPaymentTransactions(...args) { return _domains.profile.listPaymentTransactions(...args); }
function getShiftCashMovements(...args) { return _domains.profile.getShiftCashMovements(...args); }
function addCashMovement(...args) { return _domains.profile.addCashMovement(...args); }
function getOpenShift(...args) { return _domains.shifts.getOpenShift(...args); }
function openShift(...args) { return _domains.shifts.openShift(...args); }
function computeExpectedCash(...args) { return _domains.shifts.computeExpectedCash(...args); }
function getShiftSummary(...args) { return _domains.shifts.getShiftSummary(...args); }
function closeShift(...args) { return _domains.shifts.closeShift(...args); }
function listShifts(...args) { return _domains.shifts.listShifts(...args); }
function normalizePayrollMonth(...args) { return _domains.payroll.normalizePayrollMonth(...args); }
function daysInPayrollMonth(...args) { return _domains.payroll.daysInPayrollMonth(...args); }
function parsePayrollDateLocal(...args) { return _domains.payroll.parsePayrollDateLocal(...args); }
function payrollTodayLocal(...args) { return _domains.payroll.payrollTodayLocal(...args); }
function daysElapsedInPayrollPeriod(...args) { return _domains.payroll.daysElapsedInPayrollPeriod(...args); }
function payrollDaysElapsedThrough(...args) { return _domains.payroll.payrollDaysElapsedThrough(...args); }
function payrollMonth(...args) { return _domains.payroll.payrollMonth(...args); }
function getOrCreatePayrollMonth(...args) { return _domains.payroll.getOrCreatePayrollMonth(...args); }
function payrollMultiplyDivideMinor(...args) { return _domains.payroll.payrollMultiplyDivideMinor(...args); }
function payrollRatioMinor(...args) { return _domains.payroll.payrollRatioMinor(...args); }
function recalcPayrollEmployeeMonth(...args) { return _domains.payroll.recalcPayrollEmployeeMonth(...args); }
function listPayrollV2Employees(...args) { return _domains.payroll.listPayrollV2Employees(...args); }
function addPayrollV2Employee(...args) { return _domains.payroll.addPayrollV2Employee(...args); }
function updatePayrollV2Employee(...args) { return _domains.payroll.updatePayrollV2Employee(...args); }
function setPayrollV2EmployeeActive(...args) { return _domains.payroll.setPayrollV2EmployeeActive(...args); }
function deletePayrollV2Employee(...args) { return _domains.payroll.deletePayrollV2Employee(...args); }
function getPayrollV2Report(...args) { return _domains.payroll.getPayrollV2Report(...args); }
function getPayrollV2Month(...args) { return _domains.payroll.getPayrollV2Month(...args); }
function assertPayrollMonthMutable(...args) { return _domains.payroll.assertPayrollMonthMutable(...args); }
function getPayrollEmployeePaymentState(...args) { return _domains.payroll.getPayrollEmployeePaymentState(...args); }
function syncPayrollEmployeeAccrual(...args) { return _domains.payroll.syncPayrollEmployeeAccrual(...args); }
function accruePayrollMonth(...args) { return _domains.payroll.accruePayrollMonth(...args); }
function addPayrollV2Transaction(...args) { return _domains.payroll.addPayrollV2Transaction(...args); }
function removePayrollV2Transaction(...args) { return _domains.payroll.removePayrollV2Transaction(...args); }
function setPayrollEmployeeMonthStartDate(...args) { return _domains.payroll.setPayrollEmployeeMonthStartDate(...args); }
function normalizePayrollFirstDeductionMonth(...args) { return _domains.payroll.normalizePayrollFirstDeductionMonth(...args); }
function currentPayrollMonthKey(...args) { return _domains.payroll.currentPayrollMonthKey(...args); }
function addMonthsToPayrollMonth(...args) { return _domains.payroll.addMonthsToPayrollMonth(...args); }
function createPayrollAdvance(...args) { return _domains.payroll.createPayrollAdvance(...args); }
function listPayrollAdvances(...args) { return _domains.payroll.listPayrollAdvances(...args); }
function listPayrollAdvancePayments(...args) { return _domains.payroll.listPayrollAdvancePayments(...args); }
function repayPayrollAdvance(...args) { return _domains.payroll.repayPayrollAdvance(...args); }
function settlePayrollAdvance(...args) { return _domains.payroll.settlePayrollAdvance(...args); }
function recordPayrollSalaryAdvanceRecovery(...args) { return _domains.payroll.recordPayrollSalaryAdvanceRecovery(...args); }
function getLoyaltySettings(...args) { return _domains.payroll.getLoyaltySettings(...args); }
function saveLoyaltySettings(...args) { return _domains.payroll.saveLoyaltySettings(...args); }
function getLoyaltyRedemptionQuote(...args) { return _domains.payroll.getLoyaltyRedemptionQuote(...args); }
function getLoyaltyRedemptionQuoteMajor(...args) { return _domains.payroll.getLoyaltyRedemptionQuoteMajor(...args); }
function resolveLoyaltyRedemption(...args) { return _domains.payroll.resolveLoyaltyRedemption(...args); }
function getReceiptBarcodeEnabled(...args) { return _domains.payroll.getReceiptBarcodeEnabled(...args); }
function setReceiptBarcodeEnabled(...args) { return _domains.payroll.setReceiptBarcodeEnabled(...args); }
function getQuickCashierEnabled(...args) { return _domains.payroll.getQuickCashierEnabled(...args); }
function setQuickCashierEnabled(...args) { return _domains.payroll.setQuickCashierEnabled(...args); }
function getOffersCategoryEnabled(...args) { return _domains.payroll.getOffersCategoryEnabled(...args); }
function setOffersCategoryEnabled(...args) { return _domains.payroll.setOffersCategoryEnabled(...args); }
function getOffersCategoryImage(...args) { return _domains.payroll.getOffersCategoryImage(...args); }
function setOffersCategoryImage(...args) { return _domains.payroll.setOffersCategoryImage(...args); }
function getTaxDefaultRate(...args) { return _domains.payroll.getTaxDefaultRate(...args); }
function saveTaxDefaultRate(...args) { return _domains.payroll.saveTaxDefaultRate(...args); }
function getPayrollSettings(...args) { return _domains.payroll.getPayrollSettings(...args); }
function savePayrollSettings(...args) { return _domains.payroll.savePayrollSettings(...args); }
function setPayrollV2RegularHours(...args) { return _domains.payroll.setPayrollV2RegularHours(...args); }
function recordPayrollPayment(...args) { return _domains.payroll.recordPayrollPayment(...args); }
function calculatePayrollFinalSettlement(...args) { return _domains.payroll.calculatePayrollFinalSettlement(...args); }
function settleEmployeeFinalPayroll(...args) { return _domains.payroll.settleEmployeeFinalPayroll(...args); }
function listPayrollFinalSettlements(...args) { return _domains.payroll.listPayrollFinalSettlements(...args); }
function listPayrollPayments(...args) { return _domains.payroll.listPayrollPayments(...args); }
function voidPayrollFinalSettlement(...args) { return _domains.payroll.voidPayrollFinalSettlement(...args); }
function reopenPayrollMonth(...args) { return _domains.payroll.reopenPayrollMonth(...args); }
function getPayrollV2Employee(...args) { return _domains.payroll.getPayrollV2Employee(...args); }
function getSaleIdByInvoiceNumber(...args) { return _domains.returns.getSaleIdByInvoiceNumber(...args); }
function getSaleForReturn(...args) { return _domains.returns.getSaleForReturn(...args); }
function createReturn(...args) { return _domains.returns.createReturn(...args); }
function listReturns(...args) { return _domains.returns.listReturns(...args); }
function getReturn(...args) { return _domains.returns.getReturn(...args); }
function getDeliverySummary(...args) { return _domains.delivery.getDeliverySummary(...args); }
function getReportExport(...args) { return _domains.export_sync.getReportExport(...args); }
function getSyncConfig(...args) { return _domains.export_sync.getSyncConfig(...args); }
function saveSyncConfig(...args) { return _domains.export_sync.saveSyncConfig(...args); }
function syncPayload(...args) { return _domains.export_sync.syncPayload(...args); }
function markSynced(...args) { return _domains.export_sync.markSynced(...args); }
function applyRemoteChanges(...args) { return _domains.export_sync.applyRemoteChanges(...args); }
function recalcCustomerLoyaltyPointsForBranch(...args) { return _domains.export_sync.recalcCustomerLoyaltyPointsForBranch(...args); }
function recalcAllCustomerBalancesForBranch(...args) { return _domains.export_sync.recalcAllCustomerBalancesForBranch(...args); }
function listAccountingAccounts(...args) { return _domains.accounting.listAccountingAccounts(...args); }
function createAccountingAccount(...args) { return _domains.accounting.createAccountingAccount(...args); }
function getAccountingAccountId(...args) { return _domains.accounting.getAccountingAccountId(...args); }
function ensureInventoryAdjustmentAccount(...args) { return _domains.accounting.ensureInventoryAdjustmentAccount(...args); }
function accountingTodayLocal(...args) { return _domains.accounting.accountingTodayLocal(...args); }
function accountingPeriodKeyOf(...args) { return _domains.accounting.accountingPeriodKeyOf(...args); }
function isAccountingPeriodLocked(...args) { return _domains.accounting.isAccountingPeriodLocked(...args); }
function assertAccountingPeriodOpen(...args) { return _domains.accounting.assertAccountingPeriodOpen(...args); }
function insertPostedJournalEntry(...args) { return _domains.accounting.insertPostedJournalEntry(...args); }
function postJournalEntry(...args) { return _domains.accounting.postJournalEntry(...args); }
function listJournalEntries(...args) { return _domains.accounting.listJournalEntries(...args); }
function listAccountingPeriods(...args) { return _domains.accounting.listAccountingPeriods(...args); }
function lockAccountingPeriod(...args) { return _domains.accounting.lockAccountingPeriod(...args); }
function reopenAccountingPeriod(...args) { return _domains.accounting.reopenAccountingPeriod(...args); }
function hasPostedEntriesAfterCutoff(...args) { return _domains.accounting.hasPostedEntriesAfterCutoff(...args); }
function getNetIncomeToDateFast(...args) { return _domains.accounting.getNetIncomeToDateFast(...args); }
function getTrialBalance(...args) { return _domains.accounting.getTrialBalance(...args); }
function getIncomeStatement(...args) { return _domains.accounting.getIncomeStatement(...args); }
function getBalanceSheet(...args) { return _domains.accounting.getBalanceSheet(...args); }
function getAccountLedger(...args) { return _domains.accounting.getAccountLedger(...args); }
function recordSyncOutboxEvent(...args) { return _domains.accounting.recordSyncOutboxEvent(...args); }
function listSyncConflicts(...args) { return _domains.accounting.listSyncConflicts(...args); }
function listBackupManifests(...args) { return _domains.accounting.listBackupManifests(...args); }
function saveFiscalDocument(...args) { return _domains.accounting.saveFiscalDocument(...args); }
function listFiscalDocuments(...args) { return _domains.accounting.listFiscalDocuments(...args); }
function getDbPath(...args) { return _domains.backup.getDbPath(...args); }
function createUpgradeSnapshot(...args) { return _domains.backup.createUpgradeSnapshot(...args); }
function closeDatabase(...args) { return _domains.backup.closeDatabase(...args); }
function validateBackupFile(...args) { return _domains.backup.validateBackupFile(...args); }
function getImagesDirPath(...args) { return _domains.backup.getImagesDirPath(...args); }
function buildImageBundle(...args) { return _domains.backup.buildImageBundle(...args); }
function extractImageBundle(...args) { return _domains.backup.extractImageBundle(...args); }
function deriveImagesKey(...args) { return _domains.backup.deriveImagesKey(...args); }
function encryptImageBundle(...args) { return _domains.backup.encryptImageBundle(...args); }
function decryptImageBundle(...args) { return _domains.backup.decryptImageBundle(...args); }
function imagesSidecarPath(...args) { return _domains.backup.imagesSidecarPath(...args); }
function restoreImagesSidecarIfPresent(...args) { return _domains.backup.restoreImagesSidecarIfPresent(...args); }
function derivePortableKey(...args) { return _domains.backup.derivePortableKey(...args); }
function restorePortableBackup(...args) { return _domains.backup.restorePortableBackup(...args); }

function backupTo(...args) { return _domains.backup.backupTo(...args); }
function backupToWithImages(...args) { return _domains.backup.backupToWithImages(...args); }
function createPortableBackup(...args) { return _domains.backup.createPortableBackup(...args); }
module.exports = {
  DatabaseKeyMismatchError,
  resetUserPassword,
  changeOwnPassword,
  getProfitLoss,
  getCashMovementsSummary,
  getBalancesSnapshot,
  bulkImportProducts,
  parseProductsCsv,
  listBundles,
  listActiveBundles,
  createBundle,
  updateBundle,
  deleteBundle,
  init,
  authenticate,
  getBootstrapAdminInfo,
  clearBootstrapAdminInfo,
  authenticateByPin,
  authenticateManagerByPin,
  setUserPin,
  clearUserPin,
  setUserShiftType,
  listUsers,
  getUser,
  createUser,
  updateUser,
  deleteUser,
  listBranches,
  getCurrentBranch,
  updateBranch,
  adoptSharedBranch,
  listCategories,
  setCategoryImage,
  setCategoryPosHidden,
  moveCategoryOrder,
  createCategory,
  listProducts,
  listProductVariants,
  listVariantParentOptions,
  getProduct,
  getProductByPlu,
  resolveWeightedBarcode,
  resolveGs1Barcode,
  buildWeightedBarcode,
  createProduct,
  updateProduct,
  deleteProduct,
  createSale,
  listSales,
  listKnownDeliveryPersons,
  getSale,
  listInventory,
  adjustInventory,
  listInventoryMovements,
  listTransferBranches,
  upsertTransferBranch,
  createInventoryTransfer,
  listInventoryTransfers,
  getInventoryTransferByUuid,
  receiveInventoryTransfer,
  cancelInventoryTransfer,
  getSalesSummary,
  getTopProducts,
  getDailySales,
  getInvoiceList,
  listCustomers,
  getCustomer,
  createCustomer,
  updateCustomer,
  getCustomerLedger,
  receiveCustomerPayment,
  getDebtAging,
  listSuppliers,
  createSupplier,
  updateSupplier,
  paySupplierDebt,
  createPurchaseOrder,
  receivePurchaseOrder,
  listPurchaseOrders,
  getPurchaseOrder,
  listTables,
  requestBillForTable,
  acknowledgeBillRequest,
  releaseEmptyTable,
  createTable,
  deleteTable,
  getOrCreateOpenSale,
  setTableSaleCustomer,
  getOpenSaleForTable,
  setOpenSaleItems,
  markKitchenSent,
  setUserSalesModify,
  userCanModifySales,
  listExpenseCategories,
  saveExpenseCategory,
  createExpenseInvoice,
  getOperatingExpensesSummary,
  mergeTables,
  splitTableSale,
  closeTableSale,
  correctSalePaymentMethod,
  modifyCompletedSaleItems,
  logAudit,
  listAuditLogs,
  getSetting,
  setSetting,
  getGlobalProfile,
  setGlobalProfile,
  listTaxProfiles,
  saveTaxProfile,
  listPaymentTransactions,
  getShiftCashMovements,
  addCashMovement,
  getMaxCashierDiscountPercent,
  getOpenShift,
  openShift,
  closeShift,
  getShiftSummary,
  listShifts,
  listPayrollV2Employees,
  addPayrollV2Employee,
  updatePayrollV2Employee,
  setPayrollV2EmployeeActive,
  deletePayrollV2Employee,
  getOrCreatePayrollMonth,
  getPayrollV2Month,
  getPayrollV2Report,
  getPayrollV2Employee,
  addPayrollV2Transaction,
  removePayrollV2Transaction,
  recordPayrollPayment,
  accruePayrollMonth,
  syncPayrollEmployeeAccrual,
  migratePayrollAccrualV19, // مُصدَّرة أيضاً كأداة دعم فنّي: تشغيلها يدوياً آمن ومتكرر (idempotent) إن احتاج الدعم إعادة فحص أي فرع/تركيب قديم.
  listPayrollPayments,
  createPayrollAdvance,
  listPayrollAdvances,
  listPayrollAdvancePayments,
  repayPayrollAdvance,
  settlePayrollAdvance,
  recordPayrollSalaryAdvanceRecovery,
  calculatePayrollFinalSettlement,
  settleEmployeeFinalPayroll,
  listPayrollFinalSettlements,
  voidPayrollFinalSettlement,
  reopenPayrollMonth,
  setPayrollV2RegularHours,
  getPayrollSettings,
  savePayrollSettings,
  getTaxDefaultRate,
  saveTaxDefaultRate,
  getReceiptBarcodeEnabled,
  setReceiptBarcodeEnabled,
  getQuickCashierEnabled,
  setQuickCashierEnabled,
  priceItemsFromDatabase,
  quoteSale,
  getOffersCategoryEnabled,
  setOffersCategoryEnabled,
  getOffersCategoryImage,
  setOffersCategoryImage,
  getLoyaltySettings,
  saveLoyaltySettings,
  getLoyaltyRedemptionQuote,
  getLoyaltyRedemptionQuoteMajor,
  setPayrollEmployeeMonthStartDate,
  getSaleForReturn,
  createReturn,
  listReturns,
  getReturn,
  getDeliverySummary,
  getReportExport,
  getSyncConfig,
  saveSyncConfig,
  syncPayload,
  markSynced,
  applyRemoteChanges,
  getDbPath,
  createUpgradeSnapshot,
  closeDatabase,
  validateBackupFile,
  backupTo,
  backupToWithImages, restoreImagesSidecarIfPresent,
  createPortableBackup, restorePortableBackup,
  listAccountingAccounts, createAccountingAccount, postJournalEntry, listJournalEntries,
  getTrialBalance, getIncomeStatement, getBalanceSheet, getAccountLedger,
  listAccountingPeriods, lockAccountingPeriod, reopenAccountingPeriod,
  recordSyncOutboxEvent, listSyncConflicts, listBackupManifests,
  saveFiscalDocument, listFiscalDocuments,
};
