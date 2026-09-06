let currentSale = null;

const saleIdInput = document.getElementById('saleIdInput');
const loadSaleBtn = document.getElementById('loadSaleBtn');
const saleReturnPanel = document.getElementById('saleReturnPanel');
const saleIdLabel = document.getElementById('saleIdLabel');
const returnItemsBody = document.getElementById('returnItemsBody');
const returnReasonInput = document.getElementById('returnReasonInput');
const refundMethodSelect = document.getElementById('refundMethodSelect');
const refundTotalPreview = document.getElementById('refundTotalPreview');
const confirmReturnBtn = document.getElementById('confirmReturnBtn');

async function init() {
  const user = await guardPage(['admin', 'manager'], '../login.html');
  if (!user) return;
  const branch = await window.api.branches.current();
  document.getElementById('branchName').textContent = branch ? branch.name : '';

  loadSaleBtn.addEventListener('click', loadSale);
  confirmReturnBtn.addEventListener('click', submitReturn);
}

async function loadSale() {
  const invoiceNumber = normalizeDigits(saleIdInput.value.trim());
  if (!invoiceNumber) return;
  const sale = await window.api.returns.saleForReturn(invoiceNumber);
  if (!sale) {
    alert(ts('لا توجد فاتورة بهذا الرقم'));
    saleReturnPanel.classList.add('hidden');
    return;
  }
  if (sale.status === 'refunded') {
    alert(ts('هذه الفاتورة مرتجعة بالكامل مسبقاً'));
  }
  currentSale = sale;
  saleIdLabel.textContent = sale.invoice_number || sale.id;
  renderItems();
  saleReturnPanel.classList.remove('hidden');
}

function renderItems() {
  returnItemsBody.innerHTML = '';
  for (const item of currentSale.items) {
    const maxReturnable = item.quantity - item.already_returned;
    // منتجات الوزن (كيلو/لتر) تُباع بكميات كسرية (1.25 كغم مثلاً)، فخانة الإرجاع لازم تسمح
    // بكسور فعلياً — step="1" كان يمنع ذلك عملياً (مؤشرات الزيادة/النقصان + تحقق الصلاحية).
    const isFractional = ['kg', 'liter'].includes(item.unit);
    const step = isFractional ? '0.001' : '1';
    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${escapeHtml(item.product_name)}</td>
      <td>${item.quantity}</td>
      <td>${item.already_returned}</td>
      <td>
        <input type="number" min="0" max="${maxReturnable}" step="${step}" value="0"
          data-sale-item-id="${item.id}" data-unit-price="${item.unit_price}" style="width:80px;" ${maxReturnable <= 0 ? 'disabled' : ''} />
      </td>
      <td>${item.unit_price.toFixed(2)}</td>
    `;
    returnItemsBody.appendChild(row);
  }
  returnItemsBody.querySelectorAll('input').forEach((el) => el.addEventListener('input', updatePreview));
  updatePreview();
}

function updatePreview() {
  let total = 0;
  returnItemsBody.querySelectorAll('input').forEach((el) => {
    const qty = parseFloat(el.value) || 0;
    total += qty * parseFloat(el.dataset.unitPrice);
  });
  refundTotalPreview.textContent = `${t('returns.refundTotal','إجمالي الاسترداد')}: ${total.toFixed(2)}`;
}

async function submitReturn() {
  const items = [];
  returnItemsBody.querySelectorAll('input').forEach((el) => {
    const qty = parseFloat(el.value) || 0;
    if (qty > 0) items.push({ saleItemId: parseInt(el.dataset.saleItemId, 10), quantity: qty });
  });
  if (items.length === 0) {
    alert(ts('حدد كمية إرجاع لصنف واحد على الأقل'));
    return;
  }
  if (!confirm(ts('هل تريد تنفيذ هذا المرتجع؟ سيتم إرجاع الكمية للمخزون تلقائياً.'))) return;

  confirmReturnBtn.disabled = true;
  try {
    const result = await window.api.returns.create({
      saleId: currentSale.id,
      items,
      reason: returnReasonInput.value.trim(),
      refundMethod: refundMethodSelect.value,
      clientRequestId: (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`),
    });
    alert(`${t('returns.success','تم تنفيذ المرتجع بنجاح. المبلغ المسترد')}: ${result.totalRefunded.toFixed(2)}`);
    saleReturnPanel.classList.add('hidden');
    saleIdInput.value = '';
  } catch (err) {
    alert(ts('حدث خطأ: ') + err.message);
  } finally {
    confirmReturnBtn.disabled = false;
  }
}

init();
