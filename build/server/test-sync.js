// ==========================================================
// اختبار تكامل حقيقي لخادم المزامنة (server/sync-server.js).
// يشغّل نسخة حقيقية من الخادم على قاعدة بيانات اختبار منفصلة (لا يمسّ central-sync.db
// الحقيقي)، ويسجّل فرعين تجريبيين، ثم يتحقق فعلياً من:
//   1) رفض مفتاح خاطئ
//   2) دفع فرع لتغييراته واستلام فرع آخر لها
//   3) عدم إعادة إرسال بيانات مكررة بعد تحديث المؤشر (cursor)
//   4) تعارض التعديلات: يفوز التعديل الأحدث تاريخاً (Last-Write-Wins)
//   5) لا يقدر فرع ينتحل هوية فرع آخر (يُثبَّت branch_uuid من المفتاح الموثَّق دائماً)
//   6) إبطال مفتاح فرع يمنعه من المزامنة فوراً
//
// التشغيل: node server/test-sync.js
// (يحتاج فقط better-sqlite3-multiple-ciphers مثبتة — نفس اعتماديات الخادم نفسه)
// ==========================================================
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const Database = require('better-sqlite3-multiple-ciphers');

const TEST_DB = path.join(__dirname, 'central-sync.test.db');
const PORT = 8799;
const BASE_URL = `http://localhost:${PORT}`;
const BRANCH_A = { uuid: '11111111-1111-1111-1111-111111111111', name: 'فرع اختبار أ' };
const BRANCH_B = { uuid: '22222222-2222-2222-2222-222222222222', name: 'فرع اختبار ب' };

function hashKey(secret) {
  const salt = crypto.randomBytes(16).toString('hex');
  const digest = crypto.scryptSync(secret, salt, 64).toString('hex');
  return `${salt}:${digest}`;
}

function registerBranch(db, uuid, label) {
  const secret = crypto.randomBytes(24).toString('base64url');
  db.prepare(
    `INSERT INTO branch_keys (branch_uuid, key_hash, label, revoked) VALUES (?, ?, ?, 0)
     ON CONFLICT(branch_uuid) DO UPDATE SET key_hash = excluded.key_hash, label = excluded.label, revoked = 0`
  ).run(uuid, hashKey(secret), label);
  return secret;
}

