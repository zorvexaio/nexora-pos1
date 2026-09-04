# Nexora POS v0.52.1 — Release Status

**Status: Engineering Source Release / Release Candidate. Not yet commercially verified.**

## مثبت
- JavaScript syntax checks clean.
- Financial/security static checks clean.
- Migration chain v2..v15 explicitly checked.
- Payroll regression suite and schema checks are available.
- Core SHA256 manifest is checked.
- Electron security policy and CSP are checked.
- Native SQLite setup/rebuild commands are included.

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
