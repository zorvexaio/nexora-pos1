# Nexora POS v0.52.16 — Quick Quantity Safety Fix

## Fixed

- The quick-quantity input now visibly confirms the next product addition as `سيُضاف × N` (translated for Turkish and English).
- Focusing the input selects its default value so a cashier can replace `1` in one keystroke.
- Only a successful cart addition resets the input to `1`; rejected input remains visible and receives focus, so it cannot become a hidden carried-over quantity.
- Whole quantities above `9,999`, malformed entries, and additions that would push an existing product line above `9,999` are rejected before the cart changes.
- The same line ceiling is enforced for quantity increment controls and weighted-product accumulation.

## Verification

- `tools/quantity-buffer-regression.js` unit-tests Western, Arabic-Indic, and Persian digits; malformed input; the maximum; and accumulation boundaries.
- The engineering source suite includes that regression before the existing project checks.

## Scope

This source release does not claim validation of the unsigned Windows installer, a production update endpoint, physical peripherals, or the native SQLite runtime when its dependency is not installed.
