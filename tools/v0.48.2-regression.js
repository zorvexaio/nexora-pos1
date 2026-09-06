#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(root,'package-lock.json'),'utf8'));
const db = fs.readFileSync(path.join(root,'database','db.js'),'utf8');
const client = fs.readFileSync(path.join(root,'database','sync-client.js'),'utf8');
const server = fs.readFileSync(path.join(root,'server','sync-server.js'),'utf8');
const main = fs.readFileSync(path.join(root,'main.js'),'utf8');
assert.ok(/^(?:0\.(?:48|49|50|51|52)\.)/.test(pkg.version));
assert.strictEqual(lock.version, pkg.version);
assert.strictEqual(lock.packages[''].version, pkg.version);
{
  // كان يطابق قائمة ثابتة (10..15) فيفشل تلقائياً مع أي ترحيلة لاحقة (فشل فعلياً منذ v16).
  const m = db.match(/CURRENT_SCHEMA_VERSION\s*=\s*(\d+)/);
  assert.ok(m, 'A numeric schema version constant is required.');
  assert.ok(Number(m[1]) >= 15, 'Schema version must not regress below the v0.48.2 baseline (v15).');
}
assert.match(db, /migration-journal-integrity-v9/);
assert.match(db, /checksum mismatch/);
assert.match(client, /maxAttempts = 3/);
assert.match(client, /validateRemoteEnvelope/);
assert.match(server, /unknownEntities/);
assert.match(server, /Number\(body.cursor \|\| 0\)/);
assert.match(main, /getBusinessLocalDate/);
console.log('V0.48.x ENGINEERING REGRESSION: PASS');
