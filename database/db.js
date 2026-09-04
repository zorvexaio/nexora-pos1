const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3-multiple-ciphers');
const { app, safeStorage } = require('electron');
const { parseWeightedBarcode, buildWeightedBarcode } = require('./weighted-barcode');
const { parseGs1 } = require('./gs1-barcode');
const money = require('../core/money');
const accounting = require('../finance/accounting');

// قاعدة البيانات تُخزَّن في مجلد بيانات المستخدم (يبقى بعد تحديث التطبيق).
// لا تحفظ أي بيانات عميل داخل مجلد التثبيت أو داخل asar، لأن المثبّت يستبدلهما بالكامل.
const userDataPath = app.getPath('userData');
const dbPath = path.join(userDataPath, 'pos.db');
const keyPath = path.join(userDataPath, 'pos.db.key');
const databaseExistedBeforeOpen = fs.existsSync(dbPath) && fs.statSync(dbPath).size > 0;
const CURRENT_SCHEMA_VERSION = 15;

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
  const unit = minorUnit == null ? Number(getGlobalProfile()?.currency_minor_unit || 2) : Number(minorUnit);
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

/* ---------------- تشفير كلمات المرور ---------------- */
// scrypt مدمج في Node.js، لا حاجة لأي حزمة خارجية (يفادي تعقيد بناء native إضافي)
const authFailures = new Map();
const AUTH_MAX_ATTEMPTS = 8;
const AUTH_WINDOW_MS = 10 * 60 * 1000;
const AUTH_LOCKOUT_MS = 15 * 60 * 1000;

function authBucket(key) {
  const now = Date.now();
  const bucket = authFailures.get(key);
  if (!bucket || (now - bucket.firstAt) > AUTH_WINDOW_MS) {
    const fresh = { firstAt: now, count: 0, lockedUntil: 0 };
    authFailures.set(key, fresh);
    return fresh;
  }
  return bucket;
}

function checkAuthRateLimit(key) {
  const b = authBucket(key);
  if (b.lockedUntil > Date.now()) return false;
  if (b.lockedUntil && b.lockedUntil <= Date.now()) { b.count = 0; b.firstAt = Date.now(); b.lockedUntil = 0; }
  return true;
}

function recordAuthFailure(key) {
  const b = authBucket(key);
  b.count += 1;
  if (b.count >= AUTH_MAX_ATTEMPTS) b.lockedUntil = Date.now() + AUTH_LOCKOUT_MS;
}

function clearAuthFailures(key) { authFailures.delete(key); }

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const check = crypto.scryptSync(password, salt, 64).toString('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(check, 'hex'));
  } catch {
    return false; // طول غير متطابق مثلاً
  }
}

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

  // Migrate existing payroll-only workers once. Their login account remains legacy data for compatibility,
  // but all new payroll operations use payroll_employees and never create a users row.
  const legacyPayrollWorkers = db.prepare(`SELECT id,branch_id,full_name,job_title,pay_type,pay_rate,monthly_salary,hourly_rate FROM users WHERE is_payroll_only=1`).all();
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

function logAudit({ userId = null, action, entityType = null, entityId = null, details = null, level = 'info', branchId = null }) {
  const branch = branchId ? null : getCurrentBranch();
  db.prepare(`INSERT INTO audit_logs (branch_id,user_id,action,entity_type,entity_id,details,level)
    VALUES (?,?,?,?,?,?,?)`).run(branchId || branch?.id || null, userId, action, entityType, entityId == null ? null : String(entityId),
    details == null ? null : JSON.stringify(details), level);
}

function listAuditLogs(limit = 500) {
  const branch = getCurrentBranch();
  return db.prepare(`SELECT a.*, u.full_name AS user_name FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id
    WHERE a.branch_id=? OR a.branch_id IS NULL ORDER BY a.id DESC LIMIT ?`).all(branch.id, Math.min(Math.max(Number(limit) || 100, 1), 500));
}

function uuid() {
  return crypto.randomUUID();
}

// عند أول تشغيل: ننشئ فرعاً افتراضياً واحداً حتى يعمل التطبيق فوراً
function seedDefaultBranchIfEmpty() {
  const count = db.prepare('SELECT COUNT(*) AS c FROM branches').get().c;
  if (count === 0) {
    db.prepare(
      `INSERT INTO branches (uuid, name, business_type, is_current) VALUES (?, ?, ?, 1)`
    ).run(uuid(), 'الفرع الرئيسي', 'general');
  }
}

/* ---------------- المصادقة وإدارة المستخدمين ---------------- */
function sanitizeUser(u) {
  if (!u) return null;
  const { password_hash, pin_hash, ...rest } = u;
  return rest;
}

function authenticate(username, password) {
  const branch = getCurrentBranch();
  if (!branch) return null;
  const cleanUsername = String(username || '').trim();
  const key = `pwd:${branch.id}:${cleanUsername.toLowerCase()}`;
  if (!checkAuthRateLimit(key)) return { rateLimited: true };
  const row = db.prepare('SELECT * FROM users WHERE username = ? AND branch_id = ?').get(cleanUsername, branch.id);
  if (row?.is_payroll_only) return { blocked: true };
  if (!row || !verifyPassword(password, row.password_hash)) { recordAuthFailure(key); return null; }
  if (!row.is_active) return { blocked: true };
  clearAuthFailures(key);
  return sanitizeUser(row);
}

// تبديل سريع بين الموظفين على نفس الجهاز: يبحث عن أي مستخدم نشط يطابق رقم الـ PIN المُدخَل.
// عدد الموظفين بالمحل الواحد صغير عادةً، فالمرور على الكل بأمان (بدون تسريب توقيت) مقبول الأداء.
function authenticateByPin(pin) {
  if (!pin) return null;
  const branch = getCurrentBranch();
  if (!branch) return null;
  const key = `pin:${branch.id}`;
  if (!checkAuthRateLimit(key)) return { rateLimited: true };
  const rows = db.prepare('SELECT * FROM users WHERE is_active = 1 AND is_payroll_only = 0 AND pin_hash IS NOT NULL AND branch_id = ?').all(branch.id);
  for (const row of rows) {
    if (verifyPassword(pin, row.pin_hash)) { clearAuthFailures(key); return sanitizeUser(row); }
  }
  recordAuthFailure(key);
  return null;
}

// موافقة مدير/مدير عام سريعة عبر PIN فقط (بديل أسرع لاسم مستخدم/كلمة مرور بشاشات الموافقة)
function authenticateManagerByPin(pin) {
  const user = authenticateByPin(pin);
  if (!user || !['admin', 'manager'].includes(user.role)) return null;
  return user;
}

// تعيين/تغيير PIN مستخدم. يرفض PIN مستخدَم فعلاً من مستخدم نشط آخر (تفادي التعارض عند البحث بالتبديل السريع).
function setUserPin(userId, pin) {
  const branch = getCurrentBranch();
  const clean = String(pin || '').trim();
  if (!/^\d{4,6}$/.test(clean)) {
    return { success: false, message: 'رقم الـ PIN يجب أن يكون من 4 إلى 6 أرقام.' };
  }
  const others = db.prepare('SELECT pin_hash FROM users WHERE is_active = 1 AND pin_hash IS NOT NULL AND branch_id = ? AND id != ?').all(branch.id, userId);
  for (const row of others) {
    if (verifyPassword(clean, row.pin_hash)) {
      return { success: false, message: 'رقم الـ PIN هذا مستخدَم بالفعل من موظف آخر. اختر رقماً مختلفاً.' };
    }
  }
  const target = db.prepare('SELECT id FROM users WHERE id = ? AND branch_id = ?').get(Number(userId), branch.id);
  if (!target) return { success: false, message: 'المستخدم غير موجود في الفرع الحالي.' };
  db.prepare('UPDATE users SET pin_hash = ? WHERE id = ? AND branch_id = ?').run(hashPassword(clean), target.id, branch.id);
  return { success: true };
}

function clearUserPin(userId) {
  const branch = getCurrentBranch();
  db.prepare('UPDATE users SET pin_hash = NULL WHERE id = ? AND branch_id = ?').run(Number(userId), branch.id);
  return { success: true };
}

function listUsers() {
  const branch = getCurrentBranch();
  return db
    .prepare(
      `SELECT id, uuid, full_name, username, role, branch_id, is_active, monthly_salary, created_at,
              (pin_hash IS NOT NULL) AS has_pin
       FROM users WHERE branch_id = ? AND is_payroll_only = 0 ORDER BY id`
    )
    .all(branch.id);
}

function getUser(id) {
  const branch = getCurrentBranch();
  return sanitizeUser(db.prepare('SELECT * FROM users WHERE id = ? AND branch_id = ?').get(Number(id), branch.id));
}

function createUser(u) {
  const branch = getCurrentBranch();
  if (!String(u.fullName || '').trim()) return { success: false, message: 'اسم الموظف مطلوب.' };
  if (!/^[A-Za-z0-9_.@-]{3,64}$/.test(String(u.username || '').trim())) return { success: false, message: 'اسم المستخدم غير صالح.' };
  if (String(u.password || '').length < 8) return { success: false, message: 'كلمة المرور يجب أن تكون 8 أحرف على الأقل.' };
  if (!['admin','manager','cashier'].includes(u.role || 'cashier')) return { success: false, message: 'الدور غير صالح.' };
  try {
    const info = db
      .prepare(
        `INSERT INTO users (uuid, full_name, username, password_hash, role, branch_id, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(uuid(), u.fullName, u.username, hashPassword(u.password), u.role || 'cashier', branch.id, u.isActive === false ? 0 : 1);
    return { success: true, id: info.lastInsertRowid };
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return { success: false, message: 'اسم المستخدم مستخدم بالفعل' };
    }
    throw err;
  }
}

// عدد حسابات "مدير عام" المفعّلة في هذا الفرع (باستثناء مستخدم معيّن اختيارياً) — يُستخدم
// لمنع تعطيل أو حذف أو إنزال دور آخر مدير عام مفعّل، لأن ذلك قد يقفل إدارة النظام كاملاً
// (الإعدادات، الرواتب، سجل التدقيق...) بلا أي حساب قادر على الوصول إليها لاحقاً.
function countActiveAdmins(branchId, excludeUserId) {
  const row = db.prepare(`SELECT COUNT(*) c FROM users WHERE branch_id=? AND role='admin' AND is_active=1 AND id != ?`).get(branchId, Number(excludeUserId || 0));
  return row.c;
}

function updateUser(u) {
  const branch = getCurrentBranch();
  const target = db.prepare('SELECT id, username, role, is_active FROM users WHERE id = ? AND branch_id = ?').get(Number(u.id), branch.id);
  if (!target) return { success: false, message: 'المستخدم غير موجود في الفرع الحالي.' };
  if (!String(u.fullName || '').trim()) return { success: false, message: 'اسم الموظف مطلوب.' };
  if (!/^[A-Za-z0-9_.@-]{3,64}$/.test(String(u.username || '').trim())) return { success: false, message: 'اسم المستخدم غير صالح.' };
  if (!['admin','manager','cashier'].includes(u.role)) return { success: false, message: 'الدور غير صالح.' };
  const willLoseAdminRights = target.role === 'admin' && target.is_active === 1 && (u.role !== 'admin' || u.isActive === false);
  if (willLoseAdminRights && countActiveAdmins(branch.id, target.id) === 0) {
    return { success: false, message: 'لا يمكن تعطيل هذا الحساب أو تغيير دوره لأنه آخر حساب "مدير عام" مفعّل في هذا الفرع. أضف مديراً عاماً آخر أولاً.' };
  }
  try {
    if (u.password) {
      if (String(u.password).length < 8) return { success: false, message: 'كلمة المرور يجب أن تكون 8 أحرف على الأقل.' };
      db.prepare(
        `UPDATE users SET full_name=?, username=?, role=?, is_active=?, password_hash=?, must_change_password=1 WHERE id=? AND branch_id=?`
      ).run(String(u.fullName).trim(), String(u.username).trim(), u.role, u.isActive === false ? 0 : 1, hashPassword(u.password), target.id, branch.id);
    } else {
      db.prepare(`UPDATE users SET full_name=?, username=?, role=?, is_active=? WHERE id=? AND branch_id=?`).run(
        String(u.fullName).trim(), String(u.username).trim(), u.role, u.isActive === false ? 0 : 1, target.id, branch.id
      );
    }
    return { success: true };
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return { success: false, message: 'اسم المستخدم مستخدم بالفعل' };
    }
    throw err;
  }
}

// حذف مستخدم من شاشة "المستخدمون". يحذف الحساب نهائياً فقط إن لم يكن مرتبطاً بأي سجلات
// تاريخية (مبيعات، ورديات، دفعات، حركات صندوق، سجل تدقيق، رواتب قديمة...). إن كان مرتبطاً،
// حذفه فعلياً سيكسر سلامة تلك السجلات (foreign_keys=ON بهذه القاعدة)، لذا نعطّل حسابه بدلاً
// من ذلك (نفس منطق is_active المستخدم أصلاً بهذا التطبيق) — يمنعه من تسجيل الدخول فوراً
// مع إبقاء كل الفواتير والتقارير والتدقيق القديمة المرتبطة به سليمة كما هي.
function deleteUser(userId, currentUserId) {
  const branch = getCurrentBranch();
  const target = db.prepare('SELECT id, role, is_active FROM users WHERE id=? AND branch_id=?').get(Number(userId), branch.id);
  if (!target) return { success: false, message: 'المستخدم غير موجود في الفرع الحالي.' };
  if (Number(target.id) === Number(currentUserId)) {
    return { success: false, message: 'لا يمكنك حذف الحساب الذي تستخدمه الآن لتسجيل الدخول.' };
  }
  if (target.role === 'admin' && target.is_active === 1 && countActiveAdmins(branch.id, target.id) === 0) {
    return { success: false, message: 'لا يمكن حذف أو تعطيل آخر حساب "مدير عام" مفعّل في هذا الفرع. أضف مديراً عاماً آخر أولاً.' };
  }
  try {
    db.prepare('DELETE FROM users WHERE id=? AND branch_id=?').run(target.id, branch.id);
    return { success: true, hardDeleted: true };
  } catch (err) {
    if (String(err.code || '').startsWith('SQLITE_CONSTRAINT')) {
      db.prepare(`UPDATE users SET is_active=0 WHERE id=? AND branch_id=?`).run(target.id, branch.id);
      return { success: true, hardDeleted: false, deactivatedInstead: true };
    }
    throw err;
  }
}

// لاستعادة كلمة مرور مستخدم (خصوصاً admin) لما تُنسى ولا يوجد أي حساب آخر يقدر
// يغيّرها من الواجهة. تُستدعى فقط من main.js عبر علم سطر أوامر --reset-password،
// وليست IPC مكشوف للواجهة (renderer) حتى لا يستغلها أي شخص عن بعد.
function resetUserPassword(username, newPassword) {
  if (String(newPassword || '').length < 8) return { success: false, message: 'كلمة المرور يجب أن تكون 8 أحرف على الأقل.' };
  const branch = getCurrentBranch();
  const row = db.prepare('SELECT id FROM users WHERE username = ? AND branch_id = ?').get(String(username || '').trim(), branch.id);
  if (!row) return { success: false, message: `لا يوجد مستخدم باسم "${username}" في الفرع الحالي` };
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ? AND branch_id = ?').run(hashPassword(newPassword), row.id, branch.id);
  return { success: true };
}

function changeOwnPassword(userId, currentPassword, newPassword) {
  if (!newPassword || String(newPassword).length < 8) throw new Error('كلمة المرور الجديدة يجب أن تتكون من 8 أحرف على الأقل.');
  const branch = getCurrentBranch();
  if (!branch) throw new Error('الفرع الحالي غير موجود.');
  const row = db.prepare('SELECT password_hash, is_active FROM users WHERE id = ? AND branch_id = ?').get(Number(userId), branch.id);
  if (!row || !row.is_active || !verifyPassword(currentPassword, row.password_hash)) throw new Error('كلمة المرور الحالية غير صحيحة.');
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ? AND branch_id = ?').run(hashPassword(newPassword), Number(userId), branch.id);
  return { success: true };
}

/* ---------------- الفروع ---------------- */
function listBranches() {
  return db.prepare('SELECT * FROM branches ORDER BY id').all();
}
function getCurrentBranch() {
  return db.prepare('SELECT * FROM branches WHERE is_current = 1 LIMIT 1').get();
}
function updateBranch(b) {
  const current = getCurrentBranch();
  if (!current || Number(b.id) !== Number(current.id)) throw new Error('لا يمكن تعديل فرع خارج الفرع الحالي.');
  const name=String(b.name||'').trim();
  const businessType=String(b.businessType||'general').trim();
  if (!name) throw new Error('اسم الفرع مطلوب.');
  if (!['general','restaurant','supermarket','fashion'].includes(businessType)) throw new Error('نوع النشاط غير صالح.');
  db.prepare(`UPDATE branches SET name = ?, business_type = ? WHERE id = ?`).run(name, businessType, current.id);
  return { success: true };
}

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

/* ---------------- الفئات ---------------- */
function listCategories() {
  return db.prepare('SELECT * FROM categories ORDER BY name').all();
}

function createCategory(c) {
  const name = String(c?.name || '').trim();
  if (!name) throw new Error('اسم الفئة مطلوب.');
  const parentId = c?.parentId == null || c.parentId === '' ? null : Number(c.parentId);
  if (parentId !== null && (!Number.isInteger(parentId) || parentId <= 0)) throw new Error('الفئة الأب غير صالحة.');
  const info = db.prepare(`INSERT INTO categories (uuid, name, parent_id) VALUES (?, ?, ?)`).run(uuid(), name, parentId);
  return { id: info.lastInsertRowid };
}

function getOrCreateCategoryByName(name) {
  if (!name) return null;
  const trimmed = String(name).trim();
  if (!trimmed) return null;
  const existing = db.prepare('SELECT id FROM categories WHERE name = ?').get(trimmed);
  if (existing) return existing.id;
  return createCategory({ name: trimmed }).id;
}

// استيراد دفعة منتجات دفعة واحدة (من ملف CSV) — لسهولة إضافة بضاعة السوبرماركت/الأزياء بدون إدخال يدوي.
// كل صف: { name, barcode, category, price, cost, quantity, minQuantity, unit }
// إن وُجد barcode مطابق لمنتج موجود: يُحدَّث الاسم/السعر/التكلفة، وتُضاف الكمية المستوردة كوارد جديد للمخزون.
// إن لم يوجد: يُنشأ منتج جديد بالكمية المستوردة كرصيد ابتدائي.
const bulkImportProductsTx = db.transaction((rows) => {
  const branch = getCurrentBranch();
  // products is a shared catalog. Barcode/name matching is intentionally global;
  // branch-specific stock is updated separately in inventory.
  const findByBarcode = db.prepare(`
    SELECT id FROM products
    WHERE barcode = ? AND barcode IS NOT NULL AND barcode != ''
    ORDER BY id LIMIT 1
  `);
  const findByName = db.prepare(`
    SELECT id FROM products
    WHERE name = ? AND is_active = 1
    ORDER BY id LIMIT 1
  `);
  const updateExisting = db.prepare(
    `UPDATE products SET name=@name, price=@price, cost=@cost, category_id=@category_id, unit=@unit WHERE id=@id`
  );
  const addStock = db.prepare(
    `UPDATE inventory SET quantity = quantity + ?, min_quantity = COALESCE(?, min_quantity), updated_at = datetime('now'), synced = 0
     WHERE branch_id = ? AND product_id = ?`
  );
  const createBranchInventory = db.prepare(
    `INSERT INTO inventory (branch_id, product_id, quantity, min_quantity) VALUES (?, ?, ?, ?)`
  );
  const logMovement = db.prepare(
    `INSERT INTO inventory_movements (uuid, branch_id, product_id, change_qty, reason, ref_id, synced) VALUES (?, ?, ?, ?, 'import', NULL, 0)`
  );

  const results = { created: 0, updated: 0, errors: [] };

  rows.forEach((row, index) => {
    try {
      const name = (row.name || '').trim();
      if (!name) {
        results.errors.push({ row: index + 1, message: 'اسم المنتج مفقود' });
        return;
      }
      const barcode = (row.barcode || '').trim() || null;
      const price = parseNonNegativeNumber(row.price ?? 0, `السعر في الصف ${index + 1}`);
      const cost = parseNonNegativeNumber(row.cost ?? 0, `التكلفة في الصف ${index + 1}`);
      const quantity = parseNonNegativeNumber(row.quantity ?? 0, `الكمية في الصف ${index + 1}`);
      const minQuantity = row.minQuantity !== undefined && String(row.minQuantity).trim() !== ''
        ? parseNonNegativeNumber(row.minQuantity, `الحد الأدنى للمخزون في الصف ${index + 1}`)
        : null;
      const categoryId = getOrCreateCategoryByName(row.category);
      const unit = (row.unit || 'piece').trim() || 'piece';

      let existing = barcode ? findByBarcode.get(barcode) : null;
      if (!existing) existing = findByName.get(name);

      if (existing) {
        updateExisting.run({ id: existing.id, name, price, cost, category_id: categoryId, unit });
        const stockResult = addStock.run(quantity, minQuantity, branch.id, existing.id);
        if (stockResult.changes === 0) {
          createBranchInventory.run(branch.id, existing.id, quantity, minQuantity || 0);
        }
        if (quantity !== 0) logMovement.run(uuid(), branch.id, existing.id, quantity);
        results.updated += 1;
      } else {
        const created = createProduct({
          name,
          barcode,
          price,
          cost,
          categoryId,
          unit,
          initialStock: quantity,
          minQuantity: minQuantity || 0,
        });
        if (quantity !== 0) logMovement.run(uuid(), branch.id, created.id, quantity);
        results.created += 1;
      }
    } catch (err) {
      results.errors.push({ row: index + 1, message: err.message });
    }
  });

  return results;
});

function bulkImportProducts(rows) {
  return bulkImportProductsTx(rows);
}

// يحوّل نص CSV خام إلى صفوف منتجات جاهزة لـ bulkImportProducts. يدعم فاصلة عادية ومحارف مقتبسة بسيطة.
// الأعمدة المتوقعة (بأي ترتيب، بالاسم بالسطر الأول): name, barcode, category, price, cost, quantity, minQuantity, unit
function parseProductsCsv(csvText) {
  const lines = csvText.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length < 2) return [];

  const splitLine = (line) => {
    const cells = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        inQuotes = !inQuotes;
      } else if (ch === ',' && !inQuotes) {
        cells.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
    cells.push(current);
    return cells.map((c) => c.trim());
  };

  const headers = splitLine(lines[0]).map((h) => h.toLowerCase());
  const colIndex = (names) => headers.findIndex((h) => names.includes(h));

  const idx = {
    name: colIndex(['name', 'الاسم', 'اسم المنتج']),
    barcode: colIndex(['barcode', 'الباركود']),
    category: colIndex(['category', 'الفئة', 'التصنيف']),
    price: colIndex(['price', 'السعر']),
    cost: colIndex(['cost', 'التكلفة']),
    quantity: colIndex(['quantity', 'qty', 'الكمية']),
    minQuantity: colIndex(['minquantity', 'min_quantity', 'الحد الأدنى']),
    unit: colIndex(['unit', 'الوحدة']),
  };

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitLine(lines[i]);
    rows.push({
      name: idx.name >= 0 ? cells[idx.name] : '',
      barcode: idx.barcode >= 0 ? cells[idx.barcode] : '',
      category: idx.category >= 0 ? cells[idx.category] : '',
      price: idx.price >= 0 ? cells[idx.price] : '0',
      cost: idx.cost >= 0 ? cells[idx.cost] : '0',
      quantity: idx.quantity >= 0 ? cells[idx.quantity] : '0',
      minQuantity: idx.minQuantity >= 0 ? cells[idx.minQuantity] : '',
      unit: idx.unit >= 0 ? cells[idx.unit] : 'piece',
    });
  }
  return rows;
}

/* ---------------- المنتجات ---------------- */
function listProducts(filters = {}) {
  const branch = getCurrentBranch();
  const search = String(filters.search || '').trim();
  const limit = Math.max(1, Math.min(Number(filters.limit) || (search ? 80 : 250), 500));

  let sql = `
    SELECT p.*, COALESCE(i.quantity, 0) AS stock,
           (SELECT COUNT(*) FROM products v WHERE v.parent_product_id = p.id AND v.is_active = 1) AS variant_count
    FROM products p
    LEFT JOIN inventory i ON i.product_id = p.id AND i.branch_id = ?
    WHERE p.is_active = 1`;
  const params = [branch.id];

  if (search) {
    // Exact identifiers first (barcode/SKU), then bounded name search.
    sql += ` AND (p.barcode = ? OR p.sku = ? OR p.name LIKE ?)`;
    params.push(search, search, `%${search}%`);
  } else if (filters.topLevelOnly) {
    // بدون بحث: نُخفي متغيرات الأزياء (مقاس/لون) من الشبكة الرئيسية، وتظهر فقط عبر نافذة اختيار المتغير
    sql += ` AND p.parent_product_id IS NULL`;
  }
  if (filters.categoryId) {
    sql += ` AND p.category_id = ?`;
    params.push(filters.categoryId);
  }
  sql += ' ORDER BY CASE WHEN p.barcode = ? THEN 0 WHEN p.sku = ? THEN 1 ELSE 2 END, p.name LIMIT ?';
  params.push(search, search, limit);
  return db.prepare(sql).all(...params);
}

// متغيرات منتج أساسي (المقاسات/الألوان المرتبطة به) مع كمية كل واحد في المخزون
function listProductVariants(parentId) {
  const branch = getCurrentBranch();
  return db
    .prepare(
      `SELECT p.*, COALESCE(i.quantity, 0) AS stock
       FROM products p
       LEFT JOIN inventory i ON i.product_id = p.id AND i.branch_id = ?
       WHERE p.parent_product_id = ? AND p.is_active = 1
       ORDER BY p.variant_size, p.variant_color`
    )
    .all(branch.id, parentId);
}

// قائمة المنتجات القابلة لتكون "أساسية" يُربَط بها متغيرات (تستثني نفسها ومنتجاتها الفرعية عند التعديل)
function listVariantParentOptions(excludeId) {
  let sql = `SELECT id, name FROM products WHERE is_active = 1 AND parent_product_id IS NULL`;
  const params = [];
  if (excludeId) {
    sql += ` AND id != ?`;
    params.push(excludeId);
  }
  sql += ' ORDER BY name';
  return db.prepare(sql).all(...params);
}

function getProduct(id) {
  const branch = getCurrentBranch();
  return db
    .prepare(
      `SELECT p.*, COALESCE(i.quantity, 0) AS stock, i.min_quantity
       FROM products p
       LEFT JOIN inventory i ON i.product_id = p.id AND i.branch_id = ?
       WHERE p.id = ?`
    )
    .get(branch.id, id);
}

// يبحث عن منتج "بيع بالوزن" بكود الـ PLU (المُضمَّن ببركود الميزان)
function getProductByPlu(pluCode) {
  const branch = getCurrentBranch();
  return db
    .prepare(
      `SELECT p.*, COALESCE(i.quantity, 0) AS stock, i.min_quantity
       FROM products p
       LEFT JOIN inventory i ON i.product_id = p.id AND i.branch_id = ?
       WHERE p.plu_code = ? AND p.is_weighted = 1 AND p.is_active = 1`
    )
    .get(branch.id, pluCode);
}

// نقطة الدخول الوحيدة من الواجهة عند مسح أي باركود بشاشة الكاشير: يحاول فك الباركود كباركود
// وزن (بادئة قابلة للتهيئة من الإعدادات)، ويعيد المنتج المطابق + الوزن المقروء جاهزَين للإضافة
// المباشرة للسلة دون أي إدخال يدوي من الكاشير. يُرجع null إن لم يكن باركود وزن أو لم يوجد الصنف.
function resolveGs1Barcode(barcode) {
  const parsed = parseGs1(barcode);
  if (!parsed) return null;
  const branch = getCurrentBranch();
  const gtin14 = parsed.gtin;
  const gtin13 = gtin14.slice(1);
  const product = db.prepare(`SELECT p.*, COALESCE(i.quantity,0) AS stock, i.min_quantity
    FROM products p LEFT JOIN inventory i ON i.product_id=p.id AND i.branch_id=?
    WHERE p.is_active=1 AND (p.barcode=? OR p.barcode=?) LIMIT 1`).get(branch.id, gtin14, gtin13);
  return product ? { product, ...parsed } : { product: null, ...parsed };
}

function resolveWeightedBarcode(barcode) {
  const prefix = getSetting('weighted_barcode_prefix', '20');
  const parsed = parseWeightedBarcode(barcode, prefix);
  if (!parsed) return null;

  const product = getProductByPlu(parsed.pluCode);
  if (!product) return null;

  return { product, weightKg: parsed.weightKg };
}

function assertUniqueProductIdentifiers({ sku, barcode, pluCode, excludeId = null }) {
  const cleanSku = String(sku ?? '').trim() || null;
  const cleanBarcode = String(barcode ?? '').trim() || null;
  // كود الـPLU يُخزَّن دائماً بصيغة 5 خانات بأصفار بادئة (نفس PLU_LENGTH المستخدم لفكّ باركود
  // الميزان في weighted-barcode.js). بدون هذا التطبيع، لو أدخل المدير "123" يدوياً بينما
  // الميزان يطبع الباركود بصيغة "00123"، فلن يجد getProductByPlu المنتج إطلاقاً عند المسح —
  // وهذا بالضبط ما كان يُفشل مسح منتجات الميزان بالكاشير.
  let cleanPlu = String(pluCode ?? '').trim() || null;
  if (cleanPlu) {
    if (!/^\d{1,5}$/.test(cleanPlu)) throw new Error('كود PLU يجب أن يكون أرقاماً فقط (حتى 5 خانات).');
    cleanPlu = cleanPlu.padStart(5, '0');
  }
  if (cleanSku) {
    const row = db.prepare('SELECT id FROM products WHERE sku = ? AND (? IS NULL OR id != ?) LIMIT 1').get(cleanSku, excludeId, excludeId);
    if (row) throw new Error(`رمز SKU مستخدم بالفعل: ${cleanSku}`);
  }
  if (cleanBarcode) {
    const row = db.prepare('SELECT id FROM products WHERE barcode = ? AND (? IS NULL OR id != ?) LIMIT 1').get(cleanBarcode, excludeId, excludeId);
    if (row) throw new Error(`الباركود مستخدم بالفعل: ${cleanBarcode}`);
  }
  if (cleanPlu) {
    const row = db.prepare('SELECT id FROM products WHERE plu_code = ? AND (? IS NULL OR id != ?) LIMIT 1').get(cleanPlu, excludeId, excludeId);
    if (row) throw new Error(`كود PLU مستخدم بالفعل: ${cleanPlu}`);
  }
  return { sku: cleanSku, barcode: cleanBarcode, pluCode: cleanPlu };
}

function parseNonNegativeNumber(value, fieldName, { optional = false, integer = false } = {}) {
  if (optional && (value === undefined || value === null || String(value).trim() === '')) return null;
  const raw = typeof value === 'string' ? value.trim() : value;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || (integer && !Number.isInteger(n))) {
    throw new Error(`${fieldName} غير صالح.`);
  }
  return n;
}

function createProduct(p) {
  const name = String(p?.name || '').trim();
  const price = parseNonNegativeNumber(p?.price ?? 0, 'السعر');
  const cost = parseNonNegativeNumber(p?.cost ?? 0, 'التكلفة');
  const taxRate = Number(p?.taxRate ?? 0);
  const initialStock = parseNonNegativeNumber(p?.initialStock ?? 0, 'المخزون الابتدائي');
  const minQuantity = parseNonNegativeNumber(p?.minQuantity ?? 0, 'الحد الأدنى للمخزون');
  if (!name) throw new Error('اسم المنتج مطلوب.');
  if (!Number.isFinite(taxRate) || taxRate < 0 || taxRate > 100) throw new Error('نسبة الضريبة غير صالحة.');
  const identifiers = assertUniqueProductIdentifiers({ sku: p?.sku, barcode: p?.barcode, pluCode: p?.pluCode });
  const info = db.transaction(() => {
    const result = db.prepare(
      `INSERT INTO products (uuid, sku, barcode, name, category_id, price, cost, tax_rate, unit, track_inventory, image_path, variant_size, variant_color, parent_product_id, is_recipe, is_weighted, plu_code)
       VALUES (@uuid, @sku, @barcode, @name, @category_id, @price, @cost, @tax_rate, @unit, @track_inventory, @image_path, @variant_size, @variant_color, @parent_product_id, @is_recipe, @is_weighted, @plu_code)`
    ).run({
      uuid: uuid(),
      sku: identifiers.sku,
      barcode: identifiers.barcode,
      name,
      category_id: p.categoryId || null,
      price,
      cost,
      tax_rate: taxRate,
      unit: String(p.unit || 'piece').trim() || 'piece',
      track_inventory: p.trackInventory === false ? 0 : 1,
      image_path: p.imagePath || null,
      variant_size: p.variantSize || null,
      variant_color: p.variantColor || null,
      parent_product_id: p.parentProductId || null,
      is_recipe: p.isRecipe ? 1 : 0,
      is_weighted: p.isWeighted ? 1 : 0,
      plu_code: identifiers.pluCode,
    });
    const branch = getCurrentBranch();
    db.prepare(`INSERT INTO inventory (branch_id, product_id, quantity, min_quantity) VALUES (?, ?, ?, ?)`)
      .run(branch.id, result.lastInsertRowid, initialStock, minQuantity);
    return result;
  })();
  return { id: info.lastInsertRowid };
}

const updateProductTx = db.transaction((p) => {
  const branch = getCurrentBranch();
  if (!branch) throw new Error('الفرع الحالي غير موجود.');
  const productId = Number(p?.id);
  if (!Number.isInteger(productId) || productId <= 0) throw new Error('معرّف المنتج غير صالح.');

  const name = String(p?.name || '').trim();
  if (!name) throw new Error('اسم المنتج مطلوب.');
  const price = parseNonNegativeNumber(p?.price ?? 0, 'السعر');
  const cost = parseNonNegativeNumber(p?.cost ?? 0, 'التكلفة');
  const taxRate = Number(p?.taxRate ?? 0);
  if (!Number.isFinite(taxRate) || taxRate < 0 || taxRate > 100) throw new Error('نسبة الضريبة غير صالحة.');
  const stock = p?.stock !== undefined ? parseNonNegativeNumber(p.stock, 'المخزون') : undefined;
  const minQuantity = p?.minQuantity !== undefined ? parseNonNegativeNumber(p.minQuantity, 'الحد الأدنى للمخزون') : undefined;
  const identifiers = assertUniqueProductIdentifiers({ sku: p?.sku, barcode: p?.barcode, pluCode: p?.pluCode, excludeId: productId });

  const existingProduct = db.prepare('SELECT id FROM products WHERE id = ? AND is_active = 1').get(productId);
  if (!existingProduct) throw new Error('المنتج غير موجود أو غير نشط.');

  const branchInventory = db.prepare('SELECT id, quantity, unit_cost, min_quantity FROM inventory WHERE branch_id = ? AND product_id = ?').get(branch.id, productId);
  const beforeQuantity = Number(branchInventory?.quantity || 0);

  db.prepare(
    `UPDATE products SET name=@name, price=@price, cost=@cost, tax_rate=@tax_rate,
      barcode=@barcode, sku=@sku, category_id=@category_id, unit=@unit,
      track_inventory=@track_inventory, image_path=@image_path,
      variant_size=@variant_size, variant_color=@variant_color, is_recipe=@is_recipe,
      parent_product_id=@parent_product_id, is_weighted=@is_weighted, plu_code=@plu_code,
      updated_at=datetime('now'), synced=0
     WHERE id=@id`
  ).run({
    id: productId, name, price, cost, tax_rate: taxRate, barcode: identifiers.barcode, sku: identifiers.sku,
    category_id: p.categoryId || null, unit: String(p.unit || 'piece').trim() || 'piece',
    track_inventory: p.trackInventory === false ? 0 : 1, image_path: p.imagePath || null,
    variant_size: p.variantSize || null, variant_color: p.variantColor || null, is_recipe: p.isRecipe ? 1 : 0,
    parent_product_id: p.parentProductId || null, is_weighted: p.isWeighted ? 1 : 0, plu_code: identifiers.pluCode,
  });

  if (stock !== undefined || minQuantity !== undefined) {
    if (branchInventory) {
      const sets = []; const params = {};
      if (stock !== undefined) { sets.push('quantity=@stock'); params.stock = stock; }
      if (minQuantity !== undefined) { sets.push('min_quantity=@minQuantity'); params.minQuantity = minQuantity; }
      params.id = branchInventory.id;
      db.prepare(`UPDATE inventory SET ${sets.join(', ')}, updated_at=datetime('now'), synced=0 WHERE id=@id`).run(params);
    } else {
      db.prepare(`INSERT INTO inventory (branch_id, product_id, quantity, min_quantity) VALUES (?, ?, ?, ?)`)
        .run(branch.id, productId, stock ?? 0, minQuantity ?? 0);
    }
    if (stock !== undefined && Math.abs(stock - beforeQuantity) > 0.000001) {
      const unitCost = Number(db.prepare('SELECT COALESCE(unit_cost, cost, 0) AS unit_cost FROM inventory JOIN products ON products.id = inventory.product_id WHERE inventory.branch_id=? AND inventory.product_id=?').get(branch.id, productId)?.unit_cost || 0);
      db.prepare(`INSERT INTO inventory_movements (uuid, branch_id, product_id, change_qty, reason, ref_id, notes, unit_cost_after, synced) VALUES (?, ?, ?, ?, 'adjustment', NULL, ?, ?, 0)`)
        .run(uuid(), branch.id, productId, stock - beforeQuantity, 'تعديل كمية من بطاقة المنتج', unitCost);
    }
  }
  return { success: true };
});

function updateProduct(p) {
  return updateProductTx(p);
}

function deleteProduct(id) {
  const productId = Number(id);
  if (!Number.isInteger(productId) || productId <= 0) throw new Error('معرّف المنتج غير صالح.');

  // products is the shared catalog; authorization is enforced by the manager/admin IPC gate.
  // Soft-delete keeps historical invoice references intact.
  db.prepare(`UPDATE products SET is_active = 0, updated_at = datetime('now'), synced = 0 WHERE id = ?`).run(productId);
  return { success: true };
}

/* ---------------- الحزم/الخصومات التجميعية (Bundles) ---------------- */
function listBundles() {
  const branch = getCurrentBranch();
  const bundles = db
    .prepare(`SELECT * FROM bundles WHERE branch_id = ? ORDER BY id DESC`)
    .all(branch.id);
  const itemsStmt = db.prepare(
    `SELECT bi.product_id, bi.quantity, p.name AS product_name, p.price
     FROM bundle_items bi JOIN products p ON p.id = bi.product_id
     WHERE bi.bundle_id = ?`
  );
  return bundles.map((b) => ({ ...b, items: itemsStmt.all(b.id) }));
}

// تُستدعى من شاشة الكاشير لجلب الحزم الفعّالة فقط، لمطابقتها مع محتوى السلة
function listActiveBundles() {
  return listBundles().filter((b) => b.is_active);
}

const saveBundleItemsTx = db.transaction((bundleId, items) => {
  db.prepare(`DELETE FROM bundle_items WHERE bundle_id = ?`).run(bundleId);
  const insert = db.prepare(`INSERT INTO bundle_items (bundle_id, product_id, quantity) VALUES (?, ?, ?)`);
  for (const it of items) {
    if (!it.productId || !(it.quantity > 0)) continue;
    insert.run(bundleId, it.productId, it.quantity);
  }
});

function createBundle(b) {
  const branch = getCurrentBranch();
  const info = db
    .prepare(
      `INSERT INTO bundles (uuid, branch_id, name, discount_type, discount_value, is_active)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(uuid(), branch.id, b.name, b.discountType || 'percent', b.discountValue || 0, b.isActive === false ? 0 : 1);
  saveBundleItemsTx(info.lastInsertRowid, b.items || []);
  return { success: true, id: info.lastInsertRowid };
}

function updateBundle(b) {
  const branch = getCurrentBranch();
  const target = db.prepare('SELECT id FROM bundles WHERE id = ? AND branch_id = ?').get(Number(b.id), branch.id);
  if (!target) throw new Error('الحزمة غير موجودة في الفرع الحالي.');
  db.prepare(
    `UPDATE bundles SET name = ?, discount_type = ?, discount_value = ?, is_active = ?, updated_at = datetime('now'), synced = 0
     WHERE id = ? AND branch_id = ?`
  ).run(b.name, b.discountType || 'percent', b.discountValue || 0, b.isActive === false ? 0 : 1, target.id, branch.id);
  if (b.items) saveBundleItemsTx(target.id, b.items);
  return { success: true };
}

function deleteBundle(id) {
  const branch = getCurrentBranch();
  const target = db.prepare('SELECT id FROM bundles WHERE id = ? AND branch_id = ?').get(Number(id), branch.id);
  if (!target) throw new Error('الحزمة غير موجودة في الفرع الحالي.');
  db.prepare(`DELETE FROM bundle_items WHERE bundle_id = ?`).run(target.id);
  db.prepare(`DELETE FROM bundles WHERE id = ? AND branch_id = ?`).run(target.id, branch.id);
  return { success: true };
}

/* ---------------- المبيعات ---------------- */
// أمان: لا نثق بأي سعر/ضريبة/إجمالي قادم من الواجهة (renderer). كل ما يُخزَّن يُعاد
// حسابه هنا من بيانات المنتج الفعلية في القاعدة والقواعد المسموحة للخصم، حتى لو
// عبثت الواجهة (مثلاً عبر DevTools) بالقيم قبل إرسالها لهذا الاستدعاء.
// يُسعِّر عناصر السلة من قاعدة البيانات مباشرة (لا يثق بأي سعر قادم من الواجهة)، ويتحقق من توفر
// مخزون كافٍ فقط للمنتجات "بكمية محددة" (track_inventory=1). المنتجات "المفتوحة" (بدون تتبع
// كمية — خدمات، أصناف بلا حدّ مخزون) تُستثنى بالكامل من هذا التحقق مهما كانت الكمية المطلوبة.
function priceItemsFromDatabase(items, branchId) {
  const getPrice = db.prepare(`SELECT p.id, p.price, p.cost, COALESCE(i.unit_cost, p.cost, 0) AS branch_cost, p.tax_rate, p.tax_profile_id, p.name, p.track_inventory, COALESCE(i.quantity, 0) AS available, tp.code AS tax_profile_code, tp.rate AS profile_rate, tp.is_inclusive AS profile_inclusive FROM products p LEFT JOIN inventory i ON i.product_id=p.id AND i.branch_id=? LEFT JOIN tax_profiles tp ON tp.id=p.tax_profile_id AND tp.branch_id=? AND tp.is_active=1 WHERE p.id=?`);
  const global=getGlobalProfile(); const minorUnit=Number(global?.currency_minor_unit ?? 2); let subtotalMinor=0; let taxTotalMinor=0; const priced=[]; const requestedByProduct=new Map();
  for(const item of items||[]){ const productId=Number(item.productId); const quantity=Number(item.quantity); if(!Number.isInteger(productId)||productId<=0) throw new Error('معرّف المنتج غير صالح.'); if(!(Number.isFinite(quantity)&&quantity>0)) throw new Error('كمية غير صالحة في السلة'); requestedByProduct.set(productId,(requestedByProduct.get(productId)||0)+quantity); }
  for(const [productId,requestedQty] of requestedByProduct){ const product=getPrice.get(branchId,branchId,productId); if(!product) throw new Error('منتج غير موجود ضمن السلة'); if(product.track_inventory&&product.available<requestedQty) throw new Error(`الكمية المتوفرة من "${product.name}" غير كافية (المتوفر: ${product.available}). فعّل "بيع مفتوح بدون تتبّع كمية" لهذا الصنف إن لم ترد التحقق من كميته.`); }
  for(const item of items||[]){ const product=getPrice.get(branchId,branchId,Number(item.productId)); const unitPriceMinor=money.toMinor(product.price,minorUnit); const unitCostMinor=money.toMinor(Math.max(0,Number(product.branch_cost??product.cost??0)),minorUnit); const taxRate=product.profile_rate==null?Number(product.tax_rate||0):Number(product.profile_rate); const inclusive=product.profile_rate!=null?Number(product.profile_inclusive)===1:global.tax_mode==='inclusive'; const lineGrossMinor=money.multiplyMinorQuantity(unitPriceMinor,Number(item.quantity)); const lineTaxMinor=money.taxMinor(lineGrossMinor,taxRate,inclusive); const lineNetMinor=inclusive?Math.max(0,lineGrossMinor-lineTaxMinor):lineGrossMinor; subtotalMinor+=lineNetMinor; taxTotalMinor+=lineTaxMinor; priced.push({productId:item.productId,quantity:Number(item.quantity),unitPrice:money.fromMinor(unitPriceMinor,minorUnit),unitPriceMinor,taxRate,taxProfileId:product.tax_profile_id||null,taxProfileCode:product.tax_profile_code||null,taxInclusive:inclusive,lineTotal:money.fromMinor(lineGrossMinor,minorUnit),lineTotalMinor:lineGrossMinor,notes:item.notes||null,costAtSale:money.fromMinor(unitCostMinor,minorUnit),costAtSaleMinor:unitCostMinor,trackInventory:Boolean(product.track_inventory)}); }
  return {priced,subtotalMinor,taxTotalMinor,subtotal:money.fromMinor(subtotalMinor,minorUnit),taxTotal:money.fromMinor(taxTotalMinor,minorUnit),minorUnit};
}

// يتحقق أن الخصم الإجمالي المطلوب لا يتجاوز حد الكاشير، إلا بموافقة مدير/مدير عام
// حقيقية (نتحقق من هوية الموافق في القاعدة، لا نثق بالـ id القادم من الواجهة فقط)
// يُرجع { discountTotal, discountApprovedBy } — يُصفّر معرّف الموافق إن لم يكن صالحاً فعلياً
function assertDiscountAllowed(subtotal, discountType, discountValue, discountApprovedBy) {
  const normalizedType = discountType == null || discountType === '' ? 'none' : String(discountType);
  const rawValue = Number(discountValue);
  if (!['none', 'percent', 'fixed'].includes(normalizedType)) throw new Error('نوع الخصم غير صالح.');
  if (!Number.isFinite(rawValue) || rawValue < 0) throw new Error('قيمة الخصم غير صالحة.');
  if (normalizedType === 'none' || rawValue <= 0 || subtotal <= 0) {
    return { discountTotal: 0, discountType: null, discountValue: 0, discountApprovedBy: null };
  }

  const requested = normalizedType === 'percent'
    ? subtotal * (Math.min(rawValue, 100) / 100)
    : Math.min(rawValue, subtotal);
  const capped = Math.max(0, Math.min(requested, subtotal));
  const maxPercent = getMaxCashierDiscountPercent();
  const effectivePercent = subtotal > 0 ? (capped / subtotal) * 100 : 0;
  if (effectivePercent <= maxPercent + 0.001) {
    return { discountTotal: capped, discountType: normalizedType, discountValue: rawValue, discountApprovedBy: null };
  }

  if (discountApprovedBy) {
    const branch = getCurrentBranch();
    const approver = db
      .prepare(`SELECT role, is_active FROM users WHERE id = ? AND branch_id = ?`)
      .get(discountApprovedBy, branch.id);
    if (approver && approver.is_active && ['admin', 'manager'].includes(approver.role)) {
      return { discountTotal: capped, discountType: normalizedType, discountValue: rawValue, discountApprovedBy };
    }
  }
  // لا موافقة صالحة: نُقلِّص الخصم إلى الحد الأقصى المسموح للكاشير، مهما كانت قيمة الواجهة.
  return { discountTotal: subtotal * (maxPercent / 100), discountType: normalizedType, discountValue: rawValue, discountApprovedBy: null };
}

function assertCreditSaleAllowed(sale) {
  if (sale.paymentMethod !== 'credit') return;
  if (!sale.customerId) throw new Error('البيع الآجل يتطلب اختيار عميل.');
  const branch = getCurrentBranch();
  const approver = sale.creditApprovedBy && db.prepare('SELECT role, is_active FROM users WHERE id = ? AND branch_id = ?').get(sale.creditApprovedBy, branch.id);
  if (!approver || !approver.is_active || !['admin', 'manager'].includes(approver.role)) {
    throw new Error('البيع الآجل يتطلب موافقة مدير أو مدير عام.');
  }
}

function getTerminalInvoiceToken() {
  const filePath = path.join(app.getPath('userData'), 'terminal-invoice-id.txt');
  try {
    if (fs.existsSync(filePath)) {
      const existing = fs.readFileSync(filePath, 'utf8').trim().toUpperCase();
      if (/^[A-Z0-9]{8}$/.test(existing)) return existing;
    }
  } catch (_) {}
  const token = crypto.randomBytes(6).toString('base64url').replace(/[^A-Z0-9]/gi, '').slice(0, 8).toUpperCase().padEnd(8, '0');
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, token, { mode: 0o600 });
  } catch (_) {}
  return token;
}

function nextInvoiceNumber() {
  const branch = getCurrentBranch();
  const year = new Date().getFullYear();
  const branchToken = String(branch.uuid || branch.id).replace(/[^a-z0-9]/gi, '').slice(0, 6).toUpperCase() || String(branch.id);
  const terminalToken = getTerminalInvoiceToken();
  const key = `invoice_sequence_${branch.uuid || branch.id}_${terminalToken}_${year}`;
  let next = Number(getSetting(key, '0')) + 1;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = `${branchToken}-${year}-${terminalToken}-${String(next).padStart(6, '0')}`;
    const collision = db.prepare('SELECT id FROM sales WHERE invoice_number = ? LIMIT 1').get(candidate);
    if (!collision) {
      setSetting(key, String(next));
      return candidate;
    }
    next += 1;
  }
  throw new Error('تعذّر توليد رقم فاتورة فريد على هذا الجهاز.');
}

function calculateBundleDiscountFromDatabase(items, bundleIds, branchId) {
  const ids = [...new Set((Array.isArray(bundleIds) ? bundleIds : []).map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))];
  if (!ids.length || !Array.isArray(items) || items.length === 0) return 0;

  const placeholders = ids.map(() => '?').join(',');
  const bundles = db.prepare(`SELECT * FROM bundles WHERE branch_id = ? AND is_active = 1 AND id IN (${placeholders}) ORDER BY id`).all(branchId, ...ids);
  const itemRows = db.prepare(`SELECT bi.bundle_id, bi.product_id, bi.quantity, p.price
    FROM bundle_items bi JOIN products p ON p.id = bi.product_id
    WHERE bi.bundle_id IN (${placeholders}) ORDER BY bi.bundle_id, bi.id`).all(...ids);
  const byBundle = new Map();
  for (const row of itemRows) {
    if (!byBundle.has(row.bundle_id)) byBundle.set(row.bundle_id, []);
    byBundle.get(row.bundle_id).push(row);
  }
  const remaining = new Map();
  for (const item of items) remaining.set(Number(item.productId), Number(item.quantity));

  let totalDiscount = 0;
  for (const bundle of bundles) {
    const bundleItems = byBundle.get(bundle.id) || [];
    if (!bundleItems.length) continue;
    let maxApplications = Infinity;
    for (const item of bundleItems) {
      const available = remaining.get(item.product_id) || 0;
      if (!(item.quantity > 0)) { maxApplications = 0; break; }
      maxApplications = Math.min(maxApplications, Math.floor(available / item.quantity));
    }
    if (!Number.isFinite(maxApplications) || maxApplications < 1) continue;

    const bundleSubtotalPerApp = bundleItems.reduce((sum, item) => sum + Number(item.price || 0) * Number(item.quantity), 0);
    const value = Number(bundle.discount_value) || 0;
    const discountPerApp = bundle.discount_type === 'fixed_price'
      ? Math.max(0, bundleSubtotalPerApp - value)
      : bundleSubtotalPerApp * (Math.min(Math.max(value, 0), 100) / 100);
    if (!(discountPerApp > 0)) continue;

    for (const item of bundleItems) {
      remaining.set(item.product_id, (remaining.get(item.product_id) || 0) - item.quantity * maxApplications);
    }
    totalDiscount += discountPerApp * maxApplications;
  }
  return Math.min(totalDiscount, Math.max(0, items.reduce((sum, item) => sum + Number(item.unitPrice || 0) * Number(item.quantity || 0), 0)));
}

function validatePaymentAmounts(total, paymentMethod, cashAmount, cardAmount, changeDue) {
  const t = Number(total);
  const cash = Number(cashAmount) || 0;
  const card = Number(cardAmount) || 0;
  const change = Number(changeDue) || 0;
  if (!Number.isFinite(t) || t < 0) throw new Error('إجمالي الفاتورة غير صالح.');
  if (!['cash', 'card', 'mixed', 'credit', 'store_credit'].includes(paymentMethod)) throw new Error('طريقة الدفع غير صالحة.');
  if ([cash, card, change].some((n) => !Number.isFinite(n) || n < 0)) throw new Error('بيانات الدفع غير صالحة.');

  if (paymentMethod === 'store_credit') {
    if (cash > 0.01 || card > 0.01 || change > 0.01) throw new Error('رصيد المتجر لا يقبل نقداً أو بطاقة في نفس العملية.');
    return;
  }
  if (paymentMethod === 'credit') {
    if (cash > 0.01 || card > 0.01 || change > 0.01) throw new Error('البيع الآجل لا يقبل دفعة نقدية أو بطاقة في نفس العملية.');
    return;
  }
  if (paymentMethod === 'cash') {
    if (cash + 0.01 < t) throw new Error('المبلغ النقدي غير كافٍ لتغطية إجمالي الفاتورة.');
    const expectedChange = Math.round((cash - t) * 100) / 100;
    if (Math.abs(change - expectedChange) > 0.01) throw new Error('الباقي النقدي غير مطابق للمبلغ المستلم.');
    return;
  }
  if (paymentMethod === 'card') {
    if (Math.abs(card - t) > 0.01 || cash > 0.01 || change > 0.01) throw new Error('مبلغ البطاقة غير متطابق مع إجمالي الفاتورة.');
    return;
  }
  if (Math.abs(cash + card - t) > 0.01 || change > 0.01) throw new Error('مبالغ الدفع المختلط غير متطابقة مع إجمالي الفاتورة.');
}

function validatePaymentAmountsMinor(totalMinor, paymentMethod, cashMinor, cardMinor, changeMinor) {
  const total = Number(totalMinor);
  const cash = Number(cashMinor) || 0;
  const card = Number(cardMinor) || 0;
  const change = Number(changeMinor) || 0;
  if (!Number.isInteger(total) || total < 0) throw new Error('إجمالي الفاتورة غير صالح.');
  if (!['cash', 'card', 'mixed', 'credit', 'store_credit'].includes(paymentMethod)) throw new Error('طريقة الدفع غير صالحة.');
  if ([cash, card, change].some((n) => !Number.isInteger(n) || n < 0)) throw new Error('بيانات الدفع غير صالحة.');
  if (paymentMethod === 'store_credit') {
    if (cash !== 0 || card !== 0 || change !== 0) throw new Error('رصيد المتجر لا يقبل نقداً أو بطاقة في نفس العملية.');
    return;
  }
  if (paymentMethod === 'credit') {
    if (cash !== 0 || card !== 0 || change !== 0) throw new Error('البيع الآجل لا يقبل دفعة نقدية أو بطاقة في نفس العملية.');
    return;
  }
  if (paymentMethod === 'cash') {
    if (cash < total) throw new Error('المبلغ النقدي غير كافٍ لتغطية إجمالي الفاتورة.');
    if (cash - total !== change) throw new Error('الباقي النقدي غير مطابق للمبلغ المستلم.');
    return;
  }
  if (paymentMethod === 'card') {
    if (card !== total || cash !== 0 || change !== 0) throw new Error('مبلغ البطاقة غير متطابق مع إجمالي الفاتورة.');
    return;
  }
  if (cash + card !== total || change !== 0) throw new Error('مبالغ الدفع المختلط غير متطابقة مع إجمالي الفاتورة.');
}

function postSaleAccountingInTransaction(sale, saleId, branchId) {
  const accountRows = db.prepare('SELECT id,code FROM accounting_accounts WHERE branch_id=? AND is_active=1 AND code IN (?,?,?,?,?,?,?,?,?)').all(branchId, '1000','1100','1200','1300','2100','2200','4000','4100','5000');
  const byCode = new Map(accountRows.map((row) => [String(row.code), Number(row.id)]));
  const requireAccount = (code) => { const id = byCode.get(code); if (!id) throw new Error(`الحساب المحاسبي ${code} غير موجود.`); return id; };
  const revenueMinor = Math.max(0, Number(sale.subtotalMinor || 0) - Number(sale.discountTotalMinor || 0) - Number(sale.bundleDiscountTotalMinor || 0));
  const taxMinor = Math.max(0, Number(sale.taxTotalMinor || 0));
  const deliveryMinor = Math.max(0, Number(sale.deliveryFeeMinor || 0));
  const costMinor = sale.items.reduce((sum, item) => sum + money.multiplyMinorQuantity(Number(item.costAtSaleMinor || 0), Number(item.quantity || 0)), 0);
  const lines = [];
  const totalDebit = Number(sale.grandTotalMinor || 0);
  if (sale.paymentMethod === 'mixed') {
    if (Number(sale.cashAmountMinor || 0) > 0) lines.push({ accountId: requireAccount('1000'), debitMinor: Number(sale.cashAmountMinor), creditMinor: 0, memo: `Cash settlement ${sale.invoiceNumber}` });
    if (Number(sale.cardAmountMinor || 0) > 0) lines.push({ accountId: requireAccount('1100'), debitMinor: Number(sale.cardAmountMinor), creditMinor: 0, memo: `Card settlement ${sale.invoiceNumber}` });
  } else {
    let settlementAccountCode = '1000';
    if (sale.paymentMethod === 'card') settlementAccountCode = '1100';
    else if (sale.paymentMethod === 'credit') settlementAccountCode = '1200';
    else if (sale.paymentMethod === 'store_credit') settlementAccountCode = '2200';
    if (totalDebit > 0) lines.push({ accountId: requireAccount(settlementAccountCode), debitMinor: totalDebit, creditMinor: 0, memo: `Settlement ${sale.invoiceNumber}` });
  }
  if (revenueMinor > 0) lines.push({ accountId: requireAccount('4000'), debitMinor: 0, creditMinor: revenueMinor, memo: `Sales revenue ${sale.invoiceNumber}` });
  if (deliveryMinor > 0) lines.push({ accountId: requireAccount('4100'), debitMinor: 0, creditMinor: deliveryMinor, memo: `Delivery revenue ${sale.invoiceNumber}` });
  if (taxMinor > 0) lines.push({ accountId: requireAccount('2100'), debitMinor: 0, creditMinor: taxMinor, memo: `Tax payable ${sale.invoiceNumber}` });
  if (costMinor > 0) {
    lines.push({ accountId: requireAccount('5000'), debitMinor: costMinor, creditMinor: 0, memo: `COGS ${sale.invoiceNumber}` });
    lines.push({ accountId: requireAccount('1300'), debitMinor: 0, creditMinor: costMinor, memo: `Inventory ${sale.invoiceNumber}` });
  }
  // Revenue/tax settlement plus COGS/inventory form one balanced journal only when both sides match.
  // The settlement debit is the gross sale total; the revenue side is net of discounts plus tax and delivery.
  // COGS creates an equal additional debit/credit pair.
  const operatingLines = lines;
  const operatingDebit = operatingLines.reduce((n, l) => n + Number(l.debitMinor || 0), 0);
  const operatingCredit = operatingLines.reduce((n, l) => n + Number(l.creditMinor || 0), 0);
  if (operatingDebit !== operatingCredit) throw new Error(`القيد المحاسبي غير متوازن للفواتير ${sale.invoiceNumber}.`);
  const entry = insertPostedJournalEntry({ branchId, memo: `Sale ${sale.invoiceNumber}`, referenceType: 'sale', referenceId: saleId, lines: operatingLines, createdBy: sale.userId || null });
  return entry;
}

// عملية بيع كاملة داخل transaction واحدة: تسجيل الفاتورة + البنود + خصم المخزون
const createSaleTx = db.transaction((sale) => {
  const branch = getCurrentBranch();
  if (sale.customerId != null) {
    const customer = db.prepare('SELECT id FROM customers WHERE id=? AND branch_id=?').get(Number(sale.customerId), branch.id);
    if (!customer) throw new Error('العميل غير موجود في الفرع الحالي.');
  }
  if (sale.tableId != null) {
    const table = db.prepare("SELECT id FROM restaurant_tables WHERE id=? AND branch_id=?").get(Number(sale.tableId), branch.id);
    if (!table) throw new Error('الطاولة غير موجودة في الفرع الحالي.');
  }
  if (sale.shiftId != null) {
    const shift = db.prepare("SELECT id,status FROM shifts WHERE id=? AND branch_id=?").get(Number(sale.shiftId), branch.id);
    if (!shift) throw new Error('جلسة الصندوق غير موجودة في الفرع الحالي.');
    if (shift.status !== 'open') throw new Error('جلسة الصندوق مغلقة.');
  }
  if (sale.userId != null) {
    const user = db.prepare('SELECT id,is_active FROM users WHERE id=? AND branch_id=?').get(Number(sale.userId), branch.id);
    if (!user || !user.is_active) throw new Error('المستخدم الحالي غير صالح.');
  }
  const clientRequestId = String(sale.clientRequestId || '').trim();
  if (clientRequestId) {
    const existing = db.prepare('SELECT id, uuid, invoice_number FROM sales WHERE branch_id=? AND client_request_id=?').get(branch.id, clientRequestId);
    if (existing) return { ...existing, idempotent: true };
  }
  const saleUuid = uuid();

  const { priced, subtotal, taxTotal, subtotalMinor, taxTotalMinor, minorUnit } = priceItemsFromDatabase(sale.items, branch.id);
  assertCreditSaleAllowed(sale);
  const bundleDiscountTotal = calculateBundleDiscountFromDatabase(priced, sale.bundleIds, branch.id);
  const { discountTotal, discountType, discountValue, discountApprovedBy } = assertDiscountAllowed(subtotal, sale.discountType, sale.discountValue, sale.discountApprovedBy);
  const discountTotalMinor = money.toMinor(discountTotal, minorUnit);
  const bundleDiscountTotalMinor = money.toMinor(bundleDiscountTotal, minorUnit);
  const rawDeliveryFee = Number(sale.deliveryFee) || 0;
  if (!Number.isFinite(rawDeliveryFee) || rawDeliveryFee < 0) throw new Error('رسوم التوصيل غير صالحة.');
  const deliveryFeeMinor = money.toMinor(rawDeliveryFee, minorUnit);
  const grandTotalMinor = Math.max(0, subtotalMinor + taxTotalMinor - discountTotalMinor - bundleDiscountTotalMinor + deliveryFeeMinor);
  const grandTotal = money.fromMinor(grandTotalMinor, minorUnit);
  const deliveryFee = money.fromMinor(deliveryFeeMinor, minorUnit);
  const discountTotalMajor = money.fromMinor(discountTotalMinor, minorUnit);
  const bundleDiscountTotalMajor = money.fromMinor(bundleDiscountTotalMinor, minorUnit);
  const notes = String(sale.notes || '').trim().slice(0, 500) || null;
  // وقت التسليم: فاضي/غير موجود = "الآن" (فوري). لو الكاشير حدد وقت مستقبلي، لازم
  // يكون تاريخ/وقت صالح فعلاً، وإلا نرفضه بدل ما نخزّن قيمة تالفة تكسر شاشة المطبخ.
  let deliveryTime = null;
  if (sale.orderType === 'delivery' && sale.deliveryTime) {
    const d = new Date(sale.deliveryTime);
    if (Number.isNaN(d.getTime())) throw new Error('وقت التسليم غير صالح.');
    deliveryTime = d.toISOString();
  }

  const paymentMethod = sale.paymentMethod || 'cash';
  const cashAmountMinor = money.toMinor(sale.cashAmount || 0, minorUnit);
  const cardAmountMinor = money.toMinor(sale.cardAmount || 0, minorUnit);
  const changeDueMinor = money.toMinor(sale.changeDue || 0, minorUnit);
  const dueAmountMinor = paymentMethod === 'credit' ? grandTotalMinor : 0;
  validatePaymentAmountsMinor(grandTotalMinor, paymentMethod, cashAmountMinor, cardAmountMinor, changeDueMinor);
  // Legacy major-unit validation remains as a compatibility guard for older callers.
  validatePaymentAmounts(grandTotal, paymentMethod, money.fromMinor(cashAmountMinor, minorUnit), money.fromMinor(cardAmountMinor, minorUnit), money.fromMinor(changeDueMinor, minorUnit));
  const cashAmount = money.fromMinor(cashAmountMinor, minorUnit);
  const cardAmount = money.fromMinor(cardAmountMinor, minorUnit);
  const changeDue = money.fromMinor(changeDueMinor, minorUnit);
  const dueAmount = money.fromMinor(dueAmountMinor, minorUnit);

  sale = { ...sale, subtotal, taxTotal, discountTotal: discountTotalMajor, discountType, discountValue, discountApprovedBy, bundleDiscountTotal: bundleDiscountTotalMajor, grandTotal, deliveryFee, notes, deliveryTime, items: priced, subtotalMinor, taxTotalMinor, discountTotalMinor, bundleDiscountTotalMinor, deliveryFeeMinor, grandTotalMinor, minorUnit, cashAmount, cashAmountMinor, cardAmount, cardAmountMinor, changeDue, changeDueMinor, dueAmount, dueAmountMinor };

  const invoiceNumber = nextInvoiceNumber();
  sale.invoiceNumber = invoiceNumber;
  const saleInfo = db.prepare(`
    INSERT INTO sales (
      uuid, branch_id, user_id, customer_id, table_id, shift_id, order_type,
      delivery_fee, delivery_fee_minor, delivery_person, notes, delivery_time,
      subtotal, subtotal_minor, tax_total, tax_total_minor,
      discount_total, discount_total_minor, discount_type, discount_value, discount_approved_by,
      bundle_discount_total, bundle_discount_total_minor,
      grand_total, grand_total_minor, payment_method,
      cash_amount, cash_amount_minor, card_amount, card_amount_minor,
      change_due, change_due_minor, due_amount, due_amount_minor,
      exchange_rate, invoice_number, payment_reference, payment_provider, payment_currency,
      client_request_id, loyalty_points_awarded, status
    ) VALUES (
      @uuid, @branch_id, @user_id, @customer_id, @table_id, @shift_id, @order_type,
      @delivery_fee, @delivery_fee_minor, @delivery_person, @notes, @delivery_time,
      @subtotal, @subtotal_minor, @tax_total, @tax_total_minor,
      @discount_total, @discount_total_minor, @discount_type, @discount_value, @discount_approved_by,
      @bundle_discount_total, @bundle_discount_total_minor,
      @grand_total, @grand_total_minor, @payment_method,
      @cash_amount, @cash_amount_minor, @card_amount, @card_amount_minor,
      @change_due, @change_due_minor, @due_amount, @due_amount_minor,
      @exchange_rate, @invoice_number, @payment_reference, @payment_provider, @payment_currency,
      @client_request_id, @loyalty_points_awarded, 'completed'
    )
  `).run({
    uuid: saleUuid,
    branch_id: branch.id,
    user_id: sale.userId || null,
    customer_id: sale.customerId || null,
    table_id: sale.tableId || null,
    shift_id: sale.shiftId || null,
    order_type: sale.orderType || 'in_store',
    delivery_fee: deliveryFee,
    delivery_fee_minor: deliveryFeeMinor,
    delivery_person: sale.deliveryPerson || null,
    notes: sale.notes,
    delivery_time: sale.deliveryTime,
    subtotal,
    subtotal_minor: subtotalMinor,
    tax_total: taxTotal,
    tax_total_minor: taxTotalMinor,
    discount_total: discountTotalMajor,
    discount_total_minor: discountTotalMinor,
    discount_type: sale.discountType || null,
    discount_value: sale.discountValue || 0,
    discount_approved_by: sale.discountApprovedBy || null,
    bundle_discount_total: bundleDiscountTotalMajor,
    bundle_discount_total_minor: bundleDiscountTotalMinor,
    grand_total: grandTotal,
    grand_total_minor: grandTotalMinor,
    payment_method: paymentMethod,
    cash_amount: cashAmount,
    cash_amount_minor: cashAmountMinor,
    card_amount: cardAmount,
    card_amount_minor: cardAmountMinor,
    change_due: changeDue,
    change_due_minor: changeDueMinor,
    due_amount: dueAmount,
    due_amount_minor: dueAmountMinor,
    exchange_rate: Math.max(0.000001, Number(sale.exchangeRate) || 1),
    invoice_number: invoiceNumber,
    payment_reference: String(sale.paymentReference || '').trim() || null,
    payment_provider: String(sale.paymentProvider || '').trim() || null,
    payment_currency: String(sale.paymentCurrency || getGlobalProfile().currency_code).trim().toUpperCase(),
    client_request_id: clientRequestId || null,
    loyalty_points_awarded: sale.customerId ? Math.floor(grandTotal / 10) : 0,
  });

  const saleId = saleInfo.lastInsertRowid;

  const insertItem = db.prepare(
    `INSERT INTO sale_items (uuid, sale_id, product_id, quantity, unit_price, unit_price_minor, tax_rate, tax_profile_id, tax_inclusive, discount, line_total, line_total_minor, notes, cost_at_sale, cost_at_sale_minor)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const updateStock = db.prepare(
    `UPDATE inventory SET quantity = quantity - ?, updated_at = datetime('now'), synced = 0
     WHERE branch_id = ? AND product_id = ?`
  );
  const logMovement = db.prepare(
    `INSERT INTO inventory_movements (uuid, branch_id, product_id, change_qty, reason, ref_id, unit_cost_after, synced)
     VALUES (?, ?, ?, ?, 'sale', ?, ?, 0)`
  );

  for (const item of sale.items) {
    insertItem.run(
      uuid(),
      saleId,
      item.productId,
      item.quantity,
      item.unitPrice,
      item.unitPriceMinor,
      item.taxRate || 0,
      item.taxProfileId || null,
      item.taxInclusive ? 1 : 0,
      item.discount || 0,
      item.lineTotal,
      item.lineTotalMinor,
      item.notes || null,
      item.costAtSale || 0,
      item.costAtSaleMinor
    );
    if (item.trackInventory) {
      const stockResult = updateStock.run(item.quantity, branch.id, item.productId);
      if (stockResult.changes !== 1) throw new Error('تعذّر تحديث مخزون المنتج أثناء البيع.');
      logMovement.run(uuid(), branch.id, item.productId, -item.quantity, saleId, item.costAtSale || 0);
    }
  }

  postSaleAccountingInTransaction(sale, saleId, branch.id);
  recordSyncOutboxEvent({ entityType: 'sale', entityUuid: saleUuid, operation: 'create', payload: { id: saleId, uuid: saleUuid, invoiceNumber } });

  if (sale.paymentMethod === 'store_credit') {
    if (!sale.customerId) throw new Error('الدفع برصيد المتجر يتطلب اختيار عميل.');
    const customer = db.prepare('SELECT store_credit_balance FROM customers WHERE id=? AND branch_id=?').get(sale.customerId, branch.id);
    if (!customer) throw new Error('العميل المحدد غير موجود.');
    if (Number(customer.store_credit_balance || 0) + 0.01 < sale.grandTotal) throw new Error('رصيد المتجر غير كافٍ.');
    appendStoreCreditLedger({ customerId: sale.customerId, saleId, entryType: 'sale_spend', amount: -sale.grandTotal, createdBy: sale.userId, branchId: branch.id });
  }

  // دفتر مدفوعات عالمي: يسجل طريقة/عملة/مبلغ العملية فقط ولا يخزن PAN أو بيانات البطاقة الحساسة.
  const paymentCurrency = String(sale.paymentCurrency || getGlobalProfile().currency_code).trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(paymentCurrency)) throw new Error('رمز عملة الدفع غير صالح. استخدم رمز ISO من 3 أحرف.');
  const insertPayment = db.prepare(`INSERT INTO payment_transactions(uuid,branch_id,sale_id,shift_id,method,currency_code,amount,amount_minor,exchange_rate,provider,provider_reference,external_id,masked_descriptor,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  if (sale.paymentMethod === 'store_credit') insertPayment.run(uuid(), branch.id, saleId, sale.shiftId || null, 'store_credit', paymentCurrency, -sale.grandTotal, -grandTotalMinor, 1, null, null, null, null, sale.userId || null);
  // تسجّل sales.cash_amount المبلغ المستلَم فعلياً، أما دفتر المدفوعات وحساب
  // الصندوق فيسجّلان الصافي الذي بقي في الصندوق بعد إعادة الباقي للعميل.
  else if (sale.paymentMethod === 'cash') insertPayment.run(uuid(), branch.id, saleId, sale.shiftId || null, 'cash', paymentCurrency, sale.grandTotal, grandTotalMinor, 1, null, null, null, null, sale.userId || null);
  else if (sale.paymentMethod === 'card') insertPayment.run(uuid(), branch.id, saleId, sale.shiftId || null, 'card', paymentCurrency, sale.grandTotal, grandTotalMinor, 1, sale.paymentProvider || null, sale.paymentReference || null, null, null, sale.userId || null);
  else if (sale.paymentMethod === 'mixed') {
    if (Number(sale.cashAmount) > 0) insertPayment.run(uuid(), branch.id, saleId, sale.shiftId || null, 'cash', paymentCurrency, sale.cashAmount, cashAmountMinor, 1, null, null, null, null, sale.userId || null);
    if (Number(sale.cardAmount) > 0) insertPayment.run(uuid(), branch.id, saleId, sale.shiftId || null, 'card', paymentCurrency, sale.cardAmount, cardAmountMinor, 1, sale.paymentProvider || null, sale.paymentReference || null, null, null, sale.userId || null);
  }

  // نقاط ولاء: نقطة واحدة لكل 10 وحدات عملة من إجمالي الفاتورة (قابلة للتعديل لاحقاً)
  if (sale.customerId) {
    const points = Math.floor(sale.grandTotal / 10);
    if (points > 0) {
      db.prepare(`UPDATE customers SET loyalty_points = loyalty_points + ?, updated_at = datetime('now'), synced = 0 WHERE id = ? AND branch_id=?`).run(
        points, sale.customerId, branch.id
      );
    }
  }

  if (dueAmount > 0) {
    const customer = db.prepare('SELECT balance FROM customers WHERE id=? AND branch_id=?').get(sale.customerId, branch.id);
    if (!customer) throw new Error('العميل المحدد غير موجود.');
    const balanceAfter = Number(customer.balance || 0) + dueAmount;
    db.prepare(`UPDATE customers SET balance = ?, updated_at = datetime('now'), synced = 0 WHERE id = ? AND branch_id=?`).run(balanceAfter, sale.customerId, branch.id);
    appendCustomerLedger({ customerId: sale.customerId, saleId, entryType: 'credit_sale', amount: dueAmount, balanceAfter, notes: `فاتورة ${invoiceNumber}` });
  }

  return { id: saleId, uuid: saleUuid, invoiceNumber };
});

function createSale(sale) {
  return createSaleTx(sale);
}

function listSales(filters = {}) {
  const branch = getCurrentBranch();
  let sql = `SELECT * FROM sales WHERE branch_id = ?`;
  const params = [branch.id];
  if (filters.from) {
    sql += ` AND created_at >= ?`;
    params.push(filters.from);
  }
  if (filters.to) {
    sql += ` AND created_at <= ?`;
    params.push(filters.to);
  }
  sql += ' ORDER BY created_at DESC LIMIT 200';
  return db.prepare(sql).all(...params);
}

// جلب فاتورة واحدة كاملة (رأس الفاتورة + بنودها + اسم المنتج) لغرض الطباعة/العرض
function getSale(id, branchId = null) {
  const sale = db
    .prepare(
      `SELECT s.*, c.name AS customer_name, c.phone AS customer_phone, t.name AS table_name
       FROM sales s
       LEFT JOIN customers c ON c.id = s.customer_id AND c.branch_id = s.branch_id
       LEFT JOIN restaurant_tables t ON t.id = s.table_id AND t.branch_id = s.branch_id
       WHERE s.id = ? AND (? IS NULL OR s.branch_id = ?)`
    )
    .get(id, branchId, branchId);
  if (!sale) return null;

  const items = db
    .prepare(
      `SELECT si.*, p.name AS product_name, p.unit
       FROM sale_items si
       JOIN products p ON p.id = si.product_id
       WHERE si.sale_id = ?
       ORDER BY si.id`
    )
    .all(id);

  const branch = db.prepare('SELECT * FROM branches WHERE id = ?').get(sale.branch_id);

  return { ...sale, items, branch };
}

/* ---------------- تحويلات المخزون بين الفروع ---------------- */
function listTransferBranches() {
  const current = getCurrentBranch();
  return db.prepare(`
    SELECT uuid, name, notes, CASE WHEN uuid=? THEN 1 ELSE 0 END AS is_current
    FROM branch_directory
    WHERE uuid <> ?
    UNION ALL
    SELECT uuid, name, address AS notes, 1 AS is_current
    FROM branches WHERE uuid=?
    ORDER BY is_current DESC, name
  `).all(current.uuid, current.uuid, current.uuid);
}

function upsertTransferBranch({ branchUuid, name, notes = null }) {
  const current = getCurrentBranch();
  const cleanUuid = String(branchUuid || '').trim();
  const cleanName = String(name || '').trim();
  if (!/^[A-Za-z0-9_-]{8,200}$/.test(cleanUuid)) throw new Error('معرّف الفرع غير صالح.');
  if (!cleanName || cleanName.length > 160) throw new Error('اسم الفرع مطلوب وطوله غير صالح.');
  if (cleanUuid === current.uuid) throw new Error('لا يمكن إضافة الفرع الحالي كفرع مستلم.');
  db.prepare(`INSERT INTO branch_directory(uuid,name,notes,updated_at) VALUES(?,?,?,datetime('now'))
    ON CONFLICT(uuid) DO UPDATE SET name=excluded.name,notes=excluded.notes,updated_at=datetime('now')`)
    .run(cleanUuid, cleanName, notes ? String(notes).trim().slice(0,500) : null);
  return db.prepare('SELECT * FROM branch_directory WHERE uuid=?').get(cleanUuid);
}

function getInventoryTransferByUuid(transferUuid) {
  const branch = getCurrentBranch();
  const transfer = db.prepare(`SELECT t.*, sb.name AS source_branch_name, dbb.name AS destination_branch_name,
    u.full_name AS created_by_name,
    CASE WHEN EXISTS(SELECT 1 FROM inventory_transfer_receipts r WHERE r.transfer_uuid=t.uuid) THEN 'received' ELSE t.status END AS effective_status
    FROM inventory_transfers t
    LEFT JOIN branches sb ON sb.uuid=t.source_branch_uuid
    LEFT JOIN branches dbb ON dbb.uuid=t.destination_branch_uuid
    LEFT JOIN users u ON u.id=t.created_by
    WHERE t.uuid=? AND t.local_branch_id=?`).get(String(transferUuid||''), branch.id);
  if (!transfer) return null;
  const items = db.prepare(`SELECT ti.*,p.name AS product_name,p.unit FROM inventory_transfer_items ti JOIN products p ON p.id=ti.product_id WHERE ti.transfer_id=? ORDER BY ti.id`).all(transfer.id);
  const receipt = db.prepare(`SELECT r.*,u.full_name AS received_by_name FROM inventory_transfer_receipts r LEFT JOIN users u ON u.id=r.received_by WHERE r.transfer_uuid=?`).get(transfer.uuid) || null;
  const receiptItems = receipt ? db.prepare('SELECT * FROM inventory_transfer_receipt_items WHERE receipt_id=? ORDER BY id').all(receipt.id) : [];
  return { ...transfer, items, receipt: receipt ? { ...receipt, items: receiptItems } : null };
}

function listInventoryTransfers(filters = {}) {
  const branch = getCurrentBranch();
  let sql = `SELECT t.*, sb.name AS source_branch_name, dbb.name AS destination_branch_name,
    CASE WHEN EXISTS(SELECT 1 FROM inventory_transfer_receipts r WHERE r.transfer_uuid=t.uuid) THEN 'received' ELSE t.status END AS effective_status
    FROM inventory_transfers t
    LEFT JOIN branches sb ON sb.uuid=t.source_branch_uuid
    LEFT JOIN branches dbb ON dbb.uuid=t.destination_branch_uuid
    WHERE t.local_branch_id=?`;
  const params=[branch.id];
  if (filters.status) sql += ' AND (CASE WHEN EXISTS(SELECT 1 FROM inventory_transfer_receipts r WHERE r.transfer_uuid=t.uuid) THEN \'received\' ELSE t.status END)=?', params.push(String(filters.status));
  sql += ' ORDER BY t.created_at DESC LIMIT 500';
  const rows=db.prepare(sql).all(...params);
  return rows.map((row)=>({ ...row, items: db.prepare(`SELECT ti.product_uuid,ti.quantity,p.name AS product_name,p.unit FROM inventory_transfer_items ti JOIN products p ON p.id=ti.product_id WHERE ti.transfer_id=? ORDER BY ti.id`).all(row.id) }));
}

const createInventoryTransferTx = db.transaction((payload = {}) => {
  const branch=getCurrentBranch();
  const destinationBranchUuid=String(payload.destinationBranchUuid||'').trim();
  if (!destinationBranchUuid || destinationBranchUuid === branch.uuid) throw new Error('فرع الاستلام غير صالح.');
  const destination=db.prepare('SELECT uuid,name FROM branch_directory WHERE uuid=?').get(destinationBranchUuid);
  if (!destination) throw new Error('فرع الاستلام غير موجود في قائمة الفروع المعروفة. أضفه أولاً من إعدادات التحويلات.');
  const rawItems=Array.isArray(payload.items)?payload.items:[];
  if (!rawItems.length) throw new Error('أضف منتجاً واحداً على الأقل للتحويل.');

  const merged=new Map();
  for (const raw of rawItems) {
    const productId=Number(raw.productId); const quantity=Number(raw.quantity);
    if (!Number.isInteger(productId) || productId<=0 || !Number.isFinite(quantity) || quantity<=0) throw new Error('بيانات منتج أو كمية غير صالحة.');
    merged.set(productId,(merged.get(productId)||0)+quantity);
  }

  const transferUuid=uuid();
  const result=db.prepare(`INSERT INTO inventory_transfers(uuid,source_branch_uuid,destination_branch_uuid,local_branch_id,status,notes,created_by,shipped_at,updated_at,synced)
    VALUES(?,?,?,?,?,?,?,?,datetime('now'),0)`).run(transferUuid,branch.uuid,destinationBranchUuid,branch.id,'shipped',payload.notes?String(payload.notes).trim().slice(0,1000):null,payload.createdBy||null,new Date().toISOString());
  const transferId=result.lastInsertRowid;
  const stockStmt=db.prepare('SELECT i.quantity,i.unit_cost FROM inventory i WHERE i.branch_id=? AND i.product_id=?');
  const productStmt=db.prepare('SELECT id,uuid,name,is_active,track_inventory FROM products WHERE id=?');
  const updateStock=db.prepare(`UPDATE inventory SET quantity=quantity-?,updated_at=datetime('now'),synced=0 WHERE branch_id=? AND product_id=? AND quantity>=?`);
  const itemStmt=db.prepare('INSERT INTO inventory_transfer_items(transfer_id,product_id,product_uuid,quantity,unit_cost) VALUES(?,?,?,?,?)');
  const movementStmt=db.prepare(`INSERT INTO inventory_movements(uuid,branch_id,product_id,change_qty,reason,ref_id,notes,unit_cost_after,synced) VALUES(?,?,?,?,?,?,?,?,0)`);
  for (const [productId,quantity] of merged.entries()) {
    const product=productStmt.get(productId);
    if (!product || !product.is_active || !product.track_inventory) throw new Error(`المنتج رقم ${productId} غير صالح للتحويل.`);
    const stock=stockStmt.get(branch.id,productId);
    const available=Number(stock?.quantity||0);
    if (available < quantity) throw new Error(`المخزون غير كافٍ للصنف: ${product.name}. المتاح ${available}.`);
    const changed=updateStock.run(quantity,branch.id,productId,quantity);
    if (!changed.changes) throw new Error(`تعذر حجز كمية الصنف: ${product.name}.`);
    itemStmt.run(transferId,productId,product.uuid,quantity,Number(stock?.unit_cost||product.cost||0));
    movementStmt.run(uuid(),branch.id,productId,-quantity,'transfer_out',transferId,`تحويل إلى الفرع ${destination.name}`,Number(stock?.unit_cost||product.cost||0));
  }
  return transferId;
});
function createInventoryTransfer(payload={}) { const id=createInventoryTransferTx(payload); const row=db.prepare('SELECT uuid FROM inventory_transfers WHERE id=?').get(id); return getInventoryTransferByUuid(row.uuid); }
const receiveInventoryTransferTx = db.transaction((payload = {}) => {
  const branch=getCurrentBranch();
  const transferUuid=String(payload.transferUuid||'').trim();
  const transfer=db.prepare('SELECT * FROM inventory_transfers WHERE uuid=? AND local_branch_id=?').get(transferUuid,branch.id);
  if (!transfer) throw new Error('التحويل غير موجود على هذا الفرع.');
  if (transfer.destination_branch_uuid !== branch.uuid) throw new Error('هذا الفرع ليس فرع الاستلام.');
  const exists=db.prepare('SELECT id FROM inventory_transfer_receipts WHERE transfer_uuid=?').get(transferUuid);
  if (exists) throw new Error('تم استلام هذا التحويل مسبقاً.');
  if (transfer.status === 'cancelled') throw new Error('لا يمكن استلام تحويل ملغى.');
  const items=db.prepare('SELECT ti.*,p.name,p.is_active,p.track_inventory FROM inventory_transfer_items ti JOIN products p ON p.uuid=ti.product_uuid WHERE ti.transfer_id=?').all(transfer.id);
  if (!items.length) throw new Error('التحويل لا يحتوي أصنافاً.');
  const receiptUuid=uuid();
  const receiptId=db.prepare(`INSERT INTO inventory_transfer_receipts(uuid,transfer_uuid,source_branch_uuid,destination_branch_uuid,local_branch_id,received_by,notes,synced)
    VALUES(?,?,?,?,?,?,?,0)`).run(receiptUuid,transfer.source_branch_uuid,transfer.destination_branch_uuid,branch.id,payload.receivedBy||null,payload.notes?String(payload.notes).trim().slice(0,1000):null).lastInsertRowid;
  const upsertInv=db.prepare(`INSERT INTO inventory(branch_id,product_id,quantity,unit_cost,min_quantity,updated_at,synced) VALUES(?,?,?,?,0,datetime('now'),0)
    ON CONFLICT(branch_id,product_id) DO UPDATE SET quantity=inventory.quantity+excluded.quantity,unit_cost=CASE WHEN excluded.unit_cost>0 THEN excluded.unit_cost ELSE inventory.unit_cost END,updated_at=datetime('now'),synced=0`);
  const receiptItem=db.prepare('INSERT INTO inventory_transfer_receipt_items(receipt_id,product_uuid,quantity_received) VALUES(?,?,?)');
  const movement=db.prepare(`INSERT INTO inventory_movements(uuid,branch_id,product_id,change_qty,reason,ref_id,notes,unit_cost_after,synced) VALUES(?,?,?,?,?,?,?,?,0)`);
  for(const item of items){
    if(!item.is_active || !item.track_inventory) throw new Error(`الصنف ${item.name} لم يعد صالحاً للاستلام.`);
    const qty=Number(item.quantity); if(!(qty>0)) continue;
    upsertInv.run(branch.id,item.product_id,qty,Number(item.unit_cost||0));
    receiptItem.run(receiptId,item.product_uuid,qty);
    movement.run(uuid(),branch.id,item.product_id,qty,'transfer_in',receiptId,`استلام تحويل ${transferUuid}`,Number(item.unit_cost||0));
  }
  db.prepare(`UPDATE inventory_transfers SET status='received',updated_at=datetime('now') WHERE id=?`).run(transfer.id);
  return receiptUuid;
});
function receiveInventoryTransfer(payload={}) {
  receiveInventoryTransferTx(payload);
  return getInventoryTransferByUuid(payload.transferUuid);
}

function cancelInventoryTransfer(transferUuid) {
  const branch=getCurrentBranch();
  return db.transaction(()=>{
    const transfer=db.prepare('SELECT * FROM inventory_transfers WHERE uuid=? AND local_branch_id=?').get(String(transferUuid||''),branch.id);
    if(!transfer) throw new Error('التحويل غير موجود.');
    if(transfer.source_branch_uuid!==branch.uuid) throw new Error('لا يمكن إلغاء تحويل ليس مرسلاً من هذا الفرع.');
    if(transfer.status!=='shipped') throw new Error('لا يمكن إلغاء تحويل تم استلامه أو إلغاؤه سابقاً.');
    if(Number(transfer.synced)!==0) throw new Error('تم إرسال التحويل إلى المزامنة؛ لا يمكن إلغاؤه الآن. أنشئ تحويلاً عكسياً بدلاً من تعديل السجل التاريخي.');
    if(db.prepare('SELECT 1 FROM inventory_transfer_receipts WHERE transfer_uuid=?').get(transfer.uuid)) throw new Error('لا يمكن إلغاء تحويل تم استلامه.');
    const items=db.prepare('SELECT * FROM inventory_transfer_items WHERE transfer_id=?').all(transfer.id);
    for(const item of items){
      db.prepare('UPDATE inventory SET quantity=quantity+?,updated_at=datetime(\'now\'),synced=0 WHERE branch_id=? AND product_id=?').run(item.quantity,branch.id,item.product_id);
      db.prepare(`INSERT INTO inventory_movements(uuid,branch_id,product_id,change_qty,reason,ref_id,notes,unit_cost_after,synced) VALUES(?,?,?,?,?,?,?,?,0)`).run(uuid(),branch.id,item.product_id,item.quantity,'transfer_cancel',transfer.id,`إلغاء تحويل ${transfer.uuid}`,item.unit_cost);
    }
    db.prepare(`UPDATE inventory_transfers SET status='cancelled',updated_at=datetime('now'),synced=0 WHERE id=?`).run(transfer.id);
    return getInventoryTransferByUuid(transfer.uuid);
  })();
}


/* ---------------- المخزون ---------------- */
// قائمة كل المنتجات التي تتبّع المخزون مع كمياتها، مرتبة بحيث تظهر المنتجات المنخفضة أولاً
function listInventory(filters = {}) {
  const branch = getCurrentBranch();
  let sql = `
    SELECT p.id, p.name, p.sku, p.barcode, p.unit, p.cost, cat.name AS category_name,
           COALESCE(i.quantity, 0) AS stock, COALESCE(i.min_quantity, 0) AS min_quantity,
           i.updated_at AS stock_updated_at
    FROM products p
    LEFT JOIN inventory i ON i.product_id = p.id AND i.branch_id = ?
    LEFT JOIN categories cat ON cat.id = p.category_id
    WHERE p.is_active = 1 AND p.track_inventory = 1`;
  const params = [branch.id];

  if (filters.search) {
    sql += ` AND (p.name LIKE ? OR p.barcode = ? OR p.sku = ?)`;
    params.push(`%${filters.search}%`, filters.search, filters.search);
  }
  if (filters.lowOnly) {
    sql += ` AND COALESCE(i.quantity, 0) <= COALESCE(i.min_quantity, 0)`;
  }
  sql += ' ORDER BY (COALESCE(i.quantity,0) <= COALESCE(i.min_quantity,0)) DESC, p.name';
  return db.prepare(sql).all(...params);
}

// تسوية/تعديل يدوي للمخزون (جرد، تالف، شراء بضاعة جديدة...) — عملية واحدة داخل transaction
const adjustInventoryTx = db.transaction((payload) => {
  const branch = getCurrentBranch();
  const product = db.prepare('SELECT id, is_active, track_inventory FROM products WHERE id=?').get(Number(payload.productId));
  if (!product || !product.is_active) throw new Error('المنتج غير موجود أو غير نشط.');
  const changeQty=Number(payload.changeQty);
  if (!Number.isFinite(changeQty) || changeQty===0) throw new Error('كمية التسوية غير صالحة.');
  const existing = db
    .prepare('SELECT id FROM inventory WHERE branch_id = ? AND product_id = ?')
    .get(branch.id, payload.productId);

  if (existing) {
    db.prepare(
      `UPDATE inventory SET quantity = quantity + ?, updated_at = datetime('now'), synced = 0
       WHERE branch_id = ? AND product_id = ?`
    ).run(changeQty, branch.id, payload.productId);
  } else {
    db.prepare(
      `INSERT INTO inventory (branch_id, product_id, quantity, min_quantity) VALUES (?, ?, ?, 0)`
    ).run(branch.id, payload.productId, changeQty);
  }

  db.prepare(
    `INSERT INTO inventory_movements (uuid, branch_id, product_id, change_qty, reason, ref_id, notes, synced)
     VALUES (?, ?, ?, ?, ?, NULL, ?, 0)`
  ).run(uuid(), branch.id, payload.productId, payload.changeQty, payload.reason || 'adjustment', payload.notes || null);

  return { success: true };
});

function adjustInventory(payload) {
  return adjustInventoryTx(payload);
}

function listInventoryMovements(filters = {}) {
  const branch = getCurrentBranch();
  let sql = `
    SELECT m.*, p.name AS product_name
    FROM inventory_movements m
    JOIN products p ON p.id = m.product_id
    WHERE m.branch_id = ?`;
  const params = [branch.id];
  if (filters.productId) {
    sql += ' AND m.product_id = ?';
    params.push(filters.productId);
  }
  sql += ' ORDER BY m.created_at DESC LIMIT 300';
  return db.prepare(sql).all(...params);
}

/* ---------------- التقارير ---------------- */
function dateRangeParams(range = {}) {
  // تقارير اليوم/الأسبوع/الشهر يجب أن تُفسَّر حسب المنطقة الزمنية للمؤسسة،
  // لا حسب UTC الخاص بعملية Electron. هذا يمنع انقسام يوم العمل عند منتصف الليل.
  const profile = getGlobalProfile();
  const timeZone = profile?.timezone || 'UTC';
  const localDate = (() => {
    try {
      return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    } catch (_) {
      return new Date().toISOString().slice(0, 10);
    }
  })();

  function zonedLocalToUtcSql(value, endOfDay = false) {
    const raw = String(value || '').trim();
    const match = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2}))?$/.exec(raw);
    if (!match) return raw;
    const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
    const hour = match[4] == null ? (endOfDay ? 23 : 0) : Number(match[4]);
    const minute = match[5] == null ? (endOfDay ? 59 : 0) : Number(match[5]);
    const second = match[6] == null ? (endOfDay ? 59 : 0) : Number(match[6]);
    const naive = Date.UTC(year, month - 1, day, hour, minute, second);
    let guess = naive;
    try {
      for (let i = 0; i < 4; i += 1) {
        const parts = new Intl.DateTimeFormat('en-US', {
          timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
        }).formatToParts(new Date(guess));
        const p = Object.fromEntries(parts.filter(x => x.type !== 'literal').map(x => [x.type, x.value]));
        const shownAsUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
        const offset = shownAsUtc - guess;
        guess = naive - offset;
      }
    } catch (_) {
      // إذا كانت المنطقة الزمنية غير صالحة نستخدم UTC كحل آمن ومتوقع.
      guess = naive;
    }
    const d = new Date(guess);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  }

  let from = range.from || `${localDate} 00:00:00`;
  let to = range.to || `${localDate} 23:59:59`;
  // شاشة التقارير ترسل تواريخ محلية على شكل YYYY-MM-DD؛ نحولها هنا إلى UTC.
  if (/^\d{4}-\d{2}-\d{2}(?:[ T]00:00:00)?$/.test(String(from))) from = zonedLocalToUtcSql(String(from).slice(0, 10), false);
  if (/^\d{4}-\d{2}-\d{2}(?:[ T]23:59:59)?$/.test(String(to))) to = zonedLocalToUtcSql(String(to).slice(0, 10), true);
  return { from, to, timeZone };
}

function getSalesSummary(range = {}) {
  const branch = getCurrentBranch();
  const { from, to } = dateRangeParams(range);

  const totals = db
    .prepare(
      `SELECT COUNT(*) AS count, COALESCE(SUM(subtotal),0) AS subtotal,
              COALESCE(SUM(tax_total),0) AS tax,
              COALESCE(SUM(discount_total + bundle_discount_total),0) AS discount,
              COALESCE(SUM(grand_total),0) AS total
       FROM sales
       WHERE branch_id = ? AND status IN ('completed','partially_refunded') AND created_at BETWEEN ? AND ?`
    )
    .get(branch.id, from, to);

  const byMethod = db
    .prepare(
      `SELECT payment_method, COUNT(*) AS count, COALESCE(SUM(grand_total),0) AS total
       FROM sales
       WHERE branch_id = ? AND status IN ('completed','partially_refunded') AND created_at BETWEEN ? AND ?
       GROUP BY payment_method`
    )
    .all(branch.id, from, to);

  const returns = db
    .prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(total_refunded),0) AS total
              FROM returns WHERE branch_id=? AND created_at BETWEEN ? AND ?`)
    .get(branch.id, from, to);

  return { ...totals, returnsCount: returns.count, returnsTotal: returns.total, byMethod, from, to };
}

// تُستخدم من تقرير الربح والخسارة لحساب إجمالي مصروف الرواتب الفعلي (للعاملين
// النشطين فقط، بما يطابق ما تعرضه شاشة الرواتب نفسها) خلال فترة التقرير. الراتب
// الشهري يُوزَّع على أيامه بالتناسب مع عدد الأيام المتداخلة بين الشهر وفترة التقرير،
// حتى لا يُحمَّل مدى جزئي (مثلاً أسبوع واحد) براتب الشهر كاملاً أو صفر منه.
function getPayrollExpenseForRange(fromLocalDate, toLocalDate) {
  const branch = getCurrentBranch();
  const parseLocal = (s) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''));
    return m ? { y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]) } : null;
  };
  const from = parseLocal(fromLocalDate);
  const to = parseLocal(toLocalDate);
  if (!from || !to) return 0;
  const fromUtc = Date.UTC(from.y, from.mo - 1, from.d);
  const toUtc = Date.UTC(to.y, to.mo - 1, to.d);
  if (toUtc < fromUtc) return 0;

  let total = 0;
  let cursor = new Date(Date.UTC(from.y, from.mo - 1, 1));
  const end = Date.UTC(to.y, to.mo - 1, 1);
  while (cursor.getTime() <= end) {
    const y = cursor.getUTCFullYear();
    const mo = cursor.getUTCMonth() + 1;
    const monthKey = `${y}-${String(mo).padStart(2, '0')}`;
    const monthRow = db.prepare('SELECT id FROM payroll_months WHERE branch_id=? AND month_key=?').get(branch.id, monthKey);
    if (monthRow) {
      const daysInMonth = daysInPayrollMonth(monthKey);
      const monthStartUtc = Date.UTC(y, mo - 1, 1);
      const monthEndUtc = Date.UTC(y, mo - 1, daysInMonth);
      const overlapStart = Math.max(fromUtc, monthStartUtc);
      const overlapEnd = Math.min(toUtc, monthEndUtc);
      const overlapDays = Math.floor((overlapEnd - overlapStart) / 86400000) + 1;
      if (overlapDays > 0) {
        const rows = db.prepare(`SELECT m.net_salary, e.is_active FROM payroll_employee_months m
          JOIN payroll_employees e ON e.id = m.employee_id
          WHERE m.month_id=? AND e.branch_id=?`).all(monthRow.id, branch.id);
        const monthTotal = rows.filter((r) => Number(r.is_active) !== 0).reduce((s, r) => s + Number(r.net_salary || 0), 0);
        total += monthTotal * (overlapDays / daysInMonth);
      }
    }
    cursor = new Date(Date.UTC(y, mo, 1));
  }
  return Math.round(total * 100) / 100;
}

// تقرير الربح والخسارة يحسب الإيراد قبل الضريبة من بيانات البيع التاريخية،
// ويوزع خصومات الفاتورة/الحزم على بنودها ثم يخصم المرتجعات في تاريخ حدوثها.
function getProfitLoss(range = {}) {
  const branch = getCurrentBranch();
  const { from, to } = dateRangeParams(range);
  const itemRows = db.prepare(`
    SELECT s.id AS sale_id, s.subtotal, s.tax_total, s.discount_total, s.bundle_discount_total,
           si.id AS sale_item_id, si.product_id, si.quantity, si.line_total, si.tax_rate,
           si.tax_inclusive, si.cost_at_sale, p.name AS product_name
    FROM sale_items si
    JOIN sales s ON s.id=si.sale_id
    JOIN products p ON p.id=si.product_id
    WHERE s.branch_id=? AND s.status IN ('completed','partially_refunded') AND s.created_at BETWEEN ? AND ?
    ORDER BY s.id, si.id`).all(branch.id, from, to);

  const salesMap = new Map();
  for (const row of itemRows) {
    if (!salesMap.has(row.sale_id)) salesMap.set(row.sale_id, []);
    const rows = salesMap.get(row.sale_id);
    const gross = Math.max(0, Number(row.line_total || 0));
    const rate = Math.max(0, Number(row.tax_rate || 0));
    const inclusive = Number(row.tax_inclusive) === 1;
    const net = inclusive ? gross / (1 + rate / 100) : gross;
    rows.push({ ...row, gross, net, qty: Number(row.quantity || 0), cost: Math.max(0, Number(row.cost_at_sale || 0)) });
  }

  let revenue = 0;
  let cost = 0;
  let discountTotal = 0;
  const byProductMap = new Map();

  for (const [saleId, rows] of salesMap) {
    const totalNet = rows.reduce((sum, r) => sum + r.net, 0);
    const pool = Math.max(0, Math.min(totalNet, Number(rows[0].discount_total || 0) + Number(rows[0].bundle_discount_total || 0)));
    discountTotal += pool;
    for (const row of rows) {
      const allocated = totalNet > 0 ? pool * (row.net / totalNet) : 0;
      const netAfterDiscount = Math.max(0, row.net - allocated);
      revenue += row.net;
      cost += row.qty * row.cost;
      const current = byProductMap.get(row.product_id) || { id: row.product_id, name: row.product_name, qty: 0, revenue: 0, cost: 0 };
      current.qty += row.qty;
      current.revenue += netAfterDiscount;
      current.cost += row.qty * row.cost;
      byProductMap.set(row.product_id, current);
    }
  }

  const returnRows = db.prepare(`
    SELECT ri.sale_item_id, ri.quantity, r.total_refunded, r.created_at,
           si.sale_id, si.product_id, si.quantity AS sold_quantity, si.line_total, si.tax_rate, si.tax_inclusive, si.cost_at_sale,
           s.subtotal, s.tax_total, s.discount_total, s.bundle_discount_total,
           (SELECT COALESCE(SUM(CASE WHEN COALESCE(s2.tax_inclusive,0)=1
                                      THEN s2.line_total/(1+s2.tax_rate/100)
                                      ELSE s2.line_total END),0)
            FROM sale_items s2 WHERE s2.sale_id=s.id) AS sale_net_before_discount
    FROM return_items ri
    JOIN returns r ON r.id=ri.return_id
    JOIN sale_items si ON si.id=ri.sale_item_id
    JOIN sales s ON s.id=si.sale_id
    WHERE r.branch_id=? AND r.created_at BETWEEN ? AND ?`).all(branch.id, from, to);

  let returnsRevenue = 0;
  let returnsCost = 0;
  for (const row of returnRows) {
    const qty = Math.max(0, Number(row.quantity || 0));
    const soldQty = Number(row.sold_quantity || 0);
    const itemGross = Math.max(0, Number(row.line_total || 0));
    const rate = Math.max(0, Number(row.tax_rate || 0));
    const itemNet = Number(row.tax_inclusive) === 1 ? itemGross / (1 + rate / 100) : itemGross;
    const saleNet = Math.max(0, Number(row.sale_net_before_discount || 0));
    const discountPool = Math.max(0, Math.min(saleNet, Number(row.discount_total || 0) + Number(row.bundle_discount_total || 0)));
    const allocated = saleNet > 0 ? discountPool * (itemNet / saleNet) : 0;
    const unitNetAfterDiscount = soldQty > 0 ? Math.max(0, itemNet - allocated) / soldQty : 0;
    const refundNetRevenue = qty * unitNetAfterDiscount;
    returnsRevenue += refundNetRevenue;
    returnsCost += qty * Math.max(0, Number(row.cost_at_sale || 0));
    const productId = Number(row.product_id);
    const current = byProductMap.get(productId);
    if (current) {
      current.revenue -= refundNetRevenue;
      current.cost -= qty * Math.max(0, Number(row.cost_at_sale || 0));
      current.qty = Math.max(0, current.qty - qty);
    }
  }

  const netRevenue = revenue - discountTotal - returnsRevenue;
  const netCost = cost - returnsCost;
  const grossProfit = netRevenue - netCost;
  const marginPercent = netRevenue > 0 ? (grossProfit / netRevenue) * 100 : 0;
  const byProduct = [...byProductMap.values()]
    .map((r) => ({ ...r, revenue: Math.max(0, r.revenue), cost: Math.max(0, r.cost), profit: Math.max(0, r.revenue) - Math.max(0, r.cost) }))
    .sort((a, b) => b.profit - a.profit);

  // نحسب مصروف الرواتب على التواريخ المحلية كما أدخلها المستخدم في شاشة التقارير
  // (وليس تواريخ from/to أعلاه بعد تحويلها لـ UTC)، لأن شهر الرواتب (month_key)
  // مبني أصلاً على التقويم المحلي للمنشأة.
  const profile = getGlobalProfile();
  const timeZone = profile?.timezone || 'UTC';
  const todayLocal = (() => {
    try { return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
    catch (_) { return new Date().toISOString().slice(0, 10); }
  })();
  const fromLocal = range.from ? String(range.from).slice(0, 10) : todayLocal;
  const toLocal = range.to ? String(range.to).slice(0, 10) : todayLocal;
  const payrollExpense = getPayrollExpenseForRange(fromLocal, toLocal);
  const netProfit = grossProfit - payrollExpense;

  return {
    from,
    to,
    revenue,
    discountTotal,
    netRevenue,
    cost: netCost,
    returnsRevenue,
    returnsCost,
    grossProfit,
    payrollExpense,
    netProfit,
    marginPercent,
    byProduct,
  };
}

// "الأكثر مبيعاً" يعني الأكثر كمية مباعة فعلياً (قطعة/وحدة)، لا الأكثر إيراداً — منتج رخيص
// يُباع بكثرة يجب أن يظهر قبل منتج غالٍ نادر البيع. كما نطرح الكميات المرتجعة من كل بند
// حتى لا تُحتسب وحدات أُعيدت لاحقاً ضمن "الأكثر مبيعاً".
function getTopProducts(range = {}) {
  const branch = getCurrentBranch();
  const { from, to } = dateRangeParams(range);
  const limit = range.limit || 10;

  return db
    .prepare(
      `SELECT p.id, p.name,
              COALESCE(SUM(si.quantity - COALESCE(ret.ret_qty,0)),0) AS qty,
              COALESCE(SUM(si.line_total - COALESCE(ret.ret_amount,0)),0) AS total
       FROM sale_items si
       JOIN sales s ON s.id = si.sale_id
       JOIN products p ON p.id = si.product_id
       LEFT JOIN (
         SELECT ri.sale_item_id, SUM(ri.quantity) AS ret_qty, SUM(ri.refund_amount) AS ret_amount
         FROM return_items ri
         JOIN returns r ON r.id = ri.return_id
         WHERE r.branch_id = ?
         GROUP BY ri.sale_item_id
       ) ret ON ret.sale_item_id = si.id
       WHERE s.branch_id = ? AND s.status IN ('completed','partially_refunded') AND s.created_at BETWEEN ? AND ?
       GROUP BY p.id
       HAVING qty > 0
       ORDER BY qty DESC
       LIMIT ?`
    )
    .all(branch.id, branch.id, from, to, limit);
}

function getDailySales(range = {}) {
  const branch = getCurrentBranch();
  const { from, to } = dateRangeParams(range);

  return db
    .prepare(
      `SELECT date(created_at) AS day, COUNT(*) AS count, COALESCE(SUM(grand_total),0) AS total
       FROM sales
       WHERE branch_id = ? AND status IN ('completed','partially_refunded') AND created_at BETWEEN ? AND ?
       GROUP BY day
       ORDER BY day`
    )
    .all(branch.id, from, to);
}

// قائمة الفواتير ضمن فترة معينة (رقم الفاتورة، التاريخ، العميل، طريقة الدفع، الإجمالي...)
// تُستخدم في شاشة التقارير لعرض كل فاتورة على حدة، مع إمكانية البحث برقم الفاتورة
function getInvoiceList(range = {}) {
  const branch = getCurrentBranch();
  const { from, to } = dateRangeParams(range);
  const limit = Math.min(Number(range.limit) || 200, 500);
  const search = String(range.search || '').trim();

  let sql = `SELECT s.id, s.invoice_number, s.created_at, s.payment_method, s.status,
                    s.subtotal, s.tax_total, s.discount_total, s.grand_total, s.due_amount,
                    c.name AS customer_name
             FROM sales s LEFT JOIN customers c ON c.id = s.customer_id
             WHERE s.branch_id = ? AND s.created_at BETWEEN ? AND ?`;
  const params = [branch.id, from, to];
  if (search) {
    sql += ` AND s.invoice_number LIKE ?`;
    params.push(`%${search}%`);
  }
  sql += ` ORDER BY s.created_at DESC, s.id DESC LIMIT ?`;
  params.push(limit);

  return db.prepare(sql).all(...params);
}

/* ---------------- العملاء ---------------- */
function listCustomers(filters = {}) {
  const branch = getCurrentBranch();
  const search = String(filters.search || '').trim();
  const limit = Math.max(1, Math.min(Number(filters.limit) || (search ? 40 : 250), 500));
  let sql = `SELECT * FROM customers WHERE branch_id=?`;
  const params = [branch.id];
  if (search) {
    sql += ` AND (name LIKE ? OR phone LIKE ?)`;
    params.push(`%${search}%`, `${search}%`);
  }
  sql += ' ORDER BY name LIMIT ?';
  params.push(limit);
  return db.prepare(sql).all(...params);
}

function getCustomer(id) {
  const branch = getCurrentBranch();
  return db.prepare('SELECT * FROM customers WHERE id=? AND branch_id=?').get(Number(id), branch.id);
}

function createCustomer(c) {
  const branch = getCurrentBranch();
  const info = db.prepare(`INSERT INTO customers (uuid,branch_id,name,phone,loyalty_points) VALUES (?,?,?,?,0)`)
    .run(uuid(), branch.id, c.name || null, c.phone || null);
  return { id: info.lastInsertRowid };
}

function updateCustomer(c) {
  const branch = getCurrentBranch();
  const result = db.prepare(`UPDATE customers SET name=?,phone=?,updated_at=datetime('now'),synced=0 WHERE id=? AND branch_id=?`)
    .run(c.name || null, c.phone || null, Number(c.id), branch.id);
  if (!result.changes) throw new Error('العميل غير موجود في الفرع الحالي.');
  return { success: true };
}

function appendStoreCreditLedger({ customerId, saleId = null, returnId = null, entryType, amount, createdBy = null, branchId = null }) {
  const branch = Number(branchId || getCurrentBranch().id);
  const customer = db.prepare('SELECT id FROM customers WHERE id=? AND branch_id=?').get(Number(customerId), branch);
  if (!customer) throw new Error('العميل غير موجود في الفرع الحالي.');
  const delta = Math.round(Number(amount) * 100) / 100;
  if (!Number.isFinite(delta) || delta === 0) throw new Error('حركة رصيد المتجر غير صالحة.');
  const result = db.prepare(`INSERT INTO store_credit_ledger(uuid,branch_id,customer_id,sale_id,return_id,entry_type,amount,created_by,synced) VALUES(?,?,?,?,?,?,?,?,0)`).run(uuid(), branch, Number(customerId), saleId, returnId, entryType, delta, createdBy || null);
  const balance = db.prepare('SELECT COALESCE(SUM(amount),0) AS balance FROM store_credit_ledger WHERE branch_id=? AND customer_id=?').get(branch, Number(customerId)).balance;
  db.prepare(`UPDATE customers SET store_credit_balance=?,updated_at=datetime('now'),synced=0 WHERE id=? AND branch_id=?`).run(Math.round(Number(balance)*100)/100, Number(customerId), branch);
  return { id: result.lastInsertRowid, balance: Math.round(Number(balance)*100)/100 };
}

function recalcStoreCreditBalance(customerId, branchId = null, touchSync = false) {
  const branch = Number(branchId || getCurrentBranch().id);
  const balance = db.prepare('SELECT COALESCE(SUM(amount),0) AS balance FROM store_credit_ledger WHERE branch_id=? AND customer_id=?').get(branch, Number(customerId)).balance;
  const rounded = Math.round(Number(balance || 0) * 100) / 100;
  if (touchSync) db.prepare(`UPDATE customers SET store_credit_balance=?,updated_at=datetime('now'),synced=0 WHERE id=? AND branch_id=?`).run(rounded,Number(customerId),branch);
  else db.prepare(`UPDATE customers SET store_credit_balance=? WHERE id=? AND branch_id=?`).run(rounded,Number(customerId),branch);
  return rounded;
}

function recalcCustomerBalance(customerId) {
  const branch = getCurrentBranch();
  if (!db.prepare('SELECT 1 FROM customers WHERE id=? AND branch_id=?').get(Number(customerId), branch.id)) throw new Error('العميل غير موجود في الفرع الحالي.');
  const result = db.prepare(`SELECT COALESCE(SUM(amount),0) AS balance FROM customer_ledger WHERE customer_id=? AND branch_id=?`).get(Number(customerId), branch.id);
  const balance = Math.round(Number(result?.balance || 0) * 100) / 100;
  db.prepare(`UPDATE customers SET balance=?,updated_at=datetime('now'),synced=0 WHERE id=? AND branch_id=?`).run(balance, Number(customerId), branch.id);
  return balance;
}

function appendCustomerLedger({ customerId, saleId = null, entryType, amount, balanceAfter, notes = null, branchId = null }) {
  const branch = Number(branchId || getCurrentBranch().id);
  if (!db.prepare('SELECT 1 FROM customers WHERE id=? AND branch_id=?').get(Number(customerId), branch)) throw new Error('العميل غير موجود في الفرع الحالي.');
  const ledgerUuid = uuid();
  db.prepare(`INSERT INTO customer_ledger (uuid,branch_id,customer_id,sale_id,entry_type,amount,balance_after,notes,synced) VALUES (?,?,?,?,?,?,?,?,0)`)
    .run(ledgerUuid, branch, Number(customerId), saleId, entryType, Number(amount), Number(balanceAfter), notes);
  return ledgerUuid;
}

function getCustomerLedger(customerId) {
  const branch = getCurrentBranch();
  if (!db.prepare('SELECT 1 FROM customers WHERE id=? AND branch_id=?').get(Number(customerId), branch.id)) throw new Error('العميل غير موجود في الفرع الحالي.');
  return db.prepare(`SELECT l.*,s.invoice_number FROM customer_ledger l LEFT JOIN sales s ON s.id=l.sale_id WHERE l.customer_id=? AND l.branch_id=? ORDER BY l.created_at DESC,l.id DESC`).all(Number(customerId), branch.id);
}

const receiveCustomerPaymentTx = db.transaction((payload) => {
  const amount = Number(payload.amount);
  if (!(amount > 0)) throw new Error('مبلغ التسديد غير صالح.');
  const branch = getCurrentBranch();
  const customer = db.prepare('SELECT balance FROM customers WHERE id=? AND branch_id=?').get(Number(payload.customerId), branch.id);
  if (!customer) throw new Error('العميل غير موجود في الفرع الحالي.');
  const balanceAfter = Math.max(0, Number(customer.balance || 0) - amount);
  const applied = Number(customer.balance || 0) - balanceAfter;
  if (!(applied > 0)) throw new Error('لا يوجد رصيد مستحق على هذا العميل.');
  const paymentMethod = String(payload.paymentMethod || 'cash').trim();
  if (!['cash', 'card'].includes(paymentMethod)) throw new Error('طريقة تسديد دين العميل غير صالحة.');
  db.prepare(`UPDATE customers SET balance=?,updated_at=datetime('now'),synced=0 WHERE id=? AND branch_id=?`).run(balanceAfter, Number(payload.customerId), branch.id);
  appendCustomerLedger({ customerId: payload.customerId, entryType: 'payment', amount: -applied, balanceAfter, notes: payload.notes || 'تسديد دين' });
  const currency = String(getGlobalProfile().currency_code || 'USD').trim().toUpperCase();
  const shiftId = payload.shiftId || null;
  db.prepare(`INSERT INTO payment_transactions(uuid,branch_id,shift_id,method,currency_code,amount,exchange_rate,external_id,masked_descriptor,created_by) VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .run(uuid(), branch.id, shiftId, paymentMethod, currency, applied, 1, `customer-payment:${payload.customerId}`, 'تسديد دين عميل', payload.userId || null);
  let cashMovementRecorded = false;
  if (paymentMethod === 'cash' && shiftId) {
    const shift = db.prepare("SELECT id FROM shifts WHERE id=? AND branch_id=? AND status='open'").get(shiftId, branch.id);
    if (!shift) throw new Error('جلسة الصندوق المحددة مغلقة أو لا تخص الفرع الحالي.');
    db.prepare(`INSERT INTO cash_movements(uuid,branch_id,shift_id,type,amount,reason,reference,created_by) VALUES(?,?,?,?,?,?,?,?)`)
      .run(uuid(), branch.id, shiftId, 'cash_in', applied, 'تسديد دين عميل', `customer:${payload.customerId}`, payload.userId || null);
    cashMovementRecorded = true;
  }
  return { success: true, applied, balanceAfter, cashMovementRecorded };
});
function receiveCustomerPayment(payload) { return receiveCustomerPaymentTx(payload); }
function getDebtAging() {
  const branch = getCurrentBranch();
  return db.prepare(`SELECT c.id,c.name,c.phone,c.balance,
    MIN(CASE WHEN l.entry_type='credit_sale' THEN l.created_at END) AS oldest_debt_at,
    CAST(julianday('now')-julianday(MIN(CASE WHEN l.entry_type='credit_sale' THEN l.created_at END)) AS INTEGER) AS age_days
    FROM customers c LEFT JOIN customer_ledger l ON l.customer_id=c.id AND l.branch_id=c.branch_id
    WHERE c.branch_id=? AND c.balance>0 GROUP BY c.id ORDER BY age_days DESC,c.balance DESC`).all(branch.id);
}

/* ---------------- الموردون وفواتير الشراء ---------------- */
function listSuppliers() { const b=getCurrentBranch(); return db.prepare('SELECT * FROM suppliers WHERE branch_id=? ORDER BY name').all(b.id); }
function createSupplier(s) {
  const b=getCurrentBranch();
  const name = String(s?.name || '').trim();
  if (!name) throw new Error('اسم المورد مطلوب.');
  const info = db.prepare(`INSERT INTO suppliers (uuid, branch_id, name, phone, address, notes, synced) VALUES (?, ?, ?, ?, ?, ?, 0)`)
    .run(uuid(), b.id, name, s.phone || null, s.address || null, s.notes || null);
  return { id: info.lastInsertRowid };
}
function updateSupplier(s) {
  if (!String(s.name || '').trim()) throw new Error('اسم المورد مطلوب.');
  const b=getCurrentBranch();
  const result=db.prepare(`UPDATE suppliers SET name=?,phone=?,address=?,notes=?,updated_at=datetime('now'),synced=0 WHERE id=? AND branch_id=?`)
    .run(s.name.trim(),s.phone||null,s.address||null,s.notes||null,Number(s.id),b.id);
  if(!result.changes) throw new Error('المورد غير موجود في الفرع الحالي.');
  return { success: true };
}
function createPurchaseOrder(order) {
  if (!order.supplierId || !Array.isArray(order.items) || !order.items.length) throw new Error('اختر المورد وأضف بند شراء واحداً على الأقل.');
  const branch = getCurrentBranch();
  const items = order.items.map((i) => ({ productId: Number(i.productId), quantity: Number(i.quantity), unitCost: Number(i.unitCost) }));
  if (items.some((i) => !i.productId || !(i.quantity > 0) || !(i.unitCost >= 0))) throw new Error('بيانات بنود الشراء غير صالحة.');
  const total = Math.round(items.reduce((sum, i) => sum + i.quantity * i.unitCost, 0) * 100) / 100;
  const paidAmount = Math.round(Math.max(0, Number(order.paidAmount) || 0) * 100) / 100;
  const paymentMethod = String(order.paymentMethod || (paidAmount > 0 ? 'cash' : 'credit')).trim();
  if (!['cash', 'card', 'credit'].includes(paymentMethod)) throw new Error('طريقة دفع المورد غير صالحة.');
  if (paidAmount > total + 0.01) throw new Error('المبلغ المدفوع للمورد أكبر من إجمالي فاتورة الشراء.');
  if (paymentMethod === 'credit' && paidAmount > 0.01) throw new Error('اختر نقداً أو بطاقة لتسجيل دفعة للمورد.');
  const supplier = db.prepare('SELECT id FROM suppliers WHERE id=? AND branch_id=?').get(Number(order.supplierId), branch.id);
  if(!supplier) throw new Error('المورد غير موجود.');
  const productCheck = db.prepare('SELECT id, is_active FROM products WHERE id=?');
  for (const item of items) {
    const product = productCheck.get(item.productId);
    if (!product || !product.is_active) throw new Error('يوجد منتج شراء غير موجود أو غير نشط.');
  }
  const tx = db.transaction(() => {
    const info = db.prepare(`INSERT INTO purchase_orders (uuid, branch_id, supplier_id, total, paid_amount, payment_method, notes, synced) VALUES (?, ?, ?, ?, ?, ?, ?, 0)`)
      .run(uuid(), branch.id, Number(order.supplierId), total, paidAmount, paymentMethod, order.notes || null);
    const insert = db.prepare(`INSERT INTO purchase_order_items (purchase_order_id, product_id, quantity, unit_cost) VALUES (?, ?, ?, ?)`);
    for (const item of items) insert.run(info.lastInsertRowid, item.productId, item.quantity, item.unitCost);
    // الفاتورة التي ينشئها المستخدم هي عملية شراء مكتملة وليست "مسودة" مخفية:
    // الاستلام يحدّث المخزون والحسابات في نفس transaction. يبقى خيار المسودة
    // متاحاً فقط لاستيراد/تكاملات مستقبلية عبر receiveImmediately=false.
    if (order.receiveImmediately !== false) {
      return receivePurchaseOrderCore(info.lastInsertRowid, branch.id, { paymentMethod, userId: order.userId || null, shiftId: order.shiftId || null });
    }
    return { id: info.lastInsertRowid, total, status: 'draft' };
  });
  return tx();
}
function receivePurchaseOrderCore(purchaseOrderId, branchId, context = {}) {
  const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(purchaseOrderId);
  if (!po) throw new Error('فاتورة الشراء غير موجودة.');
  // حماية: فاتورة شراء أُنشئت بفرع آخر ووصلت هالجهاز عبر المزامنة (للعرض فقط) — لا يجوز
  // استلامها من هون، لأن الاستلام يُحرّك مخزون هذا الجهاز ورصيد المورد المشترك، وفرع تاني
  // هو المسؤول الوحيد عن قرار استلام فاتورته هو.
  if (po.branch_id !== branchId) throw new Error('لا يمكن استلام فاتورة شراء تخص فرعاً آخر. راجع الفرع الذي أنشأها.');
  if (po.status !== 'draft') throw new Error('لا يمكن استلام فاتورة تم التعامل معها سابقاً.');
  const items = db.prepare('SELECT * FROM purchase_order_items WHERE purchase_order_id = ?').all(purchaseOrderId);
  const upsertInventory = db.prepare(`INSERT INTO inventory (branch_id, product_id, quantity, unit_cost, min_quantity, updated_at, synced) VALUES (?, ?, ?, ?, 0, datetime('now'), 0)
    ON CONFLICT(branch_id, product_id) DO UPDATE SET quantity=inventory.quantity + excluded.quantity, unit_cost=excluded.unit_cost, updated_at=datetime('now'), synced=0`);
  const productStock = db.prepare('SELECT quantity, unit_cost FROM inventory WHERE branch_id=? AND product_id=?');
  const movement = db.prepare(`INSERT INTO inventory_movements (uuid, branch_id, product_id, change_qty, reason, ref_id, notes, unit_cost_after, synced) VALUES (?, ?, ?, ?, 'purchase', ?, ?, ?, 0)`);
  for (const item of items) {
    const product = db.prepare('SELECT track_inventory,is_active FROM products WHERE id=?').get(item.product_id);
    if (!product || !product.is_active) throw new Error('يوجد منتج شراء غير صالح.');
    if (!product.track_inventory) continue;
    const quantity = Number(item.quantity);
    const unitCost = Number(item.unit_cost);
    if (!(quantity > 0) || !Number.isFinite(unitCost) || unitCost < 0) throw new Error('بيانات بند فاتورة الشراء غير صالحة.');
    const stockRow = productStock.get(po.branch_id, item.product_id);
    const before = Number(stockRow?.quantity || 0);
    const oldCost = Number(stockRow?.unit_cost ?? db.prepare('SELECT cost FROM products WHERE products.id=?').get(item.product_id)?.cost ?? 0);
    const weightedCost = (before + quantity) > 0 ? ((before * oldCost) + (quantity * unitCost)) / (before + quantity) : unitCost;
    upsertInventory.run(po.branch_id, item.product_id, quantity, weightedCost);
    movement.run(uuid(), po.branch_id, item.product_id, quantity, po.id, 'استلام فاتورة شراء', weightedCost);
  }
  const paidAmount = Math.min(Number(po.total), Math.max(0, Number(po.paid_amount) || 0));
  const paymentMethod = String(context.paymentMethod || po.payment_method || (paidAmount > 0 ? 'cash' : 'credit')).trim();
  if (!['cash', 'card', 'credit'].includes(paymentMethod)) throw new Error('طريقة دفع المورد غير صالحة.');
  if (paymentMethod === 'credit' && paidAmount > 0.01) throw new Error('فاتورة المورد الآجلة لا يمكن أن تحتوي دفعة مسجلة.');
  const due = Math.max(0, Number(po.total) - paidAmount);
  const supplier = db.prepare('SELECT balance FROM suppliers WHERE id=? AND branch_id=?').get(po.supplier_id, branchId);
  if (!supplier) throw new Error('المورد غير موجود في الفرع الحالي.');
  const balanceAfterPurchase = Number(supplier.balance || 0) + Number(po.total);
  const balanceAfter = balanceAfterPurchase - paidAmount;
  db.prepare(`UPDATE suppliers SET balance=?, updated_at=datetime('now'), synced=0 WHERE id=? AND branch_id=?`).run(balanceAfter, po.supplier_id, branchId);
  if (Number(po.total) > 0) db.prepare(`INSERT INTO supplier_ledger (uuid, branch_id, supplier_id, purchase_order_id, entry_type, amount, balance_after, notes, synced) VALUES (?, ?, ?, ?, 'purchase', ?, ?, ?, 0)`)
    .run(uuid(), po.branch_id, po.supplier_id, po.id, Number(po.total), balanceAfterPurchase, 'فاتورة شراء مستلمة');
  if (paidAmount > 0) db.prepare(`INSERT INTO supplier_ledger (uuid, branch_id, supplier_id, purchase_order_id, entry_type, amount, balance_after, notes, synced) VALUES (?, ?, ?, ?, 'payment', ?, ?, ?, 0)`)
    .run(uuid(), po.branch_id, po.supplier_id, po.id, -paidAmount, balanceAfter, `دفعة ${paymentMethod === 'cash' ? 'نقدية' : 'بطاقة'} للمورد`);

  const actorId = context.userId || null;
  const shiftId = context.shiftId || null;
  if (paidAmount > 0) {
    const currency = String(getGlobalProfile().currency_code || 'USD').trim().toUpperCase();
    db.prepare(`INSERT INTO payment_transactions(uuid,branch_id,shift_id,method,currency_code,amount,exchange_rate,external_id,masked_descriptor,created_by) VALUES(?,?,?,?,?,?,?,?,?,?)`)
      .run(uuid(), po.branch_id, shiftId, paymentMethod, currency, -paidAmount, 1, `purchase:${po.id}`, `دفعة مورد #${po.id}`, actorId);
    if (paymentMethod === 'cash' && shiftId) {
      const shift = db.prepare("SELECT id FROM shifts WHERE id=? AND branch_id=? AND status='open'").get(shiftId, po.branch_id);
      if (!shift) throw new Error('جلسة الصندوق المحددة مغلقة أو لا تخص الفرع الحالي.');
      db.prepare(`INSERT INTO cash_movements(uuid,branch_id,shift_id,type,amount,reason,reference,created_by) VALUES(?,?,?,?,?,?,?,?)`)
        .run(uuid(), po.branch_id, shiftId, 'cash_out', paidAmount, 'دفعة فاتورة شراء', `purchase:${po.id}`, actorId);
    }
  }
  db.prepare(`UPDATE purchase_orders SET status='received', payment_method=?, received_at=datetime('now'), updated_at=datetime('now'), synced=0 WHERE id=?`).run(paymentMethod, po.id);
  return { success: true, id: po.id, total: po.total, paidAmount, due, balanceAfter, cashMovementRecorded: paymentMethod === 'cash' && !!shiftId };
}
const receivePurchaseOrderTx = db.transaction(receivePurchaseOrderCore);
function receivePurchaseOrder(id, context = {}) { return receivePurchaseOrderTx(id, getCurrentBranch().id, context); }
function listPurchaseOrders() { const b=getCurrentBranch(); return db.prepare(`SELECT p.*, s.name AS supplier_name, b.name AS branch_name FROM purchase_orders p JOIN suppliers s ON s.id=p.supplier_id JOIN branches b ON b.id=p.branch_id WHERE p.branch_id=? ORDER BY p.created_at DESC`).all(b.id); }
function getPurchaseOrder(id) { const b=getCurrentBranch(); const order = db.prepare(`SELECT p.*, s.name AS supplier_name, b.name AS branch_name FROM purchase_orders p JOIN suppliers s ON s.id=p.supplier_id JOIN branches b ON b.id=p.branch_id WHERE p.id=? AND p.branch_id=? AND s.branch_id=?`).get(id,b.id,b.id); return order ? { ...order, items: db.prepare(`SELECT i.*, pr.name AS product_name FROM purchase_order_items i JOIN products pr ON pr.id=i.product_id WHERE i.purchase_order_id=?`).all(id) } : null; }

/* ---------------- طاولات المطعم والطلبات المفتوحة ---------------- */
function listTables() {
  const branch = getCurrentBranch();
  const tables = db.prepare('SELECT * FROM restaurant_tables WHERE branch_id = ? ORDER BY name').all(branch.id);
  return tables.map((t) => {
    // مجرد فتح شاشة الطاولة يُنشئ طلباً "open" فارغاً (لعرض/بدء الطلب)، فلا يجوز اعتبار
    // الطاولة "مشغولة" إلا إذا كان هذا الطلب المفتوح يحتوي فعلاً على صنف واحد على الأقل.
    // هذا يمنع مشكلة بقاء الطاولة "مشغولة" للأبد لمجرد أن أحداً فتحها ثم رجع دون إضافة شيء.
    const openSale = db
      .prepare(`SELECT s.id, s.grand_total, s.created_at,
                       (SELECT COUNT(*) FROM sale_items si WHERE si.sale_id = s.id) AS item_count
                FROM sales s WHERE s.branch_id = ? AND s.table_id = ? AND s.status = 'open'`)
      .get(branch.id, t.id);
    const hasItems = !!openSale && Number(openSale.item_count) > 0;
    return {
      ...t,
      occupied: hasItems,
      openSaleId: openSale ? openSale.id : null,
      openTotal: hasItems ? openSale.grand_total : 0,
      openSince: hasItems ? openSale.created_at : null,
    };
  });
}

// تحرير يدوي لطاولة عالقة: يُلغي (void) أي طلب مفتوح فارغ (بلا أصناف) عليها.
// لا يمكن استخدامها إن كان هناك طلب مفتوح يحتوي أصنافاً فعلاً — تلك حالة طبيعية ويجب
// إغلاقها عبر الدفع أو نقل/دمج الطاولة، وليس عبر "تحرير" قسري قد يُضيّع الطلب.
function releaseEmptyTable(tableId) {
  const branch = getCurrentBranch();
  const table = db.prepare('SELECT id FROM restaurant_tables WHERE id=? AND branch_id=?').get(Number(tableId), branch.id);
  if (!table) throw new Error('الطاولة غير موجودة في الفرع الحالي.');
  const openSale = db.prepare(`SELECT id FROM sales WHERE branch_id=? AND table_id=? AND status='open'`).get(branch.id, table.id);
  if (!openSale) return { success: true, released: false };
  const itemCount = db.prepare('SELECT COUNT(*) c FROM sale_items WHERE sale_id=?').get(openSale.id).c;
  if (Number(itemCount) > 0) return { success: false, message: 'لا يمكن تحرير طاولة عليها طلب يحتوي أصنافاً. أكمل الدفع أو أفرغ السلة أولاً.' };
  db.prepare(`UPDATE sales SET status='void' WHERE id=?`).run(openSale.id);
  return { success: true, released: true };
}

function createTable(t) {
  const branch = getCurrentBranch();
  const name = String(t?.name || '').trim();
  const seats = t?.seats === undefined || t.seats === '' ? 4 : Number(t.seats);
  if (!name) throw new Error('اسم الطاولة مطلوب.');
  if (!Number.isInteger(seats) || seats < 1 || seats > 100) throw new Error('عدد مقاعد الطاولة يجب أن يكون بين 1 و100.');
  const duplicate = db.prepare('SELECT id FROM restaurant_tables WHERE branch_id=? AND lower(trim(name))=lower(trim(?)) LIMIT 1').get(branch.id, name);
  if (duplicate) throw new Error('اسم الطاولة مستخدم بالفعل في الفرع الحالي.');
  const info = db.prepare(`INSERT INTO restaurant_tables (uuid, branch_id, name, seats, status, updated_at, synced) VALUES (?, ?, ?, ?, 'free', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 0)`).run(uuid(), branch.id, name, seats);
  return { id: info.lastInsertRowid };
}

function deleteTable(id) {
  // يُمنع حذف طاولة عليها طلب مفتوح حالياً
  const branch = getCurrentBranch();
  const openSale = db
    .prepare(`SELECT id FROM sales WHERE branch_id = ? AND table_id = ? AND status = 'open'`)
    .get(branch.id, id);
  if (openSale) return { success: false, message: 'لا يمكن حذف طاولة عليها طلب مفتوح' };
  const historical = db.prepare('SELECT COUNT(*) AS c FROM sales WHERE table_id=?').get(id).c;
  if (Number(historical) > 0) {
    db.prepare(`UPDATE restaurant_tables SET status='reserved', name = name || ' (محذوف)', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), synced=0 WHERE id=? AND branch_id=?`).run(id, branch.id);
    return { success: true, archived: true };
  }
  db.prepare('DELETE FROM restaurant_tables WHERE id = ? AND branch_id=?').run(id, branch.id);
  return { success: true };
}

// يفتح طلباً جديداً للطاولة إن لم يوجد طلب مفتوح بالفعل، أو يُرجع الموجود
const getOrCreateOpenSaleTx = db.transaction((tableId, userId) => {
  const branch = getCurrentBranch();
  const table = db.prepare('SELECT id FROM restaurant_tables WHERE id=? AND branch_id=?').get(Number(tableId), branch.id);
  if (!table) throw new Error('الطاولة غير موجودة في الفرع الحالي.');
  let sale = db
    .prepare(`SELECT * FROM sales WHERE branch_id = ? AND table_id = ? AND status = 'open'`)
    .get(branch.id, table.id);
  if (sale) return sale;

  const saleUuid = uuid();
  const info = db
    .prepare(
      `INSERT INTO sales (uuid, branch_id, user_id, table_id, subtotal, tax_total, discount_total, grand_total, payment_method, status)
       VALUES (?, ?, ?, ?, 0, 0, 0, 0, 'cash', 'open')`
    )
    .run(saleUuid, branch.id, userId || null, tableId);
  return db.prepare('SELECT * FROM sales WHERE id = ?').get(info.lastInsertRowid);
});

function getOrCreateOpenSale(tableId, userId) {
  return getOrCreateOpenSaleTx(tableId, userId);
}

function getOpenSaleForTable(tableId) {
  const branch = getCurrentBranch();
  const table = db.prepare('SELECT id FROM restaurant_tables WHERE id=? AND branch_id=?').get(Number(tableId), branch.id);
  if (!table) return null;
  const sale = db
    .prepare(`SELECT * FROM sales WHERE branch_id = ? AND table_id = ? AND status = 'open'`)
    .get(branch.id, table.id);
  if (!sale) return null;
  const items = db
    .prepare(
      `SELECT si.*, p.name AS product_name, p.unit
       FROM sale_items si JOIN products p ON p.id = si.product_id
       WHERE si.sale_id = ? ORDER BY si.id`
    )
    .all(sale.id);
  return { ...sale, items };
}

// يحفظ طلب الطاولة ويزامن المخزون مع الكمية المحفوظة فعلياً. يطبّق فرق الكمية فقط، فلا يحدث خصم مزدوج.
const setOpenSaleItemsTx = db.transaction((saleId, items) => {
  const branch = getCurrentBranch();
  const sale = db.prepare(`SELECT id, status, branch_id FROM sales WHERE id=? AND branch_id=? AND status='open'`).get(Number(saleId), branch.id);
  if (!sale) throw new Error('الطلب المفتوح غير موجود في الفرع الحالي.');
  if (!Array.isArray(items)) throw new Error('قائمة الأصناف غير صالحة.');

  const getProduct = db.prepare(`SELECT p.id,p.price,p.cost,p.tax_rate,p.tax_profile_id,p.name,
      tp.rate AS profile_rate,tp.is_inclusive AS profile_inclusive
      FROM products p
      LEFT JOIN tax_profiles tp ON tp.id=p.tax_profile_id AND tp.branch_id=? AND tp.is_active=1
      WHERE p.id=? AND p.is_active=1`).pluck(false);
  const getProductRow = db.prepare(`SELECT p.id,p.price,p.cost,COALESCE(i.unit_cost,p.cost,0) AS branch_cost,p.tax_rate,p.tax_profile_id,p.name,p.track_inventory,
      tp.rate AS profile_rate,tp.is_inclusive AS profile_inclusive
      FROM products p
      LEFT JOIN inventory i ON i.product_id=p.id AND i.branch_id=?
      LEFT JOIN tax_profiles tp ON tp.id=p.tax_profile_id AND tp.branch_id=? AND tp.is_active=1
      WHERE p.id=? AND p.is_active=1`);
  const global = getGlobalProfile();
  const appliedRows = db.prepare(`SELECT product_id, COALESCE(SUM(-change_qty),0) AS applied_qty FROM inventory_movements WHERE branch_id=? AND ref_id=? AND reason='table_order' GROUP BY product_id`).all(branch.id, Number(saleId));
  const appliedByProduct = new Map(appliedRows.map((r) => [Number(r.product_id), Number(r.applied_qty || 0)]));
  const normalized=[];
  let subtotal=0, taxTotal=0;
  for (const raw of items) {
    const productId=Number(raw.productId ?? raw.product_id);
    const quantity=Number(raw.quantity);
    if (!Number.isInteger(productId) || productId<=0 || !(Number.isFinite(quantity) && quantity>0)) throw new Error('بيانات صنف غير صالحة.');
    const product=getProductRow.get(branch.id,branch.id,productId);
    if (!product) throw new Error('منتج غير موجود أو غير نشط.');
    const taxRate=product.profile_rate==null ? Number(product.tax_rate||0) : Number(product.profile_rate);
    const inclusive=product.profile_rate!=null ? Number(product.profile_inclusive)===1 : global.tax_mode==='inclusive';
    const gross=Number(product.price)*quantity;
    const lineTax=inclusive ? gross - gross/(1+taxRate/100) : gross*(taxRate/100);
    subtotal += inclusive ? gross-lineTax : gross;
    taxTotal += lineTax;
    normalized.push({productId,quantity,unitPrice:Number(product.price),taxRate,taxProfileId:product.tax_profile_id||null,taxInclusive:inclusive,discount:0,lineTotal:gross,notes:String(raw.notes||'').slice(0,1000),costAtSale:Math.max(0,Number(product.branch_cost ?? product.cost ?? 0))});
  }
  const desiredByProduct = new Map();
  for (const item of normalized) desiredByProduct.set(item.productId, (desiredByProduct.get(item.productId) || 0) + item.quantity);
  const allProductIds = new Set([...appliedByProduct.keys(), ...desiredByProduct.keys()]);
  const getInventoryProduct = db.prepare('SELECT id, track_inventory FROM products WHERE id=?');
  const getInventory = db.prepare('SELECT quantity FROM inventory WHERE branch_id=? AND product_id=?');
  const decrementStock = db.prepare(`UPDATE inventory SET quantity=quantity-?,updated_at=datetime('now'),synced=0 WHERE branch_id=? AND product_id=?`);
  const incrementStock = db.prepare(`UPDATE inventory SET quantity=quantity+?,updated_at=datetime('now'),synced=0 WHERE branch_id=? AND product_id=?`);
  const getCost = db.prepare(`SELECT COALESCE(i.unit_cost,p.cost,0) AS cost FROM inventory i JOIN products p ON p.id=i.product_id WHERE i.branch_id=? AND i.product_id=?`);
  const logTableOrderMovement = db.prepare(`INSERT INTO inventory_movements (uuid,branch_id,product_id,change_qty,reason,ref_id,notes,unit_cost_after,synced) VALUES (?,?,?,?, 'table_order',?,?,?,0)`);
  for (const productId of allProductIds) {
    const applied = Number(appliedByProduct.get(productId) || 0);
    const desired = Number(desiredByProduct.get(productId) || 0);
    const delta = desired - applied;
    if (Math.abs(delta) < 0.000001) continue;
    const product = getInventoryProduct.get(productId);
    if (!product) throw new Error('أحد منتجات الطلب غير موجود.');
    if (!Number(product.track_inventory)) continue;
    const cost = Number(getCost.get(branch.id, productId)?.cost || 0);
    if (delta > 0) {
      const inv = getInventory.get(branch.id, productId);
      if (!inv || Number(inv.quantity) < delta) throw new Error(`المخزون غير كافٍ للصنف #${productId}. المتاح ${Number(inv?.quantity || 0)} والمطلوب ${delta}.`);
      if (decrementStock.run(delta, branch.id, productId).changes !== 1) throw new Error('تعذّر خصم المخزون أثناء حفظ طلب الطاولة.');
      logTableOrderMovement.run(uuid(), branch.id, productId, -delta, saleId, 'خصم عند حفظ طلب الطاولة', cost);
    } else {
      const restore = Math.abs(delta);
      if (incrementStock.run(restore, branch.id, productId).changes !== 1) throw new Error('تعذّر إعادة المخزون عند تعديل طلب الطاولة.');
      logTableOrderMovement.run(uuid(), branch.id, productId, restore, saleId, 'إعادة مخزون عند تعديل طلب الطاولة', cost);
    }
  }
  db.prepare("UPDATE sales SET inventory_committed=1 WHERE id=? AND branch_id=? AND status='open'").run(Number(saleId), branch.id);
  db.prepare('DELETE FROM sale_items WHERE sale_id=?').run(Number(saleId));
  const insertItem=db.prepare(`INSERT INTO sale_items (uuid,sale_id,product_id,quantity,unit_price,tax_rate,tax_profile_id,tax_inclusive,discount,line_total,notes,cost_at_sale) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  for(const item of normalized) insertItem.run(uuid(),Number(saleId),item.productId,item.quantity,item.unitPrice,item.taxRate,item.taxProfileId,item.taxInclusive ? 1 : 0,item.discount,item.lineTotal,item.notes,item.costAtSale);
  db.prepare(`UPDATE sales SET subtotal=?,tax_total=?,grand_total=? WHERE id=? AND branch_id=? AND status='open'`).run(subtotal,taxTotal,subtotal+taxTotal,Number(saleId),branch.id);
  return { success:true, subtotal,taxTotal,grandTotal:subtotal+taxTotal,items:normalized.length };
});

function setOpenSaleItems(saleId, items) {
  return setOpenSaleItemsTx(saleId, items);
}

function recalculateOpenSale(saleId) {
  const sale = db.prepare("SELECT branch_id FROM sales WHERE id=? AND status='open'").get(Number(saleId));
  if (!sale) throw new Error('الطلب المفتوح غير موجود.');
  const global = getGlobalProfile();
  const rows = db.prepare(`
    SELECT si.quantity, si.unit_price, si.tax_rate, si.tax_profile_id,
           tp.rate AS profile_rate, tp.is_inclusive AS profile_inclusive
    FROM sale_items si
    LEFT JOIN tax_profiles tp ON tp.id=si.tax_profile_id AND tp.branch_id=? AND tp.is_active=1
    WHERE si.sale_id=?
  `).all(sale.branch_id, Number(saleId));
  let subtotal = 0, tax = 0;
  for (const row of rows) {
    const gross = Number(row.quantity) * Number(row.unit_price);
    const rate = row.profile_rate == null ? Number(row.tax_rate || 0) : Number(row.profile_rate);
    const inclusive = row.profile_rate != null ? Number(row.profile_inclusive) === 1 : global.tax_mode === 'inclusive';
    const lineTax = inclusive ? gross - gross / (1 + rate / 100) : gross * rate / 100;
    subtotal += inclusive ? gross - lineTax : gross;
    tax += lineTax;
  }
  subtotal = Math.round(subtotal * 100) / 100;
  tax = Math.round(tax * 100) / 100;
  const grandTotal = Math.round((subtotal + tax) * 100) / 100;
  db.prepare(`UPDATE sales SET subtotal=?, tax_total=?, grand_total=? WHERE id=? AND status='open'`).run(subtotal, tax, grandTotal, Number(saleId));
  return { subtotal, tax, grand_total: grandTotal };
}

// يدمج الطلب المفتوح من طاولة إلى طاولة أخرى داخل نفس الفرع. لا يدمج أي فاتورة مدفوعة.
const mergeTablesTx = db.transaction((sourceTableId, targetTableId, userId) => {
  if (Number(sourceTableId) === Number(targetTableId)) throw new Error('اختر طاولتين مختلفتين.');
  const branch = getCurrentBranch();
  const source = db.prepare(`SELECT * FROM sales WHERE branch_id=? AND table_id=? AND status='open'`).get(branch.id, sourceTableId);
  if (!source) throw new Error('الطاولة المصدر لا تحتوي طلباً مفتوحاً.');
  const sourceInventoryCommitted = Number(source.inventory_committed || 0) === 1;
  const targetTable = db.prepare(`SELECT id FROM restaurant_tables WHERE branch_id=? AND id=?`).get(branch.id, targetTableId);
  if (!targetTable) throw new Error('الطاولة الهدف غير صالحة.');
  let target = db.prepare(`SELECT * FROM sales WHERE branch_id=? AND table_id=? AND status='open'`).get(branch.id, targetTableId);
  if (!target) {
    const created = db.prepare(`INSERT INTO sales (uuid,branch_id,user_id,table_id,subtotal,tax_total,discount_total,grand_total,payment_method,status)
      VALUES (?,?,?,?,0,0,0,0,'cash','open')`).run(uuid(), branch.id, userId || null, targetTableId);
    target = db.prepare('SELECT * FROM sales WHERE id=?').get(created.lastInsertRowid);
  }
  const targetInventoryCommitted = Number(target.inventory_committed || 0) === 1;
  const insert = db.prepare(`INSERT INTO sale_items (uuid,sale_id,product_id,quantity,unit_price,tax_rate,tax_profile_id,tax_inclusive,discount,line_total,notes,cost_at_sale) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const item of db.prepare('SELECT * FROM sale_items WHERE sale_id=?').all(source.id)) {
    insert.run(uuid(), target.id, item.product_id, item.quantity, item.unit_price, item.tax_rate, item.tax_profile_id || null, item.tax_inclusive ? 1 : 0, item.discount, item.line_total, item.notes, item.cost_at_sale || 0);
  }
  db.prepare(`UPDATE inventory_movements SET ref_id=? WHERE branch_id=? AND ref_id=? AND reason='table_order'`).run(target.id, branch.id, source.id);
  db.prepare('DELETE FROM sale_items WHERE sale_id=?').run(source.id);
  db.prepare(`UPDATE sales SET status='void' WHERE id=?`).run(source.id);
  db.prepare('UPDATE sales SET inventory_committed=? WHERE id=? AND branch_id=?').run((sourceInventoryCommitted || targetInventoryCommitted) ? 1 : 0, target.id, branch.id);
  recalculateOpenSale(target.id);
  logAudit({ userId, action: 'tables_merged', entityType: 'sale', entityId: target.id, details: { sourceTableId, targetTableId, sourceSaleId: source.id } });
  return { success: true, saleId: target.id };
});

function mergeTables(sourceTableId, targetTableId, userId) { return mergeTablesTx(sourceTableId, targetTableId, userId); }

// يدفع جزءاً محدداً من طلب الطاولة، ويُبقي الباقي مفتوحاً على الطاولة نفسها.
const splitTableSaleTx = db.transaction((saleId, selected, payment, userId, shiftId) => {
  const branch = getCurrentBranch();
  const source = db.prepare(`SELECT * FROM sales WHERE id=? AND branch_id=? AND status='open'`).get(saleId, branch.id);
  if (!source) throw new Error('الطلب المفتوح غير موجود.');
  const sourceItems = db.prepare('SELECT * FROM sale_items WHERE sale_id=?').all(saleId);
  const sourceInventoryCommitted = Number(source.inventory_committed || 0) === 1;
  const wanted = new Map((selected || []).map(x => [Number(x.saleItemId), Number(x.quantity)]));
  const picked = [];
  for (const item of sourceItems) {
    const qty = wanted.get(item.id) || 0;
    if (qty < 0 || qty > item.quantity) throw new Error('كمية التقسيم غير صالحة.');
    if (qty > 0) picked.push({ ...item, quantity: qty, line_total: item.unit_price * qty });
  }
  if (!picked.length) throw new Error('اختر صنفاً واحداً على الأقل للتقسيم.');
  const global = getGlobalProfile();
  let subtotal = 0;
  let tax = 0;
  for (const i of picked) {
    const gross = Number(i.unit_price) * Number(i.quantity);
    const profile = i.tax_profile_id ? db.prepare('SELECT is_inclusive, rate FROM tax_profiles WHERE id=? AND branch_id=?').get(i.tax_profile_id, branch.id) : null;
    const rate = profile ? Number(profile.rate || 0) : Number(i.tax_rate || 0);
    const inclusive = profile ? Number(profile.is_inclusive) === 1 : global.tax_mode === 'inclusive';
    const lineTax = inclusive && rate > 0 ? gross - gross / (1 + rate / 100) : (inclusive ? 0 : gross * rate / 100);
    subtotal += inclusive ? gross - lineTax : gross;
    tax += lineTax;
  }
  subtotal = Math.round(subtotal * 100) / 100;
  tax = Math.round(tax * 100) / 100;
  const total = Math.round((subtotal + tax) * 100) / 100;
  if (!sourceInventoryCommitted) {
    for (const item of picked) {
      const product = db.prepare('SELECT id,track_inventory,is_active FROM products WHERE id=?').get(item.product_id);
      if (!product || !product.is_active) throw new Error('أحد منتجات الطلب لم يعد صالحًا.');
      if (product.track_inventory) {
        const inv = db.prepare('SELECT quantity FROM inventory WHERE branch_id=? AND product_id=?').get(branch.id, item.product_id);
        if (!inv || Number(inv.quantity) < Number(item.quantity)) throw new Error('الكمية المتوفرة لم تعد كافية لتقسيم الطلب.');
      }
    }
  }
  const method = payment.paymentMethod || 'cash';
  validatePaymentAmounts(total, method, payment.cashAmount, payment.cardAmount, payment.changeDue);
  const invoiceNumber = nextInvoiceNumber();
  const info = db.prepare(`INSERT INTO sales (uuid,branch_id,user_id,customer_id,table_id,shift_id,order_type,subtotal,tax_total,grand_total,payment_method,cash_amount,card_amount,change_due,invoice_number,status)
    VALUES (?,?,?,?,?,?,'table_split',?,?,?,?,?,?,?,?,'completed')`).run(uuid(), branch.id, userId, source.customer_id || null, source.table_id, shiftId, subtotal, tax, total, method,
    Number(payment.cashAmount) || 0, Number(payment.cardAmount) || 0, Number(payment.changeDue) || 0, invoiceNumber);
  const paidSaleId = info.lastInsertRowid;
  const ins = db.prepare(`INSERT INTO sale_items (uuid,sale_id,product_id,quantity,unit_price,tax_rate,tax_profile_id,tax_inclusive,discount,line_total,notes,cost_at_sale) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  const stock = db.prepare(`UPDATE inventory SET quantity=quantity-?,updated_at=datetime('now'),synced=0 WHERE branch_id=? AND product_id=?`);
  const movement = db.prepare(`INSERT INTO inventory_movements (uuid,branch_id,product_id,change_qty,reason,ref_id,unit_cost_after,synced) VALUES (?,?,?,?, 'sale',?,?,0)`);
  const updateSource = db.prepare('UPDATE sale_items SET quantity=quantity-?, line_total=unit_price*(quantity-?) WHERE id=?');
  for (const item of picked) {
    const lineTotal = Number(item.unit_price) * Number(item.quantity);
    ins.run(uuid(), paidSaleId, item.product_id, item.quantity, item.unit_price, item.tax_rate, item.tax_profile_id || null, item.tax_inclusive ? 1 : 0, item.discount, lineTotal, item.notes, item.cost_at_sale || 0);
    updateSource.run(item.quantity, item.quantity, item.id);
    if (!sourceInventoryCommitted) {
      const product = db.prepare('SELECT track_inventory FROM products WHERE id=? AND is_active=1').get(item.product_id);
      if (product?.track_inventory) {
        const stockResult = stock.run(item.quantity, branch.id, item.product_id);
        if (stockResult.changes !== 1) throw new Error('تعذّر تحديث مخزون المنتج أثناء تقسيم الطلب.');
        movement.run(uuid(), branch.id, item.product_id, -item.quantity, paidSaleId, Number(item.cost_at_sale || 0));
      }
    }
  }
  db.prepare('DELETE FROM sale_items WHERE sale_id=? AND quantity<=0').run(saleId);
  recalculateOpenSale(saleId);
  const currency = String(getGlobalProfile().currency_code || 'USD').toUpperCase();
  const ptx = db.prepare(`INSERT INTO payment_transactions(uuid,branch_id,sale_id,shift_id,method,currency_code,amount,exchange_rate,provider,provider_reference,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
  if (method === 'cash') ptx.run(uuid(), branch.id, paidSaleId, shiftId || null, 'cash', currency, total, 1, null, null, userId || null);
  else if (method === 'card') ptx.run(uuid(), branch.id, paidSaleId, shiftId || null, 'card', currency, total, 1, payment.paymentProvider || null, payment.paymentReference || null, userId || null);
  else if (method === 'mixed') {
    if (Number(payment.cashAmount) > 0) ptx.run(uuid(), branch.id, paidSaleId, shiftId || null, 'cash', currency, Number(payment.cashAmount), 1, null, null, userId || null);
    if (Number(payment.cardAmount) > 0) ptx.run(uuid(), branch.id, paidSaleId, shiftId || null, 'card', currency, Number(payment.cardAmount), 1, payment.paymentProvider || null, payment.paymentReference || null, userId || null);
  } else if (method === 'store_credit') {
    const customer = source.customer_id ? db.prepare('SELECT store_credit_balance FROM customers WHERE id=? AND branch_id=?').get(source.customer_id, branch.id) : null;
    if (!customer || Number(customer.store_credit_balance || 0) + 0.01 < total) throw new Error('رصيد المتجر غير كافٍ للدفع المجزأ.');
    appendStoreCreditLedger({ customerId: source.customer_id, saleId: paidSaleId, entryType: 'sale_spend', amount: -total, createdBy: userId, branchId: branch.id });
    ptx.run(uuid(), branch.id, paidSaleId, shiftId || null, 'store_credit', currency, -total, 1, null, null, userId || null);
  }
  logAudit({ userId, action: 'table_bill_split', entityType: 'sale', entityId: paidSaleId, details: { sourceSaleId: saleId, total, items: picked.length } });
  return { success: true, id: paidSaleId, invoiceNumber };
});

function splitTableSale(saleId, selected, payment, userId, shiftId) { return splitTableSaleTx(saleId, selected, payment, userId, shiftId); }

// إغلاق طاولة: يخصم المخزون فعلياً لأول مرة، يسجّل الدفع، ويحوّل الفاتورة من open إلى completed
const closeTableSaleTx = db.transaction((saleId, payment, actorUserId, shiftId = null) => {
  const branch = getCurrentBranch();
  const sale = db.prepare("SELECT * FROM sales WHERE id=? AND branch_id=? AND status='open'").get(saleId, branch.id);
  if (!sale) throw new Error('الطلب المفتوح غير موجود.');
  let paymentShiftId = sale.shift_id || null;
  if (shiftId != null) {
    const shift = db.prepare("SELECT id FROM shifts WHERE id=? AND branch_id=? AND status='open'").get(Number(shiftId), branch.id);
    if (!shift) throw new Error('جلسة الصندوق المحددة مغلقة أو لا تخص الفرع الحالي.');
    paymentShiftId = shift.id;
  }
  const items = db.prepare('SELECT * FROM sale_items WHERE sale_id = ?').all(saleId);
  const inventoryAlreadyCommitted = Number(sale.inventory_committed || 0) === 1;
  const updateStock = db.prepare(
    `UPDATE inventory SET quantity = quantity - ?, updated_at = datetime('now'), synced = 0
     WHERE branch_id = ? AND product_id = ?`
  );
  const logMovement = db.prepare(
    `INSERT INTO inventory_movements (uuid, branch_id, product_id, change_qty, reason, ref_id, unit_cost_after, synced)
     VALUES (?, ?, ?, ?, 'sale', ?, ?, 0)`
  );
  if (!inventoryAlreadyCommitted) {
    for (const item of items) {
      const inv = db.prepare('SELECT quantity FROM inventory WHERE branch_id=? AND product_id=?').get(branch.id,item.product_id);
      const product = db.prepare('SELECT track_inventory FROM products WHERE id=? AND is_active=1').get(item.product_id);
      if (!product) throw new Error('المنتج الموجود في الطلب لم يعد صالحًا.');
      if (product.track_inventory && (!inv || Number(inv.quantity) < Number(item.quantity))) {
        throw new Error('الكمية المتوفرة لم تعد كافية لإغلاق الطلب.');
      }
    }
  }
  // إعادة حساب الإجمالي من البنود المخزنة بدل الوثوق بأي قيمة قديمة.
  recalculateOpenSale(saleId);
  const refreshed = db.prepare('SELECT * FROM sales WHERE id=? AND branch_id=? AND status=\'open\'').get(saleId,branch.id);
  const total = Number(refreshed?.grand_total) || 0;
  validatePaymentAmounts(total, payment.paymentMethod || 'cash', payment.cashAmount, payment.cardAmount, payment.changeDue);
  if (!inventoryAlreadyCommitted) {
    for (const item of items) {
      const product = db.prepare('SELECT track_inventory FROM products WHERE id=? AND is_active=1').get(item.product_id);
      if (product?.track_inventory) {
        const stockResult = updateStock.run(item.quantity, branch.id, item.product_id);
        if (stockResult.changes !== 1) throw new Error('تعذّر تحديث مخزون المنتج أثناء إغلاق الطلب.');
        logMovement.run(uuid(), branch.id, item.product_id, -item.quantity, saleId, Number(item.cost_at_sale || 0));
      }
    }
    db.prepare('UPDATE sales SET inventory_committed=1 WHERE id=? AND branch_id=?').run(saleId, branch.id);
  }
  db.prepare(
    `UPDATE sales SET payment_method = ?, cash_amount = ?, card_amount = ?, change_due = ?, shift_id = ?, status = 'completed'
     WHERE id = ? AND branch_id = ? AND status='open'`
  ).run(payment.paymentMethod || 'cash', payment.cashAmount || 0, payment.cardAmount || 0, payment.changeDue || 0, paymentShiftId, saleId, branch.id);

  const method = payment.paymentMethod || 'cash';
  const currency=String(getGlobalProfile().currency_code||'USD').toUpperCase();
  const pt=db.prepare(`INSERT INTO payment_transactions(uuid,branch_id,sale_id,shift_id,method,currency_code,amount,exchange_rate,provider,provider_reference,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
  const createdBy = actorUserId || sale.user_id || null;
  if(method==='cash') pt.run(uuid(),branch.id,saleId,paymentShiftId,'cash',currency,total,1,null,null,createdBy);
  else if(method==='card') pt.run(uuid(),branch.id,saleId,paymentShiftId,'card',currency,total,1,payment.paymentProvider||null,payment.paymentReference||null,createdBy);
  else if(method==='mixed'){ if(Number(payment.cashAmount)>0) pt.run(uuid(),branch.id,saleId,paymentShiftId,'cash',currency,Number(payment.cashAmount),1,null,null,createdBy); if(Number(payment.cardAmount)>0) pt.run(uuid(),branch.id,saleId,paymentShiftId,'card',currency,Number(payment.cardAmount),1,payment.paymentProvider||null,payment.paymentReference||null,createdBy); }
  else if(method==='store_credit') {
    if (!sale.customer_id) throw new Error('الدفع برصيد المتجر يتطلب عميلًا مرتبطًا بالطلب.');
    const customer = db.prepare('SELECT store_credit_balance FROM customers WHERE id=? AND branch_id=?').get(sale.customer_id, branch.id);
    if (!customer || Number(customer.store_credit_balance || 0) + 0.01 < total) throw new Error('رصيد المتجر غير كافٍ.');
    appendStoreCreditLedger({ customerId: sale.customer_id, saleId, entryType: 'sale_spend', amount: -total, createdBy: createdBy, branchId: branch.id });
    pt.run(uuid(),branch.id,saleId,sale.shift_id||null,'store_credit',currency,-total,1,null,null,createdBy);
  }
  return { id: saleId };
});

function closeTableSale(saleId, payment, actorUserId, shiftId = null) {
  return closeTableSaleTx(saleId, payment, actorUserId, shiftId);
}

/* ==========================================================
   الإعدادات العامة (app_settings)
   ========================================================== */
function getGlobalProfile(){
  const row=db.prepare('SELECT * FROM organization_profile WHERE id=1').get();
  return row || {country_code:'TR',locale:'ar',timezone:'Europe/Istanbul',currency_code:'TRY',currency_minor_unit:2,tax_mode:'exclusive',tax_registration_number:'',fiscalization_mode:'none',fiscal_provider:''};
}
function setGlobalProfile(profile){
  const country=String(profile.countryCode||'TR').trim().toUpperCase();
  const locale=String(profile.locale||'en').trim();
  const timezone=String(profile.timezone||'UTC').trim();
  const currency=String(profile.currencyCode||'USD').trim().toUpperCase();
  const minor=Number(profile.currencyMinorUnit);
  const taxMode=String(profile.taxMode||'exclusive');
  const fiscalMode=String(profile.fiscalizationMode||'none');
  if(!/^[A-Z]{2}$/.test(country)) throw new Error('رمز الدولة يجب أن يكون ISO من حرفين.');
  if(!/^[A-Z]{3}$/.test(currency)) throw new Error('رمز العملة يجب أن يكون ISO من 3 أحرف.');
  if(![0,1,2,3].includes(minor)) throw new Error('عدد الخانات العشرية للعملة غير صالح.');
  if(!['exclusive','inclusive'].includes(taxMode)) throw new Error('وضع الضريبة غير صالح.');
  if(!['none','adapter'].includes(fiscalMode)) throw new Error('وضع الفوترة الإلكترونية غير صالح.');
  db.prepare(`UPDATE organization_profile SET country_code=?,locale=?,timezone=?,currency_code=?,currency_minor_unit=?,tax_mode=?,tax_registration_number=?,fiscalization_mode=?,fiscal_provider=?,updated_at=datetime('now') WHERE id=1`).run(country,locale,timezone,currency,minor,taxMode,String(profile.taxRegistrationNumber||'').trim()||null,fiscalMode,String(profile.fiscalProvider||'').trim()||null);
  return getGlobalProfile();
}
function listTaxProfiles(){ const b=getCurrentBranch(); return db.prepare('SELECT * FROM tax_profiles WHERE branch_id=? ORDER BY code').all(b.id); }
function saveTaxProfile(p){
  const b=getCurrentBranch(); const code=String(p.code||'').trim().toUpperCase(); const name=String(p.name||'').trim(); const rate=Number(p.rate);
  if(!code||!name) throw new Error('رمز واسم الضريبة مطلوبان.');
  if(!Number.isFinite(rate)||rate<0||rate>100) throw new Error('نسبة الضريبة غير صالحة.');
  const id=Number(p.id||0);
  if(id){ const exists=db.prepare('SELECT id FROM tax_profiles WHERE id=? AND branch_id=?').get(id,b.id); if(!exists) throw new Error('ملف الضريبة غير موجود.');
    db.prepare(`UPDATE tax_profiles SET code=?,name=?,rate=?,tax_category=?,country_code=?,is_inclusive=?,is_active=?,updated_at=datetime('now'),synced=0 WHERE id=? AND branch_id=?`).run(code,name,rate,String(p.taxCategory||'').trim()||null,String(p.countryCode||getGlobalProfile().country_code).toUpperCase(),p.isInclusive?1:0,p.isActive===false?0:1,id,b.id);
    return db.prepare('SELECT * FROM tax_profiles WHERE id=?').get(id); }
  const row=db.prepare(`INSERT INTO tax_profiles(uuid,branch_id,code,name,rate,tax_category,country_code,is_inclusive,is_active) VALUES(?,?,?,?,?,?,?,?,?)`).run(uuid(),b.id,code,name,rate,String(p.taxCategory||'').trim()||null,String(p.countryCode||getGlobalProfile().country_code).toUpperCase(),p.isInclusive?1:0,p.isActive===false?0:1);
  return db.prepare('SELECT * FROM tax_profiles WHERE id=?').get(row.lastInsertRowid);
}
function listPaymentTransactions(range={}){ const b=getCurrentBranch(); let sql='SELECT pt.*,u.full_name user_name FROM payment_transactions pt LEFT JOIN users u ON u.id=pt.created_by WHERE pt.branch_id=?'; const args=[b.id]; if(range.from){sql+=' AND pt.created_at>=?';args.push(range.from);} if(range.to){sql+=' AND pt.created_at<=?';args.push(range.to);} return db.prepare(sql+' ORDER BY pt.created_at DESC LIMIT 1000').all(...args); }
function getShiftCashMovements(shiftId, viewerUserId = null, viewerRole = null){ const b=getCurrentBranch(); const shift=db.prepare('SELECT opened_by FROM shifts WHERE id=? AND branch_id=?').get(Number(shiftId), b.id); if(!shift) throw new Error('جلسة الصندوق غير موجودة.'); if(viewerUserId!=null && Number(shift.opened_by)!==Number(viewerUserId) && !['admin','manager'].includes(viewerRole)) throw new Error('لا تملك صلاحية عرض حركات جلسة موظف آخر.'); return db.prepare('SELECT * FROM cash_movements WHERE shift_id=? AND branch_id=? ORDER BY created_at').all(Number(shiftId),b.id); }
function addCashMovement({shiftId,type,amount,reason,reference,createdBy}){ const b=getCurrentBranch(); const shift=db.prepare('SELECT id,status,opened_by FROM shifts WHERE id=? AND branch_id=?').get(Number(shiftId),b.id); if(!shift) throw new Error('جلسة الصندوق غير موجودة.'); if(shift.status!=='open') throw new Error('جلسة الصندوق مغلقة.'); const actor=db.prepare('SELECT role,is_active FROM users WHERE id=? AND branch_id=?').get(Number(createdBy),b.id); if(!actor || !actor.is_active) throw new Error('المستخدم الحالي غير صالح.'); if(Number(shift.opened_by)!==Number(createdBy) && !['admin','manager'].includes(actor.role)) throw new Error('لا يمكن إضافة حركة نقد إلا لمن فتح الجلسة أو لمدير.'); if(!['cash_in','cash_out'].includes(type)) throw new Error('نوع حركة النقد غير صالح.'); const n=Number(amount); if(!Number.isFinite(n)||n<=0) throw new Error('المبلغ يجب أن يكون أكبر من صفر.'); const row=db.prepare(`INSERT INTO cash_movements(uuid,branch_id,shift_id,type,amount,reason,reference,created_by) VALUES(?,?,?,?,?,?,?,?)`).run(uuid(),b.id,Number(shiftId),type,n,String(reason||'').trim()||'غير محدد',String(reference||'').trim()||null,createdBy||null); logAudit({userId:createdBy||null,branchId:b.id,action:'cash_movement_added',entityType:'cash_movement',entityId:row.lastInsertRowid,details:{type,amount:n}}); return db.prepare('SELECT * FROM cash_movements WHERE id=?').get(row.lastInsertRowid); }

function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}
function setSetting(key, value) {
  db.prepare(
    `INSERT INTO app_settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, String(value));
  return { success: true };
}
// الحد الأقصى لنسبة الخصم التي يقدر الكاشير يطبّقها بدون موافقة مدير (افتراضياً 10%)
function getMaxCashierDiscountPercent() {
  const value = Number(getSetting('max_cashier_discount_percent', '10'));
  return Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 10;
}

/* ==========================================================
   الورديات (فتح/إغلاق الصندوق)
   ========================================================== */
function getOpenShift() {
  const branch = getCurrentBranch();
  return db.prepare(`SELECT * FROM shifts WHERE branch_id = ? AND status = 'open' LIMIT 1`).get(branch.id);
}

function openShift(openingAmount, userId) {
  const existing = getOpenShift();
  if (existing) return { success: false, message: 'يوجد وردية مفتوحة بالفعل', shift: existing };
  const branch = getCurrentBranch();
  const amount = Number(openingAmount ?? 0);
  const actor = db.prepare('SELECT id,is_active FROM users WHERE id=? AND branch_id=?').get(Number(userId), branch.id);
  if (!actor || !actor.is_active) throw new Error('المستخدم الذي يفتح جلسة الصندوق غير صالح.');
  if (!Number.isFinite(amount) || amount < 0) throw new Error('مبلغ افتتاح الصندوق غير صالح.');
  const info = db
    .prepare(`INSERT INTO shifts (uuid, branch_id, opened_by, opening_amount, status) VALUES (?, ?, ?, ?, 'open')`)
    .run(uuid(), branch.id, actor.id, Math.round(amount * 100) / 100);
  return { success: true, id: info.lastInsertRowid };
}

// يحسب الكاش المتوقع في الصندوق: الافتتاحي + صافي المبيعات النقدية (بعد الباقي)
// + حركات الإدخال - المرتجعات النقدية - حركات الإخراج. cash_amount هو المبلغ
// المستلَم فعلياً، لهذا نطرح change_due هنا مرة واحدة.
function computeExpectedCash(shift) {
  const cashSales = db
    .prepare(
      `SELECT COALESCE(SUM(cash_amount - change_due),0) AS c FROM sales
       WHERE shift_id = ? AND status IN ('completed','partially_refunded')`
    )
    .get(shift.id).c;
  const cashReturns = db
    .prepare(
      `SELECT COALESCE(SUM(r.total_refunded),0) AS c FROM returns r
       WHERE r.shift_id = ? AND r.refund_method = 'cash'`
    )
    .get(shift.id).c;
  const cashIn = db.prepare(`SELECT COALESCE(SUM(amount),0) AS c FROM cash_movements WHERE shift_id=? AND type='cash_in'`).get(shift.id).c;
  const cashOut = db.prepare(`SELECT COALESCE(SUM(amount),0) AS c FROM cash_movements WHERE shift_id=? AND type='cash_out'`).get(shift.id).c;
  return shift.opening_amount + cashSales - cashReturns + cashIn - cashOut;
}

function getShiftSummary(shiftId, branchId = null, viewerUserId = null, viewerRole = null) {
  const shift = db.prepare('SELECT * FROM shifts WHERE id = ? AND (? IS NULL OR branch_id = ?)').get(shiftId, branchId, branchId);
  if (!shift) return null;
  if (viewerUserId != null && Number(shift.opened_by) !== Number(viewerUserId) && !['admin', 'manager'].includes(viewerRole)) {
    throw new Error('لا تملك صلاحية عرض تفاصيل جلسة صندوق فتحها موظف آخر.');
  }
  const sales = db
    .prepare(
      `SELECT COUNT(*) AS count, COALESCE(SUM(grand_total),0) AS total,
              COALESCE(SUM(cash_amount - change_due),0) AS cash, COALESCE(SUM(card_amount),0) AS card,
              COALESCE(SUM(delivery_fee),0) AS deliveryFees
       FROM sales WHERE shift_id = ? AND status IN ('completed','partially_refunded')`
    )
    .get(shiftId);
  const returns = db
    .prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(total_refunded),0) AS total FROM returns WHERE shift_id = ?`)
    .get(shiftId);
  return {
    ...shift,
    sales,
    returns,
    expectedCash: shift.status === 'closed' ? shift.expected_cash : computeExpectedCash(shift),
  };
}

const closeShiftTx = db.transaction((shiftId, actualCash, userId, notes, branchId = null) => {
  const shift = db.prepare('SELECT * FROM shifts WHERE id = ? AND (? IS NULL OR branch_id = ?)').get(shiftId, branchId, branchId);
  if (!shift || shift.status !== 'open') throw new Error('لا توجد وردية مفتوحة بهذا المعرّف');
  const branch = getCurrentBranch();
  const actor = db.prepare('SELECT id,role,is_active FROM users WHERE id=? AND branch_id=?').get(Number(userId), branch.id);
  if (!actor || !actor.is_active) throw new Error('المستخدم الذي يغلق جلسة الصندوق غير صالح.');
  if (Number(shift.opened_by) !== actor.id && !['admin','manager'].includes(actor.role)) throw new Error('لا يمكن إغلاق جلسة صندوق فتحها موظف آخر إلا بواسطة مدير.');
  const actual = Number(actualCash);
  if (!Number.isFinite(actual) || actual < 0) throw new Error('المبلغ الفعلي في الصندوق غير صالح.');
  const expected = computeExpectedCash(shift);
  const diff = actual - expected;
  db.prepare(
    `UPDATE shifts SET status='closed', closed_by=?, expected_cash=?, actual_cash=?, cash_difference=?, closed_at=datetime('now'), notes=?
     WHERE id = ?`
  ).run(userId || null, expected, actualCash, diff, notes || null, shiftId);
  return { success: true, expected, actual: actualCash, difference: diff };
});

function closeShift(shiftId, actualCash, userId, notes) {
  const branchId = getCurrentBranch().id;
  const shift = db.prepare('SELECT opened_by, status FROM shifts WHERE id=? AND branch_id=?').get(Number(shiftId), branchId);
  if (!shift || shift.status !== 'open') throw new Error('لا توجد جلسة صندوق مفتوحة بهذا المعرّف.');
  const actor = db.prepare('SELECT role FROM users WHERE id=? AND branch_id=? AND is_active=1').get(Number(userId), branchId);
  if (!actor) throw new Error('المستخدم الحالي غير صالح.');
  if (Number(shift.opened_by) !== Number(userId) && !['admin','manager'].includes(actor.role)) throw new Error('لا يمكن إلا لمن فتح جلسة الصندوق أو لمدير إغلاقها.');
  return closeShiftTx(shiftId, actualCash, userId, notes, branchId);
}

function listShifts(filters = {}) {
  const branch = getCurrentBranch();
  let sql = `SELECT s.*, uo.full_name AS opened_by_name, uc.full_name AS closed_by_name
             FROM shifts s
             LEFT JOIN users uo ON uo.id = s.opened_by
             LEFT JOIN users uc ON uc.id = s.closed_by
             WHERE s.branch_id = ?`;
  const params = [branch.id];
  if (filters.from) {
    sql += ' AND s.opened_at >= ?';
    params.push(filters.from);
  }
  if (filters.to) {
    sql += ' AND s.opened_at <= ?';
    params.push(filters.to);
  }
  sql += ' ORDER BY s.opened_at DESC LIMIT 100';
  return db.prepare(sql).all(...params);
}

/* ==========================================================
   موديول الرواتب — راتب شهري ثابت + إضافات/خصميات/سلف
   ========================================================== */
/* ==========================================================
   Payroll v2 — مستقل تماماً عن حسابات المستخدمين
   ========================================================== */
function normalizePayrollMonth(monthKey) {
  const m = String(monthKey || '').trim();
  if (!/^\d{4}-\d{2}$/.test(m)) throw new Error('الشهر غير صالح.');
  const [year, month] = m.split('-').map(Number);
  if (month < 1 || month > 12) throw new Error('الشهر غير صالح.');
  return m;
}
function daysInPayrollMonth(monthKey) { const [y,m] = normalizePayrollMonth(monthKey).split('-').map(Number); return new Date(y,m,0).getDate(); }
// يحوّل سلسلة "YYYY-MM-DD" إلى Date محلي (بدون قراءتها كـ UTC كما يفعل new Date(str)
// افتراضياً)، حتى تُقارَن بشكل صحيح مع تواريخ أخرى مبنية بنفس الطريقة (new Date(y,m,d)).
function parsePayrollDateLocal(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || '').trim());
  if (!match) return null;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}
// "اليوم" حسب المنطقة الزمنية للمؤسسة (لا حسب UTC الخاص بعملية Electron)، لنفس السبب
// الموثّق أعلى dateRangeParams(): لا نريد يوم العمل ينقلب عند منتصف الليل UTC.
function payrollTodayLocal() {
  const profile = getGlobalProfile();
  const timeZone = profile?.timezone || 'UTC';
  let str;
  try { str = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
  catch (_) { str = new Date().toISOString().slice(0, 10); }
  return parsePayrollDateLocal(str);
}
// عدد الأيام "المستحقة" فعلياً لعامل ضمن شهر الرواتب، بدءاً من تاريخ التحاقه (start_date،
// أو أول الشهر افتراضياً) وحتى اليوم الحالي (أو آخر الشهر إن كان الشهر قد انتهى فعلاً).
// هذا هو أساس احتساب الراتب تلقائياً يوماً بيوم بدل افتراض شهر كامل من أول يوم.
function daysElapsedInPayrollPeriod(monthKey, startDateValue) {
  const dim = daysInPayrollMonth(monthKey);
  const [year, month] = normalizePayrollMonth(monthKey).split('-').map(Number);
  const periodStart = new Date(year, month - 1, 1);
  const periodEnd = new Date(year, month - 1, dim);
  let start = parsePayrollDateLocal(startDateValue) || periodStart;
  if (start < periodStart) start = periodStart;
  if (start > periodEnd) return 0; // لم يلتحق العامل بعد ضمن هذا الشهر
  const today = payrollTodayLocal();
  const asOf = today < start ? null : (today > periodEnd ? periodEnd : today);
  if (!asOf) return 0;
  const msPerDay = 24 * 60 * 60 * 1000;
  const days = Math.round((asOf - start) / msPerDay) + 1;
  return Math.max(0, Math.min(dim, days));
}
function payrollDaysElapsedThrough(monthKey, startDateValue, asOfDateValue) {
  const [year, month] = normalizePayrollMonth(monthKey).split('-').map(Number);
  const dim = daysInPayrollMonth(monthKey);
  const periodStart = new Date(year, month - 1, 1);
  const periodEnd = new Date(year, month - 1, dim);
  let start = parsePayrollDateLocal(startDateValue) || periodStart;
  if (start < periodStart) start = periodStart;
  if (start > periodEnd) return 0;
  let asOf = parsePayrollDateLocal(asOfDateValue) || payrollTodayLocal();
  if (asOf < start) return 0;
  if (asOf > periodEnd) asOf = periodEnd;
  const msPerDay = 24 * 60 * 60 * 1000;
  const days = Math.round((asOf - start) / msPerDay) + 1;
  return Math.max(0, Math.min(dim, days));
}

function payrollMonth(monthId) {
  const b = getCurrentBranch();
  const row = db.prepare('SELECT * FROM payroll_months WHERE id=? AND branch_id=?').get(Number(monthId), b.id);
  if (!row) throw new Error('سجل الشهر غير موجود.');
  return row;
}
function getOrCreatePayrollMonth(monthKey, createdBy=null) {
  const key = normalizePayrollMonth(monthKey); const b = getCurrentBranch();
  let month = db.prepare('SELECT * FROM payroll_months WHERE branch_id=? AND month_key=?').get(b.id,key);
  if (!month) {
    try {
      const info = db.prepare('INSERT INTO payroll_months(uuid,branch_id,month_key) VALUES(?,?,?)').run(uuid(),b.id,key);
      month = db.prepare('SELECT * FROM payroll_months WHERE id=?').get(info.lastInsertRowid);
    } catch (error) {
      if (!/UNIQUE constraint failed.*payroll_months/i.test(String(error?.message || ''))) throw error;
      month = db.prepare('SELECT * FROM payroll_months WHERE branch_id=? AND month_key=?').get(b.id,key);
    }
  }
  const active = db.prepare('SELECT * FROM payroll_employees WHERE branch_id=? AND is_active=1 ORDER BY full_name COLLATE NOCASE').all(b.id);
  const existing = new Set(db.prepare('SELECT employee_id FROM payroll_employee_months WHERE month_id=?').all(month.id).map(r=>Number(r.employee_id)));
  // start_date الافتراضي هو أول يوم من الشهر (عامل مستمر منذ بداية الشهر) — إلا إذا
  // كان العامل نفسه قد أُضيف (created_at) بعد بداية هذا الشهر، وعندها نفترض بداية
  // استحقاقه من تاريخ إضافته فعلياً، لا من أول الشهر. هذا يمنع احتساب راتب شهر كامل
  // تلقائياً لعامل جديد أُضيف في منتصف الشهر. المدير يستطيع لاحقاً تعديل التاريخ يدوياً
  // من واجهة الرواتب إذا احتاج تصحيحه، وعندها يُعاد احتساب الراتب يوماً بيوم من ذلك التاريخ.
  const periodStartStr = `${key}-01`;
  const insert = db.prepare(`INSERT INTO payroll_employee_months(month_id,employee_id,pay_type,pay_rate,base_amount,start_date) VALUES(?,?,?,?,?,?)`);
  const tx = db.transaction(() => {
    for (const e of active) {
      if (existing.has(Number(e.id))) continue;
      const type = ['monthly','daily','hourly'].includes(e.pay_type) ? e.pay_type : 'monthly';
      const rate = Math.max(0, Number(e.pay_rate || 0));
      const createdLocal = String(e.hire_date || e.created_at || '').slice(0, 10); // YYYY-MM-DD
      const startDate = createdLocal > periodStartStr ? createdLocal : periodStartStr;
      insert.run(month.id,e.id,type,rate,0,startDate);
    }
  });
  tx();
  return month;
}
function payrollMultiplyDivideMinor(valueMinor, quantity, multiplier = 1, divisor = 1) {
  const value = BigInt(Math.trunc(Number(valueMinor || 0)));
  const q = BigInt(Math.max(0, Math.trunc(Number(money.toMinor(String(Number(quantity || 0)), 6)) || 0)));
  const m = BigInt(Math.max(0, Math.trunc(Number(money.toMinor(String(Number(multiplier || 0)), 6)) || 0)));
  const divisorScaled = BigInt(Math.max(1, Math.trunc(Number(money.toMinor(String(Number(divisor || 1)), 6)) || 0)));
  const d = divisorScaled * 1000000n;
  const numerator = value * q * m;
  if (numerator === 0n) return 0;
  return Number((numerator + d / 2n) / d);
}
function payrollRatioMinor(valueMinor, numerator, denominator) {
  return payrollMultiplyDivideMinor(valueMinor, numerator, 1, denominator);
}

function recalcPayrollEmployeeMonth(monthId, employeeId, options = {}) {
  const b = getCurrentBranch(); const month = payrollMonth(monthId);
  const em = db.prepare(`SELECT m.*,e.full_name,e.job_title,e.pay_type employee_pay_type,e.pay_rate employee_pay_rate,e.is_active
    FROM payroll_employee_months m JOIN payroll_employees e ON e.id=m.employee_id
    WHERE m.month_id=? AND m.employee_id=? AND e.branch_id=?`).get(Number(monthId),Number(employeeId),b.id);
  if (!em) throw new Error('العامل غير موجود في هذا الشهر.');
  const tx = db.prepare(`SELECT type,COALESCE(SUM(amount),0) amount,COALESCE(SUM(quantity),0) quantity,COALESCE(SUM(overtime_hours),0) overtime_hours,AVG(COALESCE(overtime_multiplier,1.5)) overtime_multiplier
    FROM payroll_transactions WHERE month_id=? AND employee_id=? AND branch_id=? GROUP BY type`).all(month.id,em.employee_id,b.id);
  const sums = Object.fromEntries(tx.map(x=>[x.type,{amount:Number(x.amount||0),quantity:Number(x.quantity||0)}]));
  const scheduledAdvanceMinor = Number(db.prepare(`
    SELECT COALESCE(SUM(i.amount_minor - COALESCE((SELECT SUM(CASE WHEN p.payment_type='direct' THEN pa.amount_minor ELSE 0 END) FROM payroll_advance_payment_allocations pa JOIN payroll_advance_payments p ON p.id=pa.payment_id WHERE p.voided_at IS NULL AND pa.installment_id=i.id),0)),0) amount_minor
    FROM payroll_advance_installments i
    JOIN payroll_advances a ON a.id=i.advance_id
    WHERE a.branch_id=? AND a.employee_id=? AND a.status='active' AND i.month_key=?
  `).get(b.id, em.employee_id, month.month_key)?.amount_minor || 0);
  const unit = Number(getGlobalProfile()?.currency_minor_unit || 2);
  const scheduledAdvance = money.fromMinor(scheduledAdvanceMinor, unit);
  const absDays = sums.absence?.quantity || 0;
  // ساعات العمل الفعلية لهذا الشهر = مجموع سجلات "ساعات يوم" التي أدخلها المدير يوماً بيوم
  // (نوع الحركة 'hours'، حيث quantity = عدد الساعات في ذلك اليوم). إن لم تُسجَّل أي حركة
  // بعد هذا الشهر (مثلاً بيانات قديمة قبل هذه الميزة)، نستخدم regular_hours المُدخل يدوياً
  // كقيمة احتياطية للتوافق العكسي فقط.
  const loggedHours = sums.hours?.quantity || 0;
  const hoursForPay = loggedHours > 0 ? loggedHours : Number(em.regular_hours||0);
  const type = em.pay_type;
  const rateMinor = Number(em.pay_rate_minor || money.toMinor(Number(em.pay_rate||0),unit));
  const dim = daysInPayrollMonth(month.month_key);
  const elapsedDays = options.asOfDate ? payrollDaysElapsedThrough(month.month_key, em.start_date, options.asOfDate) : daysElapsedInPayrollPeriod(month.month_key, em.start_date);
  let baseMinor = 0;
  if (type==='hourly') baseMinor = payrollMultiplyDivideMinor(rateMinor, hoursForPay, 1, 1);
  else if (type==='monthly') baseMinor = payrollRatioMinor(rateMinor, elapsedDays, dim);
  else if (type==='daily') baseMinor = payrollMultiplyDivideMinor(rateMinor, elapsedDays, 1, 1);
  else baseMinor = Number(em.base_amount_minor || money.toMinor(Number(em.base_amount||0),unit));
  const absenceMinor = type==='monthly' ? payrollRatioMinor(rateMinor, absDays, dim) : type==='daily' ? payrollMultiplyDivideMinor(rateMinor, absDays, 1, 1) : 0;
  const bonusMinor = money.add(...tx.filter(x=>x.type==='bonus').map(x=>money.toMinor(Number(x.amount||0),unit)));
  const deductionMinor = money.add(...tx.filter(x=>x.type==='deduction').map(x=>money.toMinor(Number(x.amount||0),unit)));
  const overtimeRows = tx.filter(x=>x.type==='overtime');
  const overtimeHours = overtimeRows.reduce((sum,x)=>sum+Number(x.overtime_hours||0),0);
  const overtimeLegacyMinor = money.add(...overtimeRows.filter(x=>!Number(x.overtime_hours||0)).map(x=>money.toMinor(Number(x.amount||0),unit)));
  const workHoursPerDay=Number(getSetting('payroll_work_hours_per_day','8'))||8;
  const overtimeMinor = overtimeHours>0 ? overtimeRows.reduce((sum,x)=>{
    const hours=Number(x.overtime_hours||0), mult=Number(x.overtime_multiplier||1.5);
    const divisor = type==='hourly' ? 1 : (type==='daily' ? workHoursPerDay : dim*workHoursPerDay);
    return sum + payrollMultiplyDivideMinor(rateMinor, hours, mult, divisor);
  },0) : overtimeLegacyMinor;
  const beforeAdvancesMinor = Math.max(0, rateMinor ? money.add(baseMinor, -absenceMinor, -deductionMinor, bonusMinor, overtimeMinor) : 0);
  const netBeforeDebtMinor = money.add(beforeAdvancesMinor, -Number(scheduledAdvanceMinor||0));
  const debtMinor = Math.max(0,-netBeforeDebtMinor);
  const netMinor = Math.max(0,netBeforeDebtMinor);
  const rounded = n=>Math.round(Number(n||0)*100)/100;
  db.prepare(`UPDATE payroll_employee_months SET base_amount=?,base_amount_minor=?,absence_days=?,absence_deduction=?,bonus_total=?,deduction_total=?,advance_total=?,overtime_total=?,net_salary=?,net_salary_minor=?,debt_carry=?,debt_carry_minor=?,regular_hours=?,updated_at=datetime('now') WHERE id=?`)
    .run(money.fromMinor(baseMinor,unit),baseMinor,rounded(absDays),money.fromMinor(absenceMinor,unit),money.fromMinor(bonusMinor,unit),money.fromMinor(deductionMinor,unit),money.fromMinor(Number(scheduledAdvanceMinor),unit),money.fromMinor(overtimeMinor,unit),money.fromMinor(netMinor,unit),netMinor,money.fromMinor(debtMinor,unit),debtMinor,Math.round(hoursForPay*100)/100,em.id);
  return db.prepare(`SELECT m.*,e.full_name,e.job_title,e.pay_type employee_pay_type,e.pay_rate employee_pay_rate,e.is_active
    FROM payroll_employee_months m JOIN payroll_employees e ON e.id=m.employee_id WHERE m.id=?`).get(em.id);
}
function listPayrollV2Employees(includeInactive=false) {
  const b=getCurrentBranch();
  return db.prepare(`SELECT id,uuid,full_name,job_title,pay_type,pay_rate,pay_rate_minor,is_active,national_id,hire_date,phone,department,iban,country_code,payroll_notes,created_at,updated_at FROM payroll_employees WHERE branch_id=? ${includeInactive?'':'AND is_active=1'} ORDER BY full_name COLLATE NOCASE`).all(b.id);
}
function addPayrollV2Employee(fullName,jobTitle,payType,payRate,meta={}) {
  const name=String(fullName||'').trim(), title=String(jobTitle||'').trim(), type=['monthly','daily','hourly'].includes(payType)?payType:'monthly', rate=Number(payRate);
  if(!name) return {success:false,message:'اسم العامل مطلوب.'};
  if(!title) return {success:false,message:'المسمى الوظيفي مطلوب.'};
  if(!Number.isFinite(rate)||rate<=0) return {success:false,message:'قيمة الأجر يجب أن تكون أكبر من صفر.'};
  const b=getCurrentBranch(), rateMinor=money.toMinor(rate,Number(getGlobalProfile()?.currency_minor_unit||2)), v=money.fromMinor(rateMinor,Number(getGlobalProfile()?.currency_minor_unit||2));
  const info=db.prepare(`INSERT INTO payroll_employees(uuid,branch_id,full_name,job_title,pay_type,pay_rate,pay_rate_minor,is_active,national_id,hire_date,phone,department,iban,country_code,payroll_notes) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(uuid(),b.id,name,title,type,v,rateMinor,1,String(meta.nationalId||'').trim()||null,String(meta.hireDate||'').trim()||null,String(meta.phone||'').trim()||null,String(meta.department||'').trim()||null,String(meta.iban||'').trim()||null,String(meta.countryCode||'').trim()||null,String(meta.payrollNotes||'').trim()||null);
  return {success:true,id:Number(info.lastInsertRowid)};
}
function updatePayrollV2Employee(employeeId, fullName, jobTitle, payType, payRate, meta={}) {
  const b=getCurrentBranch(), id=Number(employeeId), name=String(fullName||'').trim(), title=String(jobTitle||'').trim(), type=['monthly','daily','hourly'].includes(payType)?payType:'monthly', rate=Number(payRate);
  if(!name||!title) return {success:false,message:'الاسم والوظيفة مطلوبان.'};
  if(!Number.isFinite(rate)||rate<=0) return {success:false,message:'قيمة الأجر يجب أن تكون أكبر من صفر.'};
  const row=db.prepare('SELECT id FROM payroll_employees WHERE id=? AND branch_id=?').get(id,b.id); if(!row) return {success:false,message:'العامل غير موجود.'};
  const unit=Number(getGlobalProfile()?.currency_minor_unit||2); const rateMinor=money.toMinor(rate,unit);
  const metaValues=[String(meta.nationalId||'').trim()||null,String(meta.hireDate||'').trim()||null,String(meta.phone||'').trim()||null,String(meta.department||'').trim()||null,String(meta.iban||'').trim()||null,String(meta.countryCode||'').trim()||null,String(meta.payrollNotes||'').trim()||null];
  db.prepare('UPDATE payroll_employees SET full_name=?,job_title=?,pay_type=?,pay_rate=?,pay_rate_minor=?,national_id=?,hire_date=?,phone=?,department=?,iban=?,country_code=?,payroll_notes=?,updated_at=datetime(\'now\'),synced=0 WHERE id=? AND branch_id=?').run(name,title,type,money.fromMinor(rateMinor,unit),rateMinor,...metaValues,id,b.id);
  return {success:true,id};
}
function setPayrollV2EmployeeActive(employeeId,isActive){ const b=getCurrentBranch(); const r=db.prepare('SELECT id FROM payroll_employees WHERE id=? AND branch_id=?').get(Number(employeeId),b.id); if(!r)return{success:false,message:'العامل غير موجود.'}; db.prepare('UPDATE payroll_employees SET is_active=?,updated_at=datetime(\'now\'),synced=0 WHERE id=?').run(isActive?1:0,r.id); return{success:true,isActive:!!isActive}; }
// حذف نهائي — مسموح فقط إذا العامل ما إله ولا سجل راتب واحد بأي شهر (يعني انضاف بالغلط
// ولم يُصرف له شيء بعد). إذا إله تاريخ، نرفض الحذف حتى لا تُفقد سجلات رواتب مدفوعة فعلياً
// أو ينكسر أي تقرير قديم يعتمد عليها — الخيار الصحيح حينها هو تعطيله (setPayrollV2EmployeeActive).
function deletePayrollV2Employee(employeeId){
  const b=getCurrentBranch();
  const r=db.prepare('SELECT id,full_name FROM payroll_employees WHERE id=? AND branch_id=?').get(Number(employeeId),b.id);
  if(!r) return {success:false,message:'العامل غير موجود.'};
  const historyCount=db.prepare('SELECT COUNT(*) c FROM payroll_employee_months WHERE employee_id=?').get(r.id).c;
  if(historyCount>0) return {success:false,message:`لا يمكن حذف "${r.full_name}" لأن له سجل رواتب سابق (${historyCount} شهر). عطّله بدلاً من ذلك للحفاظ على دقة التقارير القديمة.`};
  db.prepare('DELETE FROM payroll_employees WHERE id=? AND branch_id=?').run(r.id,b.id);
  return {success:true};
}
function getPayrollV2Report(monthKey) {
  const month = getPayrollV2Month(monthKey);
  const unit = Number(getGlobalProfile()?.currency_minor_unit || 2);
  const rows = month.items.map((x) => {
    const paidMinor = Number(x.paid_total_minor || 0);
    const netMinor = Number(x.net_salary_minor || 0);
    return {
      employeeId: x.employee_id, fullName: x.full_name, jobTitle: x.job_title,
      nationalId: x.national_id || '', department: x.department || '', iban: x.iban || '',
      payType: x.employee_pay_type || x.pay_type, payRate: money.fromMinor(Number(x.pay_rate_minor || 0), unit),
      base: money.fromMinor(Number(x.base_amount_minor || 0), unit),
      absence: Number(x.absence_days || 0), absenceDeduction: Number(x.absence_deduction || 0),
      bonuses: Number(x.bonus_total || 0), deductions: Number(x.deduction_total || 0),
      advances: Number(x.advance_total || 0), overtime: Number(x.overtime_total || 0),
      net: money.fromMinor(netMinor, unit), debtCarry: money.fromMinor(Number(x.debt_carry_minor || 0), unit),
      paid: money.fromMinor(paidMinor, unit), remaining: money.fromMinor(Math.max(0, netMinor-paidMinor), unit),
      status: x.payment_status || 'unpaid', active: Number(x.is_active) !== 0
    };
  });
  return { monthKey: month.month_key, status: month.status, generatedAt: new Date().toISOString(), total: rows.reduce((n,r)=>n+r.net,0), rows };
}

function getPayrollV2Month(monthKey) {
  const m=getOrCreatePayrollMonth(monthKey); const b=getCurrentBranch();
  const rows=db.prepare(`SELECT m.*,e.uuid employee_uuid,e.full_name,e.job_title,e.pay_type employee_pay_type,e.pay_rate employee_pay_rate,e.is_active
    FROM payroll_employee_months m JOIN payroll_employees e ON e.id=m.employee_id WHERE m.month_id=? AND e.branch_id=? ORDER BY e.full_name COLLATE NOCASE`).all(m.id,b.id);
  for(const r of rows) recalcPayrollEmployeeMonth(m.id,r.employee_id);
  const items=db.prepare(`SELECT m.*,e.uuid employee_uuid,e.full_name,e.job_title,e.pay_type employee_pay_type,e.pay_rate employee_pay_rate,e.is_active
    FROM payroll_employee_months m JOIN payroll_employees e ON e.id=m.employee_id WHERE m.month_id=? AND e.branch_id=? ORDER BY e.full_name COLLATE NOCASE`).all(m.id,b.id);
  const paymentRows=db.prepare(`SELECT employee_id,COALESCE(SUM(amount_minor),0) paid_minor,COALESCE(SUM(amount),0) paid_amount FROM payroll_payments WHERE branch_id=? AND month_id=? GROUP BY employee_id`).all(b.id,m.id);
  const paymentMap=new Map(paymentRows.map(x=>[Number(x.employee_id),x]));
  const unit=Number(getGlobalProfile()?.currency_minor_unit||2);
  const transactions=db.prepare('SELECT * FROM payroll_transactions WHERE month_id=? AND branch_id=? ORDER BY event_date DESC,id DESC').all(m.id,b.id);
  const enrichedItems=items.map(x=>{const paid=paymentMap.get(Number(x.employee_id));const paidMinor=Number(paid?.paid_minor||0);const netMinor=Number(x.net_salary_minor||money.toMinor(Number(x.net_salary||0),unit));return {...x,paid_total:money.fromMinor(paidMinor,unit),paid_total_minor:paidMinor,remaining_salary:money.fromMinor(Math.max(0,netMinor-paidMinor),unit),remaining_salary_minor:Math.max(0,netMinor-paidMinor),payment_status:paidMinor>=netMinor?'paid':paidMinor>0?'partial':'unpaid'};});
  const payableItems=enrichedItems.filter(x=>Number(x.is_active)!==0);
  return {id:m.id,uuid:m.uuid,month_key:m.month_key,status:m.status||'open',closed_at:m.closed_at||null,items:enrichedItems,transactions,total:money.fromMinor(payableItems.reduce((s,x)=>s+Number(x.net_salary_minor||money.toMinor(Number(x.net_salary||0),unit)),0),unit)};
}
function assertPayrollMonthMutable(month) {
  if (String(month.status || 'open') === 'paid') {
    throw new Error('تم صرف هذا الشهر بالكامل ولا يمكن تعديل مستحقاته. إذا كان هناك خطأ، استخدم قيد تصحيح مستقل ولا تعدّل السجل التاريخي.');
  }
}

function getPayrollEmployeePaymentState(monthId, employeeId) {
  const b = getCurrentBranch();
  const month = payrollMonth(monthId);
  const item = db.prepare(`SELECT m.*,e.full_name,e.is_active FROM payroll_employee_months m JOIN payroll_employees e ON e.id=m.employee_id WHERE m.month_id=? AND m.employee_id=? AND e.branch_id=?`).get(month.id, Number(employeeId), b.id);
  if (!item) throw new Error('العامل غير موجود في هذا الشهر.');
  const unit = Number(getGlobalProfile()?.currency_minor_unit || 2);
  const netMinor = money.toMinor(Number(item.net_salary || 0), unit);
  const paid = db.prepare('SELECT COALESCE(SUM(amount_minor),0) paid_minor FROM payroll_payments WHERE branch_id=? AND month_id=? AND employee_id=?').get(b.id, month.id, item.employee_id);
  const paidMinor = Number(paid?.paid_minor || 0);
  return { item, netMinor, paidMinor, remainingMinor: Math.max(0, netMinor - paidMinor), currencyMinorUnit: unit };
}

function addPayrollV2Transaction({monthId,employeeId,type,amount,quantity,eventDate,reason,createdBy,paidFromRegister,overtimeMultiplier=1.5}) {
  const b=getCurrentBranch(), m=payrollMonth(monthId);
  assertPayrollMonthMutable(m);
  // 'hours' = سجل ساعات عمل ليوم واحد بالتحديد (quantity = عدد الساعات)، يُستخدم مع
  // العاملين بالساعة بدل إدخال إجمالي شهري يدوي واحد عرضة للخطأ.
  if(type==='advance') throw new Error('السلف تُدار حصراً من سجل السلف المجدولة.');
  if(!['absence','bonus','deduction','overtime','hours'].includes(type)) throw new Error('نوع الحركة غير صالح.');
  const amt=Number(amount||0), qty=Number(quantity==null?1:quantity), date=String(eventDate||'').trim();
  const overtimeMultiplierValue=Number(overtimeMultiplier);
  if(!Number.isFinite(amt)||amt<0) throw new Error('مبلغ الحركة غير صالح.');
  const zeroAmountTypes = type==='absence' || type==='hours';
  if(!Number.isFinite(qty)||qty<=0) throw new Error(type==='hours' ? 'عدد الساعات غير صالح.' : 'الكمية غير صالحة.');
  if(type==='hours' && qty>24) throw new Error('لا يمكن أن يتجاوز عدد ساعات اليوم الواحد 24 ساعة.');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('تاريخ الحركة غير صالح.');
  const key=m.month_key; if(date.slice(0,7)!==key) throw new Error('تاريخ الحركة يجب أن يكون ضمن الشهر المحدد.');
  if(zeroAmountTypes && amt!==0) throw new Error(type==='absence' ? 'الغياب لا يحتاج مبلغًا؛ يُحسب الخصم تلقائيًا.' : 'ساعات العمل لا تحتاج مبلغًا؛ يُحسب الراتب تلقائياً من الساعات والأجر بالساعة.');
  if(!zeroAmountTypes && amt<=0) throw new Error('المبلغ يجب أن يكون أكبر من صفر.');
  const e=db.prepare('SELECT id,pay_type,full_name FROM payroll_employees WHERE id=? AND branch_id=?').get(Number(employeeId),b.id); if(!e)throw new Error('العامل غير موجود.');
  if(type==='hours' && e.pay_type!=='hourly') throw new Error('تسجيل الساعات متاح فقط للعاملين بنظام الأجر بالساعة.');
  // السلفة ممكن تتسجل كصرف نقدي فوري من الصندوق (لو الموظف استلمها كاش دلوقتي)، أو كقيد
  // رواتب بحت (لو هتتسوى لاحقاً بطريقة تانية). لو "من الصندوق"، لازم يكون فيه وردية مفتوحة
  // فعلاً عشان الفلوس فعلياً تخصم من رصيد الصندوق وتظهر في التقارير المالية.
  const wantsCashOut = false;
  const result=db.transaction(()=>{
    let cashMovementId=null;
    if(wantsCashOut){
      const openShift=getOpenShift();
      if(!openShift) throw new Error('لا يمكن تسجيل السلفة كصرف من الصندوق لعدم وجود وردية مفتوحة حالياً. افتح وردية أولاً، أو سجّل السلفة كقيد رواتب بدون خصمها من الصندوق الآن.');
      const cm=addCashMovement({shiftId:openShift.id,type:'cash_out',amount:amt,reason:`سلفة موظف: ${e.full_name}`,reference:'payroll_advance',createdBy});
      cashMovementId=cm.id;
    }
    const exists=db.prepare('SELECT id FROM payroll_employee_months WHERE month_id=? AND employee_id=?').get(m.id,e.id);
    if(!exists) db.prepare(`INSERT INTO payroll_employee_months(month_id,employee_id,pay_type,pay_rate,base_amount) SELECT ?,id,pay_type,pay_rate,CASE WHEN pay_type='monthly' THEN pay_rate WHEN pay_type='daily' THEN pay_rate*? ELSE 0 END FROM payroll_employees WHERE id=?`).run(m.id,daysInPayrollMonth(key),e.id);
    if(type==='absence') { const dup=db.prepare("SELECT id FROM payroll_transactions WHERE month_id=? AND employee_id=? AND type=\'absence\' AND event_date=?").get(m.id,e.id,date); if(dup) throw new Error('يوم الغياب هذا مسجل بالفعل.'); }
    if(type==='hours') { const dup=db.prepare("SELECT id FROM payroll_transactions WHERE month_id=? AND employee_id=? AND type=\'hours\' AND event_date=?").get(m.id,e.id,date); if(dup) throw new Error('ساعات هذا اليوم مسجلة بالفعل. احذف السجل القديم إن أردت تعديله.'); }
    const amountMinor = money.toMinor(amt, unit);
    const overtimeHoursValue = type === 'overtime' ? qty : 0;
    const overtimeMultiplierDb = type === 'overtime' ? overtimeMultiplierValue : 1.5;
    if (type === 'overtime') {
      if (!Number.isFinite(overtimeMultiplierValue) || overtimeMultiplierValue <= 0 || overtimeMultiplierValue > 10) {
        throw new Error('معامل الإضافي يجب أن يكون أكبر من صفر ولا يتجاوز 10.');
      }
    }
    const info=db.prepare(`INSERT INTO payroll_transactions(uuid,branch_id,month_id,employee_id,type,amount,amount_minor,quantity,event_date,reason,created_by,cash_movement_id,overtime_multiplier,overtime_hours) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      uuid(),b.id,m.id,e.id,type,money.fromMinor(amountMinor,unit),amountMinor,Math.round(qty*100)/100,date,String(reason||'').trim()||null,createdBy||null,cashMovementId,overtimeMultiplierDb,overtimeHoursValue
    );
    return {success:true,id:Number(info.lastInsertRowid),cashMovementId,item:recalcPayrollEmployeeMonth(m.id,e.id)};
  })();
  return result;
}
function removePayrollV2Transaction(transactionId,deletedBy){
  const b=getCurrentBranch();
  const t=db.prepare('SELECT id,month_id,employee_id,amount,cash_movement_id FROM payroll_transactions WHERE id=? AND branch_id=?').get(Number(transactionId),b.id);
  if(!t)throw new Error('الحركة غير موجودة.');
  assertPayrollMonthMutable(payrollMonth(t.month_id));
  const result=db.transaction(()=>{
    // لو السلفة دي كانت اتخصمت فعلياً من الصندوق، لازم نرجّع المبلغ للصندوق (حركة إدخال
    // معاكسة) قبل حذف القيد، وإلا هيفضل رصيد الصندوق ناقص فلوس من غير سبب. نسيب حركة النقد
    // الأصلية زي ما هي (سجل تاريخي ثابت، متسقّ مع باقي جداول الصندوق) ونضيف حركة عكسية.
    if(t.cash_movement_id){
      const openShift=getOpenShift();
      if(!openShift) throw new Error('هذه السلفة مسجَّلة كصرف من الصندوق. لحذفها لازم تفتح وردية أولاً حتى يُعاد المبلغ للصندوق.');
      addCashMovement({shiftId:openShift.id,type:'cash_in',amount:t.amount,reason:'إلغاء/حذف سلفة موظف (تصحيح)',reference:`payroll_advance_reversal:${t.id}`,createdBy:deletedBy||null});
    }
    db.prepare('DELETE FROM payroll_transactions WHERE id=?').run(t.id);
    return recalcPayrollEmployeeMonth(t.month_id,t.employee_id);
  })();
  return {success:true,item:result};
}
// يحدّد تاريخ التحاق العامل ضمن هذا الشهر تحديداً (متى بدأ يستحق راتباً هذا الشهر).
// بعدها يُعاد احتساب صافي الراتب فوراً على أساس عدد الأيام من هذا التاريخ وحتى اليوم.
function setPayrollEmployeeMonthStartDate(monthId,employeeId,startDate){
  const b=getCurrentBranch(); const m=payrollMonth(monthId);
  assertPayrollMonthMutable(m);
  const date=String(startDate||'').trim();
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)) return {success:false,message:'تاريخ البدء غير صالح.'};
  const row=db.prepare(`SELECT m.id FROM payroll_employee_months m JOIN payroll_employees e ON e.id=m.employee_id WHERE m.month_id=? AND m.employee_id=? AND e.branch_id=?`).get(m.id,Number(employeeId),b.id);
  if(!row) return {success:false,message:'العامل غير موجود في هذا الشهر.'};
  db.prepare(`UPDATE payroll_employee_months SET start_date=?,updated_at=datetime('now'),synced=0 WHERE id=?`).run(date,row.id);
  return {success:true,item:recalcPayrollEmployeeMonth(m.id,Number(employeeId))};
}

function normalizePayrollFirstDeductionMonth(monthKey) {
  return normalizePayrollMonth(monthKey || currentPayrollMonthKey());
}
function currentPayrollMonthKey() { const d=payrollTodayLocal(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`; }
function addMonthsToPayrollMonth(monthKey, offset) {
  const [y,m]=normalizePayrollMonth(monthKey).split('-').map(Number);
  const d=new Date(y,m-1+Number(offset),1);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
}
function createPayrollAdvance({monthId,employeeId,amount,installmentCount=1,firstDeductionMonth,reason,paidFromRegister=false,createdBy}) {
  const b=getCurrentBranch(); const m=payrollMonth(monthId); assertPayrollMonthMutable(m);
  const employee=db.prepare('SELECT id,full_name,is_active FROM payroll_employees WHERE id=? AND branch_id=?').get(Number(employeeId),b.id);
  if(!employee) throw new Error('العامل غير موجود.');
  if(!employee.is_active) throw new Error('لا يمكن إنشاء سلفة لعامل معطّل.');
  const unit=Number(getGlobalProfile()?.currency_minor_unit||2);
  const principalMinor=money.toMinor(Number(amount),unit);
  if(principalMinor<=0) throw new Error('قيمة السلفة يجب أن تكون أكبر من صفر.');
  const count=Number(installmentCount);
  if(!Number.isInteger(count)||count<1||count>36) throw new Error('عدد أقساط السلفة يجب أن يكون بين 1 و36.');
  const first=normalizePayrollFirstDeductionMonth(firstDeductionMonth || m.month_key);
  if(first < m.month_key) throw new Error('شهر بدء الخصم لا يمكن أن يكون قبل شهر السلفة.');
  const regularMinor=Math.floor(principalMinor/count);
  const remainder=principalMinor-(regularMinor*count);
  const tx=db.transaction(()=>{
    let cashMovementId=null;
    if(paidFromRegister){
      const shift=getOpenShift();
      if(!shift) throw new Error('لا يمكن دفع السلفة نقداً من الصندوق دون وردية مفتوحة. افتح وردية أولاً أو سجّلها بدون صرف فوري.');
      const cm=addCashMovement({shiftId:shift.id,type:'cash_out',amount:money.fromMinor(principalMinor,unit),reason:`سلفة موظف: ${employee.full_name}`,reference:'payroll_advance',createdBy});
      cashMovementId=cm.id;
    }
    const advanceInfo=db.prepare(`INSERT INTO payroll_advances(uuid,branch_id,employee_id,principal,principal_minor,installment_count,installment_amount,installment_amount_minor,first_deduction_month,reason,cash_movement_id,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(uuid(),b.id,employee.id,money.fromMinor(principalMinor,unit),principalMinor,count,money.fromMinor(regularMinor,unit),regularMinor,first,String(reason||'').trim()||null,cashMovementId,createdBy||null);
    const advanceId=Number(advanceInfo.lastInsertRowid);
    const ins=db.prepare(`INSERT INTO payroll_advance_installments(advance_id,month_key,installment_no,amount,amount_minor) VALUES(?,?,?,?,?)`);
    for(let n=1;n<=count;n++){
      const minor=regularMinor+(n===count?remainder:0); const month=addMonthsToPayrollMonth(first,n-1);
      ins.run(advanceId,month,n,money.fromMinor(minor,unit),minor);
    }
    return {advanceId,cashMovementId,principalMinor};
  })();
  return {success:true,id:tx.advanceId,cashMovementId:tx.cashMovementId,principal:money.fromMinor(tx.principalMinor,unit),installmentCount:count,firstDeductionMonth:first};
}
function listPayrollAdvances(employeeId=null){
  const b=getCurrentBranch(); const unit=Number(getGlobalProfile()?.currency_minor_unit||2);
  const where=employeeId!=null?'AND a.employee_id=?':''; const params=employeeId!=null?[b.id,Number(employeeId)]:[b.id];
  const rows=db.prepare(`SELECT a.*,e.full_name employee_name FROM payroll_advances a JOIN payroll_employees e ON e.id=a.employee_id WHERE a.branch_id=? ${where} ORDER BY a.created_at DESC,a.id DESC`).all(...params);
  return rows.map(a=>{
    const paid=db.prepare(`SELECT COALESCE(SUM(CASE WHEN p.payment_type='direct' THEN pa.amount_minor ELSE 0 END),0) direct_paid_minor,COALESCE(SUM(pa.amount_minor),0) recovered_minor FROM payroll_advance_payment_allocations pa JOIN payroll_advance_payments p ON p.id=pa.payment_id WHERE p.voided_at IS NULL AND p.advance_id=?`).get(a.id);
    const directPaidMinor=Number(paid?.direct_paid_minor||0);
    const recoveredMinor=Number(paid?.recovered_minor||0);
    const remainingMinor=Math.max(0,Number(a.principal_minor||0)-recoveredMinor);
    const current= db.prepare(`SELECT COALESCE(SUM(i.amount_minor),0) scheduled_minor,
      COALESCE(SUM(CASE WHEN i.month_key<=? THEN i.amount_minor ELSE 0 END),0) accrued_minor,
      COALESCE(SUM(CASE WHEN i.month_key<=? THEN (i.amount_minor-COALESCE((SELECT SUM(CASE WHEN p.payment_type='direct' THEN pa.amount_minor ELSE 0 END) FROM payroll_advance_payment_allocations pa JOIN payroll_advance_payments p ON p.id=pa.payment_id WHERE p.voided_at IS NULL AND pa.installment_id=i.id),0)) ELSE 0 END),0) overdue_direct_adjusted_minor
      FROM payroll_advance_installments i WHERE i.advance_id=?`).get(currentPayrollMonthKey(),currentPayrollMonthKey(),a.id);
    const status=remainingMinor<=0?'completed':'active';
    if (String(a.status)!==status) db.prepare(`UPDATE payroll_advances SET status=?,updated_at=datetime('now'),synced=0 WHERE id=? AND branch_id=?`).run(status,a.id,b.id);
    return {...a,status,principal:money.fromMinor(Number(a.principal_minor||0),unit),installment_amount:money.fromMinor(Number(a.installment_amount_minor||0),unit),scheduled_minor:Number(current?.scheduled_minor||0),scheduled:money.fromMinor(Number(current?.scheduled_minor||0),unit),accrued_minor:Number(current?.accrued_minor||0),accrued:money.fromMinor(Number(current?.accrued_minor||0),unit),direct_paid_minor:directPaidMinor,direct_paid:money.fromMinor(directPaidMinor,unit),recovered_minor:recoveredMinor,recovered:money.fromMinor(recoveredMinor,unit),remaining_minor:remainingMinor,remaining:money.fromMinor(remainingMinor,unit)};
  });
}

function listPayrollAdvancePayments(advanceId){
  const b=getCurrentBranch(); const a=db.prepare('SELECT id FROM payroll_advances WHERE id=? AND branch_id=?').get(Number(advanceId),b.id); if(!a) throw new Error('السلفة غير موجودة.');
  return db.prepare(`SELECT p.*,COALESCE(SUM(pa.amount_minor),0) allocated_minor FROM payroll_advance_payments p LEFT JOIN payroll_advance_payment_allocations pa ON pa.payment_id=p.id WHERE p.advance_id=? AND p.branch_id=? GROUP BY p.id ORDER BY p.payment_date DESC,p.id DESC`).all(a.id,b.id);
}

function repayPayrollAdvance({advanceId,amount,paymentDate,method='cash',reference,notes,createdBy,paidFromRegister=false}){
  const b=getCurrentBranch(); const unit=Number(getGlobalProfile()?.currency_minor_unit||2);
  const advance=db.prepare('SELECT * FROM payroll_advances WHERE id=? AND branch_id=?').get(Number(advanceId),b.id);
  if(!advance) throw new Error('السلفة غير موجودة.');
  if(String(advance.status)==='completed') throw new Error('هذه السلفة مسددة بالكامل.');
  const date = String(paymentDate || payrollTodayLocal().toISOString().slice(0,10)).slice(0,10);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('تاريخ تسديد السلفة غير صالح.');
  const amountMinor=money.toMinor(Number(amount),unit); if(amountMinor<=0) throw new Error('قيمة التسديد يجب أن تكون أكبر من صفر.');
  const recovered=Number(db.prepare('SELECT COALESCE(SUM(amount_minor),0) x FROM payroll_advance_payment_allocations pa JOIN payroll_advance_payments p ON p.id=pa.payment_id WHERE p.voided_at IS NULL AND p.advance_id=?').get(advance.id).x||0);
  const remaining=Math.max(0,Number(advance.principal_minor||0)-recovered);
  if(amountMinor>remaining) throw new Error(`مبلغ التسديد أكبر من الرصيد المتبقي (${money.fromMinor(remaining,unit)}).`);
  const tx=db.transaction(()=>{
    let cashMovementId=null;
    if(paidFromRegister){
      const shift=getOpenShift(); if(!shift) throw new Error('لا يمكن تسجيل التسديد نقداً من الصندوق دون وردية مفتوحة.');
      const cm=addCashMovement({shiftId:shift.id,type:'cash_in',amount:money.fromMinor(amountMinor,unit),reason:'تسديد سلفة موظف',reference:`payroll_advance_repayment:${advance.id}`,createdBy}); cashMovementId=cm.id;
    }
    const paymentInfo=db.prepare(`INSERT INTO payroll_advance_payments(uuid,branch_id,advance_id,payment_type,amount,amount_minor,payment_date,method,reference,notes,cash_movement_id,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(uuid(),b.id,advance.id,'direct',money.fromMinor(amountMinor,unit),amountMinor,date,String(method||'cash'),String(reference||'payroll_advance_repayment'),String(notes||'').trim()||null,cashMovementId,createdBy||null);
    const paymentId=Number(paymentInfo.lastInsertRowid);
    let left=amountMinor;
    const installments=db.prepare(`SELECT i.* FROM payroll_advance_installments i WHERE i.advance_id=? ORDER BY i.month_key,i.installment_no`).all(advance.id);
    for(const i of installments){
      if(left<=0) break;
      const already=Number(db.prepare(`SELECT COALESCE(SUM(CASE WHEN p.payment_type='direct' THEN pa.amount_minor ELSE 0 END),0) x FROM payroll_advance_payment_allocations pa JOIN payroll_advance_payments p ON p.id=pa.payment_id WHERE p.voided_at IS NULL AND pa.installment_id=?`).get(i.id).x||0);
      const open=Math.max(0,Number(i.amount_minor)-already); if(open<=0) continue;
      const alloc=Math.min(open,left); const ins=db.prepare(`INSERT INTO payroll_advance_payment_allocations(payment_id,installment_id,amount,amount_minor) VALUES(?,?,?,?)`).run(paymentId,i.id,money.fromMinor(alloc,unit),alloc); left-=alloc;
    }
    if(left>0) throw new Error('تعذر توزيع مبلغ التسديد على أقساط السلفة.');
    const newRecovered=recovered+amountMinor;
    if(newRecovered>=Number(advance.principal_minor)) db.prepare(`UPDATE payroll_advances SET status='completed',updated_at=datetime('now'),synced=0 WHERE id=? AND branch_id=?`).run(advance.id,b.id);
    return {id:paymentId,cashMovementId,amountMinor,remainingMinor:Math.max(0,Number(advance.principal_minor)-newRecovered)};
  })();
  return {success:true,id:tx.id,cashMovementId:tx.cashMovementId,amount:money.fromMinor(tx.amountMinor,unit),remaining:money.fromMinor(tx.remainingMinor,unit),status:tx.remainingMinor<=0?'completed':'active'};
}

function settlePayrollAdvance(advanceId,{paymentDate,method='cash',reference='payroll_advance_early_settlement',notes,createdBy,paidFromRegister=false}={}){
  const a=listPayrollAdvances(advanceId)[0]; if(!a) throw new Error('السلفة غير موجودة.');
  if(Number(a.remaining_minor||0)<=0) return {success:true,status:'completed',amount:'0.00',remaining:'0.00'};
  return repayPayrollAdvance({advanceId:a.id,amount:a.remaining,paymentDate,method,reference,notes,createdBy,paidFromRegister});
}

function recordPayrollSalaryAdvanceRecovery({monthId,employeeId,amountMinor,createdBy,sourcePaymentId}){
  const b=getCurrentBranch(); const m=payrollMonth(monthId); const unit=Number(getGlobalProfile()?.currency_minor_unit||2);
  const paidMinor=Math.max(0,Number(amountMinor||0)); if(!paidMinor) return {recoveredMinor:0};
  const advanceRows=db.prepare(`SELECT a.* FROM payroll_advances a WHERE a.branch_id=? AND a.employee_id=? AND a.status='active' ORDER BY a.first_deduction_month,a.created_at,a.id`).all(b.id,Number(employeeId));
  let left=paidMinor, recovered=0;
  for(const a of advanceRows){
    if(left<=0) break;
    const already=Number(db.prepare('SELECT COALESCE(SUM(pa.amount_minor),0) x FROM payroll_advance_payment_allocations pa JOIN payroll_advance_payments p ON p.id=pa.payment_id WHERE p.voided_at IS NULL AND p.advance_id=?').get(a.id).x||0);
    const remaining=Math.max(0,Number(a.principal_minor)-already); if(!remaining) continue;
    const dueThisMonth=Number(db.prepare(`SELECT COALESCE(SUM(i.amount_minor),0) x FROM payroll_advance_installments i WHERE i.advance_id=? AND i.month_key=?`).get(a.id,m.month_key).x||0); if(!dueThisMonth) continue;
    const salaryAlready=Number(db.prepare(`SELECT COALESCE(SUM(pa.amount_minor),0) x FROM payroll_advance_payment_allocations pa JOIN payroll_advance_payments p ON p.id=pa.payment_id WHERE p.voided_at IS NULL AND p.advance_id=? AND p.payment_type='salary' AND pa.installment_id IN (SELECT id FROM payroll_advance_installments WHERE advance_id=? AND month_key=?)`).get(a.id,a.id,m.month_key).x||0);
    const openDue=Math.max(0,dueThisMonth-salaryAlready); if(!openDue) continue;
    const alloc=Math.min(openDue,left,remaining); const paymentInfo=db.prepare(`INSERT INTO payroll_advance_payments(uuid,branch_id,advance_id,payment_type,amount,amount_minor,payment_date,method,reference,notes,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(uuid(),b.id,a.id,'salary',money.fromMinor(alloc,unit),alloc,`${m.month_key}-01`,'payroll',String(sourcePaymentId||'payroll_payment'),`خصم سلفة من راتب ${m.month_key}`,createdBy||null); const pid=Number(paymentInfo.lastInsertRowid);
    const inst=db.prepare(`SELECT id,amount_minor FROM payroll_advance_installments WHERE advance_id=? AND month_key=? ORDER BY installment_no`).all(a.id,m.month_key);
    let il=alloc;
    for(const i of inst){ if(il<=0) break; const alreadyI=Number(db.prepare(`SELECT COALESCE(SUM(CASE WHEN p.payment_type='salary' THEN pa.amount_minor ELSE 0 END),0) x FROM payroll_advance_payment_allocations pa JOIN payroll_advance_payments p ON p.id=pa.payment_id WHERE p.voided_at IS NULL AND pa.installment_id=?`).get(i.id).x||0); const openI=Math.max(0,Number(i.amount_minor)-alreadyI); if(!openI) continue; const q=Math.min(openI,il); db.prepare(`INSERT INTO payroll_advance_payment_allocations(payment_id,installment_id,amount,amount_minor) VALUES(?,?,?,?)`).run(pid,i.id,money.fromMinor(q,unit),q); il-=q; }
    recovered+=alloc; left-=alloc; const totalRecovered=already+alloc; if(totalRecovered>=Number(a.principal_minor)) db.prepare(`UPDATE payroll_advances SET status='completed',updated_at=datetime('now'),synced=0 WHERE id=? AND branch_id=?`).run(a.id,b.id);
  }
  return {recoveredMinor:recovered};
}


function getPayrollSettings(){const unit=Number(getGlobalProfile()?.currency_minor_unit||2),m=Number(getSetting('payroll_overtime_multiplier','1.5')),h=Number(getSetting('payroll_work_hours_per_day','8'));return{overtimeMultiplier:Number.isFinite(m)&&m>0?m:1.5,workHoursPerDay:Number.isFinite(h)&&h>0?h:8,currencyMinorUnit:unit};}
function savePayrollSettings({overtimeMultiplier,workHoursPerDay}={}){const m=Number(overtimeMultiplier),h=Number(workHoursPerDay);if(!Number.isFinite(m)||m<=0||m>10)throw new Error('معامل الإضافي يجب أن يكون بين 0 و10.');if(!Number.isFinite(h)||h<=0||h>24)throw new Error('ساعات العمل اليومية يجب أن تكون بين 0 و24.');setSetting('payroll_overtime_multiplier',String(m));setSetting('payroll_work_hours_per_day',String(h));return{success:true,overtimeMultiplier:m,workHoursPerDay:h};}
function setPayrollV2RegularHours(monthId,employeeId,hours){ const b=getCurrentBranch(); const m=payrollMonth(monthId); assertPayrollMonthMutable(m); const n=Number(hours); if(!Number.isFinite(n)||n<0||n>744)throw new Error('ساعات العمل غير صالحة.'); const e=db.prepare('SELECT id,pay_type,pay_rate FROM payroll_employees WHERE id=? AND branch_id=?').get(Number(employeeId),b.id); if(!e)throw new Error('العامل غير موجود.'); db.prepare(`INSERT INTO payroll_employee_months(month_id,employee_id,pay_type,pay_rate,base_amount) VALUES(?,?,?,?,0) ON CONFLICT(month_id,employee_id) DO NOTHING`).run(m.id,e.id,e.pay_type,e.pay_rate); db.prepare('UPDATE payroll_employee_months SET regular_hours=?,updated_at=datetime(\'now\'),synced=0 WHERE month_id=? AND employee_id=?').run(Math.round(n*100)/100,m.id,e.id); return{success:true,item:recalcPayrollEmployeeMonth(m.id,e.id)}; }
function recordPayrollPayment({monthId, employeeId, amount, method='cash', paymentDate, reference, notes, createdBy}) {
  const b = getCurrentBranch(); const unit=Number(getGlobalProfile()?.currency_minor_unit||2);
  const m = payrollMonth(monthId);
  assertPayrollMonthMutable(m);
  const state = getPayrollEmployeePaymentState(m.id, employeeId);
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) throw new Error('مبلغ صرف الراتب غير صالح.');
  if (!['cash','bank','other'].includes(String(method))) throw new Error('طريقة صرف الراتب غير صالحة.');
  const amountMinor = money.toMinor(value, unit);
  if (amountMinor <= 0) throw new Error('مبلغ صرف الراتب يجب أن يكون أكبر من صفر.');
  if (amountMinor > state.remainingMinor) throw new Error(`المبلغ أكبر من المتبقي للموظف. المتبقي: ${money.fromMinor(state.remainingMinor, unit)}`);
  const date = String(paymentDate || payrollTodayLocal()).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('تاريخ صرف الراتب غير صالح.');
  if (date.slice(0,7) !== m.month_key) throw new Error('تاريخ صرف الراتب يجب أن يكون ضمن الشهر المحدد.');
  const tx = db.transaction(() => {
    let cashMovementId = null;
    if (method === 'cash') {
      const shift = getOpenShift();
      if (!shift) throw new Error('لا يمكن صرف الراتب نقداً بدون وردية صندوق مفتوحة. افتح وردية أولاً أو اختر التحويل/أخرى.');
      const cm = addCashMovement({shiftId: shift.id, type:'cash_out', amount:money.fromMinor(amountMinor, unit), reason:`صرف راتب: ${state.item.full_name}`, reference:reference || 'payroll_salary', createdBy});
      cashMovementId = cm.id;
    }
    const info = db.prepare(`INSERT INTO payroll_payments(uuid,branch_id,month_id,employee_id,amount,amount_minor,method,payment_date,reference,notes,created_by,cash_movement_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(uuid(), b.id, m.id, state.item.employee_id, money.fromMinor(amountMinor, unit), amountMinor, method, date, String(reference||'').trim()||null, String(notes||'').trim()||null, createdBy||null, cashMovementId);
    const nextPaid = state.paidMinor + amountMinor;
    const monthItems = db.prepare(`SELECT m.employee_id,m.net_salary,e.is_active FROM payroll_employee_months m JOIN payroll_employees e ON e.id=m.employee_id WHERE m.month_id=?`).all(m.id);
    let allPaid = true;
    for (const row of monthItems.filter(x => Number(x.is_active)!==0)) {
      const net = money.toMinor(Number(row.net_salary||0), unit);
      const paid = db.prepare('SELECT COALESCE(SUM(amount_minor),0) x FROM payroll_payments WHERE branch_id=? AND month_id=? AND employee_id=?').get(b.id,m.id,row.employee_id).x;
      if (Number(paid) < net) { allPaid = false; break; }
    }
    if (allPaid && monthItems.some(x => Number(x.is_active)!==0)) {
      db.prepare(`UPDATE payroll_months SET status='paid',closed_at=datetime('now'),closed_by=?,synced=0 WHERE id=? AND branch_id=?`).run(createdBy||null,m.id,b.id);
    }
    const finalSalaryPayment = nextPaid >= state.netMinor;
    const scheduledRecoveryMinor = finalSalaryPayment ? money.toMinor(Number(state.item.advance_total || 0), unit) : 0;
    const recovery = scheduledRecoveryMinor > 0 ? recordPayrollSalaryAdvanceRecovery({monthId:m.id,employeeId:Number(employeeId),amountMinor:scheduledRecoveryMinor,createdBy,sourcePaymentId:Number(info.lastInsertRowid)}) : {recoveredMinor:0};
    return {success:true,id:Number(info.lastInsertRowid),cashMovementId,amountMinor,remainingMinor:Math.max(0,state.remainingMinor-amountMinor),monthStatus:allPaid?'paid':'open',advanceRecoveredMinor:recovery.recoveredMinor};
  })();
  return tx;
}

function calculatePayrollFinalSettlement(monthId, employeeId, settlementDate, additionalCompensation=0) {
  const b=getCurrentBranch(); const m=payrollMonth(monthId);
  const date=String(settlementDate||'').slice(0,10);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date) || date.slice(0,7)!==m.month_key) throw new Error('تاريخ إنهاء الخدمة يجب أن يكون ضمن شهر الرواتب المحدد.');
  const employee=db.prepare('SELECT * FROM payroll_employees WHERE id=? AND branch_id=?').get(Number(employeeId),b.id);
  if(!employee) throw new Error('العامل غير موجود.');
  const existing=db.prepare("SELECT id FROM payroll_final_settlements WHERE branch_id=? AND employee_id=? AND status='paid' ORDER BY id DESC LIMIT 1").get(b.id,employee.id);
  if(existing) throw new Error('تمت تسوية الموظف سابقاً.');
  const item=recalcPayrollEmployeeMonth(m.id,employee.id,{asOfDate:date});
  const unit=Number(getGlobalProfile()?.currency_minor_unit||2);
  const grossEarned=Number(item.base_amount||0)-Number(item.absence_deduction||0)+Number(item.bonus_total||0)+Number(item.overtime_total||0);
  const deductions=Number(item.deduction_total||0);
  const advanceRows=listPayrollAdvances(employee.id);
  const advanceBalanceMinor=advanceRows.reduce((sum,a)=>sum+Number(a.remaining_minor||0),0);
  const paidMinor=Number(db.prepare('SELECT COALESCE(SUM(amount_minor),0) x FROM payroll_payments WHERE branch_id=? AND month_id=? AND employee_id=?').get(b.id,m.id,employee.id).x||0);
  const additionalMinor=money.toMinor(Number(additionalCompensation||0),unit);
  if(additionalMinor<0) throw new Error('التعويض الإضافي غير صالح.');
  const grossMinor=Math.max(0,money.toMinor(grossEarned,unit));
  const deductionsMinor=Math.max(0,money.toMinor(deductions,unit));
  const finalGrossAfterDeductions=Math.max(0,grossMinor-deductionsMinor);
  const netDueBeforePaid=Math.max(0,finalGrossAfterDeductions+additionalMinor-advanceBalanceMinor);
  const netDueMinor=Math.max(0,netDueBeforePaid-paidMinor);
  return {employee,month:m,item,date,unit,grossMinor,deductionsMinor,advanceBalanceMinor,additionalMinor,paidMinor,netDueMinor,
    grossEarned:money.fromMinor(grossMinor,unit),deductions:money.fromMinor(deductionsMinor,unit),advanceBalance:money.fromMinor(advanceBalanceMinor,unit),
    additionalCompensation:money.fromMinor(additionalMinor,unit),paidAmount:money.fromMinor(paidMinor,unit),netDue:money.fromMinor(netDueMinor,unit)};
}

function settleEmployeeFinalPayroll({monthId,employeeId,settlementDate,additionalCompensation=0,method='cash',notes,createdBy,paidFromRegister=true,terminationReason}) {
  const b=getCurrentBranch(); const unit=Number(getGlobalProfile()?.currency_minor_unit||2);
  const data=calculatePayrollFinalSettlement(monthId,employeeId,settlementDate,additionalCompensation);
  if(!['cash','bank','other'].includes(String(method))) throw new Error('طريقة دفع التسوية غير صالحة.');
  const tx=db.transaction(()=>{
    let cashMovementId=null;
    if(data.netDueMinor>0 && method==='cash') {
      if(!paidFromRegister) throw new Error('التسوية النقدية يجب أن تُسجل من الصندوق حفاظاً على دقة النقدية.');
      const shift=getOpenShift(); if(!shift) throw new Error('لا يمكن دفع التسوية نقداً دون وردية صندوق مفتوحة.');
      const cm=addCashMovement({shiftId:shift.id,type:'cash_out',amount:money.fromMinor(data.netDueMinor,unit),reason:`تصفية موظف: ${data.employee.full_name}`,reference:`payroll_final_settlement:${data.employee.id}`,createdBy});
      cashMovementId=cm.id;
    }
    // التسوية النهائية تسدد كامل رصيد السلف ضمنياً. نسجلها كدفعة direct بدون حركة cash-in
    // لأنها جزء من المقاصة على مستحق الراتب، وليست مبلغاً عاد إلى الصندوق من الموظف.
    let left=data.advanceBalanceMinor;
    const advances=listPayrollAdvances(data.employee.id).filter(a=>Number(a.remaining_minor||0)>0);
    for(const a of advances){
      if(left<=0) break;
      let remainingA=Number(a.remaining_minor||0);
      const paymentInfo=db.prepare(`INSERT INTO payroll_advance_payments(uuid,branch_id,advance_id,payment_type,amount,amount_minor,payment_date,method,reference,notes,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
        .run(uuid(),b.id,a.id,'direct',money.fromMinor(remainingA,unit),remainingA,data.date,'settlement',`payroll_final_settlement:${data.employee.id}`,'تسوية رصيد السلفة ضمن التصفية النهائية',createdBy||null);
      const pid=Number(paymentInfo.lastInsertRowid);
      const installments=db.prepare(`SELECT i.* FROM payroll_advance_installments i WHERE i.advance_id=? ORDER BY i.month_key,i.installment_no`).all(a.id);
      let allocLeft=remainingA;
      for(const i of installments){
        if(allocLeft<=0) break;
        const already=Number(db.prepare(`SELECT COALESCE(SUM(CASE WHEN p.payment_type='direct' THEN pa.amount_minor ELSE 0 END),0) x FROM payroll_advance_payment_allocations pa JOIN payroll_advance_payments p ON p.id=pa.payment_id WHERE p.voided_at IS NULL AND pa.installment_id=?`).get(i.id).x||0);
        const openI=Math.max(0,Number(i.amount_minor)-already); if(!openI) continue;
        const q=Math.min(openI,allocLeft);
        db.prepare(`INSERT INTO payroll_advance_payment_allocations(payment_id,installment_id,amount,amount_minor) VALUES(?,?,?,?)`).run(pid,i.id,money.fromMinor(q,unit),q);
        allocLeft-=q;
      }
      db.prepare(`UPDATE payroll_advances SET status='completed',updated_at=datetime('now'),synced=0 WHERE id=? AND branch_id=?`).run(a.id,b.id);
      left-=remainingA;
    }
    const info=db.prepare(`INSERT INTO payroll_final_settlements(uuid,branch_id,employee_id,month_id,settlement_date,gross_earned,deductions,advance_balance,additional_compensation,net_due,paid_amount,gross_earned_minor,deductions_minor,advance_balance_minor,additional_compensation_minor,net_due_minor,paid_amount_minor,method,cash_movement_id,notes,created_by,status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(uuid(),b.id,data.employee.id,data.month.id,data.date,data.grossEarned,data.deductions,data.advanceBalance,data.additionalCompensation,data.netDue,data.netDue,
        data.grossMinor,data.deductionsMinor,data.advanceBalanceMinor,data.additionalMinor,data.netDueMinor,data.netDueMinor,method,cashMovementId,String(notes||'').trim()||null,createdBy||null,'paid');
    db.prepare(`UPDATE payroll_employees SET is_active=0,terminated_at=?,termination_reason=?,updated_at=datetime('now'),synced=0 WHERE id=? AND branch_id=?`).run(data.date,String(terminationReason||'').trim()||null,data.employee.id,b.id);
    return {id:Number(info.lastInsertRowid),cashMovementId};
  })();
  return {success:true,id:tx.id,employeeId:data.employee.id,employeeName:data.employee.full_name,netDue:data.netDue,advanceSettled:data.advanceBalance,paidAmount:data.netDue,status:'paid',cashMovementId:tx.cashMovementId};
}

function listPayrollFinalSettlements(employeeId=null) {
  const b=getCurrentBranch(); const unit=Number(getGlobalProfile()?.currency_minor_unit||2);
  const rows=db.prepare(`SELECT s.*,e.full_name employee_name,m.month_key FROM payroll_final_settlements s JOIN payroll_employees e ON e.id=s.employee_id JOIN payroll_months m ON m.id=s.month_id WHERE s.branch_id=? ${employeeId!=null?'AND s.employee_id=?':''} ORDER BY s.settlement_date DESC,s.id DESC`).all(...(employeeId!=null?[b.id,Number(employeeId)]:[b.id]));
  return rows.map(r=>({...r,grossEarned:money.fromMinor(Number(r.gross_earned_minor||0),unit),deductions:money.fromMinor(Number(r.deductions_minor||0),unit),advanceBalance:money.fromMinor(Number(r.advance_balance_minor||0),unit),additionalCompensation:money.fromMinor(Number(r.additional_compensation_minor||0),unit),netDue:money.fromMinor(Number(r.net_due_minor||0),unit),paidAmount:money.fromMinor(Number(r.paid_amount_minor||0),unit)}));
}

function listPayrollPayments(monthId, employeeId=null) {
  const b=getCurrentBranch(); const m=payrollMonth(monthId);
  const rows=db.prepare(`SELECT p.*,e.full_name employee_name FROM payroll_payments p JOIN payroll_employees e ON e.id=p.employee_id WHERE p.branch_id=? AND p.month_id=? ${employeeId!=null?'AND p.employee_id=?':''} ORDER BY p.payment_date DESC,p.id DESC`).all(...(employeeId!=null?[b.id,m.id,Number(employeeId)]:[b.id,m.id]));
  return rows;
}

function voidPayrollFinalSettlement(settlementId, reason, voidedBy) {
  const b=getCurrentBranch(); const id=Number(settlementId); const text=String(reason||'').trim();
  if(!Number.isInteger(id)||id<=0) throw new Error('معرّف التسوية غير صالح.');
  if(text.length<10) throw new Error('سبب إلغاء التصفية يجب ألا يقل عن 10 محارف.');
  const s=db.prepare('SELECT * FROM payroll_final_settlements WHERE id=? AND branch_id=?').get(id,b.id);
  if(!s) throw new Error('التصفية النهائية غير موجودة.');
  if(String(s.status)!=='paid') throw new Error('هذه التصفية ملغاة بالفعل.');
  db.transaction(()=>{
    db.prepare(`UPDATE payroll_final_settlements SET status='voided',voided_at=datetime('now'),void_reason=?,updated_at=datetime('now'),synced=0 WHERE id=? AND branch_id=?`).run(text,id,b.id);
    db.prepare("UPDATE payroll_employees SET is_active=1,terminated_at=NULL,termination_reason=NULL,updated_at=datetime('now') WHERE id=? AND branch_id=?").run(Number(s.employee_id),b.id);
    if(Number(s.cash_movement_id)>0){
      const cm=db.prepare('SELECT * FROM cash_movements WHERE id=? AND branch_id=?').get(Number(s.cash_movement_id),b.id);
      if(cm){
        const openShift=getOpenShift();
        if(!openShift) throw new Error('لا يمكن إلغاء تصفية نقدية بدون وردية مفتوحة لتسجيل حركة العكس في الصندوق.');
        db.prepare(`INSERT INTO cash_movements(uuid,branch_id,shift_id,type,amount,amount_minor,reason,reference,created_by,created_at,synced) VALUES(?,?,?,?,?,?,?,?,?,datetime('now'),0)`).run(uuid(),b.id,openShift.id,'cash_in',cm.amount,cm.amount_minor,'عكس تصفية موظف',`void:payroll_final_settlement:${id}`,voidedBy||null);
      }
    }
    const refs=[`payroll_final_settlement:${s.employee_id}`, `payroll_final_settlement:${Number(s.employee_id)}`];
    const aps=db.prepare(`SELECT id FROM payroll_advance_payments WHERE branch_id=? AND reference=? AND voided_at IS NULL`).all(b.id,refs[0]);
    for(const ap of aps) db.prepare(`UPDATE payroll_advance_payments SET voided_at=datetime('now'),void_reason=? WHERE id=?`).run(`إلغاء التصفية النهائية ${id}`,ap.id);
  })();
  return {success:true,id,status:'voided'};
}

function reopenPayrollMonth(monthId, reason, reopenedBy) {
  const b=getCurrentBranch(); const m=payrollMonth(monthId);
  if (String(m.status)!=='paid') return {success:true,status:m.status};
  const text=String(reason||'').trim(); if(text.length<10) throw new Error('سبب إعادة فتح شهر الرواتب يجب ألا يقل عن 10 محارف.');
  // لا نحذف ولا نعدل دفعات سابقة. إعادة الفتح تسمح فقط بتسجيل تصحيح جديد.
  db.prepare(`UPDATE payroll_months SET status='open',closed_at=NULL,closed_by=NULL,synced=0 WHERE id=? AND branch_id=?`).run(m.id,b.id);
  return {success:true,status:'open',reason:text};
}

function getPayrollV2Employee(monthId,employeeId){ const m=payrollMonth(monthId), b=getCurrentBranch(); recalcPayrollEmployeeMonth(m.id,Number(employeeId)); const employee=db.prepare(`SELECT e.*,m.month_id,m.month_key,m.pay_type,m.pay_rate,m.base_amount,m.base_amount_minor,m.regular_hours,m.absence_days,m.absence_deduction,m.bonus_total,m.deduction_total,m.advance_total,m.overtime_total,m.net_salary,m.net_salary_minor,m.debt_carry,m.debt_carry_minor FROM payroll_employee_months m JOIN payroll_employees e ON e.id=m.employee_id JOIN payroll_months pm ON pm.id=m.month_id WHERE m.month_id=? AND m.employee_id=? AND e.branch_id=?`).get(m.id,Number(employeeId),b.id); if(!employee)throw new Error('العامل غير موجود في هذا الشهر.'); const unit=Number(getGlobalProfile()?.currency_minor_unit||2); const paid=db.prepare('SELECT COALESCE(SUM(amount_minor),0) paid_minor,COALESCE(SUM(amount),0) paid_amount FROM payroll_payments WHERE branch_id=? AND month_id=? AND employee_id=?').get(b.id,m.id,Number(employeeId)); const paidMinor=Number(paid?.paid_minor||0),netMinor=money.toMinor(Number(employee.net_salary||0),unit); employee.paid_total=money.fromMinor(paidMinor,unit); employee.paid_total_minor=paidMinor; employee.remaining_salary=money.fromMinor(Math.max(0,netMinor-paidMinor),unit); employee.remaining_salary_minor=Math.max(0,netMinor-paidMinor); employee.payment_status=paidMinor>=netMinor?'paid':paidMinor>0?'partial':'unpaid'; const transactions=db.prepare('SELECT * FROM payroll_transactions WHERE month_id=? AND employee_id=? ORDER BY event_date DESC,id DESC').all(m.id,Number(employeeId)); const payments=listPayrollPayments(m.id,Number(employeeId)); return {employee,transactions,payments,monthStatus:m.status||'open'}; }

/* ==========================================================
   المرتجعات
   ========================================================== */
// يُرجع فاتورة كاملة مع بنودها وكمية كل بند التي أُرجعت سابقاً (لمنع إرجاع نفس الوحدة مرتين)
// يبحث برقم الفاتورة المطبوع على الإيصال (مثال: 2026-000123) بدل رقم الصف الداخلي
// بقاعدة البيانات، لأن هذا هو الرقم الوحيد الذي يعرفه المستخدم فعلياً.
function getSaleIdByInvoiceNumber(invoiceNumber) {
  const clean = String(invoiceNumber || '').trim();
  if (!clean) return null;
  const row = db.prepare('SELECT id FROM sales WHERE invoice_number = ?').get(clean);
  return row ? row.id : null;
}

function getSaleForReturn(invoiceNumberOrId) {
  // نقبل رقم الفاتورة (الحالة الطبيعية) وأيضاً الرقم الداخلي القديم للتوافق مع أي استخدام سابق
  let saleId = getSaleIdByInvoiceNumber(invoiceNumberOrId);
  if (!saleId && /^\d+$/.test(String(invoiceNumberOrId || '').trim())) {
    saleId = Number(invoiceNumberOrId);
  }
  if (!saleId) return null;
  const sale = getSale(saleId, getCurrentBranch().id);
  if (!sale) return null;
  const alreadyReturned = db
    .prepare(
      `SELECT ri.sale_item_id, COALESCE(SUM(ri.quantity),0) AS qty
       FROM return_items ri JOIN returns r ON r.id = ri.return_id
       WHERE r.sale_id = ? GROUP BY ri.sale_item_id`
    )
    .all(saleId);
  const returnedMap = Object.fromEntries(alreadyReturned.map((r) => [r.sale_item_id, r.qty]));
  sale.items = sale.items.map((i) => ({ ...i, already_returned: returnedMap[i.id] || 0 }));
  return sale;
}

// إنشاء مرتجع: يرجّع الكمية للمخزون تلقائياً، ويحدّث حالة الفاتورة الأصلية (مرتجع كلي/جزئي)
const createReturnTx = db.transaction((payload) => {
  const branch = getCurrentBranch();
  const clientRequestId = String(payload.clientRequestId || '').trim();
  if (clientRequestId) {
    const existing = db.prepare('SELECT id, uuid, total_refunded FROM returns WHERE branch_id=? AND client_request_id=?').get(branch.id, clientRequestId);
    if (existing) return { ...existing, idempotent: true };
  }
  const refundMethod = String(payload.refundMethod || 'cash');
  if (!['cash','card','store_credit'].includes(refundMethod)) throw new Error('طريقة الاسترداد غير صالحة.');
  const sale = db.prepare('SELECT * FROM sales WHERE id = ? AND branch_id = ?').get(payload.saleId, branch.id);
  if (!sale) throw new Error('الفاتورة غير موجودة في الفرع الحالي');
  if (!['completed', 'partially_refunded'].includes(String(sale.status))) {
    throw new Error('لا يمكن إرجاع فاتورة غير مكتملة أو غير مدفوعة. أغلق الطلب أولاً.');
  }
  if (payload.shiftId != null) {
    const shift = db.prepare('SELECT id, branch_id, status FROM shifts WHERE id=? AND branch_id=?').get(Number(payload.shiftId), branch.id);
    if (!shift) throw new Error('جلسة الصندوق غير موجودة في الفرع الحالي.');
    if (shift.status !== 'open') throw new Error('جلسة الصندوق مغلقة.');
  }

  if (!Array.isArray(payload.items) || payload.items.length === 0) throw new Error('اختر صنفاً واحداً على الأقل للمرتجع.');
  const returnUuid = uuid();
  const returnInfo = db
    .prepare(
      `INSERT INTO returns (uuid, branch_id, sale_id, user_id, shift_id, reason, refund_method, total_refunded, client_request_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      returnUuid,
      branch.id,
      payload.saleId,
      payload.userId || null,
      payload.shiftId || null,
      payload.reason || null,
      refundMethod,
      0,
      clientRequestId || null
    );
  const returnId = returnInfo.lastInsertRowid;

  const insertReturnItem = db.prepare(
    `INSERT INTO return_items (return_id, sale_item_id, product_id, quantity, refund_amount) VALUES (?, ?, ?, ?, ?)`
  );
  const updateStock = db.prepare(
    `UPDATE inventory SET quantity = quantity + ?, updated_at = datetime('now'), synced = 0
     WHERE branch_id = ? AND product_id = ?`
  );
  const logMovement = db.prepare(
    `INSERT INTO inventory_movements (uuid, branch_id, product_id, change_qty, reason, ref_id, unit_cost_after, synced)
     VALUES (?, ?, ?, ?, 'return', ?, ?, 0)`
  );

  const alreadyReturnedFor = db.prepare(
    `SELECT COALESCE(SUM(quantity),0) AS q FROM return_items WHERE sale_item_id = ?`
  );

  const saleItemsTotalBeforeDiscount = Math.max(0, Number(sale.subtotal || 0) + Number(sale.tax_total || 0));
  const saleDiscountPool = Math.max(0, Math.min(
    saleItemsTotalBeforeDiscount,
    Number(sale.discount_total || 0) + Number(sale.bundle_discount_total || 0)
  ));
  const globalProfile = getGlobalProfile();
  function refundableUnitAmount(saleItem) {
    const quantity = Number(saleItem.quantity);
    const base = Number(saleItem.line_total);
    const rate = Number(saleItem.tax_rate || 0);
    const inclusive = saleItem.tax_inclusive != null
      ? Number(saleItem.tax_inclusive) === 1
      : globalProfile.tax_mode === 'inclusive';
    const tax = inclusive ? base - base / (1 + rate / 100) : base * (rate / 100);
    const merchandiseGross = inclusive ? base : base + tax;
    if (!(quantity > 0) || !(merchandiseGross >= 0)) return 0;
    const allocatedDiscount = saleItemsTotalBeforeDiscount > 0
      ? saleDiscountPool * (merchandiseGross / saleItemsTotalBeforeDiscount)
      : 0;
    return Math.max(0, (merchandiseGross - allocatedDiscount) / quantity);
  }

  let totalRefunded = 0;
  for (const item of payload.items) {
    const saleItem = db.prepare('SELECT * FROM sale_items WHERE id = ? AND sale_id = ?').get(item.saleItemId, payload.saleId);
    if (!saleItem) continue;

    const quantity = Number(item.quantity);
    if (!(quantity > 0)) continue;
    const alreadyReturned = alreadyReturnedFor.get(item.saleItemId).q;
    const remaining = saleItem.quantity - alreadyReturned;
    if (remaining <= 0) continue; // تم إرجاع هذا الصنف بالكامل من قبل
    const cappedQuantity = Math.min(quantity, remaining); // لا يمكن إرجاع أكثر مما بقي غير مُرتجَع
    item.quantity = cappedQuantity;

    const unitRefund = refundableUnitAmount(saleItem);
    const refundAmount = unitRefund * item.quantity;
    insertReturnItem.run(returnId, item.saleItemId, saleItem.product_id, item.quantity, refundAmount);
    const product = db.prepare('SELECT track_inventory FROM products WHERE id=?').get(saleItem.product_id);
    if (product?.track_inventory) {
      const stockResult = updateStock.run(item.quantity, branch.id, saleItem.product_id);
      if (stockResult.changes !== 1) throw new Error('تعذّر إعادة الكمية إلى المخزون.');
      const currentCost = db.prepare('SELECT COALESCE(unit_cost,0) AS unit_cost FROM inventory WHERE branch_id=? AND product_id=?').get(branch.id, saleItem.product_id)?.unit_cost || 0;
      logMovement.run(uuid(), branch.id, saleItem.product_id, item.quantity, returnId, currentCost);
    }
    totalRefunded += refundAmount;
  }

  if (!(totalRefunded > 0)) throw new Error('لم توجد كمية قابلة للإرجاع.');
  db.prepare(`UPDATE returns SET total_refunded = ? WHERE id = ?`).run(totalRefunded, returnId);
  if (refundMethod === 'cash' || refundMethod === 'card') {
    db.prepare(`INSERT INTO payment_transactions(uuid,branch_id,return_id,shift_id,method,currency_code,amount,exchange_rate,provider,provider_reference,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
      .run(uuid(), branch.id, returnId, payload.shiftId || null, refundMethod, String(getGlobalProfile().currency_code).toUpperCase(), -totalRefunded, 1, null, null, payload.userId || null);
  }
  if (refundMethod === 'store_credit') {
    const customerId = sale.customer_id;
    if (!customerId) throw new Error('إرجاع كرَصيد متجر يتطلب أن تكون الفاتورة مرتبطة بعميل.');
    const customer = db.prepare('SELECT balance, store_credit_balance FROM customers WHERE id=? AND branch_id=?').get(customerId, branch.id);
    if (!customer) throw new Error('العميل المرتبط بالفاتورة غير موجود.');
    appendStoreCreditLedger({ customerId, saleId: sale.id, returnId, entryType: 'return_credit', amount: totalRefunded, createdBy: payload.userId, branchId: branch.id });
    db.prepare(`INSERT INTO payment_transactions(uuid,branch_id,return_id,shift_id,method,currency_code,amount,exchange_rate,provider,provider_reference,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
      .run(uuid(), branch.id, returnId, payload.shiftId || null, 'store_credit', String(getGlobalProfile().currency_code).toUpperCase(), -totalRefunded, 1, null, null, payload.userId || null);
    appendCustomerLedger({ customerId, saleId: sale.id, entryType: 'return_adjustment', amount: 0, balanceAfter: Number(customer.balance || 0), notes: `إصدار رصيد متجر ${totalRefunded.toFixed(2)} من الفاتورة ${sale.invoice_number}` });
  }

  // عكس نقاط الولاء المرتبطة فعلياً بالفاتورة عند الإرجاع، بنسبة قيمة السلع المرتجعة،
  // مع قفلها عند عدد النقاط التي سبق منحها/عكسها حتى لا يمكن تكرار الخصم عبر مرتجعات متتابعة.
  if (sale.customer_id) {
    const saleAward = Number(sale.loyalty_points_awarded || 0);
    const alreadyReversed = Number(sale.loyalty_points_reversed || 0);
    if (saleAward > alreadyReversed && sale.grand_total > 0) {
      const priorRefunded = db.prepare(`SELECT COALESCE(SUM(total_refunded),0) AS v FROM returns WHERE sale_id=? AND id<>?`).get(sale.id, returnId).v;
      const ratio = Math.min(1, Math.max(0, Number(totalRefunded + Number(priorRefunded || 0)) / Number(sale.grand_total)));
      const targetReversed = Math.floor(saleAward * ratio);
      const reverseNow = Math.max(0, targetReversed - alreadyReversed);
      if (reverseNow > 0) {
        db.prepare("UPDATE customers SET loyalty_points=MAX(0, loyalty_points-?), updated_at=datetime('now'), synced=0 WHERE id=? AND branch_id=?").run(reverseNow, sale.customer_id, branch.id);
        db.prepare('UPDATE sales SET loyalty_points_reversed=loyalty_points_reversed+? WHERE id=?').run(reverseNow, sale.id);
      }
    }
  }

  // تحديد إن كانت الفاتورة أصبحت مرتجعة بالكامل أو جزئياً
  const totalItemsQty = db.prepare('SELECT COALESCE(SUM(quantity),0) AS q FROM sale_items WHERE sale_id = ?').get(sale.id).q;
  const totalReturnedQty = db
    .prepare(
      `SELECT COALESCE(SUM(ri.quantity),0) AS q FROM return_items ri JOIN returns r ON r.id = ri.return_id WHERE r.sale_id = ?`
    )
    .get(sale.id).q;
  const newStatus = totalReturnedQty >= totalItemsQty ? 'refunded' : 'partially_refunded';
  db.prepare(`UPDATE sales SET status = ? WHERE id = ?`).run(newStatus, sale.id);

  return { id: returnId, uuid: returnUuid, totalRefunded };
});

function createReturn(payload) {
  return createReturnTx(payload);
}

function listReturns(filters = {}) {
  const branch = getCurrentBranch();
  let sql = `SELECT r.*, u.full_name AS user_name FROM returns r LEFT JOIN users u ON u.id = r.user_id WHERE r.branch_id = ?`;
  const params = [branch.id];
  if (filters.from) {
    sql += ' AND r.created_at >= ?';
    params.push(filters.from);
  }
  if (filters.to) {
    sql += ' AND r.created_at <= ?';
    params.push(filters.to);
  }
  sql += ' ORDER BY r.created_at DESC LIMIT 200';
  return db.prepare(sql).all(...params);
}

function getReturn(id) {
  const branch = getCurrentBranch();
  const ret = db.prepare('SELECT * FROM returns WHERE id = ? AND branch_id = ?').get(id, branch.id);
  if (!ret) return null;
  const items = db
    .prepare(
      `SELECT ri.*, p.name AS product_name FROM return_items ri JOIN products p ON p.id = ri.product_id WHERE ri.return_id = ?`
    )
    .all(id);
  return { ...ret, items };
}

/* ==========================================================
   تقارير الدليفري والوردية
   ========================================================== */
function getDeliverySummary(range = {}) {
  const branch = getCurrentBranch();
  const { from, to } = dateRangeParams(range);
  const totals = db
    .prepare(
      `SELECT COUNT(*) AS orderCount, COALESCE(SUM(delivery_fee),0) AS deliveryFees,
              COALESCE(SUM(subtotal + tax_total - discount_total),0) AS productsRevenue,
              COALESCE(SUM(grand_total),0) AS grandTotal
       FROM sales
       WHERE branch_id = ? AND order_type = 'delivery' AND status IN ('completed','partially_refunded')
         AND created_at BETWEEN ? AND ?`
    )
    .get(branch.id, from, to);

  const byPerson = db
    .prepare(
      `SELECT COALESCE(delivery_person,'غير محدد') AS deliveryPerson, COUNT(*) AS orderCount,
              COALESCE(SUM(delivery_fee),0) AS deliveryFees
       FROM sales
       WHERE branch_id = ? AND order_type = 'delivery' AND status IN ('completed','partially_refunded')
         AND created_at BETWEEN ? AND ?
       GROUP BY deliveryPerson ORDER BY deliveryFees DESC`
    )
    .all(branch.id, from, to);

  return { ...totals, byPerson, from, to };
}

/* ---------------- بيانات التصدير ---------------- */
function getReportExport(range = {}) {
  const summary = getSalesSummary(range);
  const topProducts = getTopProducts({ ...range, limit: 100 });
  const daily = getDailySales(range);
  const delivery = getDeliverySummary(range);
  const profitLoss = getProfitLoss(range);
  return { summary, topProducts, daily, delivery, profitLoss, range };
}

/* ---------------- إعدادات ومحتوى المزامنة ---------------- */
function getSyncConfig() {
  return {
    serverUrl: getSetting('sync_server_url', ''),
    token: getSetting('sync_token', ''),
    enabled: getSetting('sync_enabled', '0') === '1',
    cursor: getSetting('sync_cursor', '0'),
    lastSyncAt: getSetting('sync_last_at', ''),
    // بصمة SHA-256 لشهادة TLS مُثبَّتة (pinning) — تُملأ فقط عند الاتصال بخادم LAN مُضمَّن ذاتي
    // التوقيع (راجع server/lan-tls.js وserver/pinned-request.js). فارغة لخادم مركزي حقيقي خلف
    // TLS بشهادة مرجع ثقة عادي (عندها sync-client.js يستخدم تحقق TLS القياسي بدلاً من التثبيت).
    tlsFingerprint: getSetting('sync_tls_fingerprint', ''),
  };
}
function saveSyncConfig(config = {}) {
  const url = String(config.serverUrl || '').trim().replace(/\/$/, '');
  if (config.enabled && !String(config.token || '').trim()) {
    throw new Error('لا يمكن تفعيل المزامنة بدون رمز وصول للفرع.');
  }
  if (url) {
    let parsed;
    try { parsed = new URL(url); } catch { throw new Error('عنوان الخادم غير صالح.'); }
    const isLoopbackHost = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(String(parsed.hostname).toLowerCase());
    if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('عنوان الخادم يجب أن يستخدم HTTPS أو HTTP محلي فقط.');
    if (parsed.protocol === 'http:' && !isLoopbackHost) {
      throw new Error('المزامنة إلى خادم بعيد يجب أن تستخدم HTTPS لحماية بيانات المبيعات والمفاتيح. HTTP مسموح فقط على الجهاز المحلي.');
    }
  }
  setSetting('sync_server_url', url);
  setSetting('sync_token', String(config.token || '').trim());
  setSetting('sync_enabled', config.enabled ? '1' : '0');
  // إدخال عنوان خادم يدوياً من شاشة الإعدادات (خادم مركزي حقيقي، لا اقتران LAN) يعني شهادة
  // TLS عادية من مرجع ثقة معروف — نُلغي أي بصمة LAN مثبَّتة سابقاً حتى تُستخدم آلية التحقق
  // القياسية بدل التثبيت (والعكس: الاقتران بالجهاز الرئيسي يضبط sync_tls_fingerprint بنفسه)
  setSetting('sync_tls_fingerprint', '');
  return { success: true };
}
function syncPayload() {
  const branch = getCurrentBranch();
  const categoryRows = db.prepare(`SELECT c.*,pc.uuid AS parent_uuid FROM categories c LEFT JOIN categories pc ON pc.id=c.parent_id WHERE c.synced=0`).all();
  const productRows = db.prepare(`SELECT p.*,c.uuid AS category_uuid,pp.uuid AS parent_product_uuid,tp.uuid AS tax_profile_uuid FROM products p LEFT JOIN categories c ON c.id=p.category_id LEFT JOIN products pp ON pp.id=p.parent_product_id LEFT JOIN tax_profiles tp ON tp.id=p.tax_profile_id AND tp.branch_id=? WHERE p.synced=0`).all(branch.id);
  const customerRows = db.prepare(`SELECT c.*,b.uuid AS branch_uuid FROM customers c JOIN branches b ON b.id=c.branch_id WHERE c.branch_id=? AND c.synced=0`).all(branch.id);
  const customerLedgerRows = db.prepare(`SELECT cl.*,c.uuid AS customer_uuid,s.uuid AS sale_uuid,b.uuid AS branch_uuid FROM customer_ledger cl JOIN customers c ON c.id=cl.customer_id LEFT JOIN sales s ON s.id=cl.sale_id JOIN branches b ON b.id=cl.branch_id WHERE cl.branch_id=? AND cl.synced=0 AND cl.uuid IS NOT NULL`).all(branch.id);
  const storeCreditLedgerRows = db.prepare(`SELECT scl.*,c.uuid AS customer_uuid,s.uuid AS sale_uuid,r.uuid AS return_uuid,b.uuid AS branch_uuid,u.username AS created_by_username
    FROM store_credit_ledger scl JOIN customers c ON c.id=scl.customer_id LEFT JOIN sales s ON s.id=scl.sale_id LEFT JOIN returns r ON r.id=scl.return_id JOIN branches b ON b.id=scl.branch_id LEFT JOIN users u ON u.id=scl.created_by
    WHERE scl.branch_id=? AND scl.synced=0`).all(branch.id);
  const inventoryRows = db.prepare(`SELECT i.*,p.uuid AS product_uuid,b.uuid AS branch_uuid FROM inventory i JOIN products p ON p.id=i.product_id JOIN branches b ON b.id=i.branch_id WHERE i.branch_id=? AND i.synced=0`).all(branch.id);
  const saleRows = db.prepare('SELECT * FROM sales WHERE branch_id=? AND synced=0').all(branch.id).map((sale) => ({
    ...sale, branch_uuid: branch.uuid,
    customer_uuid: sale.customer_id ? db.prepare('SELECT uuid FROM customers WHERE id=? AND branch_id=?').get(sale.customer_id, branch.id)?.uuid : null,
    shift_uuid: sale.shift_id ? db.prepare('SELECT uuid FROM shifts WHERE id=? AND branch_id=?').get(sale.shift_id, branch.id)?.uuid : null,
    user_username: sale.user_id ? db.prepare('SELECT username FROM users WHERE id=? AND branch_id=?').get(sale.user_id, branch.id)?.username : null,
    table_uuid: sale.table_id ? db.prepare('SELECT uuid FROM restaurant_tables WHERE id=? AND branch_id=?').get(sale.table_id, branch.id)?.uuid : null,
    items: db.prepare(`SELECT si.*,p.uuid AS product_uuid,tp.uuid AS tax_profile_uuid FROM sale_items si JOIN products p ON p.id=si.product_id LEFT JOIN tax_profiles tp ON tp.id=si.tax_profile_id AND tp.branch_id=? WHERE si.sale_id=?`).all(branch.id,sale.id),
  }));
  const paymentRows = db.prepare(`SELECT pt.*,b.uuid AS branch_uuid,s.uuid AS sale_uuid,r.uuid AS return_uuid,sh.uuid AS shift_uuid,u.username AS created_by_username FROM payment_transactions pt JOIN branches b ON b.id=pt.branch_id LEFT JOIN sales s ON s.id=pt.sale_id LEFT JOIN returns r ON r.id=pt.return_id LEFT JOIN shifts sh ON sh.id=pt.shift_id LEFT JOIN users u ON u.id=pt.created_by WHERE pt.branch_id=? AND pt.synced=0`).all(branch.id);
  const cashMovementRows = db.prepare(`SELECT cm.*,b.uuid AS branch_uuid,sh.uuid AS shift_uuid,u.username AS created_by_username FROM cash_movements cm JOIN branches b ON b.id=cm.branch_id JOIN shifts sh ON sh.id=cm.shift_id LEFT JOIN users u ON u.id=cm.created_by WHERE cm.branch_id=? AND cm.synced=0`).all(branch.id);
  const shiftRows = db.prepare(`SELECT sh.*,b.uuid AS branch_uuid,uo.username AS opened_by_username,uc.username AS closed_by_username FROM shifts sh JOIN branches b ON b.id=sh.branch_id LEFT JOIN users uo ON uo.id=sh.opened_by LEFT JOIN users uc ON uc.id=sh.closed_by WHERE sh.branch_id=? AND sh.synced=0`).all(branch.id);
  const inventoryMovementRows = db.prepare(`SELECT im.*,p.uuid AS product_uuid,b.uuid AS branch_uuid FROM inventory_movements im JOIN products p ON p.id=im.product_id JOIN branches b ON b.id=im.branch_id WHERE im.branch_id=? AND im.synced=0 AND im.uuid IS NOT NULL`).all(branch.id);
  const supplierRows = db.prepare(`SELECT s.*,b.uuid AS branch_uuid FROM suppliers s JOIN branches b ON b.id=s.branch_id WHERE s.branch_id=? AND s.synced=0`).all(branch.id);
  const supplierLedgerRows = db.prepare(`SELECT sl.*,s.uuid AS supplier_uuid,b.uuid AS branch_uuid,po.uuid AS purchase_order_uuid FROM supplier_ledger sl JOIN suppliers s ON s.id=sl.supplier_id JOIN branches b ON b.id=sl.branch_id LEFT JOIN purchase_orders po ON po.id=sl.purchase_order_id WHERE sl.branch_id=? AND sl.synced=0 AND sl.uuid IS NOT NULL`).all(branch.id);
  const purchaseOrderRows = db.prepare(`SELECT po.*,s.uuid AS supplier_uuid,b.uuid AS branch_uuid FROM purchase_orders po JOIN suppliers s ON s.id=po.supplier_id JOIN branches b ON b.id=po.branch_id WHERE po.branch_id=? AND po.synced=0`).all(branch.id).map((po) => ({...po,items: db.prepare(`SELECT poi.*,p.uuid AS product_uuid FROM purchase_order_items poi JOIN products p ON p.id=poi.product_id WHERE poi.purchase_order_id=?`).all(po.id)}));
  const returnRows = db.prepare(`SELECT r.*,b.uuid AS branch_uuid,s.uuid AS sale_uuid,sh.uuid AS shift_uuid,u.username AS user_username FROM returns r JOIN branches b ON b.id=r.branch_id JOIN sales s ON s.id=r.sale_id LEFT JOIN shifts sh ON sh.id=r.shift_id LEFT JOIN users u ON u.id=r.user_id WHERE r.branch_id=? AND r.synced=0`).all(branch.id).map((r) => ({...r,items: db.prepare(`SELECT ri.*,si.uuid AS sale_item_uuid,p.uuid AS product_uuid FROM return_items ri JOIN products p ON p.id=ri.product_id JOIN sale_items si ON si.id=ri.sale_item_id WHERE ri.return_id=?`).all(r.id)}));
  const tableRows = db.prepare(`SELECT t.*,b.uuid AS branch_uuid FROM restaurant_tables t JOIN branches b ON b.id=t.branch_id WHERE t.branch_id=? AND t.synced=0`).all(branch.id);
  const bundleRows = db.prepare(`SELECT bu.*,b.uuid AS branch_uuid FROM bundles bu JOIN branches b ON b.id=bu.branch_id WHERE bu.branch_id=? AND bu.synced=0`).all(branch.id).map((b) => ({...b,items: db.prepare(`SELECT bi.*,p.uuid AS product_uuid FROM bundle_items bi JOIN products p ON p.id=bi.product_id WHERE bi.bundle_id=?`).all(b.id)}));
  const taxProfileRows = db.prepare(`SELECT tp.*,b.uuid AS branch_uuid FROM tax_profiles tp JOIN branches b ON b.id=tp.branch_id WHERE tp.branch_id=? AND tp.synced=0`).all(branch.id);
  const inventoryTransferRows = db.prepare(`SELECT t.* FROM inventory_transfers t WHERE t.local_branch_id=? AND t.source_branch_uuid=? AND t.synced=0`).all(branch.id, branch.uuid).map((t)=>({
    ...t, branch_uuid: branch.uuid,
    items: db.prepare(`SELECT product_uuid,quantity,unit_cost FROM inventory_transfer_items WHERE transfer_id=? ORDER BY id`).all(t.id)
  }));
  const payrollEmployeeRows = db.prepare(`SELECT e.*,b.uuid AS branch_uuid FROM payroll_employees e JOIN branches b ON b.id=e.branch_id WHERE e.branch_id=? AND e.synced=0`).all(branch.id);
  const payrollMonthRows = db.prepare(`SELECT m.*,b.uuid AS branch_uuid FROM payroll_months m JOIN branches b ON b.id=m.branch_id WHERE m.branch_id=? AND m.synced=0`).all(branch.id);
  const payrollEmployeeMonthRows = db.prepare(`SELECT em.*,m.uuid AS month_uuid,e.uuid AS employee_uuid,b.uuid AS branch_uuid FROM payroll_employee_months em JOIN payroll_months m ON m.id=em.month_id JOIN payroll_employees e ON e.id=em.employee_id JOIN branches b ON b.id=? WHERE em.synced=0`).all(branch.id);
  const payrollTransactionRows = db.prepare(`SELECT t.*,m.uuid AS month_uuid,e.uuid AS employee_uuid,b.uuid AS branch_uuid FROM payroll_transactions t JOIN payroll_months m ON m.id=t.month_id JOIN payroll_employees e ON e.id=t.employee_id JOIN branches b ON b.id=t.branch_id WHERE t.branch_id=? AND t.synced=0`).all(branch.id);
  const payrollAdvanceRows = db.prepare(`SELECT a.*,e.uuid AS employee_uuid,b.uuid AS branch_uuid FROM payroll_advances a JOIN payroll_employees e ON e.id=a.employee_id JOIN branches b ON b.id=a.branch_id WHERE a.branch_id=? AND a.synced=0`).all(branch.id);
  const payrollInstallmentRows = db.prepare(`SELECT i.*,a.uuid AS advance_uuid,b.uuid AS branch_uuid FROM payroll_advance_installments i JOIN payroll_advances a ON a.id=i.advance_id JOIN branches b ON b.id=a.branch_id WHERE a.branch_id=? AND i.synced=0`).all(branch.id);
  const payrollAdvancePaymentRows = db.prepare(`SELECT p.*,a.uuid AS advance_uuid,b.uuid AS branch_uuid FROM payroll_advance_payments p JOIN payroll_advances a ON a.id=p.advance_id JOIN branches b ON b.id=p.branch_id WHERE p.branch_id=? AND p.synced=0`).all(branch.id);
  const payrollAllocationRows = db.prepare(`SELECT pa.*,p.uuid AS payment_uuid,i.advance_id,a.uuid AS advance_uuid,i.month_key,b.uuid AS branch_uuid FROM payroll_advance_payment_allocations pa JOIN payroll_advance_payments p ON p.id=pa.payment_id JOIN payroll_advance_installments i ON i.id=pa.installment_id JOIN payroll_advances a ON a.id=i.advance_id JOIN branches b ON b.id=a.branch_id WHERE a.branch_id=? AND pa.synced=0`).all(branch.id);
  const payrollPaymentRows = db.prepare(`SELECT p.*,m.uuid AS month_uuid,e.uuid AS employee_uuid,b.uuid AS branch_uuid FROM payroll_payments p JOIN payroll_months m ON m.id=p.month_id JOIN payroll_employees e ON e.id=p.employee_id JOIN branches b ON b.id=p.branch_id WHERE p.branch_id=? AND p.synced=0`).all(branch.id);
  const payrollSettlementRows = db.prepare(`SELECT s.*,m.uuid AS month_uuid,e.uuid AS employee_uuid,b.uuid AS branch_uuid FROM payroll_final_settlements s JOIN payroll_months m ON m.id=s.month_id JOIN payroll_employees e ON e.id=s.employee_id JOIN branches b ON b.id=s.branch_id WHERE s.branch_id=? AND s.synced=0`).all(branch.id);
  const inventoryTransferReceiptRows = db.prepare(`SELECT r.* FROM inventory_transfer_receipts r WHERE r.local_branch_id=? AND r.destination_branch_uuid=? AND r.synced=0`).all(branch.id, branch.uuid).map((r)=>({
    ...r, branch_uuid: branch.uuid,
    items: db.prepare(`SELECT product_uuid,quantity_received FROM inventory_transfer_receipt_items WHERE receipt_id=? ORDER BY id`).all(r.id)
  }));
  return { branch, changes: { categories: categoryRows, products: productRows, tables: tableRows, customers: customerRows, inventory: inventoryRows, sales: saleRows, payments: paymentRows, cash_movements: cashMovementRows, shifts: shiftRows, inventory_movements: inventoryMovementRows, suppliers: supplierRows, supplier_ledger: supplierLedgerRows, purchase_orders: purchaseOrderRows, returns: returnRows, bundles: bundleRows, customer_ledger: customerLedgerRows, store_credit_ledger: storeCreditLedgerRows, tax_profiles: taxProfileRows, inventory_transfers: inventoryTransferRows, inventory_transfer_receipts: inventoryTransferReceiptRows, payroll_employees: payrollEmployeeRows, payroll_months: payrollMonthRows, payroll_employee_months: payrollEmployeeMonthRows, payroll_transactions: payrollTransactionRows, payroll_advances: payrollAdvanceRows, payroll_advance_installments: payrollInstallmentRows, payroll_advance_payments: payrollAdvancePaymentRows, payroll_advance_payment_allocations: payrollAllocationRows, payroll_payments: payrollPaymentRows, payroll_final_settlements: payrollSettlementRows } };
}
function markSynced(payload) {
  const set = (table, rows) => {
    const uuids=(rows||[]).map(r=>r.uuid).filter(Boolean); if(!uuids.length)return;
    db.prepare(`UPDATE ${table} SET synced=1 WHERE uuid IN (${uuids.map(()=>'?').join(',')})`).run(...uuids);
  };
  ['categories','products','restaurant_tables','customers','sales','payments','cash_movements','shifts','inventory_movements','suppliers','supplier_ledger','purchase_orders','customer_ledger','store_credit_ledger','returns','bundles','tax_profiles','inventory_transfers','inventory_transfer_receipts','payroll_employees','payroll_months','payroll_employee_months','payroll_transactions','payroll_advances','payroll_advance_installments','payroll_advance_payments','payroll_advance_payment_allocations','payroll_payments','payroll_final_settlements'].forEach((entity)=>{
    const table = entity==='payments' ? 'payment_transactions' : entity==='restaurant_tables' ? 'restaurant_tables' : entity;
    set(table,payload.changes?.[entity]);
  });
  const ids=(payload.changes?.inventory||[]).map(r=>r.id).filter(Boolean); if(ids.length)db.prepare(`UPDATE inventory SET synced=1 WHERE id IN (${ids.map(()=>'?').join(',')})`).run(...ids);
  const transferUuids=(payload.changes?.inventory_transfers||[]).map(r=>r.uuid).filter(Boolean); if(transferUuids.length)db.prepare(`UPDATE inventory_transfers SET synced=1 WHERE uuid IN (${transferUuids.map(()=>'?').join(',')})`).run(...transferUuids);
  const receiptUuids=(payload.changes?.inventory_transfer_receipts||[]).map(r=>r.uuid).filter(Boolean); if(receiptUuids.length)db.prepare(`UPDATE inventory_transfer_receipts SET synced=1 WHERE uuid IN (${receiptUuids.map(()=>'?').join(',')})`).run(...receiptUuids);
}
function applyRemoteChanges(changes={}) {
  const currentBranch=getCurrentBranch();
  const currentBranchUuid=currentBranch?.uuid||null;
  const branchOwnedEntities = ['tables','inventory','sales','customers','suppliers','purchase_orders','returns','bundles','customer_ledger','payments','cash_movements','shifts','inventory_movements','supplier_ledger','store_credit_ledger','tax_profiles','payroll_employees','payroll_months','payroll_employee_months','payroll_transactions','payroll_advances','payroll_advance_installments','payroll_advance_payments','payroll_advance_payment_allocations','payroll_payments','payroll_final_settlements'];
  const transferEntities = ['inventory_transfers','inventory_transfer_receipts'];
  const own=(rows, entity)=> (rows||[]).filter(r=>{
    if (transferEntities.includes(entity)) {
      return !!r?.source_branch_uuid && !!r?.destination_branch_uuid && (r.source_branch_uuid===currentBranchUuid || r.destination_branch_uuid===currentBranchUuid);
    }
    if (branchOwnedEntities.includes(entity)) {
      if (!r?.branch_uuid) throw new Error(`رفضت المزامنة: ${entity} يحتوي سجلاً بلا branch_uuid.`);
      if (r.branch_uuid !== currentBranchUuid) throw new Error('رفضت المزامنة سجلات تخص فرعاً آخر.');
      return true;
    }
    return !r?.branch_uuid || r.branch_uuid===currentBranchUuid;
  });
  const foreign=(rows)=>(rows||[]).filter(r=>r?.branch_uuid&&r.branch_uuid!==currentBranchUuid).length;
  if(
    foreign(changes.tables)||foreign(changes.inventory)||foreign(changes.sales)||foreign(changes.customers)||
    foreign(changes.suppliers)||foreign(changes.purchase_orders)||foreign(changes.returns)||foreign(changes.bundles)||
    foreign(changes.customer_ledger)||foreign(changes.payments)||foreign(changes.cash_movements)||foreign(changes.shifts)||
    foreign(changes.inventory_movements)||foreign(changes.supplier_ledger)||foreign(changes.store_credit_ledger)||foreign(changes.tax_profiles)||foreign(changes.payroll_employees)||foreign(changes.payroll_months)||foreign(changes.payroll_employee_months)||foreign(changes.payroll_transactions)||foreign(changes.payroll_advances)||foreign(changes.payroll_advance_installments)||foreign(changes.payroll_advance_payments)||foreign(changes.payroll_advance_payment_allocations)||foreign(changes.payroll_payments)||foreign(changes.payroll_final_settlements)
  ) throw new Error('رفضت المزامنة سجلات تخص فرعاً آخر.');

  const findOrCreateBranch=(uuidValue,name='فرع مُزامَن')=>{
    if(!uuidValue)return currentBranch.id;
    const found=db.prepare('SELECT id FROM branches WHERE uuid=?').get(uuidValue);
    if(found)return found.id;
    return db.prepare('INSERT INTO branches (uuid,name,business_type,is_current) VALUES (?,?,?,0)')
      .run(uuidValue,name,'general').lastInsertRowid;
  };

  const tx=db.transaction(()=>{
    // 1) tax profiles first: products/sale items reference them by UUID.
    for(const tp of own(changes.tax_profiles||[], 'tax_profiles')){
      const branchId=findOrCreateBranch(tp.branch_uuid);
      if(branchId!==currentBranch.id) continue;
      db.prepare(`
        INSERT INTO tax_profiles(uuid,branch_id,code,name,rate,tax_category,country_code,is_inclusive,is_active,updated_at,synced)
        VALUES(@uuid,@branchId,@code,@name,@rate,@tax_category,@country_code,@is_inclusive,@is_active,@updated_at,1)
        ON CONFLICT(uuid) DO UPDATE SET
          code=excluded.code,name=excluded.name,rate=excluded.rate,tax_category=excluded.tax_category,
          country_code=excluded.country_code,is_inclusive=excluded.is_inclusive,is_active=excluded.is_active,
          updated_at=excluded.updated_at,synced=1`).run({...tp,branchId,updated_at:tp.updated_at||new Date().toISOString()});
    }

    // 2) categories, two-pass so parent hierarchy is preserved even when order differs.
    for(const c of changes.categories||[]){
      db.prepare(`
        INSERT INTO categories(uuid,name,parent_id,updated_at,synced)
        VALUES(@uuid,@name,NULL,@updated_at,1)
        ON CONFLICT(uuid) DO UPDATE SET name=excluded.name,updated_at=excluded.updated_at,synced=1`)
        .run({...c,updated_at:c.updated_at||new Date().toISOString()});
    }
    for(const c of changes.categories||[]){
      const parentId=c.parent_uuid?db.prepare('SELECT id FROM categories WHERE uuid=?').get(c.parent_uuid)?.id||null:null;
      db.prepare('UPDATE categories SET parent_id=?,synced=1 WHERE uuid=?').run(parentId,c.uuid);
    }

    // Payroll branch-owned records: resolve UUID relationships locally before insert/upsert.
    for(const pe of own(changes.payroll_employees||[], 'payroll_employees')) db.prepare(`INSERT INTO payroll_employees(uuid,branch_id,full_name,job_title,pay_type,pay_rate,pay_rate_minor,is_active,legacy_user_id,terminated_at,termination_reason,national_id,hire_date,phone,department,iban,country_code,payroll_notes,created_at,updated_at,synced) VALUES(@uuid,@branchId,@full_name,@job_title,@pay_type,@pay_rate,@pay_rate_minor,@is_active,NULL,@terminated_at,@termination_reason,@national_id,@hire_date,@phone,@department,@iban,@country_code,@payroll_notes,@created_at,@updated_at,1) ON CONFLICT(uuid) DO UPDATE SET full_name=excluded.full_name,job_title=excluded.job_title,pay_type=excluded.pay_type,pay_rate=excluded.pay_rate,pay_rate_minor=excluded.pay_rate_minor,is_active=excluded.is_active,terminated_at=excluded.terminated_at,termination_reason=excluded.termination_reason,national_id=excluded.national_id,hire_date=excluded.hire_date,phone=excluded.phone,department=excluded.department,iban=excluded.iban,country_code=excluded.country_code,payroll_notes=excluded.payroll_notes,updated_at=excluded.updated_at,synced=1`).run({...pe,branchId:currentBranch.id});
    for(const pm of own(changes.payroll_months||[], 'payroll_months')) db.prepare(`INSERT INTO payroll_months(uuid,branch_id,month_key,status,closed_at,closed_by,created_at,synced) VALUES(@uuid,@branchId,@month_key,@status,@closed_at,NULL,@created_at,1) ON CONFLICT(uuid) DO UPDATE SET month_key=excluded.month_key,status=excluded.status,closed_at=excluded.closed_at,synced=1`).run({...pm,branchId:currentBranch.id});
    for(const pem of own(changes.payroll_employee_months||[], 'payroll_employee_months')) { const monthId=db.prepare('SELECT id FROM payroll_months WHERE uuid=?').get(pem.month_uuid)?.id; const employeeId=db.prepare('SELECT id FROM payroll_employees WHERE uuid=?').get(pem.employee_uuid)?.id; if(!monthId||!employeeId) continue; db.prepare(`INSERT INTO payroll_employee_months(month_id,employee_id,pay_type,pay_rate,base_amount,base_amount_minor,regular_hours,absence_days,absence_deduction,bonus_total,deduction_total,advance_total,overtime_total,net_salary,net_salary_minor,start_date,debt_carry,debt_carry_minor,created_at,updated_at,synced) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(month_id,employee_id) DO UPDATE SET pay_type=excluded.pay_type,pay_rate=excluded.pay_rate,base_amount=excluded.base_amount,base_amount_minor=excluded.base_amount_minor,regular_hours=excluded.regular_hours,absence_days=excluded.absence_days,absence_deduction=excluded.absence_deduction,bonus_total=excluded.bonus_total,deduction_total=excluded.deduction_total,advance_total=excluded.advance_total,overtime_total=excluded.overtime_total,net_salary=excluded.net_salary,net_salary_minor=excluded.net_salary_minor,start_date=excluded.start_date,debt_carry=excluded.debt_carry,debt_carry_minor=excluded.debt_carry_minor,updated_at=excluded.updated_at,synced=1`).run(monthId,employeeId,pem.pay_type,pem.pay_rate,pem.base_amount,pem.base_amount_minor,pem.regular_hours,pem.absence_days,pem.absence_deduction,pem.bonus_total,pem.deduction_total,pem.advance_total,pem.overtime_total,pem.net_salary,pem.net_salary_minor,pem.start_date,pem.debt_carry||0,pem.debt_carry_minor||0,pem.created_at,pem.updated_at); }
    for(const pt of own(changes.payroll_transactions||[], 'payroll_transactions')) { const monthId=db.prepare('SELECT id FROM payroll_months WHERE uuid=?').get(pt.month_uuid)?.id; const employeeId=db.prepare('SELECT id FROM payroll_employees WHERE uuid=?').get(pt.employee_uuid)?.id; if(!monthId||!employeeId) continue; db.prepare(`INSERT INTO payroll_transactions(uuid,branch_id,month_id,employee_id,type,amount,amount_minor,quantity,event_date,reason,created_by,cash_movement_id,overtime_multiplier,overtime_hours,created_at,synced) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1) ON CONFLICT(uuid) DO UPDATE SET type=excluded.type,amount=excluded.amount,amount_minor=excluded.amount_minor,quantity=excluded.quantity,event_date=excluded.event_date,reason=excluded.reason,overtime_multiplier=excluded.overtime_multiplier,overtime_hours=excluded.overtime_hours,synced=1`).run(pt.uuid,currentBranch.id,monthId,employeeId,pt.type,pt.amount,pt.amount_minor||0,pt.quantity,pt.event_date,pt.reason,null,null,pt.overtime_multiplier||1.5,pt.overtime_hours||0,pt.created_at); }
    for(const pa of own(changes.payroll_advances||[], 'payroll_advances')) { const employeeId=db.prepare('SELECT id FROM payroll_employees WHERE uuid=?').get(pa.employee_uuid)?.id; if(!employeeId) continue; db.prepare(`INSERT INTO payroll_advances(uuid,branch_id,employee_id,principal,principal_minor,installment_count,installment_amount,installment_amount_minor,first_deduction_month,reason,cash_movement_id,created_by,status,created_at,updated_at,synced) VALUES(@uuid,@branchId,?,?,?,?,?,?,?,?,?,?,@status,@created_at,@updated_at,1) ON CONFLICT(uuid) DO UPDATE SET employee_id=excluded.employee_id,principal=excluded.principal,principal_minor=excluded.principal_minor,installment_count=excluded.installment_count,installment_amount=excluded.installment_amount,installment_amount_minor=excluded.installment_amount_minor,first_deduction_month=excluded.first_deduction_month,reason=excluded.reason,status=excluded.status,updated_at=excluded.updated_at,synced=1`).run({...pa,branchId:currentBranch.id}); }
    for(const pi of own(changes.payroll_advance_installments||[], 'payroll_advance_installments')) { const advanceId=db.prepare('SELECT id FROM payroll_advances WHERE uuid=?').get(pi.advance_uuid)?.id; if(!advanceId) continue; db.prepare(`INSERT INTO payroll_advance_installments(advance_id,month_key,installment_no,amount,amount_minor,created_at,synced) VALUES(?,?,?,?,?,?,1) ON CONFLICT(advance_id,installment_no) DO UPDATE SET month_key=excluded.month_key,amount=excluded.amount,amount_minor=excluded.amount_minor,synced=1`).run(advanceId,pi.month_key,pi.installment_no,pi.amount,pi.amount_minor||0,pi.created_at); }
    for(const pp of own(changes.payroll_advance_payments||[], 'payroll_advance_payments')) { const advanceId=db.prepare('SELECT id FROM payroll_advances WHERE uuid=?').get(pp.advance_uuid)?.id; if(!advanceId) continue; db.prepare(`INSERT INTO payroll_advance_payments(uuid,branch_id,advance_id,payment_type,amount,amount_minor,payment_date,method,reference,notes,cash_movement_id,created_by,voided_at,void_reason,created_at,synced) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1) ON CONFLICT(uuid) DO UPDATE SET advance_id=excluded.advance_id,amount=excluded.amount,amount_minor=excluded.amount_minor,payment_date=excluded.payment_date,method=excluded.method,reference=excluded.reference,notes=excluded.notes,voided_at=excluded.voided_at,void_reason=excluded.void_reason,synced=1`).run(pp.uuid,currentBranch.id,advanceId,pp.payment_type,pp.amount,pp.amount_minor,pp.payment_date,pp.method,pp.reference,pp.notes,null,null,pp.voided_at,pp.void_reason,pp.created_at); }
    for(const al of own(changes.payroll_advance_payment_allocations||[], 'payroll_advance_payment_allocations')) { const paymentId=db.prepare('SELECT id FROM payroll_advance_payments WHERE uuid=?').get(al.payment_uuid)?.id; const installmentId=db.prepare('SELECT i.id FROM payroll_advance_installments i JOIN payroll_advances a ON a.id=i.advance_id WHERE i.month_key=? AND a.uuid=?').get(al.month_key,al.advance_uuid)?.id; if(!paymentId||!installmentId) continue; db.prepare(`INSERT INTO payroll_advance_payment_allocations(payment_id,installment_id,amount,amount_minor,created_at,synced) VALUES(?,?,?,?,?,1) ON CONFLICT(payment_id,installment_id) DO UPDATE SET amount=excluded.amount,amount_minor=excluded.amount_minor,synced=1`).run(paymentId,installmentId,al.amount,al.amount_minor,al.created_at); }
    for(const pp of own(changes.payroll_payments||[], 'payroll_payments')) { const monthId=db.prepare('SELECT id FROM payroll_months WHERE uuid=?').get(pp.month_uuid)?.id; const employeeId=db.prepare('SELECT id FROM payroll_employees WHERE uuid=?').get(pp.employee_uuid)?.id; if(!monthId||!employeeId) continue; db.prepare(`INSERT INTO payroll_payments(uuid,branch_id,month_id,employee_id,amount,amount_minor,method,payment_date,reference,notes,created_by,cash_movement_id,created_at,synced) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,1) ON CONFLICT(uuid) DO UPDATE SET amount=excluded.amount,amount_minor=excluded.amount_minor,method=excluded.method,payment_date=excluded.payment_date,reference=excluded.reference,notes=excluded.notes,synced=1`).run(pp.uuid,currentBranch.id,monthId,employeeId,pp.amount,pp.amount_minor||0,pp.method,pp.payment_date,pp.reference,pp.notes,null,null,pp.created_at); }
    for(const fsr of own(changes.payroll_final_settlements||[], 'payroll_final_settlements')) { const monthId=db.prepare('SELECT id FROM payroll_months WHERE uuid=?').get(fsr.month_uuid)?.id; const employeeId=db.prepare('SELECT id FROM payroll_employees WHERE uuid=?').get(fsr.employee_uuid)?.id; if(!monthId||!employeeId) continue; db.prepare(`INSERT INTO payroll_final_settlements(uuid,branch_id,employee_id,month_id,settlement_date,gross_earned,deductions,advance_balance,additional_compensation,net_due,paid_amount,gross_earned_minor,deductions_minor,advance_balance_minor,additional_compensation_minor,net_due_minor,paid_amount_minor,method,cash_movement_id,notes,created_by,status,voided_at,void_reason,created_at,updated_at,synced) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1) ON CONFLICT(uuid) DO UPDATE SET settlement_date=excluded.settlement_date,net_due=excluded.net_due,net_due_minor=excluded.net_due_minor,paid_amount=excluded.paid_amount,paid_amount_minor=excluded.paid_amount_minor,status=excluded.status,voided_at=excluded.voided_at,void_reason=excluded.void_reason,updated_at=excluded.updated_at,synced=1`).run(fsr.uuid,currentBranch.id,employeeId,monthId,fsr.settlement_date,fsr.gross_earned,fsr.deductions,fsr.advance_balance,fsr.additional_compensation,fsr.net_due,fsr.paid_amount,fsr.gross_earned_minor,fsr.deductions_minor,fsr.advance_balance_minor,fsr.additional_compensation_minor,fsr.net_due_minor,fsr.paid_amount_minor,fsr.method,null,fsr.notes,null,fsr.status,fsr.voided_at,fsr.void_reason,fsr.created_at,fsr.updated_at); }

    // 3) products first, then parent-product references.
    for(const prod of changes.products||[]){
      const branchId=currentBranch.id;
      const categoryId=prod.category_uuid?db.prepare('SELECT id FROM categories WHERE uuid=?').get(prod.category_uuid)?.id||null:null;
      const taxProfileId=prod.tax_profile_uuid?db.prepare('SELECT id FROM tax_profiles WHERE uuid=? AND branch_id=?').get(prod.tax_profile_uuid,branchId)?.id||null:null;
      db.prepare(`
        INSERT INTO products(
          uuid,sku,barcode,name,category_id,price,cost,tax_rate,tax_profile_id,unit,track_inventory,is_active,
          image_path,variant_size,variant_color,parent_product_id,is_recipe,is_weighted,plu_code,updated_at,synced
        ) VALUES(
          @uuid,@sku,@barcode,@name,@categoryId,@price,@cost,@tax_rate,@taxProfileId,@unit,@track_inventory,@is_active,
          @image_path,@variant_size,@variant_color,NULL,@is_recipe,@is_weighted,@plu_code,@updated_at,1
        )
        ON CONFLICT(uuid) DO UPDATE SET
          sku=excluded.sku,barcode=excluded.barcode,name=excluded.name,category_id=excluded.category_id,price=excluded.price,
          cost=excluded.cost,tax_rate=excluded.tax_rate,tax_profile_id=excluded.tax_profile_id,unit=excluded.unit,
          track_inventory=excluded.track_inventory,is_active=excluded.is_active,image_path=excluded.image_path,
          variant_size=excluded.variant_size,variant_color=excluded.variant_color,is_recipe=excluded.is_recipe,
          is_weighted=excluded.is_weighted,plu_code=excluded.plu_code,updated_at=excluded.updated_at,synced=1`)
        .run({...prod,categoryId,taxProfileId,updated_at:prod.updated_at||new Date().toISOString()});
    }
    for(const prod of changes.products||[]){
      const parentProductId=prod.parent_product_uuid?db.prepare('SELECT id FROM products WHERE uuid=?').get(prod.parent_product_uuid)?.id||null:null;
      db.prepare('UPDATE products SET parent_product_id=?,synced=1 WHERE uuid=?').run(parentProductId,prod.uuid);
    }

    // 4) branch-owned masters before transactional documents.
    for(const t of own(changes.tables||[], 'tables')){
      const branchId=findOrCreateBranch(t.branch_uuid);
      if(branchId!==currentBranch.id) continue;
      db.prepare(`
        INSERT INTO restaurant_tables(uuid,branch_id,name,seats,status,updated_at,synced)
        VALUES(@uuid,@branchId,@name,@seats,@status,@updated_at,1)
        ON CONFLICT(uuid) DO UPDATE SET name=excluded.name,seats=excluded.seats,status=excluded.status,
          updated_at=excluded.updated_at,synced=1`).run({...t,branchId,updated_at:t.updated_at||new Date().toISOString()});
    }
    for(const c of own(changes.customers||[], 'customers')){
      const branchId=findOrCreateBranch(c.branch_uuid);
      if(branchId!==currentBranch.id) continue;
      db.prepare(`
        INSERT INTO customers(uuid,branch_id,name,phone,loyalty_points,balance,store_credit_balance,updated_at,synced)
        VALUES(@uuid,@branchId,@name,@phone,0,@balance,0,@updated_at,1)
        ON CONFLICT(uuid) DO UPDATE SET name=excluded.name,phone=excluded.phone,
          balance=excluded.balance,updated_at=excluded.updated_at,synced=1`)
        .run({...c,branchId,balance:Number(c.balance||0),updated_at:c.updated_at||new Date().toISOString()});
    }
    for(const sup of own(changes.suppliers||[], 'suppliers')){
      const branchId=findOrCreateBranch(sup.branch_uuid);
      if(branchId!==currentBranch.id) continue;
      db.prepare(`
        INSERT INTO suppliers(uuid,branch_id,name,phone,address,notes,balance,updated_at,synced)
        VALUES(@uuid,@branchId,@name,@phone,@address,@notes,@balance,@updated_at,1)
        ON CONFLICT(uuid) DO UPDATE SET name=excluded.name,phone=excluded.phone,address=excluded.address,notes=excluded.notes,
          balance=excluded.balance,updated_at=excluded.updated_at,synced=1`)
        .run({...sup,branchId,updated_at:sup.updated_at||new Date().toISOString()});
    }
    for(const sh of own(changes.shifts||[], 'shifts')){
      const branchId=findOrCreateBranch(sh.branch_uuid);
      if(branchId!==currentBranch.id) continue;
      const openedBy=sh.opened_by_username?db.prepare('SELECT id FROM users WHERE username=? AND branch_id=?').get(sh.opened_by_username,branchId)?.id:null;
      const closedBy=sh.closed_by_username?db.prepare('SELECT id FROM users WHERE username=? AND branch_id=?').get(sh.closed_by_username,branchId)?.id:null;
      db.prepare(`
        INSERT INTO shifts(uuid,branch_id,opened_by,closed_by,opening_amount,expected_cash,actual_cash,cash_difference,status,opened_at,closed_at,notes,synced)
        VALUES(@uuid,@branchId,@openedBy,@closedBy,@opening_amount,@expected_cash,@actual_cash,@cash_difference,@status,@opened_at,@closed_at,@notes,1)
        ON CONFLICT(uuid) DO UPDATE SET closed_by=excluded.closed_by,expected_cash=excluded.expected_cash,
          actual_cash=excluded.actual_cash,cash_difference=excluded.cash_difference,status=excluded.status,
          closed_at=excluded.closed_at,notes=excluded.notes,synced=1`)
        .run({...sh,branchId,openedBy,closedBy,opened_at:sh.opened_at||new Date().toISOString()});
    }

    // 5) purchase orders before supplier ledger so foreign keys can resolve.
    for(const po of own(changes.purchase_orders||[], 'purchase_orders')){
      const branchId=findOrCreateBranch(po.branch_uuid);
      if(branchId!==currentBranch.id) continue;
      const supplierId=po.supplier_uuid?db.prepare('SELECT id FROM suppliers WHERE uuid=? AND branch_id=?').get(po.supplier_uuid,branchId)?.id:null;
      if(!supplierId) continue;
      db.prepare(`
        INSERT INTO purchase_orders(uuid,branch_id,supplier_id,status,total,paid_amount,payment_method,received_at,notes,created_at,updated_at,synced)
        VALUES(@uuid,@branchId,@supplierId,@status,@total,@paid_amount,@payment_method,@received_at,@notes,@created_at,@updated_at,1)
        ON CONFLICT(uuid) DO UPDATE SET status=excluded.status,total=excluded.total,paid_amount=excluded.paid_amount,payment_method=excluded.payment_method,
          received_at=excluded.received_at,notes=excluded.notes,updated_at=excluded.updated_at,synced=1`)
        .run({...po,branchId,supplierId,payment_method:po.payment_method||'credit',created_at:po.created_at||new Date().toISOString(),updated_at:po.updated_at||new Date().toISOString()});
      const localPo=db.prepare('SELECT id FROM purchase_orders WHERE uuid=?').get(po.uuid);
      if(!localPo) continue;
      const hasItems=db.prepare('SELECT 1 FROM purchase_order_items WHERE purchase_order_id=? LIMIT 1').get(localPo.id);
      if(!hasItems){
        const ins=db.prepare('INSERT INTO purchase_order_items(purchase_order_id,product_id,quantity,unit_cost) VALUES(?,?,?,?)');
        for(const item of po.items||[]){
          const productId=db.prepare('SELECT id FROM products WHERE uuid=?').get(item.product_uuid)?.id;
          if(productId)ins.run(localPo.id,productId,item.quantity,item.unit_cost);
        }
      }
    }

    // 6) sales before returns/payments/ledgers so all references are resolvable.
    for(const sale of own(changes.sales||[], 'sales')){
      const branchId=findOrCreateBranch(sale.branch_uuid);
      if(branchId!==currentBranch.id) continue;
      const customerId=sale.customer_uuid?db.prepare('SELECT id FROM customers WHERE uuid=? AND branch_id=?').get(sale.customer_uuid,branchId)?.id||null:null;
      const userId=sale.user_username?db.prepare('SELECT id FROM users WHERE username=? AND branch_id=?').get(sale.user_username,branchId)?.id||null:null;
      const shiftId=sale.shift_uuid?db.prepare('SELECT id FROM shifts WHERE uuid=? AND branch_id=?').get(sale.shift_uuid,branchId)?.id||null:null;
      const tableId=sale.table_uuid?db.prepare('SELECT id FROM restaurant_tables WHERE uuid=? AND branch_id=?').get(sale.table_uuid,branchId)?.id||null:null;
      db.prepare(`
        INSERT INTO sales(
          uuid,branch_id,user_id,customer_id,table_id,shift_id,subtotal,tax_total,discount_total,discount_type,discount_value,
          discount_approved_by,bundle_discount_total,grand_total,payment_method,cash_amount,card_amount,change_due,due_amount,
          exchange_rate,invoice_number,payment_reference,payment_provider,payment_currency,client_request_id,loyalty_points_awarded,
          loyalty_points_reversed,status,order_type,delivery_fee,delivery_person,created_at,synced
        ) VALUES(
          @uuid,@branchId,@userId,@customerId,@tableId,@shiftId,@subtotal,@tax_total,@discount_total,@discount_type,@discount_value,
          NULL,@bundle_discount_total,@grand_total,@payment_method,@cash_amount,@card_amount,@change_due,@due_amount,
          @exchange_rate,@invoice_number,@payment_reference,@payment_provider,@payment_currency,@client_request_id,@loyalty_points_awarded,
          @loyalty_points_reversed,@status,@order_type,@delivery_fee,@delivery_person,@created_at,1
        ) ON CONFLICT(uuid) DO NOTHING`)
        .run({
          ...sale,branchId,userId,customerId,tableId,shiftId,
          loyalty_points_awarded:Number(sale.loyalty_points_awarded||0),
          loyalty_points_reversed:Number(sale.loyalty_points_reversed||0),
          created_at:sale.created_at||new Date().toISOString()
        });
      const localSale=db.prepare('SELECT id FROM sales WHERE uuid=? AND branch_id=?').get(sale.uuid,branchId);
      if(!localSale) continue;
      const hasItems=db.prepare('SELECT 1 FROM sale_items WHERE sale_id=? LIMIT 1').get(localSale.id);
      if(hasItems) continue;
      const ins=db.prepare('INSERT INTO sale_items(uuid,sale_id,product_id,quantity,unit_price,tax_rate,tax_profile_id,tax_inclusive,discount,line_total,notes,cost_at_sale) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)');
      for(const item of sale.items||[]){
        const productId=db.prepare('SELECT id FROM products WHERE uuid=?').get(item.product_uuid)?.id;
        const taxProfileId=item.tax_profile_uuid?db.prepare('SELECT id FROM tax_profiles WHERE uuid=? AND branch_id=?').get(item.tax_profile_uuid,branchId)?.id||null:null;
        if(productId)ins.run(item.uuid||uuid(),localSale.id,productId,item.quantity,item.unit_price,item.tax_rate||0,taxProfileId,item.tax_inclusive?1:0,item.discount||0,item.line_total,item.notes||null,Number(item.cost_at_sale||0));
      }
    }

    // 7) returns before payment_transactions because return payment rows reference return_id.
    for(const r of own(changes.returns||[], 'returns')){
      const branchId=findOrCreateBranch(r.branch_uuid);
      if(branchId!==currentBranch.id) continue;
      const saleId=r.sale_uuid?db.prepare('SELECT id FROM sales WHERE uuid=? AND branch_id=?').get(r.sale_uuid,branchId)?.id:null;
      if(!saleId) continue;
      const userId=r.user_username?db.prepare('SELECT id FROM users WHERE username=? AND branch_id=?').get(r.user_username,branchId)?.id||null:null;
      const shiftId=r.shift_uuid?db.prepare('SELECT id FROM shifts WHERE uuid=? AND branch_id=?').get(r.shift_uuid,branchId)?.id||null:null;
      const inserted=db.prepare(`
        INSERT INTO returns(uuid,branch_id,sale_id,user_id,shift_id,reason,refund_method,total_refunded,client_request_id,created_at,synced)
        VALUES(@uuid,@branchId,@saleId,@userId,@shiftId,@reason,@refund_method,@total_refunded,@client_request_id,@created_at,1)
        ON CONFLICT(uuid) DO NOTHING`).run({...r,branchId,saleId,userId,shiftId,created_at:r.created_at||new Date().toISOString()});
      const localReturn=db.prepare('SELECT id FROM returns WHERE uuid=? AND branch_id=?').get(r.uuid,branchId);
      if(!localReturn) continue;
      if(!inserted.changes) continue; // idempotent: no duplicate financial side effects.
      const ins=db.prepare('INSERT INTO return_items(return_id,sale_item_id,product_id,quantity,refund_amount) VALUES(?,?,?,?,?)');
      for(const item of r.items||[]){
        const productId=db.prepare('SELECT id FROM products WHERE uuid=?').get(item.product_uuid)?.id;
        const localSaleItemId=item.sale_item_uuid
          ?db.prepare('SELECT id FROM sale_items WHERE uuid=? AND sale_id=?').get(item.sale_item_uuid,saleId)?.id
          :(productId?db.prepare('SELECT id FROM sale_items WHERE sale_id=? AND product_id=? ORDER BY id LIMIT 1').get(saleId,productId)?.id:null);
        if(productId&&localSaleItemId)ins.run(localReturn.id,localSaleItemId,productId,item.quantity,item.refund_amount);
      }
      const saleRow=db.prepare('SELECT id,customer_id,grand_total,loyalty_points_awarded,loyalty_points_reversed FROM sales WHERE id=? AND branch_id=?').get(saleId,branchId);
      if(saleRow?.customer_id){
        const saleAward=Number(saleRow.loyalty_points_awarded||0);
        const currentReversed=Number(saleRow.loyalty_points_reversed||0);
        const prevRefunded=Number(db.prepare(`SELECT COALESCE(SUM(total_refunded),0) AS total FROM returns WHERE sale_id=? AND id<>?`).get(saleId,localReturn.id).total||0);
        const saleGrand=Math.max(Number(saleRow.grand_total||0),0.01);
        const ratio=Math.min(1,(prevRefunded+Number(r.total_refunded||0))/saleGrand);
        const target=Math.min(saleAward,Math.floor(saleAward*ratio+1e-9));
        const reverseNow=Math.max(0,target-currentReversed);
        if(reverseNow>0){
          db.prepare('UPDATE customers SET loyalty_points=MAX(0,loyalty_points-?),updated_at=? WHERE id=? AND branch_id=?').run(reverseNow,r.created_at||new Date().toISOString(),saleRow.customer_id,branchId);
          db.prepare('UPDATE sales SET loyalty_points_reversed=? WHERE id=? AND branch_id=?').run(currentReversed+reverseNow,saleId,branchId);
        }
      }
      const pending=db.prepare(`SELECT COALESCE(SUM(ri.quantity),0) AS returned FROM return_items ri WHERE ri.return_id IN (SELECT id FROM returns WHERE sale_id=?)`).get(saleId).returned;
      const sold=db.prepare('SELECT COALESCE(SUM(quantity),0) AS sold FROM sale_items WHERE sale_id=?').get(saleId).sold;
      if(Number(pending)>=Number(sold)&&Number(sold)>0) db.prepare('UPDATE sales SET status=\'refunded\',synced=1 WHERE id=? AND branch_id=?').run(saleId,branchId);
      else db.prepare('UPDATE sales SET status=\'partially_refunded\',synced=1 WHERE id=? AND branch_id=? AND status=\'completed\'').run(saleId,branchId);
    }

    // 8) store-credit ledger before payments: events are authoritative; customer snapshots never overwrite the balance.
    for(const l of own(changes.store_credit_ledger||[], 'store_credit_ledger')){
      const branchId=findOrCreateBranch(l.branch_uuid); if(branchId!==currentBranch.id) continue;
      const customerId=l.customer_uuid?db.prepare('SELECT id FROM customers WHERE uuid=? AND branch_id=?').get(l.customer_uuid,branchId)?.id:null;
      if(!customerId) continue;
      const saleId=l.sale_uuid?db.prepare('SELECT id FROM sales WHERE uuid=? AND branch_id=?').get(l.sale_uuid,branchId)?.id:null;
      const returnId=l.return_uuid?db.prepare('SELECT id FROM returns WHERE uuid=? AND branch_id=?').get(l.return_uuid,branchId)?.id:null;
      const createdBy=l.created_by_username?db.prepare('SELECT id FROM users WHERE username=? AND branch_id=?').get(l.created_by_username,branchId)?.id:null;
      const inserted=db.prepare(`INSERT INTO store_credit_ledger(uuid,branch_id,customer_id,sale_id,return_id,entry_type,amount,created_by,created_at,synced) VALUES(@uuid,@branchId,@customerId,@saleId,@returnId,@entry_type,@amount,@createdBy,@created_at,1) ON CONFLICT(uuid) DO NOTHING`).run({...l,branchId,customerId,saleId,returnId,createdBy,created_at:l.created_at||new Date().toISOString()});
      if(inserted.changes) recalcStoreCreditBalance(customerId,branchId,false);
    }

    // 9) payments/cash after their parents exist.
    for(const pt of own(changes.payments||[], 'payments')){
      const branchId=findOrCreateBranch(pt.branch_uuid); if(branchId!==currentBranch.id)continue;
      const saleId=pt.sale_uuid?db.prepare('SELECT id FROM sales WHERE uuid=? AND branch_id=?').get(pt.sale_uuid,branchId)?.id:null;
      const returnId=pt.return_uuid?db.prepare('SELECT id FROM returns WHERE uuid=? AND branch_id=?').get(pt.return_uuid,branchId)?.id:null;
      const shiftId=pt.shift_uuid?db.prepare('SELECT id FROM shifts WHERE uuid=? AND branch_id=?').get(pt.shift_uuid,branchId)?.id:null;
      const createdBy=pt.created_by_username?db.prepare('SELECT id FROM users WHERE username=? AND branch_id=?').get(pt.created_by_username,branchId)?.id:null;
      db.prepare(`
        INSERT INTO payment_transactions(uuid,branch_id,sale_id,return_id,shift_id,method,currency_code,amount,exchange_rate,provider,provider_reference,external_id,masked_descriptor,created_by,created_at,synced)
        VALUES(@uuid,@branchId,@saleId,@returnId,@shiftId,@method,@currency_code,@amount,@exchange_rate,@provider,@provider_reference,@external_id,@masked_descriptor,@createdBy,@created_at,1)
        ON CONFLICT(uuid) DO NOTHING`).run({...pt,branchId,saleId,returnId,shiftId,createdBy,created_at:pt.created_at||new Date().toISOString()});
    }
    for(const cm of own(changes.cash_movements||[], 'cash_movements')){
      const branchId=findOrCreateBranch(cm.branch_uuid); if(branchId!==currentBranch.id)continue;
      const shiftId=cm.shift_uuid?db.prepare('SELECT id FROM shifts WHERE uuid=? AND branch_id=?').get(cm.shift_uuid,branchId)?.id:null; if(!shiftId)continue;
      const createdBy=cm.created_by_username?db.prepare('SELECT id FROM users WHERE username=? AND branch_id=?').get(cm.created_by_username,branchId)?.id:null;
      db.prepare(`
        INSERT INTO cash_movements(uuid,branch_id,shift_id,type,amount,reason,reference,created_by,created_at,synced)
        VALUES(@uuid,@branchId,@shiftId,@type,@amount,@reason,@reference,@createdBy,@created_at,1)
        ON CONFLICT(uuid) DO NOTHING`).run({...cm,branchId,shiftId,createdBy,created_at:cm.created_at||new Date().toISOString()});
    }

    // 9) inventory snapshot first, then movements as the authoritative delta stream.
    for(const i of own(changes.inventory||[], 'inventory')){
      const productId=db.prepare('SELECT id FROM products WHERE uuid=?').get(i.product_uuid)?.id;
      if(!productId)continue;
      const branchId=findOrCreateBranch(i.branch_uuid); if(branchId!==currentBranch.id)continue;
      const local=db.prepare('SELECT id,updated_at FROM inventory WHERE branch_id=? AND product_id=?').get(branchId,productId);
      const incomingUpdatedAt = i.updated_at || new Date().toISOString();
      if(!local){
        db.prepare(`INSERT INTO inventory(branch_id,product_id,quantity,unit_cost,min_quantity,updated_at,synced) VALUES(?,?,?,?,?,?,1)`).run(branchId,productId,i.quantity,Number(i.unit_cost??0),i.min_quantity,incomingUpdatedAt);
      }else{
        const localIsNewer = local.updated_at && String(local.updated_at) > String(incomingUpdatedAt);
        db.prepare(`UPDATE inventory SET min_quantity=?,unit_cost=CASE WHEN ? THEN unit_cost ELSE COALESCE(?,unit_cost) END,updated_at=CASE WHEN ? THEN updated_at ELSE ? END,synced=1 WHERE branch_id=? AND product_id=?`).run(i.min_quantity, localIsNewer ? 1 : 0, i.unit_cost == null ? null : Number(i.unit_cost), localIsNewer ? 1 : 0, localIsNewer ? local.updated_at : incomingUpdatedAt, branchId, productId);
      }
    }
    for(const im of own(changes.inventory_movements||[], 'inventory_movements')){
      const branchId=findOrCreateBranch(im.branch_uuid); if(branchId!==currentBranch.id)continue;
      const productId=im.product_uuid?db.prepare('SELECT id FROM products WHERE uuid=?').get(im.product_uuid)?.id:null;
      if(!productId)continue;
      const stamp=im.created_at||new Date().toISOString();
      const inserted=db.prepare(`
        INSERT INTO inventory_movements(uuid,branch_id,product_id,change_qty,reason,ref_id,notes,unit_cost_after,created_at,synced)
        VALUES(@uuid,@branchId,@productId,@change_qty,@reason,@ref_id,@notes,@unit_cost_after,@created_at,1)
        ON CONFLICT(uuid) DO NOTHING`).run({...im,branchId,productId,created_at:stamp});
      if(!inserted.changes)continue;
      const localInv=db.prepare('SELECT quantity,updated_at FROM inventory WHERE branch_id=? AND product_id=?').get(branchId,productId);
      if(localInv){
        const localIsNewer = localInv.updated_at && String(localInv.updated_at) > stamp;
        const unitCost = (!localIsNewer && im.unit_cost_after != null) ? Number(im.unit_cost_after) : null;
        db.prepare(`UPDATE inventory SET quantity=quantity+?,unit_cost=COALESCE(?,unit_cost),updated_at=CASE WHEN ? THEN updated_at ELSE ? END,synced=1 WHERE branch_id=? AND product_id=?`)
          .run(Number(im.change_qty)||0, unitCost, localIsNewer ? 1 : 0, localIsNewer ? localInv.updated_at : stamp, branchId, productId);
      }else{
        db.prepare(`INSERT INTO inventory(branch_id,product_id,quantity,unit_cost,min_quantity,updated_at,synced) VALUES(?,?,?,?,0,?,1)`)
          .run(branchId,productId,Number(im.change_qty)||0,Number(im.unit_cost_after||0),stamp);
      }
    }

    // 10) ledgers after their referenced sales/purchase orders exist.
    for(const l of own(changes.customer_ledger||[], 'customer_ledger')){
      if(!l.uuid)continue;
      const branchId=l.branch_uuid?findOrCreateBranch(l.branch_uuid):currentBranch.id; if(branchId!==currentBranch.id)continue;
      const customerId=l.customer_uuid?db.prepare('SELECT id FROM customers WHERE uuid=? AND branch_id=?').get(l.customer_uuid,branchId)?.id:null; if(!customerId)continue;
      const saleId=l.sale_uuid?db.prepare('SELECT id FROM sales WHERE uuid=? AND branch_id=?').get(l.sale_uuid,branchId)?.id||null:null;
      db.prepare(`
        INSERT INTO customer_ledger(uuid,branch_id,customer_id,sale_id,entry_type,amount,balance_after,notes,created_at,synced)
        VALUES(@uuid,@branchId,@customerId,@saleId,@entry_type,@amount,@balance_after,@notes,@created_at,1)
        ON CONFLICT(uuid) DO NOTHING`).run({...l,branchId,customerId,saleId,created_at:l.created_at||new Date().toISOString()});
    }
    for(const sl of own(changes.supplier_ledger||[], 'supplier_ledger')){
      const branchId=findOrCreateBranch(sl.branch_uuid); if(branchId!==currentBranch.id)continue;
      const supplierId=sl.supplier_uuid?db.prepare('SELECT id FROM suppliers WHERE uuid=? AND branch_id=?').get(sl.supplier_uuid,branchId)?.id:null;
      const poId=sl.purchase_order_uuid?db.prepare('SELECT id FROM purchase_orders WHERE uuid=? AND branch_id=?').get(sl.purchase_order_uuid,branchId)?.id:null;
      if(!supplierId)continue;
      db.prepare(`
        INSERT INTO supplier_ledger(uuid,branch_id,supplier_id,purchase_order_id,entry_type,amount,balance_after,notes,created_at,synced)
        VALUES(@uuid,@branchId,@supplierId,@poId,@entry_type,@amount,@balance_after,@notes,@created_at,1)
        ON CONFLICT(uuid) DO NOTHING`).run({...sl,supplierId,poId,created_at:sl.created_at||new Date().toISOString()});
    }

    // 11) bundles after products exist.
    for(const bu of own(changes.bundles||[], 'bundles')){
      const branchId=findOrCreateBranch(bu.branch_uuid); if(branchId!==currentBranch.id)continue;
      db.prepare(`
        INSERT INTO bundles(uuid,branch_id,name,discount_type,discount_value,is_active,updated_at,synced)
        VALUES(@uuid,@branchId,@name,@discount_type,@discount_value,@is_active,@updated_at,1)
        ON CONFLICT(uuid) DO UPDATE SET name=excluded.name,discount_type=excluded.discount_type,
          discount_value=excluded.discount_value,is_active=excluded.is_active,updated_at=excluded.updated_at,synced=1`)
        .run({...bu,branchId,updated_at:bu.updated_at||new Date().toISOString()});
      const localBundle=db.prepare('SELECT id FROM bundles WHERE uuid=?').get(bu.uuid);
      if(!localBundle)continue;
      db.prepare('DELETE FROM bundle_items WHERE bundle_id=?').run(localBundle.id);
      const ins=db.prepare('INSERT INTO bundle_items(bundle_id,product_id,quantity) VALUES(?,?,?)');
      for(const item of bu.items||[]){
        const productId=db.prepare('SELECT id FROM products WHERE uuid=?').get(item.product_uuid)?.id;
        if(productId)ins.run(localBundle.id,productId,item.quantity);
      }
    }

    // 12) Cross-branch inventory transfers. The transfer document is visible to both
    // endpoints, while the receipt is the only event that mutates destination stock.
    for (const t of (changes.inventory_transfers || [])) {
      if (!t?.uuid || t.source_branch_uuid !== currentBranchUuid && t.destination_branch_uuid !== currentBranchUuid) continue;
      const local = db.prepare('SELECT id FROM inventory_transfers WHERE uuid=? AND local_branch_id=?').get(t.uuid,currentBranch.id);
      let localTransferId = local?.id || null;
      if (!localTransferId) {
        const result = db.prepare(`INSERT INTO inventory_transfers(uuid,source_branch_uuid,destination_branch_uuid,local_branch_id,status,notes,created_by,shipped_at,created_at,updated_at,synced)
          VALUES(?,?,?,?,?,?,?,?,?,?,1)`).run(t.uuid,t.source_branch_uuid,t.destination_branch_uuid,currentBranch.id,t.status==='cancelled'?'cancelled':'shipped',t.notes||null,null,t.shipped_at||t.created_at||new Date().toISOString(),t.created_at||new Date().toISOString(),t.updated_at||t.created_at||new Date().toISOString());
        localTransferId=result.lastInsertRowid;
        const ins=db.prepare(`INSERT OR IGNORE INTO inventory_transfer_items(transfer_id,product_id,product_uuid,quantity,unit_cost) VALUES(?,?,?,?,?)`);
        for(const item of t.items||[]) {
          const productId=db.prepare('SELECT id FROM products WHERE uuid=?').get(item.product_uuid)?.id;
          if(productId) ins.run(localTransferId,productId,item.product_uuid,Number(item.quantity)||0,Number(item.unit_cost)||0);
        }
      } else if (t.status === 'cancelled' && !db.prepare('SELECT 1 FROM inventory_transfer_receipts WHERE transfer_uuid=?').get(t.uuid)) {
        db.prepare(`UPDATE inventory_transfers SET status='cancelled',notes=?,updated_at=?,synced=1 WHERE id=?`).run(t.notes||null,t.updated_at||new Date().toISOString(),localTransferId);
      }
    }
    for (const r of (changes.inventory_transfer_receipts || [])) {
      if (!r?.uuid || (r.destination_branch_uuid !== currentBranchUuid && r.source_branch_uuid !== currentBranchUuid)) continue;
      const localReceipt=db.prepare('SELECT id FROM inventory_transfer_receipts WHERE uuid=?').get(r.uuid);
      if(localReceipt) continue;
      const transfer=db.prepare('SELECT * FROM inventory_transfers WHERE uuid=? AND local_branch_id=?').get(r.transfer_uuid,currentBranch.id);
      if(!transfer) continue;
      const receiptId=db.prepare(`INSERT INTO inventory_transfer_receipts(uuid,transfer_uuid,source_branch_uuid,destination_branch_uuid,local_branch_id,received_by,notes,received_at,created_at,updated_at,synced)
        VALUES(?,?,?,?,?,?,?, ?,?,?,1)`).run(r.uuid,r.transfer_uuid,r.source_branch_uuid,r.destination_branch_uuid,currentBranch.id,null,r.notes||null,r.received_at||r.created_at||new Date().toISOString(),r.created_at||new Date().toISOString(),r.updated_at||r.created_at||new Date().toISOString()).lastInsertRowid;
      const ins=db.prepare('INSERT OR IGNORE INTO inventory_transfer_receipt_items(receipt_id,product_uuid,quantity_received) VALUES(?,?,?)');
      for(const item of r.items||[]) ins.run(receiptId,item.product_uuid,Number(item.quantity_received)||0);
      if(transfer.source_branch_uuid===currentBranchUuid){
        db.prepare(`UPDATE inventory_transfers SET status='received',updated_at=? WHERE id=?`).run(r.received_at||r.created_at||new Date().toISOString(),transfer.id);
      }
    }

    recalcAllCustomerBalancesForBranch(currentBranch.id);
  });
  tx();
  recalcCustomerLoyaltyPointsForBranch(currentBranch.id);
}
function recalcCustomerLoyaltyPointsForBranch(branchId) {
  const customers = db.prepare('SELECT id, loyalty_points FROM customers WHERE branch_id=?').all(branchId);
  const pointsStmt = db.prepare(`
    SELECT COALESCE(SUM(COALESCE(loyalty_points_awarded,0) - COALESCE(loyalty_points_reversed,0)),0) AS points
    FROM sales WHERE branch_id=? AND customer_id=?`);
  const update = db.prepare('UPDATE customers SET loyalty_points=?, updated_at=datetime(\'now\'), synced=1 WHERE id=? AND branch_id=?');
  for (const customer of customers) {
    const points = Math.max(0, Math.floor(Number(pointsStmt.get(branchId, customer.id)?.points || 0)));
    if (Number(customer.loyalty_points || 0) !== points) update.run(points, customer.id, branchId);
  }
}
function recalcAllCustomerBalancesForBranch(branchId) {
  const rows=db.prepare('SELECT id, balance FROM customers WHERE branch_id=?').all(branchId);
  for(const r of rows){
    const total=db.prepare('SELECT COALESCE(SUM(amount),0) AS balance FROM customer_ledger WHERE customer_id=? AND branch_id=?').get(r.id,branchId).balance;
    const next=Math.round(Number(total||0)*100)/100;
    if (Math.abs(Number(r.balance||0)-next) > 0.005) {
      db.prepare('UPDATE customers SET balance=?,synced=1 WHERE id=? AND branch_id=?').run(next,r.id,branchId);
    }
  }
}

/* ==========================================================
   المحاسبة + سجل المزامنة
   ========================================================== */
function listAccountingAccounts(){const b=getCurrentBranch();return db.prepare('SELECT * FROM accounting_accounts WHERE branch_id=? ORDER BY code').all(b.id);}
function createAccountingAccount(input){const b=getCurrentBranch();const n=accounting.normalizeAccount(input,Number(getGlobalProfile()?.currency_minor_unit||2));const r=db.prepare(`INSERT INTO accounting_accounts(uuid,branch_id,code,name,account_type,currency_code,opening_balance_minor,is_active,updated_at,synced) VALUES(?,?,?,?,?,?,?,?,datetime('now'),0)`).run(uuid(),b.id,n.code,n.name,n.type,n.currencyCode,n.openingBalanceMinor,n.isActive);return db.prepare('SELECT * FROM accounting_accounts WHERE id=?').get(r.lastInsertRowid);}
function insertPostedJournalEntry({ branchId, memo = null, referenceType = null, referenceId = null, entryDate = null, lines = [], createdBy = null, currencyCode = null }) {
  const p = getGlobalProfile();
  const unit = Number(p?.currency_minor_unit || 2);
  const normalized = lines.map((l) => ({
    ...l,
    debitMinor: l.debitMinor != null ? Number(l.debitMinor) : money.toMinor(l.debit || 0, unit),
    creditMinor: l.creditMinor != null ? Number(l.creditMinor) : money.toMinor(l.credit || 0, unit),
  }));
  accounting.validateJournalLines(normalized);
  const currency = String(currencyCode || p?.currency_code || 'USD').toUpperCase();
  const e = db.prepare(`INSERT INTO accounting_journal_entries(uuid,branch_id,reference_type,reference_id,memo,currency_code,entry_date,status,created_by,synced) VALUES(?,?,?,?,?,?,?,'posted',?,0)`)
    .run(uuid(), branchId, referenceType, referenceId == null ? null : String(referenceId), memo, currency, entryDate || new Date().toISOString(), createdBy || null);
  const ins = db.prepare('INSERT INTO accounting_journal_lines(entry_id,account_id,debit_minor,credit_minor,memo) VALUES(?,?,?,?,?)');
  for (const line of normalized) ins.run(e.lastInsertRowid, Number(line.accountId), Number(line.debitMinor || 0), Number(line.creditMinor || 0), line.memo || null);
  return db.prepare('SELECT * FROM accounting_journal_entries WHERE id=?').get(e.lastInsertRowid);
}
function postJournalEntry(input = {}) {
  const b = getCurrentBranch();
  return db.transaction(() => insertPostedJournalEntry({ ...input, branchId: b.id }))();
}
function listJournalEntries(range={}){const b=getCurrentBranch();let sql='SELECT * FROM accounting_journal_entries WHERE branch_id=?';const a=[b.id];if(range.from){sql+=' AND entry_date>=?';a.push(range.from);}if(range.to){sql+=' AND entry_date<=?';a.push(range.to);}return db.prepare(sql+' ORDER BY entry_date DESC,id DESC LIMIT 1000').all(...a);}
function recordSyncOutboxEvent({entityType,entityUuid=null,operation='event',payload={}}){const b=getCurrentBranch();const eventId=uuid();const json=JSON.stringify(payload);const checksum=crypto.createHash('sha256').update(json).digest('hex');db.prepare('INSERT INTO sync_outbox(event_id,branch_id,entity_type,entity_uuid,operation,payload_json,payload_checksum) VALUES(?,?,?,?,?,?,?)').run(eventId,b.id,String(entityType),entityUuid,operation,json,checksum);return eventId;}
function listSyncConflicts(limit=200){const b=getCurrentBranch();return db.prepare('SELECT * FROM sync_conflicts WHERE branch_id=? ORDER BY id DESC LIMIT ?').all(b.id,Math.min(Math.max(Number(limit)||50,1),500));}
function listBackupManifests(limit=100){return db.prepare('SELECT * FROM backup_manifests ORDER BY created_at DESC LIMIT ?').all(Math.min(Math.max(Number(limit)||50,1),500));}

function saveFiscalDocument(input = {}) {
  const branch = getCurrentBranch();
  const result = db.prepare(`INSERT INTO fiscal_documents(uuid,branch_id,sale_id,provider,status,external_id,external_number,request_payload,response_payload,issued_at) VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .run(uuid(), branch.id, Number(input.saleId) || null, String(input.provider || 'generic'), String(input.status || 'pending'), input.externalId || null, input.externalNumber || null, input.requestPayload == null ? null : JSON.stringify(input.requestPayload), input.responsePayload == null ? null : JSON.stringify(input.responsePayload), input.issuedAt || null);
  return db.prepare('SELECT * FROM fiscal_documents WHERE id=?').get(result.lastInsertRowid);
}
function listFiscalDocuments(filters = {}) {
  const branch = getCurrentBranch();
  let sql = 'SELECT * FROM fiscal_documents WHERE branch_id=?'; const params = [branch.id];
  if (filters.saleId) { sql += ' AND sale_id=?'; params.push(Number(filters.saleId)); }
  if (filters.status) { sql += ' AND status=?'; params.push(String(filters.status)); }
  sql += ' ORDER BY id DESC LIMIT 500';
  return db.prepare(sql).all(...params);
}

/* ==========================================================
   النسخ الاحتياطي والاستعادة
   ========================================================== */
function getDbPath() {
  return dbPath;
}

// مجلدات ينشئها Electron/Chromium داخل userData لأغراض الكاش والجلسة المؤقتة فقط.
// هذه المجلدات: (أ) لا تحوي بيانات عميل، و(ب) قد تكون مقفلة أثناء تشغيل التطبيق
// (مثال: DawnGraphiteCache) مما يسبب فشل EACCES/EBUSY عند نسخها. يجب استبعادها
// من لقطة الترقية دائماً.
const UPGRADE_SNAPSHOT_EXCLUDED_DIRS = new Set([
  'upgrade-backups',
  'Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'DawnGraphiteCache', 'DawnWebGPUCache',
  'GrShaderCache', 'ShaderCache', 'blob_storage', 'Service Worker', 'Session Storage',
  'Local Storage', 'IndexedDB', 'Crashpad', 'CachedData', 'component_crx_cache',
  'CacheStorage', 'GPUCache_data', 'WebStorage', 'databases',
]);

function createUpgradeSnapshot(reason = 'manual') {
  if (!db || !db.open) throw new Error('لا يمكن إنشاء لقطة الترقية وقاعدة البيانات مغلقة.');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const snapshotRoot = path.join(userDataPath, 'upgrade-backups');
  const snapshotPath = path.join(snapshotRoot, `${stamp}-${String(reason).replace(/[^a-zA-Z0-9._-]/g, '_')}`);

  fs.mkdirSync(snapshotPath, { recursive: true });
  // نحذف WAL فقط بعد دمجه في pos.db، ثم ننسخ بيانات العميل الدائمة فقط من userData:
  // نستبعد لقطات الترقية السابقة ومجلدات كاش/جلسة Electron الداخلية (قد تكون مقفلة
  // أثناء التشغيل ولا تحوي أي بيانات عميل أصلاً). أي ملف يفشل نسخه لسبب القفل
  // (EBUSY/EACCES/EPERM) يُتجاوز بدل إفشال اللقطة كاملة، طالما لم يكن pos.db.
  db.pragma('wal_checkpoint(TRUNCATE)');
  const skipped = [];
  for (const entry of fs.readdirSync(userDataPath, { withFileTypes: true })) {
    if (UPGRADE_SNAPSHOT_EXCLUDED_DIRS.has(entry.name)) continue;
    const src = path.join(userDataPath, entry.name);
    const dest = path.join(snapshotPath, entry.name);
    try {
      fs.cpSync(src, dest, { recursive: true, force: false, errorOnExist: true });
    } catch (error) {
      if (entry.name === 'pos.db') throw error; // قاعدة البيانات نفسها يجب ألا تفشل بصمت
      skipped.push(entry.name);
    }
  }

  const validation = validateBackupFile(path.join(snapshotPath, 'pos.db'));
  if (!validation.valid) {
    throw new Error(`فشل التحقق من لقطة الترقية: ${validation.message}`);
  }
  fs.writeFileSync(path.join(snapshotPath, 'manifest.json'), JSON.stringify({
    createdAt: new Date().toISOString(),
    reason,
    appSchemaVersion: CURRENT_SCHEMA_VERSION,
    databaseSchemaVersion: Number(db.pragma('user_version', { simple: true }) || 0),
    included: 'userData except upgrade-backups and Electron cache/session directories',
    excludedDirs: Array.from(UPGRADE_SNAPSHOT_EXCLUDED_DIRS),
    skippedLockedEntries: skipped,
  }, null, 2), 'utf8');
  return { success: true, path: snapshotPath };
}

function closeDatabase() {
  if (db && db.open) db.close();
}
function validateBackupFile(filePath) {
  const target = String(filePath || '');
  if (!target || !fs.existsSync(target) || fs.statSync(target).size < 32) return { valid: false, message: 'ملف النسخة الاحتياطية غير موجود أو ناقص.' };
  let handle;
  try {
    handle = new Database(target, { readonly: true });
    applyDatabaseKey(handle);
    handle.pragma('schema_version');
    handle.prepare('SELECT name FROM sqlite_master WHERE type = \'table\' LIMIT 1').get();
    return { valid: true };
  } catch (error) {
    return { valid: false, message: 'ملف النسخة الاحتياطية ليس قاعدة Nexora صالحة أو لا يطابق مفتاح هذا الجهاز.' };
  } finally {
    if (handle) { try { handle.close(); } catch (_) {} }
  }
}

async function backupTo(destPath) {
  const target = path.resolve(String(destPath || ''));
  if (!target) throw new Error('مسار النسخة الاحتياطية غير صالح.');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
  try {
    await db.backup(temp);
    const validation = validateBackupFile(temp);
    if (!validation.valid) throw new Error(validation.message);
    const bytes = fs.statSync(temp).size;
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(temp)).digest('hex');
    // Replace only after the backup is complete and validated, avoiding a partially-written target.
    try { fs.rmSync(target, { force: true }); } catch (_) {}
    fs.renameSync(temp, target);
    try {
      db.prepare(`INSERT INTO backup_manifests(uuid,kind,path,file_size,sha256,schema_version,verified_at) VALUES(?,?,?,?,?,?,datetime('now'))`)
        .run(uuid(),'local',target,bytes,sha256,CURRENT_SCHEMA_VERSION);
    } catch (error) {
      logAudit({ userId: null, action: 'backup_manifest_failed', entityType: 'backup', entityId: target, level: 'error', details: { reason: error.message } });
    }
    return {success:true,path:target,sha256,schemaVersion:CURRENT_SCHEMA_VERSION};
  } finally {
    try { fs.unlinkSync(temp); } catch (_) {}
  }
}
const PORTABLE_BACKUP_MAGIC=Buffer.from('NEXORA-NXBAK-1\0','utf8');
function derivePortableKey(passphrase,salt){return crypto.scryptSync(String(passphrase),salt,32,{N:16384,r:8,p:1}).toString('hex');}
async function createPortableBackup(destPath,passphrase){const secret=String(passphrase||'');if(secret.length<12)throw new Error('كلمة مرور النسخة المحمولة يجب ألا تقل عن 12 محرفاً.');const tempDb=`${destPath}.work-${process.pid}-${Date.now()}.db`;const salt=crypto.randomBytes(16);const portableKey=derivePortableKey(secret,salt);try{await db.backup(tempDb);const h=new Database(tempDb);try{applyDatabaseKey(h);h.rekey(portableKey);}finally{h.close();}const dbBytes=fs.readFileSync(tempDb);const meta=Buffer.from(JSON.stringify({format:1,createdAt:new Date().toISOString(),appVersion:require('../package.json').version,schemaVersion:CURRENT_SCHEMA_VERSION,salt:salt.toString('base64'),dbSha256:crypto.createHash('sha256').update(dbBytes).digest('hex')}),'utf8');const header=Buffer.alloc(PORTABLE_BACKUP_MAGIC.length+4);PORTABLE_BACKUP_MAGIC.copy(header,0);header.writeUInt32BE(meta.length,PORTABLE_BACKUP_MAGIC.length);fs.writeFileSync(destPath,Buffer.concat([header,meta,dbBytes]));const checksum=crypto.createHash('sha256').update(fs.readFileSync(destPath)).digest('hex');try{db.prepare(`INSERT INTO backup_manifests(uuid,kind,path,file_size,sha256,schema_version,verified_at) VALUES(?,?,?,?,?,?,datetime('now'))`).run(uuid(),'portable',destPath,fs.statSync(destPath).size,checksum,CURRENT_SCHEMA_VERSION);}catch(_){ }return{success:true,path:destPath,sha256:checksum,schemaVersion:CURRENT_SCHEMA_VERSION};}finally{try{fs.unlinkSync(tempDb);}catch(_){}}}
function restorePortableBackup(filePath,passphrase){const secret=String(passphrase||'');if(secret.length<12)return{valid:false,message:'كلمة مرور النسخة المحمولة غير صالحة.'};let data;try{data=fs.readFileSync(filePath);}catch(e){return{valid:false,message:`تعذّر قراءة النسخة: ${e.message}`};}if(data.length<PORTABLE_BACKUP_MAGIC.length+4||!data.subarray(0,PORTABLE_BACKUP_MAGIC.length).equals(PORTABLE_BACKUP_MAGIC))return{valid:false,message:'صيغة النسخة المحمولة غير صالحة.'};const metadataLen=data.readUInt32BE(PORTABLE_BACKUP_MAGIC.length);const metadataStart=PORTABLE_BACKUP_MAGIC.length+4;const dbStart=metadataStart+metadataLen;if(dbStart>data.length)return{valid:false,message:'ملف النسخة المحمولة ناقص.'};let meta;try{meta=JSON.parse(data.subarray(metadataStart,dbStart).toString('utf8'));}catch(_){return{valid:false,message:'بيانات النسخة المحمولة تالفة.'};}const dbBytes=data.subarray(dbStart);if(crypto.createHash('sha256').update(dbBytes).digest('hex')!==meta.dbSha256)return{valid:false,message:'فشل تحقق سلامة قاعدة النسخة المحمولة.'};const salt=Buffer.from(String(meta.salt||''),'base64');if(salt.length<16)return{valid:false,message:'ملح التشفير غير صالح.'};const key=derivePortableKey(secret,salt);const temp=`${dbPath}.portable-restore-${Date.now()}.db`;try{fs.writeFileSync(temp,dbBytes,{mode:0o600});const h=new Database(temp);try{h.pragma("cipher = 'chacha20'");h.key(key);h.pragma('schema_version');h.rekey(encryptionKey);}finally{h.close();}fs.copyFileSync(temp,dbPath);const validation=validateBackupFile(dbPath);if(!validation.valid)return validation;return{valid:true,schemaVersion:Number(meta.schemaVersion||0),appVersion:String(meta.appVersion||'unknown')};}catch(e){return{valid:false,message:`فشل فك واستعادة النسخة المحمولة: ${e.message}`};}finally{try{fs.unlinkSync(temp);}catch(_){}}}

module.exports = {
  DatabaseKeyMismatchError,
  resetUserPassword,
  changeOwnPassword,
  getProfitLoss,
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
  createPurchaseOrder,
  receivePurchaseOrder,
  listPurchaseOrders,
  getPurchaseOrder,
  listTables,
  releaseEmptyTable,
  createTable,
  deleteTable,
  getOrCreateOpenSale,
  getOpenSaleForTable,
  setOpenSaleItems,
  mergeTables,
  splitTableSale,
  closeTableSale,
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
  createPortableBackup, restorePortableBackup,
  listAccountingAccounts, createAccountingAccount, postJournalEntry, listJournalEntries,
  recordSyncOutboxEvent, listSyncConflicts, listBackupManifests,
  saveFiscalDocument, listFiscalDocuments,
};
