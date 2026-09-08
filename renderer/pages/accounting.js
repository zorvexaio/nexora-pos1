// فورمات الأرقام بفواصل آلاف — نفس المنطق المستخدم بصفحة التقارير لتوحيد شكل الأرقام بالتطبيق كله.
function formatMoney(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '0.00';
  return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

let isAdminUser = false;
let accountsCache = [];

async function init() {
  const user = await guardPage(['admin', 'manager'], '../login.html');
  if (!user) return;
  isAdminUser = user.role === 'admin';
  if (!isAdminUser) {
    // إقفال/فتح الفترات وإضافة قيد يدوي/حساب جديد إجراءات حسّاسة محصورة بالأدمن فعلياً
    // بالخلفية (requireAdmin) — نُخفي التبويبين بالواجهة بدل ما نعرضهما ثم نفشل عند الضغط.
    document.getElementById('periodsTabBtn').style.display = 'none';
    document.getElementById('manualTabBtn').style.display = 'none';
  }

  const today = new Date().toISOString().slice(0, 10);
  document.getElementById('trialAsOf').value = today;
  document.getElementById('balanceAsOf').value = today;
  document.getElementById('overviewFrom').value = today.slice(0, 8) + '01';
  document.getElementById('overviewTo').value = today;
  document.getElementById('incomeFrom').value = today.slice(0, 8) + '01';
  document.getElementById('incomeTo').value = today;
  document.getElementById('journalFrom').value = today.slice(0, 8) + '01';
  document.getElementById('journalTo').value = today;
  document.getElementById('ledgerFrom').value = today.slice(0, 8) + '01';
  document.getElementById('ledgerTo').value = today;

  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  document.getElementById('overviewLoadBtn').addEventListener('click', loadOverview);
  document.getElementById('trialLoadBtn').addEventListener('click', loadTrialBalance);
  document.getElementById('incomeLoadBtn').addEventListener('click', loadIncomeStatement);
  document.getElementById('balanceLoadBtn').addEventListener('click', loadBalanceSheet);
  document.getElementById('ledgerLoadBtn').addEventListener('click', loadLedger);
  document.getElementById('journalLoadBtn').addEventListener('click', loadJournal);
  document.getElementById('lockPeriodBtn').addEventListener('click', onLockPeriod);

  document.getElementById('manualEntryDate').value = today;
  document.getElementById('manualToggleNewAccountBtn').addEventListener('click', () => {
    document.getElementById('manualNewAccountRow').classList.toggle('hidden');
  });
  document.getElementById('createAccountBtn').addEventListener('click', onCreateAccount);
  document.getElementById('manualAddLineBtn').addEventListener('click', () => { addManualLine(); recalcManualTotals(); });
  document.getElementById('manualPostBtn').addEventListener('click', onPostManualEntry);

  accountsCache = await window.api.accounting.listAccounts();
  const select = document.getElementById('ledgerAccountSelect');
  select.innerHTML = accountsCache.map((a) => `<option value="${a.id}">${escapeHtml(a.code)} — ${escapeHtml(a.name)}</option>`).join('');

  addManualLine();
  addManualLine();
  recalcManualTotals();

  await loadOverview();
}

function switchTab(name) {
  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('hidden', p.id !== `tab-${name}`));
  if (name === 'trial' && !document.getElementById('trialBody').childElementCount) loadTrialBalance();
  if (name === 'income' && !document.getElementById('incomeRevenueBody').childElementCount) loadIncomeStatement();
  if (name === 'balance' && !document.getElementById('balanceAssetsBody').childElementCount) loadBalanceSheet();
  if (name === 'ledger' && !document.getElementById('ledgerBody').childElementCount) loadLedger();
  if (name === 'journal' && !document.getElementById('journalBody').childElementCount) loadJournal();
  if (name === 'periods') loadPeriods();
}

const accountTypeLabel = (t) => ({ asset: 'أصول', liability: 'خصوم', equity: 'حقوق ملكية', revenue: 'إيراد', expense: 'مصروف' }[t] || t);

// كود الحساب الافتراضي → اسم بسيط بالعربي، لبناء "نظرة عامة" بلغة غير محاسبية.
// الحسابات المخصّصة اللي يضيفها الأدمن (خارج هالقائمة) تُجمع حسب نوعها فقط.
const overviewCashCodes = ['1000', '1100'];
const overviewInventoryCodes = ['1300'];
const overviewReceivableCodes = ['1200'];
const overviewPayableCodes = ['2000'];

