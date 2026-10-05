(function (global) {
  'use strict';

  // A per-line ceiling keeps a mistyped quick quantity from silently becoming
  // a sale that is too large to review safely.
  const MAX_QUANTITY = 9999;

  function normalizeQuantityDigits(value) {
    const arabicIndic = '٠١٢٣٤٥٦٧٨٩';
    const persian = '۰۱۲۳۴۵۶۷۸۹';
    return String(value ?? '').replace(/[٠-٩۰-۹]/g, (digit) => {
      const arabicIndex = arabicIndic.indexOf(digit);
      return String(arabicIndex === -1 ? persian.indexOf(digit) : arabicIndex);
    }).trim();
  }

  function parseQuickQuantity(value) {
    const normalized = normalizeQuantityDigits(value);
    if (!/^\d+$/.test(normalized)) return { ok: false, reason: 'invalid' };

    const quantity = Number(normalized);
    if (!Number.isSafeInteger(quantity) || quantity < 1) return { ok: false, reason: 'invalid' };
    if (quantity > MAX_QUANTITY) return { ok: false, reason: 'maximum' };
    return { ok: true, quantity };
  }

  function canAccumulateQuantity(currentQuantity, addedQuantity) {
    const current = Number(currentQuantity) || 0;
    const added = Number(addedQuantity) || 0;
    return Number.isFinite(current) && Number.isFinite(added) && current + added <= MAX_QUANTITY;
  }

  const api = { MAX_QUANTITY, parseQuickQuantity, canAccumulateQuantity };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.quantityBuffer = api;
})(typeof window !== 'undefined' ? window : globalThis);
