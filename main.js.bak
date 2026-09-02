const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');
const fs = require('fs');
const crypto = require('crypto');
const { autoUpdater } = require('electron-updater');
const license = require('./licensing/license');
const { exportWorkbook } = require('./database/report-exporter');
const { syncNow } = require('./database/sync-client');
const { createSyncServer } = require('./server/sync-server');
const { startBeacon, startListener, getLocalIPv4Addresses } = require('./server/lan-discovery');
const { getOrCreateServerCert } = require('./server/lan-tls');
const { pinnedRequest } = require('./server/pinned-request');
const PACKAGE_CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));

function isUpdateProviderConfigured() {
  return Boolean(PACKAGE_CONFIG.build?.publish);
}

// منع تشغيل أكثر من نسخة من البرنامج في الوقت نفسه؛ يمنع تعارض الكتابة على قاعدة البيانات
// ويُظهر النسخة الحالية عند ضغط المستخدم على الاختصار مرة أخرى.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
}

// فرض sandbox على كل renderer قبل app.ready وفق توصيات Electron الأمنية.
app.enableSandbox();

// تعطيل تسريع الرسومات (GPU) — بعض كروت الشاشة/التعريفات على ويندوز تسبب تجمّد متقطع
// في استجابة لوحة المفاتيح داخل نوافذ Electron تحديداً. إن لم تكن هذه المشكلة موجودة
// عندك يمكن حذف هذا السطر لاحقاً بدون أي أثر على باقي التطبيق.
app.disableHardwareAcceleration();

// لا تُنزّل التحديث تلقائياً؛ نطلب موافقة المستخدم أولاً بعد إشعاره بوجود إصدار جديد
autoUpdater.autoDownload = false;
// لا تثبّت عند خروج عادي: التثبيت يمر دائماً عبر update:installNow كي نأخذ لقطة
// استرجاع موثّقة من بيانات العميل قبل أن يستبدل NSIS ملفات التطبيق.
autoUpdater.autoInstallOnAppQuit = false;

// يرسل حالة التحديث لنافذة الإعدادات (إن كانت مفتوحة) حتى تحدّث الواجهة
function sendUpdateStatus(status, payload) {
  const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
  if (win) win.webContents.send('update:status', { status, ...payload });
}

autoUpdater.on('checking-for-update', () => sendUpdateStatus('checking'));
autoUpdater.on('update-available', (info) => sendUpdateStatus('available', { version: info.version }));
autoUpdater.on('update-not-available', () => sendUpdateStatus('not-available'));
autoUpdater.on('download-progress', (p) => sendUpdateStatus('downloading', { percent: Math.round(p.percent) }));
autoUpdater.on('update-downloaded', (info) => sendUpdateStatus('downloaded', { version: info.version }));
autoUpdater.on('error', (err) => sendUpdateStatus('error', { message: err == null ? 'خطأ غير معروف' : err.message }));

// لا تُفتح قاعدة البيانات قبل app.whenReady(): مفتاح SQLCipher محفوظ في مخزن
// نظام التشغيل الآمن (safeStorage) ولا يصبح جاهزاً بصورة موثوقة قبل ذلك.
let db;

// يترجم أخطاء قيود قاعدة البيانات الشائعة عند حفظ منتج إلى رسالة عربية مفهومة للكاشير/المدير
function friendlyProductError(err) {
  const message = err && err.message ? err.message : String(err);
  if (message.includes('idx_products_plu_code') || message.includes('plu_code')) {
    return 'كود الصنف (PLU) هذا مستخدم بالفعل لمنتج آخر بيع بالوزن. اختر كوداً مختلفاً.';
  }
  return message;
}

