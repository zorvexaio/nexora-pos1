# Nexora POS v0.40.3

## Legacy multi-branch database compatibility
- Added a single, audited legacy-branch migration map covering every table whose current schema requires `branch_id`.
- Existing rows keep any existing branch ownership; only NULL legacy ownership is backfilled.
- Relationship-derived branch ownership is preferred for ledgers, payments, cash movements, payroll adjustments, salary history, and audit rows; the current/default branch is the final fallback for genuinely single-branch legacy data.
- Migration fails closed when any branch-owned row remains unresolved.
- Per-table branch indexes are created after migration.
- Added a regression guard that compares the schema's branch-owned tables with the migration coverage list so future multi-branch additions cannot silently omit a migration.
