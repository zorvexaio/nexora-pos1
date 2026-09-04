# Dependency Freshness — 2026-09-04

Checked against npm/Electron release pages on 2026-09-04.

| Package | Project pin | Finding |
|---|---:|---|
| electron | 44.2.0 | Current stable release observed 2026-09-04 |
| better-sqlite3-multiple-ciphers | 13.0.3 | Current stable release observed |
| electron-updater | 6.8.9 | Current npm latest observed |
| electron-builder | 26.15.7 | Pinned on 26.x; not force-upgraded because builder upgrades must be validated together with the Windows build toolchain |

> This document is a freshness snapshot, not a CVE scan. Run `npm run test:dependencies` on a networked build machine to execute the project's real `npm audit --audit-level=high`.
