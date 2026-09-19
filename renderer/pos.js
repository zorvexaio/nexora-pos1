let products = [];
let cart = []; // { lineId, productId, name, price, taxRate, quantity, notes }
let nextLineId = 1;
let maxCashierDiscountPercent = 10;
let discountApproval = null; // { approverId, approverName } يُملأ بعد موافقة مدير على خصم متجاوز
let creditApproval = null;
let approvalPurpose = 'discount';
let pendingRemoveLineId = null; // السطر المطلوب حذفه من السلة بانتظار اعتماد مدير (للكاشير فقط)
let currentUser = null;
let activeBundles = []; // الحزم الفعّالة، تُجلب مرة واحدة وتُطابَق مع السلة محلياً بكل تغيير
let currencyConfig = { base: 'USD', secondary: '', rate: 1 };
let currentBranchType = 'general';
let productSearchRequestSeq = 0;
let customerSearchRequestSeq = 0;
let draftSaveTimer = null;

/* ---------------- حفظ تلقائي للسلة (منع فقدان البيانات عند إغلاق غير متوقع) ----------------
   نخزّن بـ localStorage (يبقى على القرص بين مرات التشغيل، بعكس متغيرات JS بالذاكرة).
   المفتاح مربوط بمعرّف المستخدم حتى لا يرى كاشير مسودة كاشير آخر على نفس الجهاز. */
function draftKey() {
  return currentUser ? `pos_cart_draft_${currentUser.id}` : null;
}

function persistDraftCartNow() {
  const key = draftKey();
  if (!key) return;
  if (cart.length === 0) {
    localStorage.removeItem(key);
    return;
  }
  const draft = {
    cart,
    orderType: selectedOrderType(),
    deliveryFee: deliveryFeeInput.value,
    deliveryDistanceKm: deliveryDistanceInput.value,
    deliveryPerson: deliveryPersonInput.value,
    deliveryTimeMode: selectedDeliveryTimeMode(),
    deliveryCustomTime: deliveryCustomTimeInput.value,
    orderNote: orderNoteInput.value,
    discountType: discountTypeSelect.value,
    discountValue: discountValueInput.value,
    selectedCustomerId,
    savedAt: new Date().toISOString(),
  };
  try { localStorage.setItem(key, JSON.stringify(draft)); } catch { /* الحفظ مجرد شبكة أمان */ }
}

function saveDraftCart() {
  clearTimeout(draftSaveTimer);
  draftSaveTimer = setTimeout(persistDraftCartNow, 300);
}

window.addEventListener('pagehide', () => { clearTimeout(draftSaveTimer); persistDraftCartNow(); });

function clearDraftCart() {
  const key = draftKey();
  if (key) localStorage.removeItem(key);
}

function restoreDraftIfAny() {
  const key = draftKey();
  if (!key) return;
  let draft;
  try {
    draft = JSON.parse(localStorage.getItem(key));
  } catch {
    localStorage.removeItem(key);
    return;
  }
  if (!draft || !Array.isArray(draft.cart) || draft.cart.length === 0) return;

  cart = draft.cart;
  const savedOrderType = draft.orderType === 'in_store' ? 'takeaway' : draft.orderType;
  const savedOrderOption = document.querySelector(`input[name="orderType"][value="${savedOrderType}"]`);
  if (savedOrderOption) savedOrderOption.checked = true;
  deliveryFields.classList.toggle('hidden', draft.orderType !== 'delivery');
  deliveryDistanceInput.value = draft.deliveryDistanceKm || '';
  deliveryFeeInput.value = draft.deliveryFee || 0;
  deliveryPersonInput.value = draft.deliveryPerson || '';
  const savedTimeMode = document.querySelector(`input[name="deliveryTimeMode"][value="${draft.deliveryTimeMode === 'custom' ? 'custom' : 'now'}"]`);
  if (savedTimeMode) savedTimeMode.checked = true;
  deliveryCustomTimeInput.value = draft.deliveryCustomTime || '';
  deliveryCustomTimeInput.classList.toggle('hidden', draft.deliveryTimeMode !== 'custom');
  orderNoteInput.value = draft.orderNote || '';
  updateDeliveryDistanceHint();
  discountTypeSelect.value = draft.discountType || 'none';
  discountValueInput.disabled = discountTypeSelect.value === 'none';
  discountValueInput.value = draft.discountValue || 0;
  selectedCustomerId = draft.selectedCustomerId || null;
  renderCart();
  showDraftRestoredNotice(draft.savedAt);
}

function showDraftRestoredNotice(savedAt) {
  const bar = document.createElement('div');
  bar.className = 'draft-restored-notice';
  bar.style.cssText =
    'background:#fff3cd;color:#664d03;padding:10px 14px;border-radius:8px;margin-bottom:10px;' +
    'display:flex;justify-content:space-between;align-items:center;gap:10px;font-size:14px;';
  const lang = document.documentElement.getAttribute('data-lang') || 'ar';
  bar.innerHTML = `
    <span>${t('pos.draftRestored')} (${new Date(savedAt).toLocaleString(lang)}).</span>
    <button type="button" style="white-space:nowrap;">${t('pos.discardDraft')}</button>
  `;
  bar.querySelector('button').addEventListener('click', () => {
    cart = [];
    resetOrderExtras();
    clearDraftCart();
    renderCart();
    pendingSaleRequestId = null;
    bar.remove();
  });
  cartItemsEl.parentElement.insertBefore(bar, cartItemsEl);
}

const deliveryFields = document.getElementById('deliveryFields');
const deliveryDistanceInput = document.getElementById('deliveryDistanceInput');
const deliveryDistanceHint = document.getElementById('deliveryDistanceHint');
const deliveryFeeInput = document.getElementById('deliveryFeeInput');
const deliveryPersonInput = document.getElementById('deliveryPersonInput');
const deliveryCustomTimeInput = document.getElementById('deliveryCustomTimeInput');
const orderNoteInput = document.getElementById('orderNoteInput');
let deliveryPricingConfig = { defaultFee: 0, pricePerKm: 0 };

function selectedDeliveryTimeMode() {
  const el = document.querySelector('input[name="deliveryTimeMode"]:checked');
  return el ? el.value : 'now';
}
// يرجع وقت التسليم كـISO datetime كامل (اليوم + الوقت المختار)، أو null لو "الآن".
// يملأ قائمة اقتراحات اسم مندوب التوصيل من الأسماء المكتوبة يدوياً سابقاً -
// أول مرة يكتب اسم جديد، هيُقترح تلقائياً من المرة الجاية بمجرد إعادة تحميل
// الشاشة (بعد نجاح البيع، أو فتح الشاشة من جديد).
async function loadDeliveryPersonSuggestions() {
  try {
    const names = await window.api.sales.knownDeliveryPersons();
    const list = document.getElementById('deliveryPersonList');
    if (list) list.innerHTML = names.map((n) => `<option value="${escapeHtml(n)}"></option>`).join('');
  } catch (_) { /* اقتراح تكميلي فقط، لا نزعج المستخدم لو فشل */ }
}

function computeDeliveryTimeIso() {
  if (selectedDeliveryTimeMode() !== 'custom' || !deliveryCustomTimeInput.value) return null;
  const [h, m] = deliveryCustomTimeInput.value.split(':').map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  // لو الوقت المختار فات فعلاً النهاردة (مثلاً الساعة 2 ظهر واختار 9 صباحاً)، غالباً
  // يقصد بكرة الصبح مش قبل شوية — نفترض اليوم التالي بدل تسجيل وقت في الماضي.
  if (d.getTime() < Date.now()) d.setDate(d.getDate() + 1);
  return d.toISOString();
}

// لو الكاشير أدخل مسافة، الرسوم = المسافة × سعر الكيلومتر (من الإعدادات) أوتوماتيكياً.
// لو مسح المسافة، ترجع الرسوم للسعر الثابت الافتراضي. القيمة تفضل قابلة للتعديل اليدوي
// بعد الحساب لو الكاشير عايز يستثني حالة معينة.
function applyDeliveryDistancePricing() {
  const km = parseLocaleNumber(deliveryDistanceInput.value);
  if (km > 0) deliveryFeeInput.value = (Math.round(km * deliveryPricingConfig.pricePerKm * 100) / 100).toFixed(2);
  else deliveryFeeInput.value = deliveryPricingConfig.defaultFee.toFixed(2);
  updateDeliveryDistanceHint();
  renderCart();
}
function updateDeliveryDistanceHint() {
  if (!deliveryDistanceHint) return;
  deliveryDistanceHint.textContent = `سعر الكيلومتر: ${deliveryPricingConfig.pricePerKm.toFixed(2)} — السعر الثابت بدون مسافة: ${deliveryPricingConfig.defaultFee.toFixed(2)}`;
}
const discountTypeSelect = document.getElementById('discountTypeSelect');
const discountValueInput = document.getElementById('discountValueInput');
const discountApprovalNote = document.getElementById('discountApprovalNote');
const discountRow = document.getElementById('discountRow');
const bundleDiscountRow = document.getElementById('bundleDiscountRow');
const bundleDiscountLabel = document.getElementById('bundleDiscountLabel');
const deliveryRow = document.getElementById('deliveryRow');
const sumDiscount = document.getElementById('sumDiscount');
const sumBundleDiscount = document.getElementById('sumBundleDiscount');
const sumDelivery = document.getElementById('sumDelivery');

const productsGrid = document.getElementById('productsGrid');
const searchInput = document.getElementById('searchInput');
const cartItemsEl = document.getElementById('cartItems');
const sumSubtotal = document.getElementById('sumSubtotal');
const sumTax = document.getElementById('sumTax');
const sumTotal = document.getElementById('sumTotal');
const checkoutBtn = document.getElementById('checkoutBtn');
const branchNameEl = document.getElementById('branchName');

