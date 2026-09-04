// ==========================================================
// محرّك التحقق من الترخيص — يُحمَّل فقط من العملية الرئيسية (main.js) قبل فتح أي نافذة
// حتى لا يقدر أحد يتجاوز التحقق من الواجهة (renderer) بأدوات المطوّر، مهما كانت.
//
// آلية العمل باختصار:
//  1) عندك أنت (البائع) مفتاح خاص (tools/private-key.pem) ولّدته بـ:
//       node tools/generate-license.js genkeys
//     المفتاح العام الناتج تحطّه هون تحت PUBLIC_KEY_PEM (آمن يكون داخل التطبيق الموزَّع).
//  2) العميل يرسلّك بصمة جهازه (من شاشة "إدخال ترخيص")، وانت تصدر له ملف .lic موقّع بمفتاحك
//     الخاص عبر: node tools/generate-license.js issue --customer "..." --fingerprint "..."
//  3) هالملف يتفحّص هون: التوقيع (لازم يطابق مفتاحك العام)، بصمة الجهاز، تاريخ الانتهاء،
//     وقائمة إبطال (revocation list) تحاول تتحدّث دورياً عن بعد وإلا تعتمد آخر نسخة محفوظة محلياً.
//
// لا يوجد أي اعتماد على حزم خارجية هون عمداً — فقط Node.js المدمجة (crypto/os/fs) حتى يبقى
// هالملف بسيط قدر الإمكان ومستقل عن أي تحديث لحزمة قد يكسره.
// ==========================================================

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { safeStorage } = require('electron');
const { execFileSync } = require('child_process');

// ------------------------------------------------------------------
// المفتاح العام لديك (Ed25519 SPKI PEM). استبدله بمخرجات:
//   node tools/generate-license.js genkeys
// طالما هالمفتاح لا يزال بقيمته الافتراضية (فاضي)، كل عملية تحقق ترخيص سترفض بصمت
// (malformed_license) حتى لا يعمل التطبيق بمفتاح placeholder بالخطأ.
// ------------------------------------------------------------------
const PUBLIC_KEY_PEM = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA3yhTh9PCgRfdl43H+pgxKZwDBImduwTd9XWQmGzpGtg=\n-----END PUBLIC KEY-----\n";

const REVOCATION_LIST_URL = String(process.env.NEXORA_REVOCATION_LIST_URL || '').trim();

const LICENSE_FILE_NAME = 'license.lic';
const CRL_FILE_NAME = 'pos-crl.json';
const DEVICE_ID_FILE_NAME = 'device-id.txt';
const FETCH_TIMEOUT_MS = 8000;
const DEVICE_COMMAND_TIMEOUT_MS = 2000;
const CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000;
const LAST_SEEN_TIME_FILE_NAME = 'license-last-seen.bin';
const MAX_LICENSE_INPUT_BYTES = 64 * 1024;


