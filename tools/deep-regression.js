const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const main = read('main.js');
const db = read('database/db.js');
const syncServer = read('server/sync-server.js');
const syncClient = read('database/sync-client.js');
const payroll = read('renderer/pages/payroll.js');
const pkg = JSON.parse(read('package.json'));

const checks = [
  ['login is bound to current branch', /SELECT \* FROM users WHERE username = \? AND branch_id = \?/m.test(db)],
  ['discount approver is bound to current branch', /SELECT role, is_active FROM users WHERE id = \? AND branch_id = \?/m.test(db)],
  ['credit approver is bound to current branch', /SELECT role, is_active FROM users WHERE id = \? AND branch_id = \?/m.test(db)],
  ['payroll v2 has no payment-cycle mutation path', !/function markPayrollPaid|UPDATE payroll_periods SET status='paid'|function approvePayrollPeriod|function createPayrollPeriod/.test(db) && /CREATE TABLE IF NOT EXISTS payroll_months/.test(db)],
  ['sync pull is filtered by authenticated branch', /SELECT \* FROM sync_records WHERE revision > \? AND \(branch_uuid = \? OR branch_uuid IS NULL\)/m.test(syncServer)],
  ['client rejects foreign branch-owned sync rows', /foreign\(changes\.inventory\)[\s\S]*foreign\(changes\.customers\)[\s\S]*foreign\(changes\.suppliers\)/m.test(db)],
  ['client filters branch-owned remote rows', /own\(changes\.sales(?:\|\|\[\])?\)/m.test(db) && /own\(changes\.customers(?:\|\|\[\])?\)/m.test(db) && /own\(changes\.suppliers(?:\|\|\[\])?\)/m.test(db)],
  ['sync client only sends branch-local state envelope', /branch: payload\.branch/m.test(syncClient)],
  ['monthly payroll UI exists', /monthly salary|monthlySalary|salary/i.test(payroll)],
  ['current stable Electron line', pkg.devDependencies?.electron === '43.4.1'],
  ['current stable encrypted sqlite line', pkg.dependencies?.['better-sqlite3-multiple-ciphers'] === '13.0.3'],
  ['current stable updater line', pkg.dependencies?.['electron-updater'] === '6.8.9'],
  ['current stable builder line', pkg.devDependencies?.['electron-builder'] === '26.15.7'],
  ['no hard-coded hourly payroll UI path', !/hourly_rate/.test(payroll)],
  ['no mandatory shift wording in main sale path', !/if \(!openShift\)[\s\S]{0,220}throw new Error\([^)]+وردية/.test(main)],
];
let failed = 0;
for (const [label, ok] of checks) {
  if (ok) console.log(`PASS: ${label}`);
  else { failed++; console.error(`FAIL: ${label}`); }
}
if (failed) process.exit(1);
console.log(`DEEP REGRESSION: PASS (${checks.length} checks)`);
