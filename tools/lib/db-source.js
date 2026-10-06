'use strict';
// قُسِّم database/db.js إلى database/db.js + database/domains/*.js.
// اختبارات الفحص النصي تقرأ الآن المصدر الكامل (db.js + كل الـ domains) كنص واحد.
const fs = require('fs');
const path = require('path');

// بعد التقسيم: (1) الدوال في domains تستعمل h.db / h.getCurrentBranch بدل db / getCurrentBranch،
// (2) db.js فيه أسطر تفويض قصيرة `function x(...args){ return _domains.y.x(...args); }`
// تُربك الأنماط النصية (تطابق بداية الدالة ثم تقفز لملف آخر). نُطبّع النص ليطابق ما كانت الاختبارات تتوقعه.
function normalize(text) {
  return text
    .split('\n')
    .filter((line) => !/^function \w+\(\.\.\.args\) \{ return _domains\./.test(line))
    .join('\n')
    .replace(/\bh\.(?=[A-Za-z_])/g, '');
}

function read(root = path.resolve(__dirname, '..', '..')) {
  const dbDir = path.join(root, 'database');
  // db.js أولاً ثم بقية وحدات database/ (users.js, settings.js, ...) ثم domains/
  const files = [path.join(dbDir, 'db.js')];
  for (const f of fs.readdirSync(dbDir).sort()) if (f.endsWith('.js') && f !== 'db.js') files.push(path.join(dbDir, f));
  const domains = path.join(dbDir, 'domains');
  if (fs.existsSync(domains)) {
    for (const f of fs.readdirSync(domains).sort()) if (f.endsWith('.js')) files.push(path.join(domains, f));
  }
  return normalize(files.map((f) => fs.readFileSync(f, 'utf8')).join('\n'));
}

module.exports = { read };
