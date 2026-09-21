const fs=require('fs');
const path=require('path');
const root=path.resolve(__dirname,'..');
const db=fs.readFileSync(path.join(root,'database','db.js'),'utf8');
const pos=fs.readFileSync(path.join(root,'renderer','pos.js'),'utf8');
const i18n=fs.readFileSync(path.join(root,'renderer','i18n.js'),'utf8');
const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
const preload=fs.readFileSync(path.join(root,'preload.js'),'utf8');
const main=fs.readFileSync(path.join(root,'main.js'),'utf8');
const lock=JSON.parse(fs.readFileSync(path.join(root,'package-lock.json'),'utf8'));
let passed=0; let failed=0;
function ok(name,condition){ if(condition){passed++; console.log('PASS:',name)} else {failed++; console.error('FAIL:',name)} }
function langBlock(lang){
  const start=i18n.search(new RegExp('\\b'+lang+':\\s*\\{'));
  if(start<0) return '';
  let depth=0,begun=false,end=-1;
  const brace=i18n.indexOf('{',start);
  for(let i=brace;i<i18n.length;i++){
    if(i18n[i]==='{'){depth++;begun=true;}
    else if(i18n[i]==='}'&&begun){depth--; if(depth===0){end=i+1;break;}}
  }
  return end>0?i18n.slice(start,end):'';
}
function hasDuplicateKeys(block){ const seen=new Set(); for(const m of block.matchAll(/^\s{4}([A-Za-z0-9_]+):/gm)){ if(seen.has(m[1])) return true; seen.add(m[1]); } return false; }
ok('version metadata is synchronized', pkg.version===lock.version && lock.packages?.['']?.version===pkg.version);
ok('release guide exists', fs.existsSync(path.join(root,'docs',`RELEASE_${pkg.version}.md`)));
ok('manager approval grant id survives renderer state', /grantId: result\.grantId/.test(pos) && /discountApprovalGrantId: discountApproval \? discountApproval\.grantId : null/.test(pos));
ok('migrations only ignore already-present columns', /PRAGMA table_info\(\$\{table\}\)/.test(db) && /Migration failed adding/.test(db));
ok('product create validates identifiers', /assertUniqueProductIdentifiers/.test(db) && /رمز SKU مستخدم بالفعل/.test(db) && /الباركود مستخدم بالفعل/.test(db));
ok('product update validates numeric fields', /const updateProductTx = db\.transaction/.test(db) && /parseNonNegativeNumber\(p\?\.price/.test(db) && /parseNonNegativeNumber\(p\.stock/.test(db));
ok('product update is atomic with inventory update', /const updateProductTx = db\.transaction/.test(db) && /function updateProduct\(p\) \{\s*return updateProductTx\(p\);/.test(db));
ok('CSV import rejects malformed numeric values', /parseNonNegativeNumber\(row\.price/.test(db) && /parseNonNegativeNumber\(row\.cost/.test(db) && /parseNonNegativeNumber\(row\.quantity/.test(db));
ok('table creation validates name and seat range', /اسم الطاولة مطلوب/.test(db) && /seats < 1 \|\| seats > 100/.test(db) && /اسم الطاولة مستخدم بالفعل/.test(db));
ok('category and supplier creation validate names', /function createCategory\(c\)[\s\S]*?اسم الفئة مطلوب/.test(db) && /function createSupplier\(s\)[\s\S]*?اسم المورد مطلوب/.test(db));
ok('i18n has no duplicate keys in ar/tr/en', ['ar','tr','en'].every(lang=>{const b=langBlock(lang); return !!b && !hasDuplicateKeys(b);}));
ok('sales snapshot tax inclusivity survives item writes', /tax_inclusive/.test(db) && /item\.taxInclusive \? 1 : 0/.test(db) && /item\.tax_inclusive \? 1 : 0/.test(db));
ok('returns use post-tax discounted merchandise amounts', /refundableAmountMinor\(saleItem/.test(db) && /saleItemsTotalBeforeDiscount/.test(db) && /saleDiscountPool/.test(db));
ok('cashier discount cap is fail-safe', /Number\(getSetting\('max_cashier_discount_percent'/.test(db) && /Number\.isFinite\(value\) \? Math\.min\(100, Math\.max\(0, value\)\) : 10/.test(db));
ok('opening/closing cash sessions validate actor and money', /مبلغ افتتاح الصندوق غير صالح/.test(db) && /المبلغ الفعلي في الصندوق غير صالح/.test(db) && /لا يمكن إغلاق جلسة صندوق/.test(db));
const preloadChannels=new Set([...preload.matchAll(/\.(?:invoke|send|sendSync)\(\s*['"]([^'"]+)['"]/g)].map(m=>m[1]));
const mainHandlers=new Set([...main.matchAll(/ipcMain\.handle\(\s*['"]([^'"]+)['"]/g)].map(m=>m[1]));
ok('every preload IPC channel has a main handler', [...preloadChannels].every(ch => mainHandlers.has(ch)));
console.log(`V${pkg.version} DEEP AUDIT: ${passed}/${passed+failed} passed`);
process.exitCode=failed?1:0;