function sumByCode(rows, codes) {
  return rows.filter((r) => codes.includes(r.code)).reduce((sum, r) => sum + Number(r.balance), 0);
}

async function loadOverview() {
  const from = document.getElementById('overviewFrom').value || null;
  const to = document.getElementById('overviewTo').value || null;
  const [income, balance] = await Promise.all([
    window.api.accounting.incomeStatement({ from, to }),
    window.api.accounting.balanceSheet(new Date().toISOString().slice(0, 10)),
  ]);

  document.getElementById('ovRevenue').textContent = formatMoney(income.totalRevenue);
  document.getElementById('ovExpense').textContent = formatMoney(income.totalExpense);
  document.getElementById('ovNet').textContent = formatMoney(income.netIncome);
  const netExplain = document.getElementById('ovNetExplain');
  if (income.netIncome > 0) netExplain.textContent = `ربحت ${formatMoney(income.netIncome)} صافي بهالفترة (بعد كل المصاريف).`;
  else if (income.netIncome < 0) netExplain.textContent = `خسرت ${formatMoney(Math.abs(income.netIncome))} صافي بهالفترة — مصاريفك تجاوزت مبيعاتك.`;
  else netExplain.textContent = 'تعادلت مبيعاتك مع مصاريفك بالضبط بهالفترة.';

  const cash = sumByCode(balance.assets, overviewCashCodes);
  const inventory = sumByCode(balance.assets, overviewInventoryCodes);
  const receivable = sumByCode(balance.assets, overviewReceivableCodes);
  const payable = sumByCode(balance.liabilities, overviewPayableCodes);
  document.getElementById('ovCash').textContent = formatMoney(cash);
  document.getElementById('ovInventory').textContent = formatMoney(inventory);
  document.getElementById('ovReceivable').textContent = formatMoney(receivable);
  document.getElementById('ovPayable').textContent = formatMoney(payable);
  document.getElementById('ovEquity').textContent = formatMoney(balance.totalEquity);
}

async function loadTrialBalance() {
  const asOf = document.getElementById('trialAsOf').value || null;
  const result = await window.api.accounting.trialBalance(asOf);
  document.getElementById('trialBody').innerHTML = result.accounts
    .filter((a) => a.debit !== 0 || a.credit !== 0)
    .map((a) => `<tr><td>${escapeHtml(a.code)}</td><td>${escapeHtml(a.name)}</td><td>${escapeHtml(accountTypeLabel(a.accountType))}</td><td class="num">${a.debit ? formatMoney(a.debit) : ''}</td><td class="num">${a.credit ? formatMoney(a.credit) : ''}</td></tr>`)
    .join('');
  document.getElementById('trialTotalDebit').textContent = formatMoney(result.totalDebit);
  document.getElementById('trialTotalCredit').textContent = formatMoney(result.totalCredit);
  const flag = document.getElementById('trialBalanceFlag');
  flag.textContent = result.balanced ? 'متوازن' : 'غير متوازن — راجع القيود';
  flag.className = 'balance-flag ' + (result.balanced ? 'ok' : 'bad');
}

async function loadIncomeStatement() {
  const from = document.getElementById('incomeFrom').value || null;
  const to = document.getElementById('incomeTo').value || null;
  const result = await window.api.accounting.incomeStatement({ from, to });
  document.getElementById('incomeTotalRevenue').textContent = formatMoney(result.totalRevenue);
  document.getElementById('incomeTotalExpense').textContent = formatMoney(result.totalExpense);
  document.getElementById('incomeNet').textContent = formatMoney(result.netIncome);
  document.getElementById('incomeRevenueBody').innerHTML = result.revenue
    .map((r) => `<tr><td>${escapeHtml(r.code)}</td><td>${escapeHtml(r.name)}</td><td class="num">${formatMoney(r.amount)}</td></tr>`).join('')
    || '<tr><td colspan="3" class="empty-state">لا توجد حركة إيرادات بهذه الفترة</td></tr>';
  document.getElementById('incomeExpenseBody').innerHTML = result.expense
    .map((r) => `<tr><td>${escapeHtml(r.code)}</td><td>${escapeHtml(r.name)}</td><td class="num">${formatMoney(r.amount)}</td></tr>`).join('')
    || '<tr><td colspan="3" class="empty-state">لا توجد حركة مصاريف بهذه الفترة</td></tr>';
}

