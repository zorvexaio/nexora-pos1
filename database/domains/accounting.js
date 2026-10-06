'use strict';
/** Auto-extracted domain module — refactor batch 3–5. Do not call until h.db is initialized. */
module.exports = function createDomain(h) {
  const money = h.money;
  const accounting = h.accounting;
  const crypto = h.crypto;
  const path = h.path;
  const fs = h.fs;
  const app = h.app;

/* ==========================================================
   المحاسبة + سجل المزامنة
   ========================================================== */
function listAccountingAccounts(){const b=h.getCurrentBranch();return h.db.prepare('SELECT * FROM accounting_accounts WHERE branch_id=? ORDER BY code').all(b.id);}
function createAccountingAccount(input){const b=h.getCurrentBranch();const n=accounting.normalizeAccount(input,Number(h.getGlobalProfile()?.currency_minor_unit ?? 2));const r=h.db.prepare(`INSERT INTO accounting_accounts(uuid,branch_id,code,name,account_type,currency_code,opening_balance_minor,is_active,updated_at,synced) VALUES(?,?,?,?,?,?,?,?,datetime('now'),0)`).run(h.uuid(),b.id,n.code,n.name,n.type,n.currencyCode,n.openingBalanceMinor,n.isActive);return h.db.prepare('SELECT * FROM accounting_accounts WHERE id=?').get(r.lastInsertRowid);}
// يبحث عن حساب محاسبي بكوده داخل فرع معيّن — تُستخدم بكل نقاط الترحيل التلقائي
// (مبيعات/مشتريات/مرتجعات/رواتب) بدل تكرار الاستعلام بكل مكان.
function getAccountingAccountId(branchId, code) {
  const row = h.db.prepare('SELECT id FROM accounting_accounts WHERE branch_id=? AND code=? AND is_active=1').get(branchId, String(code));
  if (!row) throw new Error(`الحساب المحاسبي ${code} غير موجود أو غير نشط بهذا الفرع.`);
  return row.id;
}

function ensureInventoryAdjustmentAccount(branchId) {
  const currency = String(h.getGlobalProfile()?.currency_code || 'USD').toUpperCase();
  h.db.prepare('INSERT OR IGNORE INTO accounting_accounts(uuid,branch_id,code,name,account_type,currency_code) VALUES(?,?,?,?,?,?)')
    .run(h.uuid(), branchId, '5900', 'Inventory Adjustments', 'expense', currency);
  return getAccountingAccountId(branchId, '5900');
}
// تاريخ محلي للمنشأة (YYYY-MM-DD) حسب timezone — لا UTC.
function accountingTodayLocal() {
  const profile = h.getGlobalProfile();
  const timeZone = profile?.timezone || 'Europe/Istanbul';
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  } catch (_) {
    return new Date().toISOString().slice(0, 10);
  }
}
// مفتاح الفترة المحاسبية بصيغة YYYY-MM من تاريخ محلي أو ISO.
function accountingPeriodKeyOf(dateStr) {
  const raw = String(dateStr || accountingTodayLocal()).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 7);
  try {
    const profile = h.getGlobalProfile();
    const timeZone = profile?.timezone || 'Europe/Istanbul';
    const d = new Date(raw);
    if (!isNaN(d.getTime())) {
      const ym = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit' }).format(d);
      return ym.slice(0, 7);
    }
  } catch (_) { /* fallthrough */ }
  return accountingTodayLocal().slice(0, 7);
}
function isAccountingPeriodLocked(branchId, dateStr) {
  const row = h.db.prepare('SELECT status FROM accounting_periods WHERE branch_id=? AND period_key=?').get(branchId, accountingPeriodKeyOf(dateStr));
  return !!row && row.status === 'locked';
}
// للحركات بلا قيد يومية أيضاً (تحويل مخزون، …)
function assertAccountingPeriodOpen(branchId, dateStr = null) {
  const keyDate = dateStr || accountingTodayLocal();
  if (isAccountingPeriodLocked(branchId, keyDate)) {
    throw new Error(`الفترة المحاسبية ${accountingPeriodKeyOf(keyDate)} مقفلة — لا يمكن تنفيذ هذه الحركة. أعد فتح الفترة أولاً إذا كان التعديل ضرورياً.`);
  }
}
function insertPostedJournalEntry({ branchId, memo = null, referenceType = null, referenceId = null, entryDate = null, lines = [], createdBy = null, currencyCode = null }) {
  const p = h.getGlobalProfile();
  const unit = Number(p?.currency_minor_unit ?? 2);
  const finalEntryDate = entryDate || accountingTodayLocal();
  if (isAccountingPeriodLocked(branchId, finalEntryDate)) {
    throw new Error(`الفترة المحاسبية ${accountingPeriodKeyOf(finalEntryDate)} مقفلة — لا يمكن إضافة أو تعديل قيود بتاريخ ضمنها. أعد فتح الفترة أولاً إذا كان التعديل ضرورياً.`);
  }
  const normalized = lines.map((l) => ({
    ...l,
    debitMinor: l.debitMinor != null ? Number(l.debitMinor) : money.toMinor(l.debit || 0, unit),
    creditMinor: l.creditMinor != null ? Number(l.creditMinor) : money.toMinor(l.credit || 0, unit),
  }));
  accounting.validateJournalLines(normalized);
  const currency = String(currencyCode || p?.currency_code || 'USD').toUpperCase();
  const e = h.db.prepare(`INSERT INTO accounting_journal_entries(uuid,branch_id,reference_type,reference_id,memo,currency_code,entry_date,status,created_by,synced) VALUES(?,?,?,?,?,?,?,'posted',?,0)`)
    .run(h.uuid(), branchId, referenceType, referenceId == null ? null : String(referenceId), memo, currency, finalEntryDate, createdBy || null);
  const ins = h.db.prepare('INSERT INTO accounting_journal_lines(entry_id,account_id,debit_minor,credit_minor,memo) VALUES(?,?,?,?,?)');
  for (const line of normalized) ins.run(e.lastInsertRowid, Number(line.accountId), Number(line.debitMinor || 0), Number(line.creditMinor || 0), line.memo || null);
  return h.db.prepare('SELECT * FROM accounting_journal_entries WHERE id=?').get(e.lastInsertRowid);
}
function postJournalEntry(input = {}) {
  const b = h.getCurrentBranch();
  return h.db.transaction(() => insertPostedJournalEntry({ ...input, branchId: b.id }))();
}
function listJournalEntries(range={}){const b=h.getCurrentBranch();let sql='SELECT * FROM accounting_journal_entries WHERE branch_id=?';const a=[b.id];if(range.from){sql+=' AND entry_date>=?';a.push(range.from);}if(range.to){sql+=' AND entry_date<=?';a.push(range.to);}return h.db.prepare(sql+' ORDER BY entry_date DESC,id DESC LIMIT 1000').all(...a);}

