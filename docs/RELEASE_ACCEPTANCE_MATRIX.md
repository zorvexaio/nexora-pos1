# Nexora POS v0.52.1 — Release Acceptance Matrix

## الهدف
هذه المصفوفة تمنع خلط الفحوصات الثابتة مع إثبات التشغيل الفعلي. لا يعتبر الإصدار تجارياً حتى تنجح بوابات Windows وnative وCode Signing.

| البوابة | ما يثبتها | الحالة في هذه البيئة |
|---|---|---|
| Source integrity | الإصدار، SHA256، migration chain، CSP، syntax | PASS |
| Native SQLite | `npm run setup` ثم `npm run verify:native` | BLOCKED هنا بدون native module مُثبت |
| Payroll Runtime | اختبارات SQLite الحقيقية بعد native build | BLOCKED حتى بناء native |
| Electron Runtime | تشغيل Electron فعلياً وإغلاق/إعادة فتح التطبيق | يحتاج Windows/macOS فعلي |
| Windows installer | NSIS build على Windows | يحتاج Windows فعلي |
| Authenticode | توقيع + `Get-AuthenticodeSignature = Valid` | يحتاج شهادة فعلية |
| Printing | طابعة حرارية حقيقية + test page/receipt | يحتاج جهاز فعلي |
| Barcode | قارئ USB/Bluetooth فعلي | يحتاج جهاز فعلي |
| Update | 0.52.0 → 0.52.1 مع بقاء قاعدة بيانات العميل | يحتاج جهاز/بيانات فعلية |
| Rollback/Recovery | backup + restore + failed update recovery | يحتاج جهاز/بيانات فعلية |
| Sync | فرعان/جهازان مع تعارضات حقيقية | يحتاج بيئة خادم فعلية |
| License | تفعيل/تغيير جهاز/انتهاء/إبطال | requires production revocation endpoint for remote revoke |

## الأوامر
```powershell
npm ci --no-audit --no-fund
npm run rebuild
npm run verify:native
npm run test:engineering
npm run test:acceptance:native
```

وللتوقيع التجاري:
```powershell
$env:CSC_LINK = "<certificate path or URL>"
$env:CSC_KEY_PASSWORD = "<certificate password>"
$env:NEXORA_REVOCATION_LIST_URL = "https://<your-domain>/pos-crl.json"
npm run test:acceptance:commercial
npm run dist:win
```

لا توضع شهادة التوقيع أو المفتاح الخاص داخل المستودع.

## بوابات الأوامر
- `npm run test:engineering`: فحوصات المصدر فقط، ولا يدّعي تشغيل native.
- `npm run test:engineering:native`: يبني native ثم يشغّل اختبارات SQLite الفعلية.
- `npm run test:commercial-gate`: يجب أن يفشل في أي بيئة لا تحتوي native runtime + signing + revocation endpoint؛ هذا فشل مقصود وليس عيباً في المصدر.
- `npm run test:dependencies`: يشغّل `npm audit --audit-level=high` على جهاز متصل بالشبكة.
