# Nexora POS central synchronization

The desktop app is offline-first. It writes locally, then `POST`s JSON to `https://your-host/api/v1/pos/sync` when the manager selects **Sync now**.

Run the included reference server on a protected host:

```powershell
$env:PORT = '8787'
node server/sync-server.js
```

Put it behind a TLS reverse proxy (Nginx, Caddy, Cloudflare, etc.). Never expose the reference server directly to the public internet without HTTPS and backups.

**Authentication — one key per branch, not a shared token.** Each branch authenticates with its own secret, registered on the server ahead of time:

```powershell
node tools/manage-branch-keys.js add --branch <branch-uuid> --label "Downtown branch"
```

This prints a one-time secret — paste it into that branch's Settings screen ("رمز الوصول"), alongside the branch's own UUID (also shown there, under "معرّف هذا الفرع"). Secrets are stored server-side only as salted `scrypt` hashes, never in plaintext. Revoke a compromised or closed branch with `node tools/manage-branch-keys.js revoke --branch <branch-uuid>`; list registered branches with `node tools/manage-branch-keys.js list`. A branch whose key is missing or revoked gets `401 Unauthorized`, and the server refuses to store records under a branch UUID that doesn't match the authenticated key — one branch cannot write data claiming to be another branch.

The reference server also applies a basic per-IP rate limit (`POS_SYNC_RATE_LIMIT` requests/minute, default 30) to blunt brute-force and abuse. See `server/.env.example` for all environment variables.

Request shape: `{ branch, cursor, changes }` with `Authorization: Bearer <branch-secret>`; response shape: `{ cursor, changes }`. `changes` holds `categories`, `products`, `restaurant_tables`, `customers`, `inventory`, `sales` (including sale-items and payment identity), `payments`, `cash_movements`, `shifts`, `inventory_movements`, `suppliers`, `supplier_ledger`, `purchase_orders`, `returns`, `bundles`, `customer_ledger`, and `tax_profiles`. The client applies these in dependency order so return payments, purchase ledgers, tax references, and inventory deltas resolve correctly. Records use immutable UUIDs; conflict resolution differs by entity:

- **`categories`, `products`, `customers`, `suppliers`, `bundles`** — shared/global data. Last-write-wins using `updated_at`. Any branch may edit these and the change propagates to all branches.
- **`sales`** — append-only by invoice UUID, never overwritten once created.
- **`purchase_orders`, `returns`** — owned by exactly one branch (the branch that created them). Other branches receive a **read-only mirror** for visibility/reporting only; the app itself (not just the UI) refuses to let a branch "receive" a purchase order or otherwise mutate a record it doesn't own — `db.js`'s `receivePurchaseOrder()` throws if `purchase_order.branch_id` doesn't match the calling branch, and `returns` have no update path at all (append-only by design).

The reference server is intentionally small so it can be replaced by an existing ERP/API with the same contract (keep the per-branch auth model and the ownership rules above if you do).

Inventory in different branches stays separated by branch UUID. The current desktop UI keeps operating even if the server is unavailable; unsent records remain marked for the next sync.
