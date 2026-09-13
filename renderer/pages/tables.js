let loggedInUser = null;

const branchNameEl = document.getElementById('branchName');
const tablesGrid = document.getElementById('tablesGrid');
const emptyState = document.getElementById('emptyState');
const addTableBtn = document.getElementById('addTableBtn');
const addTableModal = document.getElementById('addTableModal');
const addTableForm = document.getElementById('addTableForm');
const fieldTableName = document.getElementById('fieldTableName');
const fieldTableSeats = document.getElementById('fieldTableSeats');
const cancelAddTableBtn = document.getElementById('cancelAddTableBtn');
const mergeTablesBtn = document.getElementById('mergeTablesBtn');
const mergeTablesModal = document.getElementById('mergeTablesModal');
const mergeSourceTable = document.getElementById('mergeSourceTable');
const mergeTargetTable = document.getElementById('mergeTargetTable');
let latestTables = [];

async function init() {
  loggedInUser = await guardPage(null, '../login.html');
  if (!loggedInUser) return;

  const branch = await window.api.branches.current();
  branchNameEl.textContent = branch ? branch.name : '';

  await loadTables();

  const canManage = ['admin', 'manager'].includes(loggedInUser.role);
  addTableBtn.classList.toggle('hidden', !canManage);
  mergeTablesBtn.classList.toggle('hidden', !canManage);

  addTableBtn.addEventListener('click', () => addTableModal.classList.remove('hidden'));
  cancelAddTableBtn.addEventListener('click', () => addTableModal.classList.add('hidden'));
  addTableModal.addEventListener('click', (e) => {
    if (e.target === addTableModal) addTableModal.classList.add('hidden');
  });
  addTableForm.addEventListener('submit', saveTable);
  mergeTablesBtn.addEventListener('click', openMergeModal);
  document.getElementById('cancelMergeTablesBtn').addEventListener('click', () => mergeTablesModal.classList.add('hidden'));
  document.getElementById('confirmMergeTablesBtn').addEventListener('click', mergeSelectedTables);

  // تحديث دوري خفيف — أهم استخدام له هو ظهور "طلب الحساب" القادم من جهاز الكرسون
  // خلال ثوانٍ بلا حاجة الكاشير لتحديث الصفحة يدوياً كل مرة.
  setInterval(() => { if (!document.hidden) loadTables(); }, 8000);
}

async function loadTables() {
  const grid = document.getElementById('tablesGrid');
  grid.setAttribute('aria-busy', 'true');
  if (!grid.children.length) setPageLoading(grid, true, 'جارٍ تحميل الطاولات...');
  try {
    const tables = await window.api.tables.list();
    latestTables = tables;
    renderTables(tables);
  } catch (err) {
    latestTables = [];
    renderPageEmptyState(grid, { icon: '!', title: 'تعذر تحميل الطاولات', message: err.message || 'حدث خطأ غير متوقع.', actionText: 'إعادة المحاولة', onAction: loadTables });
    showToast(t('tables.toast.loadFailed') + (err.message || err), 'error');
  } finally {
    grid.setAttribute('aria-busy', 'false');
  }
}

function openMergeModal() {
  const occupied = latestTables.filter(t => t.occupied);
  if (!occupied.length) { showToast(t('tables.toast.noOccupiedTable'), 'info'); return; }
  mergeSourceTable.innerHTML = occupied.map(row => `<option value="${row.id}">${escapeHtml(row.name)} — ${window.t ? window.t('tables.occupiedPrefix', 'مشغولة') : 'مشغولة'} — ${row.openTotal.toFixed(2)}</option>`).join('');
  mergeTargetTable.innerHTML = latestTables.map(t => `<option value="${t.id}">${escapeHtml(t.name)}${t.occupied ? ' ' + ts('(مشغولة)') : ''}</option>`).join('');
  const alternative = latestTables.find(t => t.id !== occupied[0].id);
  if (!alternative) { showToast(t('tables.toast.addSecondTableFirst'), 'info'); return; }
  mergeTargetTable.value = String(alternative.id);
  mergeTablesModal.classList.remove('hidden');
}

