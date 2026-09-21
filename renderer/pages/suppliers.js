let suppliers = []; let products = []; let purchaseItems = []; let editingSupplier = null; let currentBranch = null; let payingSupplier = null;
const $ = (id) => document.getElementById(id);
async function init() {
  const user = await guardPage(['admin', 'manager'], '../login.html'); if (!user) return;
  currentBranch = await window.api.branches.current(); $('branchName').textContent = currentBranch?.name || '';
  $('addSupplierBtn').addEventListener('click', () => openSupplier()); $('cancelSupplierBtn').addEventListener('click', () => $('supplierModal').classList.add('hidden'));
  $('supplierForm').addEventListener('submit', saveSupplier); $('addPurchaseBtn').addEventListener('click', openPurchase); $('cancelPurchaseBtn').addEventListener('click', () => $('purchaseModal').classList.add('hidden'));
  $('cancelSupplierPaymentBtn').addEventListener('click', () => $('supplierPaymentModal').classList.add('hidden')); $('supplierPaymentForm').addEventListener('submit', saveSupplierPayment);
  $('addPurchaseItemBtn').addEventListener('click', addPurchaseItem); $('purchaseForm').addEventListener('submit', savePurchase); await refresh();
  $('purchasePaymentMethod').addEventListener('change', updatePurchasePaymentFields);
  initExpenseUi();
  $('quickAddProductBtn').addEventListener('click', () => {
    $('quickAddProductError').classList.add('hidden');
    $('quickAddProductName').value = ''; $('quickAddProductPrice').value = '0';
    $('quickAddProductRow').classList.remove('hidden');
    $('quickAddProductName').focus();
  });
  $('quickAddProductCancelBtn').addEventListener('click', () => $('quickAddProductRow').classList.add('hidden'));
  $('quickAddProductSaveBtn').addEventListener('click', async () => {
    const name = $('quickAddProductName').value.trim();
    const errorEl = $('quickAddProductError');
    errorEl.classList.add('hidden');
    if (!name) { errorEl.textContent = 'اكتب اسم المنتج.'; errorEl.classList.remove('hidden'); return; }
    const price = parseLocaleNumber($('quickAddProductPrice').value) || 0;
    const btn = $('quickAddProductSaveBtn');
    btn.disabled = true;
    try {
      // منتج بسيط يُنشأ من داخل شاشة الشراء مباشرة (بدون فئة/باركود) — يقدر المدير
      // يكمّل بياناته لاحقاً من شاشة "المنتجات" (فئة، باركود، حد أدنى...الخ).
      const created = await window.api.products.create({ name, price, cost: 0 });
      products = await window.api.products.list({});
      $('purchaseProduct').innerHTML = products.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
      $('purchaseProduct').value = String(created.id);
      $('quickAddProductRow').classList.add('hidden');
    } catch (error) {
      errorEl.textContent = ts('تعذّر إنشاء المنتج: ') + error.message;
      errorEl.classList.remove('hidden');
    } finally {
      btn.disabled = false;
    }
  });
}
async function refresh() { [suppliers, products] = await Promise.all([window.api.suppliers.list(), window.api.products.list({})]); const purchases = await window.api.purchases.list(); renderSuppliers(); renderPurchases(purchases); renderSupplierKpis(purchases); }
async function loadExpenseKpi() {
  try {
    const summary = await window.api.expenses.summary({});
    $('kpiMonthExpenses').textContent = Number(summary.total || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  } catch (_) { /* KPI اختياري */ }
}
function renderSupplierKpis(purchases) {
  loadExpenseKpi();
  const totalDue = suppliers.reduce((sum, s) => sum + Number(s.balance || 0), 0);
  const draftCount = purchases.filter((p) => p.status === 'draft').length;
  $('kpiSupplierCount').textContent = suppliers.length.toLocaleString('en-US');
  $('kpiSupplierDue').textContent = totalDue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  $('kpiDraftPurchases').textContent = draftCount.toLocaleString('en-US');
}
function renderSuppliers() {
  $('suppliersBody').innerHTML = suppliers.map((s) => `<tr><td>${esc(s.name)}</td><td>${esc(s.phone || '—')}</td><td>${Number(s.balance).toFixed(2)}</td><td>
    <button class="btn btn-secondary btn-sm" data-action="edit" data-id="${s.id}">تعديل</button>
    ${Number(s.balance) > 0 ? `<button class="btn btn-primary btn-sm" data-action="pay" data-id="${s.id}">دفع</button>` : ''}
  </td></tr>`).join('');
  $('suppliersBody').querySelectorAll('[data-action="edit"]').forEach((b) => b.addEventListener('click', () => openSupplier(suppliers.find((s) => s.id === Number(b.dataset.id)))));
  $('suppliersBody').querySelectorAll('[data-action="pay"]').forEach((b) => b.addEventListener('click', () => openSupplierPayment(suppliers.find((s) => s.id === Number(b.dataset.id)))));
}
function openSupplierPayment(s) {
  payingSupplier = s;
  $('supplierPaymentForm').reset();
  $('supplierPaymentTitle').textContent = `دفع للمورد: ${s.name}`;
  $('supplierPaymentBalance').textContent = Number(s.balance).toFixed(2);
  $('supplierPaymentAmount').max = String(s.balance);
  $('supplierPaymentAmount').value = Number(s.balance).toFixed(2);
  $('supplierPaymentModal').classList.remove('hidden');
}
async function saveSupplierPayment(e) {
  e.preventDefault();
  const saveBtn = e.target.querySelector('button.btn-primary');
  saveBtn.disabled = true;
  try {
    const result = await window.api.suppliers.payDebt({
      supplierId: payingSupplier.id,
      amount: parseLocaleNumber($('supplierPaymentAmount').value),
      paymentMethod: $('supplierPaymentMethod').value,
      notes: $('supplierPaymentNotes').value.trim(),
    });
    $('supplierPaymentModal').classList.add('hidden');
    await refresh();
    if (result.cashMovementRecorded === false && $('supplierPaymentMethod').value === 'cash') showToast(ts('تم تسجيل الدفعة، ولا توجد جلسة صندوق مفتوحة لإضافة حركة كاش.'), 'info');
  } catch (error) {
    showToast(ts('تعذّر تسجيل الدفعة: ') + error.message, 'error');
  } finally {
    saveBtn.disabled = false;
  }
}
// فواتير الفروع الأخرى تصل عبر المزامنة وتظهر هون للاطّلاع فقط (اسم الفرع يوضّح ذلك) — زر
// "استلام" يظهر فقط لفاتورة فرعك الحالي، لأن الاستلام يُحرّك مخزون هذا الجهاز تحديداً.
function renderPurchases(items) { $('purchasesBody').innerHTML = items.map((p) => { const isOwnBranch = !currentBranch || p.branch_id === currentBranch.id; const branchTag = !isOwnBranch ? ` <span class="role-badge">${esc(p.branch_name || '')}</span>` : ''; const statusBadge = p.status === 'received' ? `<span class="status-badge tone-success">${ts(p.invoice_type === 'expense' ? 'مسجّلة' : 'مستلمة')}</span>` : `<span class="status-badge tone-warning">${ts('مسودة')}</span>`; const paid = Number(p.paid_amount || 0); const due = Math.max(0, Number(p.total || 0) - paid); const isExpense = p.invoice_type === 'expense'; const typeCell = isExpense ? `<span class="status-badge tone-info">${ts('مصروف')}</span> ${esc(ts(p.expense_category_name || ''))}` : `<span class="status-badge">${ts('بضاعة')}</span>`; return `<tr><td>${esc(p.supplier_name)}${branchTag}</td><td title="${esc([p.invoice_date, p.reference_number].filter(Boolean).join(' · '))}">${typeCell}</td><td>${Number(p.total).toFixed(2)}</td><td>${paid.toFixed(2)} / ${due.toFixed(2)}</td><td>${statusBadge}</td><td>${p.status === 'draft' && isOwnBranch ? `<button class="btn btn-primary btn-sm" data-id="${p.id}">${ts('استلام')}</button>` : ''}</td></tr>`; }).join(''); $('purchasesBody').querySelectorAll('button').forEach((b) => b.addEventListener('click', async () => { if (await confirmDialog(ts('سيُضاف المخزون وتُحدّث التكلفة والحسابات. متابعة؟'), { tone: 'warning' })) { try { await window.api.purchases.receive(Number(b.dataset.id)); await refresh(); } catch (error) { showToast(ts('تعذّر الاستلام: ') + error.message, 'error'); } } })); }
function openSupplier(s = null) { editingSupplier = s; $('supplierForm').reset(); $('supplierModalTitle').textContent = s ? t('suppliers.editSupplier') : t('suppliers.newSupplier'); if (s) { $('supplierName').value=s.name; $('supplierPhone').value=s.phone||''; $('supplierAddress').value=s.address||''; $('supplierNotes').value=s.notes||''; } $('supplierModal').classList.remove('hidden'); }
async function saveSupplier(e) { e.preventDefault(); const data={name:$('supplierName').value.trim(),phone:$('supplierPhone').value.trim(),address:$('supplierAddress').value.trim(),notes:$('supplierNotes').value.trim()}; if(editingSupplier) await window.api.suppliers.update({...data,id:editingSupplier.id}); else await window.api.suppliers.create(data); $('supplierModal').classList.add('hidden'); await refresh(); }
function openPurchase() { purchaseItems=[]; $('purchaseForm').reset(); $('quickAddProductRow').classList.add('hidden'); $('purchaseSupplier').innerHTML=suppliers.map((s)=>`<option value="${s.id}">${esc(s.name)}</option>`).join(''); $('purchaseProduct').innerHTML=products.map((p)=>`<option value="${p.id}">${esc(p.name)}</option>`).join(''); $('purchasePaymentMethod').value='credit'; $('purchasePaid').value='0'; updatePurchasePaymentFields(); renderPurchaseItems(); $('purchaseModal').classList.remove('hidden'); }
function updatePurchasePaymentFields() { const isCredit = $('purchasePaymentMethod').value === 'credit'; $('purchasePaid').disabled = isCredit; if (isCredit) $('purchasePaid').value = '0'; $('purchasePaymentHint').textContent = isCredit ? t('suppliers.creditHint') : t('suppliers.cashHint'); }
function addPurchaseItem() { const product=products.find((p)=>p.id===Number($('purchaseProduct').value)); const quantity=parseLocaleNumber($('purchaseQty').value); const unitCost=parseLocaleNumber($('purchaseCost').value); if(!product || !(quantity>0) || !(unitCost>=0)) return showToast(ts('أدخل بند شراء صحيحاً.'), 'error'); purchaseItems.push({productId:product.id,name:product.name,quantity,unitCost}); renderPurchaseItems(); }
function renderPurchaseItems(){ $('purchaseItemsBody').innerHTML=purchaseItems.map((i,n)=>`<tr><td>${esc(i.name)}</td><td>${i.quantity}</td><td>${i.unitCost.toFixed(2)}</td><td><button type="button" class="btn btn-secondary btn-sm" data-index="${n}">${ts('حذف')}</button></td></tr>`).join(''); $('purchaseItemsBody').querySelectorAll('button').forEach((b)=>b.addEventListener('click',()=>{purchaseItems.splice(Number(b.dataset.index),1);renderPurchaseItems();})); updatePurchaseTotal(); }
// لا يوجد أي مكان آخر بالنافذة يُظهر الإجمالي قبل هذا الإصلاح، فكان المستخدم يخمّن المبلغ
// المدفوع للمورد بدون مرجع، فيتجاوز الإجمالي الفعلي ويصطدم برفض الخلفية (خطأ عام غير مفيد).
// نحسب الإجمالي هنا حسب نفس منطق createPurchaseOrder بقاعدة البيانات (تقريب لأقرب سنتين)
// ونعرضه، ونحدّ حقل الدفع بهذا السقف مباشرة فلا يصل طلب غير صالح للخلفية أصلاً.
function purchaseOrderTotal(){ return Math.round(purchaseItems.reduce((sum,i)=>sum+i.quantity*i.unitCost,0)*100)/100; }
function updatePurchaseTotal(){
  const total = purchaseOrderTotal();
  $('purchaseTotal').textContent = total.toFixed(2);
  $('purchasePaid').max = String(total);
  if (parseLocaleNumber($('purchasePaid').value) > total) $('purchasePaid').value = total.toFixed(2);
}
async function savePurchase(e){ e.preventDefault(); if (!purchaseItems.length) return showToast(ts('أضف بند شراء واحداً على الأقل.'), 'error'); const saveBtn=$('savePurchaseBtn'); saveBtn.disabled=true; try { const result = await window.api.purchases.create({supplierId:Number($('purchaseSupplier').value),items:purchaseItems,paidAmount:parseLocaleNumber($('purchasePaid').value)||0,paymentMethod:$('purchasePaymentMethod').value,notes:$('purchaseNotes').value.trim()}); $('purchaseModal').classList.add('hidden'); await refresh(); const messageKey = result.cashMovementRecorded === false && $('purchasePaymentMethod').value === 'cash' ? 'suppliers.receivedAndPaidNoSession' : 'suppliers.receivedAndUpdated'; showToast(t(messageKey), 'success'); } catch(error){showToast(ts('تعذر الحفظ: ') + error.message, 'error');} finally { saveBtn.disabled=false; } }
// ---------- فاتورة مصروف تشغيلي (بلا بضاعة) ----------
let expenseCategories = [];
function initExpenseUi() {
  $('addExpenseBtn').addEventListener('click', openExpense);
  $('cancelExpenseBtn').addEventListener('click', () => $('expenseModal').classList.add('hidden'));
  $('expenseForm').addEventListener('submit', saveExpense);
  $('expensePaymentMethod').addEventListener('change', updateExpensePaymentFields);
  $('expenseAmount').addEventListener('input', updateExpensePaymentFields);
  $('expenseAddCategoryBtn').addEventListener('click', () => { $('expenseNewCategoryRow').classList.remove('hidden'); $('expenseNewCategoryName').value = ''; $('expenseNewCategoryName').focus(); });
  $('expenseCancelCategoryBtn').addEventListener('click', () => $('expenseNewCategoryRow').classList.add('hidden'));
  $('expenseSaveCategoryBtn').addEventListener('click', async () => {
    const name = $('expenseNewCategoryName').value.trim();
    if (!name) return showToast(ts('اسم الفئة مطلوب.'), 'error');
    try {
      const created = await window.api.expenses.saveCategory({ name });
      await loadExpenseCategories(created.id);
      $('expenseNewCategoryRow').classList.add('hidden');
    } catch (error) { showToast(error.message, 'error'); }
  });
}
async function loadExpenseCategories(selectId) {
  expenseCategories = await window.api.expenses.categories();
  $('expenseCategory').innerHTML = expenseCategories.map((c) => `<option value="${c.id}">${esc(ts(c.name))}</option>`).join('');
  if (selectId) $('expenseCategory').value = String(selectId);
}
async function openExpense() {
  if (!suppliers.length) return showToast(ts('أضف مورداً أولاً.'), 'error');
  $('expenseForm').reset();
  $('expenseNewCategoryRow').classList.add('hidden');
  $('expenseSupplier').innerHTML = suppliers.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
  await loadExpenseCategories();
  $('expenseDate').value = new Date().toLocaleDateString('en-CA');
  $('expensePaymentMethod').value = 'credit';
  $('expensePaid').value = '0';
  updateExpensePaymentFields();
  $('expenseModal').classList.remove('hidden');
}
function updateExpensePaymentFields() {
  const method = $('expensePaymentMethod').value;
  const isCredit = method === 'credit';
  $('expensePaid').disabled = isCredit;
  if (isCredit) $('expensePaid').value = '0';
  else if (!parseLocaleNumber($('expensePaid').value)) $('expensePaid').value = String(parseLocaleNumber($('expenseAmount').value) || 0);
  $('expensePaymentHint').textContent = isCredit
    ? ts('يُسجَّل المبلغ كذمة على المورد ولا يتأثر الصندوق.')
    : (method === 'cash' ? ts('يُخصم المبلغ المدفوع من الصندوق ويلزم وردية مفتوحة.') : ts('يُسجَّل الدفع عبر البنك / البطاقة.'));
}
async function saveExpense(e) {
  e.preventDefault();
  const amount = parseLocaleNumber($('expenseAmount').value);
  if (!(amount > 0)) return showToast(ts('أدخل مبلغ المصروف.'), 'error');
  const method = $('expensePaymentMethod').value;
  const btn = $('saveExpenseBtn');
  btn.disabled = true;
  try {
    const result = await window.api.expenses.create({
      supplierId: Number($('expenseSupplier').value),
      categoryId: Number($('expenseCategory').value),
      amount,
      invoiceDate: $('expenseDate').value || undefined,
      referenceNumber: $('expenseReference').value.trim(),
      notes: $('expenseNotes').value.trim(),
      paymentMethod: method,
      paidAmount: method === 'credit' ? 0 : (parseLocaleNumber($('expensePaid').value) || 0),
    });
    $('expenseModal').classList.add('hidden');
    await refresh();
    showToast(ts('تم تسجيل فاتورة المصروف.'), 'success');
    return result;
  } catch (error) {
    showToast(ts('تعذر تسجيل المصروف: ') + error.message, 'error');
  } finally {
    btn.disabled = false;
  }
}
function esc(value){const d=document.createElement('div');d.textContent=value??'';return d.innerHTML;} init();
