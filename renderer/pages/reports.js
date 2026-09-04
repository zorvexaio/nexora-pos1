const branchNameEl = document.getElementById('branchName');
const fromInput = document.getElementById('fromInput');
const toInput = document.getElementById('toInput');
const applyRangeBtn = document.getElementById('applyRangeBtn');
const exportExcelBtn = document.getElementById('exportExcelBtn');
const exportPdfBtn = document.getElementById('exportPdfBtn');

const statCount = document.getElementById('statCount');
const statSubtotal = document.getElementById('statSubtotal');
const statTax = document.getElementById('statTax');
const statTotal = document.getElementById('statTotal');
const paymentBreakdown = document.getElementById('paymentBreakdown');
const topProductsBody = document.getElementById('topProductsBody');
const topProductsEmpty = document.getElementById('topProductsEmpty');
const topProfitBody = document.getElementById('topProfitBody');
const topProfitEmpty = document.getElementById('topProfitEmpty');
const plNetRevenue = document.getElementById('plNetRevenue');
const plCost = document.getElementById('plCost');
const plGrossProfit = document.getElementById('plGrossProfit');
const plPayrollExpense = document.getElementById('plPayrollExpense');
const plNetProfit = document.getElementById('plNetProfit');
const plMargin = document.getElementById('plMargin');
const debtAgingBody = document.getElementById('debtAgingBody');
const debtAgingEmpty = document.getElementById('debtAgingEmpty');
const dailyChart = document.getElementById('dailyChart');
const dailyEmpty = document.getElementById('dailyEmpty');

const balCash = document.getElementById('balCash');
const balCashHint = document.getElementById('balCashHint');
const balSupplier = document.getElementById('balSupplier');
const balSupplierHint = document.getElementById('balSupplierHint');
const balAdvances = document.getElementById('balAdvances');
const balAdvancesHint = document.getElementById('balAdvancesHint');
const balCustomer = document.getElementById('balCustomer');
const balCustomerHint = document.getElementById('balCustomerHint');

const deliveryOrderCount = document.getElementById('deliveryOrderCount');
const deliveryProductsRevenue = document.getElementById('deliveryProductsRevenue');
const deliveryFeesTotal = document.getElementById('deliveryFeesTotal');
const deliveryByPersonBody = document.getElementById('deliveryByPersonBody');
const deliveryEmpty = document.getElementById('deliveryEmpty');

const PAYMENT_LABELS = { cash: 'نقدي', card: 'بطاقة', mixed: 'مختلط', credit: 'آجل' };
const STATUS_LABELS = { completed: 'مكتملة', refunded: 'مرتجعة', partially_refunded: 'مرتجعة جزئياً' };
const STATUS_TONE = { completed: 'success', refunded: 'danger', partially_refunded: 'warning' };

const trendCount = document.getElementById('trendCount');
const trendTotal = document.getElementById('trendTotal');
const trendNetProfit = document.getElementById('trendNetProfit');
const totalSparkline = document.getElementById('totalSparkline');
const invoiceModal = document.getElementById('invoiceModal');
const invoiceModalBody = document.getElementById('invoiceModalBody');
const invoiceModalTitle = document.getElementById('invoiceModalTitle');
const invoiceModalClose = document.getElementById('invoiceModalClose');

