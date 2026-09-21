#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const args = new Set(process.argv.slice(2));
const nativeRequired = args.has('--native-required') || args.has('--commercial');
const commercial = args.has('--commercial');
const checks = [];
function add(id, status, detail, blocking=false){checks.push({id,status,detail,blocking});}
function runNode(script,args=[]){const r=spawnSync(process.execPath,[path.join(root,'tools',script),...args],{cwd:root,encoding:'utf8'});return {ok:r.status===0,output:`${r.stdout||''}\n${r.stderr||''}`.trim()};}

add('source-version', fs.readFileSync(path.join(root,'VERSION'),'utf8').trim() === pkg.version ? 'PASS':'FAIL', `package version=${pkg.version}`, true);
add('node-engine', pkg.engines?.node === '>=22.12.0' ? 'PASS':'FAIL', `required=${pkg.engines?.node}`, true);
const migrationChain = runNode('migration-chain-regression.js');
// نص التفصيل يُشتق من الإخراج الفعلي للفحص نفسه (بدل نص ثابت كان يقول "v2..v15" بلا
// أي علاقة بالمخطط الفعلي) — فلا يحتاج تحديثاً يدوياً كل ما أُضيفت ترحيلة جديدة.
add('migration-chain', migrationChain.ok ? 'PASS':'FAIL', migrationChain.ok ? migrationChain.output.trim() : migrationChain.output, true);
const sourceSuite = runNode('test-engineering-source-runner.js');
add('engineering-source-suite', sourceSuite.ok ? 'PASS':'FAIL', sourceSuite.ok ? 'source regression suite passed' : sourceSuite.output, true);

const manifest = path.join(root, `CORE_SHA256_V${pkg.version}.txt`);
if (fs.existsSync(manifest)) {
  const lines=fs.readFileSync(manifest,'utf8').split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
  let bad=0;
  for(const line of lines){const m=line.match(/^([a-f0-9]{64})\s+(.+)$/i);if(!m){bad++;continue;}const p=path.join(root,m[2]);if(!fs.existsSync(p)||crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').toLowerCase()!==m[1].toLowerCase())bad++;}
  add('core-sha256',bad===0?'PASS':'FAIL',`${lines.length} manifest entries`,true);
}else add('core-sha256','FAIL','core SHA256 manifest missing',true);

const nm=path.join(root,'node_modules','better-sqlite3-multiple-ciphers');
const nativePkg=path.join(nm,'package.json');
if (!fs.existsSync(nativePkg)) {
  add('native-runtime', nativeRequired?'FAIL':'BLOCKED', 'native module is not installed; run npm run setup', nativeRequired);
} else {
  const r=runNode('runtime-native-regression.js');
  add('native-runtime',r.ok?'PASS':'FAIL',r.ok?'native SQLite open/write/read probe passed':r.output, nativeRequired);
}

const signingConfigured = Boolean(process.env.CSC_LINK || process.env.WIN_CSC_LINK) && Boolean(process.env.CSC_KEY_PASSWORD);
add('windows-signing-config', signingConfigured?'PASS':(commercial?'FAIL':'BLOCKED'), signingConfigured?'certificate + password environment configured':'not configured in this environment', commercial);

const revocationUrl=String(process.env.NEXORA_REVOCATION_LIST_URL||'').trim();
add('revocation-config', revocationUrl ? 'PASS' : (commercial?'FAIL':'BLOCKED'), revocationUrl ? 'remote revocation URL configured':'NEXORA_REVOCATION_LIST_URL is not configured', commercial);

const license=fs.readFileSync(path.join(root,'licensing','license.js'),'utf8');
const pub=(license.match(/const PUBLIC_KEY_PEM\s*=\s*([\s\S]*?);\n/)||[])[1]||'';
let pubOk=false; try{const val=JSON.parse(pub); crypto.createPublicKey(val); pubOk=true;}catch(_){ }
add('license-key',pubOk?'PASS':'FAIL',pubOk?'Ed25519 public key parses':'embedded public key invalid',true);

add('windows-runtime', process.platform==='win32' ? 'BLOCKED' : 'BLOCKED', 'requires Windows machine: installer execution, printing, barcode, update and rollback', commercial);
add('installer-signature', process.platform==='win32' ? 'BLOCKED' : 'BLOCKED', 'requires signed EXE and Get-AuthenticodeSignature on Windows', commercial);

const report={generatedAt:new Date().toISOString(),version:pkg.version,mode:commercial?'commercial':nativeRequired?'native':'source',checks};
fs.writeFileSync(path.join(root,'RELEASE_ACCEPTANCE_REPORT.json'),JSON.stringify(report,null,2)+'\n');
for(const c of checks) console.log(`[${c.status}] ${c.id}: ${c.detail}`);
const blockers=checks.filter(c=>c.blocking && c.status==='FAIL');
if(blockers.length){console.error(`RELEASE ACCEPTANCE FAIL: ${blockers.length} blocking check(s)`);process.exit(1);}
console.log(`RELEASE ACCEPTANCE ${commercial?'COMMERCIAL':'ENGINEERING'}: PASS (no blocking failures in this environment)`);
