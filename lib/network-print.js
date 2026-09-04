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
async function imageToEscPosRaster(image, maxDotsWidth) {
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

  const xL = bytesPerRow & 0xff;
  const xH = (bytesPerRow >> 8) & 0xff;
  const yL = height & 0xff;
  const yH = (height >> 8) & 0xff;

  const header = Buffer.from([GS, 0x76, 0x30, 0x00, xL, xH, yL, yH]);
  return Buffer.concat([header, raster]);
}

/**
 * يبني أمر ESC/POS كامل: تهيئة + محاذاة توسيط + صورة الإيصال + تقديم ورق + قص.
 */
async function buildFullPrintJob(image, { dotsWidth = 576, cut = true, feedLinesAfter = 3 } = {}) {
  const parts = [];
  parts.push(Buffer.from([ESC, 0x40])); // ESC @  تهيئة الطابعة
  parts.push(Buffer.from([ESC, 0x61, 0x01])); // ESC a 1  محاذاة للوسط
  parts.push(await imageToEscPosRaster(image, dotsWidth));
  parts.push(Buffer.from(Array(feedLinesAfter).fill(0x0a))); // أسطر فارغة قبل القص
  if (cut) parts.push(Buffer.from([GS, 0x56, 0x42, 0x00])); // GS V 66 0  قص جزئي (أكثر توافقاً من القص الكامل)
  return Buffer.concat(parts);
}

/**
 * يرسل بيانات خام إلى طابعة الشبكة عبر TCP (منفذ 9100 القياسي - JetDirect/RAW).
 * @returns {Promise<void>}
 */
function sendRawToNetworkPrinter(ip, port, buffer, timeoutMs = 8000) {
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
    socket.once('timeout', () => done(new Error('انتهت مهلة الاتصال بالطابعة (تأكد من رقم IP والمنفذ 9100، وأن الطابعة على نفس الشبكة).')));
    socket.once('error', (err) => done(new Error(`تعذر الاتصال بالطابعة: ${err.message}`)));
    socket.connect(Number(port) || 9100, ip, () => {
      socket.write(buffer, (err) => {
        if (err) return done(new Error(`فشل إرسال بيانات الطباعة: ${err.message}`));
        // ننتظر قليلاً قبل الإغلاق عشان الطابعة تستلم كل البيانات قبل قطع الاتصال
        setTimeout(() => done(null), 300);
      });
    });
  });
}

/**
 * يلتقط صورة من نافذة مخفية محمّلة بالفعل (بعد التأكد أن المحتوى جاهز)،
 * يحوّلها لأمر ESC/POS، ويرسلها لطابعة الشبكة.
 * @param {Electron.BrowserWindow} win نافذة مخفية تم تحميل الإيصال/تذكرة المطبخ فيها بالفعل
 * @param {{ip: string, port: string|number, dotsWidth?: number}} opts
 */
async function captureWindowAndPrintNetwork(win, { ip, port, dotsWidth = 576 } = {}) {
  if (!ip) throw new Error('لم يتم إدخال عنوان IP للطابعة في الإعدادات.');
  // نتأكد أن حجم النافذة يطابق ارتفاع المحتوى الفعلي حتى لا يُقتطع الإيصال
  const contentHeight = await win.webContents.executeJavaScript(
    'Math.ceil(document.body.scrollHeight)'
  ).catch(() => 1200);
  const contentWidth = await win.webContents.executeJavaScript(
    'Math.ceil(document.body.scrollWidth)'
  ).catch(() => 320);
  win.setContentSize(Math.max(contentWidth, 320), Math.max(contentHeight, 100));
  // فريم إضافي لضمان اكتمال الرسم بعد تغيير الحجم قبل الالتقاط
  await new Promise((r) => setTimeout(r, 120));
  const image = await win.webContents.capturePage();
  const jobBuffer = await buildFullPrintJob(image, { dotsWidth });
  await sendRawToNetworkPrinter(ip, port, jobBuffer);
}

module.exports = { captureWindowAndPrintNetwork, sendRawToNetworkPrinter, buildFullPrintJob, imageToEscPosRaster };
