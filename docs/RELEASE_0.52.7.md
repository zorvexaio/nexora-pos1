# Nexora POS v0.52.7

## Fixes and changes

- Fixed stale hardcoded version checks in release test tooling (payroll-termination-regression, migration-chain-regression, release-acceptance).
- Registered migration v19 (payroll-accrual) in the immutable migration chain list.
- Fixed false-positive legacy license path check on case-insensitive filesystems.
- Moved license signing private key out of the tracked project source tree.

## Validation

- Full check suite: PASS.
- Engineering/native regression: PASS.
- Release acceptance (non-commercial): PASS.
- Sale readiness: PASS.