async function mergeSelectedTables() {
  const source = Number(mergeSourceTable.value), target = Number(mergeTargetTable.value);
  if (source === target) { showToast(t('tables.toast.selectDifferentTarget'), 'info'); return; }
  if (!confirm(ts('سيتم نقل كل الأصناف إلى الطاولة الهدف. متابعة؟'))) return;
  try {
    await window.api.tables.merge(source, target);
    mergeTablesModal.classList.add('hidden');
    await loadTables();
  } catch (err) { showToast(t('tables.toast.mergeFailed') + err.message, 'error'); }
}

function renderTables(tables) {
  tablesGrid.innerHTML = '';
  emptyState.style.display = tables.length === 0 ? 'block' : 'none';
  if (tables.length === 0) {
    renderPageEmptyState(emptyState, { icon: '◫', title: 'لا توجد طاولات بعد', message: 'أضف أول طاولة لتبدأ إدارة الطلبات داخل المحل.', actionText: 'إضافة أول طاولة', onAction: () => addTableBtn.click() });
    mergeTablesBtn.classList.add('hidden');
    return;
  }

  for (const t of tables) {
    const card = document.createElement('div');
    card.className = `table-card ${t.occupied ? 'occupied' : 'free'} ${t.billRequested ? 'bill-requested' : ''}`;
    card.innerHTML = `
      ${t.billRequested ? `<div class="bill-request-badge">🔔 ${ts('طلب الحساب')} <button data-action="ackBill" class="ack-bill-btn">${ts('تم')}</button></div>` : ''}
      <div class="table-name">${escapeHtml(t.name)}</div>
      <div class="table-seats">${t.seats} ${ts('مقاعد')}</div>
      <div class="table-status">${t.occupied ? `${ts('مشغولة')} — ${t.openTotal.toFixed(2)}` : ts('متاحة')}</div>
      ${
        !t.occupied && (loggedInUser.role === 'admin' || loggedInUser.role === 'manager')
          ? `<button class="table-delete" data-action="delete" title="${window.t ? window.t('tables.deleteTitle', 'حذف الطاولة') : 'حذف الطاولة'}">✕</button>`
          : ''
      }
      ${
        t.occupied && (loggedInUser.role === 'admin' || loggedInUser.role === 'manager')
          ? `<button class="table-release" data-action="release" title="${window.t ? window.t('tables.releaseTitle', 'تحرير الطاولة إن كانت عالقة بدون أصناف') : 'تحرير الطاولة إن كانت عالقة بدون أصناف'}">${window.t ? window.t('tables.release', 'تحرير') : 'تحرير'}</button>`
          : ''
      }
    `;
    card.addEventListener('click', (e) => {
      if (e.target.dataset.action === 'delete' || e.target.dataset.action === 'release' || e.target.dataset.action === 'ackBill') return; // الأزرار تتعامل بمفردها
      window.location.href = `table-order.html?tableId=${t.id}`;
    });
    const ackBtn = card.querySelector('[data-action="ackBill"]');
    if (ackBtn) {
      ackBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (t.openSaleId) await window.api.tables.acknowledgeBill(t.openSaleId);
        loadTables();
      });
    }
    const deleteBtn = card.querySelector('[data-action="delete"]');
    if (deleteBtn) {
      deleteBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm(`${window.t ? window.t('tables.confirmDeletePrefix','حذف') : 'حذف'} "${t.name}"؟`)) return;
        const result = await window.api.tables.delete(t.id);
        if (result && result.success === false) {
          showToast(result.message, 'error');
          return;
        }
        await loadTables();
      });
    }
    const releaseBtn = card.querySelector('[data-action="release"]');
    if (releaseBtn) {
      releaseBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
          const result = await window.api.tables.release(t.id);
          if (result && result.success === false) { showToast(result.message, 'error'); return; }
          if (result && result.released) showToast(window.t ? window.t('tables.releaseDone', 'تم تحرير الطاولة.') : 'تم تحرير الطاولة.', 'success');
          await loadTables();
        } catch (err) { showToast(t('tables.toast.releaseFailed') + err.message, 'error'); }
      });
    }
    tablesGrid.appendChild(card);
  }
}

async function saveTable(e) {
  e.preventDefault();
  await window.api.tables.create({
    name: fieldTableName.value.trim(),
    seats: Math.floor(parseLocaleNumber(fieldTableSeats.value)) || 4,
  });
  addTableModal.classList.add('hidden');
  addTableForm.reset();
  fieldTableSeats.value = 4;
  await loadTables();
}

init();
