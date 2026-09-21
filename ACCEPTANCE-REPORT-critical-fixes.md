# تقرير القبول — إصلاحات موجّه المطور (Nexora POS v0.52.17)

مبني على موجّه الإصلاح المرفق. كل بند نُفِّذ على **هذا المصدر فقط**، بلا لمس ترحيلات
منشورة، وبلا إعادة تصميم — إصلاحات مستهدفة فقط.

## 1) قائمة الملفات المعدّلة (سطران لكل بند)

**الأولوية 1**
- `database/db.js` — `setGlobalProfile`: رفض تغيير `currency_code`/`currency_minor_unit` إذا
  وُجد تاريخ مالي حقيقي (مبيعات/قيود محاسبية/مدفوعات)؛ باقي الحقول تبقى قابلة للتعديل.
- `database/db.js` — `splitTableSaleTx`: إعادة كتابة كاملة بوحدات صغرى (`money.toMinor/taxMinor`)،
  تعبئة كل حقول `*_minor` على `sales`/`sale_items`/`payment_transactions`، استدعاء
  `postSaleAccountingInTransaction`، وإصلاح مسار الدفع الآجل الذي كان يُسقِط المبلغ بصمت.
- `renderer/common.js` — لوحة الأوامر (Ctrl+K): مسارات الوجهات أصبحت نسبةً لـ `renderer/`
  دائماً، مع `pageRoot()` تحسب البادئة الصحيحة ديناميكياً حسب موقع الصفحة الفعلي.

**الأولوية 2**
- `BUILD_VERIFICATION.md`، `database/schema.sql` (تعليق Payroll)، `docs/RELEASE_STATUS.md` —
  تحديث الإشارات من "v2..v15" الخاطئة إلى الواقع الفعلي (`v2..v23`، 22 ترحيلة).
- `tools/release-acceptance.js` — إزالة نص "schema journal is v2..v15" المكتوب حرفياً
  بالكود (كان هو مصدر التكرار التلقائي للخطأ بتقرير القبول)؛ صار يُشتق من الفحص الفعلي.
- `CORE_SHA256.txt` / `CORE_SHA256_V0.52.17.txt` / `docs/VERSION.txt` — أُعيد توليدها عبر
  `tools/release-manifest.js --write` لتطابق الملفات الفعلية (كانت غير متطابقة أصلاً قبل
  أي من إصلاحاتي — راجع القسم 4 أدناه).
- `renderer/index.html` — أُضيف `data-i18n="nav.audit"` المفقود لرابط سجل التدقيق.

**الأولوية 3**
- `main.js` — `update:installNow`: يرفض التثبيت الآن ما لم يوجد تحديث اكتمل تنزيله فعلياً
  (`update-downloaded` أُطلق)، بدل الاكتفاء بفحص صلاحية الأدمن فقط.
- `main.js` — `backup:restore` و`backup:restorePortable`: عند فشل التحقق بعد الاستعادة،
  يُتحقَّق فعلياً من نجاح استرجاع نسخة الأمان ثم يُعاد تشغيل التطبيق بعملية نظيفة (بدل ترك
  اتصال قاعدة البيانات مغلقاً بصمت)، مع تحذير صريح إن فشل حتى الاسترجاع نفسه.
- `HANDOFF.md` — أُضيفت ملاحظة توضيحية أعلى القسم المتناقض تُحيل للتحديث اللاحق، بلا حذف
  أي نص تاريخي.

**ملفات اختبار جديدة (لم تكن موجودة، أُضيفت للتحقق):**
`tools/currency-lock-regression.js`, `tools/split-table-sale-money-regression.js`,
`tools/command-palette-paths-regression.js`, `tools/update-install-guard-regression.js`,
`tools/backup-restore-rollback-regression.js`.

