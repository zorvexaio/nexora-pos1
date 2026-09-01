# Nexora POS v0.45.3

## Zero-regression hardening

- Preserved the payroll `t()` shadowing fix and regression coverage.
- Added explicit English/Turkish coverage for all literal Arabic `alert()`/`confirm()` messages found in the renderer.
- Strengthened the deep regression gate so every literal Arabic runtime dialog must have EN/TR translations.
- Kept package, lockfile, VERSION, manifest and release metadata synchronized.
