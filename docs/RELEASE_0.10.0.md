# Nexora POS v0.10.0

## Deep hardening

- Aggregates duplicate product quantities before inventory availability checks.
- Recalculates open table orders using the active tax profile and inclusive/exclusive semantics.
- Snapshots loyalty points awarded on each sale and reverses earned points safely on returns without double-reversing.
- Restricts cash-in/cash-out movements to the session opener or a manager/admin.
- Restricts branch profile edits to the active branch and validates business type.
- LAN pairing codes now use cryptographic randomness and are single-use.
- Preserves sync revision ordering when replacing an existing entity version.

## Validation

- 48+ JavaScript files syntax-checked.
- Full regression: PASS.
- Security regression: PASS.
- Payroll regression: PASS.
- Deep regression: PASS.
- Global financial regression: PASS.
- Authentication bootstrap regression: PASS.
- GS1 regression: PASS.
- IPC authorization regression: PASS.
- v0.9 regression: PASS.
- v0.10 regression: PASS.

## Native build limitation

The current execution environment does not contain `node_modules`, and network/package installation is not available reliably enough to build `better-sqlite3-multiple-ciphers` and Electron native artifacts here. Therefore the native SQLite/Electron integration test and signed installers are not claimed as executed.
