let bundles = [];
let products = [];
let currentEditId = null;
let currentItems = []; // { productId, productName, quantity } — عناصر الحزمة قيد التحرير بالنافذة

const branchNameEl = document.getElementById('branchName');
const tableBody = document.getElementById('bundlesTableBody');
const emptyState = document.getElementById('emptyState');

const addBundleBtn = document.getElementById('addBundleBtn');
const modal = document.getElementById('bundleModal');
const modalTitle = document.getElementById('modalTitle');
const bundleForm = document.getElementById('bundleForm');
const cancelBtn = document.getElementById('cancelBtn');

const fieldName = document.getElementById('fieldName');
const fieldDiscountType = document.getElementById('fieldDiscountType');
const fieldDiscountValue = document.getElementById('fieldDiscountValue');
const discountValueLabel = document.getElementById('discountValueLabel');
const fieldIsActive = document.getElementById('fieldIsActive');

const itemProductSelect = document.getElementById('itemProductSelect');
const itemQuantityInput = document.getElementById('itemQuantityInput');
const addItemBtn = document.getElementById('addItemBtn');
const bundleItemsBody = document.getElementById('bundleItemsBody');
const bundleItemsEmpty = document.getElementById('bundleItemsEmpty');

async function init() {
  const user = await guardPage(['admin', 'manager'], '../login.html');
  if (!user) return;

  const branch = await window.api.branches.current();
  branchNameEl.textContent = branch ? branch.name : '';

  products = await window.api.products.list({});
  itemProductSelect.innerHTML = products.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');

  await loadBundles();

  addBundleBtn.addEventListener('click', () => openModal());
  cancelBtn.addEventListener('click', closeModal);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeModal();
  });
  bundleForm.addEventListener('submit', saveBundle);
  addItemBtn.addEventListener('click', addItemToBundle);
  fieldDiscountType.addEventListener('change', updateDiscountValueLabel);
}

async function loadBundles() {
  bundles = await window.api.bundles.list();
  renderTable();
}

function renderTable() {
  tableBody.innerHTML = '';
  emptyState.style.display = bundles.length === 0 ? 'block' : 'none';

  for (const b of bundles) {
    const tr = document.createElement('tr');
    const itemsSummary = b.items.map((i) => `${escapeHtml(i.product_name)} ×${i.quantity}`).join('، ');
    const discountLabel =
      b.discount_type === 'fixed_price' ? `${t('bundles.fixedPrice','سعر ثابت')}: ${b.discount_value.toFixed(2)}` : `${b.discount_value}%`;
    tr.innerHTML = `
      <td>${escapeHtml(b.name)}</td>
      <td>${itemsSummary || '—'}</td>
      <td>${discountLabel}</td>
      <td>${b.is_active ? '<span class="status-active">فعّالة</span>' : '<span class="status-inactive">متوقفة</span>'}</td>
      <td class="actions"></td>
    `;
    const actionsCell = tr.querySelector('.actions');

    const editBtn = document.createElement('button');
    editBtn.className = 'btn btn-secondary btn-sm';
    editBtn.textContent = 'تعديل';
    editBtn.addEventListener('click', () => openModal(b));
    actionsCell.appendChild(editBtn);

    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'btn btn-secondary btn-sm';
    toggleBtn.textContent = b.is_active ? 'إيقاف' : 'تفعيل';
    toggleBtn.addEventListener('click', () => toggleActive(b));
    actionsCell.appendChild(toggleBtn);

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'btn btn-danger btn-sm';
    deleteBtn.textContent = t('common.delete', 'حذف');
    deleteBtn.addEventListener('click', () => removeBundle(b));
    actionsCell.appendChild(deleteBtn);

    tableBody.appendChild(tr);
  }
}

async function toggleActive(b) {
  await window.api.bundles.update({ ...bundleToPayload(b), isActive: !b.is_active });
  await loadBundles();
}

async function removeBundle(b) {
  if (!confirm(`${t('bundles.confirmDeletePrefix', 'حذف حزمة')} "${b.name}"؟`)) return;
  await window.api.bundles.delete(b.id);
  await loadBundles();
}

