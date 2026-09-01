# Nexora POS v0.31.0 — Global Readiness Matrix

## Technical posture
- Electron: context isolation enabled; Node integration disabled; renderer sandbox explicitly enabled.
- Renderer permissions: denied by default; local renderer navigation restricted; popup creation denied.
- CSP is enforced for the renderer surface.
- IPC is default-deny and authenticated for protected operations.
- SQL values use parameter binding; dynamic identifiers come from fixed internal allow-lists.
- SQLite is encrypted and initialized from a schema that passes foreign_key_check.
- Offline-first operation is supported, with branch-scoped synchronization and idempotency.
- Multi-terminal invoice identity includes a terminal token and server-side collision reservation.
- Card data model stores provider/reference metadata rather than raw PAN/CVV.
- Payroll uses monthly salary cycles, not hourly payroll as the primary model.
- Optional cash sessions do not block sales.
- GS1 1D/2D parsing and weighted/lot/expiry-aware barcode support are integrated.
- Arabic, Turkish and English localization is included.
- Organization country, timezone, currency precision and tax profile are configurable.
- Backup/restore includes validation and pre-restore safety backup.
- License signing uses Ed25519; the customer build contains only the public key.
- Release preflight blocks known unsafe/incomplete release states.

## Standards alignment
The project is engineered to align with current published security/retail baselines, including:
- OWASP ASVS 5.0.0 as a security verification baseline.
- PCI DSS v4.0.1 as the card-data security baseline (without claiming PCI certification).
- GS1 retail 2D guidance / Ambition 2027 for coexistence of 1D and GS1 2D POS scanning.
- EU ViDA architecture awareness for digital reporting/e-invoicing boundaries.

## What is intentionally not claimed as universal legal compliance
Country-specific fiscalization, VAT/e-invoicing certification, payment-acquirer certification, local tax authority APIs, privacy registrations, hardware certifications, and signing/notarization requirements depend on the deployment country, legal entity, payment provider, and hardware. Nexora exposes integration boundaries for these concerns; it does not claim one implementation is legally compliant in every jurisdiction.

## Release blockers outside this source package
1. Native Electron/SQLite build on each target OS.
2. Installer signing/notarization certificates.
3. Production update feed URL and signing workflow.
4. Production fiscal/payment provider credentials and country adapters.
5. Real POS scanner/printer/payment-terminal validation on target hardware.

These are environment/vendor deployment requirements, not hidden application TODOs.
