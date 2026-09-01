const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const db = fs.readFileSync(path.join(root, 'database', 'db.js'), 'utf8');
const syncClient = fs.readFileSync(path.join(root, 'database', 'sync-client.js'), 'utf8');
const htmlFiles = [];
function walk(dir){ for(const name of fs.readdirSync(dir)){ const p=path.join(dir,name); const st=fs.statSync(p); if(st.isDirectory()) walk(p); else if(p.endsWith('.html')) htmlFiles.push(p); }}
walk(path.join(root,'renderer'));
let failed=0;
function ok(name, cond){ console.log(`${cond?'PASS':'FAIL'} ${name}`); if(!cond) failed++; }
ok('remote sync rejects plaintext HTTP', /المزامنة إلى خادم بعيد يجب أن تستخدم HTTPS/.test(db));
ok('sync client revalidates HTTPS/loopback policy', /target\.protocol !== 'https:'/.test(syncClient) && /isLoopbackHost/.test(syncClient));
ok('theme write requires authenticated account', /ipcMain\.handle\('theme:set'[\s\S]{0,220}requireAccountReady\(\)/.test(main));
ok('image picker requires manager or admin', /ipcMain\.handle\('dialog:selectImage'[\s\S]{0,180}requireManagerOrAdmin\(\)/.test(main));
ok('all renderer HTML has CSP', htmlFiles.length > 0 && htmlFiles.every(p => /Content-Security-Policy/.test(fs.readFileSync(p,'utf8'))));
ok('CSP blocks object execution', htmlFiles.every(p => /object-src 'none'/.test(fs.readFileSync(p,'utf8'))));
process.exitCode=failed?1:0;
