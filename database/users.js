'use strict';

/**
 * Users + authentication helpers — extracted from db.js (refactor batch 2).
 * Dependencies are injected to avoid circular requires with the main db module.
 */

const {
  checkAuthRateLimit,
  recordAuthFailure,
  clearAuthFailures,
  hashPassword,
  verifyPassword,
} = require('./crypto-auth');

function sanitizeUser(u) {
  if (!u) return null;
  const { password_hash, pin_hash, ...rest } = u;
  return rest;
}

function countActiveAdmins(db, branchId, excludeUserId) {
  const row = db.prepare(
    `SELECT COUNT(*) c FROM users WHERE branch_id=? AND role='admin' AND is_active=1 AND id != ?`
  ).get(branchId, Number(excludeUserId || 0));
  return row.c;
}

function authenticate(db, getCurrentBranch, username, password) {
  const branch = getCurrentBranch();
  if (!branch) return null;
  const cleanUsername = String(username || '').trim();
  const key = `pwd:${branch.id}:${cleanUsername.toLowerCase()}`;
  if (!checkAuthRateLimit(key)) return { rateLimited: true };
  const row = db.prepare('SELECT * FROM users WHERE username = ? AND branch_id = ?').get(cleanUsername, branch.id);
  if (row?.is_payroll_only) return { blocked: true };
  if (!row || !verifyPassword(password, row.password_hash)) {
    recordAuthFailure(key);
    return null;
  }
  if (!row.is_active) return { blocked: true };
  clearAuthFailures(key);
  return sanitizeUser(row);
}

function authenticateByPin(db, getCurrentBranch, pin) {
  if (!pin) return null;
  const branch = getCurrentBranch();
  if (!branch) return null;
  const key = `pin:${branch.id}`;
  if (!checkAuthRateLimit(key)) return { rateLimited: true };
  const rows = db.prepare(
    'SELECT * FROM users WHERE is_active = 1 AND is_payroll_only = 0 AND pin_hash IS NOT NULL AND branch_id = ?'
  ).all(branch.id);
  for (const row of rows) {
    if (verifyPassword(pin, row.pin_hash)) {
      clearAuthFailures(key);
      return sanitizeUser(row);
    }
  }
  recordAuthFailure(key);
  return null;
}

function authenticateManagerByPin(db, getCurrentBranch, pin) {
  const user = authenticateByPin(db, getCurrentBranch, pin);
  if (!user || !['admin', 'manager'].includes(user.role)) return null;
  return user;
}

function setUserPin(db, getCurrentBranch, userId, pin) {
  const branch = getCurrentBranch();
  const clean = String(pin || '').trim();
  if (!/^\d{4,6}$/.test(clean)) {
    return { success: false, message: 'رقم الـ PIN يجب أن يكون من 4 إلى 6 أرقام.' };
  }
  const others = db.prepare(
    'SELECT pin_hash FROM users WHERE is_active = 1 AND pin_hash IS NOT NULL AND branch_id = ? AND id != ?'
  ).all(branch.id, userId);
  for (const row of others) {
    if (verifyPassword(clean, row.pin_hash)) {
      return { success: false, message: 'رقم الـ PIN هذا مستخدَم بالفعل من موظف آخر. اختر رقماً مختلفاً.' };
    }
  }
  const target = db.prepare('SELECT id FROM users WHERE id = ? AND branch_id = ?').get(Number(userId), branch.id);
  if (!target) return { success: false, message: 'المستخدم غير موجود في الفرع الحالي.' };
  db.prepare('UPDATE users SET pin_hash = ? WHERE id = ? AND branch_id = ?').run(hashPassword(clean), target.id, branch.id);
  return { success: true };
}

function clearUserPin(db, getCurrentBranch, userId) {
  const branch = getCurrentBranch();
  db.prepare('UPDATE users SET pin_hash = NULL WHERE id = ? AND branch_id = ?').run(Number(userId), branch.id);
  return { success: true };
}

function listUsers(db, getCurrentBranch) {
  const branch = getCurrentBranch();
  return db
    .prepare(
      `SELECT id, uuid, full_name, username, role, branch_id, is_active, monthly_salary, created_at, shift_type,
              (pin_hash IS NOT NULL) AS has_pin,
              can_modify_sales, modify_sales_reason, modify_sales_granted_at,
              (SELECT g.full_name FROM users g WHERE g.id = users.modify_sales_granted_by) AS modify_sales_granted_by_name
       FROM users WHERE branch_id = ? AND is_payroll_only = 0 ORDER BY id`
    )
    .all(branch.id);
}

