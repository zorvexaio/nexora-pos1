const params = new URLSearchParams(window.location.search);
const tableId = parseInt(params.get('tableId'), 10);

let products = [];
let cart = []; // { lineId, productId, name, price, taxRate, quantity, notes }
let nextLineId = 1;
let currentSaleId = null;
let loggedInUser = null;
// إعدادات الضريبة/العملة للمنشأة: نفس ما يستخدمه الكاشير (pos.js) حتى تتطابق المعاينة مع الباك-إند.
let orgTaxMode = 'exclusive';
let orgMinorUnit = 2;
const MAX_QTY = 9999; // نفس السقف المستخدم في quick-cashier.js وpriceItemsFromDatabase/setOpenSaleItemsTx على الخادم
function notifyQtyMax() {
  showToast(tf('pos.qtyAccumulationMaximum', { max: MAX_QTY.toLocaleString() }), 'error');
}
// ضريبة الصنف كما يحسبها الباك-إند: ملف الضريبة إن وُجد، وإلا نسبة المنتج + وضع المنشأة.
function productTaxInfo(p) {
  const hasProfile = p && p.tax_profile_rate != null;
  return {
    taxRate: hasProfile ? Number(p.tax_profile_rate) : Number((p && p.tax_rate) || 0),
    taxInclusive: hasProfile ? Number(p.tax_profile_inclusive) === 1 : orgTaxMode === 'inclusive',
  };
}
function cartLineFromSaleItem(i) {
  return { productId: i.product_id, name: i.product_name, price: i.unit_price, taxRate: Number(i.tax_rate || 0), taxInclusive: Number(i.tax_inclusive) === 1, quantity: i.quantity, saleItemId: i.id, saleItemUuid: i.uuid || null, notes: i.notes || '' };
}

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
    const leaveAnyway = await confirmDialog(t('tableOrder.backSaveFailed', 'تعذر حفظ الطلب قبل الرجوع. هل تريد المتابعة؟'), { tone: 'warning' });
    if (!leaveAnyway) return;
  }
  window.location.href = 'tables.html';
}

async function init() {
  loggedInUser = await guardPage(null, '../login.html');
  if (!loggedInUser) return;

  if (!tableId) {
    await infoDialog(t('tableOrder.invalidTable'));
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

  try {
    const gp = await window.api.global.get();
    orgTaxMode = gp?.tax_mode || 'exclusive';
    const mu = Number(gp?.currency_minor_unit);
    orgMinorUnit = Number.isInteger(mu) && mu >= 0 && mu <= 3 ? mu : 2;
  } catch { orgTaxMode = 'exclusive'; orgMinorUnit = 2; }

  await window.api.tables.openSale(tableId); // يفتح طلباً جديداً إن لم يوجد
  const openSale = await window.api.tables.getOpenSale(tableId);
  currentSaleId = openSale.id;
  cart = openSale.items.map((i) => ({ lineId: nextLineId++, ...cartLineFromSaleItem(i) }));
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
      <div class="price">${p.price.toFixed(orgMinorUnit)}</div>
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
    row.innerHTML = `<span>${escapeHtml(label)}</span><span>${v.price.toFixed(orgMinorUnit)}</span>`;
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
    if (existing.quantity >= MAX_QTY) notifyQtyMax();
    existing.quantity = Math.min(MAX_QTY, existing.quantity + 1);
  } else {
    cart.push({ lineId: nextLineId++, productId: product.id, name: product.name, price: product.price, ...productTaxInfo(product), quantity: 1, notes: '' });
  }
  renderCart();
}

