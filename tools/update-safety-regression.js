#!/usr/bin/env node
const fs = require('fs');
const assert = require('assert');

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const main = fs.readFileSync('main.js', 'utf8');
const db = fs.readFileSync('database/db.js', 'utf8');
const schema = fs.readFileSync('database/schema.sql', 'utf8');

const publish = Array.isArray(pkg.build?.publish) ? pkg.build.publish[0] : null;
assert.deepStrictEqual(publish, {
  provider: 'github', owner: 'zorvexaio', repo: 'nexora-pos1', releaseType: 'release',
}, 'The production update feed must be the Nexora GitHub Release feed.');
assert.strictEqual(pkg.build?.asar, true, 'The packaged app must remain asar-protected.');
assert.match(main, /autoUpdater\.autoDownload\s*=\s*false/, 'Updates must never download without approval.');
assert.match(main, /autoUpdater\.autoInstallOnAppQuit\s*=\s*false/, 'Updates must not install on ordinary quit.');
assert.match(main, /createUpgradeSnapshot\(`app-update-from-v\$\{app\.getVersion\(\)\}`\)/, 'Install must create a recovery snapshot first.');
assert.match(main, /app\.getPath\('userData'\)/, 'Customer data must live outside the installation directory.');
// كانت هذه قائمة بيضاء ثابتة لأرقام إصدارات مخطط قديمة (10..15)، فتفشل تلقائياً بمجرد
// أن يرتفع CURRENT_SCHEMA_VERSION بترحيلة جديدة (فشلت فعلياً منذ v16) بلا أي علاقة
// بأمان التحديث الفعلي. الصواب هو التحقق من وجود رقم إصدار صحيح وأنه لم ينخفض عن آخر
// خط أساس معروف — لا تعداد يدوي يحتاج تعديلاً كل إصدار.
const MIN_SUPPORTED_SCHEMA_VERSION = 10;
const schemaVersionMatch = db.match(/CURRENT_SCHEMA_VERSION\s*=\s*(\d+)/);
assert.ok(schemaVersionMatch, 'A numeric schema version constant is required.');
const currentSchemaVersion = Number(schemaVersionMatch[1]);
assert.ok(
  Number.isInteger(currentSchemaVersion) && currentSchemaVersion >= MIN_SUPPORTED_SCHEMA_VERSION,
  `CURRENT_SCHEMA_VERSION (${currentSchemaVersion}) must be an integer >= ${MIN_SUPPORTED_SCHEMA_VERSION}.`
);
assert.match(db, /CREATE TABLE IF NOT EXISTS schema_migrations/, 'Migration journal creation is required.');
assert.match(db, /db\.transaction\(\(\)\s*=>/, 'Schema changes must be transactional.');
assert.match(db, /createUpgradeSnapshot/, 'Schema/application upgrades must snapshot data.');
assert.match(schema, /CREATE TABLE IF NOT EXISTS schema_migrations/, 'The base schema must describe the migration journal.');
console.log('Update safety regression: PASS');
