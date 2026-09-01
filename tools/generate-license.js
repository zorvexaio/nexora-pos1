#!/usr/bin/env node
// ==========================================================
// أداة توليد التراخيص — تُستخدم من عندك أنت (البائع) فقط
// لا توزّع هذا الملف أو المفتاح الخاص (private-key.pem) مع نسخة العميل من التطبيق!
// ==========================================================
//
// الاستخدام:
//   1) أول مرة فقط: توليد زوج المفاتيح
//        node tools/generate-license.js genkeys
//      هذا يُنشئ tools/private-key.pem (احتفظ فيه بمكان آمن جداً)
//      وtools/public-key.pem — انسخ محتواه إلى licensing/license.js داخل PUBLIC_KEY_PEM
//
//   2) توليد ترخيص لعميل (بعد ما يرسل لك بصمة جهازه من شاشة "إدخال ترخيص"):
//        node tools/generate-license.js issue \
//          --customer "اسم المحل / العميل" \
//          --fingerprint "AB12-CD34-EF56-7890" \
//          --expires 2027-12-31 \
//          --out acme-store.lic
//      (بدون --expires = ترخيص دائم بدون تاريخ انتهاء)

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const args = process.argv.slice(2);
const command = args[0];

function getArg(name) {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 ? args[idx + 1] : null;
}

const keysDir = __dirname;
const privateKeyPath = process.env.NEXORA_LICENSE_PRIVATE_KEY_PATH
  ? path.resolve(process.env.NEXORA_LICENSE_PRIVATE_KEY_PATH)
  : path.join(keysDir, 'private-key.pem');
const publicKeyPath = process.env.NEXORA_LICENSE_PUBLIC_KEY_PATH
  ? path.resolve(process.env.NEXORA_LICENSE_PUBLIC_KEY_PATH)
  : path.join(keysDir, 'public-key.pem');

