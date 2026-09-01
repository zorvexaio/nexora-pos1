# Nexora POS 0.7.0 — Global-Ready Foundation

## Added
- Organization profile: ISO country, IANA timezone, locale, ISO currency, minor units, tax mode, tax registration, fiscalization adapter metadata.
- Tax profiles per branch.
- Payment transaction ledger that stores payment method/currency/amount/provider reference without PAN or sensitive card data.
- Optional cash-in / cash-out movements bound to a cash session.
- Renderer hardening: CSP, blocked external navigation, blocked popup windows.
- Removed fake update-server URL from the production package configuration.

## Security/Compliance Position
- Security baseline aligned to OWASP ASVS 5.0 practices.
- Payment design avoids storing PAN/cardholder account data; certification/SAQ obligations remain deployment-specific.
- EU/other tax and e-invoicing rules are adapter-based because legal compliance is jurisdiction-specific.
- GS1 1D/2D barcode readiness remains supported through scanner input and weighted barcode processing; full GS1 Digital Link/AI coverage is a separate compatibility layer.

## Important
This release is a global-ready software foundation, not a legal certification for every country or payment processor. Country-specific fiscalization adapters, payment terminals and certification must be completed with the applicable local authority/provider.

## Dependency baseline (verified 22 Aug 2026)
- Electron 43.4.1
- better-sqlite3-multiple-ciphers 13.0.3
- electron-updater 6.8.9
- electron-builder 26.15.7
- @electron/rebuild 4.2.0
