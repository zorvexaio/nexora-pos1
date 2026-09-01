# Nexora POS v0.16.0

## Production hardening

- Table ownership is enforced by branch before creating or reading an open table order.
- Sale detail joins customers and restaurant tables only within the sale branch.
- Closing a table records the actual cashier/manager who completed the payment in the payment ledger.
- Existing security, payroll, financial, sync, freeze, and idempotency controls remain enabled.

## Verification

- 54 JavaScript files syntax-checked.
- v0.16 regression: 8/8 PASS.
- Previous regression suites retained and rerun.
- Native Electron/SQLite packaging still requires a networked build environment with native dependency installation and platform signing.
