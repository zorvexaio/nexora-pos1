// ==========================================================
// فك تشفير باركود الوزن المتغيّر (Variable-Weight Barcode) — نفس المعيار المستخدم عالمياً
// من موازين الخضار والفواكه بالسوبرماركت: باركود EAN-13 يبدأ بمقدّمة ثابتة (افتراضياً "20"،
// قابلة للتغيير من الإعدادات حسب نوع الميزان)، يليها كود صنف قصير (PLU) ثم الوزن بالجرام،
// وآخر رقم هو رقم تحقق (checksum) قياسي.
//
// الفكرة: الكاشير لا يكتب أو يضيف أي شيء يدوياً — يمسح الباركود المطبوع من الميزان فقط،
// والنظام يتعرّف على الصنف من كود الـ PLU المُضمَّن بالباركود، ويحسب السعر تلقائياً
// (سعر الكيلوغرام المسجَّل للمنتج × الوزن المقروء من الباركود نفسه).
// ==========================================================

const DEFAULT_PREFIX = '20';
const PLU_LENGTH = 5;
const WEIGHT_LENGTH = 5; // بالجرام (يدعم أوزاناً حتى 99.999 كغم)

function ean13CheckDigit(first12Digits) {
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    const digit = Number(first12Digits[i]);
    sum += i % 2 === 0 ? digit : digit * 3;
  }
  return (10 - (sum % 10)) % 10;
}

// يحاول فك باركود وزن متغيّر. يُرجع { pluCode, weightKg } عند النجاح، أو null إن لم يطابق
// الصيغة أو فشل التحقق من رقم التحقق (checksum) — لتفادي الخلط مع باركود منتج عادي بالصدفة.
function parseWeightedBarcode(barcode, prefix = DEFAULT_PREFIX) {
  if (!barcode || typeof barcode !== 'string') return null;
  const trimmed = barcode.trim();
  if (trimmed.length !== 13) return null;
  if (!/^\d{13}$/.test(trimmed)) return null;
  if (!trimmed.startsWith(prefix)) return null;

  const first12 = trimmed.slice(0, 12);
  const checkDigit = Number(trimmed[12]);
  if (ean13CheckDigit(first12) !== checkDigit) return null;

  const pluStart = prefix.length;
  const pluCode = trimmed.slice(pluStart, pluStart + PLU_LENGTH);
  const weightGrams = Number(trimmed.slice(pluStart + PLU_LENGTH, pluStart + PLU_LENGTH + WEIGHT_LENGTH));
  if (!Number.isFinite(weightGrams)) return null;

  return { pluCode, weightKg: weightGrams / 1000 };
}

// يبني باركوداً بنفس الصيغة — يُستخدم لطباعة ملصق تجريبي أو لأغراض الاختبار الذاتي.
function buildWeightedBarcode(pluCode, weightKg, prefix = DEFAULT_PREFIX) {
  const pluStr = String(pluCode).padStart(PLU_LENGTH, '0').slice(-PLU_LENGTH);
  const weightGrams = Math.round(weightKg * 1000);
  const weightStr = String(weightGrams).padStart(WEIGHT_LENGTH, '0').slice(-WEIGHT_LENGTH);
  const first12 = `${prefix}${pluStr}${weightStr}`;
  const checkDigit = ean13CheckDigit(first12);
  return `${first12}${checkDigit}`;
}

module.exports = { parseWeightedBarcode, buildWeightedBarcode, ean13CheckDigit, DEFAULT_PREFIX, PLU_LENGTH, WEIGHT_LENGTH };
