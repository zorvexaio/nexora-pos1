# Nexora POS v0.26.0 — Final Hardening Audit

## Fixed in this release

1. Embedded a real Ed25519 public verification key; the previous placeholder is gone from the executable configuration.
2. Added real end-to-end license verification and activation regression tests.
3. Operational IPC and authentication re-check local license validity.
4. Standalone plaintext sync defaults to loopback only; non-loopback plaintext requires an explicit insecure override.
5. Sync responses are marked `no-store` and include basic security headers.
6. Added release preflight checks so an installer build stops when licensing, icons, or pinned native versions are invalid.
7. Vendor private signing key is deliberately kept outside the customer application ZIP.

## Verification executed

- `npm run check`: PASS
- v0.26 regression: 10/10 PASS
- Real Ed25519 license: sign -> verify -> activate: PASS
- Tampered license rejection: PASS
- SQLite schema from empty database: PASS
- `PRAGMA foreign_key_check`: PASS
- Release preflight: PASS
- Full JavaScript syntax sweep: PASS
- Customer tree contains no PEM/private-key file: PASS

## Native build boundary

The source tree is ready for a native Electron/SQLite build, but this environment does not have the native dependency installation/build chain required to honestly claim a produced Windows/macOS/Linux installer. The `dist:*` scripts now run `tools/release-preflight.js` before `electron-builder` so a real build machine fails closed on missing production prerequisites.