function changeQty(lineId, delta) {
  const item = cart.find((i) => i.lineId === lineId);
  if (!item) return;
  if (delta > 0 && item.quantity >= MAX_QTY) notifyQtyMax();
  item.quantity = Math.min(MAX_QTY, item.quantity + delta);
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
    saveOrder(false).catch((err) => showToast(err?.message || t('tableOrder.saveFailed', 'تعذر حفظ الطلب.'), 'error'));
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
        <span>${(item.price * item.quantity).toFixed(orgMinorUnit)}</span>
        <button type="button" class="note-btn ${item.notes ? 'has-note' : ''}" data-action="note" title="${t('pos.addNoteTooltip')}">📝</button>
      </div>
      ${item.notes ? `<div class="cart-item-note">${escapeHtml(item.notes)}</div>` : ''}
    `;
    row.querySelector('[data-action="minus"]')?.addEventListener('click', () => changeQty(item.lineId, -1));
    row.querySelector('[data-action="plus"]')?.addEventListener('click', () => changeQty(item.lineId, 1));
    row.querySelector('[data-action="note"]')?.addEventListener('click', () => openItemNoteModal(item.lineId));
    cartItemsEl.appendChild(row);
  }
  const { subtotal, tax } = sumCartTax(cart, orgMinorUnit);
  sumSubtotal.textContent = subtotal.toFixed(orgMinorUnit);
  sumTax.textContent = tax.toFixed(orgMinorUnit);
  sumTotal.textContent = (subtotal + tax).toFixed(orgMinorUnit);
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
    saleItemUuid: i.saleItemUuid || null,
  }));
}

// لو فشلت الطباعة التلقائية (طابعة غير متصلة/IP غلط/إلخ)، ننبّه المستخدم فوراً بدل
// فشل صامت لا يظهر إلا في سجل التدقيق — نفس السبب الحقيقي وراء "الطابعة لا تعمل أبداً"
// دون أي رسالة توضّح السبب.
function warnPrintOutcome(printOutcome) {
  if (!printOutcome) return;
  if (printOutcome.kitchen && printOutcome.kitchen.success === false) showToast(tf('tableOrder.kitchenPrintFailed', { reason: printOutcome.kitchen.reason || t('common.unknownError') }), 'error');
  if (printOutcome.receipt && printOutcome.receipt.success === false) showToast(tf('tableOrder.receiptPrintFailed', { reason: printOutcome.receipt.reason || t('common.unknownError') }), 'error');
}

async function saveOrder(showAlert) {
  // الـIPC الخاص بحفظ طلب الطاولة يرسل تذكرة المطبخ تلقائياً بعد نجاح transaction؛
  // لا نستدعي الطباعة مرة ثانية من الواجهة حتى لا يصل للمطبخ وصلان لنفس الحفظ.
  const result = await window.api.tables.setItems(currentSaleId, cartToItems());
  warnPrintOutcome(result?.printOutcome);
  if (showAlert) showToast(t('tableOrder.orderSaved'), 'success');
  return result;
}

// زر "حفظ الطلب": يحفظ ثم يرجع مباشرة لشاشة الطاولات (بدون تنبيه يعطّل التدفق)،
// نفس ما يحصل عند الرجوع بالزر/الاختصار العادي، حتى يقدر الكاشير يكمل شغله بسرعة.
async function saveOrderAndReturn() {
  try {
    await saveOrder(false);
    window.location.href = 'tables.html';
  } catch (err) {
    showToast(err.message || t('tableOrder.saveFailed', 'تعذر حفظ الطلب.'), 'error');
  }
}

const splitBillModal = document.getElementById('splitBillModal');
const splitItems = document.getElementById('splitItems');
const splitTotal = document.getElementById('splitTotal');
const splitCashReceived = document.getElementById('splitCashReceived');

async function openSplitBill() {
  // نفس قاعدة الدفع: لا نفتح نافذة التقسيم إن فشل حفظ الطلب أو قراءته، ونعرض السبب.
  let openSale;
  try {
    await saveOrder(false);
    openSale = await window.api.tables.getOpenSale(tableId);
  } catch (err) {
    showToast(err?.message || t('tableOrder.saveFailed', 'تعذر حفظ الطلب.'), 'error');
    return;
  }
  cart = openSale.items.map(cartLineFromSaleItem);
  renderCart();
  splitItems.innerHTML = cart.map(i => `<div class="cart-item"><span>${escapeHtml(i.name)} <small>(${t('tableOrder.availableQty')}${i.quantity})</small></span><input class="split-qty" data-item-id="${i.saleItemId}" data-price="${i.price}" data-tax="${i.taxRate || 0}" data-inclusive="${i.taxInclusive ? 1 : 0}" type="text" inputmode="numeric" data-max="${i.quantity}" value="0" style="width:75px" /></div>`).join('');
  splitItems.querySelectorAll('.split-qty').forEach(el => el.addEventListener('input', updateSplitTotal));
  document.querySelector('input[name="splitPayment"][value="cash"]').checked = true;
  splitCashReceived.value = '';
  updateSplitTotal();
  splitBillModal.classList.remove('hidden');
}
function updateSplitTotal() {
  const lines = [];
  splitItems.querySelectorAll('.split-qty').forEach(el => {
    const q = Math.min(Number(el.dataset.max), Math.max(0, parseLocaleNumber(el.value) || 0));
    el.value = q;
    lines.push({ price: Number(el.dataset.price), quantity: q, taxRate: Number(el.dataset.tax) || 0, taxInclusive: el.dataset.inclusive === '1' });
  });
  const parts = sumCartTax(lines, orgMinorUnit);
  const total = parts.subtotal + parts.tax;
  splitTotal.textContent = total.toFixed(orgMinorUnit);
  if (!splitCashReceived.value) splitCashReceived.value = total.toFixed(orgMinorUnit);
}
document.getElementById('cancelSplitBillBtn').addEventListener('click', () => splitBillModal.classList.add('hidden'));
document.querySelectorAll('input[name="splitPayment"]').forEach(el => el.addEventListener('change', () => document.getElementById('splitCashFields').classList.toggle('hidden', el.value !== 'cash')));
document.getElementById('confirmSplitBillBtn').addEventListener('click', async () => {
  const selected = [...splitItems.querySelectorAll('.split-qty')].map(el => ({ saleItemId: Number(el.dataset.itemId), quantity: parseLocaleNumber(el.value) || 0 })).filter(x => x.quantity > 0);
  const total = Number(splitTotal.textContent); if (!selected.length || !(total > 0)) return showToast(t('tableOrder.selectQtyToPay'), 'error');
  const paymentMethod = document.querySelector('input[name="splitPayment"]:checked').value;
  const received = parseLocaleNumber(splitCashReceived.value) || 0;
  if (paymentMethod === 'cash' && Math.round(received * 10 ** orgMinorUnit) < Math.round(total * 10 ** orgMinorUnit)) return showToast(t('tableOrder.splitCashInsufficient'), 'error');
  try {
    const result = await window.api.tables.split(currentSaleId, selected, { paymentMethod, cashAmount: paymentMethod === 'cash' ? received : 0, cardAmount: paymentMethod === 'card' ? total : 0, changeDue: paymentMethod === 'cash' ? received - total : 0 });
    splitBillModal.classList.add('hidden');
    const remaining = await window.api.tables.getOpenSale(tableId);
    cart = remaining.items.map(cartLineFromSaleItem);
    renderCart();
    warnPrintOutcome(result?.printOutcome);
    showToast(`${t('tableOrder.splitPaid')}${result.invoiceNumber || result.id}`, 'success');
  } catch (err) { showToast(t('tableOrder.splitFailed') + err.message, 'error'); }
});

/* ---------------- اختيار العميل واستبدال نقاط الولاء ---------------- */
const customerSearchInput = document.getElementById('customerSearchInput');
const customerResults = document.getElementById('customerResults');
const selectedCustomerBox = document.getElementById('selectedCustomerBox');
const selectedCustomerLabel = document.getElementById('selectedCustomerLabel');
const clearCustomerBtn = document.getElementById('clearCustomerBtn');
const loyaltyRedeemBox = document.getElementById('loyaltyRedeemBox');
const loyaltyPointsInput = document.getElementById('loyaltyPointsInput');
const loyaltyMaxBtn = document.getElementById('loyaltyMaxBtn');
const loyaltyRedeemHint = document.getElementById('loyaltyRedeemHint');
let selectedCustomerId = null;
let customerSearchRequestSeq = 0;
let loyaltyQuote = null;
let loyaltyRedeemedPoints = 0;

function loyaltyRedeemedValue() {
  if (!loyaltyQuote || loyaltyRedeemedPoints <= 0 || !loyaltyQuote.redeemPointsPerCurrencyUnit) return 0;
  const points = Math.min(loyaltyRedeemedPoints, loyaltyQuote.maxRedeemablePoints);
  return points / loyaltyQuote.redeemPointsPerCurrencyUnit;
}
function effectiveTotal() {
  return Math.max(0, (currentTotal || 0) - loyaltyRedeemedValue());
}
function resetLoyaltyState() {
  loyaltyQuote = null;
  loyaltyRedeemedPoints = 0;
  loyaltyPointsInput.value = 0;
  loyaltyRedeemBox.classList.add('hidden');
  loyaltyRedeemHint.textContent = '';
}
function updateLoyaltyHint() {
  if (!loyaltyQuote) { loyaltyRedeemHint.textContent = ''; return; }
  loyaltyRedeemHint.textContent = `الرصيد المتاح: ${loyaltyQuote.availablePoints} نقطة — أقصى استبدال: ${loyaltyQuote.maxRedeemablePoints} نقطة (خصم ${loyaltyQuote.maxRedeemableValue.toFixed(orgMinorUnit)})`;
}
async function refreshLoyaltyQuote() {
  if (!selectedCustomerId) { resetLoyaltyState(); return; }
  try {
    loyaltyQuote = await window.api.loyalty.redemptionQuote(selectedCustomerId, currentTotal);
  } catch (err) {
    console.error('تعذّر جلب رصيد نقاط الولاء', err);
    loyaltyQuote = null;
  }
  if (!loyaltyQuote || loyaltyQuote.maxRedeemablePoints <= 0) {
    loyaltyRedeemBox.classList.add('hidden');
    loyaltyRedeemedPoints = 0;
    loyaltyPointsInput.value = 0;
    updateLoyaltyHint();
    return;
  }
  loyaltyRedeemBox.classList.remove('hidden');
  loyaltyPointsInput.max = loyaltyQuote.maxRedeemablePoints;
  if (loyaltyRedeemedPoints > loyaltyQuote.maxRedeemablePoints) loyaltyRedeemedPoints = loyaltyQuote.maxRedeemablePoints;
  loyaltyPointsInput.value = loyaltyRedeemedPoints;
  updateLoyaltyHint();
}
function onLoyaltyRedeemChange() {
  let val = Math.floor(parseLocaleNumber(loyaltyPointsInput.value) || 0);
  val = loyaltyQuote ? Math.max(0, Math.min(val, loyaltyQuote.maxRedeemablePoints)) : 0;
  loyaltyRedeemedPoints = val;
  loyaltyPointsInput.value = val;
  if (selectedPaymentMethod() === 'cash' && document.activeElement !== cashReceivedInput) {
    cashReceivedInput.value = effectiveTotal().toFixed(orgMinorUnit);
  }
  updatePaymentView();
}
loyaltyPointsInput.addEventListener('input', onLoyaltyRedeemChange);
loyaltyMaxBtn.addEventListener('click', () => {
  if (!loyaltyQuote) return;
  loyaltyRedeemedPoints = loyaltyQuote.maxRedeemablePoints;
  loyaltyPointsInput.value = loyaltyRedeemedPoints;
  onLoyaltyRedeemChange();
});

customerSearchInput.addEventListener('input', debounce(async () => {
  const term = customerSearchInput.value.trim();
  const seq = ++customerSearchRequestSeq;
  if (!term) { customerResults.classList.add('hidden'); return; }
  try {
    const results = await window.api.customers.list({ search: term, limit: 40 });
    if (seq !== customerSearchRequestSeq || customerSearchInput.value.trim() !== term) return;
    renderCustomerResults(results);
  } catch (err) { if (seq === customerSearchRequestSeq) console.error('Customer search failed', err); }
}, 250));

function renderCustomerResults(results) {
  customerResults.innerHTML = results.length === 0
    ? `<div class="customer-result-empty">${t('pos.noCustomerResults')}</div>`
    : results.map((c) => `<div class="customer-result" data-id="${c.id}">${escapeHtml(c.name || t('common.noName'))} — ${escapeHtml(c.phone || '')} <span class="points-tag">${c.loyalty_points} ${t('common.points')}</span></div>`).join('');
  customerResults.querySelectorAll('.customer-result').forEach((el) => {
    el.addEventListener('click', () => {
      const c = results.find((r) => r.id === parseInt(el.dataset.id, 10));
      selectCustomer(c);
    });
  });
  customerResults.classList.remove('hidden');
}

async function selectCustomer(c) {
  selectedCustomerId = c.id;
  selectedCustomerLabel.textContent = `${c.name || t('common.noName')} — ${c.loyalty_points} ${t('common.points')}`;
  selectedCustomerBox.classList.remove('hidden');
  customerSearchInput.value = '';
  customerResults.classList.add('hidden');
  try { await window.api.tables.setCustomer(currentSaleId, selectedCustomerId); }
  catch (err) { console.error('تعذّر ربط العميل بالطلب', err); }
  updatePaymentView();
  refreshLoyaltyQuote().then(updatePaymentView);
}

clearCustomerBtn.addEventListener('click', async () => {
  selectedCustomerId = null;
  selectedCustomerBox.classList.add('hidden');
  resetLoyaltyState();
  try { await window.api.tables.setCustomer(currentSaleId, null); }
  catch (err) { console.error('تعذّر إزالة العميل من الطلب', err); }
  updatePaymentView();
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

let checkoutBusy = false;
async function checkout() {
  if (cart.length === 0 || checkoutBusy) return;
  checkoutBusy = true;
  try {
    await checkoutInner();
  } finally {
    checkoutBusy = false;
  }
}
async function checkoutInner() {
  // نحفظ آخر تعديلات قبل الدفع. لو فشل الحفظ (نقص مخزون، صلاحية، خطأ قاعدة بيانات...) لا نفتح نافذة الدفع
  // ونعرض السبب للمستخدم، فلا تبقى الواجهة بحالة وهمية (مبلغ معروض لطلب لم يُحفظ).
  let saved;
  try {
    saved = await saveOrder(false);
  } catch (err) {
    showToast(err?.message || t('tableOrder.saveFailed', 'تعذر حفظ الطلب.'), 'error');
    return;
  }
  // المرجع هو إجمالي الباك-إند بعد الحفظ (نفس الحساب الذي سيُتحقَّق منه عند الدفع)؛
  // المعاينة المحلية احتياط فقط إن لم يُرجع الحفظ إجمالياً.
  const preview = sumCartTax(cart, orgMinorUnit);
  currentTotal = Number.isFinite(Number(saved?.grandTotal)) ? Number(saved.grandTotal) : preview.subtotal + preview.tax;

  document.querySelector('input[name="paymentMethod"][value="cash"]').checked = true;
  mixedCashInput.value = '';
  mixedCardInput.value = '';
  paymentError.classList.add('hidden');
  resetLoyaltyState();
  creditApproval = null;
  document.querySelector('input[name="paymentMethod"][value="cash"]').checked = true;
  updatePaymentView();
  if (selectedCustomerId) refreshLoyaltyQuote().then(updatePaymentView);
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

// الدفع الآجل بالطاولات: نفس نمط الاعتماد المستخدَم بالكاشير المباشر تمامًا — يتطلب
// عميلاً مرتبطاً بالطلب مسبقاً (نفس صندوق اختيار العميل المستخدَم لنقاط الولاء)
// وموافقة مدير/مدير عام واحدة لكل عملية اعتماد.
let creditApproval = null;
const tableApprovalModal = document.getElementById('tableApprovalModal');
const tableApprovalUsername = document.getElementById('tableApprovalUsername');
const tableApprovalPassword = document.getElementById('tableApprovalPassword');
const tableApprovalError = document.getElementById('tableApprovalError');
const confirmTableApprovalBtn = document.getElementById('confirmTableApprovalBtn');
const creditNoCustomerHint = document.getElementById('creditNoCustomerHint');

function openTableApprovalModal() {
  tableApprovalUsername.value = ''; tableApprovalPassword.value = '';
  tableApprovalError.classList.add('hidden');
  tableApprovalModal.classList.remove('hidden');
  tableApprovalUsername.focus();
}
document.getElementById('cancelTableApprovalBtn').addEventListener('click', () => {
  tableApprovalModal.classList.add('hidden');
  // رجوع لطريقة دفع افتراضية إن أُلغيت الموافقة دون منح اعتماد فعلي.
  if (!creditApproval) document.querySelector('input[name="paymentMethod"][value="cash"]').checked = true;
  updatePaymentView();
});
confirmTableApprovalBtn.addEventListener('click', async () => {
  const username = tableApprovalUsername.value.trim();
  const password = tableApprovalPassword.value;
  if (!username || !password) { tableApprovalError.textContent = t('pos.enterCredentials'); tableApprovalError.classList.remove('hidden'); return; }
  confirmTableApprovalBtn.disabled = true; confirmTableApprovalBtn.textContent = t('pos.verifying');
  try {
    const result = await window.api.discount.approve(username, password);
    if (!result.approved) { tableApprovalError.textContent = result.message || t('pos.invalidCredentials'); tableApprovalError.classList.remove('hidden'); return; }
    creditApproval = { approverId: result.approverId, approverName: result.approverName, grantId: result.grantId };
    tableApprovalModal.classList.add('hidden');
    updatePaymentView();
  } catch (err) {
    tableApprovalError.textContent = t('pos.verifyError') + err.message; tableApprovalError.classList.remove('hidden');
  } finally {
    confirmTableApprovalBtn.disabled = false; confirmTableApprovalBtn.textContent = t('pos.confirmApproval');
  }
});
document.querySelectorAll('input[name="paymentMethod"]').forEach((el) => {
  el.addEventListener('change', () => {
    if (el.value === 'credit' && el.checked) {
      if (!selectedCustomerId) { creditNoCustomerHint.classList.remove('hidden'); document.querySelector('input[name="paymentMethod"][value="cash"]').checked = true; updatePaymentView(); return; }
      creditNoCustomerHint.classList.add('hidden');
      if (!creditApproval) { openTableApprovalModal(); return; }
    }
    updatePaymentView();
  });
});

function updatePaymentView() {
  const method = selectedPaymentMethod();
  cashFields.classList.toggle('hidden', method !== 'cash');
  mixedFields.classList.toggle('hidden', method !== 'mixed');
  paymentError.classList.add('hidden');
  paymentTotalDisplay.textContent = effectiveTotal().toFixed(orgMinorUnit);
  if (method === 'cash') {
    if (document.activeElement !== cashReceivedInput) cashReceivedInput.value = effectiveTotal().toFixed(orgMinorUnit);
    const received = parseLocaleNumber(cashReceivedInput.value) || 0;
    changeDueDisplay.textContent = Math.max(received - effectiveTotal(), 0).toFixed(orgMinorUnit);
  } else if (method === 'mixed') {
    const cashPart = parseLocaleNumber(mixedCashInput.value) || 0;
    const remaining = effectiveTotal() - cashPart;
    mixedRemainingDisplay.textContent = remaining.toFixed(orgMinorUnit);
    if (!mixedCardInput.value || document.activeElement !== mixedCardInput) {
      mixedCardInput.value = Math.max(remaining, 0).toFixed(orgMinorUnit);
    }
  }
}

document.querySelectorAll('input[name="paymentMethod"]').forEach((el) => el.addEventListener('change', updatePaymentView));
cashReceivedInput.addEventListener('input', updatePaymentView);
mixedCashInput.addEventListener('input', updatePaymentView);
mixedCardInput.addEventListener('input', () => {
  mixedRemainingDisplay.textContent = (
    effectiveTotal() - (parseLocaleNumber(mixedCashInput.value) || 0) - (parseLocaleNumber(mixedCardInput.value) || 0)
  ).toFixed(orgMinorUnit);
});
cancelPaymentBtn.addEventListener('click', closePaymentModal);
confirmPaymentBtn.addEventListener('click', confirmPayment);

async function confirmPayment() {
  const method = selectedPaymentMethod();
  const total = effectiveTotal();
  let cashAmount = 0;
  let cardAmount = 0;
  let changeDue = 0;

  if (method === 'cash') {
    cashAmount = parseLocaleNumber(cashReceivedInput.value) || 0;
    if (cashAmount < total - 0.001) {
      showPaymentError(t('pos.insufficientCash'));
      return;
    }
    changeDue = cashAmount - total;
  } else if (method === 'card') {
    cardAmount = total;
  } else if (method === 'mixed') {
    cashAmount = parseLocaleNumber(mixedCashInput.value) || 0;
    cardAmount = parseLocaleNumber(mixedCardInput.value) || 0;
    if (Math.abs(cashAmount + cardAmount - total) > 0.01) {
      showPaymentError(t('pos.mixedMismatch'));
      return;
    }
  } else if (method === 'credit') {
    if (!selectedCustomerId) { showPaymentError(t('pos.selectCustomerFirst')); return; }
    if (!creditApproval) { openTableApprovalModal(); return; }
  }

  confirmPaymentBtn.disabled = true;
  confirmPaymentBtn.textContent = t('tableOrder.closing');
  try {
    const closeResult = await window.api.tables.close(currentSaleId, {
      paymentMethod: method, cashAmount, cardAmount, changeDue,
      loyaltyPointsToRedeem: selectedCustomerId ? loyaltyRedeemedPoints : 0,
      creditApprovalGrantId: method === 'credit' && creditApproval ? creditApproval.grantId : null,
    });
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

init();
