# Nexora POS v0.45.11 — Payroll Architecture Repair

## Payroll architecture

- Payroll workers are stored in `payroll_employees`, independent from `users`; no login/PIN/password is created for payroll-only workers.
- Active payroll operations use `payroll_months`, `payroll_employee_months`, and `payroll_transactions`.
- The legacy payroll period approval/payment API is no longer exported and cannot be reached through the current IPC surface. Legacy tables remain only for backward-compatible data preservation/migration.

## Payroll calculation

`Base − absence deduction − advances − deductions + overtime + bonuses = net salary`.

Absence is recorded by date, duplicate absence dates are rejected, and every movement is persisted with an optional reason.

## Reliability

- Month creation handles concurrent first-open requests safely.
- Payroll mutations are transactionally persisted with recalculation.
- Historical rows remain stored when an employee becomes inactive.
- The current month total excludes inactive employees while retaining their historical records.

## Verification

- Payroll static regression: PASS.
- Full source regression: PASS (111 JavaScript files syntax-checked).
- Release preflight: PASS.
- Native SQLite integration test was added but could not be executed in this build environment because the installed `better-sqlite3-multiple-ciphers` package has no native binary available here.
