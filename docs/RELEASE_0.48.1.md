# Nexora POS v0.48.1 — Financial Precision Hardening

## Purpose
Patch release focused on deterministic monetary arithmetic and release consistency.

## Changes
- Monetary decimal parsing is exact for decimal strings; it no longer relies on binary floating-point multiplication for conversion to minor units.
- Minor-unit addition/subtraction uses bounded integer arithmetic and rejects unsafe overflow.
- Journal lines require safe integer minor-unit amounts.
- Added dedicated money regression coverage for rounding, negatives, zero-decimal currencies, overflow and percentage/tax calculations.
- `package.json` and `package-lock.json` are aligned at `0.48.1`.

## Verification
- Static JavaScript syntax checks.
- v0.48 engineering regression.
- Money regression.
- Release metadata and preflight checks.

Native Electron/SQLite runtime validation remains a Windows build-stage requirement and must be executed on the target build environment before public distribution.
