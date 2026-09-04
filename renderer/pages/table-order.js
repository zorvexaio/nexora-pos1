const params = new URLSearchParams(window.location.search);
const tableId = parseInt(params.get('tableId'), 10);

let products = [];
let cart = []; // { lineId, productId, name, price, taxRate, quantity, notes }
let nextLineId = 1;
let currentSaleId = null;
let loggedInUser = null;

const productsGrid = document.getElementById('productsGrid');
const searchInput = document.getElementById('searchInput');
const cartItemsEl = document.getElementById('cartItems');
const sumSubtotal = document.getElementById('sumSubtotal');
const sumTax = document.getElementById('sumTax');
const sumTotal = document.getElementById('sumTotal');
const checkoutBtn = document.getElementById('checkoutBtn');
const saveOrderBtn = document.getElementById('saveOrderBtn');
const splitBillBtn = document.getElementById('splitBillBtn');
const branchNameEl = document.getElementById('branchName');
const tableNameLabel = document.getElementById('tableNameLabel');
const tableTitle = document.getElementById('tableTitle');
const backToTablesBtn = document.getElementById('backToTablesBtn');


async function goBackToTables() {
  // Save the current open order before leaving so a cashier never loses changes.
  try {
    if (currentSaleId) await saveOrder(false);
  } catch (err) {
    const leaveAnyway = confirm(t('tableOrder.backSaveFailed', 'تعذر حفظ الطلب قبل الرجوع. هل تريد المتابعة؟'));
    if (!leaveAnyway) return;
  }
  window.location.href = 'tables.html';
}

async function init() {
  loggedInUser = await guardPage(null, '../login.html');
  if (!loggedInUser) return;

  if (!tableId) {
    alert(t('tableOrder.invalidTable'));
    window.location.href = 'tables.html';
    return;
  }

  const branch = await window.api.branches.current();
  branchNameEl.textContent = branch ? branch.name : '';

  const tables = await window.api.tables.list();
  const table = tables.find((t) => t.id === tableId);
  const tableName = table ? table.name : `#${tableId}`;
  tableNameLabel.textContent = tableName;
  tableTitle.textContent = `${typeof t === 'function' ? t('tableOrder.orderPrefix', 'طلب') : 'طلب'} ${tableName}`;

  await window.api.tables.openSale(tableId); // يفتح طلباً جديداً إن لم يوجد
  const openSale = await window.api.tables.getOpenSale(tableId);
  currentSaleId = openSale.id;
  cart = openSale.items.map((i) => ({
    lineId: nextLineId++,
    productId: i.product_id,
    name: i.product_name,
    price: i.unit_price,
    taxRate: i.tax_rate,
    quantity: i.quantity, saleItemId: i.id,
    notes: i.notes || '',
  }));
  renderCart();

  await loadProducts();

  backToTablesBtn?.addEventListener('click', goBackToTables);
  document.addEventListener('keydown', (e) => {
    if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); goBackToTables(); }
    if (e.key === 'Escape' && !document.querySelector('.modal-overlay:not(.hidden)')) goBackToTables();
  });

  searchInput.addEventListener('input', debounce(() => loadProducts(searchInput.value), 250));
  searchInput.addEventListener('keydown', handleSearchKeydown);
  saveOrderBtn.addEventListener('click', () => saveOrderAndReturn());
  splitBillBtn.addEventListener('click', openSplitBill);
  checkoutBtn.addEventListener('click', checkout);
}

async function loadProducts(search = '') {
  products = await window.api.products.list({ search, topLevelOnly: !search });
  renderProducts();
}

async function handleSearchKeydown(e) {
  if (e.key !== 'Enter') return;
  const code = searchInput.value.trim();
  if (!code) return;
  const matches = await window.api.products.list({ search: code });
  const exact = matches.find((p) => p.barcode === code);
  if (exact) {
    if (exact.variant_count > 0) openVariantPicker(exact);
    else addToCart(exact);
    searchInput.value = '';
    await loadProducts();
  }
}