async function loadBalanceSheet() {
  const asOf = document.getElementById('balanceAsOf').value || null;
  const result = await window.api.accounting.balanceSheet(asOf);
  document.getElementById('balanceTotalAssets').textContent = formatMoney(result.totalAssets);
  document.getElementById('balanceTotalLiabilities').textContent = formatMoney(result.totalLiabilities);
  document.getElementById('balanceTotalEquity').textContent = formatMoney(result.totalEquity);
  const flag = document.getElementById('balanceFlag');
  flag.textContent = result.balanced ? 'متوازن (الأصول = الخصوم + حقوق الملكية)' : 'غير متوازن — راجع القيود';
  flag.className = 'balance-flag ' + (result.balanced ? 'ok' : 'bad');
  const row = (r) => `<tr><td>${escapeHtml(r.code)}</td><td>${escapeHtml(r.name)}</td><td class="num">${formatMoney(r.balance)}</td></tr>`;
  document.getElementById('balanceAssetsBody').innerHTML = result.assets.map(row).join('') || '<tr><td colspan="3" class="empty-state">لا شيء</td></tr>';
  document.getElementById('balanceLiabilitiesBody').innerHTML = result.liabilities.map(row).join('') || '<tr><td colspan="3" class="empty-state">لا شيء</td></tr>';
  document.getElementById('balanceEquityBody').innerHTML = result.equity.map(row).join('') || '<tr><td colspan="3" class="empty-state">لا شيء</td></tr>';
}

async function loadLedger() {
  const accountId = document.getElementById('ledgerAccountSelect').value;
  if (!accountId) return;
  const from = document.getElementById('ledgerFrom').value || null;
  const to = document.getElementById('ledgerTo').value || null;
  const result = await window.api.accounting.accountLedger({ accountId, from, to });
  document.getElementById('ledgerOpening').textContent = formatMoney(result.openingBalance);
  document.getElementById('ledgerBody').innerHTML = result.rows
    .map((r) => `<tr><td>${escapeHtml(String(r.date || '').slice(0, 10))}</td><td>${escapeHtml(r.memo || '—')}</td><td>${escapeHtml(r.referenceType || '—')}${r.referenceId ? ' #' + escapeHtml(String(r.referenceId)) : ''}</td><td class="num">${r.debit ? formatMoney(r.debit) : ''}</td><td class="num">${r.credit ? formatMoney(r.credit) : ''}</td><td class="num">${formatMoney(r.balance)}</td></tr>`)
    .join('') || '<tr><td colspan="6" class="empty-state">لا توجد حركات بهذه الفترة</td></tr>';
}

const journalRefLabels = { sale: 'بيع', purchase_order: 'شراء', return: 'مرتجع', supplier_payment: 'دفعة مورد', customer_payment: 'تحصيل عميل', payroll_payment: 'صرف راتب', payroll_accrual: 'استحقاق راتب' };

async function loadJournal() {
  const from = document.getElementById('journalFrom').value || null;
  const to = document.getElementById('journalTo').value || null;
  const entries = await window.api.accounting.listJournalEntries({ from: from ? `${from} 00:00:00` : undefined, to: to ? `${to} 23:59:59` : undefined });
  document.getElementById('journalBody').innerHTML = entries
    .map((e) => `<tr><td>${escapeHtml(String(e.entry_date || '').slice(0, 16).replace('T', ' '))}</td><td>${escapeHtml(e.memo || '—')}</td><td>${escapeHtml(journalRefLabels[e.reference_type] || e.reference_type || '—')}${e.reference_id ? ' #' + escapeHtml(String(e.reference_id)) : ''}</td><td>${escapeHtml(e.status)}</td></tr>`)
    .join('') || '<tr><td colspan="4" class="empty-state">لا توجد قيود بهذه الفترة</td></tr>';
}

