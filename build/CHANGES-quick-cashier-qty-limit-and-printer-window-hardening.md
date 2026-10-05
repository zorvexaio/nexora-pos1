# Quick Cashier quantity limit fix + hardening (qty limit, printer window, escAttr)

## 1. Quick Cashier quantity cap corrected (999 → 9999)
- `renderer/pages/quick-cashier.js`: the per-line quantity clamp was `Math.min(999, ...)`,
  which did not match the intended business rule of 9,999. Changed to `Math.min(9999, ...)`.

## 2. Backend now enforces the same limit (it previously did not at all)
- `database/db.js`, `priceItemsFromDatabase()`: single choke point for `createSaleTx` (all sale
  creation, including Quick Cashier) and sale-modification (`modifyCompletedSaleItems`).
- Previously no upper bound on `item.quantity` server-side — only the renderer clamped it.
- Added `MAX_LINE_QUANTITY = 9999` (see #5 below for where it now lives); over-limit requests
  throw `"الكمية المطلوبة تتجاوز الحد الأقصى المسموح (9999)."` before any pricing/inventory work.

## 3. Network printer test window — explicit webPreferences hardening
- `main.js`, `printing:testNetworkPrinter`: the test-print `BrowserWindow` only declared
  `sandbox: true`, relying on Electron defaults for `contextIsolation`/`nodeIntegration`.
- Now explicitly sets `contextIsolation: true, nodeIntegration: false, sandbox: true`, matching
  every other non-preload print window in the app.

## 4. Quick Cashier cart +/− buttons and repeat-scan now also respect the 9999 cap
- `renderer/pages/quick-cashier.js`: `addProductToCart()`, the cart-item `+` button, and repeated
  scans of an already-cart product had no upper bound — only the top quantity keypad (`setQty`)
  was clamped. Unified all four call sites on one `const MAX_QTY = 9999` at the top of the file.

## 5. P0: table orders had no server-side quantity cap at all (separate code path)
- `setOpenSaleItemsTx()` (table/restaurant open orders, `table-order.js`) is a code path entirely
  separate from `priceItemsFromDatabase()`, and only checked `quantity finite && quantity > 0` —
  no upper bound. `table-order.js`'s `addToCart`/`changeQty` incremented with no clamp either.
- Fixed: hoisted `MAX_LINE_QUANTITY = 9999` to a module-level constant in `database/db.js` (was
  local to `priceItemsFromDatabase`), added the same check inside `setOpenSaleItemsTx()`. Added
  the matching `MAX_QTY = 9999` to `table-order.js`, applied to `addToCart()` and `changeQty()`.

## 6. P1: sale-modification screen (returns.js) had no quantity cap in the UI either
- `renderer/pages/returns.js`: `addModifyProduct()` accumulated with `x.quantity += 1` (no
  clamp), and the quantity `<input type="number">` had `min="0"` with no `max`.
- Fixed: added `MAX_QTY = 9999`, clamped `addModifyProduct()`, added `max="${MAX_QTY}"` to the
  input, and clamped its `change` handler to the same cap. `addBundle()` already routes through
  `addModifyProduct()`, so it's covered automatically.

With #4–#6, all four quantity-entry surfaces (main POS, Quick Cashier, table orders, and
sale-modification) clamp consistently in the UI, on top of the server-side cap that now covers
every path (`priceItemsFromDatabase` and `setOpenSaleItemsTx`, sharing one `MAX_LINE_QUANTITY`
module constant in `database/db.js`).

## 7. UX toast when a quantity clamp is actually hit (Quick Cashier + table orders)
- Both files now call a small `notifyQtyMax()` helper (existing translation key
  `pos.qtyAccumulationMaximum`, same pattern already used in `pos.js`) whenever a clamp actually
  caps the value — quantity keypad, `+` cart-item stepper, and `addProductToCart`/`addToCart` on
  a repeated scan. Silent when the clamp isn't triggered, so normal use is unaffected.

## 8. escAttr — safe escaping inside HTML attribute values
`escapeHtml()` only guarantees safety inside text nodes: it doesn't escape `"`/`'`, needed to
stay safely inside an attribute value like `src="${...}"`. Added `escAttr()` next to it in
`renderer/common.js` (escapeHtml + quote escaping) and switched every attribute-context call site
to use it, leaving text-node call sites on `escapeHtml()` unchanged:
- `renderer/pos.js` — datalist `<option value>`, offers/category image `src`, table-row `title`
- `renderer/receipt.js` — receipt logo `src`
- `renderer/pages/accounting.js` — `data-reopen`/`data-lock`, manual journal line memo `value`
- `renderer/pages/audit.js` — filter `<option value>` (×2)
- `renderer/pages/products.js` — product thumbnail `src`
- `renderer/pages/quick-cashier.js` — product tile `src`
- `renderer/pages/settings.js` — product/category thumbnail `src` (×2)
- `renderer/pages/users.js` — delegation badge/label `title` (×2)

Risk was low in every case (system-controlled paths or admin-entered text, not raw untrusted
input reflected from outside the app), but this closes the gap defensively.

## Verification done here
- `node -c` syntax check passed on every edited file.
- `npm run test:engineering:source` re-run after each round of changes: full PASS every time,
  same pre-existing warnings only (native SQLite module not installed in this sandbox, Windows
  code signing not configured — both expected and unrelated to these fixes).
- Native/DB-backed regression (`npm run test:native`) and the printer/Windows/hardware acceptance
  steps still need to run on a real Windows machine — this environment cannot build the native
  SQLite cipher module, same limitation noted in every prior review.
- LAN sync/TLS/pairing was reviewed line-by-line in this round (see chat discussion): TOFU
  certificate pinning read from the live TLS socket, an 8-digit crypto-random pairing code valid
  5 minutes with a 60-req/min per-IP rate limit (≈300 max guesses out of ~90M possible codes per
  window), timing-safe code comparison, scrypt-hashed branch secrets, and a hard refusal to bind
  plaintext HTTP to a non-loopback address. No fix was needed there.

## Not yet acted on (flagged by review, still open)
- Manager PIN attempt counter is global/in-memory, not per-branch/per-user in the database — a
  cashier could theoretically exhaust attempts and lock approvals for everyone until restart.
  Low risk for a single local POS install; worth revisiting if multi-terminal contention becomes
  an issue.
- Not yet reviewed: `licensing/license.js` signature/field/revocation path line-by-line, the
  sync-server push/pull conflict-resolution logic itself, CSV/Excel export formula-injection,
  backup/restore path validation (zip-slip) on `backup:restorePortable` specifically, split-table
  inventory edge cases, login password-attempt throttling depth.
