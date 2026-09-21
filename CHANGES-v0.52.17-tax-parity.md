# Nexora POS v0.52.17 — Tax parity follow-up (review round 2)

Scope: only items (أ) open-order tax, (ب) receipt, (ج) tests, plus two closely related
findings that the new tests exposed (listed separately below so they can be reverted alone).
No schema migration. Historical sales are untouched: stored rows are read as stored, and
the new logic applies to newly saved/closed orders only.

## (أ) One tax engine for every path — `database/db.js`
- `setOpenSaleItemsTx` (table order save) and `recalculateOpenSale` (runs on table close /
  merge / split) now use `money.toMinor` + `money.multiplyMinorQuantity` + `money.taxMinor`
  per line, exactly like `priceItemsFromDatabase` (direct sale) and split-payment.
  Before: floating-point math (`gross - gross/(1+rate)`), summed then rounded at the end
  (and with a hard-coded ×100), so the open order, the closed invoice and the ledger could
  differ by a minor unit, and 3-decimal currencies were rounded to 2 decimals on close.
- Table-order ledger posting derives its minor amounts from these stored totals, so it now
  posts the same revenue / tax-payable split as a direct sale.
- `getProfitLoss`: per-line net for inclusive items now uses the same minor-unit rounding
  (was `gross / (1 + rate/100)` unrounded), so the report equals the ledger.
- POS cart, checkout and the invoice-modification screen (`renderer/common.js`
  `computeCartLineTax` / `sumCartTax`, used by `pos.js` and `pages/returns.js`) now round
  per line in minor units exactly like the backend, so the on-screen total equals the saved
  invoice (avoids a possible 1-minor-unit mismatch between the screen total and the invoice).

## (ب) Receipt — `renderer/receipt.js`, `renderer/i18n.js`
- All amounts follow the organization's `currency_minor_unit` (0/2/3), not a fixed 2.
  (Secondary-currency line keeps 2 decimals: its precision is not configured anywhere.)
- Tax-inclusive invoices print "Prices include tax" (or "Some items include tax" for mixed
  invoices) under the tax row. Derived from the stored `sale_items.tax_inclusive`, so old
  invoices print according to how they were sold, not the current global setting.
  Exclusive receipts are unchanged. Keys added for ar / tr / en.
- Standard extraction: 450 inclusive @10% → net 409.09 + tax 40.91 = 450.00.

## (ج) Tests
- `tools/tax-inclusive-regression.js`: 4 rates × 11 amounts (incl. 1, 5, 49, 99, 999 minor
  units), inclusive + exclusive, against an independent integer reference; 450@10% vector.
- `tools/tax-parity-regression.js` (needs native SQLite → `npm run test:tax-parity`):
  0/5/10/15 % × inclusive/exclusive × 0/2/3-decimal currencies. Same 4 awkward lines go
  through direct sale, open-order save and table close; asserts equal subtotal / tax / total,
  integer reference match, Tax payable (2100) delta == invoice tax, trial balance balanced,
  and Profit&Loss revenue delta == net subtotal.
- `tools/cart-tax-ui-parity-regression.js`: 12,000 random lines, UI helper == `core/money`.
- `tools/receipt-format-regression.js`: minor units, inclusive/exclusive/mixed note.
- New no-native tests are wired into `test:engineering:source` and its runner.

## Related finding fixed (separate, easy to revert)
- `currency_minor_unit || 2` appeared 36 times in `database/db.js`. Because `0` is falsy,
  a 0-decimal currency (JPY…) was silently treated as 2 decimals in trial balance, income
  statement, balance sheet, refund posting, payroll, etc. (JPY tax 470 showed as 4.70).
  Replaced by `?? 2` (the rest of the file already used `??`). No effect for 2/3-decimal
  currencies.

## Not changed on purpose
- Order of work, atomic commits, font +2 proof: not blockers per review decision.
- POS cart labels and the reports UI still format with `toFixed(2)`; only receipts were in
  scope. Worth a follow-up for 0/3-decimal currencies.
- Still requires the real Windows verification round (printers 58/80 mm, NSIS, LAN).

---

# Round 3 — review finding: table-order screen (release blocker) + P1 items

## P0 — `renderer/pages/table-order.js` (confirmed and fixed)
- The screen computed tax as always-exclusive (`price × qty × rate/100`) and never read the
  inclusive flag: 450 inclusive @10% showed 450 + 45 = 495 while the backend saves
  409.09 + 40.91 = 450. Same in the split bill (`price × (1 + tax/100)`).
