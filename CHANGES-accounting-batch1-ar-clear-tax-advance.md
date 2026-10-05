# Accounting batch 1 — AR return, tax, advances, final settlement

Fixes (no UI / no payment-method product logic changes beyond ledger):

## 1. Credit-sale return clears AR (1200) + customer balance
- On return of a credit sale (or any sale with remaining `due_amount`), clear
  customer `balance` / `balance_minor` and reduce sale `due_amount` proportionally.
- Journal credits **1200** for the cleared AR portion instead of paying cash for
  an amount that was never collected.
- Cash/card `payment_transactions` only record the non-AR residual (if any).

## 2. Return tax follows original sale tax ratio
- `totalTaxRefundedMinor` is derived from `sale.tax_total` × (refund / grand_total)
  instead of extracting inclusive tax from the post-discount refund line amount.
- Keeps **2100** / **4000** aligned with the original sale posting.

## 3. Salary advance recovery closes 1400
- When net salary payment recovers scheduled advances, journal also posts:
  - Dr **6100** (true expense up to gross)
  - Cr **1400** (clear employee advances asset)

## 4. Final employee settlement posts journal
- `settleEmployeeFinalPayroll` now posts:
  - paid net → Dr 6100 / Cr cash|bank
  - remaining advances → Dr 6100 / Cr 1400

Regression focus: assert account balances on 1200, 1400, 2100, 4000, 6100 —
not only that the trial balance is balanced.
