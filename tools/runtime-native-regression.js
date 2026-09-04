'use strict';
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const moduleName = 'better-sqlite3-multiple-ciphers';

function fail(message) {
  console.error(`NATIVE RUNTIME FAIL: ${message}`);
  process.exit(1);
}

const packageJsonPath = path.join(root, 'node_modules', moduleName, 'package.json');
if (!fs.existsSync(packageJsonPath)) {
  fail(`${moduleName} is not installed. Run "npm run setup".`);
}

let Database;
try {
  Database = require(moduleName);
  if (typeof Database !== 'function' && Database && typeof Database.default === 'function') {
    Database = Database.default;
  }
} catch (error) {
  fail(`${moduleName} cannot be loaded. Native rebuild is missing or incompatible. ${error.message}`);
}
if (typeof Database !== 'function') fail(`${moduleName} loaded but did not export a Database constructor.`);

const dbPath = path.join(root, `.native-runtime-${process.pid}.sqlite`);
try {
  const db = new Database(dbPath);
  db.exec('CREATE TABLE IF NOT EXISTS runtime_probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL);');
  db.prepare('INSERT INTO runtime_probe(value) VALUES (?)').run('nexora-native-ok');
  const row = db.prepare('SELECT value FROM runtime_probe LIMIT 1').get();
  db.close();
  if (!row || row.value !== 'nexora-native-ok') fail('SQLite read/write probe returned an unexpected result.');
  console.log(`Native runtime regression: PASS (${pkg.dependencies[moduleName]})`);
} catch (error) {
  fail(`SQLite native open/write/read failed: ${error.message}`);
} finally {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(dbPath + suffix, { force: true }); } catch (_) {}
  }
}
