# Nexora POS v0.15.0 — Stability & Input Freeze Hardening

## الهدف
إصدار يركز على استقرار لوحة الإدخال والواجهة تحت الضغط، مع الحفاظ على كل حواجز الأمن والمالية والمزامنة من الإصدارات السابقة.

## إصلاحات الأداء والاستقرار
- تقليل تكلفة إعادة بناء DOM في شبكة المنتجات والسلة باستخدام `DocumentFragment`.
- استخدام event delegation بدل إنشاء listener لكل بطاقة/سطر في كل إعادة رسم.
- رفع تأخير البحث إلى 325ms لتقليل الاستعلامات أثناء الكتابة السريعة.
- استمرار رفض الاستجابات القديمة من طلبات البحث عبر sequence guards.
- حفظ مسودة السلة مؤجلًا؛ مع حفظ نهائي عند `pagehide`.
- إضافة نبض renderer إلى العملية الرئيسية كل ثانيتين.
- إضافة watchdog على مستوى العملية الرئيسية لاكتشاف توقف renderer لمدة 12 ثانية أو أكثر.
- لا يقوم watchdog بإعادة التحميل أثناء نافذة دفع نشطة أو حالة عمل معلنة، لتجنب مقاطعة معاملة مالية.
- عند التعافي التلقائي، تُستعاد المسودة المحلية بدل فقدان السلة.
- إضافة فهارس `products.name`, `products.barcode`, `products.sku`.

## أمان
- قناة heartbeat تمر عبر IPC المحمي وتتطلب جلسة مستخدم.
- حدث watchdog يُسجل في Audit Log.
- لا توجد كلمة مرور admin ثابتة في ملفات runtime.

## توافق
لا يتم حذف بيانات الورديات القديمة؛ جلسة الصندوق ما زالت اختيارية للبيع.

## التحقق
- 53 ملف JavaScript: syntax check PASS.
- v0.15 Regression: 13/13 PASS.
- Security Regression: PASS.
- Payroll Regression: PASS.
- Deep Regression: 15/15 PASS.
- Global Financial Regression: 10/10 PASS.
- Auth Bootstrap: 8/8 PASS.
- v0.13 Regression: 15/15 PASS.
- Freeze Regression: 11/11 PASS.
- Full Regression: PASS.

## قيد البناء
اختبار Electron/SQLite native installer النهائي والتوقيع يتطلب بيئة بناء متصلة تستطيع تنزيل وإعادة بناء native dependencies. هذا لم يُعتبر ناجحًا دون تشغيل فعلي.
