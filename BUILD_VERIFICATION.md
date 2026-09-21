# Nexora POS v0.52.17 — Build & Release Verification

## حالة الإصدار
**Engineering Source Release / Release Candidate — غير مثبت تجارياً بعد.**

هذه الوثيقة تفصل بوضوح بين فحص المصدر وبين اختبار التشغيل الحقيقي. لا يكفي نجاح `node --check` أو regression source scripts لإثبات عمل Electron/SQLite native أو Windows installer.

### البيئة المرجعية
- Version: `0.52.17`
- Node.js build requirement: `>=22.12.0`
- Electron: `44.2.0`
- Encrypted SQLite: `better-sqlite3-multiple-ciphers 13.0.3`
- Updater: `electron-updater 6.8.9`
- Builder: `electron-builder 26.15.7`
- Schema target: `15`
- Immutable migration journal: `v2..v23` (22 migrations)

## ما تم إثباته في بيئة المصدر الحالية
- `npm run test:engineering` = PASS لفحوصات المصدر والمنطق والـsecurity/financial/regression.
- `npm run test:migrations` = PASS.
- Core SHA256 manifest = PASS.
- JavaScript syntax = PASS.
- CSP/Electron security preflight = PASS.
- `npm run test:acceptance` = PASS مع BLOCKED gates غير محلية موضحة أدناه.

## ما لا يُعتبر مثبتاً هنا
- `better-sqlite3-multiple-ciphers` native ABI داخل Electron.
- فتح/تعديل قاعدة البيانات المشفرة داخل Electron الحقيقي.
- Windows NSIS installer execution.
- Authenticode signature وSmartScreen.
- طابعة حرارية، قارئ باركود، cash drawer.
- auto-update من build مثبت سابقاً مع حفظ بيانات العميل.
- مزامنة جهازين/فرعين عبر endpoint إنتاجي.

## الأوامر الصحيحة
### فحص المصدر
```powershell
npm ci --no-audit --no-fund
npm run test:engineering
npm run test:migrations
npm run test:acceptance
```

### فحص native + Payroll Runtime
```powershell
npm run test:engineering:native
```
هذا الأمر **يجب** أن يعمل على جهاز اتصال حقيقي بالشبكة أو cache مكتمل للاعتماديات.

### فحص أمان التبعيات
```powershell
npm run test:dependencies
```

### بوابة البيع التجاري
```powershell
npm run test:commercial-gate
```
هذه البوابة يجب أن تفشل حتى يتم توفير native runtime + شهادة توقيع Windows + endpoint إبطال تراخيص إنتاجي.

## Windows Release
```powershell
$env:CSC_LINK = '<certificate-path-or-url>'
$env:CSC_KEY_PASSWORD = '<certificate-password>'
$env:NEXORA_REVOCATION_LIST_URL = 'https://<your-domain>/pos-crl.json'

npm run release:win
```

بعد البناء يجب أن تكون نتيجة `Get-AuthenticodeSignature` للـEXE هي `Valid`.

**ممنوع شحن `node_modules` الفارغة أو أي مفتاح توقيع خاص داخل الأرشيف.**

## v0.48.3 Payroll Verification
- Payroll lifecycle regression: PASS.
- Salary payment capped at remaining net salary: PASS.
- Cash salary requires open register shift: PASS.
- Paid month blocks payroll mutations: PASS.
- Payment history exposed through main/preload: PASS.
- Full engineering regression: PASS.
- Runtime limitation remains: native Electron/SQLite, Windows installer, signing, printer and updater require the real Windows release machine.