// مجلد حفظ صور المنتجات داخل بيانات المستخدم (يبقى بعد تحديث التطبيق)
function getImagesDir() {
  const dir = path.join(app.getPath('userData'), 'product-images');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

let mainWindow;
let loginWindow;
let licenseWindow;
let splashWindow;

// شاشة ترحيب تظهر أول شيء عند تشغيل التطبيق (تجهيز DB والتحقق من الترخيص يصير خلفها)
function createSplashWindow() {
  splashWindow = new BrowserWindow({
    width: 380,
    height: 380,
    frame: false,
    resizable: false,
    center: true,
    alwaysOnTop: true,
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  splashWindow.setMenuBarVisibility(false);
  splashWindow.loadFile(path.join(__dirname, 'renderer', 'splash.html'));
  splashWindow.on('closed', () => {
    splashWindow = null;
  });
}

function closeSplashWindow() {
  if (splashWindow) {
    splashWindow.close();
    splashWindow = null;
  }
}

function createLicenseWindow() {
  licenseWindow = new BrowserWindow({
    width: 460,
    height: 560,
    resizable: false,
    title: 'تفعيل الترخيص',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  licenseWindow.setMenuBarVisibility(false);
  licenseWindow.once('ready-to-show', () => {
    closeSplashWindow();
    licenseWindow.show();
  });
  licenseWindow.on('closed', () => {
    licenseWindow = null;
  });
  licenseWindow.loadFile(path.join(__dirname, 'renderer', 'license.html'));
}

// يتحقق من الترخيص ويقرر أي شاشة تُفتح أولاً. هذا التحقق يصير هنا فقط (العملية الرئيسية)
// حتى لا يقدر أحد يتجاوزه من الواجهة (renderer) بأدوات المطوّر.
function checkLicenseAndStart() {
  const result = license.verifyLicense(app.getPath('userData'));
  if (!result.valid) {
    createLicenseWindow();
  } else {
    createLoginWindow();
  }
}

// يفحص الترخيص من جديد (بعد تحديث قائمة الإبطال المحلية) وينهي أي جلسة شغّالة فوراً لو تبيّن
// أنه صار مُبطَلاً عن بعد — بدل الاكتفاء بحجبه بإعادة التشغيل التالية فقط.
function enforceLicenseStatus() {
  const result = license.verifyLicense(app.getPath('userData'));
  if (result.valid || result.reason === 'no_license') return;
  if (!mainWindow && !loginWindow) return; // ما في جلسة شغّالة أصلاً (شاشة الترخيص مفتوحة أصلاً)

  const reasonMessage = result.reason === 'expired'
    ? 'انتهت صلاحية ترخيص هذا الجهاز.'
    : result.reason === 'clock_rollback_detected'
      ? 'تم اكتشاف رجوع في ساعة الجهاز. اضبط التاريخ والوقت الصحيحين ثم أعد المحاولة.'
      : result.reason === 'revoked'
        ? 'تم إبطال ترخيص هذا الجهاز. تواصل مع المورّد.'
        : 'تعذّر التحقق من ترخيص هذا الجهاز. تواصل مع المورّد.';
  dialog.showErrorBox('حالة الترخيص', reasonMessage);
  if (syncTimer) clearInterval(syncTimer);
  if (rendererWatchdogTimer) clearInterval(rendererWatchdogTimer);
  if (mainWindow) { mainWindow.close(); mainWindow = null; }
  if (loginWindow) { loginWindow.close(); loginWindow = null; }
  currentUser = null;
  db.logAudit({ action: 'license_revoked_enforced', entityType: 'license', level: 'error' });
  createLicenseWindow();
}

// تحديث قائمة الإبطال بصمت (تحاول اونلاين، وإلا تبقى على آخر نسخة محفوظة محلياً — راجع
// licensing/license.js). يُستدعى عند الإقلاع وبفاصل دوري لاحقاً حتى لا يبقى جهاز مُبطَل شغّالاً
// أياماً قبل ما يُعاد تشغيله.
function refreshLicenseRevocationSilently() {
  license.refreshRevocationList(app.getPath('userData'))
    .then(() => enforceLicenseStatus())
    .catch(() => {});
}

// المستخدم الحالي المسجّل دخوله على هذا الجهاز (جلسة واحدة لكل تشغيل — نمط الكاشير/الصندوق)
// هذه هي المرجعية الوحيدة للصلاحيات: كل صفحة تسأل عن دورها من هنا، لا تثق أي بيانات صلاحية قادمة من الواجهة نفسها
let currentUser = null;
let syncTimer = null;
let rendererWatchdogTimer = null;
let rendererHeartbeat = { at: 0, busy: false, paymentOpen: false, route: '' };
const approvalGrants = new Map();

// دفاع بالعمق: أي قناة IPC غير مذكورة صراحة هنا تتطلب تسجيل دخول تلقائياً.
// هذا يمنع تسرّب بيانات (مبيعات، عملاء، تقارير...) عبر استدعاء window.api مباشرة
// من DevTools قبل تسجيل الدخول، حتى لو نسي مطوّر إضافة تحقق صلاحية بالـ handler نفسه.
// أضف قناة هنا فقط إذا كانت فعلاً تُستخدم من شاشة سابقة لتسجيل الدخول (splash/license/login).
const PUBLIC_IPC_CHANNELS = new Set([
  'auth:bootstrapInfo',
  'auth:login',
  'auth:loginWithPin',
  'auth:logout',
  'auth:currentUser',
  'license:deviceFingerprint',
  'license:status',
  'license:activate',
  'update:currentVersion',
  'setup:isRequired',
  'language:get',
  'language:set',
  'theme:get',
  'theme:set',
  'branding:get', // تُستخدم في splash.html قبل تسجيل الدخول (اسم/شعار المتجر فقط، لا بيانات حساسة)
]);

const _rawIpcHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, listener) => {
  return _rawIpcHandle(channel, (event, ...args) => {
    if (!isTrustedRenderer(event.sender, event.senderFrame)) throw new Error('مصدر IPC غير موثوق.');
    if (PUBLIC_IPC_CHANNELS.has(channel)) return listener(event, ...args);
    if (!currentUser) throw new Error('يجب تسجيل الدخول أولاً.');
    return listener(event, ...args);
  });
};

function recordRuntimeError(error, source) {
  try {
    if (db) db.logAudit({ userId: currentUser?.id, action: 'runtime_error', entityType: source, level: 'error', details: { message: error?.message || String(error), stack: error?.stack || null } });
  } catch (_) { /* لا نسمح لفشل السجل أن يخفي الخطأ الأصلي */ }
}
process.on('unhandledRejection', (error) => recordRuntimeError(error, 'unhandled_rejection'));
process.on('uncaughtException', (error) => {
  recordRuntimeError(error, 'uncaught_exception');
  throw error;
});

function printerSetting(name) { return db.getSetting(name, '0') === '1'; }

// أسماء طابعات "PDF افتراضية" شائعة (لا طابعات فعلية) — نستثنيها من الطباعة التلقائية
// الصامتة، لأن استخدامها يعني أن الفاتورة/تذكرة المطبخ ستتحول صامتةً إلى ملف PDF
// بدل أن تُطبع فعلياً، وهذا غير متوقَّع للمستخدم ولا نريده أبداً في الطباعة التلقائية.
function isVirtualPdfPrinter(name) {
  const n = String(name || '').toLowerCase();
  return /(print to pdf|save as pdf|pdfcreator|cutepdf|dopdf|adobe pdf|bullzip|pdf24|novapdf|win2pdf|pdf writer|onenote|xps document writer)/.test(n);
}

// يحدد الطابعة الفعلية التي ستُستخدم للطباعة الصامتة: الاسم المحدد صراحةً في الإعدادات
// إن كان طابعة حقيقية، وإلا طابعة ويندوز الافتراضية — لكن فقط إن لم تكن طابعة PDF وهمية.
// إن لم توجد طابعة فعلية مناسبة، نوقف الطباعة بدل إنتاج ملف PDF صامت لا يريده أحد.
async function resolvePrintDevice(win, configuredName) {
  let printers = [];
  try { printers = await win.webContents.getPrintersAsync(); } catch (_) { printers = []; }
  if (configuredName) {
    const match = printers.find((p) => p.name === configuredName || p.displayName === configuredName);
    if (match && isVirtualPdfPrinter(match.name || match.displayName)) {
      return { blocked: true, reason: `الطابعة المحددة في الإعدادات (${configuredName}) هي طابعة PDF افتراضية وليست طابعة فعلية. الرجاء اختيار طابعة حقيقية من الإعدادات ← الطباعة التلقائية.` };
    }
    return { deviceName: configuredName };
  }
  const def = printers.find((p) => p.isDefault) || null;
  if (!def) return { blocked: true, reason: 'لم يتم العثور على أي طابعة متصلة بالجهاز.' };
  if (isVirtualPdfPrinter(def.name || def.displayName)) {
    return { blocked: true, reason: `طابعة ويندوز الافتراضية الحالية (${def.displayName || def.name}) هي طابعة PDF وهمية وليست طابعة فعلية. الرجاء اختيار طابعة حقيقية من الإعدادات ← الطباعة التلقائية.` };
  }
  return { deviceName: def.name };
}

// لا تظهر نافذة ولا مربع طباعة: إن كانت الطباعة مفعّلة نرسلها مباشرة إلى الطابعة الافتراضية
// أو إلى الاسم المحدد في الإعدادات. فشل الطابعة يسجَّل ولا يوقف البيع.
function printAutomatically(fileName, saleId, enabledSetting, printerSettingName, label, enabledOverride = null) {
  if (enabledOverride === null ? !printerSetting(enabledSetting) : !enabledOverride) return Promise.resolve({ skipped: true });
  const deviceName = db.getSetting(printerSettingName, '').trim();
  return new Promise((resolve) => {
    const win = new BrowserWindow({ show: false, webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (!win.isDestroyed()) win.destroy();
      resolve(result);
    };
    win.webContents.once('did-fail-load', (_event, errorCode, errorDescription) => {
      const reason = `تعذر تحميل مستند الطباعة (${errorCode}): ${errorDescription || 'unknown'}`;
      db.logAudit({ userId: currentUser?.id, action: 'automatic_print_failed', entityType: 'sale', entityId: saleId, level: 'error', details: { label, reason } });
      finish({ success: false, reason });
    });
    win.webContents.once('did-finish-load', () => {
      let attempts = 0;
      const printWhenReady = () => win.webContents.executeJavaScript(`document.body && document.body.dataset.printReady === '1'`).then(async (ready) => {
        if (!ready && attempts++ < 80) return setTimeout(printWhenReady, 50);
        if (!ready) {
          const reason = 'انتهت مهلة تجهيز مستند الطباعة.';
          db.logAudit({ userId: currentUser?.id, action: 'automatic_print_failed', entityType: 'sale', entityId: saleId, level: 'error', details: { label, reason } });
          finish({ success: false, reason });
          return;
        }
        const resolved = await resolvePrintDevice(win, deviceName);
        if (resolved.blocked) {
          // نوقف الطباعة التلقائية بدل السقوط صامتاً إلى طابعة PDF — هذا هو الفرق بين
          // "لا تُطبع الفاتورة" (يظهر بوضوح في سجل التدقيق) وبين "تتحول الفاتورة إلى
          // ملف PDF غير مرغوب فيه دون أي إشعار".
          db.logAudit({ userId: currentUser?.id, action: 'automatic_print_skipped_no_real_printer', entityType: 'sale', entityId: saleId, level: 'warning', details: { label, reason: resolved.reason } });
          finish({ success: false, blocked: true, reason: resolved.reason });
          return;
        }
        win.webContents.print({ silent: true, printBackground: true, deviceName: resolved.deviceName }, (success, failureReason) => {
          if (!success) db.logAudit({ userId: currentUser?.id, action: 'automatic_print_failed', entityType: 'sale', entityId: saleId, level: 'error', details: { label, reason: failureReason || 'unknown' } });
          else db.logAudit({ userId: currentUser?.id, action: 'automatic_printed', entityType: 'sale', entityId: saleId, details: { label, deviceName: resolved.deviceName } });
          finish({ success, reason: failureReason });
        });
      }).catch((error) => {
        db.logAudit({ userId: currentUser?.id, action: 'automatic_print_failed', entityType: 'sale', entityId: saleId, level: 'error', details: { label, reason: error.message } });
        finish({ success: false, reason: error.message });
      });
      printWhenReady();
    });
    win.loadFile(path.join(__dirname, 'renderer', fileName), { query: { saleId: String(saleId), auto: '1' } }).catch((error) => {
      const reason = error?.message || 'تعذر فتح مستند الطباعة.';
      db.logAudit({ userId: currentUser?.id, action: 'automatic_print_failed', entityType: 'sale', entityId: saleId, level: 'error', details: { label, reason } });
      finish({ success: false, reason });
    });
  });
}

function autoPrintReceipt(saleId) { return printAutomatically('receipt.html', saleId, 'receipt_auto_print', 'receipt_printer_name', 'receipt'); }
function autoSendKitchen(saleId) {
  const enabled = db.getSetting('kitchen_auto_print', '1') === '1';
  return printAutomatically('kitchen-ticket.html', saleId, 'kitchen_auto_print', 'kitchen_printer_name', 'kitchen', enabled);
}

function startBackgroundSync() {
  if (syncTimer) clearInterval(syncTimer);
  if (!db || !db.getSyncConfig().enabled) return;
  // مزامنة سريعة (كل بضع ثوانٍ) لو هذا الجهاز "طرفية" تشارك محلاً مع جهاز رئيسي على نفس الشبكة؛
  // مزامنة عادية (كل 5 دقائق) للفروع المنفصلة عبر الإنترنت — لا داعي للسرعة ولا للضغط على الخادم.
  const intervalMs = db.getSetting('lan_role', 'none') === 'terminal' ? 5 * 1000 : 5 * 60 * 1000;
  // لا نوقف الكاشير عند انقطاع الشبكة؛ كل محاولة فاشلة تترك السجلات محلية للمحاولة التالية.
  syncNow(db).catch(() => {});
  syncTimer = setInterval(() => syncNow(db).catch(() => {}), intervalMs);
  syncTimer.unref?.();
}

/* ==========================================================
   مشاركة بيانات المحل بين عدة كاشيرات على نفس الشبكة المحلية (LAN)
   ========================================================== */
let lanServerHandle = null; // { server, port, registerBranchKey, close } — فقط بوضع "رئيسي"
let lanBeacon = null; // بث الإعلان عن الجهاز — فقط بوضع "رئيسي"
let lanListener = null; // استماع لاكتشاف الأجهزة — فقط بوضع "طرفية"
let discoveredDevices = [];
let currentPairingCode = null;
let pairingCodeExpiresAt = 0;

function stopLanMain() {
  if (lanBeacon) { lanBeacon.stop(); lanBeacon = null; }
  if (lanServerHandle) { lanServerHandle.close().catch(() => {}); lanServerHandle = null; }
  currentPairingCode = null;
  pairingCodeExpiresAt = 0;
}

function stopLanTerminalDiscovery() {
  if (lanListener) { lanListener.stop(); lanListener = null; }
  discoveredDevices = [];
}

// يشغّل هذا الجهاز كـ"جهاز رئيسي": خادم مزامنة مُضمَّن + بث اسمه على الشبكة، دون أي تثبيت أو أداة خارجية
async function startLanMain() {
  stopLanTerminalDiscovery();
  if (lanServerHandle) return lanServerHandle; // يعمل أصلاً

  const branch = db.getCurrentBranch();
  const userDataDir = app.getPath('userData');

  // شهادة TLS ذاتية التوقيع لهذا الجهاز (تُنشأ أول مرة وتبقى ثابتة بعدها — راجع server/lan-tls.js)
  const sanEntries = [
    { type: 'dns', value: 'localhost' },
    { type: 'ip', value: '127.0.0.1' },
    ...getLocalIPv4Addresses().map((ip) => ({ type: 'ip', value: ip })),
  ];
  const lanCert = getOrCreateServerCert(userDataDir, { sanEntries });

  lanServerHandle = await createSyncServer({
    dbPath: path.join(userDataDir, 'lan-sync.db'),
    port: Number(db.getSetting('lan_main_port', '0')) || 0,
    tls: { key: lanCert.keyPem, cert: lanCert.certPem },
    consumePairingCode: () => { currentPairingCode = null; pairingCodeExpiresAt = 0; },
    getPairingInfo: () => {
      if (!currentPairingCode) return null;
      return {
        code: currentPairingCode,
        branchUuid: branch.uuid,
        branchName: branch.name,
        businessType: branch.business_type,
        secret: db.getSetting('lan_branch_secret', ''),
        expiresAt: pairingCodeExpiresAt,
      };
    },
  });
  db.setSetting('lan_main_port', String(lanServerHandle.port));

  // مفتاح مزامنة واحد ثابت لهذا الفرع يُنشأ مرة واحدة فقط ويُعاد استخدامه (لا يتغيّر مع كل اقتران)
  let secret = db.getSetting('lan_branch_secret', '');
  if (!secret) {
    secret = lanServerHandle.registerBranchKey(branch.uuid, db.getSetting('lan_device_name', 'الجهاز الرئيسي'));
    db.setSetting('lan_branch_secret', secret);
  } else {
    lanServerHandle.registerBranchKey(branch.uuid, db.getSetting('lan_device_name', 'الجهاز الرئيسي'), secret);
    // نُعيد تثبيت نفس المفتاح في قاعدة مزامنة LAN إذا أُعيد إنشاء قاعدة الخادم،
    // مع الحفاظ على السر المحفوظ في pos.db — لا نُولّد مفتاحاً جديداً ونترك السر القديم معطلاً.
  }

  lanBeacon = startBeacon(() => ({
    name: db.getSetting('lan_device_name', branch.name),
    port: lanServerHandle.port,
    branchUuid: branch.uuid,
  }));

  // الجهاز الرئيسي أيضاً "يزامن مع نفسه": يدفع تغييراته المحلية إلى الخادم المُضمَّن الذي يستضيفه،
  // ويسحب تغييرات الأجهزة الطرفية الأخرى إلى نسخته المحلية — بدون هذا، مبيعات الطرفيات لن تظهر
  // بتقارير الجهاز الرئيسي، ومنتجات الجهاز الرئيسي لن تصل للطرفيات أبداً.
  db.setSetting('sync_server_url', `https://localhost:${lanServerHandle.port}`);
  db.setSetting('sync_token', secret);
  // الجهاز الرئيسي يعرف بصمة شهادته لأنه هو من ولّدها — يثبّتها لمزامنته الذاتية أيضاً بدل تعطيل
  // التحقق. لن تتغيّر بين عمليات إعادة التشغيل لأن getOrCreateServerCert تعيد استخدام نفس الشهادة.
  db.setSetting('sync_tls_fingerprint', lanCert.fingerprint256);
  db.setSetting('sync_enabled', '1');
  startBackgroundSync();

  return lanServerHandle;
}

// يبدأ الاستماع لاكتشاف الأجهزة الرئيسية على الشبكة (وضع "طرفية")
function startLanTerminalDiscovery() {
  stopLanMain();
  if (lanListener) return;
  lanListener = startListener((devices) => {
    discoveredDevices = devices;
  });
}

function createLoginWindow() {
  loginWindow = new BrowserWindow({
    width: 420,
    height: 520,
    resizable: false,
    title: 'تسجيل الدخول',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  loginWindow.setMenuBarVisibility(false);
  loginWindow.once('ready-to-show', () => {
    closeSplashWindow();
    loginWindow.show();
  });
  loginWindow.loadFile(path.join(__dirname, 'renderer', 'login.html'));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'Nexora POS',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('closed', () => {
    mainWindow = null;
    if (rendererWatchdogTimer) { clearInterval(rendererWatchdogTimer); rendererWatchdogTimer = null; }
  });
  if (rendererWatchdogTimer) clearInterval(rendererWatchdogTimer);
  rendererHeartbeat = { at: Date.now(), busy: false, paymentOpen: false, route: '' };
  rendererWatchdogTimer = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed() || !currentUser) return;
    const age = Date.now() - rendererHeartbeat.at;
    if (age < 12000) return;
    // Never restart the renderer automatically. A forced reload is itself an input/data-loss
    // failure and was perceived by cashiers as a frozen screen. We only audit the missed
    // heartbeat; the renderer's own error/stall handlers surface recovery information.
    if (rendererHeartbeat.paymentOpen || rendererHeartbeat.busy) return;
    const stall = { ageMs: age, route: rendererHeartbeat.route || 'unknown', action: 'no_automatic_reload' };
    try { db.logAudit({ userId: currentUser.id, action: 'renderer_watchdog_stall', entityType: 'renderer', level: 'error', details: stall }); } catch (_) {}
    rendererHeartbeat.at = Date.now();
  }, 3000);
  // mainWindow.webContents.openDevTools(); // فعّلها وقت التطوير
}

// يمنع فتح أدوات المطوّر (وبالتالي console للوصول لـ window.api مباشرة) في النسخة الموزّعة.
// يبقى مفتوحاً أثناء التطوير (npm start) لتسهيل التصحيح.
function isTrustedRenderer(webContents, senderFrame = null) {
  if (!webContents || webContents.isDestroyed()) return false;
  if (senderFrame && senderFrame.isMainFrame === false) return false;
  const url = String(senderFrame?.url || webContents.getURL() || '');
  return url.startsWith('file://');
}

function blockDevToolsInProduction(webContents) {
  if (!app.isPackaged) return;
  webContents.on('before-input-event', (event, input) => {
    const key = (input.key || '').toLowerCase();
    const isDevToolsShortcut =
      key === 'f12' ||
      (input.control && input.shift && (key === 'i' || key === 'j' || key === 'c')) ||
      (input.meta && input.alt && (key === 'i' || key === 'j' || key === 'c'));
    if (isDevToolsShortcut) event.preventDefault();
  });
  webContents.on('devtools-opened', () => webContents.closeDevTools());
}
// صلاحيات Chromium/renderer مقفلة افتراضياً: التطبيق المحلي لا يحتاج geolocation/notifications/media/clipboard
// كصلاحيات نظام. أي تكامل مستقبلي يطلب صلاحية محددة يجب إضافته هنا بشكل صريح.
app.on('web-contents-created', (_event, webContents) => {
  blockDevToolsInProduction(webContents);
  webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  webContents.on('will-navigate', (event, url) => {
    const allowed = url.startsWith('file://');
    if (!allowed) event.preventDefault();
  });
});

// طبقة CSP دفاعية تمنع حقن script/صفحات خارجية حتى لو تسرب محتوى غير موثوق إلى renderer.
const csp = [
  "default-src 'self' file:",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' file: data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');
app.whenReady().then(() => {
  const ses = require('electron').session.defaultSession;
  ses.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  if (typeof ses.setPermissionCheckHandler === 'function') {
    ses.setPermissionCheckHandler(() => false);
  }
  ses.webRequest.onHeadersReceived((details, callback) => {
    callback({ responseHeaders: { ...(details.responseHeaders || {}), 'Content-Security-Policy': [csp] } });
  });

  createSplashWindow();

  try {
    db = require('./database/db');
    db.init(); // إنشاء الجداول إن لم تكن موجودة
  } catch (err) {
    closeSplashWindow();

    if (err && err.name === 'DatabaseKeyMismatchError') {
      const d = err.details || {};
      dialog.showErrorBox(
        'تعذّر فتح قاعدة البيانات',
        'لا يمكن فتح pos.db بالمفتاح الحالي. لم يتم حذف أو تعديل أي ملف.\n\n' +
        `pos.db موجود: ${d.dbExists} (${d.dbSizeBytes} bytes)\n` +
        `pos.db.key موجود: ${d.keyFileExists}\n` +
        `نسخة احتياطية قديمة موجودة: ${d.preEncryptionBackupExists}\n\n` +
        'الأسباب الشائعة: تم نسخ pos.db من جهاز/حساب مستخدم آخر دون نسخ pos.db.key معه ' +
        '(المفتاح مرتبط بحساب ويندوز الحالي عبر safeStorage)، أو تم حذف/استبدال pos.db.key، ' +
        'أو الملف تالف.\n\n' +
        `المسار: ${d.dbPath}`
      );
    } else {
      dialog.showErrorBox(
        'خطأ أثناء تشغيل التطبيق',
        `تعذّر تجهيز قاعدة البيانات:\n${err && err.message ? err.message : err}`
      );
    }
    app.quit();
    return;
  }

  // أداة استعادة كلمة مرور من سطر الأوامر — لما يُنسى كل حساب admin ولا يوجد
  // طريقة تانية للدخول. تعمل فقط محلياً على نفس الجهاز، ولا تُكشف كـ IPC للواجهة.
  // الاستخدام: npm start -- --reset-password=admin:كلمة-مرور-جديدة
  const resetArg = process.argv.find((a) => a.startsWith('--reset-password='));
  if (resetArg) {
    closeSplashWindow();
    const [username, ...pwParts] = resetArg.slice('--reset-password='.length).split(':');
    const newPassword = pwParts.join(':');
    if (!username || !newPassword) {
      console.error('الصيغة الصحيحة: --reset-password=اسم-المستخدم:كلمة-المرور-الجديدة');
    } else {
      const result = db.resetUserPassword(username, newPassword);
      console.log(
        result.success
          ? `تم تغيير كلمة مرور "${username}" بنجاح. أغلق هذا الأمر وشغّل npm start عادي وسجّل دخول بالكلمة الجديدة.`
          : `فشل: ${result.message}`
      );
    }
    app.quit();
    return;
  }

  checkLicenseAndStart();

  // تحديث قائمة إبطال التراخيص بصمت: أول مرة بعد الإقلاع (بدون تأخير — لا تعطّل بدء التشغيل
  // لأنها async ولا تحجب أي نافذة)، ثم كل 6 ساعات بعدها. إن تعذّر الاتصال بالإنترنت تبقى آخر
  // نسخة محفوظة محلياً هي المعتمدة (راجع licensing/license.js لتفاصيل السلوك عند الفشل).
  refreshLicenseRevocationSilently();
  setInterval(refreshLicenseRevocationSilently, 6 * 60 * 60 * 1000);

  // استئناف وضع "مشاركة بين الكاشيرات" تلقائياً بعد إعادة تشغيل التطبيق (لا يحتاج تسجيل دخول
  // أولاً — الجهاز الرئيسي يجب أن يكون جاهزاً لاستقبال الكاشيرات الأخرى فور تشغيله)
  const savedLanRole = db.getSetting('lan_role', 'none');
  if (savedLanRole === 'main') {
    startLanMain().catch((err) => db.logAudit({ action: 'lan_main_autostart_failed', entityType: 'lan', level: 'error', details: { message: err.message } }));
  } else if (savedLanRole === 'terminal') {
    // الطرفية المُقترنة مسبقاً لا تحتاج إعادة اكتشاف — فقط تُكمل المزامنة السريعة تلقائياً
    // (startBackgroundSync يُستدعى أصلاً بعد تسجيل الدخول عبر createWindow/auth handlers)
  }

  // تحقق صامت من وجود تحديث بعد بدء التشغيل (فقط في نسخة موزّعة، وليس أثناء التطوير).
  // الافتراضي هو التحقق فقط؛ لا يتم التنزيل أو التثبيت قبل موافقة المدير من الإعدادات.
  if (app.isPackaged && isUpdateProviderConfigured() && db.getSetting('update_auto_check_on_boot', '1') === '1') {
    setTimeout(() => {
      autoUpdater.checkForUpdates().catch((err) => sendUpdateStatus('error', { message: err.message }));
    }, 5000);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      if (currentUser) createWindow();
      else checkLicenseAndStart();
    }
  });
});

/* ---------------- تحديث التطبيق ---------------- */
// فحص/تنزيل/تثبيت التحديث تتطلب admin على مستوى IPC نفسه، مش بس إخفاء الأزرار بالواجهة —
// أي renderer معدَّل أو نداء IPC مباشر كان راح يلتف على الحماية لو الفحص فقط بالواجهة.
ipcMain.handle('update:check', async () => {
  requireAdmin();
  if (!app.isPackaged) return { ok: false, message: 'التحقق من التحديثات غير متاح أثناء التطوير.' };
  if (!isUpdateProviderConfigured()) return { ok: false, message: 'خدمة التحديث التلقائي غير مُهيأة بعد لهذا الإصدار.' };
  try {
    await autoUpdater.checkForUpdates();
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err.message };
  }
});
ipcMain.handle('update:download', async () => {
  requireAdmin();
  if (!app.isPackaged) return { ok: false, message: 'تنزيل التحديثات غير متاح أثناء التطوير.' };
  if (!isUpdateProviderConfigured()) return { ok: false, message: 'خدمة التحديث التلقائي غير مُهيأة بعد لهذا الإصدار.' };
  try {
    await autoUpdater.downloadUpdate();
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err.message };
  }
});
ipcMain.handle('update:installNow', () => {
  requireAdmin();
  if (!isUpdateProviderConfigured()) throw new Error('خدمة التحديث التلقائي غير مُهيأة بعد لهذا الإصدار.');
  const snapshot = db.createUpgradeSnapshot(`app-update-from-v${app.getVersion()}`);
  db.logAudit({
    userId: currentUser?.id,
    action: 'application_update_install_started',
    entityType: 'application_update',
    entityId: app.getVersion(),
    details: { snapshotPath: snapshot.path },
  });
  autoUpdater.quitAndInstall();
  return { ok: true, snapshotPath: snapshot.path };
});
ipcMain.handle('update:currentVersion', () => app.getVersion());
ipcMain.handle('update:getAutoCheckEnabled', () => db.getSetting('update_auto_check_on_boot', '1') === '1');
ipcMain.handle('update:setAutoCheckEnabled', (_event, enabled) => {
  requireAdmin();
  if (enabled && !isUpdateProviderConfigured()) {
    return { success: false, message: 'لا يمكن تفعيل التحقق التلقائي قبل إعداد مزود تحديث إنتاجي.' };
  }
  try {
    return db.setSetting('update_auto_check_on_boot', enabled ? '1' : '0');
  } catch (err) {
    return { success: false, message: err.message };
  }
});

