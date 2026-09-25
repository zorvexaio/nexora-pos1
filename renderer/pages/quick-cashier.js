// شاشة "الكاشير السريع" — بديل كامل لشاشة الكاشير العادية، مبني خصيصاً لمحل لا يملك
// كيبورد ويعمل باللمس فقط (زبون بقالة/سوبرماركت). كل إدخال هنا عبر لوحة أرقام كبيرة
// على الشاشة، وشبكة صور للأصناف الشائعة للإضافة بضغطة واحدة بلا كتابة أي شيء.
//
// عمداً أبسط بكثير من شاشة الكاشير العادية (index.html/pos.js): بدون حزم/عروض،
// خصومات، أو بيع آجل. لكن التسعير النهائي (الضريبة والإجمالي) لا يُحسب هنا أبداً —
// يُطلب دائماً من نفس محرك التسعير في قاعدة البيانات (sale:quote) قبل فتح شاشة
// الدفع، حتى يتطابق المعروض على الشاشة مع ما سيُحفظ فعلياً عند sale:create 100%.

let cart = []; // { productId, name, price, quantity }
let allProducts = [];
let currentCategoryId = null;
let paymentMethod = 'cash';
let globalMinorUnit = 2; // يُحدَّث من الخادم عند التحميل (عدد الخانات العشرية الفعلي لعملة الفرع)
let currentQuote = null; // آخر تسعير مؤكَّد من الخادم لمحتوى السلة الحالي، يُستخدم عند الدفع
const MAX_QTY = 9999; // نفس السقف المستخدم في quantity-buffer.js وpriceItemsFromDatabase على الخادم
function notifyQtyMax() {
  showToast(tf('pos.qtyAccumulationMaximum', { max: MAX_QTY.toLocaleString() }), 'error');
}

const codeInput = document.getElementById('qcCodeInput');
const codeMsg = document.getElementById('qcCodeMsg');
const qtyValueEl = document.getElementById('qcQtyValue');
const grid = document.getElementById('qcProductsGrid');
const categoryTabs = document.getElementById('qcCategoryTabs');
const cartItemsEl = document.getElementById('qcCartItems');
const cartTotalEl = document.getElementById('qcCartTotal');
const checkoutBtn = document.getElementById('qcCheckoutBtn');

const paymentOverlay = document.getElementById('qcPaymentOverlay');
const payTotalEl = document.getElementById('qcPayTotal');
const cashInput = document.getElementById('qcCashInput');
const changeValueEl = document.getElementById('qcChangeValue');
const cashTab = document.getElementById('qcCashTab');
const cardTab = document.getElementById('qcCardTab');
const cashSection = document.getElementById('qcCashSection');
const confirmPayBtn = document.getElementById('qcConfirmPayBtn');
const payKeypadEl = document.getElementById('qcPayKeypad');

let qty = 1;

function fmt(n) {
  return Number(n || 0).toFixed(globalMinorUnit);
}

async function init() {
  const user = await guardPage(null, '../login.html');
  if (!user) return;

  // نجيب عدد الخانات العشرية الحقيقي لعملة الفرع مرة واحدة (تسعير بلا أصناف
  // يكفي، السيرفر يرجّعه دائماً بغض النظر عن السلة) بدل افتراض 2 خانة دائماً.
  try {
    const q = await window.api.sales.quote({ items: [] });
    globalMinorUnit = Number.isInteger(q?.minorUnit) ? q.minorUnit : 2;
  } catch (_) { /* نبقى على الافتراضي 2 إن تعذّر */ }

  await loadCategories();
  await loadProducts();
  renderGrid();
  renderCart();
  buildPayKeypad();

  setupKeypad();

  document.getElementById('qcAddBtn').addEventListener('click', addByCode);
  document.getElementById('qcQtyMinus').addEventListener('click', () => setQty(qty - 1));
  document.getElementById('qcQtyPlus').addEventListener('click', () => setQty(qty + 1));
  codeInput.addEventListener('keydown', (e) => {
    // ماسح الباركود يعمل كلوحة مفاتيح فعلياً ويرسل Enter تلقائياً بعد الرقم —
    // فيضيف الصنف مباشرة دون الحاجة للمس زر "إضافة".
    if (e.key === 'Enter') { e.preventDefault(); addByCode(); }
  });

  checkoutBtn.addEventListener('click', openPayment);
  document.getElementById('qcPaymentBack').addEventListener('click', closePayment);
  cashTab.addEventListener('click', () => setPaymentMethod('cash'));
  cardTab.addEventListener('click', () => setPaymentMethod('card'));
  confirmPayBtn.addEventListener('click', confirmPay);

  focusCodeInput();
}