async function init() {
  const user = await guardPage(null, 'login.html');
  if (!user) return;
  window.currentPosUser = user;
  currentUser = user;

  // ملاحظة: إجبار تغيير كلمة المرور الافتراضية صار يُدار مركزياً من common.js
  // (setupChangePasswordButton) بحيث يعمل على كل الصفحات وليس شاشة الكاشير فقط.

  const branch = await window.api.branches.current();
  branchNameEl.textContent = branch ? branch.name : '';
  currentBranchType = branch ? branch.business_type || 'general' : 'general';
  currencyConfig = await window.api.currency.get();
  await showSetupIfRequired();

  maxCashierDiscountPercent = await window.api.discount.maxCashierPercent();
  activeBundles = await window.api.bundles.listActive();
  deliveryPricingConfig = await window.api.delivery.getPricing();
  updateDeliveryDistanceHint();
  loadDeliveryPersonSuggestions();

  await loadProducts();
  initCategoryTabs();
  restoreDraftIfAny();

  searchInput.addEventListener('input', debounce(() => loadProducts(searchInput.value), 325));
  searchInput.addEventListener('input', hideBarcodeError);
  searchInput.addEventListener('keydown', handleSearchKeydown);
  checkoutBtn.addEventListener('click', checkout);
  document.addEventListener('keydown', (event) => {
    const tag = event.target?.tagName;
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !event.target.closest('form')) { event.preventDefault(); checkout(); }
    if (event.key === 'F2' && !['INPUT','TEXTAREA','SELECT'].includes(tag)) { event.preventDefault(); searchInput.focus(); searchInput.select(); }
  });

  document.querySelectorAll('input[name="orderType"]').forEach((el) =>
    el.addEventListener('change', () => {
      const isDelivery = selectedOrderType() === 'delivery';
      deliveryFields.classList.toggle('hidden', !isDelivery);
      // فور فتح "توصيل" لأول مرة (مفيش مسافة متسجلة)، نظهر السعر الثابت الافتراضي فوراً.
      if (isDelivery && !deliveryDistanceInput.value) deliveryFeeInput.value = deliveryPricingConfig.defaultFee.toFixed(2);
      renderCart();
    })
  );
  deliveryDistanceInput.addEventListener('input', applyDeliveryDistancePricing);
  deliveryFeeInput.addEventListener('input', renderCart);
  document.querySelectorAll('input[name="deliveryTimeMode"]').forEach((el) =>
    el.addEventListener('change', () => {
      deliveryCustomTimeInput.classList.toggle('hidden', selectedDeliveryTimeMode() !== 'custom');
    })
  );
  discountTypeSelect.addEventListener('change', () => {
    discountValueInput.disabled = discountTypeSelect.value === 'none';
    if (discountTypeSelect.value === 'none') discountValueInput.value = 0;
    discountApproval = null;
    renderCart();
  });
  discountValueInput.addEventListener('input', () => {
    discountApproval = null;
    renderCart();
  });

  // نعيد جلب الحزم الفعّالة عند رجوع التركيز لنافذة الكاشير (مثلاً بعد إضافة/تعديل/تفعيل
  // حزمة من صفحة "الحزم" بنافذة أو تبويب آخر بينما شاشة الكاشير كانت مفتوحة أصلاً) — وإلا
  // تضل الحزمة الجديدة غير محسوبة بالكاشير لحد ما يُعاد تحميل الصفحة يدوياً بالكامل. نضيف
  // كمان تحديثاً دورياً كل ٣ دقائق كخط دفاع ثانٍ لأي حالة نادرة ما ياخد فيها حدث التركيز.
  window.addEventListener('focus', refreshActiveBundles);
  setInterval(refreshActiveBundles, 3 * 60 * 1000);
}

async function refreshActiveBundles() {
  try {
    const hadOffersTabCandidate = activeBundles.length > 0;
    activeBundles = await window.api.bundles.listActive();
    // إعادة بناء تبويبات الأقسام فقط لو تغيّرت وجود/غياب حزم نشطة (ظهور أو اختفاء
    // تبويب "العروض")، تفادياً لإعادة رسم الشريط كامل كل ٣ دقائق بلا داعٍ.
    if (hadOffersTabCandidate !== (activeBundles.length > 0)) initCategoryTabs();
    renderProducts();
    renderCart();
  } catch {
    // فشل صامت: لا نكسر الكاشير لمجرد فشل تحديث خلفي للحزم؛ سيُعاد المحاولة بالتحديث القادم.
  }
}

function showPasswordChangeModal() {
  const modal = document.getElementById('passwordChangeModal');
  const form = document.getElementById('passwordChangeForm');
  modal.classList.remove('hidden');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const currentPassword = document.getElementById('currentPasswordInput').value;
    const newPassword = document.getElementById('newPasswordInput').value;
    const confirmPassword = document.getElementById('confirmPasswordInput').value;
    const error = document.getElementById('passwordChangeError');
    error.classList.add('hidden');
    if (newPassword !== confirmPassword) { error.textContent = t('pos.passwordMismatch'); error.classList.remove('hidden'); return; }
    try {
      await window.api.auth.changeOwnPassword({ currentPassword, newPassword });
      currentUser.must_change_password = 0;
      modal.classList.add('hidden');
    } catch (err) { error.textContent = err.message; error.classList.remove('hidden'); }
  });
}

async function showSetupIfRequired() {
  if (!currentUser || currentUser.role !== 'admin') return;
  if (!(await window.api.setup.isRequired())) return;
  const modal = document.getElementById('setupModal');
  modal.classList.remove('hidden');
  document.querySelectorAll('[data-business-type]').forEach((button) => button.addEventListener('click', async () => {
    button.disabled = true;
    try { await window.api.setup.complete(button.dataset.businessType); window.location.reload(); }
    catch (error) { alert(t('pos.setupSaveError') + error.message); button.disabled = false; }
  }));
}

function selectedOrderType() {
  return document.querySelector('input[name="orderType"]:checked').value;
}

let selectedCategoryId = null;
// رمز خاص (وليس رقم فئة حقيقي من قاعدة البيانات) لتبويب "العروض" — عند اختياره
// تُعرض الحزم النشطة فقط بدل جلب منتجات بفئة معيّنة.
const OFFERS_CATEGORY_ID = '__offers__';
let offersCategoryEnabled = true;

// نقطة تنبيه صغيرة على تبويب "العروض" لو فيه عرض نشط لسا ما فتح الكاشير تبويب
// العروض من وقت ما ظهر — تُحفظ محلياً بهذا الجهاز فقط (لا تحتاج قاعدة بيانات)،
// وتختفي بمجرد ما يضغط الكاشير على التبويب نفسه.
const OFFERS_SEEN_KEY = 'nexora_pos_seen_offer_ids';
function getSeenOfferIds() {
  try { return new Set(JSON.parse(localStorage.getItem(OFFERS_SEEN_KEY) || '[]')); } catch { return new Set(); }
}
function markOffersSeen(ids) {
  try { localStorage.setItem(OFFERS_SEEN_KEY, JSON.stringify(ids)); } catch { /* تجاهل: مجرد تفضيل عرض محلي */ }
}
const categoryTabs = document.getElementById('categoryTabs');
const categoryTabsWrap = document.getElementById('categoryTabsWrap');
const catScrollLeftBtn = document.getElementById('catScrollLeft');
const catScrollRightBtn = document.getElementById('catScrollRight');
const qtyBufferInput = document.getElementById('qtyBufferInput');
const qtyBufferStatus = document.getElementById('qtyBufferStatus');
const { MAX_QUANTITY, parseQuickQuantity, canAccumulateQuantity } = window.quantityBuffer;

function quantityBufferText(key, values = {}) {
  return t(key).replace(/\{(\w+)\}/g, (_match, name) => String(values[name] ?? ''));
}

function quantityBufferMessage(result) {
  if (result?.reason === 'maximum') return quantityBufferText('pos.qtyMaximum', { max: MAX_QUANTITY.toLocaleString() });
  return quantityBufferText('pos.qtyInvalid');
}

function updateQuantityBufferStatus(result = parseQuickQuantity(qtyBufferInput?.value)) {
  if (!qtyBufferStatus) return result;
  if (result.ok) {
    qtyBufferStatus.textContent = quantityBufferText('pos.qtyWillAdd', { quantity: result.quantity });
    qtyBufferStatus.classList.remove('is-error');
  } else {
    qtyBufferStatus.textContent = quantityBufferMessage(result);
    qtyBufferStatus.classList.add('is-error');
  }
  return result;
}

function resetQuantityBuffer() {
  if (!qtyBufferInput) return;
  qtyBufferInput.value = '1';
  updateQuantityBufferStatus({ ok: true, quantity: 1 });
}

qtyBufferInput?.addEventListener('focus', () => qtyBufferInput.select());
qtyBufferInput?.addEventListener('input', () => updateQuantityBufferStatus());
qtyBufferInput?.addEventListener('blur', () => {
  const result = parseQuickQuantity(qtyBufferInput.value);
  if (!result.ok) resetQuantityBuffer();
  else if (qtyBufferInput.value !== String(result.quantity)) qtyBufferInput.value = String(result.quantity);
});
updateQuantityBufferStatus({ ok: true, quantity: 1 });

// تبويبات الفئات: شريط أفقي بعرض ثابت لكل تبويب (زي تبويبات المتصفح) — كل فئة تظهر
// دائماً، سواء أكان عندها صورة مرفوعة أم لا. لو فيه فئات أكتر من عرض الشاشة يظهر
// تمرير أفقي (عجلة الماوس أو أزرار سهم) بدل ما تلتف الأقسام لسطر ثانٍ وتاكل مساحة
// شبكة المنتجات. الفئة بلا صورة تاخد أيقونة حرف بلون ثابت (مشتق من اسمها) بدل حرف
// عشوائي على خلفية رمادية، حتى تبقى متّسقة بصرياً مع تبويبات الصور المجاورة لها.
const CATEGORY_CHIP_PALETTE = [
  ['#4338ca', '#6a5cf5'], ['#0f766e', '#14b8a6'], ['#b45309', '#f59e0b'],
  ['#be123c', '#fb7185'], ['#1d4ed8', '#60a5fa'], ['#7e22ce', '#c084fc'],
  ['#15803d', '#4ade80'], ['#a16207', '#eab308'], ['#0e7490', '#22d3ee'],
];
function categoryChipGradient(seed) {
  let hash = 0;
  const s = String(seed || '');
  for (let i = 0; i < s.length; i += 1) hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
  const [from, to] = CATEGORY_CHIP_PALETTE[hash % CATEGORY_CHIP_PALETTE.length];
  return `linear-gradient(135deg, ${from}, ${to})`;
}

