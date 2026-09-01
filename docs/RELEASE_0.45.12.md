# Nexora POS v0.45.12 — Release Guide

## Scope

This release completes the financial and table-order fixes introduced during the 0.45.x line. It is intended for a Windows x64 build using Node.js 22.12 or later.

## Included fixes

- Cash sales retain the full amount received and record customer change separately; cash-session totals use the net retained amount.
- Credit sales update the customer balance and ledger, and customer debt payments record the associated financial movement.
- Purchase invoices are received immediately by default, update branch inventory and weighted cost, and record supplier debt and supplier payments.
- Table-order inventory is committed by quantity delta, so editing, splitting, merging, or closing a table order cannot deduct already-committed stock twice.
- A completed table payment is linked to the currently open cash session, so its net cash is included in that session's expected balance.
- Table bill splitting records the correct number of columns and values when creating the paid invoice.
- Renderer stall monitoring records diagnostics without automatically reloading the active window and discarding user input.

## Verification completed

- `npm test` — synchronization integration tests.
- `npm run test:payments-purchases` — cash/change, credit, debt payment, purchases, inventory, supplier, and cash-session coverage.
- `npm run test:freeze` — renderer performance and stall-safety checks.
- `npm run check` — full release regression suite and release preflight.

## Build and delivery

Run `npm run dist:win` on Windows to create the NSIS x64 installer in `dist/`. The build uses the application icon in `build/icon.ico` and packages the application with ASAR enabled.

Before distributing, install the generated package on a clean Windows machine and verify startup, licensing, printer configuration, a cash sale with change, a table split payment, and an end-of-shift cash reconciliation.
