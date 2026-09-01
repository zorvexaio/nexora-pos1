# Nexora POS v0.33.0

## Hardening
- Added a 2-second timeout to synchronous OS device-ID probes used for licensing.
- Preserved a safe fallback device identifier when OS probing fails or times out.
- Added v0.33 regression coverage for startup-freeze protection.
- `npm run check` now includes v0.32/v0.33 regression suites and release preflight.
