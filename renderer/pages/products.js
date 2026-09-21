let categories = [];
let currentEditId = null;
let pickedImageUrl = null; // مسار file:// للصورة المختارة حديثاً (قبل الحفظ)

const branchNameEl = document.getElementById('branchName');
const searchInput = document.getElementById('searchInput');
const categoryFilter = document.getElementById('categoryFilter');
const tableBody = document.getElementById('productsTableBody');
const emptyState = document.getElementById('emptyState');

const addProductBtn = document.getElementById('addProductBtn');
const modal = document.getElementById('productModal');
const modalTitle = document.getElementById('modalTitle');
const productForm = document.getElementById('productForm');
const cancelBtn = document.getElementById('cancelBtn');

const fieldName = document.getElementById('fieldName');
const fieldCategory = document.getElementById('fieldCategory');
const fieldNewCategory = document.getElementById('fieldNewCategory');
const fieldPrice = document.getElementById('fieldPrice');
const fieldCost = document.getElementById('fieldCost');
const fieldTax = document.getElementById('fieldTax');
const fieldUnit = document.getElementById('fieldUnit');
const fieldBarcode = document.getElementById('fieldBarcode');
const fieldSku = document.getElementById('fieldSku');
const fieldTrackInventory = document.getElementById('fieldTrackInventory');
const stockModeTabs = document.getElementById('stockModeTabs');
const fieldIsWeighted = document.getElementById('fieldIsWeighted');
const fieldPluCode = document.getElementById('fieldPluCode');
const pluField = document.getElementById('pluField');
const fieldStock = document.getElementById('fieldStock');
const fieldMinQty = document.getElementById('fieldMinQty');
const fieldVariantSize = document.getElementById('fieldVariantSize');
const fieldVariantColor = document.getElementById('fieldVariantColor');
const fieldParentProduct = document.getElementById('fieldParentProduct');
const fieldIsRecipe = document.getElementById('fieldIsRecipe');
const stockField = document.getElementById('stockField');
const minQtyField = document.getElementById('minQtyField');
const imagePreview = document.getElementById('imagePreview');
const pickImageBtn = document.getElementById('pickImageBtn');
const advancedToggle = document.getElementById('advancedToggle');
const advancedFields = document.getElementById('advancedFields');

const PLACEHOLDER_IMG =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#f0f0f0"/><text x="32" y="38" font-size="24" text-anchor="middle" fill="#c1c5cb">🛒</text></svg>`
  );

async function init() {
  const user = await guardPage(['admin', 'manager'], '../login.html');
  if (!user) return;

  const branch = await window.api.branches.current();
  branchNameEl.textContent = branch ? branch.name : '';

  await loadCategories();
  await loadProducts();

  searchInput.addEventListener('input', debounce(loadProducts, 250));
  categoryFilter.addEventListener('change', loadProducts);
  addProductBtn.addEventListener('click', () => openModal());
  document.getElementById('downloadTemplateBtn').addEventListener('click', downloadCsvTemplate);
  document.getElementById('importCsvBtn').addEventListener('click', importFromCsv);
  cancelBtn.addEventListener('click', closeModal);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeModal();
  });
  productForm.addEventListener('submit', saveProduct);
  pickImageBtn.addEventListener('click', pickImage);
  fieldTrackInventory.addEventListener('change', toggleStockFields);
  stockModeTabs.querySelectorAll('.login-mode-tab').forEach((btn) => {
    btn.addEventListener('click', () => setStockMode(btn.dataset.mode === 'tracked'));
  });
  fieldIsWeighted.addEventListener('change', toggleWeightedField);
  // نطبّع الأصفار البادئة أثناء الكتابة مباشرة حتى يشوف المستخدم فوراً شكل الكود الفعلي
  // اللي رح يُحفظ (مطابقاً لصيغة باركود الميزان)، بدل ما يتفاجأ لاحقاً وقت المسح.
  fieldPluCode.addEventListener('blur', () => {
    const digits = normalizeDigits(fieldPluCode.value).replace(/\D/g, '').slice(0, 5);
    fieldPluCode.value = digits ? digits.padStart(5, '0') : '';
  });
  advancedToggle.addEventListener('click', toggleAdvanced);
}

async function loadCategories() {
  categories = await window.api.categories.list();
  const optionsHtml = categories.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
  categoryFilter.innerHTML = '<option value="">كل الفئات</option>' + optionsHtml;
  fieldCategory.innerHTML = '<option value="">بدون فئة</option>' + optionsHtml;
}

async function loadProducts() {
  const products = await window.api.products.list({
    search: searchInput.value.trim(),
    categoryId: categoryFilter.value || undefined,
  });
  renderTable(products);
}

