// اختبار: البحث الذكي في الكاشير (تطبيع عربي/تركي، كلمات بأي ترتيب، باركود بأرقام هندية، PLU، ترتيب النتائج).
const fs = require('fs'), os = require('os'), path = require('path'), Module = require('module');
let Database;
try { Database = require('better-sqlite3-multiple-ciphers'); } catch (_) { console.log('SKIP search regression: better-sqlite3-multiple-ciphers is not installed in this environment.'); process.exit(0); }
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nx-search-'));
const orig = Module._load;
Module._load = function (r) {
  if (r === 'electron') return { app: { getPath: () => dataDir }, safeStorage: { isEncryptionAvailable: () => true, encryptString: (v) => Buffer.from(String(v)), decryptString: (v) => Buffer.from(v).toString() } };
  return orig.apply(this, arguments);
};
const db = require(path.join(__dirname, '..', 'database', 'db'));
db.init();
let bad=0;const ck=(n,c,x)=>{console.log((c?'PASS':'FAIL')+': '+n+(x!==undefined?' -> '+JSON.stringify(x):''));if(!c)bad++;};
const mk=(name,extra={})=>db.createProduct({name,price:10,cost:5,initialStock:10,trackInventory:true,...extra});
mk('شاورما دجاج',{barcode:'6001234567890'}); mk('شاورما لحم'); mk('أيس كريم فانيلا'); mk('ماء معبأة'); mk('Çay'); mk('ÇAY ŞEKERLİ'); mk('Kahve'); mk('Hamburger'); mk('Işık Ekmek'); mk('كولا مشروبة',{sku:'CL-01'}); mk('بيبسي',{pluCode:'4455'});
const names=(q,o={})=>db.listProducts({search:q,...o}).map(p=>p.name);
const first=(q)=>names(q)[0];
ck('word order ignored: "دجاج شاورما"',names('دجاج شاورما').includes('شاورما دجاج'),names('دجاج شاورما'));
ck('only chicken matched (not lamb)',!names('دجاج شاورما').includes('شاورما لحم'));
ck('alef variants: "ايس كريم" finds "أيس كريم فانيلا"',names('ايس كريم').includes('أيس كريم فانيلا'));
ck('hamza+teh marbuta: "ماء معباة" finds "ماء معبأة"',names('ماء معباة').includes('ماء معبأة'));
ck('Turkish ascii "cay" ranks exact "Çay" first',first('cay')==='Çay',names('cay'));
ck('Turkish upper "ÇAY"',first('ÇAY')==='Çay',names('ÇAY'));
ck('"sekerli" finds "ÇAY ŞEKERLİ"',names('sekerli').includes('ÇAY ŞEKERLİ'));
ck('"isik" finds "Işık Ekmek"',names('isik').includes('Işık Ekmek'));
ck('"ekmek ısık" (dotless) finds it',names('ekmek ısık').includes('Işık Ekmek'));
ck('barcode exact',first('6001234567890')==='شاورما دجاج');
ck('barcode with Arabic-Indic digits',first('٦٠٠١٢٣٤٥٦٧٨٩٠')==='شاورما دجاج',names('٦٠٠١٢٣٤٥٦٧٨٩٠'));
ck('barcode last 5 digits',names('67890').includes('شاورما دجاج'));
ck('SKU exact',first('CL-01')==='كولا مشروبة');
ck('SKU lowercase prefix',names('cl-').includes('كولا مشروبة'));
ck('PLU exact',first('4455')==='بيبسي');
ck('prefix ranks before contains: "شاور" -> both شاورما, no crash',names('شاور').length===2);
ck('percent/underscore in query does not match everything',names('%').length===0 && names('_').length===0,[names('%').length,names('_').length]);
ck('symbol-only query falls back safely',Array.isArray(names('+')));
ck('empty search still lists',names('').length>=10);
ck('category filter + search together',Array.isArray(names('cay',{categoryId:999999})) && names('cay',{categoryId:999999}).length===0);
ck('limit respected',names('a',{limit:2}).length<=2);


if (bad) { console.error('SEARCH REGRESSION: FAIL'); process.exit(1); }
console.log('SEARCH REGRESSION: PASS');