if (command === 'genkeys') {
  if (fs.existsSync(privateKeyPath)) {
    console.error('يوجد مفتاح خاص بالفعل هنا. احذفه يدوياً أولاً إن كنت متأكد من توليد زوج جديد (سيُبطل كل التراخيص القديمة).');
    process.exit(1);
  }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  fs.writeFileSync(privateKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  fs.writeFileSync(publicKeyPath, publicKey.export({ type: 'spki', format: 'pem' }));
  console.log('تم توليد زوج المفاتيح بنجاح:');
  console.log('  - المفتاح الخاص (سرّي، لا يُشارك):', privateKeyPath);
  console.log('  - المفتاح العام (انسخه لملف licensing/license.js):', publicKeyPath);
  console.log('\nمحتوى المفتاح العام:\n');
  console.log(fs.readFileSync(publicKeyPath, 'utf8'));
  process.exit(0);
}

if (command === 'issue') {
  const customerName = getArg('customer');
  const fingerprint = getArg('fingerprint');
  const expiresArg = getArg('expires');
  const outArg = getArg('out') || 'license.lic';

  if (!customerName || !fingerprint) {
    console.error('لازم تحدد --customer و --fingerprint');
    process.exit(1);
  }
  if (!fs.existsSync(privateKeyPath)) {
    console.error('لا يوجد مفتاح خاص. شغّل أولاً: node tools/generate-license.js genkeys');
    process.exit(1);
  }

  const privateKey = fs.readFileSync(privateKeyPath, 'utf8');
  const license = {
    // معرّف ثابت لهذا الترخيص بالذات، منفصل عن بصمة الجهاز — يُستخدم لاحقاً كمرجع للإبطال
    // عن بعد (أمر revoke تحت) حتى لو أُعيد إصدار ترخيص لنفس الجهاز أو تغيّرت بصمته
    licenseId: crypto.randomUUID(),
    customerName,
    fingerprint,
    issuedAt: new Date().toISOString(),
    expiresAt: expiresArg ? new Date(expiresArg).toISOString() : null,
  };

  const dataToSign = Buffer.from(JSON.stringify(license));
  const signature = crypto.sign(null, dataToSign, privateKey).toString('base64');

  const finalPayload = { ...license, signature };
  fs.writeFileSync(outArg, JSON.stringify(finalPayload, null, 2), 'utf8');
  console.log(`تم إنشاء ملف الترخيص: ${outArg}`);
  console.log(`معرّف الترخيص (احتفظ فيه لإبطاله لاحقاً عند الحاجة): ${license.licenseId}`);
  console.log('أرسل هذا الملف للعميل ليقوم باستيراده من شاشة "إدخال ترخيص" داخل التطبيق.');
  process.exit(0);
}

if (command === 'revoke') {
  const licenseId = getArg('licenseId');
  const fingerprint = getArg('fingerprint');
  const undo = args.includes('--undo');
  const inArg = getArg('in');
  const outArg = getArg('out') || 'pos-crl.json';

  if (!licenseId && !fingerprint) {
    console.error('لازم تحدد --licenseId (من رسالة أمر issue) و/أو --fingerprint لجهاز تريد إبطال كل تراخيصه');
    process.exit(1);
  }
  if (!fs.existsSync(privateKeyPath)) {
    console.error('لا يوجد مفتاح خاص. شغّل أولاً: node tools/generate-license.js genkeys');
    process.exit(1);
  }

  // نبني على القائمة الموجودة سابقاً (نفس ملف --out إن وُجد، أو --in صراحة) حتى لا نفقد
  // إبطالات سابقة كل مرة نشغّل هالأمر — القائمة المُوزَّعة يجب أن تبقى تراكمية
  let revokedLicenseIds = [];
  let revokedFingerprints = [];
  const inPath = inArg || (fs.existsSync(outArg) ? outArg : null);
  if (inPath && fs.existsSync(inPath)) {
    try {
      const prior = JSON.parse(fs.readFileSync(inPath, 'utf8'));
      revokedLicenseIds = Array.isArray(prior.revokedLicenseIds) ? prior.revokedLicenseIds : [];
      revokedFingerprints = Array.isArray(prior.revokedFingerprints) ? prior.revokedFingerprints : [];
    } catch {
      console.error(`تحذير: تعذّرت قراءة القائمة السابقة (${inPath})، سيتم إنشاء قائمة جديدة من الصفر`);
    }
  }

  if (undo) {
    if (licenseId) revokedLicenseIds = revokedLicenseIds.filter((id) => id !== licenseId);
    if (fingerprint) revokedFingerprints = revokedFingerprints.filter((fp) => fp !== fingerprint);
  } else {
    if (licenseId && !revokedLicenseIds.includes(licenseId)) revokedLicenseIds.push(licenseId);
    if (fingerprint && !revokedFingerprints.includes(fingerprint)) revokedFingerprints.push(fingerprint);
  }

  const privateKey = fs.readFileSync(privateKeyPath, 'utf8');
  const list = { issuedAt: new Date().toISOString(), revokedLicenseIds, revokedFingerprints };
  const signature = crypto.sign(null, Buffer.from(JSON.stringify(list)), privateKey).toString('base64');
  const finalPayload = { ...list, signature };
  fs.writeFileSync(outArg, JSON.stringify(finalPayload, null, 2), 'utf8');

  console.log(`${undo ? 'تم إلغاء الإبطال وتحديث' : 'تم تحديث'} قائمة الإبطال: ${outArg}`);
  console.log(`عدد معرّفات التراخيص المُبطَلة: ${revokedLicenseIds.length} | عدد بصمات الأجهزة المُبطَلة: ${revokedFingerprints.length}`);
  console.log('ارفع هذا الملف إلى نفس الرابط المضبوط بـ REVOCATION_LIST_URL في licensing/license.js حتى تصل الأجهزة له.');
  process.exit(0);
}

console.log(`
الاستخدام:
  node tools/generate-license.js genkeys
  node tools/generate-license.js issue --customer "اسم العميل" --fingerprint "XXXX-XXXX-XXXX-XXXX" [--expires 2027-12-31] [--out file.lic]
  node tools/generate-license.js revoke --licenseId <uuid> [--in pos-crl.json] [--out pos-crl.json]
  node tools/generate-license.js revoke --fingerprint "XXXX-XXXX-XXXX-XXXX" [--out pos-crl.json]   # يُبطل كل تراخيص هذا الجهاز
  node tools/generate-license.js revoke --licenseId <uuid> --undo [--out pos-crl.json]              # يُلغي إبطالاً سابقاً بالخطأ
`);
process.exit(1);
