'use strict';
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');

const start = src.indexOf("exposeInMainWorld('api', {");
if (start === -1) throw new Error('لم يُعثر على contextBridge.exposeInMainWorld(\'api\', {...}) بـ preload.js');
const braceStart = src.indexOf('{', start);
let depth = 0, end = braceStart;
for (; end < src.length; end++) {
  if (src[end] === '{') depth++;
  else if (src[end] === '}') { depth--; if (depth === 0) { end++; break; } }
}
const body = src.slice(braceStart + 1, end - 1);

// مفاتيح المستوى الأول فقط: سطر يبدأ بمسافتين بالضبط ثم اسم ثم ':' (لا نلمس مفاتيح متداخلة).
const topLevelKeys = [...body.matchAll(/^  ([a-zA-Z_][a-zA-Z0-9_]*):/gm)].map((m) => m[1]);

const seen = new Map();
const duplicates = [];
for (const key of topLevelKeys) {
  seen.set(key, (seen.get(key) || 0) + 1);
}
for (const [key, count] of seen) {
  if (count > 1) duplicates.push(`${key} (×${count})`);
}

if (duplicates.length) {
  throw new Error(
    `مفاتيح مكررة بمستوى أول لكائن window.api بـ preload.js: ${duplicates.join(', ')}. ` +
    `JavaScript بيسمح بتعريف نفس المفتاح مرتين بكائن حرفي واحد ويتجاهل الأول بصمت — ` +
    `فأي دالة بالتعريف الأول تختفي فعلياً من window.api بدون أي خطأ وقت التشغيل حتى تُستدعى. ` +
    `ادمج كل تعريفات نفس المفتاح بمكان واحد.`
  );
}

console.log(`PRELOAD DUPLICATE KEY REGRESSION: PASS (${topLevelKeys.length} top-level keys, all unique)`);
