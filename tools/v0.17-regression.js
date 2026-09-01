const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const db = fs.readFileSync(path.join(ROOT, 'database', 'db.js'), 'utf8');
const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const reports = fs.readFileSync(path.join(ROOT, 'renderer', 'pages', 'reports.js'), 'utf8');

const checks = [
  ['pricing uses item quantity', /const lineGross = unitPrice \* Number\(item\.quantity\)/.test(db)],
  ['pricing no longer references undefined quantity', !/const lineGross = unitPrice \* quantity;/.test(db)],
  ['shift summary is viewer-scoped', /getShiftSummary\(shiftId, branchId = null, viewerUserId = null, viewerRole = null\)/.test(db)],
  ['shift summary rejects cross-user cash visibility', /لا تملك صلاحية عرض تفاصيل جلسة صندوق فتحها موظف آخر/.test(db)],
  ['cash movements are viewer-scoped', /getShiftCashMovements\(shiftId, viewerUserId = null, viewerRole = null\)/.test(db)],
  ['branches list is admin-only', /ipcMain\.handle\('branches:list', \(\) => \{ requireAdmin\(\);/.test(main)],
  ['main passes shift viewer identity', /db\.getShiftSummary\(shiftId, db\.getCurrentBranch\(\)\.id, currentUser\.id, currentUser\.role\)/.test(main)],
  ['reports send date-only range', /from: fromInput\.value,\s*to: toInput\.value/s.test(reports)],
  ['reports use local browser date', /Intl\.DateTimeFormat\('en-CA'/.test(reports)],
  ['DB converts organization-local dates', /zonedLocalToUtcSql/.test(db)],
  ['DB reads organization timezone', /const timeZone = profile\?\.timezone \|\| 'UTC'/.test(db)],
];
let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok) failed += 1;
}
if (failed) process.exit(1);
console.log(`v0.17 regression: ${checks.length}/${checks.length} PASS`);
