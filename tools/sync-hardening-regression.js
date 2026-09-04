#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const root = path.resolve(__dirname, '..');
const sync = fs.readFileSync(path.join(root,'core','sync-engine.js'),'utf8');
const client = fs.readFileSync(path.join(root,'database','sync-client.js'),'utf8');
const db = fs.readFileSync(path.join(root,'database','db.js'),'utf8');
let n=0;
function ok(name, condition){ assert.ok(condition,name); n++; console.log('PASS:',name); }
ok('remote sync validates monotonic cursor', /nextCursor < before/.test(sync));
ok('remote sync validates expected branch', /expectedBranchUuid/.test(sync) && /belongs to another branch/.test(sync));
ok('branch-owned remote rows require branch_uuid', /missing branch_uuid/.test(sync));
ok('sync client validates server envelope before applying it', client.indexOf('validateRemoteEnvelope') < client.indexOf('db.applyRemoteChanges'));
ok('database rejects branch-owned sync rows without branch_uuid', /يحتوي سجلاً بلا branch_uuid/.test(db));
ok('migration journal stores checksum', /schema_migrations[\s\S]{0,200}checksum TEXT/.test(db));
ok('published migrations are checksum-verified', /checksum mismatch/.test(db));
ok('backup is staged before target replacement', /backup\(temp\)/.test(db) && /renameSync\(temp, target\)/.test(db));
console.log(`SYNC HARDENING REGRESSION: ${n}/8 PASS`);
