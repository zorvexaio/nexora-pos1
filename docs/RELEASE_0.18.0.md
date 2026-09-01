# Nexora POS v0.18.0 — Production Hardening

## إصلاحات الدورة

- تصحيح منطق الدفع النقدي: يمكن أن يكون المبلغ المستلم أكبر من الإجمالي، مع التحقق الصارم من أن الباقي يساوي `cash received - total`.
- إصلاح استقبال المشتريات: المتوسط المرجح للتكلفة يُكتب فعليًا في `inventory.unit_cost` لكل فرع، بما يمنع ضياع التكلفة عند إدخال دفعة شراء جديدة.
- التحقق من أن كل منتج داخل أمر الشراء موجود ونشط قبل إنشاء الأمر.
- استمرار منع إدخال كميات مخزون سالبة عبر بيع يتجاوز المتاح؛ يتم تجميع الكمية المطلوبة لكل منتج قبل التحقق.
- استمرار عزل العملاء والموردين والفواتير والطلبات والطاولات وجلسات الصندوق حسب الفرع.
- استمرار حماية الرواتب الشهرية، Store Credit، idempotency، GS1، heartbeat/watchdog، والمزامنة.

## Verification

`npm run check` — PASS.

التحقق النهائي شمل:
- 56 ملف JavaScript — syntax checked.
- Security / payroll / deep / global financial / auth bootstrap regressions.
- v0.13 / v0.15 / v0.16 / v0.17 regressions.
- v0.18 regression: 8/8 PASS.

## Native packaging boundary

بناء Electron/SQLite native وتوقيع installers يجب تنفيذه في جهاز CI/Build متصل يستطيع تنزيل native dependencies، ثم اختباره على Windows/macOS/Linux الفعليين. لا يتم اعتبار هذا الجزء مثبتًا لمجرد نجاح الاختبارات المصدرية.
