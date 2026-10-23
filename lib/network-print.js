'use strict';

// طباعة شبكية مباشرة (Raw ESC/POS عبر TCP، بروتوكول JetDirect القياسي على المنفذ 9100)
// بدون أي حاجة لتسجيل الطابعة كطابعة ويندوز.
//
// لماذا نحوّل الصفحة إلى صورة (raster) بدل إرسال نص عادي؟
// لأن أغلب طابعات ESC/POS الرخيصة (زي هذه الطابعة الصينية) لا تدعم ترميز
// النصوص العربية (لا توجد صفحة رموز CP864/Arabic مضمّنة فيها غالباً)، فإرسال
// نص عربي خام كان سيطبع رموزاً غير مفهومة. الحل الآمن: نلتقط الإيصال كما هو
// معروض فعلياً على الشاشة (بعد أن يرسمه Chromium بشكل صحيح، عربي أو غيره)
// كصورة، ثم نحوّل هذه الصورة إلى بتات أبيض/أسود ونرسلها كأمر "طباعة صورة"
// (GS v 0) الذي تدعمه كل طابعات ESC/POS تقريباً بغض النظر عن اللغة.

const net = require('net');
const { nativeImage } = require('electron');

const ESC = 0x1b;
const GS = 0x1d;

/**
 * يحوّل NativeImage إلى Buffer بصيغة أمر ESC/POS لطباعة صورة نقطية (GS v 0).
 *
 * ملاحظة أداء مهمة: هذا التحويل يمر بيكسل بيكسل (قد يصل لمئات الآلاف من
 * البكسلات للإيصال الواحد). عملية Electron الرئيسية (main process) خيط واحد
 * فقط، وأي حلقة تكرار متزامنة (synchronous) طويلة فيها كانت تُجمّد **التطبيق
 * كله** (كل النوافذ، كل الأزرار، كل حقول الإدخال) لحد ما تخلص - وهو ما كان
 * يظهر للمستخدم كـ"تجمد مفاجئ" أو "الأرقام مش بتتسجل" لو كان بيكتب في نفس
 * لحظة الطباعة. الحل: نعالج الصورة صفاً صفاً ونرجّع التحكم لدورة الأحداث
 * (event loop) كل عدد قليل من الصفوف عبر setImmediate، حتى تفضل بقية
 * العملية (فتح نوافذ، استقبال ضغطات لوحة المفاتيح، ردود IPC) شغالة بينما
 * المعالجة مستمرة في الخلفية.
 * @param {Electron.NativeImage} image
 * @param {number} maxDotsWidth عرض الورق بالنقاط (مثلاً 576 لورق 80مم عند 203dpi)
 * @returns {Promise<Buffer>}
 */
// قصّ الفراغ الأبيض أسفل الصورة النقطية: آخر صف فيه حبر + هامش صغير. يمنع هدر الورق عندما تكون نافذة
// الالتقاط أطول من المحتوى (مثلاً تذكرة مطبخ بصنف واحد). raster = بايتات الصفوف المتتالية.
function trimRasterBottom(raster, bytesPerRow, height, marginRows = 8) {
  if (!bytesPerRow || !height) return { raster, height };
  let lastInkRow = -1;
  for (let y = height - 1; y >= 0 && lastInkRow < 0; y--) {
    const start = y * bytesPerRow;
    for (let i = 0; i < bytesPerRow; i++) {
      if (raster[start + i] !== 0) { lastInkRow = y; break; }
    }
  }
  const keep = lastInkRow < 0 ? 1 : Math.min(height, lastInkRow + 1 + Math.max(0, marginRows));
  return { raster: raster.subarray(0, keep * bytesPerRow), height: keep };
}

