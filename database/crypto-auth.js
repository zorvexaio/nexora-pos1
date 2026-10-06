'use strict';

/**
 * Password hashing + in-process auth rate limiting.
 * Extracted from database/db.js (cleanup batch 1) so auth primitives
 * can be unit-tested without opening the encrypted SQLite handle.
 */

const crypto = require('crypto');

const AUTH_MAX_ATTEMPTS = 8;
const AUTH_WINDOW_MS = 10 * 60 * 1000;
const AUTH_LOCKOUT_MS = 15 * 60 * 1000;

const authFailures = new Map();

function authBucket(key) {
  const now = Date.now();
  const bucket = authFailures.get(key);
  if (!bucket || (now - bucket.firstAt) > AUTH_WINDOW_MS) {
    const fresh = { firstAt: now, count: 0, lockedUntil: 0 };
    authFailures.set(key, fresh);
    return fresh;
  }
  return bucket;
}

function checkAuthRateLimit(key) {
  const b = authBucket(key);
  if (b.lockedUntil > Date.now()) return false;
  if (b.lockedUntil && b.lockedUntil <= Date.now()) {
    b.count = 0;
    b.firstAt = Date.now();
    b.lockedUntil = 0;
  }
  return true;
}

function recordAuthFailure(key) {
  const b = authBucket(key);
  b.count += 1;
  if (b.count >= AUTH_MAX_ATTEMPTS) b.lockedUntil = Date.now() + AUTH_LOCKOUT_MS;
}

function clearAuthFailures(key) {
  authFailures.delete(key);
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const check = crypto.scryptSync(password, salt, 64).toString('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(check, 'hex'));
  } catch {
    return false;
  }
}

/** Test helper — clears all buckets (not for production paths). */
function _resetAuthFailuresForTests() {
  authFailures.clear();
}

module.exports = {
  AUTH_MAX_ATTEMPTS,
  AUTH_WINDOW_MS,
  AUTH_LOCKOUT_MS,
  authBucket,
  checkAuthRateLimit,
  recordAuthFailure,
  clearAuthFailures,
  hashPassword,
  verifyPassword,
  _resetAuthFailuresForTests,
};