// حقل الكود يبقى هو الوجهة الافتراضية للتركيز دائماً — لازم يكون فيه تركيز حتى
// يستقبل ماسح الباركود (يعمل كلوحة مفاتيح فعلياً)، سواء عند فتح الصفحة أول مرة
// أو بعد إضافة صنف أو إتمام بيع أو إغلاق شاشة الدفع.
function focusCodeInput() {
  codeInput.focus({ preventScroll: true });
}

// ===== لوحة أرقام إدخال الكود =====
function setupKeypad() {
  document.getElementById('qcKeypad').addEventListener('click', (e) => {
    const btn = e.target.closest('.qc-key');
    if (!btn) return;
    const key = btn.dataset.key;
    if (key === 'clear') codeInput.value = '';
    else if (key === 'back') codeInput.value = codeInput.value.slice(0, -1);
    else codeInput.value += key;
    focusCodeInput();
  });
}

function setQty(v) {
  const rounded = Math.max(1, Math.round(v));
  qty = Math.min(MAX_QTY, rounded);
  if (rounded > MAX_QTY) notifyQtyMax();
  qtyValueEl.textContent = String(qty);
}

async function loadCategories() {
  let cats = [];
  try { cats = (await window.api.categories.list()).filter((c) => !c.pos_hidden); } catch (_) { cats = []; }
  const allBtn = `<button type="button" class="category-tab active" data-cat="">${t('pos.allCategories', 'الكل')}</button>`;
  const catBtns = cats
    .map((c) => `<button type="button" class="category-tab" data-cat="${c.id}">${escapeHtml(c.name)}</button>`)
    .join('');
  categoryTabs.innerHTML = allBtn + catBtns;
  categoryTabs.addEventListener('click', (e) => {
    const btn = e.target.closest('.category-tab');
    if (!btn) return;
    categoryTabs.querySelectorAll('.category-tab').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    currentCategoryId = btn.dataset.cat || null;
    renderGrid();
  });
}

async function loadProducts() {
  try {
    allProducts = await window.api.products.list({ quickCashierOnly: true, limit: 500 });
  } catch (_) {
    allProducts = [];
    showCodeMsg(t('quickCashier.loadError', 'تعذّر تحميل الأصناف — تحقّق من الاتصال وأعد المحاولة'), 'error');
  }
}

function renderGrid() {
  const list = currentCategoryId
    ? allProducts.filter((p) => String(p.category_id) === String(currentCategoryId))
    : allProducts;
  if (!list.length) {
    const msg = currentCategoryId
      ? t('quickCashier.noProducts', 'لا توجد أصناف')
      : t('quickCashier.noProductsSelected', 'لم تُضِف أي صنف لهذه الشاشة بعد. افتح صفحة "المنتجات" وفعّل "إظهار في الكاشير السريع" لكل صنف تريده هنا.');
    grid.innerHTML = `<div class="qc-empty-hint">${msg}</div>`;
    return;
  }
  grid.innerHTML = list
    .map((p) => {
      if (p.image_path) {
        return `
        <div class="product-card qc-tile qc-tile-image" data-id="${p.id}">
          <img src="${escAttr(p.image_path)}" alt="" class="qc-tile-img" />
          <span class="price-badge qc-tile-price">${fmt(p.price)}</span>
          <div class="name qc-tile-caption">${escapeHtml(p.name)}</div>
        </div>`;
      }
      return `
      <div class="product-card qc-tile" data-id="${p.id}">
        <div class="name">${escapeHtml(p.name)}</div>
        <div class="card-meta-row"><span class="price-badge">${fmt(p.price)}</span></div>
      </div>`;
    })
    .join('');
}

