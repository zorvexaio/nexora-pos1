# Log triage fixes (on v0.52.17)

1. language switch before login / for non-admin: renderer/i18n.js now stores the choice per-device
   (localStorage `nexora_ui_lang`) and only calls `language:set` when the signed-in user is admin.
   The admin-only rule in main.js is unchanged (tools/v0.20-regression.js still passes).
2. shift screen: renderer/pages/shift.js catches the permission error from `shift:summary`
   (open shift belongs to another employee) and shows a toast instead of an unhandled rejection.
3. tools/v0.37-regression.js: stale check expected `border-bottom: 3px solid var(--brand-gold)` on .topbar;
   the design intentionally became 1px border + gold box-shadow line, so the test now checks that.

4. Receipt readability + offers: renderer/style.css (appended block) enlarges receipt fonts (80mm: items 17.5px bold, rows 16.5px,
   total 23px; 58mm scaled down) and gives the offer box a double border with a large title.
   renderer/receipt.js now also prints "offer price" and "you saved" lines inside each offer box (new i18n keys
   receipt.offerPrice / receipt.offerSaved in ar/tr/en).
