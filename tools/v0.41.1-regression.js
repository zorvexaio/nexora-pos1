'use strict';
const fs=require('fs'); const path=require('path');
const root=path.resolve(__dirname,'..');
function ok(name,v){console.log(`${v?'PASS':'FAIL'} ${name}`); if(!v) process.exitCode=1;}
const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
const lock=JSON.parse(fs.readFileSync(path.join(root,'package-lock.json'),'utf8'));
function versionAtLeast(v, min) { const a=v.split('.').map(Number), b=min.split('.').map(Number); for(let i=0;i<3;i++){ if((a[i]||0)!==(b[i]||0)) return (a[i]||0)>(b[i]||0); } return true; }
ok('version metadata is at least 0.41.1', /^\d+\.\d+\.\d+$/.test(pkg.version) && pkg.version===lock.version && pkg.version===lock.packages[''].version && versionAtLeast(pkg.version,'0.41.1'));
ok('license engine uses non-conflicting licensing path', fs.existsSync(path.join(root,'licensing','license.js')) && /require\(['"]\.\/licensing\/license['"]\)/.test(fs.readFileSync(path.join(root,'main.js'),'utf8')));
const i18n=fs.readFileSync(path.join(root,'renderer','i18n.js'),'utf8');
for(const lang of ['ar','tr','en']) ok(`audit translations ${lang}`, new RegExp(`'audit\\.title'`).test(i18n));
for(const file of fs.readdirSync(path.join(root,'renderer','pages')).filter(f=>f.endsWith('.html'))){const s=fs.readFileSync(path.join(root,'renderer','pages',file),'utf8'); if(s.includes('href="audit.html"')) ok(`${file} localizes audit nav`, /data-i18n="nav\.audit"/.test(s));}
console.log('V0.41.1 REGRESSION COMPLETE');
if(process.exitCode) process.exit(1);