async function imageToEscPosRaster(image, maxDotsWidth, options = {}) {
  const size = image.getSize();
  if (!size.width || !size.height) return Buffer.alloc(0);

  // نصغّر الصورة لعرض الورق فقط إن كانت أعرض منه (لا نكبّرها أبداً حفاظاً على الجودة)
  let scaled = image;
  if (size.width > maxDotsWidth) {
    scaled = image.resize({ width: maxDotsWidth });
  }
  const { width, height } = scaled.getSize();
  const bitmap = scaled.toBitmap(); // Buffer خام 4 بايت لكل بكسل (ترتيب القنوات غير مهم هنا لأننا نحسب المتوسط)

  const bytesPerRow = Math.ceil(width / 8);
  const raster = Buffer.alloc(bytesPerRow * height, 0);

  const ROWS_PER_CHUNK = 40; // كل 40 صف نوقف لحظة ونرجّع التحكم لدورة الأحداث
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pixelOffset = (y * width + x) * 4;
      const a = bitmap[pixelOffset + 3];
      // بكسل شفاف بالكامل = خلفية بيضاء = لا حبر
      if (a < 16) continue;
      const c0 = bitmap[pixelOffset];
      const c1 = bitmap[pixelOffset + 1];
      const c2 = bitmap[pixelOffset + 2];
      const luminance = (c0 + c1 + c2) / 3;
      if (luminance < 170) {
        // بكسل داكن -> نطبعه (نضيء البت المقابل له)
        const byteIndex = y * bytesPerRow + (x >> 3);
        const bitInByte = 7 - (x & 7);
        raster[byteIndex] |= (1 << bitInByte);
      }
    }
    if (y % ROWS_PER_CHUNK === ROWS_PER_CHUNK - 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  let outRaster = raster;
  let outHeight = height;
  if (options.trimBottom) {
    const trimmed = trimRasterBottom(raster, bytesPerRow, height, options.bottomMarginDots ?? 8);
    outRaster = trimmed.raster;
    outHeight = trimmed.height;
  }

  const xL = bytesPerRow & 0xff;
  const xH = (bytesPerRow >> 8) & 0xff;
  const yL = outHeight & 0xff;
  const yH = (outHeight >> 8) & 0xff;

  const header = Buffer.from([GS, 0x76, 0x30, 0x00, xL, xH, yL, yH]);
  return Buffer.concat([header, outRaster]);
}

/**
 * يبني أمر ESC/POS كامل: تهيئة + محاذاة توسيط + صورة الإيصال + تقديم ورق + قص.
 */
async function buildFullPrintJob(image, { dotsWidth = 576, cut = true, feedLinesAfter = 3, trimBottom = false, bottomMarginDots = 8 } = {}) {
  const parts = [];
  parts.push(Buffer.from([ESC, 0x40])); // ESC @  تهيئة الطابعة
  parts.push(Buffer.from([ESC, 0x61, 0x01])); // ESC a 1  محاذاة للوسط
  parts.push(await imageToEscPosRaster(image, dotsWidth, { trimBottom, bottomMarginDots }));
  parts.push(Buffer.from(Array(feedLinesAfter).fill(0x0a))); // أسطر فارغة قبل القص
  if (cut) parts.push(Buffer.from([GS, 0x56, 0x42, 0x00])); // GS V 66 0  قص جزئي (أكثر توافقاً من القص الكامل)
  return Buffer.concat(parts);
}

/**
 * يرسل بيانات خام إلى طابعة الشبكة عبر TCP (منفذ 9100 القياسي - JetDirect/RAW).
 * @returns {Promise<void>}
 */
function sendOnce(ip, port, buffer, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (err) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (err) reject(err); else resolve();
    };
    socket.setTimeout(timeoutMs);
    socket.once('timeout', () => { const e = new Error('انتهت مهلة الاتصال بالطابعة (تأكد من رقم IP والمنفذ 9100، وأن الطابعة على نفس الشبكة).'); e.code = 'ETIMEDOUT'; done(e); });
    socket.once('error', (err) => { const e = new Error(`تعذر الاتصال بالطابعة: ${err.message}`); e.code = err.code; done(e); });
    socket.connect(Number(port) || 9100, ip, () => {
      socket.write(buffer, (err) => {
        if (err) return done(new Error(`فشل إرسال بيانات الطباعة: ${err.message}`));
        // ننتظر قليلاً قبل الإغلاق عشان الطابعة تستلم كل البيانات قبل قطع الاتصال
        setTimeout(() => done(null), 300);
      });
    });
  });
}

// طابعات الإيصالات الحرارية تقبل عادةً اتصال TCP واحداً في المرة: اتصال ثانٍ أثناء الطباعة يُرفض (ECONNREFUSED).
// لذلك: (1) نسلسل الإرسال لكل وجهة ip:port، (2) نعيد المحاولة عند الرفض/القطع، (3) إن كانت الطابعة غير
// متاحة فعلاً نفشل فوراً لفترة قصيرة بدل أن تنتظر كل فاتورة مهلة 8 ثوانٍ وتتراكم الطلبات وتبطئ الكاشير.
const destinationTail = new Map();
const destinationDownUntil = new Map();
const DOWN_COOLDOWN_MS = 20000;
const RETRYABLE = new Set(['ECONNREFUSED', 'ECONNRESET', 'EPIPE']);
const destKey = (ip, port) => `${String(ip).trim()}:${Number(port) || 9100}`;

