# Nexora POS 0.22.0 — Deep Sync & Data Integrity Hardening

## أهم التغييرات

- مزامنة الجداول `restaurant_tables` مع UUID/metadata وترميمها ضمن الفرع.
- إضافة UUID ثابت لبنود المبيعات `sale_items` لضمان ربط المرتجع بالسطر الصحيح.
- مزامنة `payment_transactions`, `cash_movements`, `shifts`, `inventory_movements`, `supplier_ledger`, `customer_ledger`, `purchase_orders`, `returns`, `bundles`, و`tax_profiles`.
- إصلاح ترتيب تطبيق المزامنة: ملفات الضرائب قبل المنتجات، المشتريات قبل دفتر المورد، المبيعات قبل المرتجعات، المرتجعات قبل المدفوعات، اللِيدجر بعد المستندات المرجعية.
- حفظ `tax_profile_uuid`, `parent_product_uuid`, `sale_item_uuid`, وبيانات نقاط الولاء أثناء المزامنة.
- المرتجعات البعيدة أصبحت idempotent قبل أي أثر مالي، وتُحدّث Store Credit والولاء وحالة الفاتورة.
- لقطات المخزون لا تستبدل الكمية المحلية المطلقة على جهاز قائم؛ حركات المخزون هي دلتا التاريخ المرجعية لتقليل lost updates بين الأجهزة.
- إعادة بناء رصيد العميل بعد تطبيق المزامنة لا يولد حلقة مزامنة إضافية.
- تم تحديث اختبارات الإصدارات السابقة لتقيس التوافق السلوكي بدل تثبيت أرقام الإصدارات حرفيًا.

## التحقق

- `npm run check`: PASS
- 60 ملف JavaScript تم فحصها نحويًا.
- v0.22 Regression: 23/23 PASS.
- Security / Payroll / Deep / Global Financial / Auth / Freeze / جميع اختبارات الإصدارات السابقة: PASS.

## حدود هذه البيئة

لم يتم تنفيذ build native فعلي لـElectron/SQLite أو توقيع installers أو اختبار أجهزة Windows/macOS/Linux الحقيقية داخل هذه البيئة.
