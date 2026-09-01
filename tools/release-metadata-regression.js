const fs=require('fs'); const assert=require('assert');
const pkg=JSON.parse(fs.readFileSync('package.json','utf8'));
const lock=JSON.parse(fs.readFileSync('package-lock.json','utf8'));
assert.strictEqual(pkg.version, lock.version, 'package-lock top-level version must match package.json');
assert.strictEqual(pkg.version, lock.packages[''].version, 'package-lock root package version must match package.json');
assert.strictEqual(pkg.name, lock.name, 'package-lock name must match package.json');
assert.strictEqual(pkg.name, lock.packages[''].name, 'package-lock root package name must match package.json');
assert.strictEqual(pkg.build.productName, 'Nexora POS', 'Windows product name must remain Nexora POS');
console.log('Release metadata regression: PASS');
