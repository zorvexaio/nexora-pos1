# Nexora POS 0.24.0

## Hardening

- Branch isolation enforced for purchase-order listing and retrieval.
- Barcode resolution IPC requires an authenticated account before exposing product resolution data.
- Purchase-order retrieval verifies the current branch against both purchase order and supplier ownership.
- Added regression coverage for these boundaries.

## Verification

- 61 JavaScript files syntax-checked.
- v0.24 regression: 5/5.
- Full regression suite retained as a release gate.
- SQLite schema load and foreign-key check executed with Python sqlite3 in the build environment.

## External build boundary

Native Electron/SQLite packaging and code signing still require a real build host with network access to the npm registry and platform signing credentials.
