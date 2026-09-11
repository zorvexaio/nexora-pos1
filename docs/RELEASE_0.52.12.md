# Nexora POS v0.52.12

## Fixes
- Reverted a post-publication edit to migration v19 (`migratePayrollAccrualV19`) that broke
  the migration checksum guard for any customer who had already run it, blocking app startup
  entirely after updating ("Migration v19 was modified after publication; checksum mismatch").
  Migration v20 already handles reversing incorrectly-posted future-month accrual entries,
  so no behavior is lost.
- Fixed `tools/payroll-accrual-v19-regression.js` — was missing the electron module mock used
  by other executable regression tests, causing it to crash under plain `node` and (if ever run
  via the real Electron binary) to write test data into the real production database.