- Cart lines now carry `taxRate` + `taxInclusive` (stored sale item flag for existing lines;
  tax profile → organization mode for new products, same rule as the backend).
- Cart preview and split total use the shared `sumCartTax` engine (per-line, minor units).
- **Checkout now uses the backend `grandTotal` returned by the save** (authoritative);
  the local preview is only a fallback.
- All money output follows `currency_minor_unit` (was `toFixed(2)`).
- New `tools/table-order-tax-regression.js` executes the real screen code against a stub DOM:
  inclusive / exclusive / mixed carts, split bill, checkout total (sentinel proves it is the
  backend value), 0/2/3-decimal currencies, plus static guards against the old formulas.

## P1
- 4) `validatePaymentAmounts` (legacy, float, 0.01 tolerance — 10 minor units in KWD) is now a
  thin wrapper over `validatePaymentAmountsMinor`: every payment path (direct sale, table close,
  split, payment-method correction) validates exactly in minor units. Mixed-payment split in
  `correctSalePaymentMethod` no longer rounds with a hard-coded ×100.
- 5) `toFixed(2)` removed from the table screen (see above). The `step="0.01"` attributes are on
  `type="text"` inputs, so they have no functional effect; left as is.
- 6) P&L returns: `sale_net_before_discount` is no longer computed with float division in SQL;
  it is summed in JS from per-line minor-unit net (same rounding as sales and the ledger).
- New native test `tools/payment-returns-minor-regression.js` (run by `npm run test:tax-parity`):
  KWD cash short by 0.005 is rejected (the old code accepted it), JPY short by 1 is rejected,
  and P&L returns on a tax-inclusive 9.99×3 @15% invoice equal the per-line rounded net/3.

## Still open (not done in this round)
- Other hard-coded `Math.round(x * 100) / 100` sites in `db.js` (cash-shift expected cash,
  customer balance deltas, purchase-order totals, payroll helpers…). Harmless for 2-decimal
  currencies; wrong for 0/3-decimal ones.
- `toFixed(2)` in `pos.js` (cashier screen) and reports UI for 0/3-decimal currencies.
- Cashier modifying an invoice with a manager-granted permission: new requirement, see reply.
- P2: Windows NSIS build, printers, LAN, backup/restore.

Test maintenance: `tools/v0.18-regression.js` asserted the literal text of the old float validator
(`cash + 0.01 < t`, `expectedChange`); it now asserts the same intent (tender above total accepted,
exact change required) on `validatePaymentAmountsMinor`.

---

# Round 4 — "عرض" (offers / bundles) on kitchen ticket and receipt

Reported: an order paid with an offer printed on both printers as a normal order, with no "عرض" mark.
Cause: the sale only stored `bundle_discount_total`; which offer was applied (and its items) was never
persisted, kitchen ticket and receipt did not know about offers at all, and the receipt did not even
print the offer discount, so the printed arithmetic did not add up.

- **Snapshot per invoice** — new table `sale_bundles` (offer name, times applied, discount, components
  with names/quantities), created by `schema.sql` with `CREATE TABLE IF NOT EXISTS` (additive, no
  schema-version bump, same mechanism as the other additive tables). Written in `createSale` and rewritten
  when invoice items are modified. Old invoices are unaffected (no snapshot → no offer block).
  Later edits/deletes of the offer do not change printed history.
- `getSale` returns `bundles`; the sale sync payload carries `bundles_applied` and the receiving side
  stores it idempotently (uuid key), so a reprint on another device shows the offer too.
- **Kitchen ticket**: a framed block `*** عرض *** <name> ×n` with the offer's components (with their notes);
  the offer's quantities are subtracted from the normal lines so nothing prints twice (3 burgers with a
  1-burger offer → 1 in the block, 2 as normal). Plain `***` text instead of emoji (thermal printers).
- **Receipt**: the same framed block after the items, plus a "خصم العروض" row so
  subtotal + tax − discount − offer discount … = total is visible on paper. ar / tr / en strings added.
- New `tools/bundle-offer-print-regression.js` (`npm run test:offers`, native SQLite): discount and
  snapshot, snapshot survives editing the offer, kitchen block / no duplicates / partial consumption /
  notes, receipt block + discount row, no offer → unchanged output, invoice modification refreshes the
  snapshot, sync payload and receive (idempotent).

