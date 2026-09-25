# Log triage fixes (on v0.52.17)

1. language switch before login / for non-admin: renderer/i18n.js now stores the choice per-device
   (localStorage `nexora_ui_lang`) and only calls `language:set` when the signed-in user is admin.
   The admin-only rule in main.js is unchanged (tools/v0.20-regression.js still passes).
2. shift screen: renderer/pages/shift.js catches the permission error from `shift:summary`
   (open shift belongs to another employee) and shows a toast instead of an unhandled rejection.
3. tools/v0.37-regression.js: stale check expected `border-bottom: 3px solid var(--brand-gold)` on .topbar;
   the design intentionally became 1px border + gold box-shadow line, so the test now checks that.

4. Receipt readability + offers: renderer/style.css (appended block) enlarges receipt fonts (80mm: items 20px bold, rows 19px,
   total 26px; 58mm scaled down; kitchen ticket ~19-22px too) and gives the offer box a double border with a large title.
   renderer/receipt.js now also prints "offer price" and "you saved" lines inside each offer box (new i18n keys
   receipt.offerPrice / receipt.offerSaved in ar/tr/en).

5. Customer receipt (kitchen ticket untouched, it was already fine): renderer/receipt.js now prints each
   item on one compact line (name + total together, unit price only shown in parentheses when qty>1)
   instead of two lines, roughly halving the height of long orders. Offer items get a small 🎁 badge
   inline on their normal line instead of being repeated inside a big boxed block; the block is replaced
   by a single "🎁 offer name — you saved X" line. Fonts were NOT reduced (kept the earlier enlargement).
   tools/bundle-offer-print-regression.js assertions updated to match the new markup.
6. POS product grid (renderer/pos.js + style.css): removed the colored icon/letter square from every
   product and offer card (it often fell back to a single random letter and crowded out the name on
   small touchscreens). The product name is now the dominant element, bold ~15.5px, up to 3 lines.
   Offer cards keep only the small "🎁 عرض" corner badge. The table-order screen already showed plain
   names with no icons, so it needed no change.

7. NEW: "الكاشير السريع" (Quick Cashier) — a full alternate, touch-only sales screen for shops with
   no keyboard (e.g. a grocery/supermarket cashier who can't type a search term):
   - renderer/pages/quick-cashier.html + quick-cashier.js: a big on-screen numeric keypad to type a
     barcode/SKU by hand (calls the existing products.list({search}) exact-match lookup — no new
     backend search needed), a quantity stepper, and a picture-first product grid (falls back to the
     plain text tile from fix #6 above for items with no image) that adds to cart on a single tap.
     A physical barcode scanner still works on the same code field (inputmode="none" suppresses the
     Windows on-screen keyboard on touch, but real keystrokes/Enter from a scanner still land in it).
   - Checkout is its own numpad-driven overlay (Cash/Card, change calculation) — no separate keyboard
     needed there either. Sale creation reuses the existing sale:create IPC with a minimal payload
     (items + paymentMethod + amounts); price/tax are computed server-side from the DB as already,
     so no bundles/discounts/credit complexity was needed for this simplified screen.
   - New per-branch setting `quick_cashier_enabled` (off by default) in database/db.js + IPC
     `posMode:quickCashierEnabled` (main.js/preload.js) + a toggle on the Settings page — admin can
     show/hide the "الكاشير السريع" nav link per shop. common.js hides/shows any
     `[data-setting="quickCashier"]` element on every page based on this setting.
   - Added the nav link + i18n keys (ar/tr/en) to all 15 pages.
   - Not yet covered (documented, not built — flag if the client needs it): weighted/PLU barcode
     lookup (products.resolveWeightedBarcode exists but isn't wired into this screen), and a way to
     mark specific products as "show on quick-cashier grid" instead of showing every product with
     an image — currently ALL active top-level products with an image_path appear as picture tiles.

8. Quick Cashier grid is now opt-in per product (not "show everything with an image"): new
   products.quick_cashier_visible column (default 0), a checkbox "إظهار كصورة في شاشة الكاشير
   السريع" on the product edit form (products.html/js), and listProducts() now supports
   filters.quickCashierOnly to return only flagged products. quick-cashier.js was updated to request
   quickCashierOnly instead of topLevelOnly. Empty state now tells the manager exactly where to go
   ("Products" page → enable the toggle) instead of showing nothing with no explanation.

9. Fixes after an external code review of the Quick Cashier feature (all verified against the actual
   source, not taken on faith):
   - P0 FIXED: Quick Cashier's total no longer diverges from the tax-aware total createSaleTx actually
     charges. Added db.quoteSale() + IPC `sale:quote` (returns the exact same priceItemsFromDatabase
     result used at sale creation). quick-cashier.js now fetches a fresh server quote when opening the
     payment screen and uses that number — not a local price×qty sum — for the displayed total, the
     cash/change math, and the amount actually sent to sale:create.
   - Code-entry resolver hardened: addByCode() now requires an EXACT barcode/SKU match first, then
     GS1, then weighted/PLU (products.resolveGs1Barcode / resolveWeightedBarcode, same resolvers
     pos.js uses) — never falls back to a fuzzy name-LIKE match like a plain products.list search
     could, which risked adding the wrong item from a numeric code field.
   - Weighted items (fractional kg quantities) now work via the barcode-scale resolver; cart quantity
     is no longer forced to a whole number for these.
   - Payment keypad now includes a decimal-point key (only shown when the branch currency has decimal
     places at all — hidden for a 0-decimal currency).
   - Every amount on the page (price tiles, cart total, payment total/change) now formats to the
     branch's real currency_minor_unit instead of a hardcoded 2 decimals.
   - printOutcome from sale:create is now surfaced (red toast) if the receipt or kitchen ticket failed
     to print automatically — previously silently ignored on this screen only.
   - Code field is focused on page load and refocused after every add/sale/payment-close so a physical
     barcode scanner (keyboard-emulation) works immediately without a manual tap first.
   - Backend hardening (affects the whole app, not just this screen): priceItemsFromDatabase now
     requires the product to be active (p.is_active=1) instead of silently pricing a soft-deleted
     product; createSaleTx now rejects an empty-items sale explicitly instead of silently accepting a
     zero-item/zero-total sale; the sale_created audit log now records the server-computed grand total
     (createSaleTx's return value now includes it) instead of trusting whatever total the renderer
     happened to send (which Quick Cashier never sent at all, so it was logging `undefined`).
   - NOT changed, deliberately: CURRENT_SCHEMA_VERSION / the versionedMigrations array. This project's
     established pattern (see is_weighted/plu_code before it) is that a simple additive tryAddColumn
     inside runMigrations() does not bump the formal schema version; that mechanism is reserved for
     migrations with real data-transformation logic (see migrateInventoryAccountCorrectionV23 etc.).
     Bumping it without a matching versionedMigrations entry broke tools/migration-chain-regression.js
     — reverted after confirming the mismatch.
   - Could not verify in this sandbox (no network, no native better-sqlite3 build, no real Windows/
     Electron runtime): an actual `npm install && npm start` launch, and an in-place update test from a
     previously installed version. Please run both on your machine before shipping this to a customer.
