const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
let passCount = 0;
let failCount = 0;
function ok(name, condition) {
  if (condition) { passCount += 1; console.log(`PASS ${name}`); }
  else { failCount += 1; console.error(`FAIL ${name}`); }
}
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));
const pos = read('renderer/pos.js');
const index = read('renderer/index.html');
const common = read('renderer/common.js');
const reports = read('renderer/pages/reports.js');
const reportsHtml = read('renderer/pages/reports.html');
const tables = read('renderer/pages/tables.js');
const settings = read('renderer/pages/settings.js');
const style = read('renderer/style.css');

ok('product release remains compatible with 0.43 baseline', (() => { const parts = String(pkg.version).split('.').map(Number); return parts[0] === 0 && parts[1] >= 43 && lock.version === pkg.version && lock.packages?.['']?.version === pkg.version; })());
ok('POS has resilient product loading/error state', /setPageLoading\(productsGrid/.test(pos) && /تعذر تحميل المنتجات/.test(pos));
ok('POS has premium empty search state', /لا توجد نتائج/.test(pos) && /مسح البحث/.test(pos));
ok('cart shows live item count and empty state', /cartItemCount/.test(pos) && /السلة فارغة/.test(pos));
ok('checkout is keyboard accessible', /Ctrl \+ Enter للدفع/.test(index) && /event\.key === 'Enter'/.test(pos) && /checkout\(\)/.test(pos));
ok('F2 focuses product search', /event\.key === 'F2'/.test(pos) && /searchInput\.focus\(\)/.test(pos));
ok('global success/error toast utility exists', /function showToast\(/.test(common) && /nexora-toast-success/.test(style) && /nexora-toast-error/.test(style));
ok('global Escape modal close exists', /event\.key === 'Escape'/.test(common) && /modal-actions \.btn-secondary/.test(common));
ok('reports expose refresh status and error handling', /reportStatus/.test(reports) && /تعذر تحديث التقارير/.test(reports) && /aria-busy/.test(reports));
ok('table screen has loading and recovery state', /جارٍ تحميل الطاولات/.test(tables) && /تعذر تحميل الطاولات/.test(tables) && /window\.t \? window\.t/.test(tables));
ok('settings uses visible product-grade feedback', /showToast\(/.test(settings) && !/alert\('تم حفظ اسم المتجر/.test(settings));
ok('focus-visible styling exists', /button:focus-visible/.test(style) && /input:focus-visible/.test(style));
ok('release notes exist', fs.existsSync(path.join(root, 'docs', 'RELEASE_0.43.0.md')));
console.log(`V0.43.0 PRODUCT UX REGRESSION: ${passCount}/${passCount + failCount} passed`);
process.exitCode = failCount ? 1 : 0;
