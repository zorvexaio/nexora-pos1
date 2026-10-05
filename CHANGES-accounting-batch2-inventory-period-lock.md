# Accounting batch 2 — inventory 1300 + real period lock

## Inventory follows quantity (all business types)
- **Transfer out (source branch):** Cr 1300 / Dr 3000 (inter-branch equity)
- **Transfer in (destination):** Dr 1300 / Cr 3000
- **Stock adjustment** already posted 1300 ↔ 5900; now also blocked when period locked

## Period lock is real
- Default journal `entry_date` uses **organization local date** (`timezone` from profile), not UTC midnight edge cases
- `assertAccountingPeriodOpen()` blocks transfers, adjustments, and cancel-transfer even when no journal would run
- Journal path still enforces lock inside `insertPostedJournalEntry`

## Suits everyone
Restaurant / supermarket / fashion / general all share inventory + period rules; no sector-specific path.
