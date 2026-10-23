const fs=require('fs');
// ملاحظة: فحوص الدمج/التقسيم والتسعير أُحلّت محل نسخها النصية باختبارات سلوكية:
// tools/table-merge-split-behavior.js و tools/open-order-pricing-behavior.js
const db=require('./lib/db-source').read();
const main=fs.readFileSync('main.js','utf8');
const server=fs.readFileSync('server/sync-server.js','utf8');
const pkg=JSON.parse(fs.readFileSync('package.json','utf8'));
const checks=[
 ['version is newer than 0.10.0 baseline', /^0\.(1[1-9]|[2-9][0-9])\./.test(pkg.version)],
 ['loyalty award snapshot', /loyalty_points_awarded/.test(db)],
 ['loyalty reversal capped', /loyalty_points_reversed/.test(db) && /MAX\(0, loyalty_points-\?\)/.test(db)],
 ['cash movement scoped to session owner or manager', /shift\.opened_by/.test(db) && /لا يمكن إضافة حركة نقد/.test(db)],
 ['branch update scoped to current branch', /لا يمكن تعديل فرع خارج الفرع الحالي/.test(db)],
 ['pairing code uses cryptographic randomness', /crypto\.randomInt\(10000000, 100000000\)/.test(main)],
 ['pairing code is one-time', /consumePairingCode/.test(main) && /typeof consumePairingCode === 'function'/.test(server)],
 ['sync server persists revision on replacement', /deleteExisting\.run\(rec\.entity, rec\.uuid\)/.test(server) && /insertFresh\.run/.test(server)],
];
let ok=true; for(const [n,p] of checks){console.log((p?'✅':'❌')+' '+n); if(!p) ok=false;} process.exit(ok?0:1);
