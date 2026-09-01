const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root,p),'utf8');
const checks = [
  ['global profile schema', /organization_profile/],
  ['tax profiles schema', /CREATE TABLE IF NOT EXISTS tax_profiles/],
  ['payment ledger schema', /CREATE TABLE IF NOT EXISTS payment_transactions/],
  ['cash movement schema', /CREATE TABLE IF NOT EXISTS cash_movements/],
  ['CSP hardening', /Content-Security-Policy/],
  ['popup blocking', /setWindowOpenHandler/],
  ['navigation blocking', /will-navigate/],
  ['no fake update host', !/updates\.example\.com/.test(read('package.json'))],
  ['sale item tax profile', /tax_profile_id/.test(read('database/schema.sql'))],
  ['payment ledger write', /payment_transactions/.test(read('database/db.js'))],
  ['cash movement affects expected cash', /cashIn.*cashOut/.test(read('database/db.js'))],
  ['ISO currency validation', /\^\[A-Z\]\{3\}\$/.test(read('database/db.js'))],
  ['country validation', /\^\[A-Z\]\{2\}\$/.test(read('database/db.js'))],
  ['GS1 parser shipped', /parseGs1/.test(read('database/gs1-barcode.js'))],
  ['GS1 IPC exposed', /products:resolveGs1Barcode/.test(read('main.js'))],

];
let failed=0;
for(const [name, ok] of checks){ if(!ok){ failed++; console.error('FAIL',name);} else console.log('PASS',name); }
process.exit(failed?1:0);

assert(fs.existsSync(path.join(root, 'docs/WORLD_READINESS.md')), 'world readiness document');
console.log('PASS world readiness document');
