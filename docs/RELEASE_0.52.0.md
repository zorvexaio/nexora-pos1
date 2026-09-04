# Nexora POS v0.52.0 — Payroll Termination & Final Settlement

- Added payroll employee termination workflow.
- Added final settlement ledger with local-currency minor-unit integrity.
- Final settlement calculates earned salary through the selected termination date.
- Outstanding employee advances are fully offset against the final settlement without a false cash-in.
- Optional additional compensation and deduction handling.
- Cash final settlement requires an open register shift and records a cash-out.
- Employee is deactivated only after successful settlement.
- Added final-settlement IPC/preload methods and payroll UI action.
- Added schema migration v14.