function renderProducts() {
  productsGrid.innerHTML = '';
  if (products.length === 0) {
    productsGrid.innerHTML = `<p style="color:#9ca3af">${t('pos.noProducts')}</p>`;
    return;
  }
  for (const p of products) {
    const card = document.createElement('div');
    card.className = 'product-card';
    const lowStock = p.track_inventory && p.stock <= (p.min_quantity || 0);
    card.innerHTML = `
      <div class="name">${escapeHtml(p.name)}${p.variant_count ? ` <span class="variant-badge">${t('pos.selectBadge')}</span>` : ''}</div>
      <div class="price">${p.price.toFixed(2)}</div>
      ${p.track_inventory ? `<div class="stock ${lowStock ? 'low' : ''}">${t('pos.stockLabel')}${p.stock}</div>` : ''}
    `;
    card.addEventListener('click', () => (p.variant_count > 0 ? openVariantPicker(p) : addToCart(p)));
    productsGrid.appendChild(card);
  }
}

/* ---------------- نافذة اختيار المتغيّر ---------------- */
const variantModal = document.getElementById('variantModal');
const variantModalTitle = document.getElementById('variantModalTitle');
const variantList = document.getElementById('variantList');
document.getElementById('closeVariantBtn').addEventListener('click', () => variantModal.classList.add('hidden'));
variantModal.addEventListener('click', (e) => {
  if (e.target === variantModal) variantModal.classList.add('hidden');
});

async function openVariantPicker(parentProduct) {
  variantModalTitle.textContent = `${t('pos.selectVariantTitle')}${parentProduct.name}`;
  variantList.innerHTML = `<p style="color:#9ca3af">${t('splash.loading')}</p>`;
  variantModal.classList.remove('hidden');
  const variants = await window.api.products.variants(parentProduct.id);
  variantList.innerHTML = '';
  if (variants.length === 0) {
    variantList.innerHTML = `<p style="color:#9ca3af">${t('pos.noVariants')}</p>`;
    return;
  }
  for (const v of variants) {
    const outOfStock = v.track_inventory && v.stock <= 0;
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'variant-option';
    row.disabled = outOfStock;
    const label = [v.variant_size, v.variant_color].filter(Boolean).join(' / ') || v.name;
    row.innerHTML = `<span>${escapeHtml(label)}</span><span>${v.price.toFixed(2)}</span>`;
    row.addEventListener('click', () => {
      addToCart(v);
      variantModal.classList.add('hidden');
    });
    variantList.appendChild(row);
  }
}

function addToCart(product) {
  const existing = cart.find((i) => i.productId === product.id && !i.notes);
  if (existing) {
    existing.quantity += 1;
  } else {
    cart.push({ lineId: nextLineId++, productId: product.id, name: product.name, price: product.price, taxRate: product.tax_rate || 0, quantity: 1, notes: '' });
  }
  renderCart();
}

function changeQty(lineId, delta) {
  const item = cart.find((i) => i.lineId === lineId);
  if (!item) return;
  item.quantity += delta;
  if (item.quantity <= 0) cart = cart.filter((i) => i.lineId !== lineId);
  renderCart();
}

/* ---------------- ملاحظة على صنف بالسلة (مثال: بدون ثوم، دبل لحمة) ---------------- */
const itemNoteModal = document.getElementById('itemNoteModal');
const itemNoteInput = document.getElementById('itemNoteInput');
const itemNoteProductName = document.getElementById('itemNoteProductName');
const saveItemNoteBtn = document.getElementById('saveItemNoteBtn');
const cancelItemNoteBtn = document.getElementById('cancelItemNoteBtn');
let itemNoteLineId = null;

function openItemNoteModal(lineId) {
  const item = cart.find((i) => i.lineId === lineId);
  if (!item) return;
  itemNoteLineId = lineId;
  itemNoteProductName.textContent = item.name;
  itemNoteInput.value = item.notes || '';
  itemNoteModal.classList.remove('hidden');
  itemNoteInput.focus();
}

function closeItemNoteModal() {
  itemNoteModal.classList.add('hidden');
  itemNoteLineId = null;
}

saveItemNoteBtn?.addEventListener('click', () => {
  const item = cart.find((i) => i.lineId === itemNoteLineId);
  if (item) {
    item.notes = itemNoteInput.value.trim();
    renderCart();
    saveOrder(false);
  }
  closeItemNoteModal();
});
cancelItemNoteBtn?.addEventListener('click', closeItemNoteModal);
itemNoteModal?.addEventListener('click', (e) => {
  if (e.target === itemNoteModal) closeItemNoteModal();
});

