# تقرير التنظيف — Nexora POS v0.52.29

**تاريخ التنظيف:** 2026-10-06  
**الإصدار:** 0.52.29 (بدون تغيير رقم الإصدار — تنظيف فقط)

---

## ما تم تنظيفه

### 1. حذف ملفات النسخ الاحتياطي (.bak)
تم حذف الملفات التالية من المصدر لأنها ملوِّثة وغير مناسبة للمستودع:

- `database/db.js.bak`
- `database/db.js.bak2`
- `renderer/license.js.bak`
- `renderer/pos.js.bak`
- `renderer/receipt.js.bak2`

### 2. أرشفة التوثيق التاريخي
نُقلت ملفات التغييرات والتقارير القديمة إلى `archive/` لتنظيف جذر المشروع:

| المجلد | المحتوى |
|--------|---------|
| `archive/changes/` | 27 ملف `CHANGES-*.md` |
| `archive/reports/` | ACCEPTANCE-REPORT، BUILD_VERIFICATION، HANDOFF، MERGE-NOTES، check-output |
| `archive/tools-and-licensing.zip` | أرشيف أدوات الترخيص (كان في الجذر) |

### 3. تحديث `.gitignore`
أُضيفت قواعد لمنع عودة ملفات `.bak` و`.orig` وملفات المحررات.

### 4. إصلاح `package.json`
- حقل `"author"` كان فارغاً → أصبح `"Zorvexa / Nexora POS"`.

---

## ما لم يُغيَّر (عن قصد)

| البند | السبب |
|-------|--------|
| تفكيك `database/db.js` (7842 سطر) | تغيير معماري كبير يحتاج اختبارات انحدار كاملة على Windows + SQLite مشفّر |
| بناء adapters ضريبية حقيقية | يحتاج مواصفات سوق (تركيا / السعودية / …) ومفاتيح API رسمية |
| تعديل منطق المال / الرواتب / المحاسبة | الكود الحالي مختبر بـ suite انحدار؛ أي تعديل بدون تشغيل الاختبارات خطر |
| حذف مجلد `build/` | جزء من هيكل الحزمة للتوزيع |
| حذف `docs/` | توثيق رسمي للإصدار والتشغيل |

---

## هيكل الجذر بعد التنظيف

```
nexora-pos1-main/
├── README.md
├── LICENSE
├── VERSION
├── package.json
├── package-lock.json
├── main.js
├── preload.js
├── CLEANUP-REPORT.md          ← هذا الملف
├── RELEASE_ACCEPTANCE_REPORT.json
├── CORE_SHA256.txt
├── CORE_SHA256_V0.52.29.txt
├── archive/                   ← التوثيق التاريخي
├── build/
├── core/
├── database/
├── docs/
├── finance/
├── fiscalization/
├── lib/
├── licensing/
├── renderer/
├── server/
└── tools/
```

---

## ملاحظات مهمة للمطور

1. **لا تشغّل `npm start` قبل `npm ci && npm run rebuild`** — الوحدة الأصلية لـ SQLite المشفّر يجب بناؤها للجهاز الحالي.
2. ملفات `archive/` للاحتفاظ بالتاريخ فقط؛ ليست جزءاً من مسار التشغيل.
3. الإصلاحات المعمارية المتبقية (تفكيك db.js، Fiscalization، تقوية PIN rate-limit) موثّقة في تقرير التدقيق السابق ويمكن تنفيذها على دفعات مع تشغيل:
   ```bash
   npm run check
   ```

---

## التحقق السريع بعد الاستخراج

```bash
# لا يجب أن يظهر أي .bak
find . -name '*.bak*' 

# الجذر يجب أن يكون نظيفاً من CHANGES-*.md
ls CHANGES-*.md 2>/dev/null || echo "OK: no CHANGES in root"

# الإصدار
cat VERSION && node -e "console.log(require('./package.json').version)"
```

**النتيجة المتوقعة:** لا ملفات bak، لا CHANGES في الجذر، الإصدار `0.52.29`.

---

## دفعة الإصلاح 1 (بعد التنظيف)

### أ) استخراج `database/crypto-auth.js`
- نقل `hashPassword` / `verifyPassword` / rate-limit المصادقة من `db.js`.
- `db.js` يستوردها ويحافظ على نفس السلوك.
- التحقق: `node --check` ناجح + اختبار يدوي للتجزئة والتحقق.

### ب) تقوية قفل PIN في `main.js`
- بعد 5 محاولات فاشلة: القفل **5 دقائق** بدل دقيقة واحدة (دخول PIN وموافقة المدير بـPIN).
- طبقة DB ما زالت قادرة على فرض قفل أطول (حتى 15 دقيقة).

### ج) خارطة التفكيك
- `docs/REFACTOR-ROADMAP.md` — دفعات 2→5 مقترحة.

---

## حجم الملفات بعد الدفعة 1

| الملف | الأسطر تقريباً |
|-------|----------------|
| `database/db.js` | ~7803 (كان ~7842) |
| `database/crypto-auth.js` | ~82 (جديد) |

---

## دفعة الإصلاح 2

ملفات جديدة:
- `database/settings.js`
- `database/branches.js`
- `database/audit.js`
- `database/users.js`

`db.js` أصبح ~7558 سطر (أغلفة رفيعة + المنطق المتبقي).
`node --check` ناجح على كل الوحدات الجديدة و`db.js`.

---

## دفعات 3–5 — اكتمال التفكيك

- `database/db.js` ≈ **2000** سطر (كان ~7842).
- **16** نطاقاً في `database/domains/`.
- `node --check` على النواة وكل النطاقات: ناجح.
- الأسماء المُصدَّرة في `module.exports` محفوظة للتوافق مع `main.js`.

**تحذير:** يلزم تشغيل `npm run check` على Windows/Linux مع native SQLite قبل اعتماد الإصدار إنتاجياً.
