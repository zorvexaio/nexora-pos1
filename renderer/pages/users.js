let currentEditId = null;
let loggedInUser = null;

const tableBody = document.getElementById('usersTableBody');
const emptyState = document.getElementById('emptyState');
const branchNameEl = document.getElementById('branchName');

const addUserBtn = document.getElementById('addUserBtn');
const modal = document.getElementById('userModal');
const modalTitle = document.getElementById('modalTitle');
const userForm = document.getElementById('userForm');
const cancelBtn = document.getElementById('cancelBtn');

const fieldFullName = document.getElementById('fieldFullName');
const fieldUsername = document.getElementById('fieldUsername');
const fieldRole = document.getElementById('fieldRole');
const fieldShiftType = document.getElementById('fieldShiftType');
const fieldPassword = document.getElementById('fieldPassword');
const fieldIsActive = document.getElementById('fieldIsActive');
const passwordLabel = document.getElementById('passwordLabel');

const pinModal = document.getElementById('pinModal');
const pinModalUserName = document.getElementById('pinModalUserName');
const fieldNewPin = document.getElementById('fieldNewPin');
const pinModalError = document.getElementById('pinModalError');
const cancelPinBtn = document.getElementById('cancelPinBtn');
const savePinBtn = document.getElementById('savePinBtn');
let pinModalUserId = null;

const ROLE_TABLE_LABELS = { admin: 'مدير عام', manager: 'مدير فرع', cashier: 'كاشير' };
const SHIFT_TYPE_LABELS = { morning: 'صباحية', evening: 'مسائية' };

async function init() {
  loggedInUser = await guardPage(['admin'], '../login.html');
  if (!loggedInUser) return;

  const branch = await window.api.branches.current();
  branchNameEl.textContent = branch ? branch.name : '';

  await loadUsers();

  addUserBtn.addEventListener('click', () => openModal());
  cancelBtn.addEventListener('click', closeModal);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeModal();
  });
  userForm.addEventListener('submit', saveUser);
  cancelPinBtn.addEventListener('click', closePinModal);
  savePinBtn.addEventListener('click', savePin);
  pinModal.addEventListener('click', (e) => {
    if (e.target === pinModal) closePinModal();
  });
}

async function loadUsers() {
  const users = await window.api.users.list();
  renderTable(users);
}

