let allLogs = [];

const branchNameEl = document.getElementById('branchName');
const logsBody = document.getElementById('logsBody');
const emptyState = document.getElementById('emptyState');
const levelFilter = document.getElementById('levelFilter');
const actionFilter = document.getElementById('actionFilter');
const userFilter = document.getElementById('userFilter');
const searchInput = document.getElementById('searchInput');

const actionKeys = {
  login_success: 'audit.actions.login_success', login_failed: 'audit.actions.login_failed', logout: 'audit.actions.logout',
  sale_created: 'audit.actions.sale_created', table_order_updated: 'audit.actions.table_order_updated', table_order_closed: 'audit.actions.table_order_closed',
  tables_merged: 'audit.actions.tables_merged', table_bill_split: 'audit.actions.table_bill_split', return_created: 'audit.actions.return_created',
  inventory_adjusted: 'audit.actions.inventory_adjusted', customer_payment_received: 'audit.actions.customer_payment_received',
  printing_config_updated: 'audit.actions.printing_config_updated', automatic_printed: 'audit.actions.automatic_printed',
  automatic_print_failed: 'audit.actions.automatic_print_failed', runtime_error: 'audit.actions.runtime_error',
};
// أي نوع عملية غير مُترجَم بعد (مثل عمليات الرواتب) يُعرض بصيغة مقروءة تلقائياً
// بدل الاسم البرمجي الخام (مثلاً payroll_worker_added → Payroll worker added)
function humanizeAction(action) {
  return String(action || '').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}
const actionLabel = (action) => t(actionKeys[action], humanizeAction(action));


async function init() {
  const user = await guardPage(['admin'], '../login.html');
  if (!user) return;

  const branch = await window.api.branches.current();
  branchNameEl.textContent = branch ? branch.name : '';

  document.getElementById('refreshBtn').addEventListener('click', loadLogs);
  levelFilter.addEventListener('change', render);
  actionFilter.addEventListener('change', render);
  userFilter.addEventListener('change', render);
  searchInput.addEventListener('input', debounce(render, 200));

  await loadLogs();
}

async function loadLogs() {
  allLogs = await window.api.audit.list();
  fillActionFilter();
  fillUserFilter();
  render();
}

function fillActionFilter() {
  const currentValue = actionFilter.value;
  const uniqueActions = [...new Set(allLogs.map((l) => l.action))].sort();
  actionFilter.innerHTML =
    '<option value="">كل أنواع العمليات</option>' +
    uniqueActions.map((a) => `<option value="${escapeHtml(a)}">${escapeHtml(actionLabel(a))}</option>`).join('');
  actionFilter.value = currentValue;
}

function fillUserFilter() {
  const currentValue = userFilter.value;
  const uniqueUsers = [...new Set(allLogs.map((l) => l.user_name).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ar'));
  userFilter.innerHTML =
    '<option value="">كل الموظفين</option>' +
    uniqueUsers.map((u) => `<option value="${escapeHtml(u)}">${escapeHtml(u)}</option>`).join('');
  userFilter.value = currentValue;
}

function render() {
  const level = levelFilter.value;
  const action = actionFilter.value;
  const userName = userFilter.value;
  const search = searchInput.value.trim().toLowerCase();

  const filtered = allLogs.filter((log) => {
    if (level && log.level !== level) return false;
    if (action && log.action !== action) return false;
    if (userName && (log.user_name || '') !== userName) return false;
    if (search) {
      const haystack = `${log.user_name || ''} ${log.action} ${actionLabel(log.action)}`.toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    return true;
  });

  emptyState.style.display = filtered.length === 0 ? 'block' : 'none';
  logsBody.innerHTML = filtered
    .map((log) => {
      let detailsText = '';
      if (log.details) {
        try {
          detailsText = JSON.stringify(JSON.parse(log.details));
        } catch {
          detailsText = String(log.details);
        }
      }
      return `
        <tr>
          <td>${formatDate(log.created_at)}</td>
          <td>${escapeHtml(log.user_name || '—')}</td>
          <td>${escapeHtml(actionLabel(log.action))}</td>
          <td><span class="audit-level ${['info','warning','error'].includes(log.level) ? log.level : 'info'}">${escapeHtml(levelLabel(log.level))}</span></td>
          <td class="audit-details">${escapeHtml(detailsText)}</td>
        </tr>`;
    })
    .join('');
}

function levelLabel(level) {
  return ({ info: t('audit.info'), warning: t('audit.warning'), error: t('audit.error') })[level] || level;
}

function formatDate(str) {
  if (!str) return '';
  // created_at مخزّن بالخادم بتوقيت UTC (SQLite datetime('now'))؛ لازم نضيف 'Z' صراحة قبل
  // التحويل وإلا JS بيفسّر النص كأنه بالتوقيت المحلي أصلاً (بدون أي إزاحة فعلية) — وهذا كان
  // يعرض وقت كل حركة بسجل التدقيق بتوقيت غرينتش الخام بدل توقيت الجهاز المحلي، وهو أمر
  // حسّاس بالذات بسجل أمني/تدقيقي يُعتمد عليه لمعرفة "مين عمل شو ومتى" بالضبط.
  const d = new Date(str.replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return str;
  return d.toLocaleString('ar-EG', { dateStyle: 'short', timeStyle: 'medium' });
}

init();
