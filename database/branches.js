'use strict';

/**
 * Branch helpers — extracted from db.js (refactor batch 2).
 */

function listBranches(db) {
  return db.prepare('SELECT * FROM branches ORDER BY id').all();
}

function getCurrentBranch(db) {
  return db.prepare('SELECT * FROM branches WHERE is_current = 1 LIMIT 1').get();
}

function updateBranch(db, b) {
  const current = getCurrentBranch(db);
  if (!current || Number(b.id) !== Number(current.id)) {
    throw new Error('لا يمكن تعديل فرع خارج الفرع الحالي.');
  }
  const name = String(b.name || '').trim();
  const businessType = String(b.businessType || 'general').trim();
  if (!name) throw new Error('اسم الفرع مطلوب.');
  if (!['general', 'restaurant', 'supermarket', 'fashion'].includes(businessType)) {
    throw new Error('نوع النشاط غير صالح.');
  }
  db.prepare(`UPDATE branches SET name = ?, business_type = ? WHERE id = ?`).run(name, businessType, current.id);
  return { success: true };
}

function seedDefaultBranchIfEmpty(db, uuidFn) {
  const count = db.prepare('SELECT COUNT(*) AS c FROM branches').get().c;
  if (count === 0) {
    db.prepare(
      `INSERT INTO branches (uuid, name, business_type, is_current) VALUES (?, ?, ?, 1)`
    ).run(uuidFn(), 'الفرع الرئيسي', 'general');
  }
}

module.exports = {
  listBranches,
  getCurrentBranch,
  updateBranch,
  seedDefaultBranchIfEmpty,
};