function renderCart() {
  cartItemsEl.innerHTML = '';
  for (const item of cart) {
    const row = document.createElement('div');
    row.className = 'cart-item';
    row.innerHTML = `
      <div class="cart-item-main">
        <span>${escapeHtml(item.name)}</span>
      <div class="qty-controls">${loggedInUser.role === 'cashier' ? `<span title="${t('pos.qtyLockedTooltip')}">${item.quantity}</span>` : `<button data-action="minus">−</button><span>${item.quantity}</span><button data-action="plus">+</button>`}</div>
        <span>${(item.price * item.quantity).toFixed(2)}</span>
        <button type="button" class="note-btn ${item.notes ? 'has-note' : ''}" data-action="note" title="${t('pos.addNoteTooltip')}">📝</button>
      </div>
      ${item.notes ? `<div class="cart-item-note">${escapeHtml(item.notes)}</div>` : ''}
    `;
    row.querySelector('[data-action="minus"]')?.addEventListener('click', () => changeQty(item.lineId, -1));
    row.querySelector('[data-action="plus"]')?.addEventListener('click', () => changeQty(item.lineId, 1));
    row.querySelector('[data-action="note"]')?.addEventListener('click', () => openItemNoteModal(item.lineId));
    cartItemsEl.appendChild(row);
  }
  const subtotal = cart.reduce((s, i) => s + i.price * i.quantity, 0);
  const tax = cart.reduce((s, i) => s + i.price * i.quantity * (i.taxRate / 100), 0);
  sumSubtotal.textContent = subtotal.toFixed(2);
  sumTax.textContent = tax.toFixed(2);
  sumTotal.textContent = (subtotal + tax).toFixed(2);
  checkoutBtn.disabled = cart.length === 0;
}

function cartToItems() {
  return cart.map((i) => ({
    productId: i.productId,
    quantity: i.quantity,
    unitPrice: i.price,
    taxRate: i.taxRate,
    lineTotal: i.price * i.quantity,
    notes: i.notes || null,
  }));
}

// لو فشلت الطباعة التلقائية (طابعة غير متصلة/IP غلط/إلخ)، ننبّه المستخدم فوراً بدل
// فشل صامت لا يظهر إلا في سجل التدقيق — نفس السبب الحقيقي وراء "الطابعة لا تعمل أبداً"
// دون أي رسالة توضّح السبب.
function warnPrintOutcome(printOutcome) {
  if (!printOutcome) return;
  if (printOutcome.kitchen && printOutcome.kitchen.success === false) alert(`⚠️ لم تُطبع تذكرة المطبخ: ${printOutcome.kitchen.reason || 'خطأ غير معروف'}`);
  if (printOutcome.receipt && printOutcome.receipt.success === false) alert(`⚠️ لم تُطبع الفاتورة: ${printOutcome.receipt.reason || 'خطأ غير معروف'}`);
}

async function saveOrder(showAlert) {
  // الـIPC الخاص بحفظ طلب الطاولة يرسل تذكرة المطبخ تلقائياً بعد نجاح transaction؛
  // لا نستدعي الطباعة مرة ثانية من الواجهة حتى لا يصل للمطبخ وصلان لنفس الحفظ.
  const result = await window.api.tables.setItems(currentSaleId, cartToItems());
  warnPrintOutcome(result?.printOutcome);
  if (showAlert) alert(t('tableOrder.orderSaved'));
}

// زر "حفظ الطلب": يحفظ ثم يرجع مباشرة لشاشة الطاولات (بدون تنبيه يعطّل التدفق)،
// نفس ما يحصل عند الرجوع بالزر/الاختصار العادي، حتى يقدر الكاشير يكمل شغله بسرعة.
async function saveOrderAndReturn() {
  try {
    await saveOrder(false);
    window.location.href = 'tables.html';
  } catch (err) {
    alert(err.message || t('tableOrder.saveFailed', 'تعذر حفظ الطلب.'));
  }
}

const splitBillModal = document.getElementById('splitBillModal');
const splitItems = document.getElementById('splitItems');
const splitTotal = document.getElementById('splitTotal');
const splitCashReceived = document.getElementById('splitCashReceived');

