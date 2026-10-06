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


/** رقم فاتورة قصير للطباعة: آخر مقطع رقمي بعد الشرطة (000399) بدل الرمز الطويل. */
function shortInvoiceNo(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return '';
  const parts = s.split(/[-_/]/).filter(Boolean);
  if (parts.length >= 2) {
    const last = parts[parts.length - 1];
    if (/^\d+$/.test(last)) return last.replace(/^0+(?=\d)/, '') === '' ? last : last; // keep zeros like 000399
    // إن كان الأخير غير رقمي، جرّب مقطعاً رقمياً من النهاية
    for (let i = parts.length - 1; i >= 0; i--) {
      if (/^\d+$/.test(parts[i])) return parts[i];
    }
  }
  const digits = s.match(/(\d{3,})$/);
  if (digits) return digits[1];
  return s.length > 12 ? s.slice(-8) : s;
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
  // تفصيل الضريبة حسب النسبة — نفس منطق computeCartLineTax / money.taxMinor
  // inclusive 450 @10% → أساس 409.09 + ضريبة 40.91 (gross × rate ÷ (100 + rate))
  const scale = 10 ** minorUnit;
  const taxByRate = {};
  for (const i of (sale.items || [])) {
    const rate = Number(i.tax_rate || 0);
    if (!(rate > 0)) continue;
    const inclusive = Number(i.tax_inclusive) === 1;
    const qty = Number(i.quantity || 1) || 1;
    const unitPrice = i.unit_price != null ? Number(i.unit_price) : (Number(i.line_total || 0) / qty);
    const unitMinor = Math.round(Number((unitPrice * scale).toFixed(6)));
    const grossMinor = Math.max(0, Math.round(Number((unitMinor * qty).toFixed(6))));
    const bps = Math.max(0, Math.round(rate * 100));
    const den = inclusive ? 10000 + bps : 10000;
    const taxMinor = bps > 0 ? Math.floor((grossMinor * bps * 2 + den) / (2 * den)) : 0;
    const netMinor = inclusive ? Math.max(0, grossMinor - taxMinor) : grossMinor;
    const taxAmt = taxMinor / scale;
    const baseAmt = netMinor / scale;
    if (!taxByRate[rate]) taxByRate[rate] = { base: 0, tax: 0 };
    taxByRate[rate].base += baseAmt;
    taxByRate[rate].tax += taxAmt;
  }
  const taxDetailHtml = Object.keys(taxByRate).length
    ? Object.entries(taxByRate).map(([rate, v]) =>
        `<div class="receipt-row receipt-tax-detail"><span>${t('common.tax')} ${Number(rate)}% (${t('receipt.taxBase', 'أساس')} ${fmt(v.base)})</span><span>${fmt(v.tax)}</span></div>`
      ).join('')
    : '';
  const computedTaxFromItems = Object.values(taxByRate).reduce((s, v) => s + v.tax, 0);
  const PAYMENT_LABELS = { cash: t('receipt.cash'), card: t('receipt.card'), mixed: t('common.mixed'), credit: t('common.credit'), store_credit: t('common.credit'), debt: t('common.credit'), on_account: t('common.credit') };
  const DISCOUNT_TYPE_LABELS = { percent: t('pos.percent'), fixed: t('pos.fixedAmount') };

  const receiptEl = document.getElementById('receipt');
  const storeName = (branding && branding.storeName) || (sale.branch ? sale.branch.name : t('receipt.defaultStoreName'));
  const storeAddress = (sale.branch && sale.branch.address) ? String(sale.branch.address).trim() : '';
  const cashierName = sale.cashier_name || sale.cashier_username || '';
  const taxNumber = (currency && currency.taxNumber) ? String(currency.taxNumber).trim() : '';
  const logoUrl = branding && branding.logoPath ? 'file://' + branding.logoPath.replace(/\\/g, '/') : '';
  const bundlesList = (Array.isArray(sale.bundles) ? sale.bundles : []).filter((b) => b && Array.isArray(b.items) && b.items.length);
  // أي صنف مذكور داخل حزمة يأخذ شارة هدية 🎁 صغيرة على اسمه في السطر نفسه، بدل الصندوق
  // الكبير القديم اللي كان يكرّر أسماء الأصناف من جديد ويطوّل الفاتورة بلا داعٍ.
  const offerItemKeys = new Set();
  for (const b of bundlesList) {
    for (const oi of b.items) offerItemKeys.add(oi.product_id != null ? `id:${oi.product_id}` : `n:${oi.product_name}`);
  }
  const isOfferItem = (i) => offerItemKeys.has(i.product_id != null ? `id:${i.product_id}` : `n:${i.product_name}`);

  // كل صنف: السطر الأول = (الكمية× الاسم) في جهة والمجموع في الجهة الأخرى، وتحته (إن زادت الكمية
  // عن 1) سعر القطعة الواحدة بنص واضح — بدل الأقواس «(15.00)» التي كانت تُفهم خطأً.
  // تنسيق البنود بأسلوب الإيصال الحراري الشائع:
  //   اسم الصنف                    NxPRICE=TOTAL
  // أوضح على ورق 58/80mm من فصل الكمية في سطر ثاني.
  const cur = escapeHtml(currency.base || '');
  const itemsHtml = sale.items
    .map((i) => {
      const qty = Number(i.quantity || 0);
      const unit = Number(i.unit_price || 0);
      const line = Number(i.line_total || 0);
      const badge = isOfferItem(i) ? `<span class="receipt-item-offer-badge">[${t('receipt.offerBadge', 'عرض')}]</span> ` : '';
      // سطر واحد: [عرض] 1× الاسم ................ 500.00
      const namePart = `${badge}<bdi class="receipt-item-qty">${qty}×</bdi> ${escapeHtml(i.product_name)}`;
      return `
      <div class="receipt-item">
        <div class="receipt-item-line">
          <span class="receipt-item-name">${namePart}</span>
          <span class="receipt-item-total"><bdi>${fmt(line)}</bdi></span>
        </div>
        ${qty > 1 ? `<div class="receipt-item-unitline"><bdi>${fmt(unit)}</bdi> × ${qty}</div>` : ''}
        ${i.notes ? `<div class="receipt-item-note">${escapeHtml(i.notes)}</div>` : ''}
      </div>`;
    })
    .join('');
  const totalPieces = (sale.items || []).reduce((n, i) => n + Number(i.quantity || 0), 0);

  const offersHtml = bundlesList
    .map((b) => {
      const apps = Number(b.applications || 1);
      const saved = Number(b.discount || 0);
      return `<div class="receipt-offer-line"><span>[${t('receipt.offerBadge', 'عرض')}] ${escapeHtml(b.name)}${apps > 1 ? ` ×${apps}` : ''}</span>${saved > 0 ? `<span>${t('receipt.offerSaved')} ${fmt(saved)}</span>` : ''}</div>`;
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

  // ---- بيانات الفاتورة: ترتيب مطابق لإيصالات المطاعم الحرارية ----
  const isDelivery = sale.order_type === 'delivery';
  const typeLabel = isDelivery ? t('receipt.typeDelivery') : (sale.table_name ? `${t('receipt.typeTable')} ${sale.table_name}` : t('receipt.typeInStore'));
  const orderNoFull = sale.invoice_number || (sale.id != null ? String(sale.id) : '');
  const orderNo = shortInvoiceNo(orderNoFull) || orderNoFull;
  const shortWhen = formatShortDateTime(sale.created_at);
  const deliveryTimeValue = sale.delivery_time
    ? formatDate(sale.delivery_time)
    : (isDelivery ? `${t('receipt.deliverNow')}${formatTimeOnly(sale.created_at) ? ` ${formatTimeOnly(sale.created_at)}` : ''}` : '');

  receiptEl.innerHTML = `
    <div class="receipt-header">
      ${logoUrl ? `<img id="receiptLogo" class="receipt-logo" src="${escAttr(logoUrl)}" alt="" />` : ''}
      <div class="receipt-brand">${escapeHtml(storeName)}</div>
      ${storeAddress ? `<div class="receipt-store-meta">${escapeHtml(storeAddress)}</div>` : ''}
      ${taxNumber ? `<div class="receipt-store-meta">${t('receipt.taxNumber', 'الرقم الضريبي')}: ${escapeHtml(taxNumber)}</div>` : ''}
    </div>

    <div class="receipt-meta-block">
      ${sale.customer_name ? `<div class="receipt-meta-line"><span class="rm-label">${t('receipt.customerLabel')}</span><span class="rm-value">${escapeHtml(sale.customer_name)}</span></div>` : ''}
      <div class="receipt-meta-line receipt-meta-inline">
        ${orderNo ? `<span>${t('receipt.invoiceNo', 'فاتورة')}: <bdi>#${escapeHtml(orderNo)}</bdi></span>` : ''}
        ${shortWhen ? `<span><bdi>${shortWhen}</bdi></span>` : ''}
      </div>
      <div class="receipt-meta-line"><span class="rm-label">${t('receipt.orderTypeLabel')}</span><span class="rm-value">${escapeHtml(typeLabel)}</span></div>
      ${cashierName ? `<div class="receipt-meta-line"><span class="rm-label">${t('receipt.cashierLabel', 'الكاشير')}</span><span class="rm-value">${escapeHtml(cashierName)}</span></div>` : ''}
      ${isDelivery && sale.delivery_person ? `<div class="receipt-meta-line"><span class="rm-label">${t('receipt.deliveryPerson')}</span><span class="rm-value">${escapeHtml(sale.delivery_person)}</span></div>` : ''}
      ${deliveryTimeValue ? `<div class="receipt-meta-line"><span class="rm-label">${t('receipt.deliveryTime')}</span><span class="rm-value"><bdi>${deliveryTimeValue}</bdi></span></div>` : ''}
    </div>

    <div class="receipt-divider"></div>
    <div class="receipt-cols-head">
      <span>${t('receipt.colItem', 'الصنف')}</span>
      <span>${t('receipt.colQtyPrice', 'الكمية × السعر')}</span>
    </div>
    <div class="receipt-divider receipt-divider-thin"></div>

    <div class="receipt-items">${itemsHtml}</div>
    ${offersHtml ? `<div class="receipt-offers">${offersHtml}</div>` : ''}
    ${Number.isInteger(totalPieces) && totalPieces > 0 ? `<div class="receipt-pieces">${t('receipt.totalPieces', 'عدد القطع')}: <bdi>${totalPieces}</bdi></div>` : ''}

    <div class="receipt-divider"></div>

    <div class="receipt-row"><span>${t('common.subtotal')}</span><span>${fmt(sale.subtotal)}</span></div>
    ${(Number(sale.tax_total) > 0 || computedTaxFromItems > 0) ? `<div class="receipt-row"><span>${t('common.tax')}</span><span>${fmt(Number(sale.tax_total) > 0 ? sale.tax_total : computedTaxFromItems)}</span></div>` : ''}
    ${taxDetailHtml}
    ${taxModeNote && (Number(sale.tax_total) > 0 || computedTaxFromItems > 0) ? `<div class="receipt-item-note">${escapeHtml(taxModeNote)}</div>` : ''}
    ${
      sale.discount_total
        ? `<div class="receipt-row"><span>${t('receipt.discount')}${sale.discount_type ? ` (${DISCOUNT_TYPE_LABELS[sale.discount_type] || escapeHtml(sale.discount_type || '')})` : ''}</span><span>-<bdi>${fmt(sale.discount_total)}</bdi></span></div>`
        : ''
    }
    ${Number(sale.bundle_discount_total || 0) > 0 ? `<div class="receipt-row"><span>${t('receipt.bundleDiscount')}</span><span>-<bdi>${fmt(sale.bundle_discount_total)}</bdi></span></div>` : ''}
    ${sale.order_type === 'delivery' && sale.delivery_fee ? `<div class="receipt-row"><span>${t('receipt.deliveryFee')}</span><span><bdi>${fmt(sale.delivery_fee)}</bdi></span></div>` : ''}
    ${
      sale.loyalty_points_redeemed
        ? `<div class="receipt-row"><span>${t('receipt.loyaltyRedeemed')} (${sale.loyalty_points_redeemed} ${t('common.points')})</span><span>-<bdi>${fmt(sale.loyalty_redeemed_value || 0)}</bdi></span></div>`
        : ''
    }
    <div class="receipt-row receipt-total"><span>${t('receipt.total')}</span><span>${fmt(sale.grand_total)}${cur ? ` ${cur}` : ''}</span></div>
    ${currency.showSecondaryOnReceipt && currency.secondary && currency.secondary !== currency.base ? `<div class="receipt-row"><span>${t('receipt.secondaryCurrency')}</span><span><bdi>${(sale.grand_total * (sale.exchange_rate || currency.rate || 1)).toFixed(2)}</bdi> ${escapeHtml(currency.secondary)}</span></div>` : ''}
    ${sale.due_amount ? `<div class="receipt-row"><span>${t('receipt.dueAmount')}</span><span><bdi>${fmt(sale.due_amount)}</bdi></span></div>` : ''}

    <div class="receipt-divider"></div>
    ${paymentHtml}

    <img id="receiptQr" class="receipt-qr" alt="QR" style="display:none" />
    <div class="receipt-footer">${t('receipt.thankYou')}</div>
    ${orderNo ? `<div class="receipt-footer receipt-ref"><bdi>#${escapeHtml(orderNo)}</bdi></div>` : ''}
    ${branding && branding.receiptFooterMessage ? `<div class="receipt-footer receipt-footer-custom">${escapeHtml(branding.receiptFooterMessage).replace(/\n/g, '<br>')}</div>` : ''}
  `;

    // إذا فشل تحميل ملف الشعار (حُذف من القرص، أو مسار غير صالح)، لا نترك أيقونة صورة
  // مكسورة تتصادم بصرياً مع اسم المتجر — نخفيها فوراً ويبقى الاسم وحده واضحاً.
  const logoImg = document.getElementById('receiptLogo');
  if (logoImg) logoImg.addEventListener('error', () => logoImg.remove(), { once: true });
}


// تاريخ قصير بنمط الطابعات الحرارية: 19:50 05-10-2026
function formatShortDateTime(str) {
  const normalized = String(str || '').trim();
  if (!normalized) return '';
  const hasTimezone = /Z$|[+-]\d{2}:?\d{2}$/.test(normalized);
  const isoCandidate = normalized.includes('T') ? normalized : normalized.replace(' ', 'T');
  const d = new Date(hasTimezone ? isoCandidate : isoCandidate + 'Z');
  if (isNaN(d.getTime())) return normalized;
  const pad = (n) => String(n).padStart(2, '0');
  const hh = pad(d.getHours());
  const mm = pad(d.getMinutes());
  const dd = pad(d.getDate());
  const mo = pad(d.getMonth() + 1);
  const yy = d.getFullYear();
  return `${hh}:${mm} ${dd}-${mo}-${yy}`;
}

function escAttr(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
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

// الساعة فقط (HH:MM) لطلبات "الآن": بدلها كانت الفاتورة تطبع "تسليم فوري" بدون أي ساعة.
function formatTimeOnly(str) {
  const normalized = String(str || '').trim();
  const hasTimezone = /Z$|[+-]\d{2}:?\d{2}$/.test(normalized);
  const isoCandidate = normalized.includes('T') ? normalized : normalized.replace(' ', 'T');
  const d = new Date(hasTimezone ? isoCandidate : isoCandidate + 'Z');
  if (isNaN(d.getTime())) return '';
  const lang = document.documentElement.getAttribute('data-lang') || 'ar';
  const LOCALES = { ar: 'ar-EG-u-nu-latn', tr: 'tr-TR', en: 'en-US' };
  return d.toLocaleTimeString(LOCALES[lang] || 'ar-EG-u-nu-latn', { hour: '2-digit', minute: '2-digit' });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

init();
