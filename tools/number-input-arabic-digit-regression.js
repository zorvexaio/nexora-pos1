'use strict';
// يتأكد إنه ما رجع أي <input type="number"> بواجهة الكاشير/الشاشات التفاعلية بدون
// مبرر — لأن هالنوع بيرفض الأرقام العربية/الفارسية بصمت (راجع تعليق common.js).
// القاعدة: أي حقل بيتوقع كتابة يدوية سريعة من الكاشير/المستخدم لازم يكون
// type="text" inputmode="numeric" + يُقرأ بـ parseLocaleNumber/normalizeDigits.
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

// استثناءات معروفة ومقصودة: حقول إعدادات/فلاتر نادراً ما تُكتب يدوياً بلوحة عربية
// وقت الاستعجال، أو محكومة بسبينرات المتصفح نفسها كميزة، فمش أولوية بنفس درجة
// خانات الكاشير السريعة. عدّل هالقائمة إذا أضفت استثناءً حقيقياً بمبرر بتعليق مجاور.
const ALLOWLIST = new Set([]);

// نفحص ملفات HTML الثابتة، وكمان ملفات JS نفسها — لأن بعض الشاشات (payroll.js مثلاً)
// تبني حقول <input> ديناميكياً بـ innerHTML جوا الكود، فما بتظهر بأي ملف .html ثابت.
const targets = [
  'renderer/index.html',
  ...fs.readdirSync(path.join(root, 'renderer', 'pages')).filter((f) => f.endsWith('.html')).map((f) => `renderer/pages/${f}`),
  ...fs.readdirSync(path.join(root, 'renderer')).filter((f) => f.endsWith('.js')).map((f) => `renderer/${f}`),
  ...fs.readdirSync(path.join(root, 'renderer', 'pages')).filter((f) => f.endsWith('.js')).map((f) => `renderer/pages/${f}`),
];

let failed = false;
for (const rel of targets) {
  const full = path.join(root, rel);
  if (!fs.existsSync(full)) continue;
  const html = fs.readFileSync(full, 'utf8');
  const matches = [...html.matchAll(/<input\s+[^>]*id="([^"]+)"[^>]*?type="number"[^>]*>/g)];
  for (const m of matches) {
    const id = m[1];
    const key = `${rel}#${id}`;
    if (ALLOWLIST.has(key)) continue;
    console.error(`PRELOAD/NUMBER-INPUT WARNING: ${key} يستخدم type="number" — سيرفض الأرقام العربية/الفارسية بصمت. استخدم type="text" inputmode="numeric" مع parseLocaleNumber بدلاً منه، أو أضفه لـ ALLOWLIST بهذا الملف مع تعليق يشرح السبب.`);
    failed = true;
  }
}

if (failed) process.exit(1);
console.log(`NUMBER INPUT ARABIC-DIGIT REGRESSION: PASS (${targets.length} ملفات فُحصت، لا حقول type="number" غير مُستثناة)`);
