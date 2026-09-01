# Vendor License Operations

## Signing key

The public verification key is embedded in the customer app. The private Ed25519 signing key is **not** included in the customer ZIP.

Use the separate vendor key file delivered with this release, protect it offline, and never commit it to source control.

## Issue a license

Set `NEXORA_LICENSE_PRIVATE_KEY_PATH` to the protected private-key path and run:

```bash
node tools/generate-license.js issue --customer "Customer Name" --fingerprint "ABCD-1234-..." --out customer.lic
```

The CLI now supports `NEXORA_LICENSE_PRIVATE_KEY_PATH` instead of requiring a private key to live inside the repository.

## Rotation

Do not rotate the key casually. Changing the embedded public key invalidates licenses issued under the previous key. Perform rotation only with an explicit migration strategy.