/* ---------------- الترخيص ---------------- */
ipcMain.handle('license:deviceFingerprint', () => license.getDeviceFingerprint());
ipcMain.handle('license:status', () => license.verifyLicense(app.getPath('userData')));
ipcMain.handle('license:activate', (_event, fileContent) => {
  const result = license.activateLicense(app.getPath('userData'), fileContent);
  if (result.success && licenseWindow) {
    createLoginWindow();
    licenseWindow.close();
  }
  return result;
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  stopLanMain();
  stopLanTerminalDiscovery();
});

/* ==========================================================
   IPC Handlers — الجسر بين واجهة المستخدم (renderer) وقاعدة البيانات
   كل عملية بيانات تمر من هنا فقط (لا وصول مباشر من الواجهة)
   ========================================================== */

/* ---------------- المصادقة ---------------- */
const passwordAttempts = new Map();
function isPasswordRateLimited(event) {
  const sender = String(event.senderFrame?.routingId || event.sender.id || 'local');
  const now = Date.now();
  const item = passwordAttempts.get(sender);
  if (!item || now > item.resetAt) return false;
  return item.count >= 5;
}
function notePasswordFailure(event) {
  const sender = String(event.senderFrame?.routingId || event.sender.id || 'local');
  const now = Date.now();
  const item = passwordAttempts.get(sender);
  if (!item || now > item.resetAt) passwordAttempts.set(sender, { count: 1, resetAt: now + 60_000 });
  else item.count += 1;
}
function resetPasswordAttempts(event) { passwordAttempts.delete(String(event.senderFrame?.routingId || event.sender.id || 'local')); }
setInterval(() => { const now = Date.now(); for (const [k,v] of passwordAttempts) if (now > v.resetAt) passwordAttempts.delete(k); }, 60_000).unref();

