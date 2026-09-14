# Nexora POS v0.52.17 — Optional Cashier Category Images

## Changed

- Every category remains visible as a cashier tab, whether it has an image or not.
- Settings now presents **Choose image** for image-free categories, **Change image** for categories with an image, and **Remove image** when there is one to clear.
- Removing an image only clears the category's stored image reference; it does not delete the category or its products.
- After removal, the cashier tab falls back to the first letter of the category name.

## Verification

- `tools/category-image-removal-regression.js` verifies the remove action, NULL persistence, and cashier fallback.