function getNetworkPrinterCooldown(ip, port) {
  const until = destinationDownUntil.get(destKey(ip, port)) || 0;
  return until > Date.now() ? until - Date.now() : 0;
}

function sendRawToNetworkPrinter(ip, port, buffer, timeoutMs = 4000) {
  const key = destKey(ip, port);
  const run = async () => {
    const wait = getNetworkPrinterCooldown(ip, port);
    if (wait > 0) {
      const e = new Error(`الطابعة ${key} لا تستجيب (فشل الاتصال قبل لحظات).`); e.code = 'PRINTER_COOLDOWN'; e.waitSeconds = Math.ceil(wait / 1000); throw e;
    }
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await sendOnce(ip, port, buffer, timeoutMs);
        destinationDownUntil.delete(key);
        return;
      } catch (err) {
        lastErr = err;
        if (!RETRYABLE.has(err.code)) break;
        await new Promise((r) => setTimeout(r, 700));
      }
    }
    destinationDownUntil.set(key, Date.now() + DOWN_COOLDOWN_MS);
    throw lastErr;
  };
  const prev = destinationTail.get(key) || Promise.resolve();
  const result = prev.then(run, run);
  destinationTail.set(key, result.catch(() => {}));
  return result;
}

/**
 * يلتقط صورة من نافذة مخفية محمّلة بالفعل (بعد التأكد أن المحتوى جاهز)،
 * يحوّلها لأمر ESC/POS، ويرسلها لطابعة الشبكة.
 * @param {Electron.BrowserWindow} win نافذة مخفية تم تحميل الإيصال/تذكرة المطبخ فيها بالفعل
 * @param {{ip: string, port: string|number, dotsWidth?: number, feedLinesAfter?: number}} opts
 */
async function captureWindowAndPrintNetwork(win, { ip, port, dotsWidth = 576, feedLinesAfter = 3, trimBottom = false } = {}) {
  if (!ip) { const e = new Error('لم يتم إدخال عنوان IP للطابعة في الإعدادات.'); e.code = 'NO_IP'; throw e; }
  const measure = (expr, fallback) => win.webContents.executeJavaScript(expr).then((v) => Number(v) || fallback).catch(() => fallback);

  // (1) إزالة هوامش الصفحة حتى تملأ الفاتورة عرض الورق بالضبط
  await win.webContents.insertCSS(
    'html,body{margin:0!important;padding:0!important;background:#fff!important;}' +
    '.receipt-body{padding:0!important;background:#fff!important;align-items:flex-start!important;min-height:0!important;height:auto!important;}' +
    '.receipt,.kitchen-ticket,#receipt{margin:0 auto!important;box-shadow:none!important;border-radius:0!important;}'
  ).catch(() => {});

  // (2) عرض الورق = عرض الإيصال الفعلي (بالبكسل المنطقي CSS)، وليس عرض النافذة كلها
  const paperWidth = Math.max(1, await measure(
    "(() => { const el = document.querySelector('.receipt, .kitchen-ticket, #receipt'); return el ? Math.ceil(el.getBoundingClientRect().width) : 0; })()", 0
  )) || await measure('Math.ceil(document.body.scrollWidth)', 320);
  const contentHeight = await measure('Math.ceil(document.body.scrollHeight)', 1200);
  win.setContentSize(Math.max(paperWidth, 100), Math.max(contentHeight, 100));
  await new Promise((r) => setTimeout(r, 120));

  // (3) تكبير المحتوى ليملأ dotsWidth نقطة: الصورة الملتقطة تصبح بعرض الطابعة تماماً.
  // بدون ذلك كانت الفاتورة 320 نقطة فقط من 576 فتُطبع بنحو نصف الحجم المطلوب.
  const zoom = Math.min(Math.max(dotsWidth / paperWidth, 0.25), 5);
  if (Math.abs(zoom - 1) > 0.01) {
    win.webContents.setZoomFactor(zoom);
    win.setContentSize(Math.ceil(paperWidth * zoom), Math.ceil(contentHeight * zoom));
    await new Promise((r) => setTimeout(r, 150));
  }

  const image = await win.webContents.capturePage();
  const jobBuffer = await buildFullPrintJob(image, { dotsWidth, feedLinesAfter, trimBottom });
  await sendRawToNetworkPrinter(ip, port, jobBuffer);
}

module.exports = { getNetworkPrinterCooldown, captureWindowAndPrintNetwork, sendRawToNetworkPrinter, buildFullPrintJob, imageToEscPosRaster, trimRasterBottom };