async function openSplitBill() {
  await saveOrder(false);
  const openSale = await window.api.tables.getOpenSale(tableId);
  cart = openSale.items.map(i => ({ productId: i.product_id, name: i.product_name, price: i.unit_price, taxRate: i.tax_rate, quantity: i.quantity, saleItemId: i.id }));
  renderCart();
  splitItems.innerHTML = cart.map(i => `<div class="cart-item"><span>${escapeHtml(i.name)} <small>(${t('tableOrder.availableQty')}${i.quantity})</small></span><input class="split-qty" data-item-id="${i.saleItemId}" data-price="${i.price}" data-tax="${i.taxRate || 0}" type="number" min="0" max="${i.quantity}" value="0" step="1" style="width:75px" /></div>`).join('');
  splitItems.querySelectorAll('.split-qty').forEach(el => el.addEventListener('input', updateSplitTotal));
  document.querySelector('input[name="splitPayment"][value="cash"]').checked = true;
  splitCashReceived.value = '';
  updateSplitTotal();
  splitBillModal.classList.remove('hidden');
}
function updateSplitTotal() {
  let total = 0;
  splitItems.querySelectorAll('.split-qty').forEach(el => { const q = Math.min(Number(el.max), Math.max(0, Number(el.value) || 0)); el.value = q; total += q * Number(el.dataset.price) * (1 + Number(el.dataset.tax) / 100); });
  splitTotal.textContent = total.toFixed(2);
  if (!splitCashReceived.value) splitCashReceived.value = total.toFixed(2);
}
document.getElementById('cancelSplitBillBtn').addEventListener('click', () => splitBillModal.classList.add('hidden'));
document.querySelectorAll('input[name="splitPayment"]').forEach(el => el.addEventListener('change', () => document.getElementById('splitCashFields').classList.toggle('hidden', el.value !== 'cash')));
document.getElementById('confirmSplitBillBtn').addEventListener('click', async () => {
  const selected = [...splitItems.querySelectorAll('.split-qty')].map(el => ({ saleItemId: Number(el.dataset.itemId), quantity: Number(el.value) || 0 })).filter(x => x.quantity > 0);
  const total = Number(splitTotal.textContent); if (!selected.length || !(total > 0)) return alert(t('tableOrder.selectQtyToPay'));
  const paymentMethod = document.querySelector('input[name="splitPayment"]:checked').value;
  const received = Number(splitCashReceived.value) || 0;
  if (paymentMethod === 'cash' && received < total - 0.001) return alert(t('tableOrder.splitCashInsufficient'));
  try {
    const result = await window.api.tables.split(currentSaleId, selected, { paymentMethod, cashAmount: paymentMethod === 'cash' ? received : 0, cardAmount: paymentMethod === 'card' ? total : 0, changeDue: paymentMethod === 'cash' ? received - total : 0 });
    splitBillModal.classList.add('hidden');
    const remaining = await window.api.tables.getOpenSale(tableId);
    cart = remaining.items.map(i => ({ productId: i.product_id, name: i.product_name, price: i.unit_price, taxRate: i.tax_rate, quantity: i.quantity, saleItemId: i.id }));
    renderCart();
    warnPrintOutcome(result?.printOutcome);
    alert(`${t('tableOrder.splitPaid')}${result.invoiceNumber || result.id}`);
  } catch (err) { alert(t('tableOrder.splitFailed') + err.message); }
});

/* ---------------- الدفع وإغلاق الطاولة ---------------- */
const paymentModal = document.getElementById('paymentModal');
const paymentTotalDisplay = document.getElementById('paymentTotalDisplay');
const cashFields = document.getElementById('cashFields');
const mixedFields = document.getElementById('mixedFields');
const cashReceivedInput = document.getElementById('cashReceivedInput');
const changeDueDisplay = document.getElementById('changeDueDisplay');
const mixedCashInput = document.getElementById('mixedCashInput');
const mixedCardInput = document.getElementById('mixedCardInput');
const mixedRemainingDisplay = document.getElementById('mixedRemainingDisplay');
const paymentError = document.getElementById('paymentError');
const cancelPaymentBtn = document.getElementById('cancelPaymentBtn');
const confirmPaymentBtn = document.getElementById('confirmPaymentBtn');

