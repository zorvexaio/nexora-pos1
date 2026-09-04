let currentItems = [];

const branchNameEl = document.getElementById('branchName');
const searchInput = document.getElementById('searchInput');
const lowOnlyCheckbox = document.getElementById('lowOnlyCheckbox');
const tableBody = document.getElementById('inventoryTableBody');
const emptyState = document.getElementById('emptyState');

const tabStockBtn = document.getElementById('tabStockBtn');
const tabMovementsBtn = document.getElementById('tabMovementsBtn');
const tabTransfersBtn = document.getElementById('tabTransfersBtn');
const stockTab = document.getElementById('stockTab');
const movementsTab = document.getElementById('movementsTab');
const movementsTableBody = document.getElementById('movementsTableBody');
const movementsEmptyState = document.getElementById('movementsEmptyState');
const transfersTab = document.getElementById('transfersTab');
const transfersTableBody = document.getElementById('transfersTableBody');
const transfersEmptyState = document.getElementById('transfersEmptyState');
const newTransferBtn = document.getElementById('newTransferBtn');
const addTransferBranchBtn = document.getElementById('addTransferBranchBtn');

const adjustModal = document.getElementById('adjustModal');
const adjustForm = document.getElementById('adjustForm');
const adjustProductId = document.getElementById('adjustProductId');
const adjustCurrentQty = document.getElementById('adjustCurrentQty');
const adjustDirection = document.getElementById('adjustDirection');
const adjustValue = document.getElementById('adjustValue');
const adjustReason = document.getElementById('adjustReason');
const adjustNotes = document.getElementById('adjustNotes');
const cancelAdjustBtn = document.getElementById('cancelAdjustBtn');
const transferModal = document.getElementById('transferModal');
const transferForm = document.getElementById('transferForm');
const transferDestination = document.getElementById('transferDestination');
const transferProduct = document.getElementById('transferProduct');
const transferQuantity = document.getElementById('transferQuantity');
const transferNotes = document.getElementById('transferNotes');
const transferAvailableHint = document.getElementById('transferAvailableHint');
const transferDraftItems = document.getElementById('transferDraftItems');
const addTransferItemBtn = document.getElementById('addTransferItemBtn');
const cancelTransferBtn = document.getElementById('cancelTransferBtn');
const saveTransferBtn = document.getElementById('saveTransferBtn');
const transferBranchModal = document.getElementById('transferBranchModal');
const transferBranchForm = document.getElementById('transferBranchForm');
const transferBranchUuid = document.getElementById('transferBranchUuid');
const transferBranchName = document.getElementById('transferBranchName');
const transferBranchNotes = document.getElementById('transferBranchNotes');
const cancelTransferBranchBtn = document.getElementById('cancelTransferBranchBtn');

let transferBranches = [];
let transfers = [];
let transferDraft = [];

const REASON_LABELS = {
  sale: 'بيع',
  adjustment: 'تسوية / جرد',
  purchase: 'شراء بضاعة جديدة',
  damage: 'تالف / منتهي الصلاحية',
  transfer: 'تحويل بين فروع',
  transfer_out: 'تحويل صادر',
  transfer_in: 'تحويل وارد',
  transfer_cancel: 'إلغاء تحويل',
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
  tabTransfersBtn.addEventListener('click', () => switchTab('transfers'));
  newTransferBtn.addEventListener('click', openTransferModal);
  addTransferBranchBtn.addEventListener('click', openTransferBranchModal);
  addTransferItemBtn.addEventListener('click', addTransferDraftItem);
  cancelTransferBtn.addEventListener('click', closeTransferModal);
  cancelTransferBranchBtn.addEventListener('click', closeTransferBranchModal);
  transferForm.addEventListener('submit', saveTransfer);
  transferBranchForm.addEventListener('submit', saveTransferBranch);
  transferProduct.addEventListener('change', updateTransferAvailableHint);
  transferModal.addEventListener('click', (e) => { if (e.target === transferModal) closeTransferModal(); });
  transferBranchModal.addEventListener('click', (e) => { if (e.target === transferBranchModal) closeTransferBranchModal(); });

  adjustForm.addEventListener('submit', saveAdjustment);
  cancelAdjustBtn.addEventListener('click', closeAdjustModal);
  adjustModal.addEventListener('click', (e) => {
    if (e.target === adjustModal) closeAdjustModal();
  });
}

