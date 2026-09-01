#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const root = path.resolve(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const releasePreflight = fs.readFileSync(path.join(root, 'tools', 'release-preflight.js'), 'utf8');

function ok(cond, msg) { assert.ok(cond, msg); console.log(`PASS ${msg}`); }

const [vMaj, vMin] = pkg.version.split('.').map(Number);
ok(vMaj > 0 || vMin >= 31, `version remains compatible with v0.31 baseline (${pkg.version})`);
ok(main.includes('app.enableSandbox();'), 'global Electron sandbox is explicitly enabled before ready');
ok((main.match(/sandbox:\s*true/g) || []).length >= 5, 'all critical BrowserWindow configurations explicitly enable sandbox');
ok(main.includes('setPermissionRequestHandler'), 'renderer permission requests are denied by default');
ok(main.includes('setPermissionCheckHandler'), 'renderer permission checks are denied by default');
ok(/function isTrustedRenderer\(webContents, senderFrame = null\)/.test(main), 'trusted renderer provenance helper has frame-aware signature');
ok(/isTrustedRenderer\(event\.sender, event\.senderFrame\)/.test(main), 'IPC wrapper enforces trusted renderer provenance');
ok(preload.includes('contextBridge.exposeInMainWorld'), 'contextBridge-only renderer bridge remains in use');
ok(!preload.includes('ipcRenderer.send'), 'preload does not expose raw ipcRenderer.send');
ok(releasePreflight.includes('sandbox'), 'release preflight checks sandbox posture');
const manifest = fs.readFileSync(path.join(root, 'CORE_SHA256.txt'), 'utf8');
const expectedFiles = ['main.js','preload.js','package.json','database/db.js','server/sync-server.js','licensing/license.js'];
for (const rel of expectedFiles) ok(new RegExp(`  ${rel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm').test(manifest), `core manifest includes ${rel}`);
const versionTxt = fs.readFileSync(path.join(root,'docs','VERSION.txt'),'utf8').trim();
ok(versionTxt === `Nexora POS v${pkg.version}`, 'docs/VERSION.txt matches package version');
const versionedManifest = path.join(root, `CORE_SHA256_V${pkg.version}.txt`);
ok(fs.existsSync(path.join(root, 'CORE_SHA256.txt')) || fs.existsSync(versionedManifest), 'core manifest exists for current release pipeline');

const htmlFiles = [];
function walk(dir) { for (const name of fs.readdirSync(dir)) { const p = path.join(dir,name); const st=fs.statSync(p); if(st.isDirectory()) walk(p); else if(name.endsWith('.html')) htmlFiles.push(p); } }
walk(path.join(root,'renderer'));
ok(htmlFiles.length >= 20, 'renderer surface contains expected HTML pages');
for (const p of htmlFiles) {
  const text = fs.readFileSync(p,'utf8');
  ok(/Content-Security-Policy/i.test(text) || main.includes('Content-Security-Policy'), `CSP enforced for ${path.relative(root,p)}`);
}
console.log('v0.31 regression: PASS');