let currentTotal = 0;

async function checkout() {
  if (cart.length === 0) return;
  await saveOrder(false); // نحفظ آخر تعديلات قبل الدفع
  const subtotal = cart.reduce((s, i) => s + i.price * i.quantity, 0);
  const tax = cart.reduce((s, i) => s + i.price * i.quantity * (i.taxRate / 100), 0);
  currentTotal = subtotal + tax;

  paymentTotalDisplay.textContent = currentTotal.toFixed(2);
  document.querySelector('input[name="paymentMethod"][value="cash"]').checked = true;
  cashReceivedInput.value = currentTotal.toFixed(2);
  mixedCashInput.value = '';
  mixedCardInput.value = '';
  paymentError.classList.add('hidden');
  updatePaymentView();
  paymentModal.classList.remove('hidden');
  cashReceivedInput.focus();
  cashReceivedInput.select();
}

function closePaymentModal() {
  paymentModal.classList.add('hidden');
}

function selectedPaymentMethod() {
  return document.querySelector('input[name="paymentMethod"]:checked').value;
}

function updatePaymentView() {
  const method = selectedPaymentMethod();
  cashFields.classList.toggle('hidden', method !== 'cash');
  mixedFields.classList.toggle('hidden', method !== 'mixed');
  paymentError.classList.add('hidden');
  if (method === 'cash') {
    const received = parseFloat(cashReceivedInput.value) || 0;
    changeDueDisplay.textContent = Math.max(received - currentTotal, 0).toFixed(2);
  } else if (method === 'mixed') {
    const cashPart = parseFloat(mixedCashInput.value) || 0;
    const remaining = currentTotal - cashPart;
    mixedRemainingDisplay.textContent = remaining.toFixed(2);
    if (!mixedCardInput.value || document.activeElement !== mixedCardInput) {
      mixedCardInput.value = Math.max(remaining, 0).toFixed(2);
    }
  }
}

document.querySelectorAll('input[name="paymentMethod"]').forEach((el) => el.addEventListener('change', updatePaymentView));
cashReceivedInput.addEventListener('input', updatePaymentView);
mixedCashInput.addEventListener('input', updatePaymentView);
mixedCardInput.addEventListener('input', () => {
  mixedRemainingDisplay.textContent = (
    currentTotal - (parseFloat(mixedCashInput.value) || 0) - (parseFloat(mixedCardInput.value) || 0)
  ).toFixed(2);
});
cancelPaymentBtn.addEventListener('click', closePaymentModal);
confirmPaymentBtn.addEventListener('click', confirmPayment);

async function confirmPayment() {
  const method = selectedPaymentMethod();
  let cashAmount = 0;
  let cardAmount = 0;
  let changeDue = 0;

  if (method === 'cash') {
    cashAmount = parseFloat(cashReceivedInput.value) || 0;
    if (cashAmount < currentTotal - 0.001) {
      showPaymentError(t('pos.insufficientCash'));
      return;
    }
    changeDue = cashAmount - currentTotal;
  } else if (method === 'card') {
    cardAmount = currentTotal;
  } else if (method === 'mixed') {
    cashAmount = parseFloat(mixedCashInput.value) || 0;
    cardAmount = parseFloat(mixedCardInput.value) || 0;
    if (Math.abs(cashAmount + cardAmount - currentTotal) > 0.01) {
      showPaymentError(t('pos.mixedMismatch'));
      return;
    }
  }

  confirmPaymentBtn.disabled = true;
  confirmPaymentBtn.textContent = t('tableOrder.closing');
  try {
    const closeResult = await window.api.tables.close(currentSaleId, { paymentMethod: method, cashAmount, cardAmount, changeDue });
    warnPrintOutcome(closeResult?.printOutcome);
    window.location.href = 'tables.html';
  } catch (err) {
    showPaymentError(t('tableOrder.genericError') + err.message);
  } finally {
    confirmPaymentBtn.disabled = false;
    confirmPaymentBtn.textContent = t('tableOrder.confirmAndClose');
  }
}

function showPaymentError(msg) {
  paymentError.textContent = msg;
  paymentError.classList.remove('hidden');
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
