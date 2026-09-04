// خادم مزامنة خفيف. يعمل بطريقتين:
//   1) مستقل: `node server/sync-server.js` — لخادم مركزي حقيقي خلف HTTPS يخدم عدة فروع منفصلة.
//      كل فرع له مفتاح خاص به يُدار عبر: node tools/manage-branch-keys.js add --branch <uuid> --label "..."
//   2) مُضمَّن: `createSyncServer({ dbPath, port })` — يُستدعى من main.js نفسه عندما يُفعِّل صاحب
//      المحل "وضع الجهاز الرئيسي" لمشاركة المخزون/المبيعات لحظياً بين عدة كاشيرات بنفس المحل عبر
//      الشبكة المحلية (LAN)، بدون أي إعداد خادم منفصل أو أدوات سطر أوامر.
// راجع docs/CENTRAL_SYNC_PROTOCOL.md و.env.example للتفاصيل الكاملة للبروتوكول.
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const Database = require('better-sqlite3-multiple-ciphers');
const path = require('path');

function send(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none';",
    'strict-transport-security': 'max-age=31536000; includeSubDomains',
  });
  res.end(JSON.stringify(body));
}

function read(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (c) => {
      s += c;
      if (s.length > maxBytes) req.destroy(new Error('payload too large'));
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(s || '{}'));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function verifyKey(secret, hash) {
  const [salt, digest] = String(hash || '').split(':');
  if (!salt || !digest) return false;
  const check = crypto.scryptSync(String(secret || ''), salt, 64);
  const expected = Buffer.from(digest, 'hex');
  return check.length === expected.length && crypto.timingSafeEqual(check, expected);
}

function hashKey(secret) {
  const salt = crypto.randomBytes(16).toString('hex');
  const digest = crypto.scryptSync(secret, salt, 64).toString('hex');
  return `${salt}:${digest}`;
}

const ENTITIES = ['categories', 'products', 'restaurant_tables', 'customers', 'inventory', 'sales', 'payments', 'cash_movements', 'shifts', 'inventory_movements', 'payroll_employees', 'payroll_months', 'payroll_employee_months', 'payroll_transactions', 'payroll_advances', 'payroll_advance_installments', 'payroll_advance_payments', 'payroll_advance_payment_allocations', 'payroll_payments', 'payroll_final_settlements', 'suppliers', 'supplier_ledger', 'purchase_orders', 'returns', 'bundles', 'customer_ledger', 'store_credit_ledger', 'tax_profiles', 'inventory_transfers', 'inventory_transfer_receipts'];
const GLOBAL_ENTITIES = new Set(['categories', 'products']);
const CROSS_BRANCH_ENTITIES = new Set(['inventory_transfers', 'inventory_transfer_receipts']);

// ينشئ خادم مزامنة كامل (HTTP) على قاعدة بيانات SQLite مستقلة عن قاعدة بيانات التطبيق نفسها
// (سجل مركزي للتغييرات، مختلف عن pos.db). يُرجع { server, registerBranchKey, close }.
function createSyncServer({ dbPath, port = 0, rateLimit = 60, onLog = () => {}, getPairingInfo = null, consumePairingCode = null, tls = null, host = null, allowPlaintextNonLoopback = false } = {}) {
  // tls = { key, cert } (نصوص PEM) — يُمرَّر فقط من وضع "الجهاز الرئيسي" المُضمَّن بـ main.js
  // (شهادة ذاتية التوقيع، راجع server/lan-tls.js). الخادم المستقل (تشغيل مباشر خلف بروكسي
  // TLS مثل Nginx/Caddy — راجع docs/CENTRAL_SYNC_PROTOCOL.md) يبقى HTTP عادياً محلياً كما كان،
  // فالبروكسي هو من يتولى TLS بشهادة حقيقية أمام الإنترنت في تلك الحالة.
  const resolvedPath = dbPath || path.join(__dirname, 'central-sync.db');
  const db = new Database(resolvedPath);
  db.exec(`CREATE TABLE IF NOT EXISTS sync_records (
    entity TEXT NOT NULL, entity_uuid TEXT NOT NULL, branch_uuid TEXT, payload TEXT NOT NULL,
    revision INTEGER PRIMARY KEY AUTOINCREMENT, updated_at TEXT NOT NULL,
    source_branch_uuid TEXT, destination_branch_uuid TEXT, UNIQUE(entity, entity_uuid)
  )`);
  for (const col of ['source_branch_uuid TEXT', 'destination_branch_uuid TEXT']) {
    const name = col.split(' ')[0];
    const exists = db.prepare('PRAGMA table_info(sync_records)').all().some((row) => row.name === name);
    if (!exists) db.exec(`ALTER TABLE sync_records ADD COLUMN ${col}`);
  }
  db.exec(`CREATE TABLE IF NOT EXISTS branch_keys (
    branch_uuid TEXT PRIMARY KEY, key_hash TEXT NOT NULL, label TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), revoked INTEGER NOT NULL DEFAULT 0
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS invoice_numbers (
    branch_uuid TEXT NOT NULL, invoice_number TEXT NOT NULL, sale_uuid TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (branch_uuid, invoice_number),
    UNIQUE (branch_uuid, sale_uuid)
  )`);

  // ملاحظة مهمة: لا نستخدم ON CONFLICT DO UPDATE هنا. عمود revision هو AUTOINCREMENT مرتبط
  // بـ rowid الصف، وتحديث صف موجود (UPDATE) لا يُغيّر rowid/الترقيم أبداً — أي تحديث ثانٍ لنفس
  // العنصر (مثلاً كمية المخزون تتغيّر مرة أخرى) كان سيبقى بنفس رقم الـ revision القديم، فيختفي
  // عن أي عميل سبق أن سحب حتى ذلك الرقم رغم وجود بيانات أحدث فعلياً (bug حقيقي مكتشَف بالاختبار).
  // الحل: نحذف الصف القديم وندرج صفاً جديداً بكل تحديث مقبول، فيحصل دائماً على رقم أحدث.
  const selectExisting = db.prepare('SELECT branch_uuid, updated_at FROM sync_records WHERE entity = ? AND entity_uuid = ?');
  const deleteExisting = db.prepare('DELETE FROM sync_records WHERE entity = ? AND entity_uuid = ?');
  const insertFresh = db.prepare(
    `INSERT INTO sync_records (entity,entity_uuid,branch_uuid,payload,updated_at,source_branch_uuid,destination_branch_uuid) VALUES (?,?,?,?,?,?,?)`
  );
  function save(rec) {
    const existing = selectExisting.get(rec.entity, rec.uuid);
    if (existing && existing.branch_uuid && rec.branch && existing.branch_uuid !== rec.branch && !GLOBAL_ENTITIES.has(rec.entity)) {
      throw new Error(`Sync UUID collision across branches for ${rec.entity}:${rec.uuid}`);
    }
    if (existing && existing.updated_at > rec.updated) return; // بيانات موجودة أحدث فعلياً — نتجاهل هذا التحديث الأقدم
    if (existing) deleteExisting.run(rec.entity, rec.uuid);
    insertFresh.run(rec.entity, rec.uuid, GLOBAL_ENTITIES.has(rec.entity) ? null : rec.branch, rec.payload, rec.updated, rec.sourceBranchUuid || null, rec.destinationBranchUuid || null);
  }
  const getKeyStmt = db.prepare('SELECT branch_uuid, key_hash, revoked FROM branch_keys WHERE branch_uuid = ?');
  const reserveInvoiceNumber = db.prepare('INSERT INTO invoice_numbers(branch_uuid, invoice_number, sale_uuid) VALUES(?,?,?)');

  // تسجيل/تجديد مفتاح فرع برمجياً (بدل أداة سطر الأوامر) — يُستخدم من وضع "الجهاز الرئيسي" داخل التطبيق
  function registerBranchKey(branchUuid, label, existingSecret = null) {
    const secret = existingSecret ? String(existingSecret) : crypto.randomBytes(24).toString('base64url');
    if (!/^[A-Za-z0-9_-]{20,200}$/.test(secret)) throw new Error('مفتاح المزامنة غير صالح.');
    db.prepare(
      `INSERT INTO branch_keys (branch_uuid, key_hash, label, revoked) VALUES (?, ?, ?, 0)
       ON CONFLICT(branch_uuid) DO UPDATE SET key_hash = excluded.key_hash, label = excluded.label, revoked = 0`
    ).run(branchUuid, hashKey(secret), label || null);
    return secret;
  }

  const rateBuckets = new Map();
  function rateLimited(ip) {
    const now = Date.now();
    const windowMs = 60_000;
    const bucket = rateBuckets.get(ip);
    if (!bucket || now > bucket.resetAt) {
      rateBuckets.set(ip, { count: 1, resetAt: now + windowMs });
      return false;
    }
    bucket.count += 1;
    return bucket.count > rateLimit;
  }
  const bucketCleanup = setInterval(() => {
    const now = Date.now();
    for (const [ip, b] of rateBuckets) if (now > b.resetAt) rateBuckets.delete(ip);
  }, 5 * 60_000);
  bucketCleanup.unref();

  const requestHandler = async (req, res) => {
    // Defensive network limits: do not allow a slow/stalled peer to occupy a socket forever.
    req.setTimeout(20_000, () => { try { req.destroy(); } catch (_) {} });
    const ip = req.socket.remoteAddress || 'unknown';
    if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true });

    const contentType = String(req.headers['content-type'] || '').toLowerCase();
    const isJson = contentType.split(';', 1)[0].trim() === 'application/json';

    // اقتران جهاز طرفية جديد: يرسل الرمز القصير المعروض على شاشة الجهاز الرئيسي، ويستلم
    // هوية الفرع (uuid/الاسم/نوع النشاط) + سر المزامنة تلقائياً — دون أي نسخ يدوي أو أداة سطر أوامر.
    if (req.method === 'POST' && req.url === '/pair') {
      if (!isJson) return send(res, 415, { message: 'Content-Type يجب أن يكون application/json.' });
      if (rateLimited(ip)) return send(res, 429, { message: 'محاولات كثيرة جداً، حاول لاحقاً.' });
      if (!getPairingInfo) return send(res, 404, { message: 'الاقتران غير مفعَّل على هذا الخادم' });
      let body;
      try {
        body = await read(req, 1000);
      } catch {
        return send(res, 400, { message: 'JSON غير صالح' });
      }
      const info = getPairingInfo();
      if (!info || !info.code) return send(res, 409, { message: 'لا يوجد رمز اقتران فعّال حالياً. افتح شاشة الاقتران بالجهاز الرئيسي أولاً.' });
      if (info.expiresAt && Date.now() > info.expiresAt) return send(res, 409, { message: 'انتهت صلاحية رمز الاقتران. أنشئ رمزاً جديداً.' });

      const submitted = String((body && body.code) || '').trim();
      const expected = String(info.code).trim();
      const match =
        submitted.length === expected.length &&
        crypto.timingSafeEqual(Buffer.from(submitted), Buffer.from(expected));
      if (!match) return send(res, 401, { message: 'رمز الاقتران غير صحيح' });

      if (typeof consumePairingCode === 'function') consumePairingCode();
      return send(res, 200, {
        branchUuid: info.branchUuid,
        branchName: info.branchName,
        businessType: info.businessType,
        syncSecret: info.secret,
      });
    }

    if (req.method !== 'POST' || req.url !== '/api/v1/pos/sync') return send(res, 404, { message: 'Not found' });
    if (!isJson) return send(res, 415, { message: 'Content-Type يجب أن يكون application/json.' });
    if (rateLimited(ip)) return send(res, 429, { message: 'طلبات كثيرة جداً، حاول لاحقاً.' });

    let body;
    try {
      body = await read(req, 10_000_000);
    } catch {
      return send(res, 400, { message: 'JSON غير صالح' });
    }

    const branchUuid = body.branch && body.branch.uuid;
    const authHeader = req.headers.authorization || '';
    const secret = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!branchUuid || !secret) return send(res, 401, { message: 'Unauthorized' });

    const row = getKeyStmt.get(branchUuid);
    if (!row || row.revoked || !verifyKey(secret, row.key_hash)) return send(res, 401, { message: 'Unauthorized' });

    // لا نثق بأي branch UUID يرسله العميل خارج هوية الفرع المرتبطة بالمفتاح المصادق عليه.
    // بدون هذا القيد كان صاحب مفتاح فرع صحيح يستطيع تغيير body.branch.uuid إلى فرع آخر
    // ثم سحب سجلات ذلك الفرع من الاستجابة أو تلويث مخزن المزامنة بهوية فرع مزيفة.
    const authenticatedBranchUuid = row.branch_uuid;
    if (String(body.branch.uuid) !== String(authenticatedBranchUuid)) {
      return send(res, 403, { message: 'هوية الفرع لا تطابق مفتاح المزامنة.' });
    }

    try {
      const changes = body.changes || {};
      if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
        throw new Error('changes يجب أن يكون كائناً صالحاً.');
      }
      const unknownEntities = Object.keys(changes).filter((entity) => !ENTITIES.includes(entity));
      if (unknownEntities.length) throw new Error(`كيانات مزامنة غير مدعومة: ${unknownEntities.slice(0, 10).join(', ')}`);
      const cursor = Number(body.cursor || 0);
      if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('cursor غير صالح.');
      const MAX_ENTITY_ROWS = 1000;
      const MAX_NESTED_ROWS = 500;
      for (const entity of ENTITIES) {
        if (changes[entity] == null) continue;
        if (!Array.isArray(changes[entity])) throw new Error(`changes.${entity} يجب أن يكون مصفوفة.`);
        if (changes[entity].length > MAX_ENTITY_ROWS) throw new Error(`عدد سجلات ${entity} يتجاوز الحد المسموح.`);
        for (const record of changes[entity]) {
          if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error(`سجل ${entity} غير صالح.`);
          for (const nestedKey of ['items']) {
            if (record[nestedKey] !== undefined) {
              if (!Array.isArray(record[nestedKey])) throw new Error(`حقل ${entity}.${nestedKey} غير صالح.`);
              if (record[nestedKey].length > MAX_NESTED_ROWS) throw new Error(`عدد العناصر داخل ${entity} يتجاوز الحد المسموح.`);
            }
          }
        }
      }
      const tx = db.transaction(() =>
        ENTITIES.forEach((entity) =>
          (changes[entity] || []).forEach((r) => {
            // مفتاح احتياطي (بدون uuid صريح) مسموح فقط لسجلات inventory (لها product_uuid دائماً).
            // أي كيان آخر (عملاء/مبيعات/...) بدون uuid يُرفَض بدل توليد مفتاح تصادمي "branchUuid:undefined"
            // يتشارك فيه كل السجلات الناقصة ويُطغى بعضها على بعض بصمت.
            let uuid = r.uuid;
            if (!uuid) {
              if (entity === 'inventory' && r.product_uuid) {
                uuid = `${branchUuid}:${r.product_uuid}`;
              } else {
                onLog(`Sync: rejected ${entity} record without uuid from branch ${branchUuid}`);
                return;
              }
            }
            if (entity === 'sales' && r.invoice_number) {
              try {
                reserveInvoiceNumber.run(branchUuid, String(r.invoice_number), uuid);
              } catch (err) {
                if (!String(err.message || '').includes('UNIQUE')) throw err;
                const existing = db.prepare('SELECT sale_uuid FROM invoice_numbers WHERE branch_uuid=? AND invoice_number=?').get(branchUuid, String(r.invoice_number));
                if (existing && existing.sale_uuid !== uuid) throw new Error(`Invoice number collision for branch ${branchUuid}: ${r.invoice_number}`);
              }
            }
            const rawStamp = r.updated_at || r.created_at || new Date().toISOString();
            const parsedStamp = new Date(rawStamp);
            if (Number.isNaN(parsedStamp.getTime())) {
              throw new Error(`Invalid timestamp for ${entity}:${uuid}`);
            }
            const now = Date.now();
            // Never let a client pin an entity in the future and win every subsequent
            // last-write-wins comparison. A small clock skew is tolerated.
            if (parsedStamp.getTime() > now + 5 * 60 * 1000) {
              throw new Error(`Timestamp too far in the future for ${entity}:${uuid}`);
            }
            const normalizedStamp = parsedStamp.toISOString();
            if (CROSS_BRANCH_ENTITIES.has(entity)) {
              const source = String(r.source_branch_uuid || '').trim();
              const destination = String(r.destination_branch_uuid || '').trim();
              if (!/^[A-Za-z0-9_-]{8,200}$/.test(source) || !/^[A-Za-z0-9_-]{8,200}$/.test(destination) || source === destination) {
                throw new Error(`مسار تحويل غير صالح للكيان ${entity}.`);
              }
              const ownerField = entity === 'inventory_transfers' ? source : destination;
              if (ownerField !== branchUuid) throw new Error(`الفرع المصادق عليه ليس مالك سجل ${entity}.`);
            }
            save({
              entity,
              uuid,
              branch: branchUuid,
              sourceBranchUuid: CROSS_BRANCH_ENTITIES.has(entity) ? String(r.source_branch_uuid) : null,
              destinationBranchUuid: CROSS_BRANCH_ENTITIES.has(entity) ? String(r.destination_branch_uuid) : null,
              payload: JSON.stringify({ ...r, updated_at: normalizedStamp, branch_uuid: branchUuid, _sync_owner_branch: branchUuid }),
              updated: normalizedStamp,
            });
          })
        )
      );
      tx();
      const rows = db.prepare(`SELECT * FROM sync_records WHERE revision > ? AND (branch_uuid = ? OR branch_uuid IS NULL OR source_branch_uuid = ? OR destination_branch_uuid = ?) ORDER BY revision`).all(cursor, branchUuid, branchUuid, branchUuid);
      const response = Object.fromEntries(ENTITIES.map((entity) => [entity, []]));
      rows.forEach((r) => response[r.entity].push(JSON.parse(r.payload)));
      const latest = db.prepare('SELECT COALESCE(MAX(revision),0) AS value FROM sync_records').get().value;
      send(res, 200, { cursor: latest, changes: response });
    } catch (error) {
      send(res, 400, { message: error.message });
    }
  };

  const server = tls
    ? https.createServer({ key: tls.key, cert: tls.cert }, requestHandler)
    : http.createServer(requestHandler);

  const bindHost = host || process.env.POS_SYNC_BIND_HOST || (tls ? '0.0.0.0' : '127.0.0.1');
  const isLoopback = ['127.0.0.1', '::1', 'localhost'].includes(String(bindHost).toLowerCase());
  if (!tls && !isLoopback && !allowPlaintextNonLoopback && process.env.POS_SYNC_ALLOW_INSECURE !== '1') {
    throw new Error('رفض تشغيل خادم المزامنة HTTP على عنوان غير محلي. استخدم TLS أو اضبط POS_SYNC_ALLOW_INSECURE=1 صراحةً.');
  }

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, bindHost, () => {
      const actualPort = server.address().port;
      onLog(`Sync server listening on ${bindHost}:${actualPort}${tls ? ' (TLS)' : ' (HTTP local-only)'}`);
      resolve({
        server,
        port: actualPort,
        host: bindHost,
        registerBranchKey,
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}

module.exports = { createSyncServer };

// عند التشغيل مباشرة: HTTP محلي فقط افتراضياً. للاستخدام خلف reverse proxy TLS يمكن للـproxy الوصول إلى 127.0.0.1،
// أو يمكن ضبط POS_SYNC_BIND_HOST صراحةً مع POS_SYNC_ALLOW_INSECURE=1 فقط إذا كان ذلك مقصوداً.
if (require.main === module) {
  const dbPath = process.env.POS_SYNC_DB || path.join(__dirname, 'central-sync.db');
  const port = Number(process.env.PORT || 8787);
  const rateLimit = Number(process.env.POS_SYNC_RATE_LIMIT || 30);

  createSyncServer({ dbPath, port, rateLimit, onLog: console.log }).then(({ registerBranchKey }) => {
    // نتحقق من وجود فرع مسجَّل واحد على الأقل، فقط للتنبيه — لا ننشئ شيئاً تلقائياً بالوضع المستقل
    const checkDb = new Database(dbPath);
    const count = checkDb.prepare('SELECT COUNT(*) AS n FROM branch_keys').get().n;
    checkDb.close();
    if (count === 0) {
      console.warn(
        'WARNING: لا يوجد أي مفتاح فرع مسجَّل بعد. سجّل فرعاً أولاً عبر: node tools/manage-branch-keys.js add --branch <uuid> --label "..."'
      );
    }
    void registerBranchKey; // غير مُستخدَمة بالوضع المستقل (التسجيل عبر tools/manage-branch-keys.js)
  });
}
