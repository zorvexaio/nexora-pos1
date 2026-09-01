# Nexora POS v0.21.0

## Critical production hardening

- Synchronized payment ledger records, cash movements, optional cash-register sessions, inventory movement history, supplier ledger records, and branch tax profiles.
- Added stable UUIDs and sync flags to legacy supplier/inventory movement ledgers through safe migrations.
- Added branch-safe reconstruction of foreign keys on the receiving device.
- Added created-by username mapping for synced payment/cash/shift records without synchronizing password or PIN material.
- Added a client-side sync mutex so manual sync and background sync cannot run concurrently and race the cursor.
- Updated electron-builder to 26.15.7 and application version to 0.21.0.

## Verification note

Source-level and regression tests are executed in the development environment. Native Electron/SQLite build and platform installers still require a network-enabled build host with native dependency rebuild and platform signing credentials.
