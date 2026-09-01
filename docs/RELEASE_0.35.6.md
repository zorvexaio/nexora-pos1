# Nexora POS v0.35.6

## Production hardening
- Corrected clock rollback reason mapping so the UI reports the actual licensing failure.
- Release preflight now hard-fails if a vendor private signing key is present in the source tree.
- Added startup regression coverage for Electron session readiness, deferred database initialization, and licensing error-code consistency.
- Carried forward all v0.35.5 security, financial, sync, payroll, and renderer hardening.