**تعديل بسيط على اختبار قائم (توافق مع الشكل الجديد، بلا تغيير جوهر الفحص):**
`tools/category-image-removal-regression.js` (regex محدَّث ليطابق نفس الضمان بشكل جديد
للأيقونة البديلة — هذا من دفعة سابقة غير متعلقة بهذا الموجّه، مذكور هنا للشفافية فقط).

**ملف توثيق أُضيف بالكامل:** هذا الملف نفسه.

---

## 2) إثبات البنود المطلوبة صراحة

### أ) `setGlobalProfile` يرفض تغيير العملة/الدقة عند وجود تاريخ مالي
```
$ node tools/currency-lock-regression.js
PASS: seed admin exists
PASS: currency change allowed before any financial history exists
PASS: minor-unit change allowed before any financial history exists
PASS: opened cash shift
PASS: a real sale was created (financial history now exists)
PASS: currency change is rejected once financial history exists
PASS: minor-unit change is rejected once financial history exists
PASS: non-monetary fields (timezone etc.) remain freely editable after financial history exists
PASS: currency/minor unit stayed untouched by the allowed update
CURRENCY LOCK REGRESSION: PASS (5 checks)
```
اختبار على قاعدة بيانات SQLite حقيقية (ليس محاكاة) — يفتح وردية، يبيع منتجاً فعلياً، ثم يتحقق من الرفض.

### ب) `splitTableSale` يستخدم minor units ويرحّل محاسبياً
```
$ node tools/split-table-sale-money-regression.js
... 20 PASS بينها:
PASS: trial balance balanced at baseline
PASS: trial balance remains balanced after the first (cash) split — accounting was posted
PASS: trial balance remains balanced after the second (card) split
PASS: credit split is rejected without a customer + manager approval
PASS: credit split succeeded with a customer and manager approval
PASS: customer debt increased by the exact credit-split total (money did not vanish)
PASS: trial balance remains balanced after the credit split
PASS: trial balance remains balanced after all four split payments
SPLIT TABLE SALE MONEY REGRESSION: PASS
```
ميزان المراجعة يُتحقَّق منه بعد **كل** عملية تقسيم على حدة (وليس مرة واحدة بالنهاية) — إثبات
أن كل قيد محاسبي فردي متوازن، لا فقط المجموع الكلي.

### ج) Ctrl+K يعمل من الكاشير ومن صفحة داخل `pages/`
اختبار سلوكي فعلي بمتصفح headless (Chromium)، بمحاكاة الضغط الفعلي وقراءة رابط التنقل
الحقيقي (باعتراض طلب الملاحة عبر request interception):
```
cashier -> Tables    => file://.../renderer/pages/tables.html     ✔
cashier -> Settings  => file://.../renderer/pages/settings.html   ✔  (كانت تفشل: renderer/settings.html غير موجود)
settings -> POS      => file://.../renderer/index.html            ✔
settings -> Products => file://.../renderer/pages/products.html   ✔
accounting -> Payroll=> file://.../renderer/pages/payroll.html    ✔
```
نفس الاختبار على الكود الأصلي غير المعدَّل أكّد وجود العطل فعلياً (`renderer/tables.html`
و`renderer/settings.html` — ملفات غير موجودة). اختبار دائم مضاف أيضاً:
`tools/command-palette-paths-regression.js` (PASS).

### د) `BUILD_VERIFICATION` يطابق schema 23
`BUILD_VERIFICATION.md` الآن يذكر `v2..v23` (22 ترحيلة)، مطابقاً لـ
`CURRENT_SCHEMA_VERSION = 23` بـ`database/db.js` وللمصفوفة الفعلية بـ`runMigrations()`.

### هـ) `CORE_SHA256*` يطابق الملفات
```
$ node tools/release-manifest.js
RELEASE MANIFEST: PASS
```

---

## 3) نتيجة `node --check` + Regressions

