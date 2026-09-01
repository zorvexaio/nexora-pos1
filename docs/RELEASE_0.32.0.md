# Nexora POS v0.32.0

## Audit hardening

- IPC now enforces renderer provenance on every channel using the frame-aware `isTrustedRenderer(webContents, senderFrame)` helper.
- Non-main-frame IPC requests are rejected.
- `release-preflight.js` regenerates and verifies `CORE_SHA256.txt`, the versioned core manifest, and `docs/VERSION.txt` on every release preflight.
- `tools/v0.31-regression.js` verifies manifest/version synchronization and actual IPC sender-trust enforcement.
- Stale v0.31 hash/version artifacts were removed or regenerated for v0.32.0.

## Verification

- Full regression suite: PASS
- Release preflight: PASS
- SQLite schema from empty database: PASS
- Foreign key check: PASS
- Private PEM scan: PASS
- ZIP integrity: PASS
