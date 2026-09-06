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
  const ticketEl = document.getElementById('ticket');

  if (!saleId) {
    ticketEl.textContent = t('kitchen.invalidOrder');
    return;
  }

  const sale = await window.api.sales.get(saleId);
  if (!sale) {
    ticketEl.textContent = t('kitchen.notFound');
    return;
  }

  const itemsHtml = sale.items
    .map(
      (i) => `
      <div class="kitchen-item">
        <span class="kitchen-item-qty">${i.quantity}×</span>
        <span class="kitchen-item-name">${escapeHtml(i.product_name)}</span>
        ${i.notes ? `<div class="kitchen-item-note">⚠ ${escapeHtml(i.notes)}</div>` : ''}
      </div>`
    )
    .join('');

  const deliveryTimeHtml = sale.order_type === 'delivery'
    ? `<div class="kitchen-delivery-time">🛵 ${sale.delivery_time ? t('kitchen.deliverAt') + ' ' + formatDate(sale.delivery_time) : t('kitchen.deliverNow')}</div>`
    : '';
  // ملاحظة الطلب العامة (مش ملاحظة صنف بعينه) — لازم تكون واضحة جداً للمطبخ لأنها
  // ممكن تكون تعليمات مهمة ("حساسية مكسرات"، "بدون بصل خالص")، فمعاملتها زي تحذير كبير.
  const orderNoteHtml = sale.notes ? `<div class="kitchen-order-note">⚠ ${escapeHtml(sale.notes)}</div>` : '';

  ticketEl.innerHTML = `
    <div class="receipt-header">
      <div class="receipt-brand">${t('kitchen.title')}</div>
      <div class="receipt-meta">${t('kitchen.orderNumber')} ${sale.id}${sale.table_name ? ` — ${escapeHtml(sale.table_name)}` : ''}</div>
      <div class="receipt-meta">${formatDate(sale.created_at)}</div>
    </div>
    ${deliveryTimeHtml}
    ${orderNoteHtml}
    <div class="receipt-divider"></div>
    <div class="kitchen-items">${itemsHtml}</div>
  `;
  document.body.dataset.printReady = '1';

}

function formatDate(str) {
  const d = new Date(str.replace(' ', 'T') + 'Z');
  const lang = document.documentElement.getAttribute('data-lang') || 'ar';
  const LOCALES = { ar: 'ar-EG', tr: 'tr-TR', en: 'en-US' };
  return d.toLocaleString(LOCALES[lang] || 'ar-EG', { dateStyle: 'medium', timeStyle: 'short' });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

init();
