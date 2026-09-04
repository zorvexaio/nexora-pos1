#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const requireWindowsSigning = process.argv.includes('--windows-signed');

const windowsStructure = path.join(root, 'tools', 'windows-structure-regression.js');
const windowsStructureResult = spawnSync(process.execPath, [windowsStructure], { cwd: root, encoding: 'utf8' });
if (windowsStructureResult.status !== 0) fail(windowsStructureResult.stderr || windowsStructureResult.stdout || 'Windows structure regression failed');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const license = fs.readFileSync(path.join(root, 'licensing', 'license.js'), 'utf8');

const manifestScript = path.join(root, 'tools', 'release-manifest.js');
const manifestResult = spawnSync(process.execPath, [manifestScript, '--write'], { cwd: root, encoding: 'utf8' });
if (manifestResult.status !== 0) fail(manifestResult.stderr || manifestResult.stdout || 'release manifest generation failed');

function fail(message) {
  console.error(`RELEASE PREFLIGHT FAIL: ${message}`);
  process.exit(1);
}
function ok(message) { console.log(`RELEASE PREFLIGHT PASS: ${message}`); }

if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) fail(`invalid semver version: ${pkg.version}`);
for (const name of fs.readdirSync(root)) {
  if (/^CORE_SHA256_V\d+\.\d+\.\d+\.txt$/.test(name) && name !== `CORE_SHA256_V${pkg.version}.txt`) fail(`stale manifest present: ${name}`);
}

const manifestCheck = spawnSync(process.execPath, [manifestScript], { cwd: root, encoding: 'utf8' });
if (manifestCheck.status !== 0) fail(manifestCheck.stderr || manifestCheck.stdout || 'release manifest check failed');
const keyDecl = (license.match(/const PUBLIC_KEY_PEM = ([\s\S]*?);\n/) || [null, ''])[1];
if (!keyDecl || keyDecl.includes('REPLACE_WITH_YOUR_GENERATED_PUBLIC_KEY')) fail('license public key is still a placeholder');
try {
  const pem = JSON.parse(keyDecl);
  if (!String(pem).includes('BEGIN PUBLIC KEY')) fail('embedded license public key is malformed');
  crypto.createPublicKey(pem);
} catch (error) {
  fail(`embedded license public key cannot be parsed: ${error.message}`);
}
for (const icon of ['build/icon.ico', 'build/icon.icns', 'build/icon.png']) {
  const p = path.join(root, icon);
  if (!fs.existsSync(p) || fs.statSync(p).size < 1024) fail(`missing/invalid ${icon}`);
}
if (fs.existsSync(path.join(root, 'tools', 'private-key.pem'))) fail('vendor private signing key must never exist inside a distributable source tree');
for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
  if (entry.isDirectory() && /^nexora-pos-v\d+\.\d+\.\d+$/.test(entry.name)) {
    fail(`nested legacy project snapshot must be outside release root: ${entry.name}`);
  }
}
const nodeMajor = Number(process.versions.node.split('.')[0]);
const nodeMinor = Number(process.versions.node.split('.')[1]);
if (nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 12)) fail(`Node.js >=22.12.0 is required for release builds (detected ${process.versions.node})`);
if (pkg.engines?.node !== '>=22.12.0') fail('package engine requirement must remain >=22.12.0');
const disallowedRootArtifacts = fs.readdirSync(root).filter((name) =>
  /_test\.(sqlite|db)$/i.test(name) || /^BUILD_VERIFICATION_V\d+\.log$/.test(name)
);
if (disallowedRootArtifacts.length) fail(`test/build artifacts must not ship: ${disallowedRootArtifacts.join(', ')}`);
if (pkg.dependencies['better-sqlite3-multiple-ciphers'] !== '13.0.3') fail('unexpected SQLite native dependency version');
if (pkg.devDependencies.electron !== '44.2.0') fail('unexpected Electron version');
if (requireWindowsSigning) {
  const signingConfigured = Boolean(process.env.CSC_LINK || process.env.WIN_CSC_LINK || process.env.CSC_KEY_PASSWORD);
  if (!signingConfigured) fail('Windows release signing is not configured. Set CSC_LINK/WIN_CSC_LINK and CSC_KEY_PASSWORD for a commercial installer.');
  ok('Windows code-signing configuration is present');
}
ok(`version ${pkg.version}`);
ok('license public key is real and parseable');
ok('Windows/macOS/Linux icon assets are present');
ok('native dependency versions are pinned');
const htmlFiles = [];
function walkHtml(dir) {
  for (const name of fs.readdirSync(dir)) {
    const current = path.join(dir, name);
    const stat = fs.statSync(current);
    if (stat.isDirectory()) walkHtml(current);
    else if (name.endsWith('.html')) htmlFiles.push(current);
  }
}
walkHtml(path.join(root, 'renderer'));
if (!htmlFiles.length || htmlFiles.some((p) => !fs.readFileSync(p, 'utf8').includes('Content-Security-Policy'))) fail('one or more renderer pages are missing CSP');
const htmlCspMismatches = htmlFiles.filter((p) => {
  const html = fs.readFileSync(p, 'utf8');
  const m = html.match(/Content-Security-Policy[^>]*content="([^"]+)/i);
  return m && /connect-src 'self' https:/.test(m[1]);
});
if (htmlCspMismatches.length) fail(`renderer CSP is broader than the runtime policy: ${htmlCspMismatches.map((p) => path.relative(root, p)).join(', ')}`);
ok('renderer CSP is present and matches the runtime network policy');
const dbSource = fs.readFileSync(path.join(root, 'database', 'db.js'), 'utf8');
if (!dbSource.includes('المزامنة إلى خادم بعيد يجب أن تستخدم HTTPS')) fail('remote sync HTTPS policy is missing');
ok('remote sync HTTPS policy is enforced');

const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
if (!mainSource.includes('app.enableSandbox();')) fail('Electron global sandbox is not explicitly enabled');
if ((mainSource.match(/sandbox:\s*true/g) || []).length < 5) fail('critical BrowserWindow instances are not explicitly sandboxed');
if (!mainSource.includes('setPermissionRequestHandler')) fail('renderer permission request handler is missing');
if (!/isTrustedRenderer\(event\.sender, event\.senderFrame\)/.test(mainSource)) fail('IPC sender trust validation is not enforced');
ok('Electron sandbox, permission hardening, and IPC sender validation are enabled');
const updateSafety = spawnSync(process.execPath, [path.join(root, 'tools', 'update-safety-regression.js')], { cwd: root, encoding: 'utf8' });
if (updateSafety.status !== 0) fail(updateSafety.stderr || updateSafety.stdout || 'Update safety regression failed');
ok('GitHub update feed, pre-install snapshot, and migration journal are configured');
console.log('RELEASE PREFLIGHT: PASS');
