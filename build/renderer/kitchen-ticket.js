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
    return `<div class="kitchen-item-note">*** ${escapeHtml(line.notes)} ***</div>`;
  };
  const offersHtml = offers
    .map((offer) => {
      const apps = Number(offer.applications || 1);
      const rows = offer.items
        .map((oi) => `<div class="kitchen-item kitchen-offer-item"><span class="kitchen-item-qty">${Number(oi.quantity || 0)} x</span><span class="kitchen-item-name">${escapeHtml(oi.product_name)}</span>${noteFor(oi.product_id)}</div>`)
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
        return `<div class="kitchen-item"><span class="kitchen-item-qty">${noteOnly ? '•' : `${isDelta ? Math.abs(qty) : qty} x`}</span><span class="kitchen-item-name">${prefix}${escapeHtml(i.product_name)}</span>${i.notes ? `<div class="kitchen-item-note">*** ${escapeHtml(i.notes)} ***</div>` : ''}</div>`;
      }
    )
    .join('');

  // ---- ترويسة منظَّمة: رقم الطلب كبير + نوع الطلب + بيانات بصيغة «الاسم: القيمة» ----
  const isDelivery = sale.order_type === 'delivery';
  const typeLabel = isDelivery
    ? t('kitchen.typeDelivery')
    : (sale.table_name ? `${t('kitchen.typeTable')} ${sale.table_name}` : t('kitchen.typeInStore'));
  const titleText = isDeltaTicket ? t('kitchen.changeTitle') : t('kitchen.title');
  const row = (label, value, cls = '') => `<div class="kt-row ${cls}"><span class="kt-label">${label}</span><span class="kt-value">${value}</span></div>`;

  // وقت التسليم المطلوب: صندوق بإطار سميك لأنه أهم معلومة للمطبخ بعد الأصناف.
  // يظهر لأي نوع طلب (توصيل أو استلام) إن حدّد الكاشير وقتاً، وللتوصيل الفوري يُكتب «الآن» مع الساعة.
  const nowTime = formatTimeOnly(sale.created_at);
  const whenHtml = sale.delivery_time
    ? `<div class="kt-when"><span class="kt-when-label">${t('kitchen.deliverAt')}</span> <bdi class="kt-when-value">${formatTimeOnly(sale.delivery_time) || formatDate(sale.delivery_time)}</bdi></div>`
    : (isDelivery ? `<div class="kt-when"><span class="kt-when-label">${t('kitchen.deliverNow')}</span>${nowTime ? ` <bdi class="kt-when-value">${nowTime}</bdi>` : ''}</div>` : '');

  const infoRows = [
    sale.customer_name ? row(t('kitchen.customerLabel'), escapeHtml(sale.customer_name), 'kt-row-customer') : '',
    isDelivery && sale.table_name ? row(t('kitchen.typeTable'), escapeHtml(sale.table_name)) : '',
    row(t('kitchen.timeLabel'), `<bdi>${formatDateNumeric(sale.created_at)} ${nowTime}</bdi>`),
  ].join('\n');
  // ملاحظة الطلب العامة (مش ملاحظة صنف بعينه) — تعليمات مهمة للمطبخ («حساسية مكسرات»، «بدون بصل») فتُعرض كتحذير كبير.
  const orderNoteHtml = sale.notes ? `<div class="kitchen-order-note">*** ${escapeHtml(sale.notes)} ***</div>` : '';
  const totalPieces = isDeltaTicket ? 0 : (sale.items || []).reduce((n, i) => n + Number(i.quantity || 0), 0);
  const piecesHtml = totalPieces > 0 ? `<div class="kt-count">${t('kitchen.totalPieces')}: <bdi>${Number.isInteger(totalPieces) ? totalPieces : totalPieces.toFixed(2)}</bdi></div>` : '';

  const orderDisplay = sale.invoice_number || sale.id;
  const shortWhen = formatShortDateTimeKitchen(sale.created_at);
  ticketEl.innerHTML = `
    <div class="kt-order kt-order-big">${t('kitchen.orderNumber')} <bdi class="kt-order-no">#${escapeHtml(String(orderDisplay))}</bdi></div>
    ${isDeltaTicket ? `<div class="kt-title">${titleText}</div>` : ''}
    <div class="kt-info">
      ${sale.customer_name ? `<div class="kt-row kt-row-customer"><span class="kt-label">${t('kitchen.customerLabel')}</span><span class="kt-value">${escapeHtml(sale.customer_name)}</span></div>` : ''}
      <div class="kt-row"><span class="kt-label">${t('kitchen.timeLabel')}</span><span class="kt-value"><bdi>${shortWhen || (formatDateNumeric(sale.created_at) + ' ' + (nowTime || ''))}</bdi></span></div>
      <div class="kt-row"><span class="kt-label">${t('kitchen.orderType', 'نوع الطلب')}</span><span class="kt-value">${escapeHtml(typeLabel)}</span></div>
      ${isDelivery && sale.delivery_person ? `<div class="kt-row"><span class="kt-label">${t('kitchen.deliveryPerson', 'المندوب')}</span><span class="kt-value">${escapeHtml(sale.delivery_person)}</span></div>` : ''}
    </div>
    ${whenHtml}
    ${orderNoteHtml}
    <div class="kt-sep"></div>
    <div class="kitchen-items">${offersHtml}${itemsHtml}</div>
    ${piecesHtml}
  `;
  document.body.dataset.printReady = '1';

}


