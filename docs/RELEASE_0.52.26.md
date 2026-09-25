# Nexora POS v0.52.26 — Version/Test Sync Fix

## Changed

- No functional/application changes in this release. This bump reconciles the
  release version number across `package.json`, `package-lock.json`, `VERSION`,
  and `docs/VERSION.txt`, which had drifted out of sync from the prior
  `0.52.17` tag.

## Fixed

- `tools/v0.41.3-regression.js`: the `product image path is escaped` check
  required the exact call `escapeHtml(p.image_path || PLACEHOLDER_IMG)`, but
  `renderer/pages/products.js` correctly uses `escAttr(...)` for that
  `src="..."` attribute context (it also escapes quote characters, which
  `escapeHtml` alone does not). The regression regex was stale from before
  `escAttr` was introduced and never updated. The regex now accepts either
  `escapeHtml(...)` or `escAttr(...)` for that call, since `escAttr` is the
  correct/safer choice for attribute-value contexts. No production code was
  changed for this fix — only the outdated test assertion.

## Verification

- `tools/v0.41.3-regression.js` passes, including `product image path is escaped`.
- `tools/v0.41.9-regression.js` passes (`package.json`/`package-lock.json`/`VERSION`
  version sync).
- Full `npm run check` chain passes with this release guide present.
