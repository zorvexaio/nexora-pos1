// ==========================================================
// طلب HTTPS يدعم "تثبيت الشهادة بالبصمة" (certificate fingerprint pinning) — لازم للاتصال
// بخادم LAN المُضمَّن (شهادة ذاتية التوقيع، راجع server/lan-tls.js لشرح لماذا).
// ==========================================================
// وضعان:
//  - pinnedFingerprint = null  → "ثقة أول استخدام" (TOFU): نقبل أي شهادة هذه المرة، ونُرجع
//    بصمتها الفعلية (من مقبس TLS نفسه، وليس من أي شيء يدّعيه جسم الرد) ليُحفَظ ويُثبَّت لاحقاً.
//    يُستخدم فقط أثناء الاقتران الأول، وهو مسبقاً محمي برمز اقتران يدوي قصير الأمد.
//  - pinnedFingerprint = "AB:CD:..." → نرفض أي شهادة لا تطابق هذه البصمة تحديداً، بصرف النظر
//    عن صلاحيتها من منظور أي مرجع شهادات (أصلاً لا تحقق سلسلة ثقة هنا إطلاقاً).
const https = require('https');
const { URL } = require('url');

function pinnedRequest({ url, method = 'GET', headers = {}, body, timeoutMs = 10000, pinnedFingerprint = null }) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      reject(new Error('عنوان الخادم غير صالح'));
      return;
    }

    let capturedFingerprint = null;
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method,
        headers,
        // لا يوجد مرجع شهادات عام يعرف شهادتنا الذاتية التوقيع أصلاً؛ التحقق الحقيقي يصير
        // يدوياً بالأسفل على مقبس TLS نفسه (تثبيت بالبصمة)، لا بسلسلة الثقة القياسية.
        // ملاحظة: خيار checkServerIdentity لا يُستدعى بموثوقية لشهادة ذاتية التوقيع فشلت أصلاً
        // بالتحقق القياسي (سلوك Node مقصود — تُستدعى فقط بعد نجاح تحقق سلسلة الثقة العادية)،
        // لذا لا نعتمد عليه، ونقرأ الشهادة الفعلية من المقبس مباشرة بعد 'secureConnect'.
        rejectUnauthorized: false,
        timeout: timeoutMs,
        // نمنع إعادة استخدام اتصال TLS محفوظ (keep-alive) من طلب سابق عمداً: لو أعدنا استخدام
        // مقبس سبق أن نجحت مصافحته، لن يُطلق حدث 'secureConnect' مرة ثانية فنفوّت التحقق من
        // البصمة لهذا الطلب بالذات. الأداء غير مهم هنا (مزامنة كل بضع ثوانٍ إلى دقائق على الأكثر).
        agent: false,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          if (settled) return; // سبق ورُفض الاتصال بسبب عدم تطابق البصمة
          settled = true;
          let json = null;
          try { json = JSON.parse(data); } catch { /* استجابة ليست JSON */ }
          resolve({ status: res.statusCode, json, raw: data, fingerprint256: capturedFingerprint });
        });
      }
    );

    req.on('socket', (socket) => {
      socket.on('secureConnect', () => {
        const cert = socket.getPeerCertificate(false);
        if (!cert || !cert.fingerprint256) {
          req.destroy();
          fail(new Error('تعذّر قراءة شهادة الخادم'));
          return;
        }
        capturedFingerprint = cert.fingerprint256;
        if (pinnedFingerprint && cert.fingerprint256 !== pinnedFingerprint) {
          req.destroy();
          fail(new Error(
            'بصمة شهادة الخادم لا تطابق البصمة المحفوظة عند الاقتران — رفضنا الاتصال حمايةً من هجوم وسيط محتمل. ' +
            'إذا أُعيد تثبيت التطبيق على الجهاز الرئيسي فعلاً (شهادة جديدة بشكل شرعي)، أعد اقتران هذا الجهاز من جديد.'
          ));
        }
      });
    });

    req.on('timeout', () => { req.destroy(); fail(new Error('انتهت مهلة الاتصال')); });
    req.on('error', (err) => fail(err));
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

module.exports = { pinnedRequest };
