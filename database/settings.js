'use strict';

/**
 * App settings (key/value) — extracted from db.js (refactor batch 2).
 * All functions take the better-sqlite3 handle as the first argument.
 */

function getSetting(db, key, fallback = null) {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function setSetting(db, key, value) {
  db.prepare(
    `INSERT INTO app_settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, String(value));
  return { success: true };
}

function getMaxCashierDiscountPercent(db) {
  const value = Number(getSetting(db, 'max_cashier_discount_percent', '10'));
  return Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 10;
}

module.exports = {
  getSetting,
  setSetting,
  getMaxCashierDiscountPercent,
};
