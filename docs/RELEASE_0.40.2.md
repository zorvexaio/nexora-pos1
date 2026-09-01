# Nexora POS v0.40.2

## Database compatibility
- Adds explicit branch ownership to `supplier_ledger`.
- Backfills legacy supplier-ledger rows from the owning supplier branch during migration.
- Fails closed if legacy rows cannot be mapped to a branch.
- Adds runtime schema compatibility checks after migrations.
- Supplier-ledger sync is now directly branch-scoped.