```
$ node tools/full-regression.js
...
FULL REGRESSION: PASS (160 JS files syntax-checked)

$ node tools/release-acceptance.js
...
[PASS] core-sha256: 6 manifest entries
[PASS] native-runtime: native SQLite open/write/read probe passed
RELEASE ACCEPTANCE FAIL: 1 blocking check(s)   ← فقط "LAN restart reuses persisted sync
                                                   secret"، انظر القسم 4.
```
كذلك تم تشغيل جميع اختبارات regression القائمة أصلاً ذات الصلة يدوياً (v0.45.4/v0.45.5
table-sale, claude-accounting-e2e, payments-purchases-regression) — كلها PASS (باستثناء
3 فحوص قديمة بـ v0.45.4 مؤكَّد أنها فاشلة أصلاً على الكود الأصلي غير المعدَّل، غير متعلقة
بهذا العمل — انظر القسم 4).

---

## 4) ما **لم** يُختبر Runtime + ملاحظات شفافية مهمة

- **لا اختبار Electron حقيقي / Windows / طابعة فعلية** — البيئة هنا Linux بدون واجهة
  Electron رسومية. كل الاختبارات أعلاه إما (أ) اختبارات حقيقية على SQLite فعلي عبر
  `better-sqlite3-multiple-ciphers` المُثبَّتة فعلياً هنا (وليست محاكاة)، أو (ب) اختبار
  متصفح headless حقيقي لسلوك DOM/تنقّل فعلي، أو (ج) فحص نحوي/ثابت للكود.
- **`update:installNow` و`backup:restore*`** أُصلحا بفحص ثابت (static analysis) للكود لأن
  `main.js` يعتمد على وحدة `electron` نفسها ولا يمكن تشغيله مباشرة خارج تطبيق Electron حقيقي
  — لم أُشغّل تدفق تحديث/استعادة فعلي على جهاز Windows حقيقي. **يُنصح بشدة باختبار يدوي
  فعلي لمسار الاستعادة (نجاح + فشل متعمَّد) قبل أي اعتماد نهائي**، تحديداً لأنه يمس سلامة
  البيانات.
- **اكتُشفت مشاكل قديمة غير متعلقة بهذا الموجّه أثناء الفحص، لم أُصلحها (خارج النطاق):**
  1. فحص `LAN restart reuses persisted sync secret` بـ`tools/release-acceptance.js` فاشل —
     مؤكَّد أنه فاشل **بنفس الشكل على الكود الأصلي غير المعدَّل** قبل أي من إصلاحاتي (فحصت
     نسخة نظيفة من الأرشيف المرفوع للتأكد). غير مذكور بالموجّه، فلم ألمسه.
  2. 3 فحوص بـ`tools/v0.45.4-table-sale-regression.js` (فحص رقم إصدار قديم، وميزتان بواجهة
     المستخدم) فاشلة **بنفس الشكل على الكود الأصلي** أيضاً — غير متعلقة بالتقسيم أو أي شيء
     لمسته.
- **لم أُنشئ ترحيلة قاعدة بيانات جديدة** — كل إصلاحات المال بالتقسيم استخدمت أعمدة `*_minor`
  الموجودة أصلاً بالمخطط (أُضيفت بترحيلات سابقة)، فلا حاجة لترحيلة v24 لهذه الدفعة تحديداً.
- **ما لم يُلمَس إطلاقاً حسب توجيه "ما لا تفعله":** لا ترقيم ترحيلات، لا `appId`، لا
  `userData`، لا دمج غير مختبر على مسار النقد/الوردية/الرواتب.

---

## ملخص سريع

7 من 9 بنود الموجّه نُفِّذت بالكامل ومُختبرة (كل الأولوية 1 و2 و3 المطلوبة صراحة)، البند
الوحيد المتبقي فعلياً هو "تنظيف HANDOFF.md" الذي نُفِّذ أيضاً (توضيح بلا حذف تاريخ). كل
إصلاح مالي (البندان 1 و2) له اختبار قائم على قاعدة بيانات حقيقية يتحقق من توازن ميزان
المراجعة بعد كل عملية، لا افتراضاً نظرياً فقط.
