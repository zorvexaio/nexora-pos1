let currentShift = null;
let lastExpectedCash = 0;

const noShiftPanel = document.getElementById('noShiftPanel');
const openShiftPanel = document.getElementById('openShiftPanel');
const openShiftForm = document.getElementById('openShiftForm');
const openingAmountInput = document.getElementById('openingAmountInput');
const closeShiftForm = document.getElementById('closeShiftForm');
const actualCashInput = document.getElementById('actualCashInput');
const closeNotesInput = document.getElementById('closeNotesInput');
const differencePreview = document.getElementById('differencePreview');

async function init() {
  const user = await guardPage(null, '../login.html');
  if (!user) return;

  const branch = await window.api.branches.current();
  document.getElementById('branchName').textContent = branch ? branch.name : '';

  await refresh();

  openShiftForm.addEventListener('submit', onOpenShift);
  closeShiftForm.addEventListener('submit', onCloseShift);
  actualCashInput.addEventListener('input', updateDifferencePreview);
}

async function refresh() {
  currentShift = await window.api.shift.current();
  if (!currentShift) {
    noShiftPanel.classList.remove('hidden');
    openShiftPanel.classList.add('hidden');
    return;
  }
  noShiftPanel.classList.add('hidden');
  openShiftPanel.classList.remove('hidden');

  let summary;
  try {
    summary = await window.api.shift.summary(currentShift.id);
  } catch (err) {
    // الوردية المفتوحة قد تكون فتحها موظف آخر؛ الكاشير لا يملك صلاحية عرض تفاصيلها.
    openShiftPanel.classList.add('hidden');
    showToast(err.message || String(err), 'error');
    return;
  }
  document.getElementById('shiftOpenedAt').textContent = new Date(summary.opened_at).toLocaleString('ar');
  document.getElementById('shiftOpenedBy').textContent = summary.opened_by_name || '—';
  document.getElementById('shiftOpeningAmount').textContent = summary.opening_amount.toFixed(2);
  document.getElementById('shiftSalesCount').textContent = summary.sales.count;
  document.getElementById('shiftSalesTotal').textContent = summary.sales.total.toFixed(2);
  document.getElementById('shiftCash').textContent = summary.sales.cash.toFixed(2);
  document.getElementById('shiftCard').textContent = summary.sales.card.toFixed(2);
  document.getElementById('shiftDeliveryFees').textContent = summary.sales.deliveryFees.toFixed(2);
  document.getElementById('shiftReturnsTotal').textContent = summary.returns.total.toFixed(2);
  document.getElementById('shiftExpectedCash').textContent = summary.expectedCash.toFixed(2);
  lastExpectedCash = summary.expectedCash;
  renderMovements(summary.movements || []);

  actualCashInput.value = summary.expectedCash.toFixed(2);
  updateDifferencePreview();
}

const movementTypeLabel = (type) => ({ cash_in: t('shift.cashIn'), cash_out: t('shift.cashOut') }[type] || type);
function renderMovements(movements) {
  const body = document.getElementById('shiftMovementsBody');
  const empty = document.getElementById('shiftMovementsEmpty');
  if (!movements.length) {
    body.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  body.innerHTML = movements
    .map((m) => {
      const time = new Date(m.created_at).toLocaleString('ar');
      const sign = m.type === 'cash_out' ? '-' : '+';
      return `<tr><td>${time}</td><td>${movementTypeLabel(m.type)}</td><td>${(m.reason || '').replace(/</g, '&lt;')}</td><td>${sign}${Number(m.amount).toFixed(2)}</td></tr>`;
    })
    .join('');
}

async function onOpenShift(e) {
  e.preventDefault();
  const amount = parseLocaleNumber(openingAmountInput.value) || 0;
  const result = await window.api.shift.open(amount);
  if (!result.success) {
    showToast(result.message || ts('تعذّر فتح جلسة الصندوق'), 'error');
  }
  await refresh();
}

function updateDifferencePreview() {
  if (!currentShift) return;
  // نقرأ القيمة المتوقعة من حالة الجلسة المحفوظة، لا من نص العنصر بالشاشة (parseFloat على
  // نص معروض كان هشاً وبيرجع NaN لو تغيّر الفورمات لاحقاً — وهذا بالضبط ما كان يخلي "الفرق"
  // يُحسب دائماً ضد صفر بدل الرقم الفعلي، بسبب انهيار refresh() قبل ما يوصل لتحديث الكرت أصلاً).
  const expected = Number(lastExpectedCash) || 0;
  const actual = parseLocaleNumber(actualCashInput.value) || 0;
  const diff = actual - expected;
  differencePreview.classList.remove('hidden');
  const label = diff === 0 ? t('shift.exactMatch', 'مطابق تماماً') : diff > 0 ? `${t('shift.increase', 'زيادة')} ${diff.toFixed(2)}` : `${t('shift.shortage', 'عجز')} ${Math.abs(diff).toFixed(2)}`;
  const tone = diff === 0 ? 'success' : diff > 0 ? 'info' : 'danger';
  differencePreview.innerHTML = `<div class="form-field full"><span class="status-badge tone-${tone}" style="font-size:13px;">${ts('الفرق')}: ${label}</span></div>`;
}

async function onCloseShift(e) {
  e.preventDefault();
  const actual = parseLocaleNumber(actualCashInput.value);
  if (isNaN(actual)) return;
  if (!(await confirmDialog(ts('هل أنت متأكد من إغلاق جلسة الصندوق؟ لن تتوقف المبيعات؛ الإغلاق يخص جلسة متابعة الكاش فقط.'), { tone: 'warning' }))) return;

  const result = await window.api.shift.close(currentShift.id, actual, closeNotesInput.value.trim());
  if (result.success) {
    await infoDialog(
      `${ts('تم إغلاق جلسة الصندوق.')}\n${ts('المتوقع')}: ${result.expected.toFixed(2)}\n${ts('الفعلي')}: ${result.actual.toFixed(2)}\n${ts('الفرق')}: ${result.difference.toFixed(2)}`
    );
  }
  await refresh();
}

init();
