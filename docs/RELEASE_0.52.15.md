# Nexora POS v0.52.15

## Features
- Credit/deferred payment ("آجل — على الحساب") is now available on table/restaurant orders, matching the direct-checkout flow: requires a customer linked to the table and manager/admin approval, adds to the customer's debt ledger, and correctly updates due_amount and the accounting ledger. This was a known gap — table orders previously supported cash/card/mixed/store-credit only.
