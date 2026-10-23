'use strict';
// شاشة الزبون: تنقية الحالة القادمة من واجهة الكاشير قبل إرسالها إلى الشاشة الثانية.
// الهدف: الشاشة تعرض للزبون فقط ما يحق له رؤيته (الأصناف، الأسعار، الخصومات، الضريبة، الإجمالي).
// لا تُمرَّر أبداً التكاليف، الأرباح، ديون العملاء، نقاط الولاء، أو أي بيانات داخلية.

const STATES = ['idle', 'cart', 'thanks'];
const LANGS = ['ar', 'tr', 'en'];
const ITEM_LIMIT = 200;
const TOTAL_ROW_LIMIT = 10;

function text(value, max) {
  return String(value == null ? '' : value).slice(0, max);
}

function sanitizeCustomerDisplayState(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const items = Array.isArray(input.items)
    ? input.items.slice(0, ITEM_LIMIT).map((item) => ({
        name: text(item && item.name, 80),
        qty: text(item && item.qty, 16),
        unit: text(item && item.unit, 40),
        line: text(item && item.line, 40),
      }))
    : [];
  const totals = Array.isArray(input.totals)
    ? input.totals.slice(0, TOTAL_ROW_LIMIT).map((row) => ({
        label: text(row && row.label, 60),
        value: text(row && row.value, 40),
        strong: Boolean(row && row.strong),
      }))
    : [];
  return {
    state: STATES.includes(input.state) ? input.state : 'cart',
    lang: LANGS.includes(input.lang) ? input.lang : 'ar',
    storeName: text(input.storeName, 80),
    currency: text(input.currency, 12),
    total: text(input.total, 40),
    secondaryTotal: text(input.secondaryTotal, 60),
    items,
    totals,
  };
}

module.exports = { sanitizeCustomerDisplayState };
