async function init() {
  let lang = 'ar';
  try {
    if (window.api && window.api.language) lang = (await window.api.language.get()) || 'ar';
  } catch (err) {
    // نستمر باللغة الافتراضية إن تعذّر القراءة
  }
  applyTranslations(lang);

  const params = new URLSearchParams(window.location.search);
  document.body.dataset.paperWidth = ['58','80'].includes(params.get('paperWidth')) ? params.get('paperWidth') : '80';
  const saleId = parseInt(params.get('saleId'), 10);
  let deltaItems = null;
  if (params.get('delta') === '1' && params.get('deltaItems')) {
    try { deltaItems = JSON.parse(atob(params.get('deltaItems').replace(/-/g,'+').replace(/_/g,'/'))); } catch { deltaItems = null; }
  }
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

  const isDeltaTicket = Array.isArray(deltaItems);
  // العروض (Bundles) المطبَّقة: تظهر بإطار وكلمة "عرض" واضحة، ومكوّناتها تُخصم من البنود العادية أدناه.
  const offers = !isDeltaTicket && Array.isArray(sale.bundles) ? sale.bundles.filter((b) => b && Array.isArray(b.items) && b.items.length) : [];
  const consumed = new Map();
  for (const offer of offers) {
    for (const oi of offer.items) consumed.set(Number(oi.product_id), (consumed.get(Number(oi.product_id)) || 0) + Number(oi.quantity || 0));
  }
  const noteShown = new Set();
  const noteFor = (productId) => {
    const line = (sale.items || []).find((it) => Number(it.product_id) === Number(productId) && it.notes && !noteShown.has(it.id));
    if (!line) return '';
    noteShown.add(line.id);
    return `<div class="kitchen-item-note">⚠ ${escapeHtml(line.notes)}</div>`;
  };
  const offersHtml = offers
    .map((offer) => {
      const apps = Number(offer.applications || 1);
      const rows = offer.items
        .map((oi) => `<div class="kitchen-item kitchen-offer-item"><span class="kitchen-item-qty">${Number(oi.quantity || 0)}×</span><span class="kitchen-item-name">${escapeHtml(oi.product_name)}</span>${noteFor(oi.product_id)}</div>`)
        .join('');
      return `<div class="kitchen-offer"><div class="kitchen-offer-title">*** ${t('kitchen.offer')} *** ${escapeHtml(offer.name)}${apps > 1 ? ` ×${apps}` : ''}</div>${rows}</div>`;
    })
    .join('');
  // البنود العادية = كمية كل سطر بعد طرح ما استهلكته العروض.
  const sourceItems = isDeltaTicket
    ? deltaItems.map((i) => ({ ...i, product_name: i.productName, quantity: i.deltaQuantity }))
    : (sale.items || [])
        .map((i) => {
          const pid = Number(i.product_id);
          const left = consumed.get(pid) || 0;
          const take = Math.min(left, Number(i.quantity || 0));
          if (take > 0) consumed.set(pid, left - take);
          return { ...i, quantity: Number(i.quantity || 0) - take };
        })
        .filter((i) => i.quantity > 1e-9);
  const itemsHtml = sourceItems
    .map(
      (i) => {
        const qty = Number(i.quantity ?? i.deltaQuantity ?? 0);
        const isDelta = Array.isArray(deltaItems);
        const noteOnly = isDelta && qty === 0;
        const prefix = noteOnly ? 'تعديل ملاحظة ' : (isDelta && qty < 0 ? 'إلغاء ' : (isDelta ? 'إضافة ' : ''));
        return `<div class="kitchen-item"><span class="kitchen-item-qty">${noteOnly ? '•' : `${isDelta ? Math.abs(qty) : qty}×`}</span><span class="kitchen-item-name">${prefix}${escapeHtml(i.product_name)}</span>${i.notes ? `<div class="kitchen-item-note">⚠ ${escapeHtml(i.notes)}</div>` : ''}</div>`;
      }
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
      <div class="receipt-brand">${Array.isArray(deltaItems) ? (lang === 'ar' ? 'تعديل طلب المطبخ' : lang === 'tr' ? 'Mutfak Sipariş Değişikliği' : 'Kitchen Order Change') : t('kitchen.title')}</div>
      <div class="receipt-meta">${t('kitchen.orderNumber')} ${sale.id}${sale.table_name ? ` — ${escapeHtml(sale.table_name)}` : ''}</div>
      <div class="receipt-meta">${formatDate(sale.created_at)}</div>
    </div>
    ${deliveryTimeHtml}
    ${orderNoteHtml}
    <div class="receipt-divider"></div>
    <div class="kitchen-items">${offersHtml}${itemsHtml}</div>
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
