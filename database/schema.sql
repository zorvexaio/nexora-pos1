-- ==========================================================
-- مخطط قاعدة البيانات الأساسي
-- مصمم ليكون عام ويصلح لـ: مطاعم / متاجر / سوبرماركت / أزياء
-- كل الجداول التي قد تُزامن مع سيرفر مركزي تحتوي على:
--   branch_id, uuid, updated_at, synced (0/1)
-- ==========================================================

-- إعدادات عامة للتطبيق (key-value) — مثال: الحد الأقصى لخصم الكاشير بدون موافقة مدير
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- سجل ترحيلات مُرقّم. لا يُخزّن بيانات عمل، لكنه يضمن معرفة كل جهاز للترقيات
-- المطبقة ويمنع إعادة تحويل نفس البيانات عند التحديثات المستقبلية.
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- سجل تدقيق محلي: يبقى مع قاعدة بيانات الفرع ليسهل تشخيص المشاكل ومراجعة العمليات الحساسة.
CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  branch_id INTEGER REFERENCES branches(id),
  user_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  details TEXT,
  level TEXT NOT NULL DEFAULT 'info', -- info | warning | error
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at DESC);

-- الفروع (حتى في الوضع المحلي، الفرع الحالي = صف واحد هنا)
CREATE TABLE IF NOT EXISTS branches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  business_type TEXT NOT NULL DEFAULT 'general', -- general | restaurant | supermarket | fashion
  address TEXT,
  is_current INTEGER NOT NULL DEFAULT 1, -- 1 = هذا هو الفرع الذي يعمل عليه هذا الجهاز
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- المستخدمون (كاشير، مدير، إلخ)
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT UNIQUE NOT NULL,
  full_name TEXT NOT NULL,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'cashier', -- admin | manager | cashier
  branch_id INTEGER REFERENCES branches(id),
  is_active INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  pin_hash TEXT, -- رقم PIN اختياري (نفس آلية تشفير كلمة المرور) لتبديل سريع بين الموظفين على نفس الجهاز
  hourly_rate REAL NOT NULL DEFAULT 0, -- legacy: لم يعد مستخدماً في الرواتب الجديدة
  monthly_salary REAL NOT NULL DEFAULT 0, -- الراتب الشهري الثابت
  shift_type TEXT NOT NULL DEFAULT 'morning', -- morning | evening — فترة عمل الموظف (صباحي/مسائي)
  is_payroll_only INTEGER NOT NULL DEFAULT 0, -- موظف رواتب لا يملك حساب دخول للنظام
  job_title TEXT NOT NULL DEFAULT '', -- الوظيفة: طباخ، عامل نظافة، نادل...
  pay_type TEXT NOT NULL DEFAULT 'monthly', -- monthly | daily | hourly
  pay_rate REAL NOT NULL DEFAULT 0, -- القيمة الأساسية حسب نوع الأجر
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- فئات المنتجات
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  parent_id INTEGER REFERENCES categories(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  synced INTEGER NOT NULL DEFAULT 0
);

-- المنتجات (يغطي: منتج سوبرماركت بباركود، صنف مطعم، قطعة أزياء)
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT UNIQUE NOT NULL,
  sku TEXT,                     -- رمز داخلي
  barcode TEXT,                 -- باركود (سوبرماركت)
  name TEXT NOT NULL,
  category_id INTEGER REFERENCES categories(id),
  price REAL NOT NULL DEFAULT 0,
  cost REAL DEFAULT 0,
  tax_rate REAL DEFAULT 0,      -- نسبة الضريبة %
  unit TEXT DEFAULT 'piece',    -- piece | kg | liter ...
  track_inventory INTEGER NOT NULL DEFAULT 1,
  is_active INTEGER NOT NULL DEFAULT 1,
  image_path TEXT,
  -- حقول خاصة بالأزياء (تُترك فارغة لباقي الأنشطة)
  variant_size TEXT,
  variant_color TEXT,
  parent_product_id INTEGER REFERENCES products(id), -- ربط المقاسات/الألوان بمنتج أساسي واحد
  -- حقول خاصة بالمطاعم
  is_recipe INTEGER NOT NULL DEFAULT 0, -- هل هو صنف يُحضّر (له مكونات)؟
  -- بيع بالوزن (خضار/فواكه سوبرماركت): يوزَن على ميزان يطبع باركوداً يتضمّن كود PLU + الوزن،
  -- فيمسحه الكاشير فقط دون كتابة أي شيء، ويُحسب السعر تلقائياً (سعر الكيلوغرام × الوزن المقروء).
  is_weighted INTEGER NOT NULL DEFAULT 0,
  plu_code TEXT,                -- كود قصير (عادة 4-5 أرقام) مطبوع/مُضمَّن ببركود الميزان لهذا الصنف
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  synced INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode);
CREATE INDEX IF NOT EXISTS idx_products_name ON products(name);
CREATE INDEX IF NOT EXISTS idx_products_sku ON products(sku);

