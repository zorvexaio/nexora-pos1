'use strict';
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const syncServer = fs.readFileSync(path.join(root, 'server', 'sync-server.js'), 'utf8');
function pass(m){console.log(`PASS: ${m}`)}
function fail(m){console.error(`FAIL: ${m}`);process.exit(1)}

if (!main.includes('app.requestSingleInstanceLock()')) fail('single-instance lock missing');
pass('Electron single-instance lock enabled');
if (!main.includes('pathToFileURL(destPath).href')) fail('safe file URL conversion missing');
if (!main.includes('MAX_IMAGE_BYTES = 10 * 1024 * 1024')) fail('image upload size cap missing');
if (!main.includes("bytes.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))")) fail('PNG signature validation missing');
if (!main.includes("bytes.subarray(8, 12).toString('ascii') === 'WEBP'")) fail('WEBP signature validation missing');
pass('product image uploads enforce size and content signatures');
if (!syncServer.includes("SELECT branch_uuid, key_hash, revoked FROM branch_keys")) fail('authenticated branch identity is not loaded');
if (!syncServer.includes("String(body.branch.uuid) !== String(authenticatedBranchUuid)")) fail('sync branch identity binding missing');
pass('sync token is cryptographically bound to requested branch identity');
console.log('V0.40.6 HARDENING REGRESSION: PASS');
