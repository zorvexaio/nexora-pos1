'use strict';
// تطبيع نصوص البحث (عربي/تركي/إنجليزي) — يُطبَّق على اسم الصنف وعلى استعلام الكاشير بالطريقة نفسها
// (الخطأ الأشهر في بحث العربية: تطبيع الفهرس ونسيان الاستعلام، أو العكس).
//   عربي: توحيد الألف (أ إ آ ٱ → ا)، ى → ي، ة → ه، ؤ → و، ئ → ي، حذف التشكيل والتطويل،
//         تحويل الأرقام الهندية/الفارسية إلى 0-9.
//   تركي: İ I ı → i، وإزالة النقاط والذيول (ç ş ğ ü ö → c s g u o) فيجد «cay» الصنف «Çay».
//   عام: حروف صغيرة، وأي رموز/علامات ترقيم تتحول لمسافة، وتُدمج المسافات.
const MAX_CACHE = 60000;
const cache = new Map();

const EXPLICIT_MAP = {
  'أ': 'ا', 'إ': 'ا', 'آ': 'ا', 'ٱ': 'ا', 'ى': 'ي', 'ة': 'ه', 'ؤ': 'و', 'ئ': 'ي',
  'ی': 'ي', 'ې': 'ي', 'ک': 'ك', 'ھ': 'ه', 'ہ': 'ه', 'ۀ': 'ه', 'گ': 'ك',
};
const EXPLICIT_RE = /[أإآٱىةؤئیېکھہۀگ]/g;
const ARABIC_MARKS_RE = /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/g; // تشكيل + تطويل
const LATIN_MARKS_RE = /[\u0300-\u036F]/g;

function normalizeDigits(s) {
  return s.replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06F0));
}

function normalizeSearchText(input) {
  if (input === null || input === undefined) return '';
  const raw = String(input);
  if (!raw) return '';
  const hit = cache.get(raw);
  if (hit !== undefined) return hit;
  let s = raw.replace(/İ/g, 'i').replace(/I/g, 'i').replace(/ı/g, 'i');
  s = normalizeDigits(s);
  s = s.normalize('NFKD').replace(LATIN_MARKS_RE, '').replace(ARABIC_MARKS_RE, '');
  s = s.replace(EXPLICIT_RE, (ch) => EXPLICIT_MAP[ch] || ch);
  s = s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
  if (cache.size >= MAX_CACHE) cache.clear();
  cache.set(raw, s);
  return s;
}

// الكلمات المفردة للاستعلام (بحد أقصى 6) — كل كلمة يجب أن تظهر في الاسم بأي ترتيب
function searchTokens(input, max = 6) {
  const norm = normalizeSearchText(input);
  return norm ? norm.split(' ').slice(0, max) : [];
}

// هروب محارف LIKE الخاصة (%، _، \) لاستخدامها مع ESCAPE '\'
function escapeLike(text) {
  return String(text).replace(/[\\%_]/g, (c) => `\\${c}`);
}

// تحويل الأرقام الهندية/الفارسية فقط إلى 0-9 (للباركود والرمز: بعض تخطيطات لوحة المفاتيح العربية تُخرج ٠١٢٣
// من الماسح الضوئي فلا يطابق الباركود المخزَّن)
function toAsciiDigits(input) {
  return normalizeDigits(String(input === null || input === undefined ? '' : input));
}

module.exports = { normalizeSearchText, searchTokens, escapeLike, toAsciiDigits };
