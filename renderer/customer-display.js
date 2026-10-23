// شاشة الزبون: تعرض فقط الحالة المنقّاة القادمة من الكاشير (انظر lib/customer-display-state.js).
// كل القيم تُكتب بـ textContent، فلا يمكن لاسم صنف أن يحقن HTML.
(() => {
  const LABELS = {
    ar: { hello: 'أهلاً بكم', thanks: 'شكراً لتسوقكم معنا', empty: 'لم تُضف منتجات بعد', total: 'الإجمالي', paid: 'تم الدفع', dir: 'rtl' },
    tr: { hello: 'Hoş geldiniz', thanks: 'Alışverişiniz için teşekkürler', empty: 'Henüz ürün eklenmedi', total: 'Toplam', paid: 'Ödendi', dir: 'ltr' },
    en: { hello: 'Welcome', thanks: 'Thank you for shopping with us', empty: 'No items yet', total: 'Total', paid: 'Paid', dir: 'ltr' },
  };
  const screenEl = document.getElementById('mainContent');

  function node(tag, className, text) {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (text != null) n.textContent = text;
    return n;
  }

  function header(state) {
    const head = node('header', 'cd-head');
    head.append(node('div', 'cd-store', state.storeName || ''), node('div', 'cd-brand', 'NEXORA'));
    return head;
  }

  function renderIdle(state, L) {
    const center = node('div', 'cd-center');
    center.append(node('div', 'cd-hello', L.hello), node('div', 'cd-sub', L.empty));
    return center;
  }

  function renderThanks(state, L) {
    const center = node('div', 'cd-center');
    center.append(node('div', 'cd-hello', L.thanks));
    if (state.total) {
      center.append(node('div', 'cd-sub', L.paid), node('div', 'cd-paid', `${state.total} ${state.currency}`.trim()));
    }
    return center;
  }

  function renderCart(state, L) {
    const body = node('div', 'cd-body');
    const items = node('div', 'cd-items');
    for (const item of state.items) {
      const left = node('div', 'cd-item-name', item.name);
      if (item.qty) {
        // الأرقام والوحدات تُعرض من اليسار لليمين حتى لا تنقلب ترتيبها داخل نص عربي (RTL)
        const qtyLine = node('div', 'cd-item-qty', item.unit ? `${item.qty} × ${item.unit}` : item.qty);
        qtyLine.dir = 'ltr';
        left.append(qtyLine);
      }
      const row = node('div', 'cd-item');
      const lineAmount = node('div', 'cd-item-line', item.line);
      lineAmount.dir = 'ltr';
      row.append(left, lineAmount);
      items.append(row);
    }
    body.append(items);

    const totals = node('div', 'cd-totals');
    for (const r of state.totals) {
      const row = node('div', r.strong ? 'cd-row cd-strong' : 'cd-row');
      const value = node('span', null, r.value);
      value.dir = 'ltr';
      row.append(node('span', null, r.label), value);
      totals.append(row);
    }
    const grand = node('div', 'cd-grand');
    grand.append(node('div', 'cd-grand-label', L.total), node('div', 'cd-grand-value', `${state.total} ${state.currency}`.trim()));
    totals.append(grand);
    if (state.secondaryTotal) totals.append(node('div', 'cd-secondary', state.secondaryTotal));
    body.append(totals);
    return { body, items };
  }

  function render(raw) {
    const state = raw || {};
    const lang = LABELS[state.lang] ? state.lang : 'ar';
    const L = LABELS[lang];
    document.documentElement.lang = lang;
    document.documentElement.dir = L.dir;

    screenEl.replaceChildren(header(state));
    if (state.state === 'thanks') {
      screenEl.append(renderThanks(state, L));
    } else if (state.state === 'cart' && state.items && state.items.length) {
      const { body, items } = renderCart(state, L);
      screenEl.append(body);
      items.scrollTop = items.scrollHeight;
    } else {
      screenEl.append(renderIdle(state, L));
    }
  }

  // الحالة الأولية قبل أي رسالة من الكاشير
  render({ state: 'idle', lang: 'ar', storeName: '' });
  if (window.api && window.api.customerDisplay) window.api.customerDisplay.onUpdate(render);
})();
