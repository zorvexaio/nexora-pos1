# Nexora POS v0.52.17 — Release Status

**Status: Engineering Source Release / Release Candidate. Not yet commercially verified.**

## مثبت
- JavaScript syntax checks clean.
- Financial/security static checks clean.
- Migration chain v2..v23 explicitly checked (append-only chain integrity, latest: v21 accounting-balance-cache, v22 payroll-advances-accounting, v23 inventory-account-correction) — see `tools/migration-chain-regression.js`, the source of truth for the current chain, so this line doesn't need manual updates to stay accurate.
- Payroll regression suite and schema checks are available.
- `npm run test:release` (`test-engineering.js` + `release-preflight.js`) passes end-to-end in this environment.
- `better-sqlite3-multiple-ciphers` is pinned to an exact version (`13.0.3`, no caret range) in `package.json`, matching what `release-preflight`/`engineering-audit` require.
- Core SHA256 manifest is checked.
- Electron security policy and CSP are checked.
- Native SQLite setup/rebuild commands are included.

## ملاحظة هندسية: فحوصات كانت تفشل بسبب رقم إصدار مخطط ثابت (أُصلحت 2026-09-06)
عدد من ملفات `tools/*-regression.js` (من ضمنها اثنان داخل `npm run test:engineering` نفسه:
`payroll-advances-regression.js` و`payroll-advance-repayments-regression.js`، بالإضافة إلى
`update-safety-regression.js`, `v0.48.0-regression.js`, `v0.48.2-regression.js`,
`payroll-lifecycle-regression.js`, `payroll-termination-regression.js`,
`inventory-transfer-regression.js`) كانت تتحقق من `CURRENT_SCHEMA_VERSION` عبر مطابقة نصية
لقائمة أرقام ثابتة (مثلاً `10|11|12|13|14|15`)، فتفشل تلقائياً بمجرد أي ترحيلة جديدة —
وفعلاً كانت تفشل منذ v16 دون أن يلاحظ أحد لأن `npm run test:release` لم يكن يُشغَّل بانتظام.
كل هذه الفحوصات صارت تتحقق من حد أدنى (>=) لا قيمة ثابتة. `migration-chain-regression.js`
يبقى الاستثناء المتعمَّد: قائمته تاريخ ثابت (append-only) بالتصميم ويجب تحديثها يدوياً مع كل
ترحيلة جديدة — هذا هو الغرض منه.

## غير مثبت داخل بيئة Linux الحالية
- `better-sqlite3-multiple-ciphers` native runtime after an actual Electron ABI rebuild.
- Windows NSIS installer execution.
- Authenticode certificate validity.
- SmartScreen behavior.
- Real thermal printer/barcode scanner.
- Real auto-update from an installed prior release.
- Two-machine sync conflict/recovery.

## Licensing
`REVOCATION_LIST_URL` لم يعد قيمة ثابتة داخل المصدر؛ يقرأ من `NEXORA_REVOCATION_LIST_URL`. يظل فارغاً افتراضياً حتى يتم توفير endpoint الإنتاج.

## Dependency baseline checked 2026-09-04
- Electron 44.2.0 is the current stable release and is within Electron's three-supported-release policy. Electron 44.2.0 ships Chromium 152.0.7977.76 and Node 24.20.0.
- better-sqlite3-multiple-ciphers 13.0.3 is the current stable npm version.
- electron-updater 6.8.9 is the current npm latest.
- electron-builder 26.15.7 is pinned in this project; npm currently exposes the 26.x line, and no upgrade is being forced without a compatibility build.


## بوابة الاختبار الصحيحة
لا تستخدم `npm run test:engineering` دليلاً على تشغيل SQLite. هذا الأمر يختبر منطق المصدر فقط. التشغيل الفعلي للنظام يتطلب `npm run test:engineering:native` بعد تثبيت native module.
