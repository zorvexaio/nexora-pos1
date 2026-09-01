# Nexora POS v0.46.0 — Safe update foundation

## What changed

- Configured `electron-updater` to read production updates from `zorvexaio/nexora-pos` GitHub Releases.
- Kept automatic checking separate from downloading and installing: only an administrator can download or install an update.
- Disabled install-on-normal-quit. The explicit install action first writes and validates a complete `userData` snapshot.
- Added transactional database initialization, `schema_migrations`, and `PRAGMA user_version` as the migration contract for future releases.
- Added a static update-safety regression that is executed by release preflight.

## First rollout

Customers on 0.45.12 need the 0.46.0 installer once. Later releases can be received through the in-app updater, provided that the GitHub Release includes the generated `latest.yml`, installer, and blockmap files and is readable by the client devices.

## Verification

- `node --check main.js database/db.js renderer/pages/settings.js`
- `node tools/update-safety-regression.js`
- `node tools/release-metadata-regression.js`

See `UPDATES_AND_DATA_SAFETY.md` for publishing, recovery, and migration rules.
