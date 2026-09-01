const fs=require('fs'); const path=require('path');
const root=path.resolve(__dirname,'..');
const db=fs.readFileSync(path.join(root,'database','db.js'),'utf8');
const main=fs.readFileSync(path.join(root,'main.js'),'utf8');
const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
const checks=[
 ['release bumped to 0.45.0+', /^0\.45\./.test(pkg.version)],
 ['payment currency is validated', /\^\[A-Z\]\{3\}\$/.test(db)],
 ['sync cannot enable without token', /config\.enabled && !String\(config\.token/.test(db)],
 ['restore validates the restored database before relaunch', /restoredValidation = db\.validateBackupFile\(dbPath\)/.test(main)],
 ['restore attempts safety rollback on failure', /copyFileSync\(safetyPath, dbPath\)/.test(main)],
 ['printing handles document load failure', /did-fail-load/.test(main)],
 ['printing has readiness timeout', /انتهت مهلة تجهيز مستند الطباعة/.test(main)],
 ['sale readiness gate exists', fs.existsSync(path.join(root,'tools','sale-readiness.js'))],
 ['manager approval grant survives renderer state', /const approval = \{ approverId: result\.approverId, approverName: result\.approverName, grantId: result\.grantId \}/.test(fs.readFileSync(path.join(root,'renderer','pos.js'),'utf8'))],
 ['auto-update is blocked without a real publish provider', /function isUpdateProviderConfigured\(\)/.test(main) && /خدمة التحديث التلقائي غير مُهيأة بعد/.test(main)],
 ['i18n catalog has no duplicate keys per language', (() => {
   const source=fs.readFileSync(path.join(root,'renderer','i18n.js'),'utf8');
   function blockFor(lang){
     const start=source.search(new RegExp('\\b'+lang+':\\s*\\{'));
     if(start<0) return '';
     let depth=0, begun=false, end=-1;
     for(let i=source.indexOf('{',start); i<source.length; i++){
       if(source[i]==='{'){ depth++; begun=true; }
       else if(source[i]==='}' && begun){ depth--; if(depth===0){ end=i+1; break; } }
     }
     return end>0 ? source.slice(start,end) : '';
   }
   function duplicateKeys(block){
     const keys=new Set();
     for(const m of block.matchAll(/^\s{4}([A-Za-z0-9_]+):/gm)){ if(keys.has(m[1])) return true; keys.add(m[1]); }
     return false;
   }
   return ['ar','tr','en'].every(lang => { const b=blockFor(lang); return !!b && !duplicateKeys(b); });
 })()],
];;
let passed=0; for(const [name,ok] of checks){ if(ok){console.log('PASS:',name);passed++;} else {console.error('FAIL:',name); process.exitCode=1;} }
console.log(`V0.45.0 SALE REGRESSION: ${passed}/${checks.length} passed`);
