'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const pkg = require('../package.json');

const root = path.resolve(__dirname, '..');
const releaseOutput = path.resolve(root, '..', 'release-output');
const archive = path.join(releaseOutput, `nexora-pos-v${pkg.version}-complete.zip`);
let passed = 0;

function pass(name, condition) {
  if (!condition) throw new Error(`FAIL ${name}`);
  passed += 1;
  console.log(`PASS ${name}`);
}

const [vMaj, vMin] = pkg.version.split('.').map(Number);
pass('version is compatible with v0.34 baseline', vMaj > 0 || vMin >= 34);
pass('archive script exists', fs.existsSync(path.join(root, 'tools', 'release-archive.js')));
const scripts = pkg.scripts || {};
pass('release archive command is preflight-gated', scripts['release:archive'] === 'node tools/release-preflight.js && node tools/release-archive.js');

const run = spawnSync(process.execPath, [path.join(root, 'tools', 'release-archive.js')], {
  cwd: root,
  encoding: 'utf8',
  timeout: 120000,
});
pass('release archive command succeeds', run.status === 0);
pass('archive exists', fs.existsSync(archive));

const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const code = String.raw`
import sys, zipfile
archive = sys.argv[1]
with zipfile.ZipFile(archive, 'r') as z:
    names = [n for n in z.namelist() if n and not n.endswith('/')]
    root_prefix = sys.argv[2]
    if not names or not all(name.startswith(root_prefix) for name in names):
        raise SystemExit('archive root mismatch')
    if any('/CORE_SHA256_V' in name and not name.endswith(f'CORE_SHA256_V{sys.argv[3]}.txt') for name in names):
        raise SystemExit('stale manifest present')
    if f'{root_prefix}CORE_SHA256_V{sys.argv[3]}.txt' not in names:
        raise SystemExit('current manifest missing')
    if f'{root_prefix}docs/VERSION.txt' not in names:
        raise SystemExit('version file missing')
print('\n'.join(names))
`;
const inspect = spawnSync(python, ['-c', code, archive, `nexora-pos-v${pkg.version}/`, pkg.version], {
  cwd: root,
  encoding: 'utf8',
  timeout: 120000,
});
if (inspect.status !== 0) throw new Error(`FAIL unable to inspect archive: ${inspect.stderr || inspect.stdout}`);
const listing = inspect.stdout.trim().split(/\r?\n/).filter(Boolean);
pass('archive uses a single versioned root', listing.length > 0 && listing.every((name) => name.startsWith(`nexora-pos-v${pkg.version}/`)));
pass('archive contains no stale versioned manifests', !listing.some((name) => /(^|\/)CORE_SHA256_V\d+\.\d+\.\d+\.txt$/.test(name) && !name.endsWith(`CORE_SHA256_V${pkg.version}.txt`)));
pass('archive contains current manifest', listing.includes(`nexora-pos-v${pkg.version}/CORE_SHA256_V${pkg.version}.txt`));
pass('archive contains current version file', listing.includes(`nexora-pos-v${pkg.version}/docs/VERSION.txt`));

console.log(`V0.34 REGRESSION ${passed}/9 PASS`);