ipcMain.handle('auth:bootstrapInfo', () => db.getBootstrapAdminInfo());
ipcMain.handle('auth:login', (event, creds) => {
  const licenseError = requireLicenseForAuth();
  if (licenseError) return { success: false, message: licenseError.message || 'الترخيص غير صالح.' };
  if (isPasswordRateLimited(event)) return { success: false, message: 'محاولات كثيرة خاطئة. حاول بعد دقيقة.' };
  const result = db.authenticate(creds.username, creds.password);
  if (result?.rateLimited) return { success: false, message: 'محاولات كثيرة خاطئة. حاول بعد 15 دقيقة.' };
  if (!result) {
    notePasswordFailure(event);
    db.logAudit({ action: 'login_failed', entityType: 'auth', level: 'warning', details: { username: String(creds?.username || '').slice(0, 80) } });
    return { success: false, message: 'اسم المستخدم أو كلمة المرور غير صحيحة' };
  }
  if (result.blocked) {
    return { success: false, message: 'هذا الحساب معطّل. راجع المدير العام.' };
  }

  resetPasswordAttempts(event);
  currentUser = result;
  db.clearBootstrapAdminInfo();
  db.logAudit({ userId: result.id, action: 'login_success', entityType: 'auth' });
  createWindow();
  startBackgroundSync();
  const senderWindow = BrowserWindow.fromWebContents(event.sender);
  if (senderWindow) senderWindow.close();
  return { success: true, user: currentUser };
});

// دخول سريع برقم PIN فقط — بديل عن اسم مستخدم/كلمة مرور، مخصَّص لتبديل الموظفين بسرعة
// على نفس الجهاز (نفس المحل، عدة كاشيرات). يبحث عن أي مستخدم نشط يطابق الـ PIN.
//
// حماية بسيطة من محاولات التخمين المتكررة: بعد 5 محاولات فاشلة متتالية، نقفل الدخول
// بـPIN لمدة دقيقة واحدة (بالذاكرة فقط — يُعاد ضبطها تلقائياً عند إعادة تشغيل البرنامج،
// وتكفي لمنع تخمين آلي سريع دون إزعاج موظف نسي رقمه مرة أو مرتين).
const pinAttempts = { count: 0, lockedUntil: 0 };
ipcMain.handle('auth:loginWithPin', (event, pin) => {
  const licenseError = requireLicenseForAuth();
  if (licenseError) return { success: false, message: licenseError.message || 'الترخيص غير صالح.' };
  if (Date.now() < pinAttempts.lockedUntil) {
    const secondsLeft = Math.ceil((pinAttempts.lockedUntil - Date.now()) / 1000);
    return { success: false, message: `محاولات كثيرة خاطئة. حاول بعد ${secondsLeft} ثانية.` };
  }

  const result = db.authenticateByPin(pin);
  if (result?.rateLimited) return { success: false, message: 'محاولات PIN كثيرة خاطئة. حاول بعد 15 دقيقة.' };
  if (!result) {
    pinAttempts.count += 1;
    if (pinAttempts.count >= 5) {
      pinAttempts.lockedUntil = Date.now() + 60_000;
      pinAttempts.count = 0;
    }
    db.logAudit({ action: 'login_failed', entityType: 'auth', level: 'warning', details: { method: 'pin' } });
    return { success: false, message: 'رقم PIN غير صحيح' };
  }

  pinAttempts.count = 0;
  currentUser = result;
  db.logAudit({ userId: result.id, action: 'login_success', entityType: 'auth', details: { method: 'pin' } });
  createWindow();
  startBackgroundSync();
  const senderWindow = BrowserWindow.fromWebContents(event.sender);
  if (senderWindow) senderWindow.close();
  return { success: true, user: currentUser };
});

ipcMain.handle('auth:logout', (event) => {
  if (currentUser) db.logAudit({ userId: currentUser.id, action: 'logout', entityType: 'auth' });
  currentUser = null;
  approvalGrants.clear();
  clientEventLastLoggedAt.clear();
  clientEventRate.clear();
  createLoginWindow();
  const senderWindow = BrowserWindow.fromWebContents(event.sender);
  if (senderWindow) senderWindow.close();
  return { success: true };
});

ipcMain.handle('auth:currentUser', () => currentUser);
ipcMain.handle('auth:changeOwnPassword', (_event, payload) => {
  if (!currentUser) throw new Error('يجب تسجيل الدخول أولاً.');
  const result = db.changeOwnPassword(currentUser.id, payload.currentPassword, payload.newPassword);
  currentUser = { ...currentUser, must_change_password: 0 };
  return result;
});

// إدارة المستخدمين: يتحقق من صلاحية admin هنا في العملية الرئيسية أيضاً (وليس فقط بإخفاء الروابط بالواجهة)
function requireAccountReady() {
  if (!currentUser) throw new Error('يجب تسجيل الدخول أولاً.');
  const licenseState = license.verifyLicense(app.getPath('userData'));
  if (!licenseState.valid) {
    throw new Error(licenseState.message || 'الترخيص غير صالح أو منتهي.');
  }
  if (currentUser && currentUser.must_change_password) {
    throw new Error('يجب تغيير كلمة المرور الافتراضية قبل استخدام النظام.');
  }
}
function requireLicenseForAuth() {
  const licenseState = license.verifyLicense(app.getPath('userData'));
  if (!licenseState.valid) return licenseState;
  return null;
}
function requireAdmin() {
  requireAccountReady();
  if (!currentUser || currentUser.role !== 'admin') {
    throw new Error('هذه العملية تتطلب صلاحية المدير العام');
  }
}
ipcMain.handle('users:list', () => {
  requireAdmin();
  return db.listUsers();
});
ipcMain.handle('users:create', (_event, user) => {
  requireAdmin();
  return db.createUser(user);
});
ipcMain.handle('users:update', (_event, user) => {
  requireAdmin();
  return db.updateUser(user);
});
ipcMain.handle('users:delete', (_event, userId) => {
  requireAdmin();
  const result = db.deleteUser(userId, currentUser.id);
  if (result.success) db.logAudit({ userId: currentUser.id, action: result.hardDeleted ? 'user_deleted' : 'user_deactivated_had_history', entityType: 'user', entityId: userId });
  return result;
});
ipcMain.handle('users:setPin', (_event, { userId, pin }) => {
  requireAdmin();
  const result = db.setUserPin(userId, pin);
  if (result.success) db.logAudit({ userId: currentUser.id, action: 'user_pin_set', entityType: 'user', entityId: userId });
  return result;
});
ipcMain.handle('users:clearPin', (_event, userId) => {
  requireAdmin();
  db.logAudit({ userId: currentUser.id, action: 'user_pin_cleared', entityType: 'user', entityId: userId });
  return db.clearUserPin(userId);
});

function requireManagerOrAdmin() {
  requireAccountReady();
  if (!currentUser || !['admin', 'manager'].includes(currentUser.role)) {
    throw new Error('هذه العملية تتطلب صلاحية مدير');
  }
}

/* ---------------- جلسة الصندوق الاختيارية ---------------- */
ipcMain.handle('shift:current', () => { requireAccountReady(); return db.getOpenShift(); });
ipcMain.handle('shift:open', (_event, openingAmount) => { requireAccountReady(); if (!(Number(openingAmount) >= 0)) throw new Error('مبلغ الافتتاح غير صالح.'); return db.openShift(Number(openingAmount), currentUser.id); });
ipcMain.handle('shift:summary', (_event, shiftId) => { requireAccountReady(); return db.getShiftSummary(shiftId, db.getCurrentBranch().id, currentUser.id, currentUser.role); });
ipcMain.handle('shift:close', (_event, { shiftId, actualCash, notes }) => { requireAccountReady(); if (!(Number(actualCash) >= 0)) throw new Error('الكاش الفعلي غير صالح.'); return db.closeShift(shiftId, Number(actualCash), currentUser.id, notes); });
ipcMain.handle('shift:list', (_event, filters) => { requireManagerOrAdmin(); return db.listShifts(filters); });