// أيقونة تمثيلية لصنف/قسم بلا صورة مرفوعة: نطابق كلمات شائعة بأسماء الأصناف
// العربية مع إيموجي مناسب، بدل حرف واحد بلا دلالة. هدفها تسريع التعرّف البصري
// للكاشير (يلقط الصنف من شكله قبل ما يقرأ الاسم كامل)، مش بديل عن صورة حقيقية —
// لو رُفعت صورة فعلية للمنتج/القسم لاحقاً هي الأولى دائماً (انظر renderProducts).
const ITEM_ICON_KEYWORDS = [
  ['🍗', ['فروج', 'دجاج', 'بروستد', 'تكة', 'طاووق']],
  ['🌯', ['شاورما', 'شاوما', 'لفة', 'لفه']],
  ['🍢', ['مشاوي', 'كباب', 'كفتة', 'كفته', 'شيش', 'لحم', 'لحمة', 'لحمه']],
  ['🥤', ['كولا', 'بيبسي', 'عصير', 'مشروب', 'مياه', 'ماء', 'فانتا', 'سفن']],
  ['🍕', ['بيتزا']],
  ['🍔', ['برجر', 'همبرغر', 'همبرجر']],
  ['🍟', ['بطاطا', 'بطاطس', 'فرايز']],
  ['🥗', ['سلطة', 'سلطه']],
  ['🍰', ['كيك', 'حلا', 'حلويات', 'حلويات', 'بقلاوة', 'كنافة']],
  ['☕', ['قهوة', 'نسكافيه', 'اسبريسو', 'إسبريسو']],
  ['🍵', ['شاي']],
  ['🍞', ['خبز', 'صامولي', 'صامولى']],
  ['🐟', ['سمك']],
  ['🍳', ['بيض', 'فطور', 'فطار']],
  ['🍚', ['رز', 'أرز', 'ارز']],
  ['🍦', ['ايس كريم', 'آيس كريم', 'بوظة', 'بوظه']],
];
function guessItemIcon(name) {
  const n = String(name || '');
  for (const [icon, words] of ITEM_ICON_KEYWORDS) {
    if (words.some((w) => n.includes(w))) return icon;
  }
  return n.trim().charAt(0) || '🍽️';
}

async function initCategoryTabs() {
  try {
    const allCategories = await window.api.categories.list();
    // فئة مخفيّة (pos_hidden) تبقى موجودة بمنتجاتها كاملة — فقط تبويبها السريع يختفي
    // من شريط الكاشير، حتى يقدر صاحب المحل يخفي أي فئة نادرة الاستخدام بضغطة واحدة
    // من الإعدادات دون حذفها أو التأثير على منتجاتها.
    const categories = allCategories.filter((c) => !c.pos_hidden);
    try {
      offersCategoryEnabled = (await window.api.pos.offersCategoryEnabled()).enabled !== false;
    } catch { offersCategoryEnabled = true; }
    // تبويب "العروض" يظهر فقط لو فيه حزم نشطة فعلاً ولم يُلغِه المدير من الإعدادات —
    // بدون هذا الشرط كان تبويب الحزم يختلط بكل الفئات الأخرى بدل أن يكون قسماً قائماً بذاته.
    const showOffersTab = offersCategoryEnabled && activeBundles.length > 0;
    if (!categories.length && !showOffersTab) { categoryTabsWrap.classList.add('hidden'); return; }
    categoryTabsWrap.classList.remove('hidden');
    const allTab = `<button type="button" class="category-tab active" data-cat="">
      <span class="category-tab-icon" style="background:${categoryChipGradient('__all__')}">🍽️</span>
      <span class="category-tab-label">${t('pos.allCategories', 'الكل')}</span>
    </button>`;
    let offersImagePath = null;
    if (showOffersTab) {
      try { offersImagePath = (await window.api.pos.offersCategoryImage()).imagePath || null; } catch { offersImagePath = null; }
    }
    const seenOfferIds = getSeenOfferIds();
    const hasUnseenOffer = showOffersTab && activeBundles.some((b) => !seenOfferIds.has(b.id));
    const offersTab = showOffersTab ? `
      <button type="button" class="category-tab category-tab-offers" data-cat="${OFFERS_CATEGORY_ID}">
        <span class="category-tab-thumb-wrap">
          ${offersImagePath
            ? `<img class="category-tab-thumb" src="${escapeHtml(offersImagePath)}" alt="" loading="lazy" draggable="false" />`
            : `<span class="category-tab-icon" style="background:linear-gradient(135deg, var(--brand-gold), #e6c876)">📦</span>`}
          ${hasUnseenOffer ? '<span class="offer-new-dot" title="عرض جديد"></span>' : ''}
        </span>
        <span class="category-tab-label">${ts('العروض')}</span>
      </button>
    ` : '';
    const tabs = categories.map((c) => `
      <button type="button" class="category-tab" data-cat="${c.id}">
        ${c.image_path
          ? `<img class="category-tab-thumb" src="${escapeHtml(c.image_path)}" alt="" loading="lazy" draggable="false" />`
          : `<span class="category-tab-icon" style="background:${categoryChipGradient(c.id ?? c.name)}">${escapeHtml(guessItemIcon(c.name))}</span>`}
        <span class="category-tab-label">${escapeHtml(c.name)}</span>
      </button>
    `).join('');
    categoryTabs.innerHTML = allTab + offersTab + tabs;
    categoryTabs.querySelectorAll('.category-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        categoryTabs.querySelectorAll('.category-tab').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        selectedCategoryId = btn.dataset.cat || null;
        if (selectedCategoryId === OFFERS_CATEGORY_ID) {
          // الكاشير فتح تبويب العروض فعلياً: نعتبر كل العروض الحالية "مشاهَدة" ونخفي نقطة التنبيه.
          markOffersSeen(activeBundles.map((b) => b.id));
          btn.querySelector('.offer-new-dot')?.remove();
        }
        loadProducts(searchInput.value);
        btn.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
      });
    });
    // صورة تعذّر تحميلها (ملف محذوف/مسار خاطئ): نرجع لأيقونة الحرف الملوّنة بدل مربع فارغ.
    categoryTabs.querySelectorAll('img.category-tab-thumb').forEach((img) => {
      img.addEventListener('error', () => {
        const btn = img.closest('.category-tab');
        const isOffers = btn?.dataset.cat === OFFERS_CATEGORY_ID;
        const name = btn?.querySelector('.category-tab-label')?.textContent || '';
        const icon = document.createElement('span');
        icon.className = 'category-tab-icon';
        icon.style.background = isOffers ? 'linear-gradient(135deg, var(--brand-gold), #e6c876)' : categoryChipGradient(btn?.dataset.cat || name);
        icon.textContent = isOffers ? '📦' : guessItemIcon(name);
        img.replaceWith(icon);
      }, { once: true });
    });
    initCategoryTabsScroll();
  } catch (err) { console.error('تعذّر تحميل تبويبات الفئات', err); }
}

// تمرير شريط الأقسام: عجلة الماوس العمودية تُترجم لتمرير أفقي، وزرّا السهم يظهران
// فقط لو فيه محتوى مخفي بتلك الجهة، ويختفيان تلقائياً لو الأقسام تتسع للعرض كله —
// بالضبط زي شريط تبويبات المتصفح، بدل ما يبقيا ظاهرين دائماً بلا داعٍ.
let categoryScrollBound = false;
function initCategoryTabsScroll() {
  updateCategoryScrollButtons();
  if (categoryScrollBound) return;
  categoryScrollBound = true;
  categoryTabs.addEventListener('wheel', (e) => {
    if (categoryTabs.scrollWidth <= categoryTabs.clientWidth) return;
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
    e.preventDefault();
    categoryTabs.scrollLeft += e.deltaY;
  }, { passive: false });
  categoryTabs.addEventListener('scroll', updateCategoryScrollButtons);
  window.addEventListener('resize', updateCategoryScrollButtons);
  // "لخلف" (catScrollLeftBtn) و"لقدّام" (catScrollRightBtn) بمعنى منطقي (بداية/نهاية
  // شريط الأقسام)، مش بمعنى فيزيائي — الاتجاه الفعلي (يمين/يسار) بيتحدد تلقائياً حسب
  // اتجاه الصفحة عبر inset-inline-start/end بالـ CSS. متصفح Chromium يستخدم قيمة
  // scrollLeft سالبة بواجهات RTL، فنعكس إشارة التمرير بس بهالحالة.
  const scrollToward = (end) => {
    const rtl = document.dir === 'rtl';
    const amount = categoryTabs.clientWidth * 0.8;
    const delta = end === rtl ? -amount : amount;
    categoryTabs.scrollBy({ left: delta, behavior: 'smooth' });
  };
  catScrollLeftBtn.addEventListener('click', () => scrollToward(false));
  catScrollRightBtn.addEventListener('click', () => scrollToward(true));
}

function updateCategoryScrollButtons() {
  const el = categoryTabs;
  const overflowing = el.scrollWidth > el.clientWidth + 2;
  categoryTabsWrap.classList.toggle('no-scroll-btns', !overflowing);
  if (!overflowing) {
    catScrollLeftBtn.classList.add('hidden');
    catScrollRightBtn.classList.add('hidden');
    return;
  }
  // نطبّع scrollLeft بقيمة مطلقة لأن Chromium يُرجعه سالباً بواجهات RTL — القيمة
  // المطلقة هنا تمثّل دائماً "المسافة من بداية الشريط منطقياً" بغض النظر عن الاتجاه.
  const maxScroll = el.scrollWidth - el.clientWidth;
  const pos = Math.abs(el.scrollLeft);
  const atStart = pos <= 2;
  const atEnd = pos >= maxScroll - 2;
  catScrollLeftBtn.classList.toggle('hidden', atStart);
  catScrollRightBtn.classList.toggle('hidden', atEnd);
}

