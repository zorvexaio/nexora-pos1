# Nexora POS v0.34.1

## Release hardening
- Added `tools/v0.34-regression.js` to execute the real release archive builder and verify archive root, current manifest, and absence of stale versioned manifests.
- Wired the v0.34 archive regression into `npm run check` so archive structure cannot regress silently.
- `release:archive` remains preflight-gated.
- No runtime POS behavior was changed in this maintenance release.
