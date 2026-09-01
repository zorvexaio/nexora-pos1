# Nexora POS v0.30.0

## Critical production hardening

### Multi-device invoice uniqueness
Invoice numbering is now terminal-aware. Each installation has an 8-character terminal token stored outside the database in the user's application-data directory. New invoice numbers use:

`BRANCH-YEAR-TERMINAL-SEQ`

This prevents ordinary multi-terminal duplicates within a branch when each device has its own terminal identity. The local allocator also checks the local database before issuing a number.

### Central sync collision guard
The central sync server now keeps a dedicated `(branch_uuid, invoice_number)` reservation table. A collision from two devices is rejected instead of silently accepting ambiguous invoice numbers.

This is a uniqueness safeguard; jurisdictions that require a centrally allocated, gapless fiscal sequence still need the applicable fiscalization adapter/provider.
