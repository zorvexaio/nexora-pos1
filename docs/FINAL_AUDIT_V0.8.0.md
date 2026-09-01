# Nexora POS v0.8.0 — Final Deep Audit

## Findings fixed in this cycle

1. First-install fixed credential `admin/admin123` removed; first-run password is random and temporary.
2. Password-login brute-force guard added (5 failures / 60 seconds per renderer sender).
3. Store credit separated from customer debt with a dedicated balance field.
4. Store-credit returns now increase store credit; they no longer create a negative debt balance that could not be redeemed.
5. Store-credit can be used as a sale payment method and is represented in the payment ledger.
6. Customer ledger rows now have UUID/branch/sync metadata; synchronized ledger events can rebuild debt instead of treating one mutable balance as the sole source of truth.
7. Central sync distinguishes global entities from branch-owned entities.
8. Cross-branch UUID collisions are rejected instead of silently overwriting another branch's record.
9. Global synchronization is explicit; branch-owned records remain branch-filtered.

## Verification in this environment

- 46 JavaScript files syntax-checked: PASS
- Security regression: PASS
- Deep regression: PASS (15 checks)
- Global financial regression: PASS (10 checks)
- Payroll regression: PASS
- Auth bootstrap regression: PASS (8 checks)
- GS1 regression: PASS
- IPC auth regression: PASS (11/11)

## Important boundary

The package is software-hardening / global-readiness work. PCI DSS validation, local tax-fiscalization certification, payment-acquirer certification, OS code signing, hardware certification, and country-specific legal compliance still require the actual deployment environment and external assessors/providers.