Not covered: the *delta* kitchen ticket printed after an invoice modification (it lists changed lines only,
without an offer block); offers are not available in the table-order screen at all (unchanged behaviour).

## CRITICAL CORRECTION to rounds 1–3 (found while testing round 4)
The mechanical replacement `currency_minor_unit || 2` → `?? 2` (round 1) also touched the bodies of two
**published migrations** (`migratePayrollLifecycle` = v10 and `migratePayrollCommercialV15` = v15).
The runtime stores `sha256(String(migrationFunction))` per migration and refuses to open a database whose
migration source changed ("Migration v10 was modified after publication; checksum mismatch").
Effect: the zips delivered in rounds 1–3 open fresh databases fine (all tests pass) but would **fail to open
any existing customer database** created by an earlier version. Reproduced: create a DB with the original
v0.52.17 code, open it with the round-3 code → error.
- Both migration functions are restored byte-for-byte; the `?? 2` fix stays everywhere else.
- Verified: DB created by the original code opens with the current code, old invoices read normally.
- New guard `tools/migration-source-frozen-regression.js` (in the source suite) pins the sha256 of all 22
  published migrations; it fails on the round-3 zip and passes now.
- **Do not use the round 1–3 zips for real installs.** Use this one.

---

# Round 5 — release-hardening P0s that need no schema version (snapshot, checkout errors, returns, kitchen)

## Open-order price/tax snapshot (`setOpenSaleItemsTx`, `recalculateOpenSale`, split)
- Reproduced: product 100 @10 % added to a table, price → 150 and tax → 20 %, order re-saved → total became 180.
- A line already in the order keeps its unit price, tax rate, tax mode (inclusive/exclusive), tax profile, cost and
  uuid from the moment it was added. Only NEW lines read the product. Quantity changes on an existing line keep the
  snapshot price. A product deactivated after being added can still be saved on the existing line; it cannot be
  added as a new one.
- `recalculateOpenSale` (runs on close/merge/split) and split-bill now read the stored `tax_rate` / `tax_inclusive`
  instead of the current tax profile / organization mode.
- `tools/open-order-snapshot-regression.js`: 3 currencies × inclusive/exclusive × 0/5/10/15 %, hostile changes
  (price ×1.5, tax 20 %, opposite tax mode) between add and re-save / quantity change / close / split, mixed cart
  (old inclusive line + new exclusive line), ledger tax-payable delta, deactivated product. Fails on the old code.
- Not testable through the db API: tax-**profile** edits (no API links a product to a profile); the code path uses the
  stored `tax_profile_id`/rate exactly like the tested ones.

## Checkout / split error handling (`renderer/pages/table-order.js`)
- `checkout()` and `openSplitBill()` now catch a failed save (stock, permission, DB…): payment/split modal is NOT
  opened, the reason is shown, no stale total is adopted. Double-click on checkout saves once. Item-note autosave
  reports failures. UI split cash pre-check compares in minor units.
- Covered by `table-order-tax-regression.js` (26 checks now).

## Returns in integer minor units (`createReturnTx`)
- Replaced float `refundableUnitAmount` (unit refund × qty, unrounded, stored as REAL with many decimals).
  Net paid per line = (gross incl. tax) − (largest-remainder share of the discount pool: manual + bundle + loyalty).
  Partial returns are proportional and rounded; the LAST piece takes the exact remainder. Refund amount, payment,
  ledger entry and remaining refundable come from the same integers.
- Reproduced on the old code: after returning everything, refunds were 1 minor unit short of the invoice
  (172,942 vs 172,943). `tools/returns-minor-regression.js`: 1,300 random invoices / 3,400+ partial returns in
  0/2/3-decimal currencies; whole minor units, exact totals, never over-refunded, ledger balanced.
- `tools/v0.45.1-deep-audit.js` asserted the old function name; it now asserts `refundableAmountMinor`.

## Kitchen ticket de-duplication (table orders)
- Reproduced: every Save re-sent the entire order. New additive column `sale_items.kitchen_sent_qty`
  (`tryAddColumn`, no schema-version bump). `setOpenSaleItems` returns `kitchenDelta` (added / more / less /
  removed / note changed) and `kitchenFirst`; `core/kitchen-plan.js` decides none | full | delta; `main.js`
  marks quantities as sent ONLY after a successful print, so a failed print is retried with the same delta.
  Split clamps the sent quantity, merge carries it (no phantom cancel / re-print).
