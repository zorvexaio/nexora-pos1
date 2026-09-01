const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const dbPath = path.join(root, 'database', 'db.js');
const mainPath = path.join(root, 'main.js');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
function must(cond, msg){ if(!cond) throw new Error(msg); }
const db = fs.readFileSync(dbPath,'utf8');
const main = fs.readFileSync(mainPath,'utf8');
const [maj,min]=pkg.version.split('.').map(Number); must(maj>0 || min>=20, 'release must remain compatible with v0.20 baseline');
must(/COALESCE\(SUM\(cash_amount - change_due\),0\) AS c/.test(db), 'cash expected must use retained cash after change');
must(main.includes("language:set', (_event, lang) => { requireAdmin();"), 'language changes must require admin');
must(main.includes("currency:get', () => { requireAccountReady();"), 'currency read must require authenticated account');
must(main.includes("printing:getConfig', () => { requireAccountReady();"), 'printing config read must require authenticated account');
console.log('v0.20 regression: 5/5 PASS');
