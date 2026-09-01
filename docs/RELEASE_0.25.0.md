# Nexora POS v0.25.0

## Deep hardening

- Branch-owned sale references are validated in the database transaction for customers, tables, shifts, and users.
- Products that do not track inventory no longer mutate inventory quantities during normal sales, table closes, splits, or returns.
- Split table sales validate current stock before committing the split.
- Purchase receiving updates branch inventory only for products configured to track inventory.
- Backup restore continues to validate the backup and close the live database before file replacement.
- Added `tools/v0.25-regression.js` and included it in `npm run check`.
