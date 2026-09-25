'use strict';
const fs=require('fs'); const path=require('path');
const root=path.resolve(__dirname,'..');
function ok(name,v){console.log(`${v?'PASS':'FAIL'} ${name}`); if(!v) process.exitCode=1;}
const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
const lock=JSON.parse(fs.readFileSync(path.join(root,'package-lock.json'),'utf8'));
const main=fs.readFileSync(path.join(root,'main.js'),'utf8');
const db=fs.readFileSync(path.join(root,'database','db.js'),'utf8');
const sync=fs.readFileSync(path.join(root,'server','sync-server.js'),'utf8');
const products=fs.readFileSync(path.join(root,'renderer','pages','products.js'),'utf8');
function versionAtLeast(v, min) { const a=v.split('.').map(Number), b=min.split('.').map(Number); for(let i=0;i<3;i++){ if((a[i]||0)!==(b[i]||0)) return (a[i]||0)>(b[i]||0); } return true; }
ok('version metadata is at least 0.41.3', /^\d+\.\d+\.\d+$/.test(pkg.version) && pkg.version===lock.version && pkg.version===lock.packages[''].version && versionAtLeast(pkg.version,'0.41.3'));
ok('account-ready requires authenticated user',/function requireAccountReady\(\)\s*\{\s*if \(!currentUser\)/.test(main));
ok('product image path is escaped',/esc(?:apeHtml|Attr)\(p\.image_path \|\| PLACEHOLDER_IMG\)/.test(products));
ok('bundle update is branch-scoped',/UPDATE bundles SET[\s\S]{0,500}WHERE id = \? AND branch_id = \?/.test(db));
ok('bundle delete is branch-scoped',/DELETE FROM bundles WHERE id = \? AND branch_id = \?/.test(db));
ok('sync timestamps reject invalid values',/Invalid timestamp for/.test(sync));
ok('sync timestamps reject far-future values',/Timestamp too far in the future/.test(sync));
ok('sync timestamp is normalized to ISO',/normalizedStamp = parsedStamp\.toISOString\(\)/.test(sync));
console.log('V0.41.3 REGRESSION COMPLETE');
if(process.exitCode) process.exit(1);