async function loadProducts(search = '') {
  const seq = ++productSearchRequestSeq;
  // تبويب "العروض": يعرض الحزم النشطة فقط، بلا أي طلب منتجات بفئة وهمية غير
  // موجودة فعلياً بقاعدة البيانات — إلا لو الكاشير يبحث/يمسح باركود، فوقتها البحث
  // يبقى شاملاً كل المنتجات بغض النظر عن التبويب المفتوح.
  if (selectedCategoryId === OFFERS_CATEGORY_ID && !search) {
    productsGrid.removeAttribute('aria-busy');
    products = [];
    renderProducts();
    return;
  }
  productsGrid.setAttribute('aria-busy', 'true');
  if (!products.length) setPageLoading(productsGrid, true, t('common.loading', 'جارٍ التحميل...'));
  try {
    const effectiveCategoryId = selectedCategoryId === OFFERS_CATEGORY_ID ? undefined : (selectedCategoryId || undefined);
    const result = await window.api.products.list({ search, categoryId: effectiveCategoryId, topLevelOnly: !search, limit: search ? 80 : 250 });
    if (seq !== productSearchRequestSeq) return;
    products = Array.isArray(result) ? result : [];
    renderProducts();
  } catch (err) {
    if (seq !== productSearchRequestSeq) return;
    console.error('Product search failed', err);
    renderPageEmptyState(productsGrid, { icon: '!', title: 'تعذر تحميل المنتجات', message: err.message || 'تحقق من الاتصال بقاعدة البيانات ثم أعد المحاولة.', actionText: 'إعادة المحاولة', onAction: () => loadProducts(search) });
  } finally {
    if (seq === productSearchRequestSeq) productsGrid.setAttribute('aria-busy', 'false');
  }
}

// دعم قارئ الباركود: عند الضغط على Enter (القارئ يُرسله تلقائياً بعد الأرقام)
// إن كان هناك تطابق تام مع باركود منتج، نضيفه مباشرة ونفرّغ الحقل بدل عرض نتائج بحث.
// إن لم يوجد تطابق مباشر، نجرّب فكّه كباركود ميزان خضار/فواكه (وزن + PLU) — لا يحتاج
// الكاشير يكتب أو يضيف أي شيء، السعر يُحسب تلقائياً (سعر الكيلو × الوزن المقروء من الباركود).
const barcodeErrorEl = document.getElementById('barcodeError');
let barcodeErrorTimeout = null;

// نعتبر النص "شكله باركود" (وليس بحث اسم عادي) إذا كان أرقام فقط وطوله 6 أو أكثر —
// هيك ما نزعج الكاشير برسالة خطأ لو ضغط Enter بالغلط أثناء كتابة اسم منتج للبحث.
function looksLikeBarcode(text) {
  return /^\d{6,}$/.test(text);
}

function showBarcodeError(message) {
  if (!barcodeErrorEl) return;
  barcodeErrorEl.textContent = message || t('pos.barcodeNotFound');
  barcodeErrorEl.classList.remove('hidden');
  playBarcodeErrorBeep();
  clearTimeout(barcodeErrorTimeout);
  barcodeErrorTimeout = setTimeout(() => barcodeErrorEl.classList.add('hidden'), 3500);
}

function hideBarcodeError() {
  if (!barcodeErrorEl) return;
  clearTimeout(barcodeErrorTimeout);
  barcodeErrorEl.classList.add('hidden');
}

// صوت تنبيه قصير (نغمتين هابطتين) بدون أي ملف صوتي خارجي — عبر Web Audio API مباشرة.
let barcodeAudioContext = null;
function playBarcodeErrorBeep() {
  try {
    if (!barcodeAudioContext) barcodeAudioContext = new (window.AudioContext || window.webkitAudioContext)();
    const ctx = barcodeAudioContext;
    [660, 440].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      osc.type = 'sine';
      gain.gain.setValueAtTime(0.15, ctx.currentTime + i * 0.15);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.15 + 0.13);
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + i * 0.15);
      osc.stop(ctx.currentTime + i * 0.15 + 0.14);
    });
  } catch {
    // بعض البيئات تمنع تشغيل صوت بدون تفاعل مسبق — نتجاهل الخطأ، الرسالة المرئية تكفي بديلاً
  }
}

let barcodeLookupBusy = false;
async function handleSearchKeydown(e) {
  if (e.key !== 'Enter' || barcodeLookupBusy) return;
  const code = searchInput.value.trim();
  if (!code) return;
  e.preventDefault();
  hideBarcodeError();
  barcodeLookupBusy = true;
  try {
    const matches = await window.api.products.list({ search: code, limit: 20 });
    const exact = matches.find((p) => p.barcode === code);
    if (exact) {
      if (exact.variant_count > 0) {
        openVariantPicker(exact);
      } else {
        addToCart(exact);
      }
      searchInput.value = '';
      await loadProducts();
      return;
    }

    // نجرّب فكّ باركود GS1 أو باركود ميزان (وزن + PLU) فقط لو النص "شكله باركود"
    // فعلاً (أرقام فقط، 6 خانات أو أكثر) — تفادياً لاستدعاءين إضافيين عديمي الفائدة
    // لقاعدة البيانات في كل مرة يبحث فيها الكاشير عن صنف بالاسم ويضغط Enter.
    if (looksLikeBarcode(code)) {
      const gs1 = await window.api.products.resolveGs1Barcode(code);
      if (gs1 && gs1.product) {
        if (gs1.product.variant_count > 0) openVariantPicker(gs1.product);
        else addToCart(gs1.product);
        searchInput.value = '';
        await loadProducts();
        return;
      }

      const weighted = await window.api.products.resolveWeightedBarcode(code);
      if (weighted) {
        addWeightedToCart(weighted.product, weighted.weightKg);
        searchInput.value = '';
        await loadProducts();
        return;
      }

      showBarcodeError();
      return;
    }

    // بحث بالاسم: لو تضييق النص بالبحث رجّع نتيجة وحيدة بالضبط، ضغطة Enter
    // بتضيفها للسلة مباشرة — نفس سرعة قارئ الباركود، بدون ما يلمس الكاشير
    // الماوس أو الشاشة. لو النتائج أكتر من واحدة، ما منضيف شي عشوائياً
    // (تفادياً لإضافة صنف غلط بالغلط بلحظة بيع حقيقية).
    if (matches.length === 1) {
      const only = matches[0];
      if (only.variant_count > 0) openVariantPicker(only);
      else addToCart(only);
      searchInput.value = '';
      await loadProducts();
    }
  } catch (err) {
    console.error('Search/barcode lookup failed', err);
    showBarcodeError(t('pos.searchLookupFailed'));
  } finally {
    barcodeLookupBusy = false;
  }
}

function renderProducts() {
  productsGrid.replaceChildren();
  productsGrid.removeAttribute('aria-busy');
  const term = searchInput.value.trim();
  // تبويب "العروض" (وليس أي تبويب آخر) هو المكان الوحيد اللي تظهر فيه بطاقات الحزم —
  // طالما الكاشير مو عم يبحث فعلياً (البحث/الباركود يبقى شاملاً كل المنتجات دائماً
  // بغض النظر عن التبويب المفتوح).
  const isOffersView = selectedCategoryId === OFFERS_CATEGORY_ID && !term;
  const bundlesToShow = isOffersView ? activeBundles.filter((b) => b.items && b.items.length > 0) : [];

  if (bundlesToShow.length === 0 && products.length === 0) {
    renderPageEmptyState(productsGrid, isOffersView
      ? { icon: '📦', title: ts('لا توجد عروض حالياً'), message: ts('لم تُضف أي حزمة/عرض نشط بعد من صفحة الحزم.') }
      : {
        icon: term ? '?' : '+',
        title: term ? 'لا توجد نتائج' : 'لا توجد منتجات بعد',
        message: term ? `${ts('لم نعثر على منتج يطابق')} «${term}». ${ts('جرّب اسماً أقصر أو امسح الباركود.')}` : t('pos.noProducts'),
        actionText: term ? 'مسح البحث' : '',
        onAction: term ? () => { searchInput.value = ''; loadProducts(); searchInput.focus(); } : null,
      });
    return;
  }
  const fragment = document.createDocumentFragment();

  // أزرار الحزم (الاسم اللي كتبه المدير عند إنشاء الحزمة) تظهر فقط ضمن تبويب "العروض"
  // المخصّص لها — بدل ما تختلط قبل شبكة المنتجات بكل الفئات الأخرى كما كانت سابقاً.
  // ضغطة واحدة تضيف كل أصناف الحزمة دفعة وحدة، وخصم الحزمة يُحسب تلقائياً كالمعتاد.
  for (const b of bundlesToShow) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'product-card bundle-card';
    card.dataset.bundleId = String(b.id);
    const itemsSummary = b.items.map((i) => `${i.product_name} ×${i.quantity}`).join('، ');
    card.innerHTML = `
      <span class="bundle-offer-badge">${ts('عرض')}</span>
      <div class="card-icon" style="background:linear-gradient(135deg, var(--brand-gold), #e6c876)">📦</div>
      <div class="name">${escapeHtml(b.name)}</div>
      <div class="card-meta-row">
        <span class="price-badge">${bundleUnitPrice(b).toFixed(2)}</span>
        <span class="stock" title="${escapeHtml(itemsSummary)}">${escapeHtml(itemsSummary)}</span>
      </div>
    `;
    fragment.appendChild(card);
  }

  const productsToShow = isOffersView ? [] : products;
  for (const p of productsToShow) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'product-card';
    card.dataset.productId = String(p.id);
    const lowStock = p.track_inventory && p.stock <= (p.min_quantity || 0);
    card.innerHTML = `
      <div class="card-icon" style="background:${categoryChipGradient(p.category_id ?? p.name)}">${escapeHtml(guessItemIcon(p.name))}</div>
      <div class="name">${escapeHtml(p.name)}${p.variant_count ? ` <span class="variant-badge">${t('pos.selectBadge')}</span>` : ''}</div>
      <div class="card-meta-row">
        <span class="price-badge">${p.price.toFixed(2)}</span>
        ${p.track_inventory ? `<span class="stock ${lowStock ? 'low' : ''}">${t('pos.stockLabel')}${p.stock}</span>` : ''}
      </div>
    `;
    fragment.appendChild(card);
  }
  productsGrid.appendChild(fragment);
}