function switchTab(tab) {
  const isStock = tab === 'stock';
  const isMovements = tab === 'movements';
  tabStockBtn.classList.toggle('active', isStock);
  tabMovementsBtn.classList.toggle('active', isMovements);
  tabTransfersBtn.classList.toggle('active', tab === 'transfers');
  stockTab.style.display = isStock ? '' : 'none';
  movementsTab.style.display = isMovements ? '' : 'none';
  transfersTab.style.display = tab === 'transfers' ? '' : 'none';
  if (isMovements) loadMovements();
  if (tab === 'transfers') loadTransfers();
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

async function loadTransfers() {
  try {
    transfers = await window.api.inventory.transfers({});
    transfersEmptyState.style.display = transfers.length === 0 ? 'block' : 'none';
    transfersTableBody.innerHTML = '';
    for (const t of transfers) {
      const incoming = t.destination_branch_uuid === t.branch_uuid;
      const otherName = incoming ? (t.source_branch_name || t.source_branch_uuid) : (t.destination_branch_name || t.destination_branch_uuid);
      const statusLabel = { shipped: 'مشحون', received: 'مستلم', cancelled: 'ملغى' }[t.effective_status || t.status] || t.status;
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${formatDate(t.created_at)}</td><td>${incoming ? 'وارد' : 'صادر'}</td><td>${escapeHtml(otherName || '—')}</td><td>${Number(t.item_count || 0)}</td><td><span class="status-badge">${statusLabel}</span></td><td class="row-actions"></td>`;
      const actions = tr.querySelector('.row-actions');
      const view = document.createElement('button'); view.className='btn btn-secondary btn-sm'; view.textContent='تفاصيل'; view.addEventListener('click',()=>showTransferDetails(t)); actions.appendChild(view);
      const status = t.effective_status || t.status;
      if (incoming && status === 'shipped') { const b=document.createElement('button'); b.className='btn btn-primary btn-sm'; b.textContent='استلام'; b.addEventListener('click',()=>receiveTransfer(t.uuid)); actions.appendChild(b); }
      if (!incoming && status === 'shipped' && Number(t.synced)===0) { const b=document.createElement('button'); b.className='btn btn-danger btn-sm'; b.textContent='إلغاء'; b.addEventListener('click',()=>cancelTransfer(t.uuid)); actions.appendChild(b); }
      transfersTableBody.appendChild(tr);
    }
  } catch (err) { alert(ts('تعذر تحميل التحويلات: ') + err.message); }
}

async function openTransferModal() {
  try {
    transferBranches = await window.api.inventory.transferBranches();
    const allItems = await window.api.inventory.list({ search: '', lowOnly: false });
    transferDestination.innerHTML = '<option value="">اختر الفرع المستلم</option>';
    for (const b of transferBranches.filter(x => !x.is_current)) {
      const o=document.createElement('option'); o.value=b.uuid; o.textContent=`${b.name} (${b.uuid})`; transferDestination.appendChild(o);
    }
    transferProduct.innerHTML = '<option value="">اختر المنتج</option>';
    for (const p of allItems.filter(x => Number(x.track_inventory) !== 0 && Number(x.stock || 0) > 0)) {
      const o=document.createElement('option'); o.value=p.id; o.textContent=`${p.name} — ${p.stock} ${p.unit || ''}`; o.dataset.stock=p.stock; transferProduct.appendChild(o);
    }
    transferForm.dataset.items = '';
    transferDraft = [];
    renderTransferDraft();
    transferQuantity.value=''; transferNotes.value=''; transferAvailableHint.textContent='—';
    transferModal.classList.remove('hidden');
  } catch (err) { alert(ts('تعذر فتح التحويل: ') + err.message); }
}
function closeTransferModal(){ transferModal.classList.add('hidden'); }
function addTransferDraftItem(){
  const productId=Number(transferProduct.value); const qty=Number(transferQuantity.value);
  if(!productId || !Number.isFinite(qty) || qty<=0){ alert('اختر منتجًا وأدخل كمية صحيحة.'); return; }
  const opt=transferProduct.selectedOptions[0]; const stock=Number(opt?.dataset.stock || 0);
  const existing=transferDraft.find(x=>x.productId===productId);
  const nextQty=(existing?.quantity || 0)+qty;
  if(nextQty>stock){ alert(`الكمية المطلوبة تتجاوز المتاح (${stock}).`); return; }
  if(existing) existing.quantity=nextQty; else transferDraft.push({productId, productName:opt.textContent, quantity:qty});
  transferQuantity.value=''; renderTransferDraft();
}
function renderTransferDraft(){
  if(!transferDraft.length){transferDraftItems.textContent='لم تتم إضافة أصناف.';return;}
  transferDraftItems.innerHTML='';
  transferDraft.forEach((item,index)=>{ const row=document.createElement('div'); row.className='row-actions'; row.style.marginBottom='6px'; const span=document.createElement('span'); span.textContent=`${item.productName} × ${item.quantity}`; const b=document.createElement('button'); b.type='button'; b.className='btn btn-secondary btn-sm'; b.textContent='حذف'; b.addEventListener('click',()=>{transferDraft.splice(index,1);renderTransferDraft();}); row.append(span,b); transferDraftItems.appendChild(row); });
}
function updateTransferAvailableHint(){ const s=transferProduct.selectedOptions[0]?.dataset.stock; transferAvailableHint.textContent=s!==undefined?`المتاح في الفرع الحالي: ${s}`:'—'; }
async function saveTransfer(e){
  e.preventDefault(); if(!transferDestination.value){alert('اختر الفرع المستلم.');return;} if(!transferDraft.length){alert('أضف صنفًا واحدًا على الأقل.');return;}
  saveTransferBtn.disabled=true; saveTransferBtn.textContent='جارٍ الشحن...';
  try { const result=await window.api.inventory.createTransfer({ destinationBranchUuid:transferDestination.value, notes:transferNotes.value.trim()||null, items:transferDraft.map(x=>({productId:x.productId,quantity:x.quantity})) }); alert(`تم إنشاء التحويل ${result.uuid} وشحنه بنجاح.`); closeTransferModal(); await loadInventory(); await loadTransfers(); } catch(err){ alert(ts('تعذر إنشاء التحويل: ')+err.message); } finally { saveTransferBtn.disabled=false; saveTransferBtn.textContent='شحن التحويل'; }
}
function openTransferBranchModal(){ transferBranchUuid.value=''; transferBranchName.value=''; transferBranchNotes.value=''; transferBranchModal.classList.remove('hidden'); transferBranchUuid.focus(); }
function closeTransferBranchModal(){ transferBranchModal.classList.add('hidden'); }
async function saveTransferBranch(e){
  e.preventDefault();
  try { await window.api.inventory.addTransferBranch({uuid:transferBranchUuid.value.trim(),name:transferBranchName.value.trim(),notes:transferBranchNotes.value.trim()||null}); closeTransferBranchModal(); alert('تم حفظ الفرع.'); } catch(err){alert(ts('تعذر حفظ الفرع: ')+err.message);}
}
async function receiveTransfer(uuid){ if(!confirm('سيتم إضافة الكميات إلى مخزون هذا الفرع. هل تريد المتابعة؟')) return; try { await window.api.inventory.receiveTransfer({uuid}); await loadTransfers(); await loadInventory(); } catch(err){alert(ts('تعذر استلام التحويل: ')+err.message);} }
async function cancelTransfer(uuid){ if(!confirm('سيتم إلغاء التحويل وإرجاع الكميات إلى المخزون. هل أنت متأكد؟')) return; try { await window.api.inventory.cancelTransfer({uuid}); await loadTransfers(); await loadInventory(); } catch(err){alert(ts('تعذر إلغاء التحويل: ')+err.message);} }
function showTransferDetails(t){
  const items=Array.isArray(t.items)?t.items:[];
  const lines=items.map(i=>`${i.product_name || i.product_uuid}: ${i.quantity}`).join('\n');
  alert(`التحويل: ${t.uuid}\nالحالة: ${t.effective_status || t.status}\nمن: ${t.source_branch_name || t.source_branch_uuid}\nإلى: ${t.destination_branch_name || t.destination_branch_uuid}\n\n${lines || 'لا توجد بنود'}`);
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