/* ---------------- الموظفون والرواتب ---------------- */
ipcMain.handle('payroll:employees', () => { requireAdmin(); return db.listPayrollV2Employees(true); });
ipcMain.handle('payroll:addEmployee', (_event, { fullName, jobTitle, payType, payRate }) => {
  requireAdmin();
  const result = db.addPayrollV2Employee(fullName, jobTitle, payType, payRate);
  if (result.success) db.logAudit({ userId: currentUser.id, action: 'payroll_employee_created', entityType: 'payroll_employee', entityId: result.id, details: { fullName, jobTitle, payType, payRate } });
  return result;
});
ipcMain.handle('payroll:updateEmployee', (_event, { employeeId, fullName, jobTitle, payType, payRate }) => { requireAdmin(); return db.updatePayrollV2Employee(employeeId, fullName, jobTitle, payType, payRate); });
ipcMain.handle('payroll:setEmployeeActive', (_event, { employeeId, isActive }) => { requireAdmin(); return db.setPayrollV2EmployeeActive(employeeId, isActive); });
ipcMain.handle('payroll:deleteEmployee', (_event, { employeeId }) => { requireAdmin(); const result = db.deletePayrollV2Employee(employeeId); if (result?.success) db.logAudit({ userId: currentUser.id, action: 'payroll_employee_deleted', entityType: 'payroll_employee', entityId: employeeId }); return result; });
ipcMain.handle('payroll:month', (_event, monthKey) => { requireAdmin(); return db.getPayrollV2Month(monthKey); });
ipcMain.handle('payroll:employee', (_event, { monthId, employeeId }) => { requireAdmin(); return db.getPayrollV2Employee(monthId, employeeId); });
ipcMain.handle('payroll:addTransaction', (_event, payload) => {
  requireAdmin();
  const result = db.addPayrollV2Transaction({ ...payload, createdBy: currentUser.id });
  db.logAudit({ userId: currentUser.id, action: 'payroll_transaction_added', entityType: 'payroll_transaction', entityId: result.id, details: { monthId: payload.monthId, employeeId: payload.employeeId, type: payload.type, amount: payload.amount, quantity: payload.quantity } });
  return result;
});
ipcMain.handle('payroll:removeTransaction', (_event, transactionId) => { requireAdmin(); const result=db.removePayrollV2Transaction(transactionId); db.logAudit({ userId: currentUser.id, action: 'payroll_transaction_removed', entityType: 'payroll_transaction', entityId: transactionId }); return result; });
ipcMain.handle('payroll:setRegularHours', (_event, { monthId, employeeId, hours }) => { requireAdmin(); return db.setPayrollV2RegularHours(monthId, employeeId, hours); });
ipcMain.handle('payroll:setStartDate', (_event, { monthId, employeeId, startDate }) => {
  requireAdmin();
  const result = db.setPayrollEmployeeMonthStartDate(monthId, employeeId, startDate);
  if (result.success) db.logAudit({ userId: currentUser.id, action: 'payroll_start_date_set', entityType: 'payroll_employee', entityId: employeeId, details: { monthId, startDate } });
  return result;
});

/* ---------------- المرتجعات ---------------- */
ipcMain.handle('returns:saleForReturn', (_event, saleId) => { requireManagerOrAdmin(); return db.getSaleForReturn(saleId); });
ipcMain.handle('returns:create', (_event, payload) => {
  // المرتجعات تعيد كمية للمخزون وقد تُرجع نقداً — تسمح بها فقط لمدير أو مدير عام لمنع
  // استغلالها (مرتجع وهمي لسرقة بضاعة أو نقد) من قبل الكاشير.
  requireManagerOrAdmin();
  const openShift = db.getOpenShift();
  const result = db.createReturn({
    ...payload,
    userId: currentUser ? currentUser.id : null,
    shiftId: openShift ? openShift.id : null,
  });
  db.logAudit({
    userId: currentUser.id,
    action: 'return_created',
    entityType: 'return',
    entityId: result && result.id,
    details: { saleId: payload.saleId, itemCount: (payload.items || []).length },
  });
  return result;
});
ipcMain.handle('returns:list', (_event, filters) => { requireManagerOrAdmin(); return db.listReturns(filters); });
ipcMain.handle('returns:get', (_event, id) => { requireManagerOrAdmin(); return db.getReturn(id); });

/* ---------------- اللغة (تعدد اللغات) ---------------- */
ipcMain.handle('language:get', () => { return db.getSetting('app_language', 'ar'); });
ipcMain.handle('language:set', (_event, lang) => { requireAdmin(); if (!['ar','en','tr'].includes(String(lang))) throw new Error('اللغة غير مدعومة.'); return db.setSetting('app_language', lang); });

/* ---------------- السمة ---------------- */
ipcMain.handle('theme:get', () => { return db.getSetting('app_theme', 'light'); });
ipcMain.handle('theme:set', (_event, theme) => {
  requireAccountReady();
  if (!['light', 'dark'].includes(theme)) throw new Error('السمة غير صالحة');
  return db.setSetting('app_theme', theme);
});

/* ---------------- العلامة التجارية (اسم المتجر + شعار الفاتورة) ---------------- */
// تُقرأ من أي شاشة (حتى الفاتورة/تذكرة المطبخ)، لكن التعديل يتطلب صلاحية admin
ipcMain.handle('branding:get', () => ({
  storeName: db.getSetting('branding_store_name', ''),
  logoPath: db.getSetting('branding_logo_path', ''),
}));
ipcMain.handle('branding:setStoreName', (_event, storeName) => {
  requireAdmin();
  return db.setSetting('branding_store_name', storeName || '');
});
ipcMain.handle('branding:setLogo', async () => {
  requireAdmin();
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'اختر شعار المتجر',
    properties: ['openFile'],
    filters: [{ name: 'صور', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
  });
  if (result.canceled || result.filePaths.length === 0) return { success: false, canceled: true };

  const sourcePath = result.filePaths[0];
  const stat = fs.statSync(sourcePath);
  const MAX_LOGO_BYTES = 10 * 1024 * 1024;
  if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_LOGO_BYTES) {
    throw new Error('شعار المتجر غير صالح أو أكبر من 10 ميغابايت.');
  }
  const bytes = fs.readFileSync(sourcePath);
  const ext = path.extname(sourcePath).toLowerCase();
  const signatures = {
    '.png': bytes.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])),
    '.jpg': bytes.subarray(0, 3).equals(Buffer.from([0xff,0xd8,0xff])),
    '.jpeg': bytes.subarray(0, 3).equals(Buffer.from([0xff,0xd8,0xff])),
    '.webp': bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP',
  };
  if (!signatures[ext]) throw new Error('نوع شعار المتجر لا يطابق محتوى الملف.');
  const destPath = path.join(getImagesDir(), `store-logo${ext}`);
  fs.writeFileSync(destPath, bytes, { mode: 0o600 });
  db.setSetting('branding_logo_path', destPath);
  return { success: true, path: destPath, url: pathToFileURL(destPath).href };
});

/* ---------------- الخصومات (إعدادات) ---------------- */
// الحد الأقصى الذي يقدر الكاشير يطبّقه بدون موافقة مدير. تغييره يتطلب صلاحية مدير.
ipcMain.handle('discount:maxCashierPercent', () => { requireAccountReady(); return db.getMaxCashierDiscountPercent(); });
ipcMain.handle('weighing:getPrefix', () => { requireAccountReady(); return db.getSetting('weighted_barcode_prefix', '20'); });
ipcMain.handle('weighing:setPrefix', (_event, prefix) => {
  requireManagerOrAdmin();
  const clean = String(prefix || '20').trim();
  if (!/^\d{2}$/.test(clean)) throw new Error('بادئة باركود الميزان يجب أن تكون رقمين بالضبط (مثال: 20).');
  db.setSetting('weighted_barcode_prefix', clean);
  return { success: true };
});
ipcMain.handle('discount:setMaxCashierPercent', (_event, percent) => {
  requireManagerOrAdmin();
  const value = Number(percent);
  if (!Number.isFinite(value) || value < 0 || value > 100) throw new Error('نسبة الخصم القصوى يجب أن تكون بين 0 و100.');
  return db.setSetting('max_cashier_discount_percent', String(Math.round(value * 100) / 100));
});
// موافقة مدير على خصم يتجاوز الحد: يتطلب إدخال اسم مستخدم/كلمة مرور مدير حتى لو الكاشير هو المسجّل دخوله حالياً
ipcMain.handle('discount:approve', (_event, { username, password }) => { requireAccountReady();
  const result = db.authenticate(username, password);
  if (!result || result.blocked || !['admin', 'manager'].includes(result.role)) {
    return { approved: false, message: 'بيانات غير صحيحة أو لا تملك صلاحية مدير' };
  }
  const grantId = crypto.randomUUID();
  approvalGrants.set(grantId, { approverId: result.id, approverName: result.full_name, userId: currentUser?.id || null, expiresAt: Date.now() + 2 * 60_000 });
  return { approved: true, approverId: result.id, approverName: result.full_name, grantId };
});
// نفس موافقة المدير، لكن عبر PIN فقط بدل اسم مستخدم/كلمة مرور — أسرع لموافقات لحظية بدون تسجيل خروج الكاشير
const managerPinAttempts = { count: 0, lockedUntil: 0 };
ipcMain.handle('discount:approveWithPin', (_event, pin) => { requireAccountReady();
  if (Date.now() < managerPinAttempts.lockedUntil) {
    const secondsLeft = Math.ceil((managerPinAttempts.lockedUntil - Date.now()) / 1000);
    return { approved: false, message: `محاولات كثيرة خاطئة. حاول بعد ${secondsLeft} ثانية.` };
  }
  const result = db.authenticateManagerByPin(pin);
  if (!result) {
    managerPinAttempts.count += 1;
    if (managerPinAttempts.count >= 5) {
      managerPinAttempts.lockedUntil = Date.now() + 60_000;
      managerPinAttempts.count = 0;
    }
    return { approved: false, message: 'رقم PIN غير صحيح أو لا يخص مديراً' };
  }
  managerPinAttempts.count = 0;
  const grantId = crypto.randomUUID();
  approvalGrants.set(grantId, { approverId: result.id, approverName: result.full_name, userId: currentUser?.id || null, expiresAt: Date.now() + 2 * 60_000 });
  return { approved: true, approverId: result.id, approverName: result.full_name, grantId };
});

/* ---------------- تقرير الدليفري ---------------- */
// نفس المبرر: كانتا بلا فحص صلاحية بالخلفية رغم حساسية بيانات الأرباح والخسائر
ipcMain.handle('reports:delivery', (_event, range) => { requireManagerOrAdmin(); return db.getDeliverySummary(range); });
ipcMain.handle('reports:profitLoss', (_event, range) => { requireManagerOrAdmin(); return db.getProfitLoss(range); });

/* ---------------- تصدير التقارير ---------------- */
ipcMain.handle('reports:exportExcel', async (_event, range) => {
  requireManagerOrAdmin();
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'تصدير تقرير Excel',
    defaultPath: `sales-report-${new Date().toISOString().slice(0, 10)}.xlsx`,
    filters: [{ name: 'Excel', extensions: ['xlsx'] }],
  });
  if (result.canceled || !result.filePath) return { success: false, canceled: true };
  await exportWorkbook(result.filePath, db.getReportExport(range));
  return { success: true, path: result.filePath };
});

