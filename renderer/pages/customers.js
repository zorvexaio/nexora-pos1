let currentEditId = null;
let ledgerCustomer = null;

const branchNameEl = document.getElementById('branchName');
const searchInput = document.getElementById('searchInput');
const tableBody = document.getElementById('customersTableBody');
const emptyState = document.getElementById('emptyState');

const addCustomerBtn = document.getElementById('addCustomerBtn');
const modal = document.getElementById('customerModal');
const modalTitle = document.getElementById('modalTitle');
const customerForm = document.getElementById('customerForm');
const cancelBtn = document.getElementById('cancelBtn');

const fieldName = document.getElementById('fieldName');
const fieldPhone = document.getElementById('fieldPhone');
const fieldPoints = document.getElementById('fieldPoints');

async function init() {
  const user = await guardPage(['admin', 'manager'], '../login.html');
  if (!user) return;

  const branch = await window.api.branches.current();
  branchNameEl.textContent = branch ? branch.name : '';

  await loadCustomers();

  searchInput.addEventListener('input', debounce(loadCustomers, 250));
  addCustomerBtn.addEventListener('click', () => openModal());
  cancelBtn.addEventListener('click', closeModal);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeModal();
  });
  customerForm.addEventListener('submit', saveCustomer);
}

async function loadCustomers() {
  const customers = await window.api.customers.list({ search: searchInput.value.trim() });
  renderTable(customers);
}

function renderTable(customers) {
  tableBody.innerHTML = '';
  emptyState.style.display = customers.length === 0 ? 'block' : 'none';
  for (const c of customers) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(c.name || 'بدون اسم')}</td>
      <td>${escapeHtml(c.phone || '—')}</td>
      <td>${c.loyalty_points}</td>
      <td>${Number(c.balance || 0).toFixed(2)}</td>
      <td>${Number(c.store_credit_balance || 0) > 0 ? `<span class="status-badge tone-success">${Number(c.store_credit_balance).toFixed(2)}</span>` : Number(c.store_credit_balance || 0).toFixed(2)}</td>
      <td class="row-actions"><button class="btn btn-secondary btn-sm" data-action="ledger">كشف الحساب</button> <button class="btn btn-secondary btn-sm" data-action="edit">تعديل</button></td>
    `;
    tr.querySelector('[data-action="edit"]').addEventListener('click', () => openModal(c));
    tr.querySelector('[data-action="ledger"]').addEventListener('click', () => openLedger(c));
    tableBody.appendChild(tr);
  }
}

async function openLedger(customer) {
  ledgerCustomer = customer;
  document.getElementById('ledgerTitle').textContent = `${t('customers.statement', 'كشف حساب')}: ${customer.name || t('common.noName', 'بدون اسم')}`;
  const debt = Number(customer.balance || 0);
  const storeCredit = Number(customer.store_credit_balance || 0);
  document.getElementById('ledgerBalances').innerHTML = `
    <div class="kpi-row" style="margin-bottom:14px;">
      <div class="kpi-card" data-tone="${debt > 0 ? 'amber' : 'slate'}">
        <span class="kpi-icon"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2 2 21h20L12 2Z"/><path d="M12 9v5M12 17h.01"/></svg></span>
        <div class="kpi-body"><div class="kpi-label">الرصيد المستحق (دين)</div><div class="kpi-value">${debt.toFixed(2)}</div></div>
      </div>
      <div class="kpi-card" data-tone="${storeCredit > 0 ? 'indigo' : 'slate'}">
        <span class="kpi-icon"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v10M9 10a3 3 0 0 1 3-1.5c1.7 0 3 1 3 2.5s-1.3 2.5-3 2.5-3 1-3 2.5 1.3 2.5 3 2.5a3 3 0 0 0 3-1.5"/></svg></span>
        <div class="kpi-body"><div class="kpi-label">رصيد المتجر (له)</div><div class="kpi-value">${storeCredit.toFixed(2)}</div></div>
      </div>
    </div>
  `;
  const rows = await window.api.customers.ledger(customer.id);
  const host = document.getElementById('ledgerRows');
  host.innerHTML = rows.length ? rows.map((row) => `<div class="breakdown-row"><div class="breakdown-label"><span>${row.entry_type === 'credit_sale' ? t('customers.creditSale', 'بيع آجل') : t('customers.payment', 'تسديد')}</span><span>${new Date(row.created_at.replace(' ', 'T') + 'Z').toLocaleDateString('ar')}</span></div><div class="breakdown-label"><span>${Number(row.amount).toFixed(2)}</span><span>${ts('الرصيد')}: ${Number(row.balance_after).toFixed(2)}</span></div></div>`).join('') : '<div class="empty-state">لا توجد حركات.</div>';
  document.getElementById('ledgerModal').classList.remove('hidden');
}
document.getElementById('closeLedgerBtn').addEventListener('click', () => document.getElementById('ledgerModal').classList.add('hidden'));
document.getElementById('receivePaymentBtn').addEventListener('click', () => {
  if (!ledgerCustomer || !(Number(ledgerCustomer.balance) > 0)) return alert(ts('لا يوجد رصيد مستحق على هذا العميل.'));
  document.getElementById('debtPaymentAmount').value = Number(ledgerCustomer.balance).toFixed(2);
  document.getElementById('paymentModal').classList.remove('hidden');
});
document.getElementById('cancelDebtPaymentBtn').addEventListener('click', () => document.getElementById('paymentModal').classList.add('hidden'));
document.getElementById('debtPaymentForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const result = await window.api.customers.receivePayment({ customerId: ledgerCustomer.id, amount: parseLocaleNumber(document.getElementById('debtPaymentAmount').value), paymentMethod: document.getElementById('debtPaymentMethod').value, notes: document.getElementById('debtPaymentNotes').value.trim() });
    document.getElementById('paymentModal').classList.add('hidden');
    document.getElementById('ledgerModal').classList.add('hidden');
    await loadCustomers();
    if (result.cashMovementRecorded === false && document.getElementById('debtPaymentMethod').value === 'cash') alert('تم تسجيل التسديد، ولا توجد جلسة صندوق مفتوحة لإضافة حركة كاش.');
  } catch (error) { alert(ts('تعذر تسجيل التسديد: ') + error.message); }
});

function openModal(c = null) {
  currentEditId = c ? c.id : null;
  customerForm.reset();
  fieldPoints.value = 0;
  modalTitle.textContent = c ? 'تعديل عميل' : 'عميل جديد';
  if (c) {
    fieldName.value = c.name || '';
    fieldPhone.value = c.phone || '';
    fieldPoints.value = c.loyalty_points || 0;
  }
  modal.classList.remove('hidden');
  fieldName.focus();
}

function closeModal() {
  modal.classList.add('hidden');
  currentEditId = null;
}

async function saveCustomer(e) {
  e.preventDefault();
  const saveBtn = document.getElementById('saveBtn');
  saveBtn.disabled = true;
  saveBtn.textContent = 'جارٍ الحفظ...';
  try {
    const payload = {
      name: fieldName.value.trim() || null,
      phone: fieldPhone.value.trim() || null,
      loyaltyPoints: parseInt(fieldPoints.value, 10) || 0,
    };
    if (currentEditId) {
      payload.id = currentEditId;
      await window.api.customers.update(payload);
    } else {
      await window.api.customers.create(payload);
    }
    closeModal();
    await loadCustomers();
  } catch (err) {
    alert(ts('حدث خطأ أثناء الحفظ: ') + err.message);
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = 'حفظ';
  }
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
