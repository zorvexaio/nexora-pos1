# Nexora POS v0.20.0

## Critical cash reconciliation fix

Cash drawer expected value now counts retained cash (`cash_amount - change_due`) for cash sales. A sale of 70 with 100 received and 30 change contributes 70 to expected cash, not 100.

## IPC hardening

Language, currency and printing settings now require an authenticated session; language changes require administrator access.

## Verification

Added `tools/v0.20-regression.js` and updated the full check script.
