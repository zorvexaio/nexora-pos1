# Nexora License Signing Key Setup

A real Ed25519 vendor keypair was generated for this release. The public key is embedded in `licensing/license.js`.

The private signing key is NOT included in the customer application ZIP. It is supplied separately to the vendor as `NEXORA_VENDOR_PRIVATE_KEY.pem`.

Protect that file like a production signing credential. Do not commit it or ship it to customers.

The license CLI expects `tools/private-key.pem`; place a protected copy there on the vendor/build machine when issuing licenses.

Changing the embedded public key invalidates previously issued licenses, so key rotation must be planned and migrated explicitly.
