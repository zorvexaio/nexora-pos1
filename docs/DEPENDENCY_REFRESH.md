# Dependency refresh

The project baseline was updated to stable Electron 43.4.0, electron-builder 26.15.7, and better-sqlite3-multiple-ciphers 13.0.3 as of 2026-08-22.

The previous pnpm lockfile resolved obsolete versions, so it was removed rather than shipped in a misleading state. In a connected build environment, run `corepack pnpm install` to create a fresh lockfile, then `corepack pnpm run check` and the installer build.
