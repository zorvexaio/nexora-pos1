# Release Artifact Policy

A source-release ZIP is a reproducible project source package, not a preinstalled `node_modules` bundle.

The release archive MUST NOT contain `node_modules/`, `dist/`, `.git/`, test databases, private signing keys, or stale versioned snapshots.

After extracting the ZIP on a clean machine:

```powershell
npm ci --no-audit --no-fund
npm run rebuild
npm run verify:native
npm run test:release
```

`npm run rebuild` is mandatory because `better-sqlite3-multiple-ciphers` contains native code that must match the installed Electron runtime and the target platform.

A commercial Windows installer MUST be code-signed. The Windows build script rejects a release build when signing configuration is absent.
