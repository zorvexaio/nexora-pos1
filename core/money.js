'use strict';

/**
 * Deterministic fixed-point money primitives.
 * Amounts are integers in the currency's minor unit (e.g. cents for USD/TRY).
 */

const DEFAULT_MINOR_UNIT = 2;
const MAX_SAFE_MINOR = BigInt(Number.MAX_SAFE_INTEGER);

function assertMinorUnit(minorUnit) {
  const n = Number(minorUnit);
  if (!Number.isInteger(n) || n < 0 || n > 6) throw new Error('Invalid currency minor unit.');
  return n;
}

function decimalToScaledInteger(value, scale) {
  const unit = assertMinorUnit(scale);
  const raw = String(value ?? '').trim();
  if (!raw || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw)) throw new Error('Invalid monetary value.');
  const negative = raw.startsWith('-');
  const unsigned = raw.replace(/^[+-]/, '');
  const [wholePart, fractionPart = ''] = unsigned.split('.');
  const whole = BigInt(wholePart || '0');
  const digits = fractionPart.replace(/\D/g, '');
  const padded = (digits + '0'.repeat(unit)).slice(0, unit);
  const discarded = digits.slice(unit);
  let scaled = whole * (10n ** BigInt(unit)) + BigInt(padded || '0');
  if (discarded && discarded[0] >= '5') scaled += 1n;
  if (negative) scaled = -scaled;
  if (scaled > MAX_SAFE_MINOR || scaled < -MAX_SAFE_MINOR) throw new Error('Monetary value is out of range.');
  return Number(scaled);
}

function toMinor(value, minorUnit = DEFAULT_MINOR_UNIT) {
  const unit = assertMinorUnit(minorUnit);
  return decimalToScaledInteger(value, unit);
}

function fromMinor(amountMinor, minorUnit = DEFAULT_MINOR_UNIT) {
  const unit = assertMinorUnit(minorUnit);
  const amount = typeof amountMinor === 'bigint' ? amountMinor : BigInt(Math.trunc(Number(amountMinor)));
  if (amount > MAX_SAFE_MINOR || amount < -MAX_SAFE_MINOR) throw new Error('Minor-unit amount is out of range.');
  return Number(amount) / (10 ** unit);
}

function normalizeMinorInteger(value) {
  const n = typeof value === 'bigint' ? value : BigInt(Math.trunc(Number(value || 0)));
  if (n > MAX_SAFE_MINOR || n < -MAX_SAFE_MINOR) throw new Error('Minor-unit amount is out of range.');
  return n;
}

function add(...amounts) {
  const total = amounts.reduce((sum, value) => sum + normalizeMinorInteger(value), 0n);
  if (total > MAX_SAFE_MINOR || total < -MAX_SAFE_MINOR) throw new Error('Minor-unit amount is out of range.');
  return Number(total);
}

function subtract(a, b) {
  const result = normalizeMinorInteger(a) - normalizeMinorInteger(b);
  if (result > MAX_SAFE_MINOR || result < -MAX_SAFE_MINOR) throw new Error('Minor-unit amount is out of range.');
  return Number(result);
}

function multiplyMinorQuantity(unitMinor, quantity) {
  const unit = BigInt(Math.trunc(Number(unitMinor)));
  const q = decimalToScaledInteger(quantity, 6);
  const raw = unit * BigInt(q);
  const result = raw >= 0n ? (raw + 500000n) / 1000000n : (raw - 500000n) / 1000000n;
  if (result > MAX_SAFE_MINOR || result < -MAX_SAFE_MINOR) throw new Error('Calculated monetary value is out of range.');
  return Number(result);
}

function percentToBasisPoints(ratePercent) {
  const rate = Number(ratePercent || 0);
  if (!Number.isFinite(rate) || rate < 0 || rate > 100000) throw new Error('Invalid percentage rate.');
  return decimalToScaledInteger(rate, 2);
}

function percentageMinor(baseMinor, percent) {
  const base = BigInt(Math.trunc(Number(baseMinor)));
  const bps = BigInt(percentToBasisPoints(percent));
  const result = (base * bps + 5000n) / 10000n;
  if (result > MAX_SAFE_MINOR || result < -MAX_SAFE_MINOR) throw new Error('Calculated percentage is out of range.');
  return Number(result);
}

function taxMinor(grossMinor, ratePercent, inclusive) {
  const gross = BigInt(Math.max(0, Math.trunc(Number(grossMinor))));
  const bps = BigInt(percentToBasisPoints(ratePercent));
  if (bps === 0n) return 0;
  const denominator = inclusive ? 10000n + bps : 10000n;
  const result = (gross * bps + denominator / 2n) / denominator;
  if (result > MAX_SAFE_MINOR) throw new Error('Calculated tax is out of range.');
  return Number(result);
}

function format(amountMinor, currency = 'USD', minorUnit = DEFAULT_MINOR_UNIT, locale = undefined) {
  const unit = assertMinorUnit(minorUnit);
  const value = fromMinor(amountMinor, unit);
  return new Intl.NumberFormat(locale, { style: 'currency', currency, minimumFractionDigits: unit, maximumFractionDigits: unit }).format(value);
}

function assertBalanced(expectedMinor, ...components) {
  const total = add(...components);
  if (total !== Math.trunc(Number(expectedMinor))) throw new Error(`Money balance mismatch: expected ${expectedMinor}, got ${total}.`);
  return true;
}

module.exports = {
  DEFAULT_MINOR_UNIT,
  toMinor,
  fromMinor,
  add,
  subtract,
  multiplyMinorQuantity,
  percentToBasisPoints,
  percentageMinor,
  taxMinor,
  format,
  assertBalanced,
};
