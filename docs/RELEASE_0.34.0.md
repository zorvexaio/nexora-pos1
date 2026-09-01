# Nexora POS v0.34.0

## Release hardening

- Removed stale versioned core manifests from the release tree; only the current `CORE_SHA256_V0.34.0.txt` is shipped alongside the canonical `CORE_SHA256.txt`.
- `release-manifest.js` now removes stale `CORE_SHA256_V*.txt` files before writing the current manifest.
- `release-preflight.js` rejects stale versioned manifests and keeps `docs/VERSION.txt` synchronized with `package.json`.
- Added `tools/release-archive.js` to build a deterministic source ZIP with a single canonical root directory: `nexora-pos-v0.34.0/`.
- `npm run release:archive` is gated by `release-preflight`, so archive creation cannot proceed with an invalid release state.
- Verified the final archive by extracting it, checking the embedded version, checking manifest freshness, validating ZIP integrity, and rerunning the full static/preflight suite from the extracted tree.

## Security lineage retained

This release retains the v0.33 protections: Electron sandboxing, renderer sender validation, strict CSP, permission denial by default, HTTPS-only remote synchronization, license clock rollback protection, pinned native dependency versions, and the release manifest/preflight chain.

## Known environment limitation

A native Electron/SQLite runtime build and OS-specific signed installers still require a real build environment with the native dependency toolchain and signing credentials. Static, schema, manifest, security, regression, and archive checks are executed here.
