# Nexora POS v0.19.0

## أهم إصلاحات الجولة

- أضيفت idempotency للمرتجعات عبر `returns.client_request_id` مع فهرس فريد لكل فرع.
- جرى تقييد `shiftId` في المرتجع بالفرع الحالي وحالة الجلسة قبل أي حركة مالية.
- إرجاع `store_credit` أصبح يظهر في `payment_transactions` كحركة استرداد سالبة مع تحديث الرصيد المنفصل.
- إغلاق طلب الطاولة يدعم `store_credit` بشكل صحيح: يتحقق من العميل، يتحقق من الرصيد، يخصم الرصيد، ويسجل حركة الدفع.
- تقسيم فاتورة الطاولة يسجل دفعات النقد/البطاقة/رصيد المتجر في دفتر المدفوعات، ويحافظ على العميل المرتبط بالفاتورة الأصلية.
- حساب الضريبة في تقسيم الفاتورة يحترم الضريبة الشاملة/الحصرية وملف الضريبة الخاص بالصنف.
- استلام المشتريات لم يعد يغير `products.cost` العالمي؛ تكلفة المخزون المرجعية تبقى في `inventory.unit_cost` على مستوى الفرع.
- ما زالت تكلفة البيع التاريخية محفوظة في `sale_items.cost_at_sale`.
- استمرت جميع إصلاحات الإصدار 0.18 المتعلقة بالدفع النقدي مع الباقي، idempotency للمبيعات، عزل الفروع، الرواتب الشهرية، والواجهة المقاومة للتجمّد.

## التحقق

- JavaScript syntax: PASS
- v0.18 regression: 8/8 PASS
- v0.19 regression: 10/10 PASS
- Security regression: PASS
- Global financial regression: PASS
- Payroll regression: PASS
- Deep regression: PASS
- Freeze/input regression: PASS
- Full regression: PASS

## ملاحظات الإنتاج

لم يتم ادعاء بناء Electron native أو توقيع installers داخل بيئة لا تملك native dependencies جاهزة. لذلك يلزم على جهاز Build حقيقي متصل تنفيذ `npm install` ثم `npm run rebuild` ثم `npm run dist:win`/`dist:mac`/`dist:linux` واختبارات التشغيل الفعلية قبل الإطلاق التجاري.
