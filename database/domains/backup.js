'use strict';
/** Auto-extracted domain module — refactor batch 3–5. Do not call until h.db is initialized. */
module.exports = function createDomain(h) {
  const money = h.money;
  const accounting = h.accounting;
  const crypto = h.crypto;
  const path = h.path;
  const fs = h.fs;
  const app = h.app;

  const dbPath = h.dbPath;
  const userDataPath = h.userDataPath;
  const keyPath = h.keyPath;
  const encryptionKey = h.encryptionKey;
  const CURRENT_SCHEMA_VERSION = h.CURRENT_SCHEMA_VERSION;
  const Database = h.Database;
  const applyDatabaseKey = h.applyDatabaseKey;

/* ==========================================================
   النسخ الاحتياطي والاستعادة
   ========================================================== */
function getDbPath() {
  return dbPath;
}

// مجلدات ينشئها Electron/Chromium داخل userData لأغراض الكاش والجلسة المؤقتة فقط.
// هذه المجلدات: (أ) لا تحوي بيانات عميل، و(ب) قد تكون مقفلة أثناء تشغيل التطبيق
// (مثال: DawnGraphiteCache) مما يسبب فشل EACCES/EBUSY عند نسخها. يجب استبعادها
// من لقطة الترقية دائماً.
const UPGRADE_SNAPSHOT_EXCLUDED_DIRS = new Set([
  'upgrade-backups',
  'Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'DawnGraphiteCache', 'DawnWebGPUCache',
  'GrShaderCache', 'ShaderCache', 'blob_storage', 'Service Worker', 'Session Storage',
  'Local Storage', 'IndexedDB', 'Crashpad', 'CachedData', 'component_crx_cache',
  'CacheStorage', 'GPUCache_data', 'WebStorage', 'databases',
]);

function createUpgradeSnapshot(reason = 'manual') {
  if (!db || !h.db.open) throw new Error('لا يمكن إنشاء لقطة الترقية وقاعدة البيانات مغلقة.');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const snapshotRoot = path.join(userDataPath, 'upgrade-backups');
  const snapshotPath = path.join(snapshotRoot, `${stamp}-${String(reason).replace(/[^a-zA-Z0-9._-]/g, '_')}`);

  fs.mkdirSync(snapshotPath, { recursive: true });
  // نحذف WAL فقط بعد دمجه في pos.db، ثم ننسخ بيانات العميل الدائمة فقط من userData:
  // نستبعد لقطات الترقية السابقة ومجلدات كاش/جلسة Electron الداخلية (قد تكون مقفلة
  // أثناء التشغيل ولا تحوي أي بيانات عميل أصلاً). أي ملف يفشل نسخه لسبب القفل
  // (EBUSY/EACCES/EPERM) يُتجاوز بدل إفشال اللقطة كاملة، طالما لم يكن pos.h.db.
  h.db.pragma('wal_checkpoint(TRUNCATE)');
  const skipped = [];
  for (const entry of fs.readdirSync(userDataPath, { withFileTypes: true })) {
    if (UPGRADE_SNAPSHOT_EXCLUDED_DIRS.has(entry.name)) continue;
    const src = path.join(userDataPath, entry.name);
    const dest = path.join(snapshotPath, entry.name);
    try {
      fs.cpSync(src, dest, { recursive: true, force: false, errorOnExist: true });
    } catch (error) {
      if (entry.name === 'pos.db') throw error; // قاعدة البيانات نفسها يجب ألا تفشل بصمت
      skipped.push(entry.name);
    }
  }

  const validation = validateBackupFile(path.join(snapshotPath, 'pos.db'));
  if (!validation.valid) {
    throw new Error(`فشل التحقق من لقطة الترقية: ${validation.message}`);
  }
  fs.writeFileSync(path.join(snapshotPath, 'manifest.json'), JSON.stringify({
    createdAt: new Date().toISOString(),
    reason,
    appSchemaVersion: CURRENT_SCHEMA_VERSION,
    databaseSchemaVersion: Number(h.db.pragma('user_version', { simple: true }) || 0),
    included: 'userData except upgrade-backups and Electron cache/session directories',
    excludedDirs: Array.from(UPGRADE_SNAPSHOT_EXCLUDED_DIRS),
    skippedLockedEntries: skipped,
  }, null, 2), 'utf8');
  return { success: true, path: snapshotPath };
}

function closeDatabase() {
  if (db && h.db.open) h.db.close();
}
function validateBackupFile(filePath) {
  const target = String(filePath || '');
  if (!target || !fs.existsSync(target) || fs.statSync(target).size < 32) return { valid: false, message: 'ملف النسخة الاحتياطية غير موجود أو ناقص.' };
  let handle;
  try {
    handle = new Database(target, { readonly: true });
    applyDatabaseKey(handle);
    handle.pragma('schema_version');
    handle.prepare('SELECT name FROM sqlite_master WHERE type = \'table\' LIMIT 1').get();
    return { valid: true };
  } catch (error) {
    return { valid: false, message: 'ملف النسخة الاحتياطية ليس قاعدة Nexora صالحة أو لا يطابق مفتاح هذا الجهاز.' };
  } finally {
    if (handle) { try { handle.close(); } catch (_) {} }
  }
}

async function backupTo(destPath) {
  const target = path.resolve(String(destPath || ''));
  if (!target) throw new Error('مسار النسخة الاحتياطية غير صالح.');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
  try {
    // h.db.backup() (SQLite's native online-backup API) refuses to run here: SQLite3
    // Multiple Ciphers rejects the backup whenever the source connection carries a
    // codec (our chacha20 key) but the destination file — opened internally by the
    // library with a plain sqlite3_open_v2(), no PRAGMA key applied — does not. That
    // mismatch is exactly "backup is not supported with incompatible source and
    // target databases", and it fires on every attempt against an encrypted db, not
    // just intermittently. Since encryption here is at-rest page encryption, a raw
    // file copy after a full WAL checkpoint is a valid, fully encrypted backup and
    // sidesteps the online-backup API entirely.
    const checkpoint = h.db.pragma('wal_checkpoint(TRUNCATE)');
    const stillPending = Array.isArray(checkpoint) && checkpoint[0] && Number(checkpoint[0].busy) !== 0;
    if (stillPending) throw new Error('تعذّر إتمام نسخ سجل WAL إلى قاعدة البيانات الرئيسية قبل النسخ الاحتياطي (قاعدة البيانات مشغولة).');
    fs.copyFileSync(dbPath, temp);
    const validation = validateBackupFile(temp);
    if (!validation.valid) throw new Error(validation.message);
    const bytes = fs.statSync(temp).size;
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(temp)).digest('hex');
    // Replace only after the backup is complete and validated, avoiding a partially-written target.
    try { fs.rmSync(target, { force: true }); } catch (_) {}
    fs.renameSync(temp, target);
    try {
      h.db.prepare(`INSERT INTO backup_manifests(uuid,kind,path,file_size,sha256,schema_version,verified_at) VALUES(?,?,?,?,?,?,datetime('now'))`)
        .run(h.uuid(),'local',target,bytes,sha256,CURRENT_SCHEMA_VERSION);
    } catch (error) {
      h.logAudit({ userId: null, action: 'backup_manifest_failed', entityType: 'backup', entityId: target, level: 'error', details: { reason: error.message } });
    }
    return {success:true,path:target,sha256,schemaVersion:CURRENT_SCHEMA_VERSION};
  } finally {
    try { fs.unlinkSync(temp); } catch (_) {}
  }
}
// صور المنتجات تُحفظ كملفات على القرص (product-images/) لا بداخل قاعدة البيانات،
// وbackupTo/createPortableBackup كانا ينسخان قاعدة البيانات فقط — فأي استعادة على
// جهاز آخر أو بعد تغيير حساب ويندوز كانت تفقد كل صور المنتجات نهائياً رغم أن
// المسارات تبقى محفوظة بالقاعدة (روابط معطّلة بصمت). الدوال التالية تحزم مجلد
// الصور وتُرفقه بالنسخة الاحتياطية (ملف جانبي للنسخة العادية، قسم مشفّر إضافي
// للنسخة المحمولة) — تغيير إضافي بحت، backupTo نفسها (تُستخدم أيضاً كنسخة أمان
// داخلية قبل أي استعادة/ترقية) تبقى بلا أي تعديل.
function getImagesDirPath() { return path.join(userDataPath, 'product-images'); }
const IMG_BUNDLE_MAGIC = Buffer.from('NXIMGBUNDLE1', 'ascii');
function buildImageBundle(imagesDir) {
  if (!fs.existsSync(imagesDir)) return null;
  const files = fs.readdirSync(imagesDir).filter((f) => { try { return fs.statSync(path.join(imagesDir, f)).isFile(); } catch (_) { return false; } });
  if (!files.length) return null;
  const manifest = []; const chunks = []; let offset = 0;
  for (const name of files) {
    const bytes = fs.readFileSync(path.join(imagesDir, name));
    manifest.push({ name, size: bytes.length, offset });
    chunks.push(bytes); offset += bytes.length;
  }
  const manifestJson = Buffer.from(JSON.stringify(manifest), 'utf8');
  const header = Buffer.alloc(IMG_BUNDLE_MAGIC.length + 4);
  IMG_BUNDLE_MAGIC.copy(header, 0);
  header.writeUInt32BE(manifestJson.length, IMG_BUNDLE_MAGIC.length);
  return Buffer.concat([header, manifestJson, ...chunks]);
}
function extractImageBundle(buffer, destDir) {
  if (buffer.length < IMG_BUNDLE_MAGIC.length + 4) throw new Error('حزمة صور تالفة (قصيرة جداً).');
  if (!buffer.subarray(0, IMG_BUNDLE_MAGIC.length).equals(IMG_BUNDLE_MAGIC)) throw new Error('صيغة حزمة الصور غير صالحة.');
  const manifestLen = buffer.readUInt32BE(IMG_BUNDLE_MAGIC.length);
  const manifestStart = IMG_BUNDLE_MAGIC.length + 4;
  const dataStart = manifestStart + manifestLen;
  if (dataStart > buffer.length) throw new Error('حزمة صور ناقصة.');
  const manifest = JSON.parse(buffer.subarray(manifestStart, dataStart).toString('utf8'));
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
  let restored = 0;
  for (const entry of manifest) {
    const safeName = path.basename(String(entry.name)); // دفاع عميق ضد path traversal، رغم أن الأسماء UUID مولَّدة من التطبيق دائماً
    if (!safeName || safeName === '.' || safeName === '..') continue;
    const start = dataStart + Number(entry.offset);
    const end = start + Number(entry.size);
    if (end > buffer.length || start < dataStart) throw new Error(`حزمة صور تالفة عند الملف: ${safeName}`);
    fs.writeFileSync(path.join(destDir, safeName), buffer.subarray(start, end), { mode: 0o600 });
    restored++;
  }
  return restored;
}
function deriveImagesKey(passphrase, salt) { return crypto.scryptSync(String(passphrase), Buffer.concat([salt, Buffer.from(':images')]), 32, { N: 16384, r: 8, p: 1 }); }
function encryptImageBundle(bundleBytes, passphrase, salt) {
  const key = deriveImagesKey(passphrase, salt);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(bundleBytes), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}
