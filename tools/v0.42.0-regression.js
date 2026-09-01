const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
let passCount = 0;
let failCount = 0;
function ok(name, condition) {
  if (condition) { passCount += 1; console.log(`PASS ${name}`); }
  else { failCount += 1; console.error(`FAIL ${name}`); }
}

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
const i18n = fs.readFileSync(path.join(root, 'renderer', 'i18n.js'), 'utf8');
const tableOrder = fs.readFileSync(path.join(root, 'renderer', 'pages', 'table-order.html'), 'utf8');
const tableOrderJs = fs.readFileSync(path.join(root, 'renderer', 'pages', 'table-order.js'), 'utf8');
const style = fs.readFileSync(path.join(root, 'renderer', 'style.css'), 'utf8');

const majorMinorPatch = String(pkg.version).split('.').map(Number);
ok('release version remains compatible with 0.42 baseline', majorMinorPatch[0] === 0 && majorMinorPatch[1] >= 42 && lock.version === pkg.version && lock.packages?.['']?.version === pkg.version);
ok('table order has explicit back button', /id="backToTablesBtn"/.test(tableOrder));
ok('table order back button is translated', /data-i18n="tableOrder\.backToTables"/.test(tableOrder));
ok('table order has safe back handler', /async function goBackToTables\(\)/.test(tableOrderJs) && /window\.location\.href = 'tables\.html'/.test(tableOrderJs));
ok('table order protects unsaved order before navigation', /await saveOrder\(false\)/.test(tableOrderJs));
ok('table order supports Alt+Left navigation', /e\.altKey && e\.key === 'ArrowLeft'/.test(tableOrderJs));
ok('premium back button styling exists', /\.back-to-tables/.test(style));
ok('English raw fallback catalog exists', /const RAW_TRANSLATIONS = \{[\s\S]*?en:/.test(i18n));
ok('Turkish raw fallback catalog exists', /const RAW_TRANSLATIONS = \{[\s\S]*?tr:/.test(i18n));
ok('raw fallback is used by programmatic t()', /RAW_TRANSLATIONS\[lang\]/.test(i18n));
ok('dynamic Arabic substrings are translated', /Longest phrases first/.test(i18n));
ok('Arabic/English/Turkish direction handling exists', /const RTL_LANGS = \['ar'\]/.test(i18n) && /setAttribute\('dir'/.test(i18n));

const hasLegacyLicensePath = [
  'main.js',
  'tools/release-manifest.js',
  'tools/release-preflight.js'
].some(rel => fs.existsSync(path.join(root, rel)) && fs.readFileSync(path.join(root, rel), 'utf8').includes("'license', 'license.js'"));
ok('runtime release paths use licensing/license.js', !hasLegacyLicensePath && fs.existsSync(path.join(root,'licensing','license.js')));

const names = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else names.push(full);
  }
})(root);
const lower = new Map();
let collision = false;
for (const full of names) {
  const rel = path.relative(root, full).replace(/\\/g,'/');
  const k = rel.toLowerCase();
  if (lower.has(k)) { collision = true; console.error(`COLLISION ${lower.get(k)} <> ${rel}`); }
  else lower.set(k, rel);
}
ok('no case-insensitive path collisions', !collision);

console.log(`V0.42 BASELINE REGRESSION: ${passCount}/${passCount + failCount} passed`);
process.exitCode = failCount ? 1 : 0;