async function loadPeriods() {
  const periods = await window.api.accounting.listPeriods();
  document.getElementById('periodLockControls').style.display = isAdminUser ? '' : 'none';
  document.getElementById('periodsBody').innerHTML = periods.map((p) => {
    const locked = p.status === 'locked';
    const actionBtn = isAdminUser
      ? (locked
          ? `<button class="btn btn-secondary btn-sm" data-reopen="${escapeHtml(p.period_key)}">إعادة فتح</button>`
          : `<button class="btn btn-danger btn-sm" data-lock="${escapeHtml(p.period_key)}">إقفال</button>`)
      : '';
    return `<tr><td>${escapeHtml(p.period_key)}</td><td class="${locked ? 'period-locked' : 'period-open'}">${locked ? 'مقفلة' : 'مفتوحة'}</td><td>${escapeHtml(String(p.locked_at || '—'))}</td><td>${actionBtn}</td></tr>`;
  }).join('') || '<tr><td colspan="4" class="empty-state">لا توجد فترات مقفلة بعد — كل الفترات مفتوحة تلقائياً حتى تُقفَل</td></tr>';

  document.querySelectorAll('[data-reopen]').forEach((btn) => btn.addEventListener('click', () => onReopenPeriod(btn.dataset.reopen)));
  document.querySelectorAll('[data-lock]').forEach((btn) => btn.addEventListener('click', () => onLockPeriodKey(btn.dataset.lock)));
}

async function onLockPeriod() {
  const key = document.getElementById('newPeriodKey').value;
  if (!key) { showToast('اختر الشهر أولاً.', 'error'); return; }
  await onLockPeriodKey(key);
}

async function onLockPeriodKey(key) {
  if (!confirm(`تأكيد إقفال الفترة ${key}؟ لن يمكن إضافة أي قيد محاسبي جديد بتاريخ ضمنها (مبيعات/مشتريات/مرتجعات/رواتب) إلا بعد إعادة فتحها.`)) return;
  try {
    await window.api.accounting.lockPeriod(key);
    showToast('تم إقفال الفترة.', 'success');
    await loadPeriods();
  } catch (error) {
    showToast('تعذّر إقفال الفترة: ' + (error.message || error), 'error');
  }
}

async function onReopenPeriod(key) {
  const reason = await promptDialog(`سبب إعادة فتح الفترة ${key} (10 محارف على الأقل — يُسجَّل بسجل التدقيق):`, '');
  if (reason === null) return;
  if (reason.trim().length < 10) { showToast('السبب يجب ألا يقل عن 10 محارف.', 'error'); return; }
  try {
    await window.api.accounting.reopenPeriod({ periodKey: key, reason });
    showToast('تم إعادة فتح الفترة.', 'success');
    await loadPeriods();
  } catch (error) {
    showToast('تعذّر إعادة فتح الفترة: ' + (error.message || error), 'error');
  }
}

/* ---------------- قيد يدوي ---------------- */
let manualLines = [];
let manualLineSeq = 0;

function accountOptionsHtml(selectedId) {
  return '<option value="">اختر حساب…</option>' + accountsCache
    .map((a) => `<option value="${a.id}" ${String(a.id) === String(selectedId) ? 'selected' : ''}>${escapeHtml(a.code)} — ${escapeHtml(a.name)}</option>`)
    .join('');
}

function addManualLine() {
  manualLineSeq += 1;
  manualLines.push({ rowId: manualLineSeq, accountId: '', memo: '', debit: '', credit: '' });
  renderManualLines();
}

function removeManualLine(rowId) {
  if (manualLines.length <= 2) { showToast('القيد يحتاج سطرين على الأقل.', 'error'); return; }
  manualLines = manualLines.filter((l) => l.rowId !== rowId);
  renderManualLines();
  recalcManualTotals();
}

function renderManualLines() {
  const body = document.getElementById('manualLinesBody');
  body.innerHTML = manualLines.map((line) => `
    <tr data-row="${line.rowId}">
      <td><select class="manual-line-account" data-row="${line.rowId}">${accountOptionsHtml(line.accountId)}</select></td>
      <td><input class="manual-line-memo" data-row="${line.rowId}" type="text" value="${escapeHtml(line.memo)}" /></td>
      <td><input class="manual-line-debit num" data-row="${line.rowId}" type="number" step="0.01" min="0" value="${line.debit}" /></td>
      <td><input class="manual-line-credit num" data-row="${line.rowId}" type="number" step="0.01" min="0" value="${line.credit}" /></td>
      <td><button class="btn btn-secondary btn-sm manual-line-remove" data-row="${line.rowId}" type="button">حذف</button></td>
    </tr>`).join('');

  body.querySelectorAll('.manual-line-account').forEach((el) => el.addEventListener('change', (e) => {
    findManualLine(e.target.dataset.row).accountId = e.target.value;
  }));
  body.querySelectorAll('.manual-line-memo').forEach((el) => el.addEventListener('input', (e) => {
    findManualLine(e.target.dataset.row).memo = e.target.value;
  }));
  body.querySelectorAll('.manual-line-debit').forEach((el) => el.addEventListener('input', (e) => {
    const line = findManualLine(e.target.dataset.row);
    line.debit = e.target.value;
    if (Number(e.target.value) > 0) line.credit = '';
    renderManualLines();
    recalcManualTotals();
  }));
  body.querySelectorAll('.manual-line-credit').forEach((el) => el.addEventListener('input', (e) => {
    const line = findManualLine(e.target.dataset.row);
    line.credit = e.target.value;
    if (Number(e.target.value) > 0) line.debit = '';
    renderManualLines();
    recalcManualTotals();
  }));
  body.querySelectorAll('.manual-line-remove').forEach((el) => el.addEventListener('click', (e) => {
    removeManualLine(Number(e.target.dataset.row));
  }));
}

