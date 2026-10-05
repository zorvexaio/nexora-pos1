'use strict';

// Minimal GS1 element-string parser for retail POS scanners.
// Handles the common AIs needed at checkout without storing or trusting unvalidated data.
const FNC1 = String.fromCharCode(29);
const FIXED = new Map([
  ['01', 14], // GTIN
  ['17', 6],  // YYMMDD expiry
  ['11', 6],  // YYMMDD production date
]);
const VARIABLE = new Map([
  ['10', 20], // batch/lot
  ['21', 20], // serial
]);

function clean(input) {
  return String(input || '').trim().replace(/\u001d/g, FNC1);
}

function parseGs1(input) {
  const value = clean(input);
  if (!value.startsWith('01') || value.length < 16) return null;
  const fields = {};
  let i = 0;
  while (i < value.length) {
    if (value[i] === FNC1) { i += 1; continue; }
    const ai = value.slice(i, i + 2);
    if (!/^\d{2}$/.test(ai)) break;
    i += 2;
    if (FIXED.has(ai)) {
      const len = FIXED.get(ai);
      if (i + len > value.length) return null;
      fields[ai] = value.slice(i, i + len);
      i += len;
      continue;
    }
    const maxLen = VARIABLE.get(ai);
    if (!maxLen) return null;
    const endGroup = value.indexOf(FNC1, i);
    const end = endGroup >= 0 ? endGroup : Math.min(value.length, i + maxLen);
    const data = value.slice(i, end);
    if (!data || data.length > maxLen) return null;
    fields[ai] = data;
    i = end;
  }
  const gtin = fields['01'];
  if (!gtin || !/^\d{14}$/.test(gtin)) return null;
  return {
    gtin,
    lot: fields['10'] || null,
    serial: fields['21'] || null,
    productionDate: fields['11'] || null,
    expiryDate: fields['17'] || null,
  };
}

module.exports = { parseGs1, FNC1 };