grid.addEventListener('click', (e) => {
  const card = e.target.closest('.qc-tile');
  if (!card) return;
  const product = allProducts.find((p) => String(p.id) === card.dataset.id);
  if (product) addProductToCart(product, 1);
});

function showCodeMsg(text, kind) {
  codeMsg.textContent = text;
  codeMsg.className = `qc-code-msg ${kind || ''}`;
  clearTimeout(showCodeMsg._t);
  showCodeMsg._t = setTimeout(() => codeMsg.classList.add('hidden'), 2200);
}

function looksLikeBarcode(text) {
  return /^\d{6,}$/.test(text);
}

async function addByCode() {
  const code = codeInput.value.trim();
  if (!code) return;

  try {
    // 1) تطابق دقيق بالباركود أو رقم SKU فقط — أبداً بحث بالاسم هنا، لأن هذا حقل
    //    كود (لوحة أرقام/ماسح)، ولا داعي لخطر إضافة صنف خاطئ بمطابقة جزئية بالاسم.
    const matches = await window.api.products.list({ search: code, limit: 20 });
    const exact = matches.find((p) => p.barcode === code || p.sku === code);
    if (exact) {
      addProductToCart(exact, qty);
      codeInput.value = '';
      setQty(1);
      focusCodeInput();
      return;
    }

    if (looksLikeBarcode(code)) {
      // 2) باركود GS1 (شائع في السوبرماركت: يحمل وزناً أو سعراً مُرمَّزاً داخل الباركود نفسه)
      const gs1 = await window.api.products.resolveGs1Barcode(code);
      if (gs1 && gs1.product) {
        addProductToCart(gs1.product, qty);
        codeInput.value = '';
        setQty(1);
        focusCodeInput();
        return;
      }

      // 3) باركود ميزان (بيع بالوزن): كود PLU + وزن مُرمَّز — الكمية هنا وزن كسري
      //    (كغم)، فلا نمرّ عبر سلّم الكمية الصحيح العادي في هذه الحالة فقط.
      const weighted = await window.api.products.resolveWeightedBarcode(code);
      if (weighted) {
        addProductToCart(weighted.product, weighted.weightKg);
        codeInput.value = '';
        setQty(1);
        focusCodeInput();
        return;
      }
    }

    showCodeMsg(t('quickCashier.notFound', 'لا يوجد صنف بهذا الكود'), 'error');
    focusCodeInput();
  } catch (err) {
    showCodeMsg((err && err.message) || String(err), 'error');
    focusCodeInput();
  }
}

function addProductToCart(product, addQty) {
  const existing = cart.find((i) => i.productId === product.id);
  if (existing) {
    const next = existing.quantity + addQty;
    existing.quantity = Math.min(MAX_QTY, next);
    if (next > MAX_QTY) notifyQtyMax();
  } else {
    const clamped = Math.min(MAX_QTY, addQty);
    cart.push({ productId: product.id, name: product.name, price: Number(product.price), quantity: clamped });
    if (addQty > MAX_QTY) notifyQtyMax();
  }
  renderCart();
}

function formatQty(q) {
  return Number.isInteger(q) ? String(q) : (Math.round(q * 1000) / 1000).toString();
}

