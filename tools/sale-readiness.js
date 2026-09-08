const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const failures = [];
const warnings = [];
function check(ok, label, detail = '') { if (!ok) failures.push(`${label}${detail ? ` — ${detail}` : ''}`); }
function warn(ok, label, detail = '') { if (!ok) warnings.push(`${label}${detail ? ` — ${detail}` : ''}`); }
function read(rel) { return fs.readFileSync(path.join(root, rel), 'utf8'); }

check(/^0\.(?:48|49|50|51|52)\./.test(pkg.version), 'Release version must be supported 0.48.x/0.49.x/0.50.x/0.51.x/0.52.x', pkg.version);
check(read('VERSION').trim() === pkg.version, 'VERSION matches package.json');
check(read('docs/VERSION.txt').trim() === `Nexora POS v${pkg.version}`, 'docs/VERSION.txt matches package.json');
check(pkg.build?.appId === 'com.zorvexa.nexorapos', 'Stable application ID configured');
check(pkg.build?.productName === 'Nexora POS', 'Product branding configured');
check(fs.existsSync(path.join(root, 'build', 'icon.ico')), 'Windows icon exists');
check(fs.existsSync(path.join(root, 'build', 'icon.icns')), 'macOS icon exists');
check(fs.existsSync(path.join(root, 'build', 'icon.png')), 'Linux icon exists');
check(fs.existsSync(path.join(root, 'licensing', 'license.js')), 'License runtime exists');
const rootEntries = fs.readdirSync(root);
check(!rootEntries.includes('license'), 'Legacy root license path is absent');

for (const candidate of ['private.pem','private.key','license-private.pem','license-private.key','id_rsa']) {
  check(!fs.existsSync(path.join(root, candidate)), `No private credential ${candidate} is bundled`);
}
const allFiles = [];
(function walk(dir) { for (const name of fs.readdirSync(dir)) { if (['node_modules','dist','.git'].includes(name)) continue; const p = path.join(dir,name); const st=fs.statSync(p); if(st.isDirectory()) walk(p); else allFiles.push(p); } })(root);
const privatePatterns = [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, /-----BEGIN PRIVATE KEY-----/];
for (const f of allFiles) {
  if (path.basename(f) === 'sale-readiness.js') continue;
  if (!/\.(js|json|ps1|cmd|env|txt|md|pem|key)$/i.test(f)) continue;
  let text=''; try { text=fs.readFileSync(f,'utf8'); } catch { continue; }
  for (const re of privatePatterns) check(!re.test(text), 'No private key material found in tracked source', path.relative(root,f));
}

const rendererDir = path.join(root,'renderer');
const rendererFiles=[];
(function walkRenderer(dir) { for(const name of fs.readdirSync(dir)){ const p=path.join(dir,name); const st=fs.statSync(p); if(st.isDirectory()) walkRenderer(p); else if(name.endsWith('.js')) rendererFiles.push(p); } })(rendererDir);
for (const f of rendererFiles) {
  try { execFileSync(process.execPath,['--check',f],{stdio:'ignore'}); } catch { failures.push(`Renderer syntax check failed — ${path.relative(root,f)}`); }
}

const main = read('main.js');
check(main.includes('app.enableSandbox()'), 'Electron sandbox enabled');
check(main.includes('contextIsolation: true'), 'Renderer context isolation enabled');
check(main.includes('nodeIntegration: false'), 'Renderer Node integration disabled');
check(main.includes("webContents.setWindowOpenHandler(() => ({ action: 'deny' }))"), 'External windows blocked');
check(main.includes("if (!isTrustedRenderer(event.sender, event.senderFrame))"), 'IPC sender validation enabled');
check(main.includes("'Content-Security-Policy'"), 'Runtime CSP injection exists');

const schema = read('database/schema.sql');
for (const table of ['sales','sale_items','payment_transactions','returns','return_items','inventory_movements','customer_ledger','store_credit_ledger','shifts']) {
  check(schema.includes(`CREATE TABLE IF NOT EXISTS ${table}`), `Required table exists: ${table}`);
}

const publishConfigured = Boolean(pkg.build?.publish);
const updateEnabledInSource = /autoUpdater\.checkForUpdates\(\)/.test(main);
if (updateEnabledInSource && !publishConfigured) {
  warnings.push('Auto-update code exists but package.json has no publish provider. Keep update checks disabled until a real production provider is configured.');
}

const signingConfigured = Boolean(process.env.CSC_LINK || process.env.WIN_CSC_LINK || process.env.CSC_NAME);
if (process.env.REQUIRE_WINDOWS_SIGNING === '1') check(signingConfigured, 'Windows code-signing credentials configured for this release build');
else warn(signingConfigured, 'Windows code signing is not configured in this environment', 'SmartScreen reputation requires a real signing certificate for a commercial release');

if (process.env.REQUIRE_UPDATE_PROVIDER === '1') check(publishConfigured, 'Production update provider configured');

const sha = crypto.createHash('sha256');
sha.update(read('package.json')); sha.update(read('VERSION')); sha.update(read('main.js')); sha.update(read('preload.js'));
console.log(`SALE READINESS: Nexora POS v${pkg.version}`);
console.log(`Core fingerprint: ${sha.digest('hex')}`);
if (warnings.length) { console.log(`WARNINGS (${warnings.length})`); for (const w of warnings) console.log(`WARN: ${w}`); }
if (failures.length) { console.error(`BLOCKERS (${failures.length})`); for (const f of failures) console.error(`FAIL: ${f}`); process.exit(1); }
console.log('SALE READINESS: PASS — codebase and release structure meet the local production gate.');
console.log('NOTE: Windows installer execution, native rebuild, printer drivers, Windows code signing, and any external update/sync infrastructure must still be verified on the release machine before customer delivery.');