function bundleToPayload(b) {
  return {
    id: b.id,
    name: b.name,
    discountType: b.discount_type,
    discountValue: b.discount_value,
    isActive: b.is_active,
    items: b.items.map((i) => ({ productId: i.product_id, quantity: i.quantity })),
  };
}

function openModal(bundle) {
  currentEditId = bundle ? bundle.id : null;
  modalTitle.textContent = bundle ? 'تعديل حزمة' : 'حزمة جديدة';
  fieldName.value = bundle ? bundle.name : '';
  fieldDiscountType.value = bundle ? bundle.discount_type : 'percent';
  fieldDiscountValue.value = bundle ? bundle.discount_value : '';
  fieldIsActive.checked = bundle ? !!bundle.is_active : true;
  currentItems = bundle ? bundle.items.map((i) => ({ productId: i.product_id, productName: i.product_name, quantity: i.quantity })) : [];
  updateDiscountValueLabel();
  renderItemsTable();
  modal.classList.remove('hidden');
}

function closeModal() {
  modal.classList.add('hidden');
  currentEditId = null;
  currentItems = [];
}

function updateDiscountValueLabel() {
  discountValueLabel.textContent = fieldDiscountType.value === 'fixed_price' ? t('bundles.fixedPriceLabel','السعر الثابت للحزمة') : t('bundles.discountValue','قيمة الخصم %');
}

function addItemToBundle() {
  const productId = parseInt(itemProductSelect.value, 10);
  const quantity = parseFloat(itemQuantityInput.value) || 0;
  if (!productId || quantity <= 0) return;

  const product = products.find((p) => p.id === productId);
  const existing = currentItems.find((i) => i.productId === productId);
  if (existing) {
    existing.quantity = quantity; // تحديث الكمية لو المنتج مضاف مسبقاً بدل تكراره
  } else {
    currentItems.push({ productId, productName: product ? product.name : '', quantity });
  }
  itemQuantityInput.value = 1;
  renderItemsTable();
}

function renderItemsTable() {
  bundleItemsBody.innerHTML = '';
  bundleItemsEmpty.style.display = currentItems.length === 0 ? 'block' : 'none';
  for (const item of currentItems) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(item.productName)}</td>
      <td>${item.quantity}</td>
      <td></td>
    `;
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'btn btn-danger btn-sm';
    removeBtn.textContent = 'إزالة';
    removeBtn.addEventListener('click', () => {
      currentItems = currentItems.filter((i) => i.productId !== item.productId);
      renderItemsTable();
    });
    tr.lastElementChild.appendChild(removeBtn);
    bundleItemsBody.appendChild(tr);
  }
}

async function saveBundle(e) {
  e.preventDefault();
  // القيد القديم كان يمنع أي حزمة إلا إذا فيها منتجان مختلفان على الأقل — وهذا كان يمنع
  // أكثر عرض شائع فعلياً: "3 قطع من نفس المنتج بسعر ثابت/خصم" (منتج واحد بكمية أكبر من 1).
  // الشرط الصحيح: منتج واحد على الأقل، وإذا كان منتجاً واحداً فقط لازم كميته أكبر من 1
  // (وإلا الخصم على قطعة وحدة مالوش معنى "تجميعي" — يُعدَّل سعر المنتج مباشرة بدل حزمة).
  if (currentItems.length === 0) {
    alert(ts('أضف منتجاً واحداً على الأقل للحزمة.'));
    return;
  }
  if (currentItems.length === 1 && Number(currentItems[0].quantity) <= 1) {
    alert(ts('لعرض منتج واحد فقط، يجب أن تكون الكمية المطلوبة أكبر من 1 (مثال: 3 قطع بسعر خاص). لخصم على قطعة واحدة، عدّل سعر المنتج مباشرة بدل إنشاء حزمة.'));
    return;
  }

  const payload = {
    id: currentEditId || undefined,
    name: fieldName.value.trim(),
    discountType: fieldDiscountType.value,
    discountValue: parseFloat(fieldDiscountValue.value) || 0,
    isActive: fieldIsActive.checked,
    items: currentItems.map((i) => ({ productId: i.productId, quantity: i.quantity })),
  };

  if (currentEditId) {
    await window.api.bundles.update(payload);
  } else {
    await window.api.bundles.create(payload);
  }

  closeModal();
  await loadBundles();
}

init();
