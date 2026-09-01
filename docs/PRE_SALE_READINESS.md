# Nexora POS — Pre-Sale Readiness

## What is now gated inside the project

- Version and release metadata consistency.
- Electron sandbox, context isolation, disabled Node integration, navigation/window blocking, CSP and IPC sender validation.
- Renderer JavaScript syntax validation.
- Database presence for sales, payments, returns, inventory movements, shifts and customer/store-credit ledgers.
- Backup validation and restore rollback protection.
- Printing load/timeout failure handling.
- Payment currency validation.
- Sync activation requires a branch access token.
- Security, financial, authentication and historical regression suites.
- Release preflight and release archive integrity.

## Required on the real Windows release machine

These cannot be honestly certified from a Linux build environment and are intentionally treated as external release gates:

1. Native `better-sqlite3-multiple-ciphers` rebuild with the exact Electron runtime.
2. Real Windows NSIS installer build and install/uninstall test.
3. Clean-machine first-run test, license activation, bootstrap login, sale, return, backup/restore.
4. Real receipt/kitchen printer tests with the target printer drivers.
5. Windows code signing using the vendor's certificate.
6. If automatic updates are sold as a feature, configure and test a real update provider before enabling it.
7. If remote sync is sold, deploy the real HTTPS sync endpoint, branch keys and TLS policy, then test push/pull across two real installations.

The source package deliberately does not pretend these external dependencies are configured when they are not.
