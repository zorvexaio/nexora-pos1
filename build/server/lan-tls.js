// ==========================================================
// شهادة TLS ذاتية التوقيع لخادم مزامنة LAN المُضمَّن (وضع "الجهاز الرئيسي").
// ==========================================================
// ليش شهادة ذاتية التوقيع بالذات (لا نستخدم Let's Encrypt أو أي CA حقيقي)؟
// لأن هذا خادم على الشبكة المحلية فقط (بلا اسم نطاق عام)، والهدف من HTTPS هنا مو "يثق فيه
// المتصفح"، الهدف هو تشفير حركة المرور بين كاشيرات نفس المحل (بيانات مبيعات/عملاء حساسة تمر
// بالشبكة اللاسلكية للمحل) ومنع أي جهاز آخر على نفس الشبكة من التنصت أو التلاعب بالبيانات
// بهجوم "الوسيط" (MITM) — مو منع انتحال هوية الخادم أمام جهة خارجية تثق بمرجع شهادات عام.
//
// آلية الثقة المستخدمة (Trust-On-First-Use / تثبيت الشهادة بالبصمة):
// عند الاقتران (server/sync-server.js + main.js: lan:pairWithDevice)، الطرفية تتصل بالجهاز
// الرئيسي عبر HTTPS دون معرفة أي شهادة مسبقاً، لكن الطلب نفسه محمي برمز اقتران قصير الأمد
// (8 أرقام، صالح 5 دقائق) يُقرأ يدوياً من شاشة الجهاز الرئيسي ويُكتب بالطرفية — أي أن هجوم
// الوسيط باللحظة الأولى يتطلب معرفة الرمز أصلاً. بمجرد نجاح الاقتران، تُحفَظ بصمة SHA-256
// الفعلية للشهادة (وليس أي قيمة يُرسلها الخادم بجسم الرد — تُقرأ من مقبس TLS نفسه) وتُستخدم
// كتثبيت (pinning) لكل الطلبات اللاحقة؛ أي شهادة مختلفة بعدها تُرفَض فوراً حتى لو كانت
// "صالحة" من منظور أي مرجع شهادات، لأننا أصلاً لا نتحقق من سلسلة الثقة إطلاقاً هنا، فقط من
// تطابق البصمة المحفوظة. هذا هو نفس النمط المُستخدَم فعلياً بتطبيقات مشابهة (مثل الاتصال
// المحلي بأجهزة IoT أو خوادم بيتية ذاتية الاستضافة).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ---------- ترميز ASN.1 DER بسيط، يكفي بالضبط لبناء شهادة X.509v3 ذاتية التوقيع ----------
function derLength(len) {
  if (len < 0x80) return Buffer.from([len]);
  const bytes = [];
  let n = len;
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
function tlv(tag, content) {
  return Buffer.concat([Buffer.from([tag]), derLength(content.length), content]);
}
const seq = (...parts) => tlv(0x30, Buffer.concat(parts));
const set = (...parts) => tlv(0x31, Buffer.concat(parts));
function derInt(value) {
  let buf;
  if (Buffer.isBuffer(value)) {
    buf = value;
  } else {
    // عدد صحيح موجب صغير (نستخدمها فقط للنسخة رقم 2 = v3)
    buf = Buffer.from([value]);
  }
  // ترميز DER للأعداد الصحيحة يجب أن يكون "أقلّياً" (minimal): لازم نحذف أي بايتات صفر زائدة
  // بالمقدمة أولاً (وإلا يرفضها أي محلّل ASN.1 صارم بخطأ "illegal padding" — هذا كان يحصل
  // عشوائياً هنا مع الرقم التسلسلي العشوائي كل ما بدأ بايت 0x00 بالصدفة)، ثم نضيف بايت 0x00
  // واحد بالمقدمة فقط لو صار أول بايت متبقٍّ مرفوع البت العالي (لتبقى القيمة موجبة).
  let start = 0;
  while (start < buf.length - 1 && buf[start] === 0x00 && !(buf[start + 1] & 0x80)) start += 1;
  buf = buf.subarray(start);
  if (buf.length === 0) buf = Buffer.from([0x00]);
  if (buf[0] & 0x80) buf = Buffer.concat([Buffer.from([0x00]), buf]);
  return tlv(0x02, buf);
}
function derOid(bytes) {
  return tlv(0x06, Buffer.from(bytes));
}
function derUtf8String(str) {
  return tlv(0x0c, Buffer.from(str, 'utf8'));
}
function derIa5String(str) {
  return tlv(0x16, Buffer.from(str, 'ascii'));
}
function derBool(value) {
  return tlv(0x01, Buffer.from([value ? 0xff : 0x00]));
}
function derBitString(buf, unusedBits = 0) {
  return tlv(0x03, Buffer.concat([Buffer.from([unusedBits]), buf]));
}
function derOctetString(buf) {
  return tlv(0x04, buf);
}
function derExplicit(tagNumber, content) {
  return tlv(0xa0 | tagNumber, content);
}
function derContextPrimitive(tagNumber, buf) {
  return tlv(0x80 | tagNumber, buf);
}

// OIDs الثابتة اللازمة (مُرمَّزة يدوياً — لا حاجة لمكتبة ASN.1 خارجية لأعداد قليلة معروفة)
const OID = {
  sha256WithRSAEncryption: [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b],
  commonName: [0x55, 0x04, 0x03],
  subjectAltName: [0x55, 0x1d, 0x11],
  basicConstraints: [0x55, 0x1d, 0x13],
  keyUsage: [0x55, 0x1d, 0x0f],
  extKeyUsage: [0x55, 0x1d, 0x25],
  serverAuth: [0x2b, 0x06, 0x01, 0x05, 0x05, 0x07, 0x03, 0x01],
};

function algorithmIdentifierSha256Rsa() {
  return seq(derOid(OID.sha256WithRSAEncryption), tlv(0x05, Buffer.alloc(0))); // NULL parameters
}

function nameWithCommonName(cn) {
  return seq(set(seq(derOid(OID.commonName), derUtf8String(cn))));
}

function utcTime(date) {
  const yy = String(date.getUTCFullYear() % 100).padStart(2, '0');
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mi = String(date.getUTCMinutes()).padStart(2, '0');
  const ss = String(date.getUTCSeconds()).padStart(2, '0');
  return tlv(0x17, Buffer.from(`${yy}${mm}${dd}${hh}${mi}${ss}Z`, 'ascii'));
}

function buildExtensions(sanEntries) {
  // subjectAltName: كل عناوين IPv4 المحلية الحالية + localhost/127.0.0.1 — لكن التحقق الفعلي
  // بجانب العميل يعتمد على تثبيت البصمة (انظر التعليق أعلى)، فهذا الحقل هنا للتوافق فقط
  // (بعض عملاء TLS الصارمين يرفضون شهادة بلا SAN إطلاقاً حتى لو كنا لن نعتمد عليه للتحقق).
  const sanValue = seq(
    ...sanEntries.map((entry) =>
      entry.type === 'ip'
        ? derContextPrimitive(7, Buffer.from(entry.value.split('.').map(Number)))
        : tlv(0x82, Buffer.from(entry.value, 'ascii')) // dNSName = context-specific primitive [2]
    )
  );
  const sanExt = seq(derOid(OID.subjectAltName), derOctetString(sanValue));

  const basicConstraintsValue = seq(); // cA=false افتراضياً (نتركه فارغاً)
  const basicConstraintsExt = seq(derOid(OID.basicConstraints), derBool(true), derOctetString(basicConstraintsValue));

  // keyUsage: digitalSignature (bit 0) + keyEncipherment (bit 2) = 0b10100000 = 0xA0
  const keyUsageValue = derBitString(Buffer.from([0xa0]), 5);
  const keyUsageExt = seq(derOid(OID.keyUsage), derBool(true), derOctetString(keyUsageValue));

  const ekuValue = seq(derOid(OID.serverAuth));
  const ekuExt = seq(derOid(OID.extKeyUsage), derOctetString(ekuValue));

  return derExplicit(3, seq(sanExt, basicConstraintsExt, keyUsageExt, ekuExt));
}

// ينشئ شهادة X.509v3 ذاتية التوقيع (RSA-2048 + SHA-256) صالحة لعدد سنوات مُحدَّد
function generateSelfSignedCert({ commonName, sanEntries, validityYears = 10 }) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' });

  const now = new Date();
  const notBefore = new Date(now.getTime() - 24 * 60 * 60 * 1000); // نتساهل بيوم للخلف تجنّباً لفروق ساعة النظام
  const notAfter = new Date(now.getTime() + validityYears * 365 * 24 * 60 * 60 * 1000);

  const serialNumber = crypto.randomBytes(16);
  const tbs = seq(
    derExplicit(0, derInt(2)), // version v3
    derInt(serialNumber),
    algorithmIdentifierSha256Rsa(),
    nameWithCommonName(commonName),
    seq(utcTime(notBefore), utcTime(notAfter)),
    nameWithCommonName(commonName),
    spkiDer,
    buildExtensions(sanEntries)
  );

  const signature = crypto.sign('sha256', tbs, privateKey);
  const certDer = seq(tbs, algorithmIdentifierSha256Rsa(), derBitString(signature, 0));

  const certPem = `-----BEGIN CERTIFICATE-----\n${certDer.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;
  const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const fingerprint256 = crypto.createHash('sha256').update(certDer).digest('hex').toUpperCase().match(/.{1,2}/g).join(':');

  return { certPem, keyPem, fingerprint256 };
}

function certPaths(userDataDir) {
  return {
    key: path.join(userDataDir, 'lan-tls-key.pem'),
    cert: path.join(userDataDir, 'lan-tls-cert.pem'),
  };
}

// يحمّل شهادة/مفتاح محفوظين مسبقاً، أو يولّد زوجاً جديداً أول مرة ويحفظه (يبقى ثابتاً بعدها
// عبر إعادة تشغيل التطبيق، حتى لا تتغيّر البصمة المُثبَّتة عند الطرفيات المُقترنة مسبقاً)
function getOrCreateServerCert(userDataDir, { sanEntries }) {
  const { key: keyPath, cert: certPath } = certPaths(userDataDir);
  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    const certPem = fs.readFileSync(certPath, 'utf8');
    const keyPem = fs.readFileSync(keyPath, 'utf8');
    const der = Buffer.from(certPem.replace(/-----[^-]+-----|\s+/g, ''), 'base64');
    const fingerprint256 = crypto.createHash('sha256').update(der).digest('hex').toUpperCase().match(/.{1,2}/g).join(':');
    return { certPem, keyPem, fingerprint256 };
  }
  const generated = generateSelfSignedCert({ commonName: 'nexora-pos-lan', sanEntries, validityYears: 15 });
  fs.writeFileSync(keyPath, generated.keyPem, { mode: 0o600 });
  fs.writeFileSync(certPath, generated.certPem, { mode: 0o600 });
  return generated;
}

module.exports = { generateSelfSignedCert, getOrCreateServerCert, certPaths };
