# Nexora POS 0.29.0

## Critical fix
- Fixed the first-run login/bootstrap flow by explicitly allowing the `auth:bootstrapInfo` IPC channel before authentication.
- The renderer requested bootstrap information before a user session existed, while the default-deny IPC gate was rejecting that channel.
- The pre-auth channel is narrowly scoped and returns only the one-time bootstrap username and temporary password when setup is pending.
- `db.clearBootstrapAdminInfo()` continues to clear the pending bootstrap secret after successful login.

## Verification
- 68 JavaScript files syntax-checked.
- Full static/security/financial/payroll/sync/input regression suite: PASS.
- v0.29 regression: 5/5 PASS.
- SQLite schema validation and foreign-key checks remain PASS from the current release line.

## Known build-environment limitation
- Native Electron/SQLite dependency installation and signed installer generation still require a real release build environment.
