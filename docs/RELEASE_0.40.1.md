# Nexora POS v0.40.1

Maintenance release focused on Electron startup determinism.

- Consolidated permission hardening, CSP wiring, and database startup under one `app.whenReady()` path.
- Kept database initialization after session setup and Electron readiness.
- Added `v0.40.1` regression coverage for startup ordering.
- No business, accounting, sync, payroll, or licensing behavior was intentionally changed.
