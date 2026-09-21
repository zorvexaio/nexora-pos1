// اختبار: مسارات لوحة الأوامر (Ctrl+K) تُحسب ديناميكياً حسب موقع الصفحة الحالية،
// بدل افتراض أن اللوحة تُفتح دائماً من داخل renderer/pages/.
// شغّله: node tools/command-palette-paths-regression.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const common = fs.readFileSync(path.join(root, 'renderer', 'common.js'), 'utf8');

// كل الوجهات مكتوبة نسبة لمجلد renderer/ (لا مسارات ثابتة تفترض موقعاً بعينه):
// الكاشير = index.html (بلا بادئة ../)، وكل صفحة أخرى تبدأ بـ pages/.
assert.match(common, /\['nav\.pos',\s*'index\.html'\]/, 'POS route must be root-relative (index.html), not a hardcoded ../index.html.');
assert.match(common, /\['nav\.tables',\s*'pages\/tables\.html'\]/, 'Tables route must be prefixed with pages/.');
assert.match(common, /\['nav\.settings',\s*'pages\/settings\.html'\]/, 'Settings route must be prefixed with pages/.');
assert.doesNotMatch(common, /\['nav\.tables',\s*'tables\.html'\]/, 'Tables route must not be a bare filename (breaks when opened from renderer/index.html).');

// pageRoot() يجب أن يحسب البادئة '../' فقط عندما تكون الصفحة الحالية فعلاً داخل
// renderer/pages/ — وليس قيمة ثابتة (كانت الدالة القديمة تُرجع '' دائماً بلا أي شرط فعلي).
assert.match(common, /function pageRoot\(\)\s*\{\s*return location\.pathname\.includes\('\/renderer\/pages\/'\)\s*\?\s*'\.\.\/'\s*:\s*''\s*;\s*\}/,
  'pageRoot() must branch on whether the current page is inside renderer/pages/.');

// visibleRoutes() يجب أن يستخدم فعلياً بادئة pageRoot() على كل رابط، لا أن يتجاهلها.
assert.match(common, /const root = pageRoot\(\);/, 'visibleRoutes() must call pageRoot() to compute the prefix.');
assert.match(common, /\.map\(\(\[key, href\]\)\s*=>\s*\[key, root \+ href\]\)/, 'visibleRoutes() must prefix every href with the computed root.');

console.log('COMMAND PALETTE PATHS REGRESSION: PASS (routes are root-relative and pageRoot() branches correctly)');
