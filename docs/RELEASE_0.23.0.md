# Nexora POS v0.23.0

## Final hardening
- Fixed remote inventory delta application: a newly received movement UUID is always applied to quantity exactly once.
- Remote inventory `unit_cost` updates no longer overwrite a newer local cost.
- Remote customer-balance recalculation no longer touches `updated_at`, preventing synthetic sync churn.
- Added v0.23 regression guard.
