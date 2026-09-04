# Nexora POS v0.48.3

Payroll and employee advance hardening.

- Explicit salary payment records with cash/bank/other methods.
- Cash salary payment is linked to an open register cash-out.
- Payment cannot exceed the employee remaining net salary.
- Payroll month closes automatically when all active employees are fully paid.
- Paid months reject payroll mutations.
- Payment history and paid/remaining amounts are exposed to the renderer.
- Existing advances remain deductions from net salary; optional immediate cash advance remains linked to a register cash-out.
- No historical payment row is deleted by payroll correction flows.

Runtime limitation: native Electron/SQLite, Windows installer/signing, printer, and updater tests still require the real Windows release environment.
