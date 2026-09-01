#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const files = [
  'main.js',
  'preload.js',
  'package.json',
  'database/db.js',
  'server/sync-server.js',
  'licensing/license.js'
];

function hashFile(rel) {
  const buf = fs.readFileSync(path.join(root, rel));
  return crypto.createHash('sha256').update(buf).digest('hex');
}

const lines = files.map((rel) => `${hashFile(rel)}  ${rel}`).join('\n') + '\n';
const generic = path.join(root, 'CORE_SHA256.txt');
const versioned = path.join(root, `CORE_SHA256_V${pkg.version}.txt`);

for (const name of fs.readdirSync(root)) {
  if (/^CORE_SHA256_V\d+\.\d+\.\d+\.txt$/.test(name) && name !== path.basename(versioned)) {
    fs.rmSync(path.join(root, name), { force: true });
  }
}
const versionTxt = path.join(root, 'docs', 'VERSION.txt');

const write = process.argv.includes('--write');
const fail = (msg) => { console.error(`RELEASE MANIFEST FAIL: ${msg}`); process.exit(1); };

if (write) {
  fs.writeFileSync(generic, lines, 'utf8');
  fs.writeFileSync(versioned, lines, 'utf8');
  fs.mkdirSync(path.dirname(versionTxt), { recursive: true });
  fs.writeFileSync(versionTxt, `Nexora POS v${pkg.version}\n`, 'utf8');
  console.log(`RELEASE MANIFEST: wrote ${path.basename(generic)}, ${path.basename(versioned)}, ${path.relative(root, versionTxt)}`);
} else {
  const expectedVersion = `Nexora POS v${pkg.version}\n`;
  if (!fs.existsSync(generic) || fs.readFileSync(generic, 'utf8') !== lines) fail('CORE_SHA256.txt is stale');
  if (!fs.existsSync(versioned) || fs.readFileSync(versioned, 'utf8') !== lines) fail(`${path.basename(versioned)} is stale`);
  if (!fs.existsSync(versionTxt) || fs.readFileSync(versionTxt, 'utf8') !== expectedVersion) fail('docs/VERSION.txt is stale');
  console.log('RELEASE MANIFEST: PASS');
}