ipcMain.handle('reports:exportPdf', async (_event, range) => {
  requireManagerOrAdmin();
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'تصدير تقرير PDF',
    defaultPath: `sales-report-${new Date().toISOString().slice(0, 10)}.pdf`,
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (result.canceled || !result.filePath) return { success: false, canceled: true };
  const report = db.getReportExport(range);
  const pdfWindow = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  await pdfWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(require('./database/report-exporter').reportHtml(report))}`);
  const data = await pdfWindow.webContents.printToPDF({ printBackground: true, landscape: true, pageSize: 'A4' });
  fs.writeFileSync(result.filePath, data);
  pdfWindow.destroy();
  return { success: true, path: result.filePath };
});

/* ---------------- مزامنة الفروع ---------------- */
ipcMain.handle('sync:getConfig', () => { requireAccountReady(); return db.getSyncConfig(); });
ipcMain.handle('sync:saveConfig', (_event, config) => {
  requireAdmin();
  const result = db.saveSyncConfig(config);
  startBackgroundSync();
  return result;
});
ipcMain.handle('sync:run', async () => {
  requireManagerOrAdmin();
  return syncNow(db);
});

/* ---------------- مشاركة بيانات المحل بين كاشيرات نفس المحل (LAN) ---------------- */
ipcMain.handle('lan:getStatus', () => { requireAccountReady();
  const role = db.getSetting('lan_role', 'none');
  const branch = db.getCurrentBranch();
  return {
    role,
    deviceName: db.getSetting('lan_device_name', ''),
    localAddresses: getLocalIPv4Addresses(),
    serverPort: lanServerHandle ? lanServerHandle.port : null,
    pairingCode: currentPairingCode,
    pairingExpiresAt: pairingCodeExpiresAt,
    discoveredDevices,
    connectedTo: role === 'terminal' ? db.getSetting('sync_server_url', '') : null,
    branchName: branch ? branch.name : '',
  };
});

ipcMain.handle('lan:setRole', async (_event, { role, deviceName }) => {
  requireAdmin();
  if (!['none', 'main', 'terminal'].includes(role)) throw new Error('دور غير معروف');

  db.setSetting('lan_role', role);
  if (deviceName) db.setSetting('lan_device_name', deviceName);

  if (role === 'main') {
    await startLanMain();
  } else if (role === 'terminal') {
    startLanTerminalDiscovery();
  } else {
    stopLanMain();
    stopLanTerminalDiscovery();
  }
  return { success: true };
});

// يولّد رمز اقتران قصير الأمد (5 دقائق) يظهر على شاشة الجهاز الرئيسي، ليكتبه المستخدم على الجهاز الطرفية
ipcMain.handle('lan:startPairingCode', async () => {
  requireAdmin();
  if (db.getSetting('lan_role', 'none') !== 'main') throw new Error('فعّل وضع "جهاز رئيسي" أولاً');
  await startLanMain();
  currentPairingCode = crypto.randomInt(10000000, 100000000).toString();
  pairingCodeExpiresAt = Date.now() + 5 * 60 * 1000;
  db.logAudit({ userId: currentUser.id, action: 'lan_pairing_code_generated', entityType: 'lan' });
  return { code: currentPairingCode, expiresAt: pairingCodeExpiresAt };
});

// الجهاز الطرفية يتصل بجهاز رئيسي مُكتشَف على الشبكة عبر عنوانه ومنفذه + الرمز المعروض هناك
ipcMain.handle('lan:pairWithDevice', async (_event, { address, port, code }) => {
  requireAdmin();
  let response;
  try {
    // ثقة أول استخدام (TOFU): لا نملك بصمة الشهادة بعد، فنقبلها هذه المرة فقط — الحماية هنا
    // من رمز الاقتران القصير الأمد (راجع server/lan-tls.js وserver/pinned-request.js). البصمة
    // الفعلية تُقرأ من مقبس TLS نفسه وتُعاد بـ fingerprint256 لتُثبَّت أدناه لكل الطلبات اللاحقة.
    response = await pinnedRequest({
      url: `https://${address}:${port}/pair`,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
      timeoutMs: 10000,
      pinnedFingerprint: null,
    });
  } catch (err) {
    throw new Error('تعذّر الاتصال بالجهاز الرئيسي: ' + err.message);
  }
  const result = response.json || {};
  if (!(response.status >= 200 && response.status < 300)) throw new Error(result.message || 'تعذّر الاقتران');
  if (!response.fingerprint256) throw new Error('تعذّر قراءة شهادة الجهاز الرئيسي أثناء الاقتران');

  // تبنّي هوية الفرع المشترك حتى تندمج التقارير والمخزون تحت نفس المحل
  db.adoptSharedBranch({ uuid: result.branchUuid, name: result.branchName, businessType: result.businessType });
  db.setSetting('sync_server_url', `https://${address}:${port}`);
  db.setSetting('sync_token', result.syncSecret);
  db.setSetting('sync_tls_fingerprint', response.fingerprint256); // تثبيت البصمة من هنا فصاعداً
  db.setSetting('sync_enabled', '1');
  db.setSetting('sync_cursor', '0'); // نبدأ من الصفر لنسحب كل بيانات المحل الحالية فوراً
  db.setSetting('lan_role', 'terminal');

  db.logAudit({ userId: currentUser.id, action: 'lan_paired', entityType: 'lan', details: { address, port } });

  stopLanTerminalDiscovery();
  startBackgroundSync(); // مزامنة سريعة فورية لسحب كل بيانات المحل مباشرة
  return { success: true, branchName: result.branchName };
});

// فصل هذا الجهاز عن مشاركة المحل (يرجع "طرفية مستقلة" ببيانات محلية فقط من هذه اللحظة)
ipcMain.handle('lan:disconnect', () => {
  requireAdmin();
  db.setSetting('lan_role', 'none');
  db.setSetting('sync_enabled', '0');
  if (syncTimer) clearInterval(syncTimer);
  db.logAudit({ userId: currentUser.id, action: 'lan_disconnected', entityType: 'lan' });
  return { success: true };
});

/* ---------------- النسخ الاحتياطي والاستعادة ---------------- */
// حماية: هاتان العمليتان خطيرتان جداً (نسخ/استبدال كامل بيانات المحل) — تتطلبان صلاحية admin
// بالعملية الرئيسية أيضاً، وليس فقط بإخفاء الزر بالواجهة عن الكاشير.
ipcMain.handle('backup:create', async () => {
  requireAdmin();
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'حفظ نسخة احتياطية',
    defaultPath: `pos-backup-${new Date().toISOString().slice(0, 10)}.db`,
    filters: [{ name: 'قاعدة بيانات', extensions: ['db'] }],
  });
  if (result.canceled || !result.filePath) return { success: false, canceled: true };
  await db.backupTo(result.filePath);
  db.logAudit({ userId: currentUser.id, action: 'backup_created', entityType: 'backup', entityId: result.filePath });
  return { success: true, path: result.filePath };
});

ipcMain.handle('backup:restore', async () => {
  requireAdmin();
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'اختر ملف نسخة احتياطية للاستعادة',
    properties: ['openFile'],
    filters: [{ name: 'قاعدة بيانات', extensions: ['db'] }],
  });
  if (result.canceled || result.filePaths.length === 0) return { success: false, canceled: true };

  const confirmed = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    buttons: ['إلغاء', 'استعادة (سيُستبدل كل شيء)'],
    defaultId: 0,
    cancelId: 0,
    message: 'استعادة نسخة احتياطية ستستبدل كل بيانات التطبيق الحالية بالكامل. هل تريد المتابعة؟',
  });
  if (confirmed.response !== 1) return { success: false, canceled: true };

  // نسجّل العملية بسجل التدقيق قبل إعادة التشغيل (بعد الاستعادة، سجل التدقيق نفسه سيُستبدل بسجل النسخة المستعادة)
  const sourcePath = result.filePaths[0];
  const backupValidation = db.validateBackupFile(sourcePath);
  if (!backupValidation.valid) throw new Error(backupValidation.message);

  const dbPath = db.getDbPath();
  const safetyPath = `${dbPath}.pre-restore-${Date.now()}.db`;
  await db.backupTo(safetyPath);
  db.logAudit({ userId: currentUser.id, action: 'backup_restore_started', entityType: 'backup', entityId: sourcePath, details: { safetyPath } });
  db.closeDatabase();
  try {
    fs.copyFileSync(sourcePath, dbPath);
    const restoredValidation = db.validateBackupFile(dbPath);
    if (!restoredValidation.valid) throw new Error(restoredValidation.message);
  } catch (error) {
    try { fs.copyFileSync(safetyPath, dbPath); } catch (_) {}
    throw new Error(`فشلت استعادة النسخة الاحتياطية وتمت محاولة إبقاء النسخة الحالية: ${error.message}`);
  }
  await dialog.showMessageBox(mainWindow, {
    type: 'info',
    message: 'تم التحقق من النسخة المستعادة بنجاح. سيتم إغلاق التطبيق الآن — أعد فتحه لتحميل البيانات المستعادة.',
  });
  app.relaunch();
  app.exit(0);
  return { success: true, safetyPath };
});

/* ---------------- المنتجات والفئات ---------------- */
ipcMain.handle('products:list', (_event, filters) => { requireAccountReady(); return db.listProducts(filters); });
ipcMain.handle('products:get', (_event, id) => { requireAccountReady(); return db.getProduct(id); });
ipcMain.handle('products:create', (_event, product) => {
  requireManagerOrAdmin();
  try {
    return db.createProduct(product);
  } catch (err) {
    throw new Error(friendlyProductError(err));
  }
});
ipcMain.handle('products:update', (_event, product) => {
  requireManagerOrAdmin();
  try {
    return db.updateProduct(product);
  } catch (err) {
    throw new Error(friendlyProductError(err));
  }
});
ipcMain.handle('products:delete', (_event, id) => {
  requireManagerOrAdmin();
  return db.deleteProduct(id);
});
ipcMain.handle('products:variants', (_event, parentId) => { requireAccountReady(); return db.listProductVariants(parentId); });

// بيع بالوزن: يفكّ باركود ميزان الخضار/الفواكه ويعيد المنتج + الوزن المقروء جاهزَين للسلة
ipcMain.handle('products:resolveWeightedBarcode', (_event, barcode) => { requireAccountReady(); return db.resolveWeightedBarcode(barcode); });
ipcMain.handle('products:resolveGs1Barcode', (_event, barcode) => { requireAccountReady(); return db.resolveGs1Barcode(barcode); });
ipcMain.handle('products:variantParents', (_event, excludeId) => { requireAccountReady(); return db.listVariantParentOptions(excludeId); });

// استيراد دفعة منتجات من ملف CSV (سهل لإضافة بضاعة السوبرماركت/الأزياء دفعة واحدة)
ipcMain.handle('products:importCsv', async () => {
  requireManagerOrAdmin();
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'اختر ملف CSV للمنتجات',
    properties: ['openFile'],
    filters: [{ name: 'CSV', extensions: ['csv'] }],
  });
  if (result.canceled || result.filePaths.length === 0) return null;

  const csvText = fs.readFileSync(result.filePaths[0], 'utf8');
  const rows = db.parseProductsCsv(csvText);
  if (rows.length === 0) {
    return { created: 0, updated: 0, errors: [{ row: 0, message: 'الملف فارغ أو بصيغة غير صحيحة' }] };
  }
  return db.bulkImportProducts(rows);
});