function renderCart() {
  if (!cart.length) {
    cartItemsEl.innerHTML = `<div class="qc-empty-hint">${t('quickCashier.emptyCart', 'السلة فارغة — أدخل كوداً أو اضغط على صورة صنف')}</div>`;
  } else {
    cartItemsEl.innerHTML = cart
      .map(
        (i, idx) => `
      <div class="cart-item qc-cart-item">
        <div class="cart-item-name">${escapeHtml(i.name)}</div>
        <div class="qc-cart-item-row">
          <div class="qc-qty-stepper qc-qty-stepper-sm">
            <button type="button" class="qc-qty-btn" data-act="minus" data-idx="${idx}">−</button>
            <span class="qc-qty-value">${formatQty(i.quantity)}</span>
            <button type="button" class="qc-qty-btn" data-act="plus" data-idx="${idx}">+</button>
          </div>
          <span class="qc-cart-item-total">${fmt(i.price * i.quantity)}</span>
          <button type="button" class="qc-cart-remove" data-act="remove" data-idx="${idx}">🗑</button>
        </div>
      </div>`
      )
      .join('');
  }
  // مجموع تقريبي (بلا ضريبة) لعرض حيّ أثناء البيع فقط — الرقم النهائي الملزم دائماً
  // يُطلب طازجاً من الخادم (sale:quote) عند فتح شاشة الدفع في openPayment().
  const roughTotal = cart.reduce((s, i) => s + i.price * i.quantity, 0);
  cartTotalEl.textContent = fmt(roughTotal);
  checkoutBtn.disabled = cart.length === 0;
  currentQuote = null; // أي تغيير بالسلة يُلغي آخر تسعير مؤكَّد، يُطلب تسعير جديد عند الدفع
}

cartItemsEl.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const idx = Number(btn.dataset.idx);
  const item = cart[idx];
  if (!item) return;
  if (btn.dataset.act === 'plus') {
    if (item.quantity >= MAX_QTY) notifyQtyMax();
    item.quantity = Math.min(MAX_QTY, item.quantity + 1);
  }
  else if (btn.dataset.act === 'minus') item.quantity -= 1;
  else if (btn.dataset.act === 'remove') item.quantity = 0;
  if (item.quantity <= 0) cart.splice(idx, 1);
  renderCart();
});

// ===== الدفع =====
// نطلب تسعيراً طازجاً من نفس محرك التسعير في قاعدة البيانات (وليس حسابنا
// المحلي) — فيتطابق الإجمالي المعروض هنا 100% مع ما سيتحقق منه sale:create.
async function fetchQuote() {
  const items = cart.map((i) => ({ productId: i.productId, quantity: i.quantity }));
  currentQuote = await window.api.sales.quote({ items });
  return currentQuote;
}

async function openPayment() {
  if (!cart.length) return;
  confirmPayBtn.disabled = true;
  try {
    const quote = await fetchQuote();
    globalMinorUnit = Number.isInteger(quote.minorUnit) ? quote.minorUnit : globalMinorUnit;
    payTotalEl.textContent = fmt(quote.grandTotal);
    cashInput.value = fmt(quote.grandTotal);
    buildPayKeypad(); // يعاد بناؤها فقط لو تغيّر عدد الخانات العشرية بين فتحة وأخرى
    setPaymentMethod('cash');
    updateChange();
    paymentOverlay.classList.remove('hidden');
  } catch (err) {
    showCodeMsg((err && err.message) || String(err), 'error');
  } finally {
    confirmPayBtn.disabled = false;
  }
}

function closePayment() {
  paymentOverlay.classList.add('hidden');
  focusCodeInput();
}

function setPaymentMethod(method) {
  paymentMethod = method;
  cashTab.classList.toggle('active', method === 'cash');
  cardTab.classList.toggle('active', method === 'card');
  cashSection.classList.toggle('hidden', method === 'card');
  if (method === 'card' && currentQuote) cashInput.value = fmt(currentQuote.grandTotal);
  updateChange();
}

