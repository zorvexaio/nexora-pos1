// عميل مزامنة offline-first. عقد الخادم موثق في docs/CENTRAL_SYNC_PROTOCOL.md.
const { pinnedRequest } = require('../server/pinned-request');

// خادم LAN المُضمَّن (وضع "الجهاز الرئيسي") شهادته ذاتية التوقيع، ونتحقق منها بتثبيت البصمة
// المحفوظة أثناء الاقتران (راجع server/pinned-request.js وserver/lan-tls.js للتفاصيل). خادم
// مركزي حقيقي أُدخل عنوانه يدوياً بشاشة الإعدادات (بشهادة من مرجع ثقة معروف) يستخدم fetch
// العادي بتحقق TLS قياسي كامل بدلاً من ذلك — التمييز يصير حسب وجود بصمة مُثبَّتة أو غياب
async function postJson(config, path, body) {
  const target = new URL(config.serverUrl);
  const isLoopbackHost = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(String(target.hostname).toLowerCase());
  if (target.protocol !== 'https:' && !(target.protocol === 'http:' && isLoopbackHost)) {
    throw new Error('المزامنة مرفوضة: يجب استخدام HTTPS مع الخادم البعيد.');
  }
  if (config.tlsFingerprint && target.protocol === 'https:') {
    const res = await pinnedRequest({
      url: `${target.origin}${path}`,
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.token}` },
      body: JSON.stringify(body),
      timeoutMs: 20000,
      pinnedFingerprint: config.tlsFingerprint,
    });
    return { ok: res.status >= 200 && res.status < 300, status: res.status, json: res.json || {} };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(`${target.origin}${path}`, {
      method: 'POST', signal: controller.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.token}` },
      body: JSON.stringify(body),
    });
    const json = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, json };
  } finally { clearTimeout(timeout); }
}

let syncInFlight = null;
async function syncNow(db) {
  if (syncInFlight) return syncInFlight;
  syncInFlight = (async () => {
  const config = db.getSyncConfig();
  if (!config.enabled || !config.serverUrl) return { success: false, message: 'المزامنة غير مفعّلة أو عنوان الخادم غير مُعدّ.' };
  const payload = db.syncPayload();
  try {
    const { ok, status, json: result } = await postJson(config, '/api/v1/pos/sync', {
      branch: payload.branch, cursor: config.cursor, changes: payload.changes,
    });
    if (!ok) throw new Error(result.message || `الخادم أعاد ${status}`);
    db.applyRemoteChanges(result.changes || {});
    db.markSynced(payload);
    db.setSetting('sync_cursor', String(result.cursor || config.cursor));
    db.setSetting('sync_last_at', new Date().toISOString());
    return { success: true, pushed: Object.values(payload.changes).reduce((n, rows) => n + rows.length, 0), pulled: Object.values(result.changes || {}).reduce((n, rows) => n + rows.length, 0), at: new Date().toISOString() };
  } catch (error) {
    return { success: false, message: `تعذّرت المزامنة: ${error.name === 'AbortError' ? 'انتهت مهلة الاتصال' : error.message}` };
  }
  })();
  try { return await syncInFlight; } finally { syncInFlight = null; }
}
module.exports = { syncNow };