// يُنشئ ملف CSV نموذجي فارغ (Template) ليعرف صاحب المحل الأعمدة المطلوبة بالضبط
ipcMain.handle('products:downloadCsvTemplate', async () => { requireAccountReady();
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'حفظ نموذج استيراد المنتجات',
    defaultPath: 'نموذج-استيراد-المنتجات.csv',
    filters: [{ name: 'CSV', extensions: ['csv'] }],
  });
  if (result.canceled || !result.filePath) return null;

  const template =
    '\uFEFF' + // BOM حتى يفتح إكسل الملف بترميز عربي صحيح
    'name,barcode,category,price,cost,quantity,minQuantity,unit\n' +
    'كولا 330 مل,6221031000012,مشروبات,2.5,1.5,100,10,piece\n' +
    'قميص قطن أزرق,,أزياء,120,80,15,2,piece\n';
  fs.writeFileSync(result.filePath, template, 'utf8');
  return { path: result.filePath };
});

/* ---------------- الحزم/الخصومات التجميعية ---------------- */
ipcMain.handle('bundles:list', () => {
  requireManagerOrAdmin();
  return db.listBundles();
});
ipcMain.handle('bundles:listActive', () => { requireAccountReady(); return db.listActiveBundles(); }); // للكاشير: قراءة فقط، بلا قيد صلاحية
ipcMain.handle('bundles:create', (_event, bundle) => {
  requireManagerOrAdmin();
  return db.createBundle(bundle);
});
ipcMain.handle('bundles:update', (_event, bundle) => {
  requireManagerOrAdmin();
  return db.updateBundle(bundle);
});
ipcMain.handle('bundles:delete', (_event, id) => {
  requireManagerOrAdmin();
  return db.deleteBundle(id);
});
ipcMain.handle('categories:list', () => { requireAccountReady(); return db.listCategories(); });
ipcMain.handle('categories:create', (_event, category) => {
  requireManagerOrAdmin();
  return db.createCategory(category);
});

/* ---------------- العملاء ---------------- */
ipcMain.handle('customers:list', (_event, filters) => { requireAccountReady(); return db.listCustomers(filters); });
ipcMain.handle('customers:get', (_event, id) => { requireAccountReady(); return db.getCustomer(id); });
ipcMain.handle('customers:create', (_event, customer) => { requireAccountReady(); return db.createCustomer(customer); });
ipcMain.handle('customers:update', (_event, customer) => { requireAccountReady(); return db.updateCustomer(customer); });
ipcMain.handle('customers:ledger', (_event, customerId) => {
  requireManagerOrAdmin();
  return db.getCustomerLedger(customerId);
});
ipcMain.handle('customers:receivePayment', (_event, payload) => {
  requireManagerOrAdmin();
  const shift = db.getOpenShift();
  const result = db.receiveCustomerPayment({ ...payload, userId: currentUser.id, shiftId: shift?.id || null });
  db.logAudit({
    userId: currentUser.id,
    action: 'customer_payment_received',
    entityType: 'customer',
    entityId: payload.customerId,
    details: { amount: payload.amount },
  });
  return result;
});

/* ---------------- الموردون والشراء ---------------- */
ipcMain.handle('suppliers:list', () => { requireManagerOrAdmin(); return db.listSuppliers(); });
ipcMain.handle('suppliers:create', (_event, supplier) => { requireManagerOrAdmin(); return db.createSupplier(supplier); });
ipcMain.handle('suppliers:update', (_event, supplier) => { requireManagerOrAdmin(); return db.updateSupplier(supplier); });
ipcMain.handle('purchases:list', () => { requireManagerOrAdmin(); return db.listPurchaseOrders(); });
ipcMain.handle('purchases:get', (_event, id) => { requireManagerOrAdmin(); return db.getPurchaseOrder(id); });
ipcMain.handle('purchases:create', (_event, purchase) => { requireManagerOrAdmin(); const shift = db.getOpenShift(); return db.createPurchaseOrder({ ...purchase, userId: currentUser.id, shiftId: shift?.id || null }); });
ipcMain.handle('purchases:receive', (_event, id) => { requireManagerOrAdmin(); const shift = db.getOpenShift(); return db.receivePurchaseOrder(id, { userId: currentUser.id, shiftId: shift?.id || null }); });

/* ---------------- طاولات المطعم والطلبات المفتوحة ---------------- */
ipcMain.handle('tables:list', () => { requireAccountReady(); return db.listTables(); });
ipcMain.handle('tables:create', (_event, table) => {
  requireManagerOrAdmin();
  return db.createTable(table);
});
ipcMain.handle('tables:delete', (_event, id) => {
  requireManagerOrAdmin();
  return db.deleteTable(id);
});
ipcMain.handle('tables:openSale', (_event, tableId) => { requireAccountReady(); return db.getOrCreateOpenSale(tableId, currentUser.id); });
ipcMain.handle('tables:getOpenSale', (_event, tableId) => { requireAccountReady(); return db.getOpenSaleForTable(tableId); });
ipcMain.handle('tables:setItems', (_event, { saleId, items }) => {
  requireAccountReady();
  const before = db.getSale(saleId, db.getCurrentBranch().id);
  if (!before || before.status !== 'open') throw new Error('الطلب المفتوح غير موجود.');
  if (currentUser.role === 'cashier') {
    // نجمع الكمية حسب المنتج عبر كل الأسطر (قد يتكرر نفس المنتج بأكثر من سطر الآن
    // بسبب الملاحظات المختلفة — مثلاً "شاورما" عادية وسطر آخر "شاورما بدون ثوم")
    const sumByProduct = (list) => {
      const map = new Map();
      for (const i of list) {
        const pid = Number(i.product_id ?? i.productId);
        map.set(pid, (map.get(pid) || 0) + Number(i.quantity));
      }
      return map;
    };
    const oldQuantities = sumByProduct(before.items);
    const newQuantities = sumByProduct(items || []);
    for (const [productId, quantity] of oldQuantities) {
      if ((newQuantities.get(productId) || 0) < quantity) throw new Error('الكاشير لا يملك صلاحية تخفيض أو حذف الكميات. اطلب المدير.');
    }
  }
  const result = db.setOpenSaleItems(saleId, items);
  db.logAudit({ userId: currentUser.id, action: 'table_order_updated', entityType: 'sale', entityId: saleId, details: { itemCount: (items || []).length } });
  void autoSendKitchen(saleId);
  return result;
});
ipcMain.handle('tables:merge', (_event, { sourceTableId, targetTableId }) => {
  requireManagerOrAdmin();
  return db.mergeTables(sourceTableId, targetTableId, currentUser.id);
});
ipcMain.handle('tables:split', (_event, { saleId, selected, payment }) => {
  requireAccountReady();
  const shift = db.getOpenShift();
  const result = db.splitTableSale(saleId, selected, payment, currentUser.id, shift?.id || null);
  // دفع جزء من الطاولة = فاتورة للزبون فقط. لا نرسل تذكرة مطبخ هنا لأن الطلب
  // وصل للمطبخ بالفعل عند حفظه، وإعادة إرسالها ستنتج طلباً مكرراً.
  void autoPrintReceipt(result.id);
  return result;
});
ipcMain.handle('tables:close', (_event, { saleId, payment }) => {
  requireAccountReady();
  const shift = db.getOpenShift();
  const result = db.closeTableSale(saleId, payment, currentUser.id, shift?.id || null);
  db.logAudit({ userId: currentUser.id, action: 'table_order_closed', entityType: 'sale', entityId: saleId, details: { paymentMethod: payment.paymentMethod } });
  // إغلاق/دفع الطاولة = فاتورة دفع فقط. لا نعيد إرسال طلب للمطبخ.
  void autoPrintReceipt(saleId);
  return result;
});
// تحرير طاولة عالقة "مشغولة" رغم عدم وجود أصناف فعلية عليها (مدير/أدمن فقط)
ipcMain.handle('tables:release', (_event, tableId) => {
  requireManagerOrAdmin();
  const result = db.releaseEmptyTable(tableId);
  if (result.released) db.logAudit({ userId: currentUser.id, action: 'table_released', entityType: 'restaurant_table', entityId: tableId, details: {} });
  return result;
});

// فتح نافذة تذكرة مطبخ قابلة للطباعة (بدون أسعار — فقط الأصناف والكميات والملاحظات)
ipcMain.handle('kitchen:open', (_event, saleId) => { requireAccountReady(); if (!db.getSale(saleId, db.getCurrentBranch().id)) throw new Error('الطلب غير موجود.'); return autoSendKitchen(saleId); });
ipcMain.handle('kitchen:print', () => { requireAccountReady(); throw new Error('الطباعة أصبحت تلقائية من إعدادات الطابعات.'); });

/* ---------------- المبيعات ---------------- */
function consumeApprovalGrant(grantId) {
  const grant = approvalGrants.get(String(grantId || ''));
  if (!grant) return null;
  approvalGrants.delete(String(grantId));
  if (grant.expiresAt < Date.now()) return null;
  if (grant.userId !== currentUser?.id) return null;
  return grant;
}

// نُلحق هوية المستخدم الحالي من العملية الرئيسية دائماً (لا نثق بأي userId قادم من الواجهة)
ipcMain.handle('sale:create', (_event, sale) => {
  requireAccountReady();
  const openShift = db.getOpenShift();
  const discountGrant = sale.discountApprovalGrantId ? consumeApprovalGrant(sale.discountApprovalGrantId) : null;
  const creditGrant = sale.creditApprovalGrantId ? consumeApprovalGrant(sale.creditApprovalGrantId) : null;
  const trustedSale = { ...sale, userId: currentUser.id, shiftId: openShift?.id || null,
    discountApprovedBy: discountGrant?.approverId || null,
    // المدير/المدير العام يستطيع اعتماد البيع الآجل لنفسه؛ الكاشير لا يمر إلا
    // بمنحة اعتماد صادرة من مدير. هذا يلغي عطل البيع الآجل للمدير مع بقاء الحماية.
    creditApprovedBy: creditGrant?.approverId || (['admin', 'manager'].includes(currentUser.role) && sale.paymentMethod === 'credit' ? currentUser.id : null),
  };
  const result = db.createSale(trustedSale);
  db.logAudit({ userId: currentUser.id, action: 'sale_created', entityType: 'sale', entityId: result.id, details: { orderType: sale.orderType, total: sale.grandTotal } });
  if (['takeaway', 'in_store'].includes(sale.orderType)) void autoSendKitchen(result.id);
  void autoPrintReceipt(result.id);
  return result;
});
ipcMain.handle('sales:list', (_event, filters) => { requireAccountReady(); return db.listSales(filters); });
ipcMain.handle('sales:get', (_event, id) => { requireAccountReady(); return db.getSale(id, db.getCurrentBranch().id); });
ipcMain.handle('branches:list', () => { requireAdmin(); return db.listBranches(); });
ipcMain.handle('branches:current', () => { requireAccountReady(); return db.getCurrentBranch(); });
ipcMain.handle('branches:update', (_event, branch) => {
  requireAdmin();
  return db.updateBranch(branch);
});

// المخزون
ipcMain.handle('inventory:list', (_event, filters) => { requireAccountReady(); return db.listInventory(filters); });
ipcMain.handle('inventory:adjust', (_event, payload) => {
  requireManagerOrAdmin();
  const result = db.adjustInventory(payload);
  db.logAudit({
    userId: currentUser.id,
    action: 'inventory_adjusted',
    entityType: 'product',
    entityId: payload.productId,
    details: { changeQty: payload.changeQty, reason: payload.reason },
  });
  return result;
});
ipcMain.handle('inventory:movements', (_event, filters) => { requireManagerOrAdmin(); return db.listInventoryMovements(filters); });