CREATE UNIQUE INDEX IF NOT EXISTS idx_products_plu_code ON products(plu_code) WHERE plu_code IS NOT NULL;

-- مخزون كل فرع لكل منتج (يسمح لاحقاً بمعرفة مخزون كل فرع على حدة)
CREATE TABLE IF NOT EXISTS inventory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  branch_id INTEGER NOT NULL REFERENCES branches(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  quantity REAL NOT NULL DEFAULT 0,
  unit_cost REAL NOT NULL DEFAULT 0, -- تكلفة هذا المنتج داخل هذا الفرع
  min_quantity REAL DEFAULT 0, -- حد التنبيه لإعادة الطلب
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  synced INTEGER NOT NULL DEFAULT 0,
  UNIQUE(branch_id, product_id)
);
CREATE INDEX IF NOT EXISTS idx_inventory_branch_product ON inventory(branch_id, product_id);

-- طاولات المطاعم (فارغة/غير مستخدمة في الأنشطة الأخرى)
CREATE TABLE IF NOT EXISTS restaurant_tables (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT UNIQUE NOT NULL,
  branch_id INTEGER NOT NULL REFERENCES branches(id),
  name TEXT NOT NULL,
  seats INTEGER DEFAULT 4,
  status TEXT NOT NULL DEFAULT 'free', -- free | occupied | reserved
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  synced INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_restaurant_tables_branch_name ON restaurant_tables(branch_id,name);

-- العملاء (اختياري لكل الأنشطة)
-- ملف الدولة/المنطقة/العملة/الضريبة: طبقة محايدة عن الدولة تدعم التكييف المحلي دون افتراض قانون واحد للعالم
CREATE TABLE IF NOT EXISTS organization_profile (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  country_code TEXT NOT NULL DEFAULT 'TR',
  locale TEXT NOT NULL DEFAULT 'ar',
  timezone TEXT NOT NULL DEFAULT 'Europe/Istanbul',
  currency_code TEXT NOT NULL DEFAULT 'TRY',
  currency_minor_unit INTEGER NOT NULL DEFAULT 2,
  tax_mode TEXT NOT NULL DEFAULT 'exclusive', -- exclusive | inclusive
  tax_registration_number TEXT,
  fiscalization_mode TEXT NOT NULL DEFAULT 'none', -- none | adapter
  fiscal_provider TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO organization_profile (id) VALUES (1);

CREATE TABLE IF NOT EXISTS tax_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT UNIQUE NOT NULL,
  branch_id INTEGER NOT NULL REFERENCES branches(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  rate REAL NOT NULL DEFAULT 0,
  tax_category TEXT,
  country_code TEXT,
  is_inclusive INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  synced INTEGER NOT NULL DEFAULT 0,
  UNIQUE(branch_id, code)
);
CREATE INDEX IF NOT EXISTS idx_tax_profiles_branch_active ON tax_profiles(branch_id, is_active);

CREATE TABLE IF NOT EXISTS payment_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT UNIQUE NOT NULL,
  branch_id INTEGER NOT NULL REFERENCES branches(id),
  sale_id INTEGER REFERENCES sales(id),
  return_id INTEGER REFERENCES returns(id),
  shift_id INTEGER REFERENCES shifts(id),
  method TEXT NOT NULL, -- cash | card | bank | wallet | credit | store_credit | other
  currency_code TEXT NOT NULL,
  amount REAL NOT NULL,
  exchange_rate REAL NOT NULL DEFAULT 1,
  provider TEXT,
  provider_reference TEXT,
  external_id TEXT,
  masked_descriptor TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  synced INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_payment_transactions_branch_date ON payment_transactions(branch_id, created_at);
CREATE INDEX IF NOT EXISTS idx_payment_transactions_sale ON payment_transactions(sale_id);

CREATE TABLE IF NOT EXISTS cash_movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT UNIQUE NOT NULL,
  branch_id INTEGER NOT NULL REFERENCES branches(id),
  shift_id INTEGER NOT NULL REFERENCES shifts(id),
  type TEXT NOT NULL, -- cash_in | cash_out
  amount REAL NOT NULL,
  reason TEXT NOT NULL,
  reference TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  synced INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_cash_movements_shift ON cash_movements(shift_id, created_at);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT UNIQUE NOT NULL,
  branch_id INTEGER NOT NULL REFERENCES branches(id),
  name TEXT,
  phone TEXT,
  loyalty_points REAL DEFAULT 0,
  balance REAL NOT NULL DEFAULT 0,
  store_credit_balance REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  synced INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_customers_branch_phone ON customers(branch_id, phone);
CREATE INDEX IF NOT EXISTS idx_customers_branch_name ON customers(branch_id, name);

-- كشف حساب العميل: مبلغ موجب = دين عليه، سالب = دفعة/تسديد منه.
CREATE TABLE IF NOT EXISTS customer_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT UNIQUE,
  branch_id INTEGER REFERENCES branches(id),
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  sale_id INTEGER REFERENCES sales(id),
  entry_type TEXT NOT NULL, -- credit_sale | payment | return_adjustment
  amount REAL NOT NULL,
  balance_after REAL NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- الورديات (فتح/إغلاق الصندوق)
-- دفتر رصيد المتجر: أحداث غير قابلة للاستبدال لحماية الرصيد من lost updates عند العمل Offline على عدة أجهزة
CREATE TABLE IF NOT EXISTS store_credit_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT UNIQUE NOT NULL,
  branch_id INTEGER NOT NULL REFERENCES branches(id),
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  sale_id INTEGER REFERENCES sales(id),
  return_id INTEGER REFERENCES returns(id),
  entry_type TEXT NOT NULL CHECK(entry_type IN ('opening','sale_spend','return_credit','adjustment')),
  amount REAL NOT NULL,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  synced INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_store_credit_ledger_customer ON store_credit_ledger(branch_id, customer_id, created_at);

CREATE TABLE IF NOT EXISTS shifts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT UNIQUE NOT NULL,
  branch_id INTEGER NOT NULL REFERENCES branches(id),
  opened_by INTEGER REFERENCES users(id),
  closed_by INTEGER REFERENCES users(id),
  opening_amount REAL NOT NULL DEFAULT 0,      -- مبلغ افتتاح الصندوق
  expected_cash REAL,                          -- الكاش المتوقع عند الإغلاق (افتتاحي + مبيعات نقدية - مرتجعات نقدية)
  actual_cash REAL,                            -- الكاش الفعلي المعدود عند الإغلاق
  cash_difference REAL,                        -- actual - expected (سالب = عجز، موجب = زيادة)
  status TEXT NOT NULL DEFAULT 'open',         -- open | closed
  opened_at TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at TEXT,
  notes TEXT,
  synced INTEGER NOT NULL DEFAULT 0
);

-- الفواتير / المبيعات
CREATE TABLE IF NOT EXISTS sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT UNIQUE NOT NULL,
  branch_id INTEGER NOT NULL REFERENCES branches(id),
  user_id INTEGER REFERENCES users(id),
  customer_id INTEGER REFERENCES customers(id),
  table_id INTEGER REFERENCES restaurant_tables(id), -- يُملأ فقط في وضع المطعم
  shift_id INTEGER REFERENCES shifts(id),            -- الوردية التي صدرت فيها الفاتورة
  order_type TEXT NOT NULL DEFAULT 'in_store',       -- in_store | delivery
  delivery_fee REAL NOT NULL DEFAULT 0,               -- رسوم التوصيل (منفصلة عن أرباح المنتجات)
  delivery_person TEXT,                               -- اسم/رقم مندوب التوصيل (اختياري)
  subtotal REAL NOT NULL DEFAULT 0,
  tax_total REAL NOT NULL DEFAULT 0,
  discount_total REAL NOT NULL DEFAULT 0,
  discount_type TEXT,                                 -- percent | fixed (خصم على مستوى الفاتورة)
  discount_value REAL DEFAULT 0,                       -- القيمة المُدخلة قبل الحساب (٪ أو مبلغ)
  discount_approved_by INTEGER REFERENCES users(id),   -- المدير الذي وافق على خصم تجاوز الحد المسموح للكاشير
  grand_total REAL NOT NULL DEFAULT 0,
  payment_method TEXT NOT NULL DEFAULT 'cash', -- cash | card | mixed
  cash_amount REAL NOT NULL DEFAULT 0,   -- المبلغ المدفوع نقداً
  card_amount REAL NOT NULL DEFAULT 0,   -- المبلغ المدفوع بالبطاقة
  change_due REAL NOT NULL DEFAULT 0,    -- الباقي المُرجَع للعميل
  due_amount REAL NOT NULL DEFAULT 0,    -- المتبقي الآجل على العميل
  exchange_rate REAL NOT NULL DEFAULT 1,
  invoice_number TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'completed', -- completed | refunded | partially_refunded | void | open
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  client_request_id TEXT,
  synced INTEGER NOT NULL DEFAULT 0,
  inventory_committed INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_branch_client_request ON sales(branch_id, client_request_id) WHERE client_request_id IS NOT NULL AND client_request_id <> '';


-- رواتب شهرية ثابتة
CREATE TABLE IF NOT EXISTS payroll_periods (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT UNIQUE NOT NULL,
  branch_id INTEGER NOT NULL REFERENCES branches(id),
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  created_by INTEGER REFERENCES users(id),
  approved_by INTEGER REFERENCES users(id),
  paid_by INTEGER REFERENCES users(id),
  approved_at TEXT,
  paid_at TEXT,
  payment_method TEXT,
  payment_reference TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(branch_id, period_start, period_end)
);
CREATE INDEX IF NOT EXISTS idx_payroll_periods_branch_dates ON payroll_periods(branch_id, period_start, period_end);

CREATE TABLE IF NOT EXISTS payroll_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  period_id INTEGER NOT NULL REFERENCES payroll_periods(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  base_salary REAL NOT NULL DEFAULT 0,
  bonus_total REAL NOT NULL DEFAULT 0,
  deduction_total REAL NOT NULL DEFAULT 0,
  advance_total REAL NOT NULL DEFAULT 0,
  absence_days REAL NOT NULL DEFAULT 0, -- محفوظ للتوافق مع نسخ قديمة، غير مستخدم في الحساب الحالي
  days_worked REAL NOT NULL DEFAULT 30, -- عدد أيام العمل الفعلية بالفترة؛ للموظف اليومي يحدد أيام الأجر
  regular_hours REAL NOT NULL DEFAULT 0, -- ساعات العمل العادية للموظف بالساعة
  pay_type TEXT NOT NULL DEFAULT 'monthly',
  pay_rate REAL NOT NULL DEFAULT 0,
  net_salary REAL NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(period_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_payroll_items_period ON payroll_items(period_id);

CREATE TABLE IF NOT EXISTS payroll_adjustments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT UNIQUE NOT NULL,
  branch_id INTEGER NOT NULL REFERENCES branches(id),
  period_id INTEGER NOT NULL REFERENCES payroll_periods(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  type TEXT NOT NULL,
  amount REAL NOT NULL,
  reason TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK(type IN ('bonus','deduction','advance')),
  CHECK(amount > 0)
);
CREATE INDEX IF NOT EXISTS idx_payroll_adjustments_period_user ON payroll_adjustments(period_id, user_id);

CREATE TABLE IF NOT EXISTS user_salary_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT UNIQUE NOT NULL,
  branch_id INTEGER NOT NULL REFERENCES branches(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  monthly_salary REAL NOT NULL,
  effective_from TEXT NOT NULL,
  changed_by INTEGER REFERENCES users(id),
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_salary_history_user_effective ON user_salary_history(user_id, effective_from DESC);


-- الموردون وفواتير الشراء. الحركات تُسجّل عند الاستلام فقط.
CREATE TABLE IF NOT EXISTS suppliers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT UNIQUE NOT NULL,
  branch_id INTEGER NOT NULL REFERENCES branches(id),
  name TEXT NOT NULL,
  phone TEXT,
  address TEXT,
  notes TEXT,
  balance REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  synced INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS supplier_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT UNIQUE NOT NULL,
  branch_id INTEGER NOT NULL REFERENCES branches(id),
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  purchase_order_id INTEGER REFERENCES purchase_orders(id),
  entry_type TEXT NOT NULL, -- purchase | payment
  amount REAL NOT NULL,
  balance_after REAL NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  synced INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS purchase_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT UNIQUE NOT NULL,
  branch_id INTEGER NOT NULL REFERENCES branches(id),
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  status TEXT NOT NULL DEFAULT 'draft', -- draft | received | cancelled
  total REAL NOT NULL DEFAULT 0,
  paid_amount REAL NOT NULL DEFAULT 0,
  payment_method TEXT NOT NULL DEFAULT 'credit', -- cash | card | credit
  received_at TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  synced INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS purchase_order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_order_id INTEGER NOT NULL REFERENCES purchase_orders(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  quantity REAL NOT NULL,
  unit_cost REAL NOT NULL
);

-- المرتجعات (كامل أو جزئي من فاتورة سابقة)
CREATE TABLE IF NOT EXISTS returns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT UNIQUE NOT NULL,
  branch_id INTEGER NOT NULL REFERENCES branches(id),
  sale_id INTEGER NOT NULL REFERENCES sales(id),
  user_id INTEGER REFERENCES users(id),   -- من نفّذ المرتجع
  shift_id INTEGER REFERENCES shifts(id),
  reason TEXT,
  refund_method TEXT NOT NULL DEFAULT 'cash', -- cash | card | store_credit
  total_refunded REAL NOT NULL DEFAULT 0,
  client_request_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  synced INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_returns_branch_client_request ON returns(branch_id, client_request_id) WHERE client_request_id IS NOT NULL AND client_request_id <> '';

-- بنود كل مرتجع
CREATE TABLE IF NOT EXISTS return_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  return_id INTEGER NOT NULL REFERENCES returns(id),
  sale_item_id INTEGER NOT NULL REFERENCES sale_items(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  quantity REAL NOT NULL,
  refund_amount REAL NOT NULL
);

-- بنود كل فاتورة
CREATE TABLE IF NOT EXISTS sale_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT UNIQUE NOT NULL,
  sale_id INTEGER NOT NULL REFERENCES sales(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  quantity REAL NOT NULL,
  unit_price REAL NOT NULL,
  tax_rate REAL DEFAULT 0,
  tax_profile_id INTEGER REFERENCES tax_profiles(id),
  tax_inclusive INTEGER NOT NULL DEFAULT 0,
  discount REAL DEFAULT 0,
  line_total REAL NOT NULL,
  notes TEXT, -- مثال: "بدون بصل" في المطاعم
  cost_at_sale REAL NOT NULL DEFAULT 0
);

-- سجل حركة المخزون (لكل دخول/خروج، مرتبط بسبب: بيع، شراء، تسوية)
CREATE TABLE IF NOT EXISTS inventory_movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT UNIQUE NOT NULL,
  branch_id INTEGER NOT NULL REFERENCES branches(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  change_qty REAL NOT NULL, -- موجب = إضافة، سالب = خصم
  reason TEXT NOT NULL,     -- sale | purchase | adjustment | transfer
  ref_id INTEGER,           -- id الفاتورة أو المرجع المرتبط
  notes TEXT,               -- ملاحظة حرة (سبب التسوية مثلاً)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  synced INTEGER NOT NULL DEFAULT 0
);

-- خصومات تجميعية (Bundle/Combo): مجموعة منتجات محددة، لو توفّرت كلها بالسلة
-- بالكمية المطلوبة، يُطبَّق خصم تلقائي (نسبة أو سعر ثابت للحزمة).
CREATE TABLE IF NOT EXISTS bundles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT UNIQUE NOT NULL,
  branch_id INTEGER NOT NULL REFERENCES branches(id),
  name TEXT NOT NULL,
  discount_type TEXT NOT NULL DEFAULT 'percent', -- percent | fixed_price
  discount_value REAL NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  synced INTEGER NOT NULL DEFAULT 0
);

-- منتجات كل حزمة والكمية المطلوبة من كل منتج
CREATE TABLE IF NOT EXISTS bundle_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bundle_id INTEGER NOT NULL REFERENCES bundles(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  quantity REAL NOT NULL DEFAULT 1
);
