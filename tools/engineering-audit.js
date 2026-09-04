const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const failures = [];
const warnings = [];
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const has = (p, needle) => read(p).includes(needle);
const ok = (condition, message) => { if (!condition) failures.push(message); };
const warn = (condition, message) => { if (!condition) warnings.push(message); };

const pkg = JSON.parse(read('package.json'));
ok(pkg.version === read('VERSION').trim(), 'package.json and VERSION are out of sync.');
ok(read('docs/VERSION.txt').trim() === `Nexora POS v${pkg.version}`, 'docs/VERSION.txt is out of sync.');
ok(pkg.dependencies?.['better-sqlite3-multiple-ciphers'] === '13.0.3', 'Encrypted SQLite dependency is not pinned to the validated 13.0.3 line.');
ok(pkg.devDependencies?.electron === '44.2.0', 'Electron version differs from the validated 44.2.0 release target.');
ok(pkg.devDependencies?.['electron-builder'] === '26.15.7', 'electron-builder version differs from the validated 26.15.7 line.');

const main = read('main.js');
ok(main.includes('app.enableSandbox()'), 'Electron sandbox is not enabled.');
ok(main.includes('contextIsolation: true'), 'contextIsolation is not enabled.');
ok(main.includes('nodeIntegration: false'), 'nodeIntegration is not disabled.');
ok(main.includes("webContents.setWindowOpenHandler(() => ({ action: 'deny' }))"), 'Untrusted external window opening is not blocked.');
ok(main.includes('isTrustedRenderer(event.sender, event.senderFrame)'), 'IPC sender validation is missing.');
ok(main.includes("'Content-Security-Policy'"), 'Runtime CSP injection is missing.');

const server = read('server/sync-server.js');
ok(server.includes('req.setTimeout(20_000'), 'Sync server request timeout hardening is missing.');
ok(server.includes("application/json"), 'Sync server JSON content-type validation is missing.');
ok(server.includes("x-frame-options"), 'Sync server frame embedding protection is missing.');

const schema = read('database/schema.sql') + read('database/db.js');
for (const table of ['sales','sale_items','payment_transactions','returns','return_items','inventory_movements','customer_ledger','store_credit_ledger','shifts','payroll_payments','fiscal_documents']) {
  ok(schema.includes(`CREATE TABLE IF NOT EXISTS ${table}`), `Required table missing from schema: ${table}`);
}

const pagesDir = path.join(root, 'renderer', 'pages');
for (const name of fs.readdirSync(pagesDir).filter((n) => n.endsWith('.html'))) {
  const text = fs.readFileSync(path.join(pagesDir, name), 'utf8');
  warn(text.includes('i18n.js'), `Page ${name} does not load i18n.js.`);
}

for (const rel of ['main.js','preload.js','database/db.js','server/sync-server.js']) {
  try { execFileSync(process.execPath, ['--check', path.join(root, rel)], { stdio: 'ignore' }); }
  catch { failures.push(`JavaScript syntax check failed: ${rel}`); }
}

warn(fs.existsSync(path.join(root,'node_modules','better-sqlite3-multiple-ciphers')), 'Native SQLite module is not installed in this environment; runtime DB tests cannot be executed here.');
warn(Boolean(process.env.CSC_LINK || process.env.WIN_CSC_LINK || process.env.CSC_NAME), 'Windows code signing credentials are not configured in this environment.');

console.log(`ENGINEERING AUDIT: Nexora POS v${pkg.version}`);
if (warnings.length) { console.log(`WARNINGS (${warnings.length})`); warnings.forEach((w) => console.log(`WARN: ${w}`)); }
if (failures.length) { console.error(`BLOCKERS (${failures.length})`); failures.forEach((f) => console.error(`FAIL: ${f}`)); process.exit(1); }
console.log('ENGINEERING AUDIT: PASS');
