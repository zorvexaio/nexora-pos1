# Nexora POS v0.31.0

## Final hardening
- Electron sandbox explicitly enabled globally and on critical renderer windows.
- Renderer permission requests/checks denied by default.
- Trusted local-renderer provenance helper retained alongside navigation/window-open restrictions.
- Release preflight now blocks a build if sandbox hardening is absent.
- Regression suite expanded for the hardened Electron runtime posture.

## Global readiness note
This release is engineered to be global-ready, but country-specific fiscalization, acquiring, payment-terminal certification, and legal/tax approvals remain deployment integrations rather than claims of universal legal compliance.

Current reference baselines include OWASP ASVS 5.0.0, PCI DSS 4.0.1, and GS1 retail 2D guidance.
