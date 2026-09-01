# Nexora POS — Windows Customer Release

## Supported build target

Windows 10/11 x64.

## Build requirements

- Node.js 22.x or newer
- npm 10.x or newer
- Internet access to the npm registry
- Visual Studio Build Tools / Windows SDK suitable for the native SQLite module

## One-command release

From the project root, run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/windows-release/BUILD-WINDOWS.ps1
```

Or double-click:

`tools/windows-release/BUILD-WINDOWS.cmd`

The script installs the pinned dependencies, rebuilds native SQLite, runs the full verification suite, runs release preflight, and builds the signed-by-configuration NSIS installer through Electron Builder.

The resulting installer is written under `dist/` and receives a matching `.sha256` file.

## Customer acceptance test

Before delivery, install the generated EXE on a clean Windows machine and verify first-run bootstrap, license activation, Arabic/English input, receipt printing, barcode scanning, backup/restore, offline sale, and synchronization.

Never ship the vendor private signing key with the installer or source package.
