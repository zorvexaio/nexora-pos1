#!/usr/bin/env node
// ==========================================================
// أداة إدارة مفاتيح الفروع لسيرفر المزامنة المركزي.
// تعمل مباشرة على قاعدة بيانات السيرفر (central-sync.db) — شغّلها على نفس
// الجهاز اللي شغال عليه server/sync-server.js (أو مرّر POS_SYNC_DB لنفس المسار).
// ==========================================================
//
// الاستخدام:
//   إضافة/تجديد مفتاح فرع (يطبع المفتاح مرة واحدة فقط — احفظه، مش مخزَّن نصاً):
//     node tools/manage-branch-keys.js add --branch <branch-uuid> --label "فرع المعادي"
//
//   عرض كل الفروع المسجَّلة:
//     node tools/manage-branch-keys.js list
//
//   إبطال مفتاح فرع (مثلاً لو الفرع سُرق أو أُغلق):
//     node tools/manage-branch-keys.js revoke --branch <branch-uuid>

const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3-multiple-ciphers');

const args = process.argv.slice(2);
const command = args[0];
function getArg(name) {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 ? args[idx + 1] : null;
}

const dbPath = process.env.POS_SYNC_DB || path.join(__dirname, '..', 'server', 'central-sync.db');
const db = new Database(dbPath);
db.exec(`CREATE TABLE IF NOT EXISTS branch_keys (
  branch_uuid TEXT PRIMARY KEY, key_hash TEXT NOT NULL, label TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), revoked INTEGER NOT NULL DEFAULT 0
)`);

function hashKey(secret) {
  const salt = crypto.randomBytes(16).toString('hex');
  const digest = crypto.scryptSync(secret, salt, 64).toString('hex');
  return `${salt}:${digest}`;
}

if (command === 'add') {
  const branch = getArg('branch');
  const label = getArg('label') || '';
  if (!branch) { console.error('لازم تحدد --branch <branch-uuid>'); process.exit(1); }
  const secret = crypto.randomBytes(24).toString('base64url');
  const keyHash = hashKey(secret);
  db.prepare(`INSERT INTO branch_keys (branch_uuid, key_hash, label, revoked) VALUES (?, ?, ?, 0)
    ON CONFLICT(branch_uuid) DO UPDATE SET key_hash = excluded.key_hash, label = excluded.label, revoked = 0`).run(branch, keyHash, label);
  console.log(`تم تسجيل/تجديد مفتاح الفرع بنجاح.`);
  console.log(`  الفرع: ${branch}${label ? ` (${label})` : ''}`);
  console.log(`  المفتاح (انسخه الآن إلى شاشة الإعدادات في تطبيق هذا الفرع — لن يُطبع مرة أخرى):`);
  console.log(`\n  ${secret}\n`);
  process.exit(0);
}

if (command === 'revoke') {
  const branch = getArg('branch');
  if (!branch) { console.error('لازم تحدد --branch <branch-uuid>'); process.exit(1); }
  const result = db.prepare('UPDATE branch_keys SET revoked = 1 WHERE branch_uuid = ?').run(branch);
  console.log(result.changes ? `تم إبطال مفتاح الفرع ${branch}.` : `لا يوجد فرع مسجَّل بهذا الـ uuid.`);
  process.exit(0);
}

if (command === 'list') {
  const rows = db.prepare('SELECT branch_uuid, label, created_at, revoked FROM branch_keys ORDER BY created_at').all();
  if (!rows.length) { console.log('لا يوجد فروع مسجَّلة بعد.'); process.exit(0); }
  rows.forEach((r) => console.log(`${r.revoked ? '[مُبطَل] ' : '[نشط]   '}${r.branch_uuid}  ${r.label || ''}  (${r.created_at})`));
  process.exit(0);
}

console.log(`
الاستخدام:
  node tools/manage-branch-keys.js add --branch <branch-uuid> --label "اسم الفرع"
  node tools/manage-branch-keys.js list
  node tools/manage-branch-keys.js revoke --branch <branch-uuid>
`);
process.exit(1);
