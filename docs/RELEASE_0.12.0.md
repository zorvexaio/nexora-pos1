# Nexora POS 0.12.0 — Production Hardening

## Security
- Added database-layer password and PIN rate limiting.
- Added one-time migration forcing active legacy admins to rotate credentials without embedding a default password in runtime code.
- Kept branch-scoped authentication and IPC authorization.

## Payments & Sales
- Added branch-scoped `client_request_id` idempotency for sales. A retried request returns the original invoice instead of creating a second sale.
- Prevented duplicate kitchen/receipt side effects for idempotent retries.

## Returns & Loyalty
- Refund methods are validated server-side.
- Loyalty reversal excludes the current return from the prior-refund sum, eliminating double counting.

## Verification
- 50 JavaScript files syntax-checked.
- Security, payroll, deep, financial, auth bootstrap, IPC, GS1, v0.9, v0.10, v0.11 and v0.12 regression suites all PASS.
- 142 IPC handlers scanned; no duplicate channel names.
- Runtime source contains no hard-coded legacy admin password.

## Native build limitation
The environment used for this audit did not contain `node_modules` and did not provide a reliable npm registry path for native Electron/SQLite dependency installation. Therefore installer generation/signing was not represented as successful.
