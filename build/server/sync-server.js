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
// وحدة قاعدة بيانات التطبيق الحقيقية (منتجات/فئات/طاولات/طلبات) — مختلفة تماماً عن
// اتصال SQLite المحلي أعلاه (المخصَّص فقط لسجل مزامنة central-sync.db). بما أن هذا
// الملف يعمل داخل نفس عملية Electron الرئيسية (main.js)، فطلب هذه الوحدة هنا يُرجع
// نفس singleton المُهيَّأ فعلاً (نفس اتصال قاعدة البيانات المشفّرة)، لا اتصالاً جديداً.
//
// حرج جداً: هذا الـ require يجب أن يبقى "كسولاً" (بداخل دالة، لا أعلى الملف) — main.js
// يستورد createSyncServer من هذا الملف في أعلى main.js مباشرةً (قبل app.whenReady()
// بمراحل)، وrequire لملف بأكمله في Node.js ينفّذ فوراً كل كوده top-level بما فيه أي
// require آخر بداخله. لو كان هذا السطر top-level هنا، فسيُحمَّل database/db.js (ويُنفَّذ
// getEncryptionKey عبر safeStorage) لحظة استيراد sync-server.js نفسه — أي قبل
// app.whenReady() بكثير — وwindows.safeStorage.isEncryptionAvailable() غير موثوقة إطلاقاً
// قبل ذلك (ترجع false)، فتنكسر قاعدة البيانات المشفّرة بالكامل من أول تشغيل. هذا بالضبط
// ما حدث فعلياً عند إضافة ميزة الكرسون (كانت تستورد database/db مباشرة أعلى الملف).
function getAppDb() {
  return require('../database/db');
}

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

function sendHtml(res, status, html) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
    // بخلاف send() (JSON، default-src 'none') هذه صفحة فعلية تحتاج تشغّل سكربتها ونمط
    // التنسيق الداخلي بها فقط — لا مصادر خارجية إطلاقاً (لا شبكة إنترنت متاحة أصلاً بمتجر).
    'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
  });
  res.end(html);
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

