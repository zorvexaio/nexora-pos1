'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = pkg.version;
const archiveName = `nexora-pos-v${version}-complete.zip`;
const outputDir = path.resolve(root, '..', 'release-output');
const output = path.join(outputDir, archiveName);
const tempRoot = path.join(outputDir, `nexora-pos-v${version}`);

function fail(msg) {
  console.error(`RELEASE ARCHIVE FAIL: ${msg}`);
  process.exit(1);
}

fs.rmSync(outputDir, { recursive: true, force: true });
fs.mkdirSync(tempRoot, { recursive: true });

const entries = fs.readdirSync(root, { withFileTypes: true });
for (const entry of entries) {
  const src = path.join(root, entry.name);
  const dest = path.join(tempRoot, entry.name);
  if (entry.name === 'dist' || entry.name === 'node_modules' || entry.name === 'release-output' || entry.name === '.git' || entry.name.startsWith('_OLD_') || /^nexora-pos-v\d+\.\d+\.\d+$/.test(entry.name) || /^BUILD_VERIFICATION_V\d+\.log$/.test(entry.name) || /_test\.(sqlite|db)$/i.test(entry.name)) continue;
  fs.cpSync(src, dest, { recursive: true });
}

const staleManifests = fs.readdirSync(tempRoot).filter(
  (name) => /^CORE_SHA256_V\d+\.\d+\.\d+\.txt$/.test(name) && name !== `CORE_SHA256_V${version}.txt`
);
if (staleManifests.length) fail(`stale versioned manifests remain: ${staleManifests.join(', ')}`);

fs.mkdirSync(outputDir, { recursive: true });

const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const code = String.raw`
import pathlib, sys, zipfile
root = pathlib.Path(sys.argv[1])
out = pathlib.Path(sys.argv[2])
with zipfile.ZipFile(out, 'w', compression=zipfile.ZIP_DEFLATED) as z:
    for p in root.rglob('*'):
        if p.is_file():
            z.write(p, p.relative_to(root.parent).as_posix())
with zipfile.ZipFile(out, 'r') as z:
    bad = z.testzip()
    if bad:
        raise SystemExit(f'zip integrity failed: {bad}')
print(out)
`;
const result = spawnSync(python, ['-c', code, tempRoot, output], { encoding: 'utf8' });
if (result.status !== 0) fail(result.stderr || result.stdout || 'zip creation/integrity check failed');

console.log(`RELEASE ARCHIVE PASS: ${output}`);
console.log(`ROOT: nexora-pos-v${version}/`);
