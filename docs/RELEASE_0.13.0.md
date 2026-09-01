# Nexora POS v0.13.0

## Critical production hardening completed

### Branch isolation
- Customers now belong explicitly to a branch.
- Suppliers now belong explicitly to a branch.
- Customer lists, reads, edits, balances, ledgers, store credit, loyalty changes, and sales references are branch-scoped.
- Supplier lists, edits, balances, purchase orders, and receiving are branch-scoped.
- Legacy databases receive a safe branch backfill during migration.
- Central sync treats customers and suppliers as branch-owned financial entities rather than global shared data.

### Financial integrity
- Branch-level inventory weighted cost uses `inventory.unit_cost` correctly when receiving purchases.
- Historical sale cost remains in `sale_items.cost_at_sale`.
- Loyalty points cannot be injected through customer profile APIs; financial transactions are the source of loyalty points.

### Regression protection
- Added 15 dedicated v0.13 regression checks for branch isolation, loyalty protection, weighted cost, and sync ownership.

## Remaining external release steps

Native SQLite/Electron installation and OS-specific signed installers require a connected build environment with native dependency download/rebuild capability and real-device smoke tests. This is intentionally documented rather than falsely reported as completed here.