// صفحة الكرسون (الجوال/التابلت) — ملف واحد ذاتي الاكتفاء (بلا مكتبات خارجية، بلا إنترنت،
// يتوافق مع بيئة المتجر offline-first). يُخدَّم مباشرة عبر GET /waiter.
const WAITER_PAGE_HTML = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
<title>Nexora POS — الكرسون</title>
<style>
  :root { --primary:#4338ca; --primary-light:#eef0fd; --line:#e2e2ea; --danger:#c0293c; --success:#17845b; }
  * { box-sizing: border-box; }
  body { margin:0; font-family: -apple-system, "Segoe UI", Tahoma, Arial, sans-serif; background:#f7f7fb; color:#1a1a2e; }
  header { background:var(--primary); color:#fff; padding:14px 16px; display:flex; align-items:center; justify-content:space-between; position:sticky; top:0; z-index:5; }
  header h1 { font-size:16px; margin:0; }
  header button { background:rgba(255,255,255,.15); border:none; color:#fff; padding:8px 12px; border-radius:8px; font-size:13px; }
  .screen { display:none; padding:16px; padding-bottom:100px; }
  .screen.active { display:block; }
  .pair-box { max-width:320px; margin:60px auto; text-align:center; }
  .pair-box input { width:100%; font-size:22px; text-align:center; letter-spacing:4px; padding:14px; border:2px solid var(--line); border-radius:12px; margin:16px 0; }
  .btn { display:block; width:100%; padding:14px; border:none; border-radius:12px; background:var(--primary); color:#fff; font-size:16px; font-weight:700; cursor:pointer; }
  .btn:disabled { opacity:.5; }
  .error-msg { color:var(--danger); font-size:13px; margin-top:8px; min-height:18px; }
  .tables-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(110px,1fr)); gap:12px; margin-top:12px; }
  .table-card { background:#fff; border:2px solid var(--line); border-radius:12px; padding:16px 8px; text-align:center; font-weight:700; cursor:pointer; position:relative; }
  .table-card.occupied { border-color:var(--danger); background:#fdecee; }
  .table-card small { display:block; font-weight:400; color:#666; margin-top:4px; font-size:11px; }
  .table-card .bill-btn { position:absolute; top:-8px; inset-inline-end:-8px; background:#f59e0b; color:#fff; border:none; border-radius:50%; width:30px; height:30px; font-size:14px; }
  .cat-tabs { display:flex; gap:8px; overflow-x:auto; padding:4px 0 12px; }
  .cat-tab { flex:0 0 auto; padding:8px 14px; border-radius:20px; border:1px solid var(--line); background:#fff; font-size:13px; font-weight:700; white-space:nowrap; }
  .cat-tab.active { background:var(--primary); color:#fff; border-color:var(--primary); }
  .product-list { display:flex; flex-direction:column; gap:8px; }
  .product-row { background:#fff; border:1px solid var(--line); border-radius:10px; padding:10px 12px; display:flex; align-items:center; justify-content:space-between; }
  .product-row .name { font-weight:700; font-size:14px; }
  .product-row .price { color:#666; font-size:12px; }
  .qty-controls { display:flex; align-items:center; gap:8px; }
  .qty-controls button { width:32px; height:32px; border-radius:8px; border:1px solid var(--line); background:#fff; font-size:18px; font-weight:700; }
  .qty-controls span { min-width:20px; text-align:center; font-weight:800; }
  .cart-bar { position:fixed; bottom:0; inset-inline:0; background:#fff; border-top:1px solid var(--line); padding:12px 16px; display:flex; align-items:center; justify-content:space-between; gap:12px; }
  .cart-bar .count { font-weight:800; }
  .toast { position:fixed; top:70px; inset-inline:16px; background:#1a1a2e; color:#fff; padding:12px 16px; border-radius:10px; text-align:center; z-index:20; display:none; }
  .toast.show { display:block; }
  .empty-hint { text-align:center; color:#888; margin-top:40px; font-size:14px; }
</style>
</head>
<body>

<div id="screen-pair" class="screen active">
  <div class="pair-box">
    <h2>ربط جهاز الكرسون</h2>
    <p style="color:#666; font-size:13px;">اكتب الكود المعروض على شاشة الكاشير الرئيسي (الإعدادات &gt; مشاركة الشبكة المحلية)</p>
    <input id="pairCode" inputmode="numeric" maxlength="8" placeholder="00000000" autofocus />
    <button class="btn" id="pairBtn">ربط الجهاز</button>
    <div class="error-msg" id="pairError"></div>
  </div>
</div>

<div id="screen-tables" class="screen">
  <header><h1 id="branchLabel">الطاولات</h1><button id="refreshTablesBtn">تحديث</button></header>
  <div style="padding:16px;">
    <div class="tables-grid" id="tablesGrid"></div>
  </div>
</div>

<div id="screen-menu" class="screen">
  <header><button id="backToTablesBtn">◀ رجوع</button><h1 id="menuTableLabel"></h1></header>
  <div style="padding:16px;">
    <div class="cat-tabs" id="catTabs"></div>
    <div class="product-list" id="productList"></div>
  </div>
  <div class="cart-bar">
    <span class="count" id="cartCount">0 صنف</span>
    <button class="btn" id="sendOrderBtn" style="width:auto; padding:12px 24px;">إرسال الطلب للمطبخ</button>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
(function () {
  var state = { branchUuid: null, secret: null, products: [], categories: [], activeCategory: null, currentTableId: null, cart: {} };

  function saveSession() { localStorage.setItem('waiter_session', JSON.stringify({ branchUuid: state.branchUuid, secret: state.secret })); }
  function loadSession() {
    try {
      var raw = localStorage.getItem('waiter_session');
      if (!raw) return false;
      var s = JSON.parse(raw);
      if (!s.branchUuid || !s.secret) return false;
      state.branchUuid = s.branchUuid; state.secret = s.secret;
      return true;
    } catch (e) { return false; }
  }
  function showScreen(id) {
    document.querySelectorAll('.screen').forEach(function (el) { el.classList.remove('active'); });
    document.getElementById(id).classList.add('active');
  }
  function showToast(msg) {
    var t = document.getElementById('toast');
    t.textContent = msg; t.classList.add('show');
    setTimeout(function () { t.classList.remove('show'); }, 2200);
  }
  function authHeaders(extra) {
    var h = Object.assign({ 'Authorization': 'Bearer ' + state.secret, 'X-Branch-Uuid': state.branchUuid }, extra || {});
    return h;
  }

  function doPair() {
    var code = document.getElementById('pairCode').value.trim();
    var err = document.getElementById('pairError');
    err.textContent = '';
    if (!/^\\d{8}$/.test(code)) { err.textContent = 'اكتب 8 أرقام.'; return; }
    fetch('/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: code }) })
      .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
      .then(function (res) {
        if (!res.ok) { err.textContent = res.body.message || 'تعذّر الاقتران.'; return; }
        state.branchUuid = res.body.branchUuid; state.secret = res.body.syncSecret;
        saveSession();
        document.getElementById('branchLabel').textContent = res.body.branchName || 'الطاولات';
        loadTables();
      })
      .catch(function () { err.textContent = 'تعذّر الاتصال بالخادم. تأكد من الاتصال بنفس شبكة المحل.'; });
  }

  function loadTables() {
    showScreen('screen-tables');
    fetch('/api/v1/waiter/tables', { headers: authHeaders() })
      .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
      .then(function (res) {
        if (!res.ok) { localStorage.removeItem('waiter_session'); showScreen('screen-pair'); showToast('انتهت صلاحية الاقتران، اربط الجهاز من جديد.'); return; }
        renderTables(res.body.tables || []);
      })
      .catch(function () { showToast('تعذّر تحميل الطاولات.'); });
  }

  function renderTables(tables) {
    var grid = document.getElementById('tablesGrid');
    if (!tables.length) { grid.innerHTML = ''; document.querySelector('#screen-tables .empty-hint') || grid.insertAdjacentHTML('afterend', '<div class="empty-hint">لا توجد طاولات مُعرَّفة بعد.</div>'); return; }
    grid.innerHTML = tables.map(function (t) {
      var occ = t.occupied ? 'occupied' : '';
      var billBtn = t.occupied ? '<button class="bill-btn" data-bill="' + t.id + '" title="طلب الحساب">🔔</button>' : '';
      return '<div class="table-card ' + occ + '" data-id="' + t.id + '" data-name="' + escapeHtml(t.name) + '">' + billBtn + escapeHtml(t.name) + (occ ? '<small>مشغولة</small>' : '<small>فاضية</small>') + '</div>';
    }).join('');
    Array.prototype.forEach.call(grid.querySelectorAll('.table-card'), function (el) {
      el.addEventListener('click', function (e) {
        if (e.target.dataset.bill) return; // زرار الحساب يتعامل بمفرده
        openTable(parseInt(el.dataset.id, 10), el.dataset.name);
      });
    });
    Array.prototype.forEach.call(grid.querySelectorAll('[data-bill]'), function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var tableId = parseInt(btn.dataset.bill, 10);
        fetch('/api/v1/waiter/request-bill', {
          method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ branchUuid: state.branchUuid, tableId: tableId })
        }).then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
          .then(function (res) { showToast(res.ok ? 'تم إرسال طلب الحساب ✓' : (res.body.message || 'تعذّر الإرسال.')); })
          .catch(function () { showToast('تعذّر الاتصال بالخادم.'); });
      });
    });
  }

  function escapeHtml(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }

  function openTable(tableId, tableName) {
    state.currentTableId = tableId; state.cart = {};
    document.getElementById('menuTableLabel').textContent = tableName;
    showScreen('screen-menu');
    if (state.products.length) { renderCategories(); renderProducts(); updateCartBar(); return; }
    fetch('/api/v1/waiter/menu', { headers: authHeaders() })
      .then(function (r) { return r.json(); })
      .then(function (body) {
        state.products = body.products || []; state.categories = body.categories || [];
        renderCategories(); renderProducts(); updateCartBar();
      })
      .catch(function () { showToast('تعذّر تحميل المنتجات.'); });
  }

  function renderCategories() {
    var wrap = document.getElementById('catTabs');
    var tabs = [{ id: null, name: 'الكل' }].concat(state.categories);
    wrap.innerHTML = tabs.map(function (c) {
      var active = (state.activeCategory === c.id) ? 'active' : '';
      return '<div class="cat-tab ' + active + '" data-id="' + (c.id == null ? '' : c.id) + '">' + escapeHtml(c.name) + '</div>';
    }).join('');
    Array.prototype.forEach.call(wrap.querySelectorAll('.cat-tab'), function (el) {
      el.addEventListener('click', function () {
        state.activeCategory = el.dataset.id ? parseInt(el.dataset.id, 10) : null;
        renderCategories(); renderProducts();
      });
    });
  }

  function renderProducts() {
    var list = document.getElementById('productList');
    var items = state.products.filter(function (p) { return !state.activeCategory || p.category_id === state.activeCategory; });
    if (!items.length) { list.innerHTML = '<div class="empty-hint">لا توجد منتجات بهذه الفئة.</div>'; return; }
    list.innerHTML = items.map(function (p) {
      var qty = state.cart[p.id] ? state.cart[p.id].quantity : 0;
      return '<div class="product-row" data-id="' + p.id + '">' +
        '<div><div class="name">' + escapeHtml(p.name) + '</div><div class="price">' + Number(p.price).toFixed(2) + '</div></div>' +
        '<div class="qty-controls">' +
          '<button data-act="minus">−</button><span>' + qty + '</span><button data-act="plus">+</button>' +
        '</div></div>';
    }).join('');
    Array.prototype.forEach.call(list.querySelectorAll('.product-row'), function (row) {
      var id = parseInt(row.dataset.id, 10);
      row.querySelector('[data-act="plus"]').addEventListener('click', function () { changeQty(id, 1); });
      row.querySelector('[data-act="minus"]').addEventListener('click', function () { changeQty(id, -1); });
    });
  }

  function changeQty(productId, delta) {
    var product = state.products.find(function (p) { return p.id === productId; });
    if (!product) return;
    var entry = state.cart[productId] || { productId: productId, quantity: 0 };
    entry.quantity = Math.max(0, entry.quantity + delta);
    if (entry.quantity === 0) delete state.cart[productId]; else state.cart[productId] = entry;
    renderProducts(); updateCartBar();
  }

  function updateCartBar() {
    var count = Object.keys(state.cart).reduce(function (s, k) { return s + state.cart[k].quantity; }, 0);
    document.getElementById('cartCount').textContent = count + ' صنف';
    document.getElementById('sendOrderBtn').disabled = count === 0;
  }

  function sendOrder() {
    var items = Object.keys(state.cart).map(function (k) { return { productId: state.cart[k].productId, quantity: state.cart[k].quantity }; });
    if (!items.length) return;
    var btn = document.getElementById('sendOrderBtn');
    btn.disabled = true; btn.textContent = 'جارٍ الإرسال...';
    fetch('/api/v1/waiter/order', {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ branchUuid: state.branchUuid, tableId: state.currentTableId, items: items })
    })
      .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
      .then(function (res) {
        btn.disabled = false; btn.textContent = 'إرسال الطلب للمطبخ';
        if (!res.ok) { showToast(res.body.message || 'تعذّر إرسال الطلب.'); return; }
        showToast('تم إرسال الطلب للمطبخ ✓');
        loadTables();
      })
      .catch(function () { btn.disabled = false; btn.textContent = 'إرسال الطلب للمطبخ'; showToast('تعذّر الاتصال بالخادم.'); });
  }

  document.getElementById('pairBtn').addEventListener('click', doPair);
  document.getElementById('pairCode').addEventListener('keydown', function (e) { if (e.key === 'Enter') doPair(); });
  document.getElementById('refreshTablesBtn').addEventListener('click', loadTables);
  document.getElementById('backToTablesBtn').addEventListener('click', loadTables);
  document.getElementById('sendOrderBtn').addEventListener('click', sendOrder);

  if (loadSession()) loadTables();
})();
</script>
</body>
</html>`;

const GLOBAL_ENTITIES = new Set(['categories', 'products']);
const CROSS_BRANCH_ENTITIES = new Set(['inventory_transfers', 'inventory_transfer_receipts']);

// ينشئ خادم مزامنة كامل (HTTP) على قاعدة بيانات SQLite مستقلة عن قاعدة بيانات التطبيق نفسها
// (سجل مركزي للتغييرات، مختلف عن pos.db). يُرجع { server, registerBranchKey, close }.
function createSyncServer({ dbPath, port = 0, rateLimit = 60, onLog = () => {}, getPairingInfo = null, consumePairingCode = null, tls = null, host = null, allowPlaintextNonLoopback = false, sendKitchenTicket = null } = {}) {
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

    // ---------------- واجهة الكرسون (طلب من الجوال/التابلت داخل الشبكة المحلية) ----------------
    // الكرسون لا يملك حساب SQLite محلي خاص به إطلاقاً (بخلاف "جهاز طرفية" كامل) — هو فقط
    // متصفح يطلب/يرسل JSON مباشرة لهذا الخادم نفسه، مصادَقاً بنفس سر الاقتران المستخدَم
    // للأجهزة الطرفية العادية (نفس /pair). لا يملك صلاحية الدفع أو إغلاق الطلب — الإضافة
    // للطاولة فقط، والدفع يبقى حصراً من الكاشير الرئيسي.
    function authenticateWaiter(branchUuidHeader) {
      const authHeader = req.headers.authorization || '';
      const secret = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
      if (!branchUuidHeader || !secret) return null;
      const row = getKeyStmt.get(branchUuidHeader);
      if (!row || row.revoked || !verifyKey(secret, row.key_hash)) return null;
      return row.branch_uuid;
    }

    if (req.method === 'GET' && req.url === '/api/v1/waiter/menu') {
      const branchUuid = authenticateWaiter(req.headers['x-branch-uuid']);
      if (!branchUuid) return send(res, 401, { message: 'Unauthorized' });
      try {
        const categories = getAppDb().listCategories();
        const products = getAppDb().listProducts({ limit: 500 });
        return send(res, 200, { categories, products });
      } catch (error) { return send(res, 400, { message: error.message }); }
    }

    if (req.method === 'GET' && req.url === '/api/v1/waiter/tables') {
      const branchUuid = authenticateWaiter(req.headers['x-branch-uuid']);
      if (!branchUuid) return send(res, 401, { message: 'Unauthorized' });
      try {
        return send(res, 200, { tables: getAppDb().listTables() });
      } catch (error) { return send(res, 400, { message: error.message }); }
    }

    if (req.method === 'POST' && req.url === '/api/v1/waiter/order') {
      if (!isJson) return send(res, 415, { message: 'Content-Type يجب أن يكون application/json.' });
      if (rateLimited(ip)) return send(res, 429, { message: 'طلبات كثيرة جداً، حاول لاحقاً.' });
      let body;
      try { body = await read(req, 200_000); } catch { return send(res, 400, { message: 'JSON غير صالح' }); }
      const branchUuid = authenticateWaiter(body.branchUuid);
      if (!branchUuid) return send(res, 401, { message: 'Unauthorized' });
      const tableId = Number(body.tableId);
      const items = Array.isArray(body.items) ? body.items : [];
      if (!Number.isInteger(tableId) || tableId <= 0) return send(res, 400, { message: 'طاولة غير صالحة.' });
      if (!items.length) return send(res, 400, { message: 'الطلب فارغ.' });
      if (items.length > 100) return send(res, 400, { message: 'عدد أصناف كبير جداً.' });
      for (const it of items) {
        if (!Number.isInteger(Number(it.productId)) || !(Number(it.quantity) > 0) || Number(it.quantity) > 999) {
          return send(res, 400, { message: 'صنف أو كمية غير صالحة.' });
        }
      }
      try {
        // "إضافة" فقط لا "استبدال": نجمع الكمية المطلوبة الآن فوق أي كمية سابقة موجودة
        // بالفعل بنفس الطلب المفتوح (من كاشير آخر أو كرسون آخر)، بدل حذف ما سبق كتابته —
        // لأن الكرسون لا يرى بالضرورة تفاصيل ما أضافه غيره على نفس الطاولة قبله.
        const openSale = getAppDb().getOrCreateOpenSale(tableId, null);
        const existing = getAppDb().getOpenSaleForTable(tableId);
        const merged = new Map();
        for (const it of (existing && existing.items) || []) {
          const key = `${it.product_id}::${it.notes || ''}`;
          merged.set(key, { productId: it.product_id, quantity: Number(it.quantity), notes: it.notes || '' });
        }
        for (const it of items) {
          const key = `${it.productId}::${it.notes || ''}`;
          const prior = merged.get(key);
          merged.set(key, { productId: Number(it.productId), quantity: (prior ? prior.quantity : 0) + Number(it.quantity), notes: it.notes || '' });
        }
        const result = getAppDb().setOpenSaleItems(openSale.id, Array.from(merged.values()));
        getAppDb().logAudit({ userId: null, action: 'table_order_updated_by_waiter', entityType: 'sale', entityId: openSale.id, details: { itemCount: items.length } });
        let kitchen = null;
        if (typeof sendKitchenTicket === 'function') {
          try { kitchen = await sendKitchenTicket(openSale.id); } catch (_) { kitchen = { success: false }; }
        }
        return send(res, 200, { ...result, saleId: openSale.id, printOutcome: { kitchen } });
      } catch (error) { return send(res, 400, { message: error.message }); }
    }

    if (req.method === 'POST' && req.url === '/api/v1/waiter/request-bill') {
      if (!isJson) return send(res, 415, { message: 'Content-Type يجب أن يكون application/json.' });
      if (rateLimited(ip)) return send(res, 429, { message: 'طلبات كثيرة جداً، حاول لاحقاً.' });
      let body;
      try { body = await read(req, 20_000); } catch { return send(res, 400, { message: 'JSON غير صالح' }); }
      const branchUuid = authenticateWaiter(body.branchUuid);
      if (!branchUuid) return send(res, 401, { message: 'Unauthorized' });
      const tableId = Number(body.tableId);
      if (!Number.isInteger(tableId) || tableId <= 0) return send(res, 400, { message: 'طاولة غير صالحة.' });
      try {
        const openSale = getAppDb().getOpenSaleForTable(tableId);
        if (!openSale) return send(res, 400, { message: 'لا يوجد طلب مفتوح على هذه الطاولة.' });
        return send(res, 200, getAppDb().requestBillForTable(openSale.id));
      } catch (error) { return send(res, 400, { message: error.message }); }
    }

    if (req.method === 'GET' && req.url === '/waiter') return sendHtml(res, 200, WAITER_PAGE_HTML);

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
