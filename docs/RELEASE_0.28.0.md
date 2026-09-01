# Nexora POS v0.28.0 — Final Hardening

## Security
- Remote synchronization requires HTTPS; plaintext HTTP is limited to loopback.
- Sync client independently enforces the same network transport policy.
- All renderer HTML pages carry a restrictive Content Security Policy.
- Theme mutation requires authentication.
- File image selection requires manager/admin authorization.

## Release
- Release preflight now checks CSP coverage and the remote-sync HTTPS policy.
- Version is pinned to 0.28.0.