// فورمات الأرقام بفواصل آلاف (12500.5 -> "12,500.50") بدل toFixed(2) الخام غير المقروء للأرقام الكبيرة
function formatMoney(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '0.00';
  return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function formatInt(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '0';
  return v.toLocaleString('en-US');
}

const invoiceSearchInput = document.getElementById('invoiceSearchInput');
const reportStatus = document.getElementById('reportStatus');
const reportShell = document.querySelector('.reports-page');
const invoicesBody = document.getElementById('invoicesBody');
const invoicesEmpty = document.getElementById('invoicesEmpty');
let invoiceSearchTimer = null;

function todayStr() {
  return new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

async function init() {
  const user = await guardPage(['admin', 'manager'], '../login.html');
  if (!user) return;

  const branch = await window.api.branches.current();
  branchNameEl.textContent = branch ? branch.name : '';

  fromInput.value = todayStr();
  toInput.value = todayStr();

  document.querySelectorAll('[data-range]').forEach((btn) => {
    btn.addEventListener('click', () => applyPreset(btn.dataset.range));
  });
  applyRangeBtn.addEventListener('click', loadReports);
  exportExcelBtn.addEventListener('click', () => exportReport('Excel'));
  exportPdfBtn.addEventListener('click', () => exportReport('Pdf'));

  document.querySelectorAll('.report-tab').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
  invoiceModalClose.addEventListener('click', closeInvoiceModal);
  invoiceModal.addEventListener('click', (e) => { if (e.target === invoiceModal) closeInvoiceModal(); });

  // نستخدم normalizeDigits لأن حقل البحث نص عادي (لا type="number") حتى يقبل الأرقام العربية/الفارسية
  // المكتوبة من لوحة مفاتيح عربية، وهو ما لا تسمح به خانات <input type="number"> إطلاقاً
  invoiceSearchInput.addEventListener('input', () => {
    invoiceSearchInput.value = normalizeDigits(invoiceSearchInput.value);
    clearTimeout(invoiceSearchTimer);
    invoiceSearchTimer = setTimeout(loadInvoices, 250);
  });

  await loadReports();
}

function switchTab(tab) {
  document.querySelectorAll('.report-tab').forEach((btn) => {
    const active = btn.dataset.tab === tab;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', String(active));
  });
  document.querySelectorAll('.tab-panel').forEach((panel) => {
    panel.hidden = panel.dataset.panel !== tab;
  });
}

function closeInvoiceModal() {
  invoiceModal.classList.add('hidden');
}

async function openInvoiceDetail(saleId) {
  invoiceModalTitle.textContent = 'تفاصيل الفاتورة';
  invoiceModalBody.innerHTML = '<div class="empty-state">جارٍ التحميل...</div>';
  invoiceModal.classList.remove('hidden');
  try {
    const sale = await window.api.sales.get(saleId);
    if (!sale) { invoiceModalBody.innerHTML = '<div class="empty-state">تعذر العثور على الفاتورة.</div>'; return; }
    invoiceModalTitle.textContent = `فاتورة رقم ${escapeHtml(sale.invoice_number || sale.id)}`;
    const itemsRows = (sale.items || []).map((it) => `
      <tr><td>${escapeHtml(it.product_name)}</td><td>${it.quantity}</td><td>${formatMoney(it.unit_price)}</td><td>${formatMoney(it.line_total)}</td></tr>
    `).join('');
    invoiceModalBody.innerHTML = `
      <div class="invoice-modal-meta">
        <span>${formatDateTime(sale.created_at)}</span>
        <span class="status-badge tone-${STATUS_TONE[sale.status] || 'slate'}">${STATUS_LABELS[sale.status] || escapeHtml(sale.status)}</span>
      </div>
      ${sale.customer_name ? `<div class="invoice-modal-meta"><span>العميل: ${escapeHtml(sale.customer_name)}</span></div>` : ''}
      <table class="products-table" style="margin-top:10px;">
        <thead><tr><th>المنتج</th><th>الكمية</th><th>السعر</th><th>الإجمالي</th></tr></thead>
        <tbody>${itemsRows || '<tr><td colspan="4">لا توجد بنود.</td></tr>'}</tbody>
      </table>
      <div class="invoice-modal-totals">
        <div><span>الإجمالي الفرعي</span><b>${formatMoney(sale.subtotal)}</b></div>
        <div><span>الضريبة</span><b>${formatMoney(sale.tax_total)}</b></div>
        <div><span>الخصم</span><b>${formatMoney(sale.discount_total)}</b></div>
        <div class="strong"><span>الإجمالي</span><b>${formatMoney(sale.grand_total)}</b></div>
        <div><span>طريقة الدفع</span><b>${PAYMENT_LABELS[sale.payment_method] || escapeHtml(sale.payment_method)}</b></div>
      </div>
    `;
  } catch (error) {
    invoiceModalBody.innerHTML = `<div class="empty-state">تعذر تحميل تفاصيل الفاتورة: ${escapeHtml(error.message || String(error))}</div>`;
  }
}

async function exportReport(kind) {
  const button = kind === 'Excel' ? exportExcelBtn : exportPdfBtn;
  button.disabled = true;
  try {
    const result = await window.api.reports[`export${kind}`](currentRange());
    if (result?.canceled) { showToast('تم إلغاء التصدير.', 'info'); return; }
    if (result && !result.success) throw new Error(result.message || 'فشل التصدير');
    if (result?.success) showToast(`${ts('تم تصدير التقرير بصيغة')} ${kind}.`);
  } catch (error) {
    showToast('تعذر تصدير التقرير: ' + error.message, 'error');
  } finally { button.disabled = false; }
}

function applyPreset(preset) {
  const today = new Date();
  const to = todayStr();
  let from = to;
  if (preset === 'week') {
    const d = new Date(today);
    d.setDate(d.getDate() - 6);
    from = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  } else if (preset === 'month') {
    const d = new Date(today);
    d.setDate(d.getDate() - 29);
    from = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  }
  fromInput.value = from;
  toInput.value = to;
  loadReports();
}

function currentRange() {
  return {
    from: fromInput.value,
    to: toInput.value,
  };
}

function prevRangeFor(range) {
  const from = new Date(`${range.from}T00:00:00`);
  const to = new Date(`${range.to}T00:00:00`);
  const spanDays = Math.max(1, Math.round((to - from) / 86400000) + 1);
  const prevTo = new Date(from);
  prevTo.setDate(prevTo.getDate() - 1);
  const prevFrom = new Date(prevTo);
  prevFrom.setDate(prevFrom.getDate() - (spanDays - 1));
  const fmt = (d) => new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  return { from: fmt(prevFrom), to: fmt(prevTo) };
}

async function loadReports() {
  const range = currentRange();
  const prevRange = prevRangeFor(range);
  if (reportStatus) reportStatus.textContent = 'جارٍ تحديث التقارير...';
  if (reportShell) reportShell.setAttribute('aria-busy', 'true');
  document.querySelectorAll('.kpi-card, .report-panel, .pl-card').forEach((el) => el.classList.add('is-loading'));
  try {
  const [summary, topProducts, daily, delivery, profitLoss, debtAging, prevSummary, prevProfitLoss, cashMovements, balances] = await Promise.all([
    window.api.reports.summary(range),
    window.api.reports.topProducts({ ...range, limit: 10 }),
    window.api.reports.daily(range),
    window.api.reports.delivery(range),
    window.api.reports.profitLoss(range),
    window.api.reports.debtAging(),
    window.api.reports.summary(prevRange).catch(() => null),
    window.api.reports.profitLoss(prevRange).catch(() => null),
    window.api.reports.cashMovements(range),
    window.api.reports.balances().catch(() => null),
  ]);

  renderSummary(summary, prevSummary);
  renderTopProducts(topProducts);
  renderDailyChart(daily);
  renderSparkline(daily);
  renderDeliverySummary(delivery);
  renderProfitLoss(profitLoss, prevProfitLoss);
  renderDebtAging(debtAging);
  renderCashMovements(cashMovements);
  renderBalances(balances);
  await loadInvoices();
  if (reportStatus) reportStatus.textContent = `${ts('تم التحديث')}: ${range.from} — ${range.to}`;
  } catch (error) {
    if (reportStatus) reportStatus.textContent = 'تعذر تحديث التقارير.';
    showToast(ts('تعذر تحديث التقارير: ') + (error.message || error), 'error');
  } finally {
    if (reportShell) reportShell.setAttribute('aria-busy', 'false');
    document.querySelectorAll('.kpi-card, .report-panel, .pl-card').forEach((el) => el.classList.remove('is-loading'));
  }
}

// قسم "وضعك المالي الآن" — أرقام لحظية بمعزل عن الفترة المحددة بالفلاتر، عكس باقي هذه الصفحة.
function renderBalances(data) {
  if (!data) return;
  if (data.shiftOpen) {
    balCash.textContent = formatMoney(data.expectedCash);
    balCashHint.innerHTML = '';
  } else {
    balCash.textContent = '—';
    balCashHint.innerHTML = '<span class="trend-hint">لا يوجد صندوق مفتوح حالياً</span>';
  }
  balSupplier.textContent = formatMoney(data.supplierDebt.total);
  balSupplierHint.innerHTML = data.supplierDebt.count ? `<span class="trend-hint">${formatInt(data.supplierDebt.count)} مورد</span>` : '';
  balAdvances.textContent = formatMoney(data.employeeAdvances.total);
  balAdvancesHint.innerHTML = data.employeeAdvances.count ? `<span class="trend-hint">${formatInt(data.employeeAdvances.count)} سلفة</span>` : '';
  balCustomer.textContent = formatMoney(data.customerDebt.total);
  balCustomerHint.innerHTML = data.customerDebt.count ? `<span class="trend-hint">${formatInt(data.customerDebt.count)} عميل</span>` : '';
}

function renderCashMovements(data) {
  const outEl = document.getElementById('cashMovementsOut');
  const inEl = document.getElementById('cashMovementsIn');
  const body = document.getElementById('cashMovementsBody');
  const empty = document.getElementById('cashMovementsEmpty');
  if (!data) return;
  outEl.textContent = formatMoney(data.cashOut);
  inEl.textContent = formatMoney(data.cashIn);
  const labels = {
    payroll_advance: 'سلف موظفين (صرف)',
    payroll_advance_repayment: 'تسديد سلف موظفين',
    payroll_advance_reversal: 'إلغاء/تصحيح سلفة',
    payroll_final_settlement: 'تصفية نهاية خدمة',
    payroll_salary: 'صرف رواتب',
    purchase: 'دفعات فواتير شراء',
    supplier: 'دفعات موردين',
    customer: 'تحصيل ديون عملاء',
    void: 'عمليات إلغاء/تصحيح',
    other: 'حركات أخرى',
  };
  if (!data.groups || !data.groups.length) {
    body.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  body.innerHTML = data.groups
    .map((g) => `<tr><td>${labels[g.key] || g.key}</td><td>${g.count}</td><td>${g.type === 'cash_out' ? '-' : '+'}${formatMoney(g.total)}</td></tr>`)
    .join('');
}

// شارة اتجاه صغيرة (▲ نسبة% أخضر / ▼ نسبة% أحمر) لمقارنة القيمة الحالية بفترة سابقة مساوية الطول
function renderTrend(el, current, previous) {
  if (!el) return;
  const cur = Number(current) || 0;
  const prev = Number(previous);
  if (!Number.isFinite(prev) || prev === 0) { el.innerHTML = ''; return; }
  const pct = ((cur - prev) / Math.abs(prev)) * 100;
  const up = pct >= 0;
  el.innerHTML = `<span class="trend-badge ${up ? 'up' : 'down'}">${up ? '▲' : '▼'} ${Math.abs(pct).toFixed(1)}%</span><span class="trend-hint">عن الفترة السابقة</span>`;
}

// خط اتجاه صغير (sparkline) داخل بطاقة إجمالي المبيعات يوضح شكل حركة المبيعات خلال الفترة
function renderSparkline(days) {
  if (!totalSparkline) return;
  if (!days || days.length < 2) { totalSparkline.innerHTML = ''; return; }
  const values = days.map((d) => Number(d.total) || 0);
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const range = Math.max(max - min, 1);
  const w = 120, h = 34;
  const points = values.map((v, i) => {
    const x = (i / (values.length - 1)) * w;
    const y = h - ((v - min) / range) * (h - 4) - 2;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const areaPoints = `0,${h} ${points} ${w},${h}`;
  totalSparkline.innerHTML = `
    <polygon points="${areaPoints}" fill="rgba(255,255,255,.18)"></polygon>
    <polyline points="${points}" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></polyline>
  `;
}

async function loadInvoices() {
  const range = { ...currentRange(), search: invoiceSearchInput.value.trim() };
  try {
    const invoices = await window.api.reports.invoices(range);
    renderInvoices(invoices);
  } catch (error) {
    invoicesBody.innerHTML = '';
    invoicesEmpty.style.display = 'block';
    invoicesEmpty.textContent = 'تعذر تحميل الفواتير. جرّب البحث مرة أخرى.';
    throw error;
  }
}

function renderInvoices(items) {
  invoicesBody.innerHTML = '';
  invoicesEmpty.style.display = items.length ? 'none' : 'block';
  for (const inv of items) {
    const tr = document.createElement('tr');
    tr.className = 'clickable-row';
    tr.innerHTML = `
      <td>${escapeHtml(inv.invoice_number || inv.id)}</td>
      <td>${formatDateTime(inv.created_at)}</td>
      <td>${escapeHtml(inv.customer_name || '—')}</td>
      <td>${PAYMENT_LABELS[inv.payment_method] || escapeHtml(inv.payment_method)}</td>
      <td>${formatMoney(inv.grand_total)}</td>
      <td><span class="status-badge tone-${STATUS_TONE[inv.status] || 'slate'}">${STATUS_LABELS[inv.status] || escapeHtml(inv.status)}</span></td>
    `;
    tr.addEventListener('click', () => openInvoiceDetail(inv.id));
    invoicesBody.appendChild(tr);
  }
}

function formatDateTime(str) {
  if (!str) return '';
  // نفس ملاحظة توقيت UTC الموضحة بـaudit.js — created_at مخزّن UTC، فلازم إضافة 'Z' صراحة
  // قبل التحويل وإلا يُعرض الوقت الخام بدون تحويل لتوقيت الجهاز المحلي.
  const d = new Date(str.replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return str;
  return d.toLocaleString('ar-EG', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function renderDebtAging(items) {
  debtAgingBody.innerHTML = '';
  debtAgingEmpty.style.display = items.length ? 'none' : 'block';
  for (const item of items) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${escapeHtml(item.name || 'بدون اسم')}</td><td>${formatMoney(item.balance)}</td><td>${item.age_days ?? 0}</td>`;
    debtAgingBody.appendChild(tr);
  }
}

function renderProfitLoss(pl, prevPl) {
  plNetRevenue.textContent = formatMoney(pl.netRevenue);
  plCost.textContent = formatMoney(pl.cost);
  plGrossProfit.textContent = formatMoney(pl.grossProfit);
  plPayrollExpense.textContent = formatMoney(pl.payrollExpense);
  plNetProfit.textContent = formatMoney(pl.netProfit);
  plMargin.textContent = `${pl.marginPercent.toFixed(1)}%`;
  renderTrend(trendNetProfit, pl.netProfit, prevPl?.netProfit);

  topProfitBody.innerHTML = '';
  topProfitEmpty.style.display = pl.byProduct.length === 0 ? 'block' : 'none';
  const maxProfit = Math.max(...pl.byProduct.map((p) => Number(p.profit) || 0), 1);
  for (const p of pl.byProduct) {
    const pct = Math.max((Number(p.profit) / maxProfit) * 100, 4);
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(p.name)}</td>
      <td>${p.qty}</td>
      <td><div class="rank-cell"><strong>${formatMoney(p.profit)}</strong><div class="rank-bar profit"><span style="width:${pct}%"></span></div></div></td>
    `;
    topProfitBody.appendChild(tr);
  }
}

function renderDeliverySummary(delivery) {
  deliveryOrderCount.textContent = formatInt(delivery.orderCount);
  deliveryProductsRevenue.textContent = formatMoney(delivery.productsRevenue);
  deliveryFeesTotal.textContent = formatMoney(delivery.deliveryFees);

  deliveryByPersonBody.innerHTML = '';
  deliveryEmpty.style.display = delivery.byPerson.length === 0 ? 'block' : 'none';
  for (const p of delivery.byPerson) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(p.deliveryPerson)}</td>
      <td>${formatInt(p.orderCount)}</td>
      <td>${formatMoney(p.deliveryFees)}</td>
    `;
    deliveryByPersonBody.appendChild(tr);
  }
}

function renderSummary(summary, prevSummary) {
  statCount.textContent = formatInt(summary.count);
  statSubtotal.textContent = formatMoney(summary.subtotal);
  statTax.textContent = formatMoney(summary.tax);
  statTotal.textContent = formatMoney(summary.total);
  renderTrend(trendCount, summary.count, prevSummary?.count);
  renderTrend(trendTotal, summary.total, prevSummary?.total);

  paymentBreakdown.innerHTML = '';
  if (summary.byMethod.length === 0) {
    paymentBreakdown.innerHTML = '<div class="empty-state">لا توجد بيانات في هذه الفترة.</div>';
    return;
  }
  const maxTotal = Math.max(...summary.byMethod.map((m) => m.total), 1);
  for (const m of summary.byMethod) {
    const row = document.createElement('div');
    row.className = 'breakdown-row';
    const pct = (m.total / maxTotal) * 100;
    row.innerHTML = `
      <div class="breakdown-label">
        <span>${PAYMENT_LABELS[m.payment_method] || escapeHtml(m.payment_method)}</span>
        <span>${formatMoney(m.total)} (${formatInt(m.count)})</span>
      </div>
      <div class="breakdown-bar"><div class="breakdown-fill" style="width:${pct}%"></div></div>
    `;
    paymentBreakdown.appendChild(row);
  }
}

function renderTopProducts(items) {
  topProductsBody.innerHTML = '';
  topProductsEmpty.style.display = items.length === 0 ? 'block' : 'none';
  const maxQty = Math.max(...items.map((p) => Number(p.qty) || 0), 1);
  for (const p of items) {
    const pct = Math.max((Number(p.qty) / maxQty) * 100, 4);
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(p.name)}</td>
      <td><div class="rank-cell"><strong>${p.qty}</strong><div class="rank-bar"><span style="width:${pct}%"></span></div></div></td>
      <td>${formatMoney(p.total)}</td>
    `;
    topProductsBody.appendChild(tr);
  }
}

function renderDailyChart(days) {
  dailyChart.innerHTML = '';
  dailyEmpty.style.display = days.length === 0 ? 'block' : 'none';
  if (days.length === 0) return;

  const maxTotal = Math.max(...days.map((d) => d.total), 1);
  for (const d of days) {
    const heightPct = Math.max((d.total / maxTotal) * 100, 3);
    const col = document.createElement('div');
    col.className = 'bar-col';
    col.innerHTML = `
      <div class="bar-value">${formatMoney(d.total)}</div>
      <div class="bar" style="height:${heightPct}%" title="${formatDay(d.day)}: ${formatMoney(d.total)}"></div>
      <div class="bar-label">${formatDay(d.day)}</div>
    `;
    dailyChart.appendChild(col);
  }
}

function formatDay(str) {
  const d = new Date(str + 'T00:00:00');
  return d.toLocaleDateString('ar-EG', { day: '2-digit', month: '2-digit' });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

init();
