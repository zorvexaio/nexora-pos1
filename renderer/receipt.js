async function init() {
  const printParams = new URLSearchParams(window.location.search);
  document.body.dataset.paperWidth = ['58','80'].includes(printParams.get('paperWidth')) ? printParams.get('paperWidth') : '80';
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
  let minorUnit = 2;
  try {
    const profile = await window.api.global.get();
    const mu = Number(profile && profile.currency_minor_unit);
    if (Number.isInteger(mu) && mu >= 0 && mu <= 3) minorUnit = mu;
  } catch (err) { /* نستمر بخانتين إن تعذّرت القراءة */ }
  renderReceipt(sale, branding, { ...currency, minorUnit });
  // بعض المحلات تفضّل فاتورة أقصر بلا رمز QR — قابل للتفعيل/الإلغاء من الإعدادات.
  let barcodeEnabled = true;
  try { barcodeEnabled = (await window.api.receipt.barcodeEnabled()).enabled !== false; }
  catch (err) { /* افتراضياً مفعّل لو تعذّرت القراءة لأي سبب */ }
  if (barcodeEnabled) {
    const qrDataUrl = await window.api.receipt.qr(saleId);
    const qrImage = document.getElementById('receiptQr');
    if (qrDataUrl && qrImage) { qrImage.src = qrDataUrl; qrImage.style.display = 'block'; }
  }
  document.body.dataset.printReady = '1';

}