function decryptImageBundle(encrypted, passphrase, salt) {
  const key = deriveImagesKey(passphrase, salt);
  const iv = encrypted.subarray(0, 12);
  const authTag = encrypted.subarray(12, 28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted.subarray(28)), decipher.final()]);
}
// الملف الجانبي للنسخة العادية (غير مشفّرة أصلاً، نفس مستوى حماية ملف .db نفسه).
function imagesSidecarPath(dbBackupPath) { return `${dbBackupPath}.images`; }
async function backupToWithImages(destPath) {
  const result = await backupTo(destPath);
  const bundle = buildImageBundle(getImagesDirPath());
  if (bundle) fs.writeFileSync(imagesSidecarPath(destPath), bundle, { mode: 0o600 });
  return { ...result, imagesIncluded: !!bundle };
}
function restoreImagesSidecarIfPresent(dbBackupPath) {
  const sidecar = imagesSidecarPath(dbBackupPath);
  if (!fs.existsSync(sidecar)) return { restored: 0, present: false };
  const restored = extractImageBundle(fs.readFileSync(sidecar), getImagesDirPath());
  return { restored, present: true };
}

const PORTABLE_BACKUP_MAGIC=Buffer.from('NEXORA-NXBAK-1\0','utf8');
function derivePortableKey(passphrase,salt){return crypto.scryptSync(String(passphrase),salt,32,{N:16384,r:8,p:1}).toString('hex');}
async function createPortableBackup(destPath,passphrase){const secret=String(passphrase||'');if(secret.length<12)throw new Error('كلمة مرور النسخة المحمولة يجب ألا تقل عن 12 محرفاً.');const tempDb=`${destPath}.work-${process.pid}-${Date.now()}.db`;const salt=crypto.randomBytes(16);const portableKey=derivePortableKey(secret,salt);try{const checkpoint=h.db.pragma('wal_checkpoint(TRUNCATE)');const stillPending=Array.isArray(checkpoint)&&checkpoint[0]&&Number(checkpoint[0].busy)!==0;if(stillPending)throw new Error('تعذّر إتمام نسخ سجل WAL إلى قاعدة البيانات الرئيسية قبل النسخ المحمولة (قاعدة البيانات مشغولة).');fs.copyFileSync(dbPath,tempDb);const _dbh = new Database(tempDb);try{applyDatabaseKey(_dbh);_dbh.rekey(portableKey);}finally{_dbh.close();}const dbBytes=fs.readFileSync(tempDb);const imageBundle=buildImageBundle(getImagesDirPath());const encryptedImages=imageBundle?encryptImageBundle(imageBundle,secret,salt):Buffer.alloc(0);const meta=Buffer.from(JSON.stringify({format:2,createdAt:new Date().toISOString(),appVersion:require('../../package.json').version,schemaVersion:CURRENT_SCHEMA_VERSION,salt:salt.toString('base64'),dbSha256:crypto.createHash('sha256').update(dbBytes).digest('hex'),imagesLength:encryptedImages.length,imagesSha256:encryptedImages.length?crypto.createHash('sha256').update(encryptedImages).digest('hex'):null}),'utf8');const header=Buffer.alloc(PORTABLE_BACKUP_MAGIC.length+4);PORTABLE_BACKUP_MAGIC.copy(header,0);header.writeUInt32BE(meta.length,PORTABLE_BACKUP_MAGIC.length);fs.writeFileSync(destPath,Buffer.concat([header,meta,dbBytes,encryptedImages]));const checksum=crypto.createHash('sha256').update(fs.readFileSync(destPath)).digest('hex');try{h.db.prepare(`INSERT INTO backup_manifests(uuid,kind,path,file_size,sha256,schema_version,verified_at) VALUES(?,?,?,?,?,?,datetime('now'))`).run(h.uuid(),'portable',destPath,fs.statSync(destPath).size,checksum,CURRENT_SCHEMA_VERSION);}catch(_){ }return{success:true,path:destPath,sha256:checksum,schemaVersion:CURRENT_SCHEMA_VERSION,imagesIncluded:encryptedImages.length>0};}finally{try{fs.unlinkSync(tempDb);}catch(_){}}}
function restorePortableBackup(filePath,passphrase){const secret=String(passphrase||'');if(secret.length<12)return{valid:false,message:'كلمة مرور النسخة المحمولة غير صالحة.'};let data;try{data=fs.readFileSync(filePath);}catch(e){return{valid:false,message:`تعذّر قراءة النسخة: ${e.message}`};}if(data.length<PORTABLE_BACKUP_MAGIC.length+4||!data.subarray(0,PORTABLE_BACKUP_MAGIC.length).equals(PORTABLE_BACKUP_MAGIC))return{valid:false,message:'صيغة النسخة المحمولة غير صالحة.'};const metadataLen=data.readUInt32BE(PORTABLE_BACKUP_MAGIC.length);const metadataStart=PORTABLE_BACKUP_MAGIC.length+4;const dbStart=metadataStart+metadataLen;if(dbStart>data.length)return{valid:false,message:'ملف النسخة المحمولة ناقص.'};let meta;try{meta=JSON.parse(data.subarray(metadataStart,dbStart).toString('utf8'));}catch(_){return{valid:false,message:'بيانات النسخة المحمولة تالفة.'};}const imagesLength=Number(meta.imagesLength||0);const dbEnd=imagesLength>0?data.length-imagesLength:data.length;const dbBytes=data.subarray(dbStart,dbEnd);if(crypto.createHash('sha256').update(dbBytes).digest('hex')!==meta.dbSha256)return{valid:false,message:'فشل تحقق سلامة قاعدة النسخة المحمولة.'};const salt=Buffer.from(String(meta.salt||''),'base64');if(salt.length<16)return{valid:false,message:'ملح التشفير غير صالح.'};const key=derivePortableKey(secret,salt);const temp=`${dbPath}.portable-restore-${Date.now()}.db`;try{fs.writeFileSync(temp,dbBytes,{mode:0o600});const _dbh = new Database(temp);try{_dbh.pragma("cipher = 'chacha20'");_dbh.key(key);_dbh.pragma('schema_version');_dbh.rekey(encryptionKey);}finally{_dbh.close();}fs.copyFileSync(temp,dbPath);const validation=validateBackupFile(dbPath);if(!validation.valid)return validation;let imagesRestored=0;if(imagesLength>0){const encryptedImages=data.subarray(dbEnd);if(crypto.createHash('sha256').update(encryptedImages).digest('hex')!==meta.imagesSha256)return{valid:false,message:'فشل تحقق سلامة صور النسخة المحمولة.'};try{const bundle=decryptImageBundle(encryptedImages,secret,salt);imagesRestored=extractImageBundle(bundle,getImagesDirPath());}catch(e){return{valid:false,message:`فشل فك تشفير صور النسخة المحمولة: ${e.message}`};}}return{valid:true,schemaVersion:Number(meta.schemaVersion||0),appVersion:String(meta.appVersion||'unknown'),imagesRestored};}catch(e){return{valid:false,message:`فشل فك واستعادة النسخة المحمولة: ${e.message}`};}finally{try{fs.unlinkSync(temp);}catch(_){}}}


  return {
    getDbPath,
    createUpgradeSnapshot,
    closeDatabase,
    validateBackupFile,
    backupTo,
    getImagesDirPath,
    buildImageBundle,
    extractImageBundle,
    deriveImagesKey,
    encryptImageBundle,
    decryptImageBundle,
    imagesSidecarPath,
    backupToWithImages,
    restoreImagesSidecarIfPresent,
    derivePortableKey,
    createPortableBackup,
    restorePortableBackup
  };
};
