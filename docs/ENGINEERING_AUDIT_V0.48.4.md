# Nexora POS v0.50.0 — Engineering Audit

## Verdict

**Codebase status: strong production candidate, but not yet a universally deployable commercial release.**

The project has a mature offline-first POS core, encrypted SQLite storage, role-based IPC authorization, branch-scoped synchronization, backup/restore protection, payroll lifecycle controls, returns, purchasing, bundles, weighted/GS1 barcode handling, thermal/network printing, reporting exports, licensing, and Arabic/Turkish/English foundations.

The v0.48.4 engineering update adds network hardening to the sync server and corrects release documentation drift.

## Verified in this environment

- JavaScript syntax: **128 files PASS**.
- Full static regression: **PASS**.
- Release preflight: **PASS**.
- Engineering audit: **PASS**.
- Money regression, sync hardening, payroll lifecycle, global financial, authentication bootstrap, update safety, Windows structure, client-event hardening and LAN key persistence source checks: **PASS**.

## Environment limitation

The uploaded source tree does not contain `node_modules`, so the native SQLite runtime package could not be loaded in this environment. Consequently, Electron/SQLite runtime tests and real printer/native installer execution must be completed on the release machine after installing dependencies and rebuilding native modules.

Windows code signing is also an external release requirement; no signing certificate is bundled or configured in the source tree.

## High-priority product gaps to plan next

### 1. Country-specific fiscalization/e-invoicing
The project exposes a fiscalization adapter boundary, but the shipped provider is only the generic adapter. Before selling as tax-compliant software in a specific country, implement and certify the applicable authority/provider integration.

### 2. Payment terminal integration
The POS records card/payment metadata, but a real acquiring/POS-terminal connector requires a provider-specific integration, certification and secure key-management process.

### 3. Inventory transfer workflow
For true multi-branch operations, add a first-class transfer document: draft → shipped → received, with source/destination branch, immutable transfer lines, in-transit quantities, receiving confirmation, audit trail and conflict-safe synchronization.

### 4. Accounting UI
The accounting engine and journal validation exist in the backend, but there is no dedicated accounting screen in the current renderer. If the product is positioned as a POS rather than ERP, this can remain an optional module.

### 5. Sync policy for payroll/accounting
Payroll and accounting are intentionally not current sync entities. If employees or accounting books must be shared centrally, define ownership and conflict policy first; do not simply add them to the sync payload.

### 6. Product-master ownership
Categories/products are global sync entities while operational records are branch-owned. A commercial multi-branch deployment should explicitly define which branch or central catalog owns product-master edits and how concurrent edits are resolved.

### 7. Automated integration/CI release gate
The current project has extensive regression scripts, but the final gate should run on a real Windows runner with native SQLite, Electron packaging, installer execution, printer smoke tests, updater verification and signed artifacts.

## Medium-priority improvements

- Replace remaining dynamic `alert()`/`confirm()` flows with a consistent localized modal/toast system.
- Finish systematic localization of dynamically generated table/status/error text instead of relying on static translation passes.
- Add configurable backup retention and an optional off-device backup destination.
- Add stock reservation/in-transit reporting once branch transfers are implemented.
- Add stronger observability for sync failures: last successful cursor, retry count, conflict count and actionable diagnostics.
- Add automated database integrity checks (`foreign_key_check` and application-level invariants) to the maintenance/diagnostic screen.

## v0.50.0 engineering changes

- Added multi-branch inventory transfer workflow with receipt events and safe cancellation rules.
- Added server-side routing/ownership validation for cross-branch transfer entities.
- Added transfer UI and branch directory configuration.

## v0.48.4 changes

- Sync server now enforces a request timeout.
- Sync and pairing POST endpoints require JSON content type.
- Sync responses include anti-framing/CSP headers.
- HTTPS responses advertise HSTS.
- Added `npm run test:audit`.
- Updated stale version/dependency/synchronization documentation.

## Recommended release sequence

1. `npm ci` on the Windows release machine.
2. `npm run rebuild` for native SQLite compatibility.
3. Run `npm run test:static`, `npm run test:audit`, and the complete engineering/security suite.
4. Build the signed Windows installer.
5. Install it on a clean Windows machine and execute sales, returns, cash session, payroll, backup/restore, LAN pairing/sync and printer smoke tests.
6. Test upgrade from a real v0.48.3 database and verify migration/backups.
7. Test updater delivery from the production GitHub release channel.
8. Only then publish v0.48.4 commercially.