function findManualLine(rowId) {
  return manualLines.find((l) => String(l.rowId) === String(rowId));
}

function recalcManualTotals() {
  const totalDebit = manualLines.reduce((sum, l) => sum + (Number(l.debit) || 0), 0);
  const totalCredit = manualLines.reduce((sum, l) => sum + (Number(l.credit) || 0), 0);
  document.getElementById('manualTotalDebit').textContent = formatMoney(totalDebit);
  document.getElementById('manualTotalCredit').textContent = formatMoney(totalCredit);
  const balanced = totalDebit > 0 && Math.abs(totalDebit - totalCredit) < 0.005;
  const flag = document.getElementById('manualBalanceFlag');
  flag.textContent = balanced ? 'متوازن' : 'غير متوازن';
  flag.className = 'balance-flag ' + (balanced ? 'ok' : 'bad');
  document.getElementById('manualPostBtn').disabled = !balanced;
  return balanced;
}

async function onCreateAccount() {
  const code = document.getElementById('newAccountCode').value.trim();
  const name = document.getElementById('newAccountName').value.trim();
  const type = document.getElementById('newAccountType').value;
  if (!code || !name) { showToast('أدخل كود واسم الحساب.', 'error'); return; }
  try {
    await window.api.accounting.createAccount({ code, name, type });
    showToast('تم إنشاء الحساب.', 'success');
    document.getElementById('newAccountCode').value = '';
    document.getElementById('newAccountName').value = '';
    accountsCache = await window.api.accounting.listAccounts();
    const ledgerSelect = document.getElementById('ledgerAccountSelect');
    const prevLedgerVal = ledgerSelect.value;
    ledgerSelect.innerHTML = accountsCache.map((a) => `<option value="${a.id}">${escapeHtml(a.code)} — ${escapeHtml(a.name)}</option>`).join('');
    if (prevLedgerVal) ledgerSelect.value = prevLedgerVal;
    renderManualLines();
    document.getElementById('manualNewAccountRow').classList.add('hidden');
  } catch (error) {
    showToast('تعذّر إنشاء الحساب: ' + (error.message || error), 'error');
  }
}

async function onPostManualEntry() {
  if (!recalcManualTotals()) return;
  const entryDate = document.getElementById('manualEntryDate').value;
  const memo = document.getElementById('manualEntryMemo').value.trim();
  if (!entryDate) { showToast('اختر التاريخ.', 'error'); return; }
  if (!memo) { showToast('أدخل بيان القيد.', 'error'); return; }
  const lines = manualLines.map((l) => ({
    accountId: Number(l.accountId) || null,
    memo: l.memo || null,
    debit: Number(l.debit) || 0,
    credit: Number(l.credit) || 0,
  }));
  if (lines.some((l) => !l.accountId)) { showToast('اختر حسابًا لكل سطر.', 'error'); return; }
  if (lines.some((l) => l.debit === 0 && l.credit === 0)) { showToast('كل سطر يحتاج مبلغ مدين أو دائن.', 'error'); return; }
  try {
    await window.api.accounting.postEntry({ entryDate, memo, lines });
    showToast('تم ترحيل القيد بنجاح.', 'success');
    manualLines = [];
    addManualLine();
    addManualLine();
    document.getElementById('manualEntryMemo').value = '';
    recalcManualTotals();
    await loadTrialBalance();
    document.getElementById('journalBody').innerHTML = '';
  } catch (error) {
    showToast('تعذّر ترحيل القيد: ' + (error.message || error), 'error');
  }
}

init();