function setUserShiftType(db, getCurrentBranch, userId, shiftType) {
  const branch = getCurrentBranch();
  const value = String(shiftType || '').trim();
  if (!['morning', 'evening'].includes(value)) return { success: false, message: 'نوع الوردية غير صالح.' };
  const result = db.prepare('UPDATE users SET shift_type=? WHERE id=? AND branch_id=?').run(value, Number(userId), branch.id);
  if (!result.changes) return { success: false, message: 'المستخدم غير موجود في الفرع الحالي.' };
  return { success: true, shiftType: value };
}

function setUserSalesModify(db, getCurrentBranch, userId, enabled, grantedBy, reason) {
  const branch = getCurrentBranch();
  const target = db.prepare('SELECT id, role, is_active FROM users WHERE id = ? AND branch_id = ?').get(Number(userId), branch.id);
  if (!target) throw new Error('المستخدم غير موجود.');
  if (['admin', 'manager'].includes(target.role)) {
    throw new Error('المدير يملك صلاحية تعديل الفواتير بحكم دوره ولا تحتاج تفويضاً.');
  }
  if (enabled) {
    const why = String(reason || '').trim();
    if (why.length < 3) throw new Error('اكتب سبب منح صلاحية تعديل الفواتير (3 أحرف على الأقل).');
    if (why.length > 300) throw new Error('سبب المنح طويل جداً (300 حرف كحد أقصى).');
    db.prepare(
      "UPDATE users SET can_modify_sales=1, modify_sales_granted_by=?, modify_sales_granted_at=datetime('now'), modify_sales_reason=? WHERE id=?"
    ).run(grantedBy || null, why, target.id);
    return { success: true, enabled: true };
  }
  db.prepare(
    'UPDATE users SET can_modify_sales=0, modify_sales_granted_by=NULL, modify_sales_granted_at=NULL, modify_sales_reason=NULL WHERE id=?'
  ).run(target.id);
  return { success: true, enabled: false };
}

function userCanModifySales(db, getCurrentBranch, userId) {
  const branch = getCurrentBranch();
  const row = db.prepare('SELECT role, is_active, can_modify_sales FROM users WHERE id = ? AND branch_id = ?').get(Number(userId), branch.id);
  if (!row || !row.is_active) return false;
  return ['admin', 'manager'].includes(row.role) || Number(row.can_modify_sales) === 1;
}

function getUser(db, getCurrentBranch, id) {
  const branch = getCurrentBranch();
  return sanitizeUser(db.prepare('SELECT * FROM users WHERE id = ? AND branch_id = ?').get(Number(id), branch.id));
}

