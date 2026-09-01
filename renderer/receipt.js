async function init() {
  let lang = 'ar';
  try {
    if (window.api && window.api.language) lang = (await window.api.language.get()) || 'ar';
  } catch (err) {
    // نستمر باللغة الافتراضية إن تعذّر القراءة
  }
  applyTranslations(lang);

  const params = new URLSearchParams(window.location.search);
  const saleId = parseInt(params.get('saleId'), 10);
  const receiptEl = document.getElementById('receipt');

  if (!saleId) {
    receiptEl.textContent = t('receipt.invalidInvoice');
    return;
  }

  const sale = await window.api.sales.get(saleId);
  if (!sale) {
    receiptEl.textContent = t('receipt.notFound');
    return;
  }

  const [branding, currency] = await Promise.all([window.api.branding.get(), window.api.currency.get()]);
  renderReceipt(sale, branding, currency);
  const qrDataUrl = await window.api.receipt.qr(saleId);
  const qrImage = document.getElementById('receiptQr');
  if (qrDataUrl && qrImage) { qrImage.src = qrDataUrl; qrImage.style.display = 'block'; }
  document.body.dataset.printReady = '1';

}

function renderReceipt(sale, branding, currency = {}) {
  const PAYMENT_LABELS = { cash: t('receipt.cash'), card: t('receipt.card'), mixed: t('common.mixed') };
  const DISCOUNT_TYPE_LABELS = { percent: t('pos.percent'), fixed: t('pos.fixedAmount') };

  const receiptEl = document.getElementById('receipt');
  const storeName = (branding && branding.storeName) || (sale.branch ? sale.branch.name : t('receipt.defaultStoreName'));
  const logoUrl = branding && branding.logoPath ? 'file://' + branding.logoPath.replace(/\\/g, '/') : '';
  const itemsHtml = sale.items
    .map(
      (i) => `
      <div class="receipt-item">
        <div class="receipt-item-name">${escapeHtml(i.product_name)}</div>
        <div class="receipt-item-row">
          <span>${i.quantity} × ${i.unit_price.toFixed(2)}</span>
          <span>${i.line_total.toFixed(2)}</span>
        </div>
        ${i.notes ? `<div class="receipt-item-note">${escapeHtml(i.notes)}</div>` : ''}
      </div>`
    )
    .join('');

  let paymentHtml = `<div class="receipt-row"><span>${t('receipt.paymentMethod')}</span><span>${
    PAYMENT_LABELS[sale.payment_method] || escapeHtml(sale.payment_method || '')
  }</span></div>`;

  if (sale.payment_method === 'cash') {
    const received = sale.cash_amount + sale.change_due;
    paymentHtml += `
      <div class="receipt-row"><span>${t('receipt.cashReceived')}</span><span>${received.toFixed(2)}</span></div>
      <div class="receipt-row"><span>${t('receipt.changeDue')}</span><span>${sale.change_due.toFixed(2)}</span></div>`;
  } else if (sale.payment_method === 'mixed') {
    paymentHtml += `
      <div class="receipt-row"><span>${t('receipt.cash')}</span><span>${sale.cash_amount.toFixed(2)}</span></div>
      <div class="receipt-row"><span>${t('receipt.card')}</span><span>${sale.card_amount.toFixed(2)}</span></div>`;
  }

  receiptEl.innerHTML = `
    <div class="receipt-header">
      ${logoUrl ? `<img id="receiptLogo" class="receipt-logo" src="${escapeHtml(logoUrl)}" alt="" />` : ''}
      <div class="receipt-brand">${escapeHtml(storeName)}</div>
      <div class="receipt-meta">${t('receipt.invoiceNumber')} ${escapeHtml(sale.invoice_number || String(sale.id))}${sale.table_name ? ` — ${escapeHtml(sale.table_name)}` : ''}</div>
      ${currency.taxNumber ? `<div class="receipt-meta">${t('receipt.taxNumber')}: ${escapeHtml(currency.taxNumber)}</div>` : ''}
      <div class="receipt-meta">${formatDate(sale.created_at)}</div>
      ${sale.customer_name ? `<div class="receipt-meta">${t('receipt.customer')}: ${escapeHtml(sale.customer_name)}</div>` : ''}
      ${sale.order_type === 'delivery' ? `<div class="receipt-meta">${t('receipt.deliveryOrder')}${sale.delivery_person ? ` — ${t('receipt.deliveryPerson')}: ${escapeHtml(sale.delivery_person)}` : ''}</div>` : ''}
    </div>

    <div class="receipt-divider"></div>

    <div class="receipt-items">${itemsHtml}</div>

    <div class="receipt-divider"></div>

    <div class="receipt-row"><span>${t('common.subtotal')}</span><span>${sale.subtotal.toFixed(2)}</span></div>
    <div class="receipt-row"><span>${t('common.tax')}</span><span>${sale.tax_total.toFixed(2)}</span></div>
    ${
      sale.discount_total
        ? `<div class="receipt-row"><span>${t('receipt.discount')}${sale.discount_type ? ` (${DISCOUNT_TYPE_LABELS[sale.discount_type] || escapeHtml(sale.discount_type || '')})` : ''}</span><span>-${sale.discount_total.toFixed(2)}</span></div>`
        : ''
    }
    ${sale.order_type === 'delivery' && sale.delivery_fee ? `<div class="receipt-row"><span>${t('receipt.deliveryFee')}</span><span>${sale.delivery_fee.toFixed(2)}</span></div>` : ''}
    <div class="receipt-row receipt-total"><span>${t('receipt.total')}</span><span>${sale.grand_total.toFixed(2)} ${escapeHtml(currency.base || '')}</span></div>
    ${currency.secondary && currency.secondary !== currency.base ? `<div class="receipt-row"><span>${t('receipt.secondaryCurrency')}</span><span>${(sale.grand_total * (sale.exchange_rate || currency.rate || 1)).toFixed(2)} ${escapeHtml(currency.secondary)}</span></div>` : ''}
    ${sale.due_amount ? `<div class="receipt-row"><span>${t('receipt.dueAmount')}</span><span>${sale.due_amount.toFixed(2)}</span></div>` : ''}

    <div class="receipt-divider"></div>
    ${paymentHtml}

    <img id="receiptQr" class="receipt-qr" alt="QR" style="display:none" />
    <div class="receipt-footer">${t('receipt.thankYou')}</div>
  `;

  // إذا فشل تحميل ملف الشعار (حُذف من القرص، أو مسار غير صالح)، لا نترك أيقونة صورة
  // مكسورة تتصادم بصرياً مع اسم المتجر — نخفيها فوراً ويبقى الاسم وحده واضحاً.
  const logoImg = document.getElementById('receiptLogo');
  if (logoImg) logoImg.addEventListener('error', () => logoImg.remove(), { once: true });
}

function formatDate(str) {
  const d = new Date(str.replace(' ', 'T') + 'Z');
  const lang = document.documentElement.getAttribute('data-lang') || 'ar';
  const LOCALES = { ar: 'ar-EG', tr: 'tr-TR', en: 'en-US' };
  return d.toLocaleString(LOCALES[lang] || 'ar-EG', { dateStyle: 'medium', timeStyle: 'short' });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

init();
