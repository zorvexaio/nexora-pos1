# Nexora POS v0.26.0 — Production Licensing & Sync Hardening

## Security hardening

- Embedded the real Ed25519 vendor public key in `licensing/license.js`.
- Added a real end-to-end license regression test: valid signatures are accepted and tampered licenses are rejected.
- Authentication and operational IPC now re-check local license validity, so a license that expires or is locally revoked cannot continue operating solely because a session was already open.
- Kept the signing private key outside the customer application ZIP.
- `tools/generate-license.js` now supports `NEXORA_LICENSE_PRIVATE_KEY_PATH` and `NEXORA_LICENSE_PUBLIC_KEY_PATH` so signing can use a secure build secret or secret store rather than a repository file.

## Sync hardening

- Standalone plaintext HTTP sync binds to `127.0.0.1` by default.
- Non-loopback plaintext binding is rejected unless `POS_SYNC_ALLOW_INSECURE=1` is explicitly set.
- TLS-backed embedded LAN sync remains supported.
- Sync responses include `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, and `Referrer-Policy: no-referrer`.

## Vendor key handling

The customer distribution does not contain the signing private key. The build workspace contains a separate vendor key file. Protect it like any production code-signing credential and do not commit or ship it.
