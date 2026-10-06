'use strict';
// style.css صار مجمِّعاً (@import) لملفات renderer/css/*.css، والمتغيرات في tokens.css.
// الاختبارات النصية تقرأ الآن كل ذلك كنص واحد.
const fs = require('fs');
const path = require('path');

function read(root = path.resolve(__dirname, '..', '..')) {
  const rdir = path.join(root, 'renderer');
  const files = [path.join(rdir, 'style.css'), path.join(rdir, 'tokens.css')];
  const cssDir = path.join(rdir, 'css');
  if (fs.existsSync(cssDir)) for (const f of fs.readdirSync(cssDir).sort()) if (f.endsWith('.css')) files.push(path.join(cssDir, f));
  return files.filter((f) => fs.existsSync(f)).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
}

module.exports = { read };