- Delta tickets gained a "تعديل ملاحظة" line for note-only changes.
- `tools/kitchen-dedupe-regression.js`: Save×3 → 1 ticket; add / +N / −N / remove / note; printer failure then
  retry; price change; split; merge (mutation-tested).
- Known limit: if the printer fails at the very moment a LINE IS REMOVED, that cancellation is not remembered
  (the removed row no longer exists).

## Still open from the hardening list (not done here)
Sales sync revision / conflict handling (updates to synced sales are never re-sent; receiver is
`ON CONFLICT DO NOTHING`), outbox for every mutation, tombstones, optimistic locking for open tables,
full randomized matrix (payments/sales), full-project currency sweep (`toFixed(2)`, `Math.round(x*100)/100`),
license / crash-recovery / offline test suites, and every Windows-only item (installer, signing, printers, LAN).

---

# Round 6 — final brief: expense invoices, cashier delegation, kitchen paper, returns list

Audit of the "final developer prompt" against the code: section 4 (operating-expense invoices) did not exist at
all; the network raster had no bottom trimming (section 3.4); the returns list showed every status, no customer
name and no payment method (section 1a). Sections 2 (font) were already in Sprint 2.

## Section 4 — operating expenses without goods
- New **expense invoice** type stored in `purchase_orders` (`invoice_type='expense'`, category, invoice date,
  reference, notes; `tryAddColumn`, no schema-version bump) + `expense_categories` table (`schema.sql`,
  `CREATE TABLE IF NOT EXISTS`). Ten default categories per branch (rent, electricity, water, internet/phone,
  maintenance, cleaning, transport, government fees, marketing, other) each with its own expense account
  (6200–6290); custom categories get 6300+ accounts.
- `createExpenseInvoice`: supplier + category + amount + date + reference + notes + cash | card | credit + amount
  paid now. **No items, no inventory movement, never receivable as goods.** Supplier balance/ledger, payment
  transaction, cash-out movement (open shift REQUIRED for cash), journal entry
  Dr category expense / Cr cash|bank / Cr accounts payable for the remainder. Audit rows for the invoice and its
  payment. Later payment = existing supplier debt payment (Dr AP / Cr cash|bank).
- Reports: `getOperatingExpensesSummary`, P&L now reports `operatingExpenses` separately from COGS and payroll and
  net profit is reduced by it; Suppliers page: "+ فاتورة مصروف" modal, type/category column, month KPI.
- Sync: the new fields travel with the purchase order and are stored by the receiving device.
- `tools/expense-invoice-regression.js` (3 currencies): scenarios 6/7/8 of the brief, card, partial payment,
  custom category, validation, audit, reports vs COGS/inventory, listing, sync. Old goods purchases unchanged.

## Section 3 — kitchen paper (network printers)
- `lib/network-print.js`: `trimRasterBottom` crops the raster below the last inked row (+8 dots margin) for the
  kitchen printer only; feed after content stays 1 line. `tools/network-print-trim-regression.js` (Electron stubbed).
- Not verifiable here: a real thermal printer at 58 / 80 mm — needs the Windows verification round.

## Section 1 — Returns area
- Invoice list: only `completed` and `partially_refunded`, customer name (LEFT JOIN — `sales` has no name column),
  payment method, "partially refunded" tag, server-side search (invoice / customer / time, `%` and `_` literal).
- **Cashier delegation ("علامة الصح")**: Users page has a "تعديل الفواتير" checkbox next to each cashier. Only the
  administrator can set it; a reason (3–300 chars) is mandatory and stored with who granted it and when; the
  tooltip explains why/what it allows. `users.can_modify_sales`, `modify_sales_granted_by/at/reason`
  (`tryAddColumn`). Enforced in `main.js` (`requireSalesModify`, read from the DB on every call so revocation is
  immediate) AND in the database (`modifyCompletedSaleItems`, `correctSalePaymentMethod` used to check the role
  only — a delegated cashier would have been rejected there). Delegated cashiers reach the Returns page (nav link
  + `guardPage allowIf`) but get NO refund button and refunds stay manager/admin. Every delegated modification
  is audited with the delegating administrator and the reason.
- `tools/sales-modify-delegation-regression.js` (32 checks).
- Known: a delegated cashier applying a discount above the cashier limit still needs the existing manager
  approval flow, which the Returns screen does not prompt for (the server error is shown).
- Known: the "original shift is closed" warning is shown after saving the payment correction, not before.
