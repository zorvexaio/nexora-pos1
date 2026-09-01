# Nexora POS v0.40.4

- Removed test-only SQLite artifact and stale build verification log from distributable source archives.
- Release archive tooling now excludes test/build artifacts even if they are accidentally present in the tree.
- Release preflight now fails closed on root test/build artifacts.
- Renderer CSP `connect-src` is now consistently restricted to `'self'`, matching the runtime CSP; the renderer uses IPC rather than direct network requests.