// السعر الظاهر على زر الحزمة = مجموع أسعار أصنافها بعد تطبيق خصم الحزمة (نفس منطق
// computeBundleDiscount تماماً لكن لتطبيق واحد فقط، ليعرض للكاشير السعر النهائي الحقيقي).
function bundleUnitPrice(bundle) {
  const subtotal = bundle.items.reduce((s, i) => s + i.price * i.quantity, 0);
  if (bundle.discount_type === 'fixed_price') return Math.max(0, bundle.discount_value);
  return subtotal * (1 - Math.min(bundle.discount_value, 100) / 100);
}

function addBundleToCart(bundle) {
  for (const item of bundle.items) {
    const product = products.find((p) => p.id === item.product_id);
    const existing = cart.find((i) => i.productId === item.product_id && !i.notes);
    if (existing) {
      existing.quantity += item.quantity;
    } else {
      cart.push({
        lineId: nextLineId++,
        productId: item.product_id,
        name: item.product_name,
        price: product ? product.price : item.price,
        taxRate: product ? (product.tax_rate || 0) : 0,
        quantity: item.quantity,
        notes: '',
      });
    }
  }
  renderCart();
}

productsGrid.addEventListener('click', (event) => {
  const bundleCard = event.target.closest('.bundle-card');
  if (bundleCard && productsGrid.contains(bundleCard)) {
    const bundle = activeBundles.find((b) => b.id === Number(bundleCard.dataset.bundleId));
    if (bundle) addBundleToCart(bundle);
    return;
  }
  const card = event.target.closest('.product-card');
  if (!card || !productsGrid.contains(card)) return;
  const product = products.find((p) => p.id === Number(card.dataset.productId));
  if (!product) return;
  product.variant_count > 0 ? openVariantPicker(product) : addToCart(product);
});

/* ---------------- نافذة اختيار المتغيّر (مقاس/لون) ---------------- */
const variantModal = document.getElementById('variantModal');
const variantModalTitle = document.getElementById('variantModalTitle');
const variantList = document.getElementById('variantList');
const closeVariantBtn = document.getElementById('closeVariantBtn');

closeVariantBtn.addEventListener('click', () => variantModal.classList.add('hidden'));
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
    row.innerHTML = `
      <span>${escapeHtml(label)}</span>
      <span>${v.price.toFixed(2)}${v.track_inventory ? ` · ${t('pos.remainingStock')}${v.stock}` : ''}</span>
    `;
    row.addEventListener('click', () => {
      addToCart(v);
      variantModal.classList.add('hidden');
    });
    variantList.appendChild(row);
  }
}

function addToCart(product) {
  // دعم "كمية سريعة": الكاشير يكتب رقماً بخانة الكمية أولاً (مثلاً 10 لعشر عبوات بسكويت)
  // ثم يضغط على المنتج مرة واحدة فيُضاف بهذه الكمية دفعة واحدة بدل الضغط 10 مرات.
  // القيمة ترجع تلقائياً لـ 1 بعد كل إضافة حتى لا تُطبَّق سهواً على المنتج التالي.
  const requestedQuantity = updateQuantityBufferStatus();
  if (!requestedQuantity.ok) {
    qtyBufferInput?.focus();
    qtyBufferInput?.select();
    return false;
  }
  const qty = requestedQuantity.quantity;
  // ندمج فقط مع سطر موجود بلا ملاحظة (نفس الصنف بلا تخصيص) — سطر عليه ملاحظة (مثلاً
  // "شاورما بدون ثوم") يبقى منفصلاً حتى لا تختلط ملاحظته مع طلب عادي لنفس الصنف.
  const existing = cart.find((i) => i.productId === product.id && !i.notes);
  if (!canAccumulateQuantity(existing?.quantity, qty)) {
    if (qtyBufferStatus) {
      qtyBufferStatus.textContent = quantityBufferText('pos.qtyAccumulationMaximum', { max: MAX_QUANTITY.toLocaleString() });
      qtyBufferStatus.classList.add('is-error');
    }
    qtyBufferInput?.focus();
    qtyBufferInput?.select();
    return false;
  }
  if (existing) {
    existing.quantity += qty;
  } else {
    cart.push({
      lineId: nextLineId++,
      productId: product.id,
      name: product.name,
      price: product.price,
      taxRate: product.tax_rate || 0,
      quantity: qty,
      notes: '',
    });
  }
  resetQuantityBuffer();
  renderCart();
  return true;
}

// إضافة منتج بيع بالوزن (خضار/فواكه) بكمية = الوزن المقروء من باركود الميزان مباشرة —
// دون أي إدخال يدوي؛ يُجمع مع نفس الصنف إن كان موجوداً بالسلة أصلاً (كيس ثانٍ من نفس الصنف).
function addWeightedToCart(product, weightKg) {
  const existing = cart.find((i) => i.productId === product.id && !i.notes);
  if (!canAccumulateQuantity(existing?.quantity, weightKg)) {
    showToast(quantityBufferText('pos.qtyAccumulationMaximum', { max: MAX_QUANTITY.toLocaleString() }), 'error');
    return false;
  }
  if (existing) {
    existing.quantity += weightKg;
  } else {
    cart.push({
      lineId: nextLineId++,
      productId: product.id,
      name: product.name,
      price: product.price,
      taxRate: product.tax_rate || 0,
      quantity: weightKg,
      isWeighted: true,
      notes: '',
    });
  }
  renderCart();
  return true;
}

function changeQty(lineId, delta) {
  const item = cart.find((i) => i.lineId === lineId);
  if (!item) return;
  if (delta > 0 && !canAccumulateQuantity(item.quantity, delta)) {
    showToast(quantityBufferText('pos.qtyAccumulationMaximum', { max: MAX_QUANTITY.toLocaleString() }), 'error');
    return;
  }
  item.quantity += delta;
  if (item.quantity <= 0) {
    cart = cart.filter((i) => i.lineId !== lineId);
  }
  renderCart();
}

// حذف مباشر لسطر كامل من السلة — متاح فقط للمدير/الأدمن بدون اعتماد إضافي
// (نفس صلاحياتهم الحالية على تعديل الكمية).
function removeLine(lineId) {
  cart = cart.filter((i) => i.lineId !== lineId);
  renderCart();
}

// الكاشير لا يحذف صنفاً من السلة مباشرة (تفادياً لبيع صنف ثم حذفه بصمت بعد
// الدفع/الفحص) — لازم اعتماد مدير بنفس آلية اعتماد الخصم المتجاوز للحد.
// كانت هذه الحالة "نص مطبّقة" فقط: تلميح الواجهة يقول "الكاشير لا يغيّر الكميات
// مباشرة" (يوحي بوجود مسار غير مباشر عبر اعتماد) لكن ما كان في أي زر يوصل له.
function requestRemoveLine(lineId) {
  pendingRemoveLineId = lineId;
  openApprovalModal('removeLine', 'pos.approveRemoveLine');
}

/* ---------------- ملاحظة على صنف بالسلة (مثال: بدون ثوم، دبل لحمة) ---------------- */
const itemNoteModal = document.getElementById('itemNoteModal');
const itemNoteInput = document.getElementById('itemNoteInput');
const itemNoteProductName = document.getElementById('itemNoteProductName');
const itemNoteCounter = document.getElementById('itemNoteCounter');
const itemNoteSuggestions = document.getElementById('itemNoteSuggestions');
const saveItemNoteBtn = document.getElementById('saveItemNoteBtn');
const cancelItemNoteBtn = document.getElementById('cancelItemNoteBtn');
let itemNoteLineId = null;

// اقتراحات جاهزة لأشيع الملاحظات — تضغط عليها بدل ما تكتب من الصفر كل مرة.
// هذا هو جوهر "الاحترافية" المطلوبة: كاشير سريع بدون كتابة يدوية متكررة.
const ITEM_NOTE_SUGGESTIONS = ['بدون ثوم', 'بدون بصل', 'حار', 'زيادة صلصة', 'بدون صلصة', 'دبل لحمة', 'مقطّع صغير'];

function renderItemNoteSuggestions() {
  if (!itemNoteSuggestions) return;
  itemNoteSuggestions.replaceChildren();
  for (const label of ITEM_NOTE_SUGGESTIONS) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'note-chip';
    chip.textContent = label;
    chip.addEventListener('click', () => {
      const current = itemNoteInput.value.trim();
      itemNoteInput.value = current ? `${current}، ${label}` : label;
      itemNoteInput.dispatchEvent(new Event('input'));
      itemNoteInput.focus();
    });
    itemNoteSuggestions.appendChild(chip);
  }
}
renderItemNoteSuggestions();

itemNoteInput?.addEventListener('input', () => {
  if (itemNoteCounter) itemNoteCounter.textContent = String(itemNoteInput.value.length);
});

function openItemNoteModal(lineId) {
  const item = cart.find((i) => i.lineId === lineId);
  if (!item) return;
  itemNoteLineId = lineId;
  itemNoteProductName.textContent = item.name;
  itemNoteInput.value = item.notes || '';
  if (itemNoteCounter) itemNoteCounter.textContent = String(itemNoteInput.value.length);
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
  }
  closeItemNoteModal();
});
cancelItemNoteBtn?.addEventListener('click', closeItemNoteModal);
itemNoteModal?.addEventListener('click', (e) => {
  if (e.target === itemNoteModal) closeItemNoteModal();
});

// نسبة أو مبلغ ثابت — القيمة كما يدخلها الكاشير في discountValueInput
function computeDiscountAmount(subtotal) {
  const type = discountTypeSelect.value;
  const value = parseLocaleNumber(discountValueInput.value) || 0;
  if (type === 'none' || value <= 0) return 0;
  if (type === 'percent') {
    return subtotal * (Math.min(value, 100) / 100);
  }
  // fixed: لا يتجاوز الخصم قيمة الفاتورة نفسها
  return Math.min(value, subtotal);
}

