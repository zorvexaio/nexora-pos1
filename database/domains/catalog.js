'use strict';
/** Auto-extracted domain module — refactor batch 3–5. Do not call until h.db is initialized. */
module.exports = function createDomain(h) {
  const money = h.money;
  const accounting = h.accounting;
  const crypto = h.crypto;
  const path = h.path;
  const fs = h.fs;
  const app = h.app;
  const parseGs1 = h.parseGs1;
  const parseWeightedBarcode = h.parseWeightedBarcode;
  const buildWeightedBarcode = h.buildWeightedBarcode;
  const MAX_LINE_QUANTITY = h.MAX_LINE_QUANTITY;

/* ---------------- الفئات ---------------- */
function listCategories() {
  return h.db.prepare('SELECT * FROM categories ORDER BY sort_order ASC, name ASC').all();
}

// تحريك فئة خطوة واحدة لأعلى/أسفل بترتيب العرض بشاشة الكاشير — للمحلات اللي عندها
// عدد كبير من الفئات لكن أغلب مبيعاتها من قليل منها (مثال: شاورما وفروج أهم من
// فئات نادرة الطلب)، فيتقدر صاحب المحل يرتّبها حسب أولوية استخدامها الفعلي.
function moveCategoryOrder(categoryId, direction) {
  const all = h.db.prepare('SELECT id, sort_order FROM categories ORDER BY sort_order ASC, name ASC').all();
  const idx = all.findIndex((c) => c.id === Number(categoryId));
  if (idx === -1) throw new Error('الفئة غير موجودة.');
  const swapWith = direction === 'up' ? idx - 1 : idx + 1;
  if (swapWith < 0 || swapWith >= all.length) return { success: true }; // بالفعل في الطرف، لا شيء يتغيّر
  const a = all[idx], b = all[swapWith];
  const tx = h.db.transaction(() => {
    h.db.prepare('UPDATE categories SET sort_order=? WHERE id=?').run(b.sort_order, a.id);
    h.db.prepare('UPDATE categories SET sort_order=? WHERE id=?').run(a.sort_order, b.id);
    // لو الفئتان بنفس sort_order (حالة شائعة لأن القيمة الافتراضية 0 لكل الفئات القديمة)
    // فالتبديل وحده لا يكفي — نُعيد ترقيم الكل بالترتيب الحالي مرة واحدة لضمان تفرّد القيم.
    if (a.sort_order === b.sort_order) {
      const ordered = [...all];
      [ordered[idx], ordered[swapWith]] = [ordered[swapWith], ordered[idx]];
      ordered.forEach((c, i) => h.db.prepare('UPDATE categories SET sort_order=? WHERE id=?').run(i, c.id));
    }
  });
  tx();
  return { success: true };
}

function createCategory(c) {
  const name = String(c?.name || '').trim();
  if (!name) throw new Error('اسم الفئة مطلوب.');
  const parentId = c?.parentId == null || c.parentId === '' ? null : Number(c.parentId);
  if (parentId !== null && (!Number.isInteger(parentId) || parentId <= 0)) throw new Error('الفئة الأب غير صالحة.');
  const info = h.db.prepare(`INSERT INTO categories (uuid, name, parent_id) VALUES (?, ?, ?)`).run(h.uuid(), name, parentId);
  return { id: info.lastInsertRowid };
}

function setCategoryImage(categoryId, imagePath) {
  const category = h.db.prepare('SELECT id FROM categories WHERE id=?').get(Number(categoryId));
  if (!category) throw new Error('الفئة غير موجودة.');
  h.db.prepare('UPDATE categories SET image_path=? WHERE id=?').run(imagePath || null, Number(categoryId));
  return { success: true };
}

// إخفاء/إظهار تبويب فئة معيّنة من شاشة الكاشير — الفئة ومنتجاتها تبقيان موجودتين
// تماماً كما هما (تظهر منتجاتها تحت "الكل")، فقط التبويب السريع يختفي من الشريط.
function setCategoryPosHidden(categoryId, hidden) {
  const category = h.db.prepare('SELECT id FROM categories WHERE id=?').get(Number(categoryId));
  if (!category) throw new Error('الفئة غير موجودة.');
  h.db.prepare('UPDATE categories SET pos_hidden=? WHERE id=?').run(hidden ? 1 : 0, Number(categoryId));
  return { success: true, hidden: !!hidden };
}

function getOrCreateCategoryByName(name) {
  if (!name) return null;
  const trimmed = String(name).trim();
  if (!trimmed) return null;
  const existing = h.db.prepare('SELECT id FROM categories WHERE name = ?').get(trimmed);
  if (existing) return existing.id;
  return createCategory({ name: trimmed }).id;
}

// استيراد دفعة منتجات دفعة واحدة (من ملف CSV) — لسهولة إضافة بضاعة السوبرماركت/الأزياء بدون إدخال يدوي.
// كل صف: { name, barcode, category, price, cost, quantity, minQuantity, unit }
// إن وُجد barcode مطابق لمنتج موجود: يُحدَّث الاسم/السعر/التكلفة، وتُضاف الكمية المستوردة كوارد جديد للمخزون.
// إن لم يوجد: يُنشأ منتج جديد بالكمية المستوردة كرصيد ابتدائي.
const bulkImportProductsTx = h.db.transaction((rows) => {
  const branch = h.getCurrentBranch();
  // products is a shared catalog. Barcode/name matching is intentionally global;
  // branch-specific stock is updated separately in inventory.
  const findByBarcode = h.db.prepare(`
    SELECT id FROM products
    WHERE barcode = ? AND barcode IS NOT NULL AND barcode != ''
    ORDER BY id LIMIT 1
  `);
  const findByName = h.db.prepare(`
    SELECT id FROM products
    WHERE name = ? AND is_active = 1
    ORDER BY id LIMIT 1
  `);
  const updateExisting = h.db.prepare(
    `UPDATE products SET name=@name, price=@price, cost=@cost, category_id=@category_id, unit=@unit WHERE id=@id`
  );
  const addStock = h.db.prepare(
    `UPDATE inventory SET quantity = quantity + ?, min_quantity = COALESCE(?, min_quantity), updated_at = datetime('now'), synced = 0
     WHERE branch_id = ? AND product_id = ?`
  );
  const createBranchInventory = h.db.prepare(
    `INSERT INTO inventory (branch_id, product_id, quantity, min_quantity, unit_cost) VALUES (?, ?, ?, ?, ?)`
  );
  const logMovement = h.db.prepare(
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
          createBranchInventory.run(branch.id, existing.id, quantity, minQuantity || 0, cost);
        }
        if (quantity !== 0) logMovement.run(h.uuid(), branch.id, existing.id, quantity);
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
        if (quantity !== 0) logMovement.run(h.uuid(), branch.id, created.id, quantity);
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
  const branch = h.getCurrentBranch();
  const search = String(filters.search || '').trim();
  // شاشات إدارية معيّنة (اختيار أصناف عرض/حزمة، اختيار صنف بفاتورة شراء) تحتاج
  // الكتالوج كاملاً بقائمة منسدلة واحدة بلا بحث تدريجي — filters.all يتجاوز سقف
  // الـ250/500 المعتاد (المصمَّم لشبكة الكاشير الحيّة) لهذه الحالات فقط.
  const limit = filters.all ? 100000 : Math.max(1, Math.min(Number(filters.limit) || (search ? 80 : 250), 500));

  let sql = `
    SELECT p.*, COALESCE(i.quantity, 0) AS stock,
           tp.rate AS tax_profile_rate,
           tp.is_inclusive AS tax_profile_inclusive,
           (SELECT COUNT(*) FROM products v WHERE v.parent_product_id = p.id AND v.is_active = 1) AS variant_count
    FROM products p
    LEFT JOIN inventory i ON i.product_id = p.id AND i.branch_id = ?
    LEFT JOIN tax_profiles tp ON tp.id = p.tax_profile_id AND tp.branch_id = ? AND tp.is_active = 1
    WHERE p.is_active = 1`;
  const params = [branch.id, branch.id];

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
  if (filters.quickCashierOnly) {
    // شاشة الكاشير السريع تعرض فقط الأصناف التي اختارها المدير صراحةً (حرية كاملة
    // بالشاشة بدل ظهور كل منتجات المحل مكدّسة فوق بعضها).
    sql += ` AND p.quick_cashier_visible = 1`;
  }
  sql += ' ORDER BY CASE WHEN p.barcode = ? THEN 0 WHEN p.sku = ? THEN 1 ELSE 2 END, p.name LIMIT ?';
  params.push(search, search, limit);
  return h.db.prepare(sql).all(...params);
}

// متغيرات منتج أساسي (المقاسات/الألوان المرتبطة به) مع كمية كل واحد في المخزون
function listProductVariants(parentId) {
  const branch = h.getCurrentBranch();
  return h.db
    .prepare(
      `SELECT p.*, COALESCE(i.quantity, 0) AS stock,
              tp.rate AS tax_profile_rate,
              tp.is_inclusive AS tax_profile_inclusive,
              tp.code AS tax_profile_code
       FROM products p
       LEFT JOIN inventory i ON i.product_id = p.id AND i.branch_id = ?
       LEFT JOIN tax_profiles tp ON tp.id = p.tax_profile_id AND tp.branch_id = ? AND tp.is_active = 1
       WHERE p.parent_product_id = ? AND p.is_active = 1
       ORDER BY p.variant_size, p.variant_color`
    )
    .all(branch.id, branch.id, parentId);
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
  return h.db.prepare(sql).all(...params);
}

function getProduct(id) {
  const branch = h.getCurrentBranch();
  return h.db
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
  const branch = h.getCurrentBranch();
  return h.db
    .prepare(
      `SELECT p.*, COALESCE(i.quantity, 0) AS stock, i.min_quantity,
              tp.rate AS tax_profile_rate,
              tp.is_inclusive AS tax_profile_inclusive,
              tp.code AS tax_profile_code
       FROM products p
       LEFT JOIN inventory i ON i.product_id = p.id AND i.branch_id = ?
       LEFT JOIN tax_profiles tp ON tp.id = p.tax_profile_id AND tp.branch_id = ? AND tp.is_active = 1
       WHERE p.plu_code = ? AND p.is_weighted = 1 AND p.is_active = 1`
    )
    .get(branch.id, branch.id, pluCode);
}

// نقطة الدخول الوحيدة من الواجهة عند مسح أي باركود بشاشة الكاشير: يحاول فك الباركود كباركود
// وزن (بادئة قابلة للتهيئة من الإعدادات)، ويعيد المنتج المطابق + الوزن المقروء جاهزَين للإضافة
// المباشرة للسلة دون أي إدخال يدوي من الكاشير. يُرجع null إن لم يكن باركود وزن أو لم يوجد الصنف.
function resolveGs1Barcode(barcode) {
  const parsed = parseGs1(barcode);
  if (!parsed) return null;
  const branch = h.getCurrentBranch();
  const gtin14 = parsed.gtin;
  const gtin13 = gtin14.slice(1);
  const product = h.db.prepare(`SELECT p.*, COALESCE(i.quantity,0) AS stock, i.min_quantity,
      tp.rate AS tax_profile_rate,
      tp.is_inclusive AS tax_profile_inclusive,
      tp.code AS tax_profile_code
    FROM products p LEFT JOIN inventory i ON i.product_id=p.id AND i.branch_id=?
    LEFT JOIN tax_profiles tp ON tp.id=p.tax_profile_id AND tp.branch_id=? AND tp.is_active=1
    WHERE p.is_active=1 AND (p.barcode=? OR p.barcode=?) LIMIT 1`).get(branch.id, branch.id, gtin14, gtin13);
  return product ? { product, ...parsed } : { product: null, ...parsed };
}

function resolveWeightedBarcode(barcode) {
  const prefix = h.getSetting('weighted_barcode_prefix', '20');
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
    const row = h.db.prepare('SELECT id FROM products WHERE sku = ? AND (? IS NULL OR id != ?) LIMIT 1').get(cleanSku, excludeId, excludeId);
    if (row) throw new Error(`رمز SKU مستخدم بالفعل: ${cleanSku}`);
  }
  if (cleanBarcode) {
    const row = h.db.prepare('SELECT id FROM products WHERE barcode = ? AND (? IS NULL OR id != ?) LIMIT 1').get(cleanBarcode, excludeId, excludeId);
    if (row) throw new Error(`الباركود مستخدم بالفعل: ${cleanBarcode}`);
  }
  if (cleanPlu) {
    const row = h.db.prepare('SELECT id FROM products WHERE plu_code = ? AND (? IS NULL OR id != ?) LIMIT 1').get(cleanPlu, excludeId, excludeId);
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
  const info = h.db.transaction(() => {
    const result = h.db.prepare(
      `INSERT INTO products (uuid, sku, barcode, name, category_id, price, cost, tax_rate, unit, track_inventory, image_path, variant_size, variant_color, parent_product_id, is_recipe, is_weighted, plu_code, quick_cashier_visible)
       VALUES (@uuid, @sku, @barcode, @name, @category_id, @price, @cost, @tax_rate, @unit, @track_inventory, @image_path, @variant_size, @variant_color, @parent_product_id, @is_recipe, @is_weighted, @plu_code, @quick_cashier_visible)`
    ).run({
      uuid: h.uuid(),
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
      quick_cashier_visible: p.quickCashierVisible ? 1 : 0,
    });
    const branch = h.getCurrentBranch();
    h.db.prepare(`INSERT INTO inventory (branch_id, product_id, quantity, min_quantity, unit_cost) VALUES (?, ?, ?, ?, ?)`)
      .run(branch.id, result.lastInsertRowid, initialStock, minQuantity, cost);
    if (initialStock > 0 && cost > 0 && (p.trackInventory !== false)) {
      const openingValueMinor = money.toMinor(initialStock * cost, Number(h.getGlobalProfile()?.currency_minor_unit ?? 2));
      if (openingValueMinor > 0) {
        h.insertPostedJournalEntry({
          branchId: branch.id,
          memo: `مخزون افتتاحي: ${name}`,
          referenceType: 'inventory_opening_balance',
          referenceId: result.lastInsertRowid,
          lines: [
            { accountId: h.getAccountingAccountId(branch.id, '1300'), debitMinor: openingValueMinor, creditMinor: 0 },
            { accountId: h.getAccountingAccountId(branch.id, '3000'), debitMinor: 0, creditMinor: openingValueMinor },
          ],
        });
      }
    }
    return result;
  })();
  return { id: info.lastInsertRowid };
}

const updateProductTx = h.db.transaction((p) => {
  const branch = h.getCurrentBranch();
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

  const existingProduct = h.db.prepare('SELECT id FROM products WHERE id = ? AND is_active = 1').get(productId);
  if (!existingProduct) throw new Error('المنتج غير موجود أو غير نشط.');

  const branchInventory = h.db.prepare('SELECT id, quantity, unit_cost, min_quantity FROM inventory WHERE branch_id = ? AND product_id = ?').get(branch.id, productId);
  const beforeQuantity = Number(branchInventory?.quantity || 0);

  h.db.prepare(
    `UPDATE products SET name=@name, price=@price, cost=@cost, tax_rate=@tax_rate,
      barcode=@barcode, sku=@sku, category_id=@category_id, unit=@unit,
      track_inventory=@track_inventory, image_path=@image_path,
      variant_size=@variant_size, variant_color=@variant_color, is_recipe=@is_recipe,
      parent_product_id=@parent_product_id, is_weighted=@is_weighted, plu_code=@plu_code,
      quick_cashier_visible=@quick_cashier_visible,
      updated_at=datetime('now'), synced=0
     WHERE id=@id`
  ).run({
    id: productId, name, price, cost, tax_rate: taxRate, barcode: identifiers.barcode, sku: identifiers.sku,
    category_id: p.categoryId || null, unit: String(p.unit || 'piece').trim() || 'piece',
    track_inventory: p.trackInventory === false ? 0 : 1, image_path: p.imagePath || null,
    variant_size: p.variantSize || null, variant_color: p.variantColor || null, is_recipe: p.isRecipe ? 1 : 0,
    parent_product_id: p.parentProductId || null, is_weighted: p.isWeighted ? 1 : 0, plu_code: identifiers.pluCode,
    quick_cashier_visible: p.quickCashierVisible ? 1 : 0,
  });

  if (stock !== undefined || minQuantity !== undefined) {
    if (branchInventory) {
      const sets = []; const params = {};
      if (stock !== undefined) { sets.push('quantity=@stock'); params.stock = stock; }
      if (minQuantity !== undefined) { sets.push('min_quantity=@minQuantity'); params.minQuantity = minQuantity; }
      params.id = branchInventory.id;
      h.db.prepare(`UPDATE inventory SET ${sets.join(', ')}, updated_at=datetime('now'), synced=0 WHERE id=@id`).run(params);
    } else {
      h.db.prepare(`INSERT INTO inventory (branch_id, product_id, quantity, min_quantity, unit_cost) VALUES (?, ?, ?, ?, ?)`)
        .run(branch.id, productId, stock ?? 0, minQuantity ?? 0, cost);
    }
    if (stock !== undefined && Math.abs(stock - beforeQuantity) > 0.000001) {
      const unitCost = Number(h.db.prepare('SELECT COALESCE(unit_cost, cost, 0) AS unit_cost FROM inventory JOIN products ON products.id = inventory.product_id WHERE inventory.branch_id=? AND inventory.product_id=?').get(branch.id, productId)?.unit_cost || 0);
      h.db.prepare(`INSERT INTO inventory_movements (uuid, branch_id, product_id, change_qty, reason, ref_id, notes, unit_cost_after, synced) VALUES (?, ?, ?, ?, 'adjustment', NULL, ?, ?, 0)`)
        .run(h.uuid(), branch.id, productId, stock - beforeQuantity, 'تعديل كمية من بطاقة المنتج', unitCost);
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
  h.db.prepare(`UPDATE products SET is_active = 0, updated_at = datetime('now'), synced = 0 WHERE id = ?`).run(productId);
  return { success: true };
}

/* ---------------- الحزم/الخصومات التجميعية (Bundles) ---------------- */
function listBundles() {
  const branch = h.getCurrentBranch();
  const bundles = h.db
    .prepare(`SELECT * FROM bundles WHERE branch_id = ? ORDER BY id DESC`)
    .all(branch.id);
  const itemsStmt = h.db.prepare(
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

const saveBundleItemsTx = h.db.transaction((bundleId, items) => {
  h.db.prepare(`DELETE FROM bundle_items WHERE bundle_id = ?`).run(bundleId);
  const insert = h.db.prepare(`INSERT INTO bundle_items (bundle_id, product_id, quantity) VALUES (?, ?, ?)`);
  for (const it of items) {
    if (!it.productId || !(it.quantity > 0)) continue;
    if (it.quantity > MAX_LINE_QUANTITY) throw new Error(`الكمية المطلوبة تتجاوز الحد الأقصى المسموح (${MAX_LINE_QUANTITY}).`);
    insert.run(bundleId, it.productId, it.quantity);
  }
});

function createBundle(b) {
  const branch = h.getCurrentBranch();
  const info = h.db
    .prepare(
      `INSERT INTO bundles (uuid, branch_id, name, discount_type, discount_value, is_active)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(h.uuid(), branch.id, b.name, b.discountType || 'percent', b.discountValue || 0, b.isActive === false ? 0 : 1);
  saveBundleItemsTx(info.lastInsertRowid, b.items || []);
  return { success: true, id: info.lastInsertRowid };
}

function updateBundle(b) {
  const branch = h.getCurrentBranch();
  const target = h.db.prepare('SELECT id FROM bundles WHERE id = ? AND branch_id = ?').get(Number(b.id), branch.id);
  if (!target) throw new Error('الحزمة غير موجودة في الفرع الحالي.');
  h.db.prepare(
    `UPDATE bundles SET name = ?, discount_type = ?, discount_value = ?, is_active = ?, updated_at = datetime('now'), synced = 0
     WHERE id = ? AND branch_id = ?`
  ).run(b.name, b.discountType || 'percent', b.discountValue || 0, b.isActive === false ? 0 : 1, target.id, branch.id);
  if (b.items) saveBundleItemsTx(target.id, b.items);
  return { success: true };
}

function deleteBundle(id) {
  const branch = h.getCurrentBranch();
  const target = h.db.prepare('SELECT id FROM bundles WHERE id = ? AND branch_id = ?').get(Number(id), branch.id);
  if (!target) throw new Error('الحزمة غير موجودة في الفرع الحالي.');
  h.db.prepare(`DELETE FROM bundle_items WHERE bundle_id = ?`).run(target.id);
  h.db.prepare(`DELETE FROM bundles WHERE id = ? AND branch_id = ?`).run(target.id, branch.id);
  return { success: true };
}


  return {
    listCategories,
    moveCategoryOrder,
    createCategory,
    setCategoryImage,
    setCategoryPosHidden,
    getOrCreateCategoryByName,
    bulkImportProducts,
    parseProductsCsv,
    listProducts,
    listProductVariants,
    listVariantParentOptions,
    getProduct,
    getProductByPlu,
    resolveGs1Barcode,
    resolveWeightedBarcode,
    assertUniqueProductIdentifiers,
    parseNonNegativeNumber,
    createProduct,
    updateProduct,
    deleteProduct,
    listBundles,
    listActiveBundles,
    createBundle,
    updateBundle,
    deleteBundle
  };
};