function formatShortDateTimeKitchen(str) {
  const normalized = String(str || '').trim();
  if (!normalized) return '';
  const hasTimezone = /Z$|[+-]\d{2}:?\d{2}$/.test(normalized);
  const isoCandidate = normalized.includes('T') ? normalized : normalized.replace(' ', 'T');
  const d = new Date(hasTimezone ? isoCandidate : isoCandidate + 'Z');
  if (isNaN(d.getTime())) return normalized;
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())} ${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()}`;
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

// التاريخ بصيغة رقمية قصيرة (05/10/2026) — أوضح للقراءة من «5 أكتوبر 2026».
function formatDateNumeric(str) {
  const d = parseDate(str);
  if (!d) return '';
  const lang = document.documentElement.getAttribute('data-lang') || 'ar';
  const LOCALES = { ar: 'ar-EG-u-nu-latn', tr: 'tr-TR', en: 'en-GB' };
  return d.toLocaleDateString(LOCALES[lang] || 'ar-EG-u-nu-latn', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function parseDate(str) {
  const normalized = String(str || '').trim();
  if (!normalized) return null;
  const hasTimezone = /Z$|[+-]\d{2}:?\d{2}$/.test(normalized);
  const isoCandidate = normalized.includes('T') ? normalized : normalized.replace(' ', 'T');
  const d = new Date(hasTimezone ? isoCandidate : isoCandidate + 'Z');
  return isNaN(d.getTime()) ? null : d;
}

// الساعة فقط (HH:MM) لطلبات "الآن": بدلها كانت الفاتورة تطبع "تسليم فوري" بدون أي ساعة.
function formatTimeOnly(str) {
  const normalized = String(str || '').trim();
  const hasTimezone = /Z$|[+-]\d{2}:?\d{2}$/.test(normalized);
  const isoCandidate = normalized.includes('T') ? normalized : normalized.replace(' ', 'T');
  const d = new Date(hasTimezone ? isoCandidate : isoCandidate + 'Z');
  if (isNaN(d.getTime())) return '';
  const lang = document.documentElement.getAttribute('data-lang') || 'ar';
  const LOCALES = { ar: 'ar-EG-u-nu-latn', tr: 'tr-TR', en: 'en-US' };
  return d.toLocaleTimeString(LOCALES[lang] || 'ar-EG-u-nu-latn', { hour: 'numeric', minute: '2-digit' });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

init();
