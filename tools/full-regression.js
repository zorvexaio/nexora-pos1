const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const jsFiles = [];
function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    if (['node_modules', 'dist', '.git'].includes(name)) continue;
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p);
    else if (name.endsWith('.js')) jsFiles.push(p);
  }
}
walk(root);
let failed = 0;
for (const file of jsFiles) {
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (r.status !== 0) {
    failed++;
    console.error(`FAIL syntax: ${path.relative(root, file)}\n${r.stderr || r.stdout}`);
  }
}
if (spawnSync(process.execPath, [path.join(root, 'tools', 'security-regression.js')], { stdio: 'inherit' }).status !== 0) failed++;
if (spawnSync(process.execPath, [path.join(root, 'tools', 'payroll-regression.js')], { stdio: 'inherit' }).status !== 0) failed++;
if (spawnSync(process.execPath, [path.join(root, 'tools', 'deep-regression.js')], { stdio: 'inherit' }).status !== 0) failed++;
if (spawnSync(process.execPath, [path.join(root, 'tools', 'v0.21-regression.js')], { stdio: 'inherit' }).status !== 0) failed++;
if (spawnSync(process.execPath, [path.join(root, 'tools', 'users-delete-regression.js')], { stdio: 'inherit' }).status !== 0) failed++;

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
for (const [section, dep] of [
  ['dependencies', 'better-sqlite3-multiple-ciphers'],
  ['devDependencies', 'electron'],
  ['devDependencies', 'electron-builder'],
]) {
  if (!pkg[section]?.[dep]) { console.error(`FAIL package: ${dep}`); failed++; }
}

if (failed) process.exit(1);
console.log(`FULL REGRESSION: PASS (${jsFiles.length} JS files syntax-checked)`);

