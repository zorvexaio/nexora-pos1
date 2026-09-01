# Nexora POS v0.45.1 — Deep Commercial Hardening

This release tightens transactional integrity and validates product/catalog input at the database boundary.

## Fixed
- Synchronized package, lockfile, VERSION, and release metadata.
- Manager approval grant IDs are preserved from approval UI into the sale payload.
- Product updates now validate all numeric fields and execute product + inventory changes atomically.
- CSV product imports reject malformed numeric values instead of silently converting them to zero.
- Product identifiers are validated to prevent ambiguous barcode/SKU entries.
- Category, supplier, and restaurant-table creation now reject invalid empty/negative values.
- Migration column-add failures are no longer silently swallowed unless the column already exists.
- Regression tests are forward-compatible with subsequent patch releases.
- i18n duplicate-key regression now performs structural per-language validation.

## Verification
The static/security/regression gates must all pass before distribution. Native Windows runtime, printer, installer signing, and real update-provider validation remain required on a Windows release machine.

## Deep-audit additions
- Sale line items now persist whether their tax was inclusive at the moment of sale, protecting historical returns from later tax-setting changes.
- Returns calculate actual merchandise refund value including historical tax treatment and allocated invoice/bundle discounts, rather than using raw line totals.
- Profit/loss reporting accounts for partial refunds and bundle discounts and can handle refunds of sales from earlier reporting periods.
- Cash opening/closing is fail-closed on invalid amounts and validates the acting user.
- Cashier discount configuration is fail-safe if its stored setting is corrupt.
- Preload IPC channel contract was audited: all 147 invoked channels have a corresponding main-process handler.
