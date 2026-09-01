'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const root = path.resolve(__dirname, '..');
const pkg = require('../package.json');
const outputDir = path.resolve(root, '..', 'release-output');
const archive = path.join(outputDir, `nexora-pos-v${pkg.version}-complete.zip`);
const releaseArchive = path.join(root, 'tools', 'release-archive.js');
function pass(name, condition) { if (!condition) throw new Error(`FAIL ${name}`); console.log(`PASS ${name}`); }
pass('version is 0.40 line', /^0\.(?:4[0-9]|[5-9][0-9])\./.test(pkg.version));
const archiveSource = fs.readFileSync(releaseArchive, 'utf8');
pass('archive script excludes legacy snapshots', /startsWith\('_OLD_'\)/.test(archiveSource) && /nexora-pos-v\\d\+\\.\\d\+\\.\\d\+/.test(archiveSource));
pass('preflight rejects nested project snapshots', /nested legacy project snapshot/.test(fs.readFileSync(path.join(root, 'tools', 'release-preflight.js'), 'utf8')));
const run = spawnSync(process.execPath, [releaseArchive], { cwd: root, encoding: 'utf8', timeout: 120000 });
pass('release archive succeeds', run.status === 0);
pass('archive exists', fs.existsSync(archive));
const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const code = String.raw`
import sys, zipfile
archive=sys.argv[1]
version=sys.argv[2]
with zipfile.ZipFile(archive,'r') as z:
    names=[n for n in z.namelist() if n and not n.endswith('/')]
    root_prefix=f'nexora-pos-v{version}/'
    if not names or not all(n.startswith(root_prefix) for n in names): raise SystemExit('archive root mismatch')
    if any('/_OLD_' in n or '/nexora-pos-v0.' in n for n in names): raise SystemExit('legacy nested snapshot present')
    if f'{root_prefix}CORE_SHA256_V{version}.txt' not in names: raise SystemExit('current manifest missing')
    if f'{root_prefix}docs/VERSION.txt' not in names: raise SystemExit('version file missing')
    if z.testzip() is not None: raise SystemExit('zip integrity failed')
print('ARCHIVE_CHECK PASS')
`;
const inspect = spawnSync(python, ['-c', code, archive, pkg.version], { cwd: root, encoding: 'utf8', timeout: 120000 });
if (inspect.status !== 0) throw new Error(`FAIL archive inspection: ${inspect.stderr || inspect.stdout}`);
console.log(inspect.stdout.trim());
console.log('V0.40 REGRESSION 4/4 PASS');
