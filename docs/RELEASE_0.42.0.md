# Nexora POS v0.42.0 — UX & Localization Hardening

## User-facing fixes
- Added a persistent, prominent back button to the table-order screen.
- Back navigation saves the current open table order before leaving.
- Alt+Left is supported for table-order navigation; Escape leaves the screen when no modal is open.
- Added premium focus styling for the table-order back control.

## Localization
- Added shared Arabic/Turkish/English fallback translations for legacy hard-coded strings.
- Programmatic alerts/confirmations now use the same translation catalog as static page text.
- Dynamic text receives phrase-level translation so status/amount messages do not fall back to Arabic after switching language.
- Table-order actions and dialogs now use translation keys.

## Release/test hardening
- Added `v0.42.0-regression.js`.
- Made historical regression checks forward-compatible with newer release versions.
- Regenerated release manifests.
- Verified release preflight and the full `npm run check` suite.