// هل الخصم المُدخَل يتجاوز الحد المسموح للكاشير بدون اعتماد مدير؟
// نسبة الخصم الفعلية = مبلغ الخصم / الإجمالي الفرعي، تُقارَن بالحد الأقصى (نسبة مئوية)
function discountExceedsLimit(discountAmount, subtotal) {
  if (discountAmount <= 0 || subtotal <= 0) return false;
  const effectivePercent = (discountAmount / subtotal) * 100;
  return effectivePercent > maxCashierDiscountPercent + 0.001;
}

function currentDeliveryFee() {
  if (selectedOrderType() !== 'delivery') return 0;
  return parseLocaleNumber(deliveryFeeInput.value) || 0;
}

// يطابق محتوى السلة الحالية مع الحزم الفعّالة، ويحسب مجموع خصم الحزم تلقائياً.
// خوارزمية بسيطة (greedy): نمرّ على الحزم بالترتيب، وكل حزمة تستهلك من "المخزون
// المتبقي بالسلة" بقدر ما تحتاج — هيك منتج موجود بأكتر من حزمة ما يُحتسب مرتين لنفس
// الوحدة. الترتيب مبني على ترتيب الحزم كما أنشأها المدير (الأقدم أولاً)، وليس بالضرورة
// الأمثل رياضياً لو تداخلت حزم كثيرة على نفس المنتجات — كافٍ لأغلب الحالات العملية.
function computeBundleDiscount() {
  if (activeBundles.length === 0 || cart.length === 0) {
    return { totalDiscount: 0, appliedNames: [] };
  }

  const remaining = {};
  for (const item of cart) remaining[item.productId] = item.quantity;

  let totalDiscount = 0;
  const appliedNames = [];
  const appliedBundleIds = [];

  const orderedBundles = [...activeBundles].sort((a, b) => a.id - b.id);
  for (const bundle of orderedBundles) {
    if (!bundle.items || bundle.items.length === 0) continue;

    let maxApplications = Infinity;
    for (const item of bundle.items) {
      const available = remaining[item.product_id] || 0;
      maxApplications = Math.min(maxApplications, Math.floor(available / item.quantity));
    }
    if (!isFinite(maxApplications) || maxApplications < 1) continue;

    const bundleSubtotalPerApp = bundle.items.reduce((s, i) => s + i.price * i.quantity, 0);
    const discountPerApp =
      bundle.discount_type === 'fixed_price'
        ? Math.max(0, bundleSubtotalPerApp - bundle.discount_value)
        : bundleSubtotalPerApp * (Math.min(bundle.discount_value, 100) / 100);

    if (discountPerApp <= 0) continue;

    for (const item of bundle.items) {
      remaining[item.product_id] -= item.quantity * maxApplications;
    }
    totalDiscount += discountPerApp * maxApplications;
    appliedBundleIds.push(bundle.id);
    appliedNames.push(maxApplications > 1 ? `${bundle.name} ×${maxApplications}` : bundle.name);
  }

  return { totalDiscount, appliedNames, appliedBundleIds };
}

/* كل ما زاد عدد الأصناف بالسلة، تتصاغر المسافات والخط تلقائياً حتى تظهر أكبر عدد
   ممكن من الأصناف دفعة وحدة بدون داعي للسكرول بالماوس. هذا حساب بسيط ومباشر
   (بدون قياس ارتفاع فعلي عبر JS، لأن ذلك كان يتصرف بشكل غير متوقّع) — درجات
   تصغير متعددة مبنية على عدد الأسطر، مع حد أدنى للخط يبقى مقروء (11px) حتى
   الملاحظات تضل واضحة. مع عدد كبير جداً من الأصناف (نادر عملياً) يبقى في سكرول
   كحل أخير، لأنه ما في طريقة تعرض 40 صنف بخط مقروء بعمود عرضه 380px بدون سكرول. */
function applyCartDensity() {
  const linesWithNotes = cart.filter((i) => i.notes).length;
  const effectiveLines = cart.length + linesWithNotes; // سطر الملاحظة يحتاج مساحة إضافية
  cartItemsEl.classList.remove('density-1', 'density-2', 'density-3', 'density-4');
  if (effectiveLines > 18) cartItemsEl.classList.add('density-4');
  else if (effectiveLines > 12) cartItemsEl.classList.add('density-3');
  else if (effectiveLines > 7) cartItemsEl.classList.add('density-2');
  else if (effectiveLines > 4) cartItemsEl.classList.add('density-1');
}

function renderCart() {
  cartItemsEl.replaceChildren();
  const cartItemCount = document.getElementById('cartItemCount');
  const count = cart.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);
  if (cartItemCount) cartItemCount.textContent = Number.isInteger(count) ? String(count) : count.toFixed(3);

  const fragment = document.createDocumentFragment();
  for (const item of cart) {
    const row = document.createElement('div');
    row.className = 'cart-item';
    row.dataset.lineId = String(item.lineId);
    row.innerHTML = `
      <div class="cart-item-main">
        <span>${escapeHtml(item.name)}</span>
        <div class="qty-controls">${item.isWeighted
          ? `<span title="${t('pos.weightTooltip')}">${item.quantity.toFixed(3)} ${t('pos.kgUnit')}</span>`
          : (window.currentPosUser?.role === 'cashier'
            ? `<span title="${t('pos.qtyLockedTooltip')}">${item.quantity}</span>`
            : `<button data-action="minus">−</button><span>${item.quantity}</span><button data-action="plus">+</button>`)}</div>
        <span>${(item.price * item.quantity).toFixed(2)}</span>
        <button type="button" class="remove-line-btn" data-action="${window.currentPosUser?.role === 'cashier' ? 'request-remove' : 'remove'}" title="${window.currentPosUser?.role === 'cashier' ? t('pos.removeLineTooltip') : t('pos.removeLineTooltipDirect')}">🗑</button>
        <button type="button" class="note-btn ${item.notes ? 'has-note' : ''}" data-action="note" title="${t('pos.addNoteTooltip')}">📝</button>
      </div>
      ${item.notes ? `<div class="cart-item-note" data-action="note" title="${t('pos.addNoteTooltip')}">${escapeHtml(item.notes)}</div>` : ''}
    `;
    fragment.appendChild(row);
  }
  applyCartDensity();
  if (cart.length === 0) {
    renderPageEmptyState(cartItemsEl, { icon: '🛒', title: 'السلة فارغة', message: 'اختر منتجاً من القائمة للبدء ببناء الفاتورة.' });
  } else {
    cartItemsEl.appendChild(fragment);
  }

  const subtotal = cart.reduce((s, i) => s + i.price * i.quantity, 0);
  const tax = cart.reduce((s, i) => s + i.price * i.quantity * (i.taxRate / 100), 0);
  const discount = computeDiscountAmount(subtotal);
  const bundleResult = computeBundleDiscount();
  const bundleDiscount = bundleResult.totalDiscount;
  const delivery = currentDeliveryFee();
  const total = subtotal + tax - discount - bundleDiscount + delivery;

  sumSubtotal.textContent = subtotal.toFixed(2);
  sumTax.textContent = tax.toFixed(2);

  discountRow.classList.toggle('hidden', discount <= 0);
  sumDiscount.textContent = discount.toFixed(2);

  bundleDiscountRow.classList.toggle('hidden', bundleDiscount <= 0);
  sumBundleDiscount.textContent = bundleDiscount.toFixed(2);
  // اسم الحزمة (كما كتبه المدير عند إنشائها) يظهر كنص ظاهر بجانب الخصم مباشرة —
  // سابقاً كان يُوضع فقط داخل title (تلميح hover)، وهذا غير مرئي على شاشة كاشير باللمس.
  const namesJoined = bundleResult.appliedNames.join('، ');
  bundleDiscountLabel.textContent = namesJoined ? `خصم الحزم (${namesJoined})` : 'خصم الحزم التلقائي';
  bundleDiscountRow.title = namesJoined;

  deliveryRow.classList.toggle('hidden', delivery <= 0);
  sumDelivery.textContent = delivery.toFixed(2);

  sumTotal.textContent = total.toFixed(2);
  const secondaryRow = document.getElementById('secondaryTotalRow');
  const secondary = document.getElementById('secondaryTotal');
  const hasSecondary = currencyConfig.secondary && currencyConfig.secondary !== currencyConfig.base;
  secondaryRow.classList.toggle('hidden', !hasSecondary);
  if (hasSecondary) secondary.textContent = `${(total * currencyConfig.rate).toFixed(2)} ${currencyConfig.secondary}`;

  const needsApproval = discountExceedsLimit(discount, subtotal);
  discountApprovalNote.classList.toggle('hidden', !needsApproval);

  checkoutBtn.disabled = cart.length === 0;

  saveDraftCart();
}

cartItemsEl.addEventListener('click', (event) => {
  const actionEl = event.target.closest('[data-action]');
  const row = event.target.closest('.cart-item');
  if (!actionEl || !row) return;
  const lineId = Number(row.dataset.lineId);
  const action = actionEl.dataset.action;
  if (action === 'minus') changeQty(lineId, -1);
  else if (action === 'plus') changeQty(lineId, 1);
  else if (action === 'remove') removeLine(lineId);
  else if (action === 'request-remove') requestRemoveLine(lineId);
  else if (action === 'note') openItemNoteModal(lineId);
});

/* ---------------- نافذة الدفع ---------------- */
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

let currentSaleTotals = null; // { subtotal, taxTotal, grandTotal }
let pendingSaleRequestId = null;
let selectedCustomerId = null;

/* ---------------- استبدال نقاط الولاء (داخل نافذة الدفع، بعد اختيار عميل) ---------------- */
const loyaltyRedeemBox = document.getElementById('loyaltyRedeemBox');
const loyaltyPointsInput = document.getElementById('loyaltyPointsInput');
const loyaltyMaxBtn = document.getElementById('loyaltyMaxBtn');
const loyaltyRedeemHint = document.getElementById('loyaltyRedeemHint');
let loyaltyQuote = null; // { availablePoints, redeemPointsPerCurrencyUnit, maxRedeemablePoints, maxRedeemableValue }
let loyaltyRedeemedPoints = 0;

