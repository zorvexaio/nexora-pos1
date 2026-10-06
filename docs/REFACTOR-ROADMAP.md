# خارطة تفكيك `database/db.js` — Nexora POS

## الحالة النهائية (2026-10-06)

| الطبقة | الموقع | الدور |
|--------|--------|--------|
| نواة دورة الحياة | `database/db.js` (~2000 سطر) | تشفير، init، ترحيلات، أغلفة |
| مصادقة | `database/crypto-auth.js` | scrypt + rate-limit |
| إعدادات / فروع / تدقيق / مستخدمون | `settings.js`, `branches.js`, `audit.js`, `users.js` | دفعة 1–2 |
| نطاقات الأعمال | `database/domains/*.js` (16 ملفاً) | دفعات 3–5 |

### نطاقات `database/domains/`

| ملف | المجال |
|-----|--------|
| catalog.js | فئات، منتجات، حزم |
| sales.js | مبيعات |
| inventory.js | مخزون + تحويلات |
| reports.js | تقارير تشغيلية |
| customers.js | عملاء |
| purchasing.js | موردون + مشتريات + مصروفات |
| tables.js | طاولات وطلبات مفتوحة |
| payments.js | تصحيح طرق الدفع |
| profile.js | ملف المنظمة / الضرائب |
| shifts.js | ورديات الصندوق |
| payroll.js | رواتب V2 |
| returns.js | مرتجعات |
| delivery.js | تقارير دليفري |
| export_sync.js | تصدير + مزامنة |
| accounting.js | محاسبة وتقارير مالية |
| backup.js | نسخ احتياطي واستعادة |

**النمط:** كل نطاق يستقبل `h` (helpers) مع `h.db` ونداءات متبادلة عبر `h.fnName` بعد الربط.

## التحقق

```bash
node --check database/db.js
for f in database/domains/*.js; do node --check "$f"; done
# على آلة تطوير كاملة:
npm run check
```

## ملاحظات

1. أجسام الترحيلات ما زالت في `db.js` (عمداً — immutability + checksums).
2. أي دفعة لاحقة: نقل ترحيلات إلى `database/migrations/` مع runner يحافظ على checksum.
3. لا تغيّر أسماء الدوال المُصدَّرة من `module.exports` في `db.js`.
