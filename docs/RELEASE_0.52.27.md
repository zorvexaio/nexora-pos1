# Nexora POS v0.52.27 — Portable Backup UI

## Problem

Restoring a `.db` backup (via **إنشاء نسخة احتياطية** / **استعادة نسخة احتياطية** in
Settings) failed with:

> ملف النسخة الاحتياطية ليس قاعدة Nexora صالحة أو لا يطابق مفتاح هذا الجهاز.

Root cause: that backup path is a raw, page-encrypted copy of `pos.db`. The
decryption key is *not* stored inside the backup file — it lives in
`pos.db.key` in the app's userData folder, itself encrypted via the OS
credential store (`safeStorage` / Windows DPAPI) and unique per Windows user
profile and per machine. So this kind of backup can only ever be restored on
the exact same device/user profile that created it. Restoring it after a
Windows reinstall, on a replacement PC, or under a different Windows account
will always fail with this message — by design, not corruption.

The backend already had a device-independent alternative —
`backup:createPortable` / `backup:restorePortable`, which encrypts the backup
with a user-chosen passphrase (scrypt-derived key) instead of the device key —
but it had **no UI**. There was no way for a shop owner to discover or use it.

## Changed

- **Settings → النسخ الاحتياطي والاستعادة**: the existing backup/restore hint
  now explicitly states that this backup is tied to the current device and
  won't survive a reinstall or a machine change.
- Added a new **النسخة المحمولة (لنقلها بين الأجهزة)** section with
  "إنشاء نسخة محمولة" and "استعادة نسخة محمولة" buttons, wired to the
  already-existing `backup:createPortable` / `backup:restorePortable` IPC
  handlers via a passphrase modal (create asks for password + confirmation,
  restore asks for the original password).

## Verification

- `tools/v0.31-regression.js`: CSP still enforced for `renderer/pages/settings.html`.
- `tools/v0.43.0-regression.js`, `tools/v0.45.6-regression.js`,
  `tools/category-image-removal-regression.js`: still pass (no regressions to
  settings page's existing product-grade feedback/routing/category behavior).
- `node --check renderer/pages/settings.js` passes.
- Manual: no duplicate DOM ids introduced in `settings.html`.