/* ---------------- إقفال الفترات المحاسبية ---------------- */
function listAccountingPeriods() {
  const b = h.getCurrentBranch();
  return h.db.prepare('SELECT * FROM accounting_periods WHERE branch_id=? ORDER BY period_key DESC').all(b.id);
}
function lockAccountingPeriod(periodKey, userId) {
  const key = String(periodKey || '').trim();
  if (!/^\d{4}-\d{2}$/.test(key)) throw new Error('صيغة الفترة المحاسبية غير صالحة (المتوقع YYYY-MM).');
  const b = h.getCurrentBranch();
  h.db.prepare(`INSERT INTO accounting_periods(branch_id,period_key,status,locked_at,locked_by) VALUES(?,?,'locked',datetime('now'),?)
    ON CONFLICT(branch_id,period_key) DO UPDATE SET status='locked', locked_at=datetime('now'), locked_by=excluded.locked_by`).run(b.id, key, userId || null);
  h.logAudit({ userId, branchId: b.id, action: 'accounting_period_locked', entityType: 'accounting_period', entityId: key, level: 'warning', details: { periodKey: key } });
  return { success: true, periodKey: key, status: 'locked' };
}
// إعادة فتح فترة مقفلة استثناء وليس عادة — تُسجَّل بمستوى تحذير مع السبب لأنها
// تتيح لاحقاً قيوداً بتاريخ كان يُفترض أنه محسوم بتقارير سابقة.
function reopenAccountingPeriod(periodKey, userId, reason) {
  const key = String(periodKey || '').trim();
  const text = String(reason || '').trim();
  if (text.length < 10) throw new Error('سبب إعادة فتح الفترة المحاسبية يجب ألا يقل عن 10 محارف.');
  const b = h.getCurrentBranch();
  const row = h.db.prepare('SELECT * FROM accounting_periods WHERE branch_id=? AND period_key=?').get(b.id, key);
  if (!row || row.status !== 'locked') throw new Error('هذه الفترة غير مقفلة أصلاً.');
  h.db.prepare(`UPDATE accounting_periods SET status='open', locked_at=NULL, locked_by=NULL WHERE branch_id=? AND period_key=?`).run(b.id, key);
  h.logAudit({ userId, branchId: b.id, action: 'accounting_period_reopened', entityType: 'accounting_period', entityId: key, level: 'warning', details: { periodKey: key, reason: text } });
  return { success: true, periodKey: key, status: 'open' };
}

