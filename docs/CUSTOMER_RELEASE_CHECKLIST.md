# Nexora POS Customer Release Checklist

## Build machine

- Windows 10/11 x64
- Node.js >=22.12.0
- npm available
- Visual Studio Build Tools + C++ workload + Windows SDK
- Internet access to npm/Electron/GitHub
- Windows code-signing certificate configured (`CSC_LINK`/`WIN_CSC_LINK` and password as required)

## Build

```powershell
npm run setup
npm run test:release
powershell -NoProfile -ExecutionPolicy Bypass -File tools/windows-release/BUILD-WINDOWS.ps1
```

## Mandatory clean-machine acceptance

Install the generated `Nexora-POS-Setup-0.52.1.exe` on a clean Windows machine and verify:

- application startup and first-run bootstrap
- license activation and invalid-license rejection
- Arabic, English and Turkish input/rendering
- product creation, barcode scanning and sale completion
- cash drawer / printer path where hardware is available
- backup and restore
- offline sale and restart recovery
- payroll month open, payment, advance, repayment and final settlement
- report export and salary-slip print/PDF
- multi-device synchronization and conflict/error reporting
- automatic update from the published GitHub release

A release is NOT marked commercially verified until the clean-machine tests above have been executed and recorded on Windows.
