'use strict';

/**
 * Small accounting domain helpers. Persistence is intentionally handled by db.js
 * so this module remains deterministic and independently testable.
 */

const money = require('../core/money');

const ACCOUNT_TYPES = Object.freeze(['asset', 'liability', 'equity', 'revenue', 'expense']);

function validateAccountType(type) {
  const normalized = String(type || '').trim().toLowerCase();
  if (!ACCOUNT_TYPES.includes(normalized)) throw new Error(`Invalid account type: ${normalized}`);
  return normalized;
}

function normalizeAccount(account, minorUnit = 2) {
  const code = String(account.code || '').trim();
  const name = String(account.name || '').trim();
  if (!code || !name) throw new Error('Account code and name are required.');
  return {
    code,
    name,
    type: validateAccountType(account.type),
    currencyCode: String(account.currencyCode || 'USD').toUpperCase(),
    openingBalanceMinor: money.toMinor(account.openingBalance || 0, minorUnit),
    isActive: account.isActive !== false ? 1 : 0,
  };
}

function validateJournalLines(lines) {
  if (!Array.isArray(lines) || lines.length < 2) throw new Error('Journal entry requires at least two lines.');
  const debit = money.add(...lines.map((line) => Math.max(0, Number(line.debitMinor || 0))));
  const credit = money.add(...lines.map((line) => Math.max(0, Number(line.creditMinor || 0))));
  if (debit <= 0 || debit !== credit) throw new Error(`Unbalanced journal entry: debit=${debit}, credit=${credit}.`);
  for (const line of lines) {
    if (!line.accountId) throw new Error('Every journal line needs an account.');
    const debitMinor = Number(line.debitMinor || 0);
    const creditMinor = Number(line.creditMinor || 0);
    if (!Number.isSafeInteger(debitMinor) || !Number.isSafeInteger(creditMinor)) throw new Error('Journal amounts must be safe integer minor units.');
    if ((debitMinor > 0) && (creditMinor > 0)) throw new Error('A journal line cannot contain both debit and credit.');
    if (debitMinor < 0 || creditMinor < 0) throw new Error('Journal amounts cannot be negative.');
  }
  return { debit, credit };
}

module.exports = { ACCOUNT_TYPES, validateAccountType, normalizeAccount, validateJournalLines };