function readProtectedLastSeenMs(userDataPath) {
  try {
    if (!safeStorage.isEncryptionAvailable()) return 0;
    const filePath = path.join(userDataPath, LAST_SEEN_TIME_FILE_NAME);
    if (!fs.existsSync(filePath)) return 0;
    const plain = safeStorage.decryptString(fs.readFileSync(filePath)).trim();
    const value = Number(plain);
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch (_) {
    return 0;
  }
}

function writeProtectedLastSeenMs(userDataPath, ms) {
  try {
    if (!safeStorage.isEncryptionAvailable()) return;
    fs.mkdirSync(userDataPath, { recursive: true });
    const filePath = path.join(userDataPath, LAST_SEEN_TIME_FILE_NAME);
    fs.writeFileSync(filePath, safeStorage.encryptString(String(Math.trunc(ms))), { mode: 0o600 });
  } catch (_) {
    // Non-fatal: licensing remains signature/expiry protected even if the local clock guard cannot persist.
  }
}

function enforceMonotonicClock(userDataPath, nowMs) {
  const previous = readProtectedLastSeenMs(userDataPath);
  if (previous > 0 && nowMs + CLOCK_SKEW_TOLERANCE_MS < previous) {
    return { ok: false, previous, now: nowMs };
  }
  if (nowMs > previous) writeProtectedLastSeenMs(userDataPath, nowMs);
  return { ok: true, previous, now: nowMs };
}

function hasRealPublicKey() {
  return !PUBLIC_KEY_PEM.includes('REPLACE_WITH_YOUR_GENERATED_PUBLIC_KEY');
}

function getPublicKeyObject() {
  return crypto.createPublicKey(PUBLIC_KEY_PEM);
}

// ------------------------------------------------------------------
// بصمة الجهاز
// ------------------------------------------------------------------

// يحاول يجيب معرّف ثابت فعلي من نظام التشغيل (لا يتغيّر بإعادة تثبيت التطبيق، بعكس أي شيء
// نولّده نحن ونخزّنه بملف). لو فشلت كل المحاولات (صلاحيات، نظام غير مدعوم...)، نرجع null
// ونعتمد بعدها على معرّف نولّده ونخزّنه محلياً (أضعف قليلاً لأنه يضيع لو محي مجلد بيانات
// التطبيق، لكنه أفضل من رفض العمل بالكامل).
function readOsStableId() {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync(
        'reg',
        ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'],
        { encoding: 'utf8', windowsHide: true, timeout: DEVICE_COMMAND_TIMEOUT_MS, killSignal: 'SIGTERM' }
      );
      const match = out.match(/MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]+)/);
      if (match) return match[1];
    } else if (process.platform === 'darwin') {
      const out = execFileSync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf8', timeout: DEVICE_COMMAND_TIMEOUT_MS, killSignal: 'SIGTERM' });
      const match = out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
      if (match) return match[1];
    } else {
      for (const p of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
        if (fs.existsSync(p)) {
          const id = fs.readFileSync(p, 'utf8').trim();
          if (id) return id;
        }
      }
    }
  } catch (err) {
    // نتابع على الاحتياطي بالأسفل بصمت — أي خطأ هون (صلاحيات، أمر غير موجود...) غير حرج
  }
  return null;
}

// احتياطي: معرّف عشوائي نولّده أول مرة ونخزّنه بمجلد بيانات التطبيق حتى يبقى ثابتاً
// بين مرات التشغيل (لكنه يُفقد لو انمحى مجلد بيانات المستخدم أو أُعيد تثبيت النظام بالكامل)
function getOrCreateFallbackId(userDataPath) {
  const filePath = path.join(userDataPath, DEVICE_ID_FILE_NAME);
  try {
    if (fs.existsSync(filePath)) {
      const id = fs.readFileSync(filePath, 'utf8').trim();
      if (id) return id;
    }
  } catch (err) {
    // نتابع لتوليد معرّف جديد
  }
  const id = crypto.randomUUID();
  try {
    fs.mkdirSync(userDataPath, { recursive: true });
    fs.writeFileSync(filePath, id, 'utf8');
  } catch (err) {
    // لو تعذّر الحفظ (صلاحيات مثلاً)، سيُعاد توليد معرّف مختلف بالتشغيلة الجاية — غير مثالي
    // لكن أفضل من رمي استثناء يمنع فتح التطبيق بالكامل
  }
  return id;
}

// يُرجع بصمة الجهاز بصيغة مقروءة للعرض على العميل (مثال: "AB12-CD34-EF56-7890")
// userDataPath اختياري: يُستخدم فقط لو تعذّر الحصول على معرّف نظام تشغيل ثابت
function getDeviceFingerprint(userDataPath) {
  const stableId = readOsStableId();
  const raw = stableId || getOrCreateFallbackId(userDataPath || getDefaultUserDataPath());
  const hash = crypto.createHash('sha256').update(`${raw}|${process.platform}`).digest('hex').toUpperCase();
  const groups = hash.slice(0, 16).match(/.{1,4}/g);
  return groups.join('-');
}

