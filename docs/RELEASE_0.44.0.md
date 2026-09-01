# Nexora POS 0.44.0 — Deep Reliability & Product Hardening

This release is a deliberate hardening pass after the 0.43 product-UX work.

## Fixed
- Prevented returns against open table orders; open orders have not deducted inventory yet.
- Preserved the tax profile when splitting a table order into a paid sale.
- Removed duplicate payment validation during table checkout.
- Validated cashier maximum-discount configuration (0–100%).
- Added strict product-input validation for price, cost, tax, opening stock, and minimum stock.

## Verification
- JavaScript syntax regression across the complete renderer/main/server/database surface.
- Security regression suite.
- Financial, authentication, legacy, release, and product-UX regressions.
- Release preflight.