function renderReceipt(sale, branding, currency = {}) {
  // المبالغ تُعرض بخانات عملة المنشأة (0/2/3) وليس 2 ثابتة.
  const minorUnit = Number.isInteger(currency.minorUnit) && currency.minorUnit >= 0 && currency.minorUnit <= 3 ? currency.minorUnit : 2;
  const fmt = (v) => Number(v || 0).toFixed(minorUnit);
  // الشمول يُقرأ من بنود الفاتورة المحفوظة (تاريخي) وليس من إعداد الضريبة الحالي.
  const taxedItems = (sale.items || []).filter((i) => Number(i.tax_rate || 0) > 0);
  const inclusiveTaxed = taxedItems.filter((i) => Number(i.tax_inclusive) === 1).length;
  const taxModeNote = taxedItems.length && inclusiveTaxed === taxedItems.length
    ? t('receipt.pricesIncludeTax')
    : (inclusiveTaxed > 0 ? t('receipt.someItemsIncludeTax') : '');
  const PAYMENT_LABELS = { cash: t('receipt.cash'), card: t('receipt.card'), mixed: t('common.mixed') };
  const DISCOUNT_TYPE_LABELS = { percent: t('pos.percent'), fixed: t('pos.fixedAmount') };

  const receiptEl = document.getElementById('receipt');
  const storeName = (branding && branding.storeName) || (sale.branch ? sale.branch.name : t('receipt.defaultStoreName'));
  const logoUrl = branding && branding.logoPath ? 'file://' + branding.logoPath.replace(/\\/g, '/') : '';
  const bundlesList = (Array.isArray(sale.bundles) ? sale.bundles : []).filter((b) => b && Array.isArray(b.items) && b.items.length);
  // أي صنف مذكور داخل حزمة يأخذ شارة هدية 🎁 صغيرة على اسمه في السطر نفسه، بدل الصندوق
  // الكبير القديم اللي كان يكرّر أسماء الأصناف من جديد ويطوّل الفاتورة بلا داعٍ.
  const offerItemKeys = new Set();
  for (const b of bundlesList) {
    for (const oi of b.items) offerItemKeys.add(oi.product_id != null ? `id:${oi.product_id}` : `n:${oi.product_name}`);
  }
  const isOfferItem = (i) => offerItemKeys.has(i.product_id != null ? `id:${i.product_id}` : `n:${i.product_name}`);

  // سطر واحد لكل صنف: الاسم (+الكمية إن زادت عن 1) في جهة، والمجموع في الجهة الأخرى —
  // بدل سطرين منفصلين لكل صنف، فتختصر الفاتورة بمقدار النصف تقريباً في الطلبات الطويلة.
  const itemsHtml = sale.items
    .map((i) => {
      const qty = Number(i.quantity || 0);
      const qtyPrefix = qty > 1 ? `<span class="receipt-item-qty">${qty}×</span> ` : '';
      const unitNote = qty > 1 ? ` <span class="receipt-item-unit">(${fmt(i.unit_price)})</span>` : '';
      const badge = isOfferItem(i) ? '<span class="receipt-item-offer-badge">🎁</span> ' : '';
      return `
      <div class="receipt-item">
        <div class="receipt-item-line">
          <span class="receipt-item-name">${badge}${qtyPrefix}${escapeHtml(i.product_name)}${unitNote}</span>
          <span class="receipt-item-total">${fmt(i.line_total)}</span>
        </div>
        ${i.notes ? `<div class="receipt-item-note">${escapeHtml(i.notes)}</div>` : ''}
      </div>`;
    })
    .join('');

  // العروض (Bundles) المطبَّقة: سطر واحد مختصر لكل عرض (🎁 اسم العرض + المبلغ الموفَّر) —
  // أصناف الحزمة نفسها ظاهرة أعلاه في قائمة الأصناف مع شارة 🎁، فلا داعي لتكرارها هنا.
  const offersHtml = bundlesList
    .map((b) => {
      const apps = Number(b.applications || 1);
      const saved = Number(b.discount || 0);
      return `<div class="receipt-offer-line"><span>🎁 ${escapeHtml(b.name)}${apps > 1 ? ` ×${apps}` : ''}</span>${saved > 0 ? `<span>${t('receipt.offerSaved')} ${fmt(saved)}</span>` : ''}</div>`;
    })
    .join('');

  let paymentHtml = `<div class="receipt-row"><span>${t('receipt.paymentMethod')}</span><span>${
    PAYMENT_LABELS[sale.payment_method] || escapeHtml(sale.payment_method || '')
  }</span></div>`;

  if (sale.payment_method === 'cash') {
    const received = sale.cash_amount + sale.change_due;
    paymentHtml += `
      <div class="receipt-row"><span>${t('receipt.cashReceived')}</span><span>${fmt(received)}</span></div>
      <div class="receipt-row"><span>${t('receipt.changeDue')}</span><span>${fmt(sale.change_due)}</span></div>`;
  } else if (sale.payment_method === 'mixed') {
    paymentHtml += `
      <div class="receipt-row"><span>${t('receipt.cash')}</span><span>${fmt(sale.cash_amount)}</span></div>
      <div class="receipt-row"><span>${t('receipt.card')}</span><span>${fmt(sale.card_amount)}</span></div>`;
  }

  receiptEl.innerHTML = `
    <div class="receipt-header">
      ${logoUrl ? `<img id="receiptLogo" class="receipt-logo" src="${escAttr(logoUrl)}" alt="" />` : ''}
      <div class="receipt-brand">${escapeHtml(storeName)}</div>
      <div class="receipt-meta">${t('receipt.invoiceNumber')} ${escapeHtml(sale.invoice_number || String(sale.id))}${sale.table_name ? ` — ${escapeHtml(sale.table_name)}` : ''}</div>
      ${currency.taxNumber ? `<div class="receipt-meta">${t('receipt.taxNumber')}: ${escapeHtml(currency.taxNumber)}</div>` : ''}
      <div class="receipt-meta">${formatDate(sale.created_at)}</div>
      ${sale.customer_name ? `<div class="receipt-customer-name">👤 ${escapeHtml(sale.customer_name)}</div>` : ''}
      ${sale.order_type === 'delivery' ? `<div class="receipt-meta">${t('receipt.deliveryOrder')}${sale.delivery_person ? ` — ${t('receipt.deliveryPerson')}: ${escapeHtml(sale.delivery_person)}` : ''}</div>` : ''}
      ${sale.delivery_time ? `<div class="receipt-meta">⏰ ${t('receipt.deliveryTime')}: ${formatDate(sale.delivery_time)}</div>` : (sale.order_type === 'delivery' ? `<div class="receipt-meta">🛵 ${t('receipt.deliverNow')}</div>` : '')}
    </div>

    <div class="receipt-divider"></div>
    ${sale.notes ? `<div class="receipt-order-note">${escapeHtml(sale.notes)}</div><div class="receipt-divider"></div>` : ''}
    <div class="receipt-items">${itemsHtml}</div>
    ${offersHtml}

    <div class="receipt-divider"></div>

    <div class="receipt-row"><span>${t('common.subtotal')}</span><span>${fmt(sale.subtotal)}</span></div>
    <div class="receipt-row"><span>${t('common.tax')}</span><span>${fmt(sale.tax_total)}</span></div>
    ${taxModeNote && Number(sale.tax_total) > 0 ? `<div class="receipt-item-note">${escapeHtml(taxModeNote)}</div>` : ''}
    ${
      sale.discount_total
        ? `<div class="receipt-row"><span>${t('receipt.discount')}${sale.discount_type ? ` (${DISCOUNT_TYPE_LABELS[sale.discount_type] || escapeHtml(sale.discount_type || '')})` : ''}</span><span>-${fmt(sale.discount_total)}</span></div>`
        : ''
    }
    ${Number(sale.bundle_discount_total || 0) > 0 ? `<div class="receipt-row"><span>${t('receipt.bundleDiscount')}</span><span>-${fmt(sale.bundle_discount_total)}</span></div>` : ''}
    ${sale.order_type === 'delivery' && sale.delivery_fee ? `<div class="receipt-row"><span>${t('receipt.deliveryFee')}</span><span>${fmt(sale.delivery_fee)}</span></div>` : ''}
    ${
      sale.loyalty_points_redeemed
        ? `<div class="receipt-row"><span>${t('receipt.loyaltyRedeemed')} (${sale.loyalty_points_redeemed} ${t('common.points')})</span><span>-${fmt(sale.loyalty_redeemed_value || 0)}</span></div>`
        : ''
    }
    <div class="receipt-row receipt-total"><span>${t('receipt.total')}</span><span>${fmt(sale.grand_total)} ${escapeHtml(currency.base || '')}</span></div>
    ${currency.showSecondaryOnReceipt && currency.secondary && currency.secondary !== currency.base ? `<div class="receipt-row"><span>${t('receipt.secondaryCurrency')}</span><span>${(sale.grand_total * (sale.exchange_rate || currency.rate || 1)).toFixed(2)} ${escapeHtml(currency.secondary)}</span></div>` : ''}
    ${sale.due_amount ? `<div class="receipt-row"><span>${t('receipt.dueAmount')}</span><span>${fmt(sale.due_amount)}</span></div>` : ''}

    <div class="receipt-divider"></div>
    ${paymentHtml}

    <img id="receiptQr" class="receipt-qr" alt="QR" style="display:none" />
    <div class="receipt-footer">${t('receipt.thankYou')}</div>
    ${branding && branding.receiptFooterMessage ? `<div class="receipt-footer receipt-footer-custom">${escapeHtml(branding.receiptFooterMessage).replace(/\n/g, '<br>')}</div>` : ''}
  `;

  // إذا فشل تحميل ملف الشعار (حُذف من القرص، أو مسار غير صالح)، لا نترك أيقونة صورة
  // مكسورة تتصادم بصرياً مع اسم المتجر — نخفيها فوراً ويبقى الاسم وحده واضحاً.
  const logoImg = document.getElementById('receiptLogo');
  if (logoImg) logoImg.addEventListener('error', () => logoImg.remove(), { once: true });
}

function formatDate(str) {
  // بعض الحقول (مثل sale.created_at) تُخزَّن بصيغة SQLite القديمة "YYYY-MM-DD HH:MM:SS"
  // بدون منطقة زمنية، بينما حقول أخرى (مثل sale.delivery_time، الناتجة عن
  // computeDeliveryTimeIso() بصفحة الكاشير) تُخزَّن كصيغة ISO كاملة تحتوي أصلاً على
  // "T" و"Z" (مثال: 2026-09-09T02:30:00.000Z). المنطق القديم كان يضيف "Z" دائماً
  // بشكل أعمى، فإذا كانت القيمة تحتوي "Z" أصلاً يصير عندنا "...ZZ" وهو تاريخ غير
  // صالح (Invalid Date) — وهذا بالضبط ما كان يظهر بالفاتورة بدل وقت التسليم الفعلي.
  // الإصلاح: نضيف "Z" فقط إذا لم تكن القيمة تحتوي أصلاً على منطقة زمنية صريحة.
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