function renderTable(products) {
  tableBody.innerHTML = '';
  emptyState.style.display = products.length === 0 ? 'block' : 'none';

  let lowStockCount = 0;
  let noBarcodeCount = 0;
  for (const p of products) {
    const category = categories.find((c) => c.id === p.category_id);
    const lowStock = p.track_inventory && p.stock <= (p.min_quantity || 0);
    if (lowStock) lowStockCount += 1;
    if (!p.barcode && !p.is_weighted) noBarcodeCount += 1;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><img class="thumb" src="${escapeHtml(p.image_path || PLACEHOLDER_IMG)}" alt="" /></td>
      <td>${escapeHtml(p.name)}${p.variant_count ? ` <span class="variant-badge">${p.variant_count} ${ts('متغيّر')}</span>` : ''}</td>
      <td>${category ? escapeHtml(category.name) : '—'}</td>
      <td>${p.price.toFixed(2)}</td>
      <td class="stock ${lowStock ? 'low' : ''}">${p.track_inventory ? p.stock : '—'}${lowStock ? ' <span class="status-badge tone-warning">منخفض</span>' : ''}</td>
      <td>${p.barcode ? escapeHtml(p.barcode) : (p.is_weighted ? `<span class="status-badge tone-slate">PLU ${escapeHtml(p.plu_code || '')}</span>` : '—')}</td>
      <td class="row-actions">
        <button class="btn btn-secondary btn-sm" data-action="edit">تعديل</button>
        <button class="btn btn-danger btn-sm" data-action="delete">حذف</button>
      </td>
    `;
    tr.querySelector('[data-action="edit"]').addEventListener('click', () => openModal(p.id));
    tr.querySelector('[data-action="delete"]').addEventListener('click', () => deleteProduct(p.id, p.name));
    tableBody.appendChild(tr);
  }

  const kpiProductCount = document.getElementById('kpiProductCount');
  const kpiNoBarcode = document.getElementById('kpiNoBarcode');
  const kpiProductsLowStock = document.getElementById('kpiProductsLowStock');
  if (kpiProductCount) kpiProductCount.textContent = products.length.toLocaleString('en-US');
  if (kpiNoBarcode) kpiNoBarcode.textContent = noBarcodeCount.toLocaleString('en-US');
  if (kpiProductsLowStock) kpiProductsLowStock.textContent = lowStockCount.toLocaleString('en-US');
}

async function openModal(productId = null) {
  currentEditId = productId;
  pickedImageUrl = null;
  productForm.reset();
  advancedFields.classList.remove('open');
  advancedToggle.textContent = '+ خيارات متقدمة (أزياء / مطاعم)';
  imagePreview.src = PLACEHOLDER_IMG;
  fieldTrackInventory.checked = true;
  setStockMode(true);
  fieldIsWeighted.checked = false;
  toggleStockFields();
  toggleWeightedField();

  const parentOptions = await window.api.products.variantParents(productId || undefined);
  fieldParentProduct.innerHTML =
    '<option value="">— منتج مستقل (غير مرتبط) —</option>' +
    parentOptions.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');

  if (productId) {
    modalTitle.textContent = t('products.edit','تعديل منتج');
    const p = await window.api.products.get(productId);
    fieldName.value = p.name;
    fieldCategory.value = p.category_id || '';
    fieldPrice.value = p.price;
    fieldCost.value = p.cost || '';
    fieldTax.value = p.tax_rate || '';
    fieldUnit.value = p.unit || 'piece';
    fieldBarcode.value = p.barcode || '';
    fieldSku.value = p.sku || '';
    fieldTrackInventory.checked = !!p.track_inventory;
    setStockMode(!!p.track_inventory);
    fieldIsWeighted.checked = !!p.is_weighted;
    fieldPluCode.value = p.plu_code || '';
    toggleWeightedField();
    fieldStock.value = p.stock ?? '';
    fieldMinQty.value = p.min_quantity ?? '';
    fieldVariantSize.value = p.variant_size || '';
    fieldVariantColor.value = p.variant_color || '';
    fieldParentProduct.value = p.parent_product_id || '';
    fieldIsRecipe.checked = !!p.is_recipe;
    if (p.image_path) {
      imagePreview.src = p.image_path;
      pickedImageUrl = p.image_path;
    }
    toggleStockFields();
    if (p.variant_size || p.variant_color || p.is_recipe || p.parent_product_id) toggleAdvanced();
  } else {
    modalTitle.textContent = 'منتج جديد';
    try { fieldTax.value = (await window.api.tax.defaultRate()).defaultTaxRate || ''; }
    catch (err) { console.error('تعذّر جلب نسبة الضريبة الافتراضية', err); }
  }

  modal.classList.remove('hidden');
  fieldName.focus();
}

function closeModal() {
  modal.classList.add('hidden');
  currentEditId = null;
}

function setStockMode(isTracked) {
  fieldTrackInventory.checked = isTracked;
  stockModeTabs.querySelectorAll('.login-mode-tab').forEach((btn) => {
    btn.classList.toggle('active', (btn.dataset.mode === 'tracked') === isTracked);
  });
  toggleStockFields();
}

function toggleStockFields() {
  const show = fieldTrackInventory.checked;
  stockField.style.display = show ? '' : 'none';
  minQtyField.style.display = show ? '' : 'none';
}

function toggleWeightedField() {
  pluField.hidden = !fieldIsWeighted.checked;
  if (fieldIsWeighted.checked) {
    fieldUnit.value = 'kg'; // البيع بالوزن يفترض وحدة الكيلوغرام دائماً
  }
}

function toggleAdvanced() {
  const open = advancedFields.classList.toggle('open');
  advancedToggle.textContent = open ? `− ${t('products.hideAdvanced','إخفاء الخيارات المتقدمة')}` : `+ ${t('products.showAdvanced','خيارات متقدمة (أزياء / مطاعم)')}`;
}

async function pickImage() {
  const result = await window.api.dialog.selectImage();
  if (!result) return;
  pickedImageUrl = result.url;
  imagePreview.src = result.url;
}

async function saveProduct(e) {
  e.preventDefault();
  const saveBtn = document.getElementById('saveBtn');
  saveBtn.disabled = true;
  saveBtn.textContent = 'جارٍ الحفظ...';

  try {
    let categoryId = fieldCategory.value || null;

    // إن كتب المستخدم اسم فئة جديدة، ننشئها أولاً
    const newCatName = fieldNewCategory.value.trim();
    if (newCatName) {
      const created = await window.api.categories.create({ name: newCatName });
      categoryId = created.id;
      await loadCategories();
    }

    if (fieldIsWeighted.checked && !fieldPluCode.value.trim()) {
      showToast(t('products.weightPluHint','أدخل كود الصنف (PLU) لمنتج البيع بالوزن — هو نفس الكود الذي تُدخله بميزان المحل لهذا الصنف.'), 'error');
      saveBtn.disabled = false;
      saveBtn.textContent = t('common.save', 'حفظ');
      return;
    }

    const payload = {
      name: fieldName.value.trim(),
      categoryId: categoryId || null,
      price: parseLocaleNumber(fieldPrice.value) || 0,
      cost: parseLocaleNumber(fieldCost.value) || 0,
      taxRate: parseLocaleNumber(fieldTax.value) || 0,
      unit: fieldUnit.value,
      barcode: fieldBarcode.value.trim() || null,
      sku: fieldSku.value.trim() || null,
      trackInventory: fieldTrackInventory.checked,
      imagePath: pickedImageUrl,
      variantSize: fieldVariantSize.value.trim() || null,
      variantColor: fieldVariantColor.value.trim() || null,
      parentProductId: fieldParentProduct.value ? parseInt(fieldParentProduct.value, 10) : null,
      isRecipe: fieldIsRecipe.checked,
      isWeighted: fieldIsWeighted.checked,
      pluCode: fieldIsWeighted.checked ? fieldPluCode.value.trim() : null,
    };

    if (currentEditId) {
      payload.id = currentEditId;
      payload.stock = fieldTrackInventory.checked ? parseLocaleNumber(fieldStock.value) || 0 : undefined;
      payload.minQuantity = fieldTrackInventory.checked ? parseLocaleNumber(fieldMinQty.value) || 0 : undefined;
      await window.api.products.update(payload);
    } else {
      payload.initialStock = parseLocaleNumber(fieldStock.value) || 0;
      payload.minQuantity = parseLocaleNumber(fieldMinQty.value) || 0;
      await window.api.products.create(payload);
    }

    closeModal();
    await loadProducts();
  } catch (err) {
    showToast(ts('حدث خطأ أثناء الحفظ: ') + err.message, 'error');
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = t('common.save', 'حفظ');
  }
}

async function deleteProduct(id, name) {
  if (!(await confirmDialog(`${t('products.confirmDeletePrefix', 'هل تريد حذف')} "${name}"${t('products.confirmDeleteSuffix', '؟ (سيتم إخفاؤه فقط، وتبقى فواتيره السابقة كما هي)')}`, { tone: 'danger', confirmLabel: t('common.delete','حذف') }))) return;
  await window.api.products.delete(id);
  await loadProducts();
}

async function downloadCsvTemplate() {
  const result = await window.api.products.downloadCsvTemplate();
  if (result && result.path) {
    await infoDialog(`${t('products.formSaved','تم حفظ النموذج')}: ${result.path}`);
  }
}

async function importFromCsv() {
  const box = document.getElementById('importResultBox');
  const result = await window.api.products.importCsv();
  if (!result) return; // المستخدم ألغى اختيار الملف

  box.style.display = 'block';
  const parts = [];
  parts.push(`<strong>${ts('تم الاستيراد')}:</strong> ${result.created} ${ts('منتج جديد،')} ${result.updated} ${ts('منتج مُحدَّث (تمت إضافة الكمية لمخزونه).')}`);
  if (result.errors && result.errors.length) {
    parts.push(`<div style="color:#dc2626;margin-top:6px">${ts('أخطاء')} (${result.errors.length}):</div>`);
    parts.push(
      '<ul style="margin:4px 0 0 0;padding-inline-start:18px;color:#dc2626">' +
        result.errors.slice(0, 20).map((e) => `<li>${ts('صف')} ${e.row}: ${escapeHtml(e.message)}</li>`).join('') +
        '</ul>'
    );
  }
  box.innerHTML = parts.join('');
  await loadProducts();
}

init();
