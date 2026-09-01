let currentItems = [];

const branchNameEl = document.getElementById('branchName');
const searchInput = document.getElementById('searchInput');
const lowOnlyCheckbox = document.getElementById('lowOnlyCheckbox');
const tableBody = document.getElementById('inventoryTableBody');
const emptyState = document.getElementById('emptyState');

const tabStockBtn = document.getElementById('tabStockBtn');
const tabMovementsBtn = document.getElementById('tabMovementsBtn');
const stockTab = document.getElementById('stockTab');
const movementsTab = document.getElementById('movementsTab');
const movementsTableBody = document.getElementById('movementsTableBody');
const movementsEmptyState = document.getElementById('movementsEmptyState');

const adjustModal = document.getElementById('adjustModal');
const adjustForm = document.getElementById('adjustForm');
const adjustProductId = document.getElementById('adjustProductId');
const adjustCurrentQty = document.getElementById('adjustCurrentQty');
const adjustDirection = document.getElementById('adjustDirection');
const adjustValue = document.getElementById('adjustValue');
const adjustReason = document.getElementById('adjustReason');
const adjustNotes = document.getElementById('adjustNotes');
const cancelAdjustBtn = document.getElementById('cancelAdjustBtn');

const REASON_LABELS = {
  sale: 'بيع',
  adjustment: 'تسوية / جرد',
  purchase: 'شراء بضاعة جديدة',
  damage: 'تالف / منتهي الصلاحية',
  transfer: 'تحويل بين فروع',
};

async function init() {
  const user = await guardPage(['admin', 'manager'], '../login.html');
  if (!user) return;

  const branch = await window.api.branches.current();
  branchNameEl.textContent = branch ? branch.name : '';

  await loadInventory();

  searchInput.addEventListener('input', debounce(loadInventory, 250));
  lowOnlyCheckbox.addEventListener('change', loadInventory);
  tabStockBtn.addEventListener('click', () => switchTab('stock'));
  tabMovementsBtn.addEventListener('click', () => switchTab('movements'));

  adjustForm.addEventListener('submit', saveAdjustment);
  cancelAdjustBtn.addEventListener('click', closeAdjustModal);
  adjustModal.addEventListener('click', (e) => {
    if (e.target === adjustModal) closeAdjustModal();
  });
}

function switchTab(tab) {
  const isStock = tab === 'stock';
  tabStockBtn.classList.toggle('active', isStock);
  tabMovementsBtn.classList.toggle('active', !isStock);
  stockTab.style.display = isStock ? '' : 'none';
  movementsTab.style.display = isStock ? 'none' : '';
  if (!isStock) loadMovements();
}

async function loadInventory() {
  currentItems = await window.api.inventory.list({
    search: searchInput.value.trim(),
    lowOnly: lowOnlyCheckbox.checked,
  });
  renderTable();
}

function renderTable() {
  tableBody.innerHTML = '';
  emptyState.style.display = currentItems.length === 0 ? 'block' : 'none';

  let lowCount = 0;
  let stockValue = 0;
  for (const item of currentItems) {
    const low = item.stock <= item.min_quantity;
    if (low) lowCount += 1;
    stockValue += Number(item.stock || 0) * Number(item.cost || 0);
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(item.name)}</td>
      <td>${item.category_name ? escapeHtml(item.category_name) : '—'}</td>
      <td>${escapeHtml(item.unit || 'piece')}</td>
      <td class="stock ${low ? 'low' : ''}">${item.stock}${low ? ' <span class="status-badge tone-warning">منخفض</span>' : ''}</td>
      <td>${item.min_quantity}</td>
      <td class="row-actions">
        <button class="btn btn-secondary btn-sm" data-action="adjust">تسوية</button>
      </td>
    `;
    tr.querySelector('[data-action="adjust"]').addEventListener('click', () => openAdjustModal(item));
    tableBody.appendChild(tr);
  }

  const kpiTotalItems = document.getElementById('kpiTotalItems');
  const kpiLowStock = document.getElementById('kpiLowStock');
  const kpiStockValue = document.getElementById('kpiStockValue');
  if (kpiTotalItems) kpiTotalItems.textContent = currentItems.length.toLocaleString('en-US');
  if (kpiLowStock) kpiLowStock.textContent = lowCount.toLocaleString('en-US');
  if (kpiStockValue) kpiStockValue.textContent = stockValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function loadMovements() {
  const movements = await window.api.inventory.movements({});
  movementsEmptyState.style.display = movements.length === 0 ? 'block' : 'none';
  movementsTableBody.innerHTML = '';
  for (const m of movements) {
    const tr = document.createElement('tr');
    const sign = m.change_qty > 0 ? '+' : '';
    tr.innerHTML = `
      <td>${formatDate(m.created_at)}</td>
      <td>${escapeHtml(m.product_name)}</td>
      <td class="${m.change_qty > 0 ? 'stock' : 'stock low'}">${sign}${m.change_qty}</td>
      <td>${REASON_LABELS[m.reason] || escapeHtml(m.reason)}</td>
      <td>${m.notes ? escapeHtml(m.notes) : '—'}</td>
    `;
    movementsTableBody.appendChild(tr);
  }
}

function openAdjustModal(item) {
  adjustProductId.value = item.id;
  adjustCurrentQty.textContent = `${item.stock} ${item.unit || ''}`;
  adjustDirection.value = 'add';
  adjustValue.value = '';
  adjustReason.value = 'adjustment';
  adjustNotes.value = '';
  adjustModal.classList.remove('hidden');
  adjustValue.focus();
}

function closeAdjustModal() {
  adjustModal.classList.add('hidden');
}

async function saveAdjustment(e) {
  e.preventDefault();
  const saveBtn = document.getElementById('saveAdjustBtn');
  saveBtn.disabled = true;
  saveBtn.textContent = 'جارٍ الحفظ...';

  try {
    const productId = parseInt(adjustProductId.value, 10);
    const item = currentItems.find((i) => i.id === productId);
    const value = parseFloat(adjustValue.value) || 0;

    let changeQty = 0;
    if (adjustDirection.value === 'add') changeQty = value;
    else if (adjustDirection.value === 'remove') changeQty = -value;
    else if (adjustDirection.value === 'set') changeQty = value - (item ? item.stock : 0);

    await window.api.inventory.adjust({
      productId,
      changeQty,
      reason: adjustReason.value,
      notes: adjustNotes.value.trim() || null,
    });

    closeAdjustModal();
    await loadInventory();
  } catch (err) {
    alert(ts('حدث خطأ أثناء حفظ التسوية: ') + err.message);
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = 'حفظ';
  }
}

function formatDate(str) {
  const d = new Date(str.replace(' ', 'T') + 'Z');
  return d.toLocaleString('ar-EG', { dateStyle: 'short', timeStyle: 'short' });
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

init();
