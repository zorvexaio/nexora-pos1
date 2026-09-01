# Nexora POS v0.45.12 — Final Release Verification

## Release
- Version: `0.45.12`
- `VERSION` = `0.45.12`
- `package.json` = `0.45.12`
- `package-lock.json` = `0.45.12`

## Payroll V2
- Payroll workers are independent from `users`.
- New payroll workers do not receive login credentials/PINs.
- No Payroll V2 open/approve/pay lifecycle is exposed.
- Transactions: absence, advance, deduction, overtime, bonus.
- Net salary is recalculated after movement changes.
- Duplicate absence on the same employee/date is rejected.
- Inactive workers retain historical payroll records.

## Startup hotfix
The legacy payroll-worker migration now binds exactly eight values for:
`uuid, branch_id, full_name, job_title, pay_type, pay_rate, is_active, legacy_user_id`.

This removes the reported `Too many parameter values were provided` startup failure.

## Automated validation completed
- `node tools/payroll-regression.js` — PASS (18/18)
- `node tools/deep-regression.js` — PASS (15/15)
- `node tools/full-regression.js` — PASS (111 JS files syntax-checked)
- `node tools/release-preflight.js` — PASS
- `node tools/windows-structure-regression.js` — PASS
- `node tools/release-metadata-regression.js` — PASS
- `node tools/runtime-export-regression.js` — PASS
- `node tools/client-event-hardening-regression.js` — PASS
- `node tools/security-regression.js` — PASS
- `node tools/v0.21-regression.js` — PASS (18/18)

## Environment limitation
A full real SQLite/Electron process test could not be executed in this Linux validation environment because the native `better-sqlite3-multiple-ciphers` runtime binary is not available. The source-level regression covers the exact binding mismatch that caused the reported startup error, but this does not replace a final Windows installer/device test.
