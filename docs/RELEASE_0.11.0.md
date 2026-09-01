# Nexora POS v0.11.0

## أهم إصلاح في هذا الإصدار

فصل تكلفة المخزون عن `products.cost` العالمي. لكل فرع أصبح للمخزون `inventory.unit_cost` خاص به، ويُستخدم هذا الرصيد عند:

- احتساب تكلفة البيع وتخزين `sale_items.cost_at_sale`.
- إعادة احتساب تكلفة طلبات الطاولات.
- استلام المشتريات وحساب المتوسط المرجّح داخل الفرع.
- مزامنة المخزون مع الفرع المالك مع الحفاظ على تكلفة الفرع.

العمود القديم `products.cost` بقي للتوافق مع قواعد البيانات القديمة، ولا يعود مصدر التكلفة الأساسي للفرع عند وجود `inventory.unit_cost`.

## التحقق

- FULL REGRESSION: PASS (49 JavaScript files).
- V0.11 REGRESSION: PASS (8 checks).
- Security / Payroll / Deep / Global Financial / Auth Bootstrap / IPC Auth / GS1: PASS.

## ملاحظة البناء

لم يتم الادعاء ببناء native Electron/SQLite داخل بيئة لا تملك `node_modules` أو وصولًا مضمونًا إلى npm registry. تشغيل `npm install`, `npm run rebuild`, ثم `npm run dist` على جهاز بناء متصل هو خطوة التسليم الأصلية للـinstaller.