// التقارير — كلها مقيّدة بمدير/مدير عام فقط (نفس صفحة reports.html بالواجهة)
// كانت هذه القنوات الأربع بلا أي فحص صلاحية بالخلفية رغم أن الصفحة محجوبة عن الكاشير
// بالواجهة فقط — أي طرف يستدعي القناة مباشرة (بدون المرور بالواجهة) كان يقدر يسحب
// تقارير المبيعات/الأرباح والخسائر/الدليفري كاملة. تم تصحيحها لتطابق reports:debtAging.
ipcMain.handle('reports:summary', (_event, range) => { requireManagerOrAdmin(); return db.getSalesSummary(range); });
ipcMain.handle('reports:topProducts', (_event, range) => { requireManagerOrAdmin(); return db.getTopProducts(range); });
ipcMain.handle('reports:daily', (_event, range) => { requireManagerOrAdmin(); return db.getDailySales(range); });
ipcMain.handle('reports:debtAging', () => { requireManagerOrAdmin(); return db.getDebtAging(); });
ipcMain.handle('reports:invoices', (_event, range) => { requireManagerOrAdmin(); return db.getInvoiceList(range); });

/* ---------------- الإعداد الأولي والعملات ---------------- */
ipcMain.handle('setup:isRequired', () => db.getSetting('setup_completed', '0') !== '1');
ipcMain.handle('setup:complete', (_event, businessType) => {
  requireAdmin();
  const branch = db.getCurrentBranch();
  db.updateBranch({ id: branch.id, name: branch.name, businessType });
  db.setSetting('setup_completed', '1');
  return { success: true };
});
ipcMain.handle('global:get', () => { requireAccountReady(); return db.getGlobalProfile(); });
ipcMain.handle('global:set', (_event, profile) => { requireAdmin(); const result=db.setGlobalProfile(profile||{}); db.logAudit({userId:currentUser.id,action:'global_profile_updated',entityType:'organization_profile'}); return result; });
ipcMain.handle('tax:list', () => { requireManagerOrAdmin(); return db.listTaxProfiles(); });
ipcMain.handle('tax:save', (_event, profile) => { requireAdmin(); const result=db.saveTaxProfile(profile||{}); db.logAudit({userId:currentUser.id,action:'tax_profile_saved',entityType:'tax_profile',entityId:result.id}); return result; });
ipcMain.handle('payments:list', (_event, range) => { requireManagerOrAdmin(); return db.listPaymentTransactions(range||{}); });
ipcMain.handle('shift:cashIn', (_event, payload) => { requireAccountReady(); return db.addCashMovement({...payload,type:'cash_in',createdBy:currentUser.id}); });
ipcMain.handle('shift:cashOut', (_event, payload) => { requireAccountReady(); return db.addCashMovement({...payload,type:'cash_out',createdBy:currentUser.id}); });
ipcMain.handle('shift:cashMovements', (_event, shiftId) => { requireAccountReady(); return db.getShiftCashMovements(shiftId, currentUser.id, currentUser.role); });

ipcMain.handle('currency:get', () => { requireAccountReady(); return ({
  base: db.getSetting('currency_base', 'USD'),
  secondary: db.getSetting('currency_secondary', 'TRY'),
  rate: Number(db.getSetting('currency_exchange_rate', '1')) || 1,
  taxNumber: db.getSetting('store_tax_number', ''),
});
});
ipcMain.handle('currency:set', (_event, config) => {
  requireAdmin();
  if (!(Number(config.rate) > 0)) throw new Error('سعر الصرف يجب أن يكون أكبر من صفر.');
  db.setSetting('currency_base', String(config.base || 'USD').trim().toUpperCase());
  db.setSetting('currency_secondary', String(config.secondary || '').trim().toUpperCase());
  db.setSetting('currency_exchange_rate', String(config.rate));
  db.setSetting('store_tax_number', String(config.taxNumber || '').trim());
  return { success: true };
});

ipcMain.handle('printing:getConfig', () => { requireAccountReady(); return ({
  kitchenAutoPrint: db.getSetting('kitchen_auto_print', '1') === '1', kitchenPrinterName: db.getSetting('kitchen_printer_name', ''),
  receiptAutoPrint: printerSetting('receipt_auto_print'), receiptPrinterName: db.getSetting('receipt_printer_name', ''),
});
});
ipcMain.handle('printing:listPrinters', async () => {
  requireManagerOrAdmin();
  if (!mainWindow || mainWindow.isDestroyed()) return [];
  try {
    const printers = await mainWindow.webContents.getPrintersAsync();
    // نستثني طابعات PDF الوهمية من القائمة أصلاً — لا فائدة من عرضها كخيار لطباعة
    // فاتورة أو تذكرة مطبخ تلقائياً، فهي تنتج ملف PDF لا طباعة فعلية.
    return printers
      .filter((p) => !isVirtualPdfPrinter(p.name || p.displayName))
      .map((p) => ({ name: p.name, displayName: p.displayName || p.name, isDefault: !!p.isDefault }));
  } catch (_) {
    return [];
  }
});
ipcMain.handle('printing:saveConfig', (_event, config) => {
  requireManagerOrAdmin();
  db.setSetting('kitchen_auto_print', config.kitchenAutoPrint ? '1' : '0');
  db.setSetting('kitchen_printer_name', String(config.kitchenPrinterName || '').trim());
  db.setSetting('receipt_auto_print', config.receiptAutoPrint ? '1' : '0');
  db.setSetting('receipt_printer_name', String(config.receiptPrinterName || '').trim());
  db.logAudit({ userId: currentUser.id, action: 'printing_config_updated', entityType: 'settings' });
  return { success: true };
});
ipcMain.handle('system:rendererHeartbeat', (_event, state = {}) => {
  if (!currentUser) return { ok: false };
  rendererHeartbeat = {
    at: Date.now(),
    busy: Boolean(state.busy),
    paymentOpen: Boolean(state.paymentOpen),
    route: String(state.route || '').slice(0, 200),
  };
  return { ok: true };
});

const clientEventLastLoggedAt = new Map();
const clientEventRate = new Map();
const CLIENT_EVENT_MAX_PER_MINUTE = 20;
ipcMain.handle('audit:clientEvent', (_event, payload = {}) => {
  if (!currentUser) return { success: false };
  const level = ['warning','error'].includes(payload.level) ? payload.level : 'warning';
  const type = String(payload.type || 'client_event').replace(/[^a-z0-9_\-]/gi, '_').slice(0, 80) || 'client_event';
  const userKey = String(currentUser.id);
  const now = Date.now();
  const bucket = clientEventRate.get(userKey);
  if (!bucket || now >= bucket.resetAt) {
    clientEventRate.set(userKey, { count: 1, resetAt: now + 60_000 });
  } else {
    bucket.count += 1;
    if (bucket.count > CLIENT_EVENT_MAX_PER_MINUTE) return { success: false, rateLimited: true };
  }
  const key = `${userKey}:${type}`;
  const last = clientEventLastLoggedAt.get(key) || 0;
  if (now - last < 30000) return { success: true, deduped: true };
  clientEventLastLoggedAt.set(key, now);
  const rawDetails = payload.details && typeof payload.details === 'object' ? payload.details : {};
  const details = {};
  for (const [k, v] of Object.entries(rawDetails).slice(0, 20)) {
    const safeKey = String(k).slice(0, 80);
    const value = typeof v === 'string' ? v.slice(0, 500) : (typeof v === 'number' || typeof v === 'boolean' || v === null ? v : String(v).slice(0, 500));
    details[safeKey] = value;
  }
  details.route = String(rawDetails.route || '').slice(0, 200);
  db.logAudit({ userId: currentUser.id, action: 'client_' + type, entityType: 'renderer', details, level });
  return { success: true };
});

ipcMain.handle('audit:list', () => { requireAdmin(); return db.listAuditLogs(); });

// فتح نافذة فاتورة قابلة للطباعة (نافذة منفصلة صغيرة بحجم إيصال)
ipcMain.handle('receipt:open', (_event, saleId) => { requireAccountReady(); if (!db.getSale(saleId, db.getCurrentBranch().id)) throw new Error('الفاتورة غير موجودة في الفرع الحالي.'); return autoPrintReceipt(saleId); });

// طلب طباعة يصل من داخل نافذة الفاتورة نفسها
ipcMain.handle('receipt:print', () => { requireAccountReady(); throw new Error('الطباعة أصبحت تلقائية من إعدادات الطابعات.'); });

ipcMain.handle('receipt:qr', async (_event, saleId) => { requireAccountReady();
  const sale = db.getSale(saleId, db.getCurrentBranch().id);
  if (!sale) throw new Error('الفاتورة غير موجودة');
  const QRCode = require('qrcode');
  // صيغة مستقرة ومقروءة دون كشف أي أسرار: يمكن ربطها لاحقاً بنظام الفوترة/التحقق المركزي.
  const payload = JSON.stringify({
    invoice: sale.uuid,
    number: sale.id,
    branch: sale.branch ? sale.branch.uuid : null,
    total: sale.grand_total,
    issuedAt: sale.created_at,
  });
  return QRCode.toDataURL(payload, { errorCorrectionLevel: 'M', margin: 1, width: 156 });
});

// اختيار صورة من جهاز المستخدم ونسخها إلى مجلد صور التطبيق
ipcMain.handle('dialog:selectImage', async () => {
  requireManagerOrAdmin();
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'اختر صورة المنتج',
    properties: ['openFile'],
    filters: [{ name: 'صور', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
  });
  if (result.canceled || result.filePaths.length === 0) return null;

  const sourcePath = result.filePaths[0];
  const stat = fs.statSync(sourcePath);
  const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
  if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_IMAGE_BYTES) {
    throw new Error('صورة المنتج غير صالحة أو أكبر من 10 ميغابايت.');
  }
  const bytes = fs.readFileSync(sourcePath);
  const ext = path.extname(sourcePath).toLowerCase();
  const signatures = {
    '.png': bytes.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])),
    '.jpg': bytes.subarray(0, 3).equals(Buffer.from([0xff,0xd8,0xff])),
    '.jpeg': bytes.subarray(0, 3).equals(Buffer.from([0xff,0xd8,0xff])),
    '.gif': bytes.subarray(0, 6).toString('ascii') === 'GIF87a' || bytes.subarray(0, 6).toString('ascii') === 'GIF89a',
    '.webp': bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP',
  };
  if (!signatures[ext]) throw new Error('نوع صورة المنتج لا يطابق محتوى الملف.');
  const destName = `${crypto.randomUUID()}${ext}`;
  const destPath = path.join(getImagesDir(), destName);
  fs.writeFileSync(destPath, bytes, { mode: 0o600 });

  // نرجع file:// URL مضمونة الترميز حتى تعمل أيضاً عندما يحتوي مسار المستخدم على مسافات أو أحرف غير لاتينية.
  return { path: destPath, url: pathToFileURL(destPath).href };
});