// لوحة أرقام الدفع تُبنى ديناميكياً حسب عدد خانات العملة العشرية: زر الفاصلة
// يظهر فقط لعملة تقبل كسوراً (خانتان/ثلاث)، ويختفي تماماً لعملة بلا كسور (مثل
// الين الياباني أو الدينار العراقي)، حتى لا يكتب الكاشير رقماً لا معنى له.
function buildPayKeypad() {
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];
  let html = keys.map((k) => `<button type="button" class="qc-key" data-paykey="${k}">${k}</button>`).join('');
  html += `<button type="button" class="qc-key qc-key-clear" data-paykey="clear">${t('quickCashier.clearBtn', 'مسح')}</button>`;
  html += `<button type="button" class="qc-key" data-paykey="0">0</button>`;
  if (globalMinorUnit > 0) {
    html += `<button type="button" class="qc-key" data-paykey="dot">.</button>`;
  }
  html += `<button type="button" class="qc-key qc-key-back" data-paykey="back">⌫</button>`;
  payKeypadEl.innerHTML = html;
}

payKeypadEl.addEventListener('click', (e) => {
  const btn = e.target.closest('.qc-key');
  if (!btn) return;
  const key = btn.dataset.paykey;
  let v = cashInput.value;
  if (key === 'clear') v = '';
  else if (key === 'back') v = v.slice(0, -1);
  else if (key === 'dot') { if (!v.includes('.')) v += '.'; }
  else v += key;
  cashInput.value = v;
  updateChange();
});

function updateChange() {
  const total = Number(currentQuote?.grandTotal || 0);
  const received = parseLocaleNumber(cashInput.value) || 0;
  const change = Math.max(0, received - total);
  changeValueEl.textContent = fmt(change);
}

async function confirmPay() {
  if (!currentQuote) return;
  const total = Number(currentQuote.grandTotal || 0);
  const received = paymentMethod === 'cash' ? (parseLocaleNumber(cashInput.value) || 0) : total;
  if (paymentMethod === 'cash' && received < total - 0.5 / Math.pow(10, globalMinorUnit)) {
    showCodeMsg(t('quickCashier.insufficientCash', 'المبلغ المستلم أقل من الإجمالي'), 'error');
    return;
  }
  confirmPayBtn.disabled = true;
  confirmPayBtn.textContent = '...';
  try {
    const sale = {
      items: cart.map((i) => ({ productId: i.productId, quantity: i.quantity })),
      paymentMethod,
      cashAmount: paymentMethod === 'cash' ? received : 0,
      cardAmount: paymentMethod === 'card' ? total : 0,
      changeDue: paymentMethod === 'cash' ? Math.max(0, received - total) : 0,
      clientRequestId: `qc-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    };
    const result = await window.api.sales.create(sale);
    showToast(`${t('quickCashier.saleDone', 'تمت عملية البيع')}${result?.invoiceNumber ? ` #${result.invoiceNumber}` : ''}`);
    // نبّه الكاشير فوراً لو الطباعة التلقائية فشلت (نفس تنبيه شاشة الكاشير الرئيسية)
    // بدل ما يفشل الأمر بصمت وما يعرفش الزبون ليه ما طلعتلوش فاتورة ورقية.
    const po = result?.printOutcome;
    if (po?.kitchen && po.kitchen.success === false) showToast(`⚠️ ${t('quickCashier.kitchenPrintFailed', 'لم تُطبع تذكرة المطبخ')}: ${po.kitchen.reason || t('common.unknownError', 'خطأ غير معروف')}`, 'error');
    if (po?.receipt && po.receipt.success === false) showToast(`⚠️ ${t('quickCashier.receiptPrintFailed', 'لم تُطبع الفاتورة')}: ${po.receipt.reason || t('common.unknownError', 'خطأ غير معروف')}`, 'error');
    cart = [];
    currentQuote = null;
    renderCart();
    closePayment();
    await loadProducts(); // تحديث المخزون المعروض إن كان أي صنف يتتبّع كمية
    renderGrid();
  } catch (err) {
    showCodeMsg((err && err.message) || String(err), 'error');
    showToast((err && err.message) || String(err), 'error');
  } finally {
    confirmPayBtn.disabled = false;
    confirmPayBtn.textContent = t('quickCashier.confirmPay', 'تأكيد الدفع');
  }
}

document.addEventListener('DOMContentLoaded', init);
