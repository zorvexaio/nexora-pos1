# Nexora POS v0.45.0 — Pre-Sale Hardening

This release is focused on pre-sale reliability rather than adding random features.

## Reliability
- Restores now validate the copied database before relaunch.
- A pre-restore safety backup is retained and used for rollback if validation fails.
- Automatic printing now handles renderer load failures and readiness timeouts without blocking the sale.
- Payment currency codes are validated before entering the payment ledger.
- Remote sync cannot be enabled without a branch access token.

## Release Gate
- Added `tools/sale-readiness.js` to check production structure, security posture, syntax, packaging assets, and release metadata.
- Added a dedicated v0.45.0 sale regression suite.

## Release limitation
A final commercial release still requires verification on the actual Windows release machine for native SQLite rebuild, installer execution, printer drivers, Windows code signing, and any externally hosted update/sync infrastructure.
