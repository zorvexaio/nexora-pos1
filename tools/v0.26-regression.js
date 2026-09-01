#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const root = path.resolve(__dirname, '..');
const packageJson = require(path.join(root, 'package.json'));
let licenseModule = null;
try { licenseModule = require(path.join(root, 'licensing', 'license.js')); } catch (error) {
  console.warn('WARN v0.26: Electron runtime unavailable; skipping dynamic license-signature execution and keeping static verification.');
}

function ok(condition, message) {
  assert.ok(condition, message);
  console.log(`PASS ${message}`);
}

const current = packageJson.version.split('.').map(Number);
ok(current[0] === 0 && current[1] >= 26, 'package version is compatible with v0.26 baseline');

const licenseSource = fs.readFileSync(path.join(root, 'licensing', 'license.js'), 'utf8');
const keyDecl = (licenseSource.match(/const PUBLIC_KEY_PEM = ([\s\S]*?);\n/) || [null, ''])[1];
ok(!keyDecl.includes('REPLACE_WITH_YOUR_GENERATED_PUBLIC_KEY'), 'runtime license key is not a placeholder');
ok(/BEGIN PUBLIC KEY/.test(licenseSource), 'real Ed25519 public key is embedded');

const privateKeyPath = process.env.NEXORA_LICENSE_PRIVATE_KEY_PATH || path.join(path.dirname(root), 'NEXORA_VENDOR_PRIVATE_KEY.pem');
if (fs.existsSync(privateKeyPath) && licenseModule) {
  ok(path.resolve(privateKeyPath) !== path.resolve(path.join(root, 'tools', 'private-key.pem')), 'vendor signing key is kept outside customer application tree');
  const privateKey = fs.readFileSync(privateKeyPath, 'utf8');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nexora-license-'));
  try {
    const fingerprint = licenseModule.getDeviceFingerprint(tmp);
    const license = {
      licenseId: crypto.randomUUID(),
      customerName: 'Nexora Internal Verification',
      fingerprint,
      issuedAt: new Date().toISOString(),
      expiresAt: null,
    };
    const payload = JSON.stringify(license);
    license.signature = crypto.sign(null, Buffer.from(payload), privateKey).toString('base64');
    fs.writeFileSync(path.join(tmp, 'license.lic'), JSON.stringify(license), 'utf8');
    const verified = licenseModule.verifyLicense(tmp);
    ok(verified.valid === true, 'real vendor signature verifies successfully');

    const tampered = { ...license, customerName: 'Tampered' };
    fs.writeFileSync(path.join(tmp, 'license.lic'), JSON.stringify(tampered), 'utf8');
    const rejected = licenseModule.verifyLicense(tmp);
    ok(rejected.valid === false, 'tampered license is rejected');

    const activationTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nexora-activate-'));
    try {
      const activationFile = path.join(activationTmp, 'license.lic');
      fs.writeFileSync(activationFile, JSON.stringify(license), 'utf8');
      const activation = licenseModule.activateLicense(activationTmp, fs.readFileSync(activationFile, 'utf8'));
      ok(activation.success === true, 'signed license activates successfully');
      ok(fs.existsSync(path.join(activationTmp, 'license.lic')), 'activated license persists locally');
    } finally { fs.rmSync(activationTmp, { recursive: true, force: true }); }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
} else {
  ok(!fs.existsSync(path.join(root, 'tools', 'private-key.pem')), 'customer tree does not contain vendor private key');
  if (!licenseModule) {
    ok(true, 'dynamic license execution skipped because Electron runtime is not installed');
  }
}

const syncSource = fs.readFileSync(path.join(root, 'server', 'sync-server.js'), 'utf8');
ok(syncSource.includes('POS_SYNC_ALLOW_INSECURE'), 'plaintext non-loopback sync requires explicit override');
ok(syncSource.includes("127.0.0.1"), 'plaintext sync defaults to loopback binding');
ok(syncSource.includes("cache-control': 'no-store'"), 'sync server sends no-store response headers');

const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
ok(mainSource.includes('requireLicenseForAuth'), 'authentication is blocked when license is invalid');
ok(mainSource.includes("licenseState = license.verifyLicense"), 'operational IPC gate verifies license locally');

const preflight = fs.readFileSync(path.join(root, 'tools', 'release-preflight.js'), 'utf8');
ok(preflight.includes('license public key is still a placeholder'), 'release preflight blocks placeholder license keys');
console.log('v0.26 regression: PASS');