function createUser(db, getCurrentBranch, uuidFn, u) {
  const branch = getCurrentBranch();
  if (!String(u.fullName || '').trim()) return { success: false, message: 'اسم الموظف مطلوب.' };
  if (!/^[A-Za-z0-9_.@-]{3,64}$/.test(String(u.username || '').trim())) {
    return { success: false, message: 'اسم المستخدم غير صالح.' };
  }
  if (String(u.password || '').length < 8) return { success: false, message: 'كلمة المرور يجب أن تكون 8 أحرف على الأقل.' };
  if (!['admin', 'manager', 'cashier'].includes(u.role || 'cashier')) {
    return { success: false, message: 'الدور غير صالح.' };
  }
  try {
    const info = db
      .prepare(
        `INSERT INTO users (uuid, full_name, username, password_hash, role, branch_id, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(uuidFn(), u.fullName, u.username, hashPassword(u.password), u.role || 'cashier', branch.id, u.isActive === false ? 0 : 1);
    return { success: true, id: info.lastInsertRowid };
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return { success: false, message: 'اسم المستخدم مستخدم بالفعل' };
    }
    throw err;
  }
}

function updateUser(db, getCurrentBranch, u) {
  const branch = getCurrentBranch();
  const target = db.prepare('SELECT id, username, role, is_active FROM users WHERE id = ? AND branch_id = ?').get(Number(u.id), branch.id);
  if (!target) return { success: false, message: 'المستخدم غير موجود في الفرع الحالي.' };
  if (!String(u.fullName || '').trim()) return { success: false, message: 'اسم الموظف مطلوب.' };
  if (!/^[A-Za-z0-9_.@-]{3,64}$/.test(String(u.username || '').trim())) {
    return { success: false, message: 'اسم المستخدم غير صالح.' };
  }
  if (!['admin', 'manager', 'cashier'].includes(u.role)) {
    return { success: false, message: 'الدور غير صالح.' };
  }
  const willLoseAdminRights = target.role === 'admin' && target.is_active === 1 && (u.role !== 'admin' || u.isActive === false);
  if (willLoseAdminRights && countActiveAdmins(db, branch.id, target.id) === 0) {
    return {
      success: false,
      message: 'لا يمكن تعطيل هذا الحساب أو تغيير دوره لأنه آخر حساب "مدير عام" مفعّل في هذا الفرع. أضف مديراً عاماً آخر أولاً.',
    };
  }
  try {
    if (u.password) {
      if (String(u.password).length < 8) return { success: false, message: 'كلمة المرور يجب أن تكون 8 أحرف على الأقل.' };
      db.prepare(
        `UPDATE users SET full_name=?, username=?, role=?, is_active=?, password_hash=?, must_change_password=1 WHERE id=? AND branch_id=?`
      ).run(String(u.fullName).trim(), String(u.username).trim(), u.role, u.isActive === false ? 0 : 1, hashPassword(u.password), target.id, branch.id);
    } else {
      db.prepare(`UPDATE users SET full_name=?, username=?, role=?, is_active=? WHERE id=? AND branch_id=?`).run(
        String(u.fullName).trim(),
        String(u.username).trim(),
        u.role,
        u.isActive === false ? 0 : 1,
        target.id,
        branch.id
      );
    }
    return { success: true };
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return { success: false, message: 'اسم المستخدم مستخدم بالفعل' };
    }
    throw err;
  }
}

function deleteUser(db, getCurrentBranch, userId, currentUserId) {
  const branch = getCurrentBranch();
  const target = db.prepare('SELECT id, role, is_active FROM users WHERE id=? AND branch_id=?').get(Number(userId), branch.id);
  if (!target) return { success: false, message: 'المستخدم غير موجود في الفرع الحالي.' };
  if (Number(target.id) === Number(currentUserId)) {
    return { success: false, message: 'لا يمكنك حذف الحساب الذي تستخدمه الآن لتسجيل الدخول.' };
  }
  if (target.role === 'admin' && target.is_active === 1 && countActiveAdmins(db, branch.id, target.id) === 0) {
    return {
      success: false,
      message: 'لا يمكن حذف أو تعطيل آخر حساب "مدير عام" مفعّل في هذا الفرع. أضف مديراً عاماً آخر أولاً.',
    };
  }
  try {
    db.prepare('DELETE FROM users WHERE id=? AND branch_id=?').run(target.id, branch.id);
    return { success: true, hardDeleted: true };
  } catch (err) {
    if (String(err.code || '').startsWith('SQLITE_CONSTRAINT')) {
      db.prepare(`UPDATE users SET is_active=0 WHERE id=? AND branch_id=?`).run(target.id, branch.id);
      return { success: true, hardDeleted: false, deactivatedInstead: true };
    }
    throw err;
  }
}

function resetUserPassword(db, getCurrentBranch, username, newPassword) {
  if (String(newPassword || '').length < 8) {
    return { success: false, message: 'كلمة المرور يجب أن تكون 8 أحرف على الأقل.' };
  }
  const branch = getCurrentBranch();
  const row = db.prepare('SELECT id FROM users WHERE username = ? AND branch_id = ?').get(String(username || '').trim(), branch.id);
  if (!row) return { success: false, message: `لا يوجد مستخدم باسم "${username}" في الفرع الحالي` };
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ? AND branch_id = ?').run(
    hashPassword(newPassword),
    row.id,
    branch.id
  );
  return { success: true };
}

function changeOwnPassword(db, getCurrentBranch, userId, currentPassword, newPassword) {
  if (!newPassword || String(newPassword).length < 8) {
    throw new Error('كلمة المرور الجديدة يجب أن تتكون من 8 أحرف على الأقل.');
  }
  const branch = getCurrentBranch();
  if (!branch) throw new Error('الفرع الحالي غير موجود.');
  const row = db.prepare('SELECT password_hash, is_active FROM users WHERE id = ? AND branch_id = ?').get(Number(userId), branch.id);
  if (!row || !row.is_active || !verifyPassword(currentPassword, row.password_hash)) {
    throw new Error('كلمة المرور الحالية غير صحيحة.');
  }
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ? AND branch_id = ?').run(
    hashPassword(newPassword),
    Number(userId),
    branch.id
  );
  return { success: true };
}

module.exports = {
  sanitizeUser,
  countActiveAdmins,
  authenticate,
  authenticateByPin,
  authenticateManagerByPin,
  setUserPin,
  clearUserPin,
  listUsers,
  setUserShiftType,
  setUserSalesModify,
  userCanModifySales,
  getUser,
  createUser,
  updateUser,
  deleteUser,
  resetUserPassword,
  changeOwnPassword,
};