// القيمة النقدية الفعلية لعدد النقاط المطلوب استبدالها حالياً (بعد قصّها على الحد
// الأقصى المسموح به فعلياً — نفس المنطق يُعاد التحقق منه بالكامل بالخلفية أيضاً).
function loyaltyRedeemedValue() {
  if (!loyaltyQuote || loyaltyRedeemedPoints <= 0 || !loyaltyQuote.redeemPointsPerCurrencyUnit) return 0;
  const points = Math.min(loyaltyRedeemedPoints, loyaltyQuote.maxRedeemablePoints);
  return points / loyaltyQuote.redeemPointsPerCurrencyUnit;
}

// الإجمالي الفعلي المطلوب دفعه فعلياً بعد خصم استبدال النقاط (إن وُجد). كل مكان بنافذة
// الدفع كان يستخدم currentSaleTotals.grandTotal مباشرة سابقاً — استبدلناه بهذه الدالة
// أينما يخص "كم يدفع الزبون فعلياً الآن"، مع إبقاء currentSaleTotals.grandTotal كما هو
// (يمثّل المبلغ المستحق قبل أي استبدال، وهو الأساس الذي تُحسب عليه حدود الاستبدال).
function effectiveGrandTotal() {
  return Math.max(0, (currentSaleTotals?.grandTotal || 0) - loyaltyRedeemedValue());
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
  loyaltyRedeemHint.textContent = `الرصيد المتاح: ${loyaltyQuote.availablePoints} نقطة — أقصى استبدال ممكن بهذه الفاتورة: ${loyaltyQuote.maxRedeemablePoints} نقطة (خصم ${loyaltyQuote.maxRedeemableValue.toFixed(2)})`;
}

