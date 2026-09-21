# ملاحظات الدمج — إصلاحات الموجّه الحرجة + شغل المطور الأخير

هذا الملف يوثّق كيف تم دمج إصلاحات "موجّه الإصلاح الحرج" (راجع الجلسة السابقة) مع آخر
نسخة سلّمها المطور (`nexora-pos-cashier-redesign-i18n-fixed.zip`)، والتأكد من عدم تكرار
أي إصلاح أو تعارض معه.

## الخطوة الأولى: ماذا فعل المطور فعلياً؟

قارنت نسخة المطور بالأصل قبل أي تعديل (نفس الأصل اللي بُني عليه موجّه الإصلاح)، فظهر إن
عمل المطور كان **منفصلاً تماماً** عن نطاق الموجّه الحرج:

- استبدال `window.alert()` / `window.confirm()` بنوافذ مخصّصة (`confirmDialog`,
  `infoDialog`) في `renderer/common.js`.
- تنظيف i18n واسع بعدة صفحات (`renderer/i18n.js` وأغلب ملفات `renderer/pages/*.js`) —
  استبدال نصوص عربية مكتوبة مباشرة بمفاتيح `t('...')`.
- إعادة تصميم بطاقة المنتج بالكاشير (`renderer/pos.js`, `renderer/style.css`) — امتداد
  لعمل "تبويبات الأقسام" من جلسة سابقة (`CHANGES-cashier-product-card-redesign.md`).

**لم يلمس المطور إطلاقاً**: `database/db.js`، `main.js`، `renderer/index.html`،
`database/schema.sql`، `BUILD_VERIFICATION.md`، `docs/RELEASE_STATUS.md`، `HANDOFF.md`،
`tools/release-acceptance.js` — أي من الملفات الجوهرية بالموجّه الحرج. تأكدت بمقارنة كل
ملف بايت-لبايت مع الأصل قبل أي تعديل.

**الخلاصة: لا تعارض إطلاقاً ولا أي إصلاح مكرَّر.** كل بنود الموجّه التسعة كانت لا تزال
غائبة تماماً بنسخة المطور (تحققت بالبحث عن العلامات المميزة لكل إصلاح: `downloadedUpdateInfo`،
`organizationHasFinancialHistory`، `rolledBack`، `data-i18n="nav.audit"`، `v2..v23`... كلها
0 نتيجة قبل الدمج).

## الخطوة الثانية: ماذا أضفتُ الآن؟

**نُسخت كاملة (الملف الأصلي لم يتغيّر عند المطور، فلا خطر دمج):**
`database/db.js`, `main.js`, `renderer/index.html`, `BUILD_VERIFICATION.md`,
`database/schema.sql`, `docs/RELEASE_STATUS.md`, `HANDOFF.md`, `tools/release-acceptance.js`،
وملفات الاختبار الخمسة الجديدة (`tools/currency-lock-regression.js` وما شابه).

**عُدِّلت بلصقات مستهدَفة فقط (لأن المطور لمس نفس الملف بأجزاء أخرى، فحافظت على شغله):**
- `renderer/common.js` — أُضيف إصلاح مسارات Ctrl+K فقط؛ `confirmDialog`/`infoDialog`
  الخاصة بالمطور لم تُمسّ إطلاقاً.
- `renderer/i18n.js` — أُضيف مفتاحا ترجمة فقط (رسالة قفل العملة، EN + TR) في نفس القواميس
  التي أضاف/عدّل بها المطور مفاتيحه الخاصة؛ لم يُحذف أو يُعدَّل أي مفتاح من مفاتيحه.
- `renderer/pages/settings.js` — سطر واحد فقط (`ts(e.message)` بدل `e.message` بدالة حفظ
  الإعدادات العامة)؛ كل تنظيف i18n الذي فعله المطور بنفس الملف (رسائل صور الأقسام، نوافذ
  التأكيد...) لم يُمسّ.

## التحقق بعد الدمج

```
$ node tools/full-regression.js          → FULL REGRESSION: PASS (160 JS files)
$ node tools/currency-lock-regression.js → PASS (5 checks)
$ node tools/split-table-sale-money-regression.js → PASS (20 checks، ميزان مراجعة متوازن
                                              بعد كل عملية تقسيم)
$ node tools/command-palette-paths-regression.js  → PASS
$ node tools/update-install-guard-regression.js   → PASS
$ node tools/backup-restore-rollback-regression.js→ PASS
$ node tools/v0.45.5-table-sale-regression.js → PASS (4/4، بما فيها split table)
$ node tools/claude-accounting-e2e.js         → PASS (0 failures)
$ node tools/category-image-removal-regression.js → PASS
$ node tools/release-manifest.js → PASS (أُعيد التوليد بعد كل التعديلات)
$ node tools/release-acceptance.js → فشل حاجز واحد فقط: "LAN restart reuses persisted
   sync secret" — مؤكَّد أنه موجود بنفس الشكل قبل أي من إصلاحاتي وقبل شغل المطور أيضاً
   (خارج نطاق العمل الحالي بالكامل، غير مذكور بأي موجّه).
```

`tools/v0.45.4-table-sale-regression.js` لا يزال فيه نفس 3 فحوص قديمة فاشلة (فحص رقم
إصدار + ميزتان بالواجهة) — مؤكَّد أنها فاشلة بنفس الشكل بالأصل قبل أي تعديل من أي طرف،
غير متعلقة بالتقسيم أو أي شيء بهذا الدمج.

راجع `ACCEPTANCE-REPORT-critical-fixes.md` (من الجلسة السابقة) للتفاصيل الكاملة لكل بند من
بنود الموجّه الحرج نفسه — كل ما فيه ينطبق حرفياً هنا أيضاً بعد الدمج.