// احتياطي بسيط لو استُدعيت الدالة بدون تمرير userDataPath (مثلاً من شاشة قبل تجهيز app.getPath)
function getDefaultUserDataPath() {
  const base = process.env.APPDATA || (process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support') : path.join(os.homedir(), '.config'));
  return path.join(base, 'nexora-pos');
}

// ------------------------------------------------------------------
// التحقق من التوقيع
// ------------------------------------------------------------------

// يعيد بناء نفس الترتيب/الشكل بالضبط الذي وقّعت به tools/generate-license.js كائن الترخيص،
// حتى يطابق التوقيع. أي تغيير بترتيب الحقول هون يكسر التحقق من كل التراخيص الصادرة سابقاً.
function licenseSigningPayload(license) {
  return JSON.stringify({
    licenseId: license.licenseId,
    customerName: license.customerName,
    fingerprint: license.fingerprint,
    issuedAt: license.issuedAt,
    expiresAt: license.expiresAt,
  });
}

function verifySignature(payloadString, signatureBase64) {
  if (!hasRealPublicKey()) return false;
  try {
    const publicKey = getPublicKeyObject();
    const signature = Buffer.from(signatureBase64, 'base64');
    return crypto.verify(null, Buffer.from(payloadString), publicKey, signature);
  } catch (err) {
    return false;
  }
}

function isWellFormedLicenseObject(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  if (typeof obj.licenseId !== 'string' || !/^[0-9a-fA-F-]{36}$/.test(obj.licenseId)) return false;
  if (typeof obj.customerName !== 'string' || obj.customerName.length > 200) return false;
  if (typeof obj.fingerprint !== 'string' || !/^[A-F0-9]{4}(?:-[A-F0-9]{4}){3}$/.test(obj.fingerprint)) return false;
  if (typeof obj.issuedAt !== 'string' || !Number.isFinite(new Date(obj.issuedAt).getTime())) return false;
  if (!(obj.expiresAt === null || obj.expiresAt === undefined || (typeof obj.expiresAt === 'string' && Number.isFinite(new Date(obj.expiresAt).getTime())))) return false;
  if (typeof obj.signature !== 'string' || obj.signature.length < 16 || obj.signature.length > 512 || !/^[A-Za-z0-9+/=]+$/.test(obj.signature)) return false;
  return true;
}

// ------------------------------------------------------------------
// قائمة الإبطال (Revocation list)
// ------------------------------------------------------------------

function readLocalCrl(userDataPath) {
  const crlPath = path.join(userDataPath, CRL_FILE_NAME);
  try {
    if (!fs.existsSync(crlPath)) return null;
    const parsed = JSON.parse(fs.readFileSync(crlPath, 'utf8'));
    const payload = JSON.stringify({
      issuedAt: parsed.issuedAt,
      revokedLicenseIds: parsed.revokedLicenseIds,
      revokedFingerprints: parsed.revokedFingerprints,
    });
    if (!verifySignature(payload, parsed.signature)) return null; // قائمة مزوّرة أو تالفة — تُهمَل
    return parsed;
  } catch (err) {
    return null;
  }
}

function isRevoked(license, crl) {
  if (!crl) return false;
  const ids = Array.isArray(crl.revokedLicenseIds) ? crl.revokedLicenseIds : [];
  const fps = Array.isArray(crl.revokedFingerprints) ? crl.revokedFingerprints : [];
  return ids.includes(license.licenseId) || fps.includes(license.fingerprint);
}

// يحاول تحميل قائمة الإبطال من REVOCATION_LIST_URL وتخزينها محلياً بعد التحقق من توقيعها.
// يفشل بصمت (يبقي النسخة المحلية القديمة كما هي) لو ما في اتصال أو الرابط غير مضبوط —
// النظام يعمل دائماً بآخر نسخة محفوظة محلياً بدل ما يتعطّل لعدم وجود إنترنت.
async function refreshRevocationList(userDataPath) {
  if (!REVOCATION_LIST_URL) return;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const response = await fetch(REVOCATION_LIST_URL, { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) return;
    const parsed = await response.json();
    const payload = JSON.stringify({
      issuedAt: parsed.issuedAt,
      revokedLicenseIds: parsed.revokedLicenseIds,
      revokedFingerprints: parsed.revokedFingerprints,
    });
    if (!verifySignature(payload, parsed.signature)) return; // رفض قائمة موقّعة بمفتاح خاطئ/مزوّرة
    fs.mkdirSync(userDataPath, { recursive: true });
    fs.writeFileSync(path.join(userDataPath, CRL_FILE_NAME), JSON.stringify(parsed), 'utf8');
  } catch (err) {
    // بدون إنترنت أو رابط غير متاح مؤقتاً — نتابع بصمت بآخر نسخة محلية
  }
}

// ------------------------------------------------------------------
// التحقق الرئيسي — يُستدعى عند كل إقلاع وبفاصل دوري
// ------------------------------------------------------------------

function verifyLicense(userDataPath) {
  if (!hasRealPublicKey()) return { valid: false, reason: 'malformed_license' };

  const licensePath = path.join(userDataPath, LICENSE_FILE_NAME);
  if (!fs.existsSync(licensePath)) return { valid: false, reason: 'no_license_file' };

  let license;
  try {
    license = JSON.parse(fs.readFileSync(licensePath, 'utf8'));
  } catch (err) {
    return { valid: false, reason: 'corrupt_file' };
  }

  if (!isWellFormedLicenseObject(license)) return { valid: false, reason: 'malformed_license' };

  if (!verifySignature(licenseSigningPayload(license), license.signature)) {
    return { valid: false, reason: 'invalid_signature' };
  }

  const currentFingerprint = getDeviceFingerprint(userDataPath);
  if (license.fingerprint !== currentFingerprint) {
    return { valid: false, reason: 'fingerprint_mismatch' };
  }

  const clock = enforceMonotonicClock(userDataPath, Date.now());
  if (!clock.ok) return { valid: false, reason: 'clock_rollback_detected' };

  if (license.expiresAt && new Date(license.expiresAt).getTime() < clock.now) {
    return { valid: false, reason: 'expired' };
  }

  const crl = readLocalCrl(userDataPath);
  if (isRevoked(license, crl)) return { valid: false, reason: 'revoked' };

  return { valid: true, license };
}

// ------------------------------------------------------------------
// تفعيل ترخيص جديد (من شاشة "إدخال ترخيص")
// ------------------------------------------------------------------

function activateLicense(userDataPath, fileContent) {
  if (!hasRealPublicKey()) {
    return { success: false, message: 'لم يُضبط مفتاح التحقق العام بعد. تواصل مع المورّد.' };
  }

  if (typeof fileContent !== 'string') {
    return { success: false, message: 'محتوى ملف الترخيص غير صالح.' };
  }
  if (Buffer.byteLength(fileContent, 'utf8') > MAX_LICENSE_INPUT_BYTES) {
    return { success: false, message: 'ملف الترخيص أكبر من الحد المسموح.' };
  }

  let license;
  try {
    license = JSON.parse(fileContent);
  } catch (err) {
    return { success: false, message: 'ملف الترخيص تالف أو غير قابل للقراءة.' };
  }

  if (!isWellFormedLicenseObject(license)) {
    return { success: false, message: 'ملف الترخيص غير مكتمل أو بصيغة غير صحيحة.' };
  }

  if (!verifySignature(licenseSigningPayload(license), license.signature)) {
    return { success: false, message: 'توقيع الترخيص غير صالح. تأكد أنك حصلت عليه من المورّد الرسمي.' };
  }

  const currentFingerprint = getDeviceFingerprint(userDataPath);
  if (license.fingerprint !== currentFingerprint) {
    return { success: false, message: 'هذا الترخيص صادر لجهاز آخر. أرسل بصمة هذا الجهاز للمورّد لإصدار ترخيص جديد.' };
  }

  const clock = enforceMonotonicClock(userDataPath, Date.now());
  if (!clock.ok) {
    return { success: false, message: 'تم اكتشاف رجوع في ساعة الجهاز. اضبط التاريخ والوقت بشكل صحيح ثم أعد المحاولة.' };
  }

  if (license.expiresAt) {
    const expiresMs = new Date(license.expiresAt).getTime();
    if (!Number.isFinite(expiresMs)) {
      return { success: false, message: 'تاريخ انتهاء الترخيص غير صالح.' };
    }
    if (expiresMs < clock.now) {
      return { success: false, message: 'هذا الترخيص منتهي الصلاحية.' };
    }
  }

  const crl = readLocalCrl(userDataPath);
  if (isRevoked(license, crl)) {
    return { success: false, message: 'تم إبطال هذا الترخيص. تواصل مع المورّد.' };
  }

  try {
    fs.mkdirSync(userDataPath, { recursive: true });
    fs.writeFileSync(path.join(userDataPath, LICENSE_FILE_NAME), JSON.stringify(license, null, 2), 'utf8');
  } catch (err) {
    return { success: false, message: 'تعذّر حفظ الترخيص على هذا الجهاز: ' + err.message };
  }

  return { success: true };
}

module.exports = {
  getDeviceFingerprint,
  verifyLicense,
  activateLicense,
  refreshRevocationList,
};


