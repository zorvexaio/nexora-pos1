# Nexora POS v0.48.0 — Engineering Hardening Release

This release converts the 0.47.x foundation into a stronger commercial baseline without removing the existing POS workflows.

## Core changes

- Fixed-point money layer using integer minor units.
- Monetary shadow columns and compatibility triggers for legacy REAL writers.
- Atomic sale payment validation in minor units.
- Automatic sale accounting journal entries for settlement, revenue, delivery revenue, tax, COGS and inventory.
- Versioned schema migrations through schema version 8.
- Accounting accounts, journal entries, journal lines and accounting periods.
- Role/permission matrix with runtime permission checks.
- Sync outbox/inbox/conflict journals.
- Portable encrypted backup format protected by a user passphrase.
- Backup manifest hashes and verification tracking.
- Fiscalization adapter registry plus persistent fiscal document records.
- More stable device fingerprinting by removing hostname from the license identity.
- Electron 44.2.0 release target.
- Release metadata and sale-readiness gates aligned to 0.48.0.

## Important limitation

The generic fiscalization adapter is an integration framework, not country-specific electronic invoicing compliance. A production country adapter must be implemented and certified/tested against the applicable authority before claiming fiscal compliance in that jurisdiction.

Windows code signing, installer execution, native SQLite runtime, real printers, and external update/sync services remain release-machine verification items.
