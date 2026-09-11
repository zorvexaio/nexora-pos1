# Nexora POS v0.52.9

## Features
- Loyalty points redemption now works on table/restaurant orders too (previously cashier checkout only).
- Global default tax rate setting for new products (Settings > Default Tax).
- POS category tabs with images (auto-hidden when no category has an image set) — Settings > POS categories.
- Quick-quantity entry at checkout (type a number, then tap a product to add that quantity at once).
- Collapsible "extra options" panel at checkout (delivery, order time, note, discount) to declutter the default view.
- Toggle to show/hide the QR code on the customer receipt (Settings).
- Category display order is now configurable (up/down arrows) from Settings.

## Fixes
- Table order accounting entries were silently unbalanced (minor-unit columns were never populated for this code path) — now derived reliably from the maintained major-unit columns.
- Table/restaurant orders never posted to the accounting ledger at all — now they do, matching direct cashier sales.
- Reports "payroll expense" figure was double-prorated for the current in-progress payroll month, understating it significantly — fixed.
- Migration v20 added to reverse payroll accrual entries that were incorrectly posted for future months that hadn't started yet.
- Kitchen ticket showed "Invalid Date" instead of the scheduled delivery time (format mismatch between ISO-stored value and the legacy parser) — fixed, matching the earlier fix already applied to the customer receipt.
- Kitchen ticket callout boxes (order note, delivery time) were excluded from the "force pure black on print" rule that the customer receipt already had, causing faint/unclear text on thermal printers — now included.
- 49 hardcoded Arabic toast/notification messages across accounting, reports, settings, and tables pages now translate properly to EN/TR.
- Two CSS color inconsistencies unified with existing design tokens (kitchen note callouts, payment-correction form borders).
- Various release-tooling fixes (stale hardcoded version checks, private key relocated out of tracked source, case-insensitive path check false positive).

## Validation
- Full native/engineering regression suite: PASS.
- Loyalty redemption regression (26 checks, real SQLite): PASS.
- Migration chain regression (v2..v20): PASS.
- Table order + customer + loyalty redemption end-to-end (real SQLite, trial balance verified balanced): PASS.
- Category reorder + receipt QR toggle: PASS.
