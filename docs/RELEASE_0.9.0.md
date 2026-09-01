# Nexora POS v0.9.0

## Production hardening

- Password self-change is now strictly scoped to the authenticated user's current branch and active account.
- Open restaurant/table orders are no longer trusted with client-provided prices, tax rates, line totals, or historical cost. The server recalculates them from the product/tax database.
- Closing an open table order recalculates the total immediately before payment, validates current inventory, and writes the payment ledger entries.
- Splitting table orders recomputes split line totals and preserves `cost_at_sale`.
- Merging table orders preserves historical item cost.
- Inventory adjustments validate that the product exists and is active and reject zero/non-finite adjustments.
- Legacy global protections remain active: branch-scoped login, branch-scoped approvals, optional cash sessions, monthly payroll, secure backup/restore, sync branch isolation, store credit, historical cost accounting, GS1 barcode support, and IPC authorization.

## Verification

- Full regression: PASS
- Security regression: PASS
- Payroll regression: PASS
- Deep regression: PASS
- Global financial regression: PASS
- Authentication/bootstrap regression: PASS
- GS1 regression: PASS
- IPC authorization regression: PASS
- v0.9 regression: PASS (10/10)
- JavaScript syntax checks: PASS

Native Electron/SQLite packaging is still environment-dependent and must be rebuilt on a connected build host with the pinned dependencies before producing signed installers.