async function push(branch, token, cursor, changes) {
  const res = await fetch(`${BASE_URL}/api/v1/pos/sync`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ branch, cursor, changes }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

function waitForHealth(retries = 20) {
  return new Promise((resolve, reject) => {
    const attempt = () => {
      fetch(`${BASE_URL}/health`)
        .then(() => resolve())
        .catch(() => {
          if (retries-- <= 0) return reject(new Error('الخادم لم يستجب'));
          setTimeout(attempt, 150);
        });
    };
    attempt();
  });
}

// Windows may keep SQLite's file handle alive for a short moment after the child
// sync server receives SIGTERM. Retrying cleanup makes a successful test exit
// successfully instead of falsely reporting EBUSY after every assertion passed.
async function unlinkWhenReleased(filePath, attempts = 20) {
  for (let i = 0; i < attempts; i += 1) {
    if (!fs.existsSync(filePath)) return;
    try { fs.unlinkSync(filePath); return; }
    catch (error) {
      if (!['EBUSY', 'EPERM', 'EACCES'].includes(error.code) || i === attempts - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

async function stopServer(server) {
  if (!server || server.exitCode !== null) return;
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 2500);
    server.once('exit', () => { clearTimeout(timer); resolve(); });
    server.kill();
  });
}

async function main() {
  await unlinkWhenReleased(TEST_DB);

  const setupDb = new Database(TEST_DB);
  setupDb.exec(`CREATE TABLE IF NOT EXISTS branch_keys (
    branch_uuid TEXT PRIMARY KEY, key_hash TEXT NOT NULL, label TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), revoked INTEGER NOT NULL DEFAULT 0
  )`);
  const KEY_A = registerBranch(setupDb, BRANCH_A.uuid, BRANCH_A.name);
  const KEY_B = registerBranch(setupDb, BRANCH_B.uuid, BRANCH_B.name);
  setupDb.close();

  const server = spawn(process.execPath, [path.join(__dirname, 'sync-server.js')], {
    env: { ...process.env, PORT: String(PORT), POS_SYNC_DB: TEST_DB },
    stdio: 'ignore',
  });

  const cleanup = async () => {
    await stopServer(server);
    await unlinkWhenReleased(TEST_DB);
  };

  try {
    await waitForHealth();

    const badAuth = await push(BRANCH_A, 'wrong-key', '0', {});
    assert(badAuth.status === 401, 'مفتاح خاطئ يجب أن يُرفض');
    console.log('✅ 1) رفض مفتاح خاطئ');

    const productUuid = 'test-product-0001';
    const changesA = {
      categories: [], customers: [], inventory: [], sales: [],
      products: [{ uuid: productUuid, sku: 'SKU1', barcode: '123456', name: 'منتج اختبار',
        category_uuid: null, price: 10, cost: 6, tax_rate: 0, unit: 'piece',
        track_inventory: 1, is_active: 1, image_path: null, variant_size: null,
        variant_color: null, is_recipe: 0, updated_at: new Date().toISOString() }],
    };
    const r1 = await push(BRANCH_A, KEY_A, '0', changesA);
    assert(r1.status === 200, 'دفعة فرع أ الصحيحة يجب أن تُقبل');
    console.log('✅ 2) فرع أ يدفع منتجاً بنجاح');

    const r2 = await push(BRANCH_B, KEY_B, '0', { categories: [], products: [], customers: [], inventory: [], sales: [] });
    const pulled = r2.body.changes.products.find((p) => p.uuid === productUuid);
    assert(pulled && pulled.name === 'منتج اختبار', 'فرع ب يجب أن يستلم منتج فرع أ');
    assert(pulled.branch_uuid === BRANCH_A.uuid, 'branch_uuid يجب أن يكون فرع أ');
    console.log('✅ 3) فرع ب يسحب منتج فرع أ بنجاح');

    const r3 = await push(BRANCH_B, KEY_B, String(r2.body.cursor), { categories: [], products: [], customers: [], inventory: [], sales: [] });
    assert(r3.body.changes.products.length === 0, 'لا يجب إعادة إرسال بيانات مكررة');
    console.log('✅ 4) لا تكرار بعد تحديث المؤشر (cursor)');

    const staleUpdate = { ...changesA.products[0], name: 'تعديل قديم متعارض', updated_at: new Date(Date.now() - 100000).toISOString() };
    await push(BRANCH_B, KEY_B, String(r2.body.cursor), { categories: [], products: [staleUpdate], customers: [], inventory: [], sales: [] });
    const r4 = await push(BRANCH_A, KEY_A, '0', {});
    const latest = r4.body.changes.products.find((p) => p.uuid === productUuid);
    assert(latest.name !== 'تعديل قديم متعارض', 'التعديل الأقدم تاريخاً يجب أن يُرفض (Last-Write-Wins)');
    console.log('✅ 5) تعارض التعديلات محلول بشكل صحيح (الأحدث يفوز)');

    const fakeSale = { uuid: 'fake-sale-1', branch_id: 1, branch_uuid: BRANCH_A.uuid, subtotal: 100,
      tax_total: 0, grand_total: 100, payment_method: 'cash', status: 'completed',
      created_at: new Date().toISOString(), items: [] };
    await push(BRANCH_B, KEY_B, '999999', { categories: [], products: [], customers: [], inventory: [], sales: [fakeSale] });
    const r5 = await push(BRANCH_A, KEY_A, '0', {});
    const savedSale = r5.body.changes.sales.find((s) => s.uuid === 'fake-sale-1');
    assert(!savedSale || savedSale.branch_uuid === BRANCH_B.uuid, 'لا يجوز لفرع انتحال هوية فرع آخر');
    console.log('✅ 6) لا يمكن لفرع انتحال هوية فرع آخر');

    const revokeDb = new Database(TEST_DB);
    revokeDb.prepare('UPDATE branch_keys SET revoked = 1 WHERE branch_uuid = ?').run(BRANCH_A.uuid);
    revokeDb.close();
    const r6 = await push(BRANCH_A, KEY_A, '0', {});
    assert(r6.status === 401, 'مفتاح مُبطَل يجب أن يُرفض فوراً');
    console.log('✅ 7) إبطال مفتاح فرع يمنعه من المزامنة');

    console.log('\nكل اختبارات المزامنة نجحت ✅ — الخادم جاهز للاستخدام.');
    await cleanup();
    process.exit(0);
  } catch (err) {
    console.error('\n❌ فشل الاختبار:', err.message);
    try { await cleanup(); } catch (cleanupError) { console.error('❌ فشل تنظيف اختبار المزامنة:', cleanupError.message); }
    process.exit(1);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

main();
