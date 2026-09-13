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

  // وقت مجدوَل يظهر بغض النظر عن نوع الطلب (توصيل أو استلام) — كان مقصوراً على
  // التوصيل فقط رغم أن الكاشير يقدر يحدد وقتاً لأي نوع طلب من شاشة البيع.
  const deliveryTimeHtml = sale.delivery_time
    ? `<div class="kitchen-delivery-time">⏰ ${t('kitchen.deliverAt')} ${formatDate(sale.delivery_time)}</div>`
    : (sale.order_type === 'delivery' ? `<div class="kitchen-delivery-time">🛵 ${t('kitchen.deliverNow')}</div>` : '');
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
  // بعض الحقول تُخزَّن بصيغة SQLite القديمة "YYYY-MM-DD HH:MM:SS" بدون منطقة زمنية،
  // بينما delivery_time (الناتج عن toISOString() بقاعدة البيانات) يُخزَّن كصيغة ISO
  // كاملة تحتوي أصلاً على "T" و"Z". المنطق القديم كان يضيف "Z" دائماً بشكل أعمى،
  // فتصير "...ZZ" وهو تاريخ غير صالح (Invalid Date) — بالضبط ما كان يظهر على
  // تذكرة المطبخ بدل وقت التسليم الفعلي. نفس الإصلاح المطبَّق في receipt.js.
  const normalized = String(str || '').trim();
  const hasTimezone = /Z$|[+-]\d{2}:?\d{2}$/.test(normalized);
  const isoCandidate = normalized.includes('T') ? normalized : normalized.replace(' ', 'T');
  const d = new Date(hasTimezone ? isoCandidate : isoCandidate + 'Z');
  if (isNaN(d.getTime())) return normalized || '—';
  const lang = document.documentElement.getAttribute('data-lang') || 'ar';
  // نفرض أرقام لاتينية (0-9) حتى مع اللغة العربية — الأرقام الهندية العربية (٠-٩)
  // بتطلع مشوّشة على أغلب طابعات الإيصال الحرارية.
  const LOCALES = { ar: 'ar-EG-u-nu-latn', tr: 'tr-TR', en: 'en-US' };
  return d.toLocaleString(LOCALES[lang] || 'ar-EG-u-nu-latn', { dateStyle: 'medium', timeStyle: 'short' });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

init();