/* ---------------- تقارير مالية: ميزان المراجعة / الدخل / المركز المالي / دفتر الأستاذ ---------------- */
// حارس أمان للمسار السريع: current_balance_minor يمثّل "الرصيد الحالي" (كل القيود
// المرحّلة بلا حد تاريخ). هذا يطابق تماماً نتيجة الاستعلام القديم فقط إذا ما في قيد
// مرحّل بتاريخ بعد حد الاستعلام (cutoff) — فحص رخيص عبر الفهرس الموجود أصلاً على
// (branch_id, entry_date). لو رجّع أي صف، معناها في قيود "مستقبلية" بالنسبة لهذا
// الحد، فنرجع فوراً للاستعلام الدقيق القديم بدون أي تغيير بالنتيجة أو السلوك.
function hasPostedEntriesAfterCutoff(branchId, cutoff) {
  return !!h.db.prepare(`SELECT 1 FROM accounting_journal_entries WHERE branch_id=? AND status='posted' AND entry_date > ? LIMIT 1`).get(branchId, cutoff);
}
// نفس منطق دالة getIncomeStatement(null, toDate) تماماً (نفس الصيغة الحسابية والتقريب
// بالنهاية) لكن محسوبة من current_balance_minor المخزّن مباشرة بدل مسح كل سطور
// اليومية من جديد — تُستخدم فقط لما يثبت الحارس أعلاه أنها مطابقة 100%.
function getNetIncomeToDateFast(branchId, unit) {
  const row = h.db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN account_type='revenue' THEN current_balance_minor ELSE 0 END),0) AS revenue_delta,
           COALESCE(SUM(CASE WHEN account_type='expense' THEN current_balance_minor ELSE 0 END),0) AS expense_delta
    FROM accounting_accounts WHERE branch_id=?`).get(branchId);
  const totalRevenue = money.fromMinor(-Number(row.revenue_delta || 0), unit);
  const totalExpense = money.fromMinor(Number(row.expense_delta || 0), unit);
  return Math.round((totalRevenue - totalExpense) * 10 ** unit) / 10 ** unit;
}
// ميزان المراجعة: رصيد كل حساب حتى تاريخ معيّن (أو حتى الآن)، مبني على الرصيد
// الافتتاحي + صافي حركة القيود المرحّلة فقط (status='posted').
function getTrialBalance(asOfDate = null) {
  const b = h.getCurrentBranch();
  const cutoff = asOfDate ? `${asOfDate}T23:59:59.999Z` : '9999-12-31T23:59:59.999Z';
  const unit = Number(h.getGlobalProfile()?.currency_minor_unit ?? 2);
  const canUseCache = !hasPostedEntriesAfterCutoff(b.id, cutoff);
  const rows = canUseCache
    ? h.db.prepare(`
      SELECT a.id, a.code, a.name, a.account_type, a.opening_balance_minor + a.current_balance_minor AS balance_minor
      FROM accounting_accounts a WHERE a.branch_id=? AND a.is_active=1 ORDER BY a.code`).all(b.id)
    : h.db.prepare(`
      SELECT a.id, a.code, a.name, a.account_type,
        a.opening_balance_minor + COALESCE((
          SELECT SUM(l.debit_minor - l.credit_minor) FROM accounting_journal_lines l
          JOIN accounting_journal_entries e ON e.id = l.entry_id
          WHERE l.account_id = a.id AND e.branch_id = a.branch_id AND e.status='posted' AND e.entry_date <= ?
        ), 0) AS balance_minor
      FROM accounting_accounts a WHERE a.branch_id=? AND a.is_active=1 ORDER BY a.code`).all(cutoff, b.id);
  const accounts = rows.map((r) => ({
    id: r.id, code: r.code, name: r.name, accountType: r.account_type,
    debit: r.balance_minor > 0 ? money.fromMinor(r.balance_minor, unit) : 0,
    credit: r.balance_minor < 0 ? money.fromMinor(-r.balance_minor, unit) : 0,
    balance: money.fromMinor(r.balance_minor, unit),
  }));
  const totalDebit = accounts.reduce((s, r) => s + r.debit, 0);
  const totalCredit = accounts.reduce((s, r) => s + r.credit, 0);
  return { asOfDate: asOfDate || null, accounts, totalDebit, totalCredit, balanced: Math.abs(totalDebit - totalCredit) < (1 / 10 ** unit) };
}
// قائمة الدخل بين تاريخين: الإيرادات (رصيد دائن طبيعي) والمصاريف (رصيد مدين طبيعي).
function getIncomeStatement(fromDate = null, toDate = null) {
  const b = h.getCurrentBranch();
  const from = fromDate ? `${fromDate} 00:00:00` : '0001-01-01 00:00:00';
  const to = toDate ? `${toDate}T23:59:59.999Z` : '9999-12-31T23:59:59.999Z';
  const unit = Number(h.getGlobalProfile()?.currency_minor_unit ?? 2);
  const rows = h.db.prepare(`
    SELECT a.code, a.name, a.account_type, COALESCE(SUM(l.credit_minor - l.debit_minor),0) AS net_minor
    FROM accounting_accounts a
    JOIN accounting_journal_lines l ON l.account_id=a.id
    JOIN accounting_journal_entries e ON e.id=l.entry_id
    WHERE a.branch_id=? AND e.branch_id=a.branch_id AND e.status='posted' AND e.entry_date BETWEEN ? AND ?
      AND a.account_type IN ('revenue','expense')
    GROUP BY a.id ORDER BY a.account_type DESC, a.code`).all(b.id, from, to);
  const toLine = (r) => ({ code: r.code, name: r.name, amount: money.fromMinor(r.account_type === 'revenue' ? r.net_minor : -r.net_minor, unit) });
  const revenue = rows.filter((r) => r.account_type === 'revenue').map(toLine);
  const expense = rows.filter((r) => r.account_type === 'expense').map(toLine);
  const totalRevenue = revenue.reduce((s, r) => s + r.amount, 0);
  const totalExpense = expense.reduce((s, r) => s + r.amount, 0);
  return { fromDate: fromDate || null, toDate: toDate || null, revenue, expense, totalRevenue, totalExpense, netIncome: Math.round((totalRevenue - totalExpense) * 10 ** unit) / 10 ** unit };
}
// المركز المالي (الميزانية) حتى تاريخ معيّن: أصول/خصوم/حقوق ملكية، مع ترحيل صافي
// دخل الفترة كـ"أرباح مرحّلة" لأن حسابات الإيراد/المصروف لا تُعرض هنا مباشرة —
// هذا ما يضمن Assets = Liabilities + Equity فعلياً.
function getBalanceSheet(asOfDate = null) {
  const b = h.getCurrentBranch();
  const cutoff = asOfDate ? `${asOfDate}T23:59:59.999Z` : '9999-12-31T23:59:59.999Z';
  const unit = Number(h.getGlobalProfile()?.currency_minor_unit ?? 2);
  const canUseCache = !hasPostedEntriesAfterCutoff(b.id, cutoff);
  const rows = canUseCache
    ? h.db.prepare(`
      SELECT a.code, a.name, a.account_type, a.opening_balance_minor + a.current_balance_minor AS balance_minor
      FROM accounting_accounts a WHERE a.branch_id=? AND a.is_active=1 AND a.account_type IN ('asset','liability','equity')
      ORDER BY a.code`).all(b.id)
    : h.db.prepare(`
      SELECT a.code, a.name, a.account_type,
        a.opening_balance_minor + COALESCE((
          SELECT SUM(l.debit_minor - l.credit_minor) FROM accounting_journal_lines l
          JOIN accounting_journal_entries e ON e.id = l.entry_id
          WHERE l.account_id = a.id AND e.branch_id = a.branch_id AND e.status='posted' AND e.entry_date <= ?
        ), 0) AS balance_minor
      FROM accounting_accounts a WHERE a.branch_id=? AND a.is_active=1 AND a.account_type IN ('asset','liability','equity')
      ORDER BY a.code`).all(cutoff, b.id);
  const toRow = (r, flip) => ({ code: r.code, name: r.name, balance: money.fromMinor(flip ? -r.balance_minor : r.balance_minor, unit) });
  const assets = rows.filter((r) => r.account_type === 'asset').map((r) => toRow(r, false));
  const liabilities = rows.filter((r) => r.account_type === 'liability').map((r) => toRow(r, true));
  const equityAccounts = rows.filter((r) => r.account_type === 'equity').map((r) => toRow(r, true));
  // كانت هذي دايماً بتستدعي getIncomeStatement(null, asOfDate) اللي بيعيد مسح *كل*
  // سطور اليومية من أول يوم — أغلى استعلام بالصفحة، ومكرَّر مرتين مع استدعاء قائمة
  // الدخل المنفصل من شاشة النظرة العامة. لما الحارس يسمح، منستخدم النسخة المحسوبة
  // من current_balance_minor مباشرة (نفس الرقم بالضبط، بدون مسح جدول اليومية).
  const netIncomeToDate = canUseCache ? getNetIncomeToDateFast(b.id, unit) : getIncomeStatement(null, asOfDate || null).netIncome;
  const equity = [...equityAccounts, { code: '3900', name: 'أرباح مرحّلة (الفترة الحالية)', balance: netIncomeToDate }];
  const totalAssets = Math.round(assets.reduce((s, r) => s + r.balance, 0) * 10 ** unit) / 10 ** unit;
  const totalLiabilities = Math.round(liabilities.reduce((s, r) => s + r.balance, 0) * 10 ** unit) / 10 ** unit;
  const totalEquity = Math.round(equity.reduce((s, r) => s + r.balance, 0) * 10 ** unit) / 10 ** unit;
  return { asOfDate: asOfDate || null, assets, liabilities, equity, totalAssets, totalLiabilities, totalEquity, balanced: Math.abs(totalAssets - (totalLiabilities + totalEquity)) < (1 / 10 ** unit) };
}
// دفتر أستاذ حساب واحد: رصيد افتتاحي حتى بداية المدى ثم كل حركة بالتسلسل مع رصيد جارٍ.
function getAccountLedger(accountId, fromDate = null, toDate = null) {
  const b = h.getCurrentBranch();
  const account = h.db.prepare('SELECT * FROM accounting_accounts WHERE id=? AND branch_id=?').get(Number(accountId), b.id);
  if (!account) throw new Error('الحساب غير موجود في الفرع الحالي.');
  const from = fromDate ? `${fromDate} 00:00:00` : '0001-01-01 00:00:00';
  const to = toDate ? `${toDate}T23:59:59.999Z` : '9999-12-31T23:59:59.999Z';
  const unit = Number(h.getGlobalProfile()?.currency_minor_unit ?? 2);
  const openingBeforeMinor = h.db.prepare(`
    SELECT COALESCE(SUM(l.debit_minor - l.credit_minor),0) AS v FROM accounting_journal_lines l
    JOIN accounting_journal_entries e ON e.id=l.entry_id
    WHERE l.account_id=? AND e.status='posted' AND e.entry_date < ?`).get(Number(accountId), from).v;
  let running = Number(account.opening_balance_minor || 0) + Number(openingBeforeMinor || 0);
  const openingBalance = money.fromMinor(running, unit);
  const lines = h.db.prepare(`
    SELECT l.debit_minor, l.credit_minor, l.memo, e.entry_date, e.memo AS entry_memo, e.reference_type, e.reference_id
    FROM accounting_journal_lines l JOIN accounting_journal_entries e ON e.id=l.entry_id
    WHERE l.account_id=? AND e.status='posted' AND e.entry_date BETWEEN ? AND ?
    ORDER BY e.entry_date, l.id`).all(Number(accountId), from, to);
  const rows = lines.map((l) => {
    running += Number(l.debit_minor || 0) - Number(l.credit_minor || 0);
    return {
      date: l.entry_date, memo: l.memo || l.entry_memo || null, referenceType: l.reference_type, referenceId: l.reference_id,
      debit: money.fromMinor(l.debit_minor, unit), credit: money.fromMinor(l.credit_minor, unit), balance: money.fromMinor(running, unit),
    };
  });
  return { account: { id: account.id, code: account.code, name: account.name, type: account.account_type }, openingBalance, rows };
}
function recordSyncOutboxEvent({entityType,entityUuid=null,operation='event',payload={}}){const b=h.getCurrentBranch();const eventId=h.uuid();const json=JSON.stringify(payload);const checksum=crypto.createHash('sha256').update(json).digest('hex');h.db.prepare('INSERT INTO sync_outbox(event_id,branch_id,entity_type,entity_uuid,operation,payload_json,payload_checksum) VALUES(?,?,?,?,?,?,?)').run(eventId,b.id,String(entityType),entityUuid,operation,json,checksum);return eventId;}
function listSyncConflicts(limit=200){const b=h.getCurrentBranch();return h.db.prepare('SELECT * FROM sync_conflicts WHERE branch_id=? ORDER BY id DESC LIMIT ?').all(b.id,Math.min(Math.max(Number(limit)||50,1),500));}
function listBackupManifests(limit=100){return h.db.prepare('SELECT * FROM backup_manifests ORDER BY created_at DESC LIMIT ?').all(Math.min(Math.max(Number(limit)||50,1),500));}

function saveFiscalDocument(input = {}) {
  const branch = h.getCurrentBranch();
  const result = h.db.prepare(`INSERT INTO fiscal_documents(uuid,branch_id,sale_id,provider,status,external_id,external_number,request_payload,response_payload,issued_at) VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .run(h.uuid(), branch.id, Number(input.saleId) || null, String(input.provider || 'generic'), String(input.status || 'pending'), input.externalId || null, input.externalNumber || null, input.requestPayload == null ? null : JSON.stringify(input.requestPayload), input.responsePayload == null ? null : JSON.stringify(input.responsePayload), input.issuedAt || null);
  return h.db.prepare('SELECT * FROM fiscal_documents WHERE id=?').get(result.lastInsertRowid);
}
function listFiscalDocuments(filters = {}) {
  const branch = h.getCurrentBranch();
  let sql = 'SELECT * FROM fiscal_documents WHERE branch_id=?'; const params = [branch.id];
  if (filters.saleId) { sql += ' AND sale_id=?'; params.push(Number(filters.saleId)); }
  if (filters.status) { sql += ' AND status=?'; params.push(String(filters.status)); }
  sql += ' ORDER BY id DESC LIMIT 500';
  return h.db.prepare(sql).all(...params);
}


  return {
    listAccountingAccounts,
    createAccountingAccount,
    getAccountingAccountId,
    ensureInventoryAdjustmentAccount,
    accountingTodayLocal,
    accountingPeriodKeyOf,
    isAccountingPeriodLocked,
    assertAccountingPeriodOpen,
    insertPostedJournalEntry,
    postJournalEntry,
    listJournalEntries,
    listAccountingPeriods,
    lockAccountingPeriod,
    reopenAccountingPeriod,
    hasPostedEntriesAfterCutoff,
    getNetIncomeToDateFast,
    getTrialBalance,
    getIncomeStatement,
    getBalanceSheet,
    getAccountLedger,
    recordSyncOutboxEvent,
    listSyncConflicts,
    listBackupManifests,
    saveFiscalDocument,
    listFiscalDocuments
  };
};
