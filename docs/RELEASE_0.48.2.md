# Nexora POS v0.48.2

## Engineering hardening

- Migration journal now records and verifies SHA-256 checksums for every published versioned migration.
- Schema journal integrity is validated at startup.
- Fixed-point money updates mirror back to legacy REAL columns for backward compatibility.
- Sync responses enforce monotonic cursors, branch ownership, timestamp sanity, and array/object envelope validation.
- Branch-owned remote rows without `branch_uuid` are rejected.
- Backups are written to a staged temporary file and atomically promoted only after validation.
- Added dedicated `sync-hardening-regression.js`.

## External release gates

Native SQLite/Electron runtime, Windows installer/signing, hardware printers/barcode, remote update delivery, and production remote-sync interoperability still require execution on a release machine.