function renderTable(users) {
  tableBody.innerHTML = '';
  emptyState.style.display = users.length === 0 ? 'block' : 'none';

  for (const u of users) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(u.full_name)}${u.id === loggedInUser.id ? ' <span class="you-tag">(أنت)</span>' : ''}</td>
      <td>${escapeHtml(u.username)}</td>
      <td>${ROLE_TABLE_LABELS[u.role] || escapeHtml(u.role)}</td>
      <td>${SHIFT_TYPE_LABELS[u.shift_type] || SHIFT_TYPE_LABELS.morning}</td>
      <td>${u.is_active ? '<span class="status-active">مفعّل</span>' : '<span class="status-inactive">معطّل</span>'}</td>
      <td>${u.has_pin ? '<span class="status-active">مُعيَّن</span>' : '<span class="status-inactive">—</span>'}</td>
      <td class="sales-modify-cell">${salesModifyCell(u)}</td>
      <td class="row-actions">
        <button class="btn btn-secondary btn-sm" data-action="edit">تعديل</button>
        <button class="btn btn-secondary btn-sm" data-action="pin">${u.has_pin ? 'تغيير PIN' : 'تعيين PIN'}</button>
        ${u.has_pin ? '<button class="btn btn-secondary btn-sm" data-action="clearPin">مسح PIN</button>' : ''}
        ${u.id === loggedInUser.id ? '' : '<button class="btn btn-danger btn-sm" data-action="delete">حذف</button>'}
      </td>
    `;
    tr.querySelector('[data-sales-modify]')?.addEventListener('change', (e) => toggleSalesModify(u, e.target));
    tr.querySelector('[data-action="edit"]').addEventListener('click', () => openModal(u));
    tr.querySelector('[data-action="pin"]').addEventListener('click', () => openPinModal(u));
    tr.querySelector('[data-action="clearPin"]')?.addEventListener('click', () => clearPin(u));
    tr.querySelector('[data-action="delete"]')?.addEventListener('click', () => deleteUser(u));
    tableBody.appendChild(tr);
  }
}

// عمود "تعديل الفواتير": علامة صح يضعها المدير العام بجانب الكاشير، مع شرح لماذا/ماذا تسمح به، ومن منحها وسببها.
function salesModifyCell(u) {
  if (u.role === 'admin' || u.role === 'manager') return `<span class="status-active" title="${escAttr(ts('المدير يملك هذه الصلاحية بحكم دوره.'))}">${ts('بحكم الدور')}</span>`;
  const on = Number(u.can_modify_sales) === 1;
  const why = ts('لماذا؟ تسمح للكاشير بتعديل أصناف أو طريقة دفع فاتورة مكتملة (بدون ارتجاع). كل تعديل يُسجَّل باسمه في التدقيق ويتطلب سبباً.');
  const granted = on ? `<small class="field-hint">${escapeHtml(ts('منحها'))}: ${escapeHtml(u.modify_sales_granted_by_name || '—')} · ${escapeHtml(String(u.modify_sales_granted_at || '').slice(0, 16))}<br>${escapeHtml(ts('السبب'))}: ${escapeHtml(u.modify_sales_reason || '—')}</small>` : '';
  return `<label title="${escAttr(why)}" style="display:flex;gap:6px;align-items:center;cursor:pointer;"><input type="checkbox" data-sales-modify ${on ? 'checked' : ''} ${u.is_active ? '' : 'disabled'} /> <span>${ts('يسمح بتعديل الفواتير')}</span></label>${granted}`;
}
async function toggleSalesModify(u, checkbox) {
  const enable = checkbox.checked;
  try {
    let reason = '';
    if (enable) {
      reason = await promptDialog(ts('سبب السماح لهذا الكاشير بتعديل الفواتير (يُحفظ في سجل التدقيق):'), '', {});
      if (reason === null || String(reason).trim().length < 3) { checkbox.checked = false; if (reason !== null) showToast(ts('اكتب السبب (3 أحرف على الأقل).'), 'error'); return; }
    } else if (!(await confirmDialog(ts('سحب صلاحية تعديل الفواتير من هذا المستخدم؟'), { tone: 'warning' }))) {
      checkbox.checked = true;
      return;
    }
    await window.api.users.setSalesModify(u.id, enable, reason);
    showToast(enable ? ts('تم تفعيل تعديل الفواتير لهذا المستخدم.') : ts('تم سحب صلاحية تعديل الفواتير.'), 'success');
    await loadUsers();
  } catch (err) {
    checkbox.checked = !enable;
    showToast(err.message || ts('حدث خطأ أثناء الحفظ'), 'error');
  }
}

function openModal(user = null) {
  currentEditId = user ? user.id : null;
  userForm.reset();
  fieldIsActive.checked = true;

  if (user) {
    modalTitle.textContent = 'تعديل مستخدم';
    passwordLabel.textContent = 'كلمة مرور جديدة (اتركها فارغة لعدم التغيير)';
    fieldPassword.required = false;
    fieldFullName.value = user.full_name;
    fieldUsername.value = user.username;
    fieldRole.value = user.role;
    fieldShiftType.value = user.shift_type || 'morning';
    fieldIsActive.checked = !!user.is_active;
  } else {
    modalTitle.textContent = 'مستخدم جديد';
    passwordLabel.textContent = 'كلمة المرور *';
    fieldPassword.required = true;
    fieldShiftType.value = 'morning';
  }

  modal.classList.remove('hidden');
  fieldFullName.focus();
}

function closeModal() {
  modal.classList.add('hidden');
  currentEditId = null;
}

async function saveUser(e) {
  e.preventDefault();

  // تحذير عند تعديل حسابك أنت وتعطيله أو إنزال دوره عن admin (قد يقفل الوصول للإدارة)
  if (currentEditId === loggedInUser.id) {
    const losingAdmin = fieldRole.value !== 'admin' || !fieldIsActive.checked;
    if (losingAdmin && !(await confirmDialog(t('users.confirmRemoveAdminPrivilege', 'أنت توشك على إزالة صلاحية المدير العام عن حسابك الحالي أو تعطيله. هل تريد المتابعة؟'), { tone: 'warning' }))) {
      return;
    }
  }

  const saveBtn = document.getElementById('saveBtn');
  saveBtn.disabled = true;
  saveBtn.textContent = t('common.savingBusy', 'جارٍ الحفظ...');

  try {
    const payload = {
      fullName: fieldFullName.value.trim(),
      username: fieldUsername.value.trim(),
      role: fieldRole.value,
      isActive: fieldIsActive.checked,
    };
    if (fieldPassword.value) payload.password = fieldPassword.value;

    let result;
    if (currentEditId) {
      payload.id = currentEditId;
      result = await window.api.users.update(payload);
    } else {
      if (!fieldPassword.value) {
        showToast(ts('كلمة المرور مطلوبة للمستخدم الجديد'), 'error');
        return;
      }
      result = await window.api.users.create(payload);
    }

    if (result && result.success === false) {
      showToast(result.message || ts('حدث خطأ أثناء الحفظ'), 'error');
      return;
    }

    const savedUserId = currentEditId || result.id;
    if (savedUserId) await window.api.users.setShiftType(savedUserId, fieldShiftType.value);

    closeModal();
    await loadUsers();
  } catch (err) {
    showToast(ts('حدث خطأ أثناء الحفظ: ') + err.message, 'error');
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = t('common.save', 'حفظ');
  }
}

function openPinModal(user) {
  pinModalUserId = user.id;
  pinModalUserName.textContent = user.full_name;
  fieldNewPin.value = '';
  pinModalError.classList.add('hidden');
  pinModal.classList.remove('hidden');
  fieldNewPin.focus();
}

function closePinModal() {
  pinModal.classList.add('hidden');
  pinModalUserId = null;
}

async function savePin() {
  pinModalError.classList.add('hidden');
  savePinBtn.disabled = true;
  savePinBtn.textContent = t('common.savingBusy', 'جارٍ الحفظ...');
  try {
    const result = await window.api.users.setPin(pinModalUserId, normalizeDigits(fieldNewPin.value.trim()));
    if (!result.success) {
      pinModalError.textContent = result.message || ts('تعذّر حفظ الـ PIN');
      pinModalError.classList.remove('hidden');
      return;
    }
    closePinModal();
    await loadUsers();
  } catch (err) {
    pinModalError.textContent = ts('حدث خطأ: ') + err.message;
    pinModalError.classList.remove('hidden');
  } finally {
    savePinBtn.disabled = false;
    savePinBtn.textContent = t('common.save', 'حفظ');
  }
}

async function clearPin(user) {
  if (!(await confirmDialog(`${t('users.clearPinFor','مسح رقم PIN الخاص بـ')} "${user.full_name}"؟ ${t('users.clearPinWarning','لن يعود يقدر يدخل بالـ PIN بعدها.')}`, { tone: 'danger', confirmLabel: t('common.delete','حذف') }))) return;
  await window.api.users.clearPin(user.id);
  await loadUsers();
}

// حذف مستخدم: يُحذف نهائياً إن لم يكن مرتبطاً بأي سجلات سابقة (مبيعات/ورديات/رواتب...)،
// وإلا يُعطَّل حسابه تلقائياً (لا يعود يقدر يسجّل دخول) مع إبقاء سجلاته القديمة سليمة —
// نعرض له بوضوح أي الحالتين حدثت فعلاً بدل الافتراض الصامت.
async function deleteUser(user) {
  if (!(await confirmDialog(tf('users.confirmDeleteUser', { name: user.full_name }), { tone: 'danger', confirmLabel: t('common.delete','حذف') }))) return;
  try {
    const result = await window.api.users.delete(user.id);
    if (!result?.success) {
      showToast(result?.message || ts('تعذر حذف المستخدم'), 'error');
      return;
    }
    if (!result.hardDeleted && result.deactivatedInstead) {
      await infoDialog(tf('users.deactivatedInsteadOfDeleted', { name: user.full_name }));
    }
    await loadUsers();
  } catch (err) {
    showToast(ts('حدث خطأ أثناء الحذف: ') + err.message, 'error');
  }
}

init();
