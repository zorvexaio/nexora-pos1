# Nexora POS v0.52.17 — Sprint 2 Corrections

- Normalized snake_case SQLite sale rows before accounting posting in completed-sale item modification.
- Enforced partial-return quantity floors inside the modification transaction.
- Added manager/admin-controlled discount editing to invoice modification.
- Added deterministic kitchen delta generation and delta-ticket printing.
- Added global/product-aware tax-inclusive calculations to the POS preview.
- Added 58mm/80mm paper-width configuration for receipt and kitchen printing.
- Reduced network print feed padding and removed kitchen trailing padding.
- Completed modification category tabs and corrected new-product preview pricing.
- Added targeted accounting, tax-UI and printing regression gates.

No schema migration added.

- Added payment-only accounting reclassification (cash/card/credit/mixed) without duplicating revenue or tax, using the configured currency minor-unit precision.
- When modifying items after a prior payment correction, prior payment-reclassification journals are reversed together with the historical sale journal before reposting the current economics.
- Preserved tax-profile metadata through variant, GS1 and weighted-barcode product lookups so the POS preview cannot silently fall back to the global tax mode.
- Added a deterministic financial scenario covering sale → cash/card correction → item modification → balanced accounting → kitchen delta.
- Expanded printing regression coverage to 8 checks, including network feed propagation and 58mm/80mm kitchen trimming.