async function refreshLoyaltyQuote() {
  if (!selectedCustomerId) { resetLoyaltyState(); return; }
  try {
    loyaltyQuote = await window.api.loyalty.redemptionQuote(selectedCustomerId, currentSaleTotals.grandTotal);
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
  if (loyaltyQuote) val = Math.max(0, Math.min(val, loyaltyQuote.maxRedeemablePoints));
  else val = 0;
  loyaltyRedeemedPoints = val;
  loyaltyPointsInput.value = val;
  // بافتراض الدفع نقداً بالمبلغ المضبوط تماماً: نحدّث الاستلام النقدي تلقائياً كل ما
  // تغيّرت قيمة الاستبدال، طالما الكاشير لسا ما عدّل الاستلام يدوياً (يبقى قابلاً للتعديل بعدها بحرية).
  if (selectedPaymentMethod() === 'cash' && document.activeElement !== cashReceivedInput) {
    cashReceivedInput.value = effectiveGrandTotal().toFixed(2);
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

/* ---------------- اختيار العميل داخل نافذة الدفع ---------------- */
const customerSearchInput = document.getElementById('customerSearchInput');
const customerResults = document.getElementById('customerResults');
const selectedCustomerBox = document.getElementById('selectedCustomerBox');
const selectedCustomerLabel = document.getElementById('selectedCustomerLabel');
const clearCustomerBtn = document.getElementById('clearCustomerBtn');

customerSearchInput.addEventListener(
  'input',
  debounce(async () => {
    const term = customerSearchInput.value.trim();
    const seq = ++customerSearchRequestSeq;
    if (!term) {
      customerResults.classList.add('hidden');
      return;
    }
    try {
      const results = await window.api.customers.list({ search: term, limit: 40 });
      if (seq !== customerSearchRequestSeq || customerSearchInput.value.trim() !== term) return;
      renderCustomerResults(results, term);
    } catch (err) {
      if (seq === customerSearchRequestSeq) console.error('Customer search failed', err);
    }
  }, 250)
);

function renderCustomerResults(results, term = '') {
  if (results.length === 0) {
    customerResults.innerHTML = `<div class="customer-result-empty">${t('pos.noCustomerResults')}</div>`;
  } else {
    customerResults.innerHTML = results
      .map(
        (c) =>
          `<div class="customer-result" data-id="${c.id}">${escapeHtml(c.name || t('common.noName'))} — ${escapeHtml(
            c.phone || ''
          )} <span class="points-tag">${c.loyalty_points} ${t('common.points')}</span></div>`
      )
      .join('');
    customerResults.querySelectorAll('.customer-result').forEach((el) => {
      el.addEventListener('click', () => {
        const c = results.find((r) => r.id === parseInt(el.dataset.id, 10));
        selectCustomer(c);
      });
    });
  }
  // لا يوجد عميل بهذا الاسم بالنظام؟ أنشئه فورًا من نفس مربع البحث بدل الرجوع لشاشة
  // العملاء يدويًا — هذا هو المسار الوحيد لإنشاء عميل جديد أثناء عملية بيع آجل جارية.
  if (term) {
    const quickAddRow = document.createElement('div');
    quickAddRow.className = 'customer-result customer-result-add';
    quickAddRow.textContent = `+ ${t('pos.createCustomerPrefix', 'إنشاء عميل جديد باسم')} "${term}"`;
    quickAddRow.addEventListener('click', async () => {
      quickAddRow.textContent = t('common.loading', 'جارٍ التحميل...');
      try {
        const created = await window.api.customers.create({ name: term });
        selectCustomer({ id: created.id, name: term, loyalty_points: 0 });
      } catch (err) {
        renderCustomerResults(results, term);
        showToast('error', t('pos.createCustomerFailed', 'تعذّر إنشاء العميل') + ': ' + err.message);
      }
    });
    customerResults.appendChild(quickAddRow);
  }
  customerResults.classList.remove('hidden');
}

function selectCustomer(c) {
  selectedCustomerId = c.id;
  selectedCustomerLabel.textContent = `${c.name || t('common.noName')} — ${c.loyalty_points} ${t('common.points')}`;
  selectedCustomerBox.classList.remove('hidden');
  customerSearchInput.value = '';
  customerResults.classList.add('hidden');
  // اختيار العميل هو الشرط الذي يفتح مسار الآجل. سابقاً لا يُحدَّث نموذج الدفع
  // بعد الاختيار، فتظل العملية وكأن العميل غير محدد إلى أن يغيّر المستخدم الطريقة.
  updatePaymentView();
  refreshLoyaltyQuote().then(updatePaymentView);
}

clearCustomerBtn.addEventListener('click', () => {
  selectedCustomerId = null;
  selectedCustomerBox.classList.add('hidden');
  creditApproval = null;
  resetLoyaltyState();
  updatePaymentView();
});

function checkout() {
  if (cart.length === 0) return;
  const subtotal = cart.reduce((s, i) => s + i.price * i.quantity, 0);
  const taxTotal = cart.reduce((s, i) => s + i.price * i.quantity * (i.taxRate / 100), 0);
  const discountTotal = computeDiscountAmount(subtotal);
  const bundleResult = computeBundleDiscount();
  const bundleDiscountTotal = bundleResult.totalDiscount;
  const deliveryFee = currentDeliveryFee();
  const grandTotal = subtotal + taxTotal - discountTotal - bundleDiscountTotal + deliveryFee;
  currentSaleTotals = { subtotal, taxTotal, discountTotal, bundleDiscountTotal, bundleIds: bundleResult.appliedBundleIds, deliveryFee, grandTotal };

  if (discountExceedsLimit(discountTotal, subtotal) && !discountApproval) {
    openApprovalModal();
    return;
  }
  openPaymentModal();
}

/* ---------------- نافذة موافقة المدير على خصم متجاوز الحد ---------------- */
const approvalModal = document.getElementById('approvalModal');
const approvalUsername = document.getElementById('approvalUsername');
const approvalPassword = document.getElementById('approvalPassword');
const approvalPin = document.getElementById('approvalPin');
const approvalPasswordFields = document.getElementById('approvalPasswordFields');
const approvalPinFields = document.getElementById('approvalPinFields');
const approvalPasswordModeBtn = document.getElementById('approvalPasswordModeBtn');
const approvalPinModeBtn = document.getElementById('approvalPinModeBtn');
const approvalError = document.getElementById('approvalError');
const cancelApprovalBtn = document.getElementById('cancelApprovalBtn');
const confirmApprovalBtn = document.getElementById('confirmApprovalBtn');
let approvalMode = 'password';

function openApprovalModal(purpose = 'discount', titleKey = 'pos.approvalRequired') {
  approvalPurpose = purpose;
  approvalUsername.value = '';
  approvalPassword.value = '';
  approvalPin.value = '';
  approvalError.classList.add('hidden');
  approvalModal.querySelector('h2').textContent = t(titleKey);
  approvalModal.classList.remove('hidden');
  setApprovalMode('password');
  approvalUsername.focus();
}

function closeApprovalModal() {
  approvalModal.classList.add('hidden');
}

function setApprovalMode(mode) {
  approvalMode = mode;
  const isPin = mode === 'pin';
  approvalPinModeBtn.classList.toggle('active', isPin);
  approvalPasswordModeBtn.classList.toggle('active', !isPin);
  approvalPinFields.classList.toggle('hidden', !isPin);
  approvalPasswordFields.classList.toggle('hidden', isPin);
  approvalError.classList.add('hidden');
  if (isPin) approvalPin.focus();
  else approvalUsername.focus();
}
approvalPasswordModeBtn.addEventListener('click', () => setApprovalMode('password'));
approvalPinModeBtn.addEventListener('click', () => setApprovalMode('pin'));

cancelApprovalBtn.addEventListener('click', closeApprovalModal);
confirmApprovalBtn.addEventListener('click', async () => {
  if (approvalMode === 'pin') {
    const pin = normalizeDigits(approvalPin.value.trim());
    if (!pin) {
      approvalError.textContent = 'أدخل رقم PIN المدير';
      approvalError.classList.remove('hidden');
      return;
    }
    await runApproval(() => window.api.discount.approveWithPin(pin));
    return;
  }

  const username = approvalUsername.value.trim();
  const password = approvalPassword.value;
  if (!username || !password) {
    approvalError.textContent = t('pos.enterCredentials');
    approvalError.classList.remove('hidden');
    return;
  }
  await runApproval(() => window.api.discount.approve(username, password));
});

async function runApproval(callApi) {
  confirmApprovalBtn.disabled = true;
  confirmApprovalBtn.textContent = t('pos.verifying');
  try {
    const result = await callApi();
    if (!result.approved) {
      approvalError.textContent = result.message || t('pos.invalidCredentials');
      approvalError.classList.remove('hidden');
      return;
    }
    const approval = { approverId: result.approverId, approverName: result.approverName, grantId: result.grantId };
    if (approvalPurpose === 'credit') {
      creditApproval = approval;
    } else if (approvalPurpose === 'removeLine') {
      // الاعتماد هون بس بيفتح الباب لحذف سطر واحد محدد سلفاً، مش لتعديل السلة عمومًا
      removeLine(pendingRemoveLineId);
      pendingRemoveLineId = null;
    } else {
      discountApproval = approval;
    }
    closeApprovalModal();
    if (approvalPurpose === 'credit') updatePaymentView();
    else if (approvalPurpose === 'discount') openPaymentModal();
  } catch (err) {
    approvalError.textContent = t('pos.verifyError') + err.message;
    approvalError.classList.remove('hidden');
  } finally {
    confirmApprovalBtn.disabled = false;
    confirmApprovalBtn.textContent = t('common.approve');
  }
}

function openPaymentModal() {
  if (!pendingSaleRequestId) pendingSaleRequestId = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  paymentTotalDisplay.textContent = currentSaleTotals.grandTotal.toFixed(2);
  document.querySelector('input[name="paymentMethod"][value="cash"]').checked = true;
  cashReceivedInput.value = currentSaleTotals.grandTotal.toFixed(2);
  mixedCashInput.value = '';
  mixedCardInput.value = '';
  paymentError.classList.add('hidden');
  selectedCustomerId = null;
  selectedCustomerBox.classList.add('hidden');
  customerSearchInput.value = '';
  customerResults.classList.add('hidden');
  resetLoyaltyState();
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
  paymentTotalDisplay.textContent = effectiveGrandTotal().toFixed(2);

  if (method === 'credit' || method === 'store_credit') {
    if (!selectedCustomerId) showPaymentError(t('pos.selectCustomerFirst'));
  } else if (method === 'cash') {
    const received = parseLocaleNumber(cashReceivedInput.value) || 0;
    const change = received - effectiveGrandTotal();
    changeDueDisplay.textContent = Math.max(change, 0).toFixed(2);
  } else if (method === 'mixed') {
    const cashPart = parseLocaleNumber(mixedCashInput.value) || 0;
    const remaining = effectiveGrandTotal() - cashPart;
    mixedRemainingDisplay.textContent = remaining.toFixed(2);
    if (!mixedCardInput.value && document.activeElement !== mixedCardInput) {
      mixedCardInput.value = Math.max(remaining, 0).toFixed(2);
    }
  }

  if (method === 'credit') {
    if (!selectedCustomerId) { showPaymentError(t('pos.creditRequiresCustomer')); return; }
    if (currentUser?.role === 'cashier' && !creditApproval) {
      // اعتماد المدير هنا خاص بالبيع الآجل — يعيد استخدام نفس نافذة الاعتماد العامة
      // بدل تكرار كود فتحها (كان مكرراً هنا سابقاً تحديداً لأن openApprovalModal
      // كانت تفرض غرض "discount" دائماً وتُلغي أي غرض آخر بالغلط).
      openApprovalModal('credit', 'pos.approveCreditSale');
      return;
    }
  }
}

document.querySelectorAll('input[name="paymentMethod"]').forEach((el) => {
  el.addEventListener('change', updatePaymentView);
});
cashReceivedInput.addEventListener('input', updatePaymentView);
mixedCashInput.addEventListener('input', updatePaymentView);
mixedCardInput.addEventListener('input', () => {
  mixedRemainingDisplay.textContent = (
    effectiveGrandTotal() - (parseLocaleNumber(mixedCashInput.value) || 0) - (parseLocaleNumber(mixedCardInput.value) || 0)
  ).toFixed(2);
});
cancelPaymentBtn.addEventListener('click', closePaymentModal);
confirmPaymentBtn.addEventListener('click', confirmPayment);

async function confirmPayment() {
  const method = selectedPaymentMethod();
  const total = effectiveGrandTotal();
  let cashAmount = 0;
  let cardAmount = 0;
  let changeDue = 0;

  if (method === 'credit') {
    if (!selectedCustomerId) {
      showPaymentError(t('pos.creditRequiresCustomer'));
      return;
    }
    if (currentUser?.role === 'cashier' && !creditApproval) {
      // لم تُستكمل موافقة المدير بعد (مثلاً أُلغيت نافذة الموافقة) — لا نُرسل البيع للخادم بدون موافقة صالحة
      showPaymentError(t('pos.approveCreditSale'));
      updatePaymentView();
      return;
    }
  }

  if (method === 'store_credit') {
    if (!selectedCustomerId) { showPaymentError(t('pos.creditRequiresCustomer')); return; }
  }

  if (method === 'cash') {
    cashAmount = parseLocaleNumber(cashReceivedInput.value) || 0;
    if (cashAmount < total - 0.001) {
      showPaymentError(t('pos.insufficientCash'));
      return;
    }
    changeDue = cashAmount - total;
    // cashAmount هو ما استلمه الكاشير فعلياً. لا نستبدله بصافي الفاتورة، لأن
    // الخلفية تحفظ الاستلام والباقي كقيمتين منفصلتين وتتحقق من تطابقهما.
  } else if (method === 'card') {
    cardAmount = total;
  } else if (method === 'mixed') {
    cashAmount = parseLocaleNumber(mixedCashInput.value) || 0;
    cardAmount = parseLocaleNumber(mixedCardInput.value) || 0;
    if (Math.abs(cashAmount + cardAmount - total) > 0.01) {
      showPaymentError(t('pos.mixedMismatch'));
      return;
    }
  }

  const orderType = selectedOrderType();
  const discountType = discountTypeSelect.value === 'none' ? null : discountTypeSelect.value;

  const sale = {
    items: cart.map((i) => ({
      productId: i.productId,
      quantity: i.quantity,
      unitPrice: i.price,
      taxRate: i.taxRate,
      lineTotal: i.price * i.quantity,
      notes: i.notes || null,
    })),
    subtotal: currentSaleTotals.subtotal,
    taxTotal: currentSaleTotals.taxTotal,
    discountTotal: currentSaleTotals.discountTotal,
    discountType,
    discountValue: parseLocaleNumber(discountValueInput.value) || 0,
    discountApprovedBy: null,
    discountApprovalGrantId: discountApproval ? discountApproval.grantId : null,
    bundleDiscountTotal: 0,
    bundleIds: currentSaleTotals.bundleIds || [],
    orderType,
    deliveryFee: currentSaleTotals.deliveryFee,
    deliveryPerson: orderType === 'delivery' ? deliveryPersonInput.value.trim() || null : null,
    deliveryTime: computeDeliveryTimeIso(),
    notes: orderNoteInput.value.trim() || null,
    grandTotal: total,
    paymentMethod: method,
    cashAmount,
    cardAmount,
    changeDue,
    customerId: selectedCustomerId,
    loyaltyPointsToRedeem: selectedCustomerId ? loyaltyRedeemedPoints : 0,
    creditApprovedBy: null,
    creditApprovalGrantId: creditApproval ? creditApproval.grantId : null,
    exchangeRate: currencyConfig.rate,
    clientRequestId: pendingSaleRequestId,
  };

  confirmPaymentBtn.disabled = true;
  confirmPaymentBtn.textContent = t('pos.saving');
  try {
    const result = await window.api.sales.create(sale);
    showToast(`${ts('تم حفظ الفاتورة')}${result?.invoiceNumber ? ` #${result.invoiceNumber}` : ''}`, 'success');
    // نبّه الكاشير فوراً لو الطباعة التلقائية فشلت (طابعة غير متصلة/IP غلط/إلخ) بدل ما
    // يفشل الأمر بصمت وميعرفش السبب إلا لو فتح سجل التدقيق يدوياً.
    const po = result?.printOutcome;
    if (po?.kitchen && po.kitchen.success === false) showToast(`⚠️ لم تُطبع تذكرة المطبخ: ${po.kitchen.reason || 'خطأ غير معروف'}`, 'error');
    if (po?.receipt && po.receipt.success === false) showToast(`⚠️ لم تُطبع الفاتورة: ${po.receipt.reason || 'خطأ غير معروف'}`, 'error');
    cart = [];
    clearDraftCart();
    renderCart();
    resetOrderExtras();
    pendingSaleRequestId = null;
    closePaymentModal();
    resetLoyaltyState();
    await loadProducts(searchInput.value); // تحديث المخزون المعروض
    if (sale.deliveryPerson) loadDeliveryPersonSuggestions(); // اقتراح الاسم الجديد من المرة الجاية
    // ترسل الفاتورة وتذكرة السفري تلقائياً عند تفعيل الطابعة في الإعدادات.
  } catch (err) {
    showPaymentError(t('pos.saleSaveError') + err.message);
    showToast(t('pos.saleSaveError') + err.message, 'error');
  } finally {
    confirmPaymentBtn.textContent = t('pos.confirmPayment');
    confirmPaymentBtn.disabled = false;
  }
}

// إعادة تصفير كل حقول التوصيل/الخصم بعد إتمام عملية بيع بنجاح، تحضيراً للفاتورة التالية
function resetOrderExtras() {
  document.querySelector('input[name="orderType"][value="takeaway"]').checked = true;
  deliveryFields.classList.add('hidden');
  deliveryDistanceInput.value = '';
  deliveryFeeInput.value = 0;
  deliveryPersonInput.value = '';
  document.querySelector('input[name="deliveryTimeMode"][value="now"]').checked = true;
  deliveryCustomTimeInput.value = '';
  deliveryCustomTimeInput.classList.add('hidden');
  orderNoteInput.value = '';
  discountTypeSelect.value = 'none';
  discountValueInput.value = 0;
  discountValueInput.disabled = true;
  discountApprovalNote.classList.add('hidden');
  discountApproval = null;
  creditApproval = null;
}

function showPaymentError(msg) {
  paymentError.textContent = msg;
  paymentError.classList.remove('hidden');
}

init();
