# Nexora POS v0.48.4

## Security and release hardening

- Added a dedicated engineering audit command: `npm run test:audit`.
- Hardened the embedded/central sync server with request timeouts, JSON content-type enforcement, frame-embedding protection, and HTTPS HSTS response headers.
- Kept the validated dependency baseline: Electron 44.2.0, electron-builder 26.15.7, better-sqlite3-multiple-ciphers 13.0.3.
- Corrected stale release documentation that still described earlier versions and outdated synchronization coverage.

## Remaining production gates

- The native SQLite/Electron runtime must still be tested after `npm ci`/native rebuild on the real release machine.
- Windows installer execution, printer/barcode hardware, Windows code signing, updater delivery, and production remote-sync interoperability require the actual deployment environment.
- Country-specific fiscalization/e-invoicing and payment-terminal certification remain integration and legal-compliance work, not generic POS features.
