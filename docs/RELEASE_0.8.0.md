# Nexora POS v0.8.0 — Deep Hardening Release

## أهم الإصلاحات

- إزالة كلمة المرور الثابتة `admin123` من أول تثبيت.
- إنشاء كلمة مرور مدير أولية عشوائية مؤقتة مع إلزام تغييرها.
- تحديد محاولات تسجيل الدخول بكلمة المرور لتقليل التخمين السريع.
- إضافة رصيد متجر مستقل عن دين العميل، مع دعم الإصدار عند المرتجعات والاستعمال كطريقة دفع.
- إضافة UUID ومزامنة لسجل كشف حساب العميل، وإعادة احتساب الدين من الأحداث بدل الاعتماد على قيمة mutable واحدة عند المزامنة.
- منع تصادم UUID بين فروع المزامنة للكيانات المملوكة.
- توضيح الكيانات العالمية في خادم المزامنة بدل خلطها مع كيانات الفرع.

## Verification

- JavaScript syntax: PASS
- Security regression: PASS
- Payroll regression: PASS
- Deep regression: PASS
- Global financial regression: PASS
- Auth bootstrap regression: PASS
- GS1 regression: PASS
- IPC auth regression: PASS

## Build note

هذه الحزمة تحتوي المصدر المحصّن وملفات الاختبار. لم يتم ادعاء بناء native Electron/SQLite installer داخل بيئة التنفيذ التي لا تحتوي على `node_modules` ولم تنجح فيها عملية تنزيل التبعيات.
