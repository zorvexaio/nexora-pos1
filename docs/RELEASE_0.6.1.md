# Nexora POS v0.6.1 — Production Hardening

## Security and isolation
- Login by username/password is now restricted to the device current branch.
- Discount and credit approvals are restricted to active managers/admins in the current branch.
- Central sync pull responses are filtered by the authenticated branch key.
- The client rejects branch-owned records belonging to another branch (fail-closed).

## Payroll
- Salary payout now writes `payment_method` and `payment_reference` into dedicated database fields.

## Compatibility
- Existing monthly-salary migration fields are preserved.
- No renderer access to Node/Electron internals was introduced.

## Verified
- All JavaScript files syntax-check successfully.
- Security regression: PASS.
- Payroll regression: PASS.
- Deep regression: PASS.
- Native Electron/SQLite installer build is still environment-dependent when npm/native binaries are unavailable; this is documented rather than falsely marked as complete.
