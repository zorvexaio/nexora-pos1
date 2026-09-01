const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexora-users-delete-'));

// db.js requires Electron for userData and safeStorage. This isolated regression
// test provides a deterministic stand-in so the real database logic can run in Node.
const Module = require('module');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') {
    return {
      app: { getPath: () => dir },
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: value => Buffer.from(String(value), 'utf8'),
        decryptString: value => Buffer.from(value).toString('utf8'),
      },
    };
  }
  return originalLoad.apply(this, arguments);
};

const db = require('../database/db');
db.init();

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

// 1) مستخدم جديد بلا أي سجلات تاريخية => حذف نهائي فعلي.
const a = db.createUser({ fullName: 'Test User A', username: 'testusera', password: 'password123', role: 'cashier' });
assert(a.success, 'Failed to create user A.');
const delA = db.deleteUser(a.id, 999999);
assert(delA.success && delA.hardDeleted === true, `Expected hard delete for a user with no history, got ${JSON.stringify(delA)}`);
assert(!db.listUsers().some(u => u.id === a.id), 'User A should no longer be listed after a hard delete.');
console.log('PASS: user with no historical references is hard-deleted');

// 2) مستخدم مرتبط بسجل تاريخي (سجل تدقيق يشير إليه) => تعطيل بدل الحذف، دون كسر القيد المرجعي.
const b = db.createUser({ fullName: 'Test User B', username: 'testuserb', password: 'password123', role: 'cashier' });
assert(b.success, 'Failed to create user B.');
db.logAudit({ userId: b.id, action: 'test_reference', entityType: 'test', entityId: 1 });
const delB = db.deleteUser(b.id, 999999);
assert(delB.success && delB.hardDeleted === false && delB.deactivatedInstead === true, `Expected soft-deactivate for a user with history, got ${JSON.stringify(delB)}`);
const bRow = db.listUsers().find(u => u.id === b.id);
assert(bRow && Number(bRow.is_active) === 0, 'User B should remain listed but deactivated (is_active=0).');
console.log('PASS: user with historical references is deactivated instead of hard-deleted (no FK breakage)');

// 3) لا يمكن للمستخدم حذف الحساب الذي يستخدمه هو حالياً لتسجيل الدخول.
const c = db.createUser({ fullName: 'Test User C', username: 'testuserc', password: 'password123', role: 'cashier' });
assert(c.success, 'Failed to create user C.');
const delSelf = db.deleteUser(c.id, c.id);
assert(delSelf.success === false, 'Deleting your own logged-in account should be rejected.');
console.log('PASS: a user cannot delete the account they are currently logged in as');

// 4) لا يمكن حذف/تعطيل آخر حساب "مدير عام" مفعّل في الفرع (منع قفل النظام بالكامل).
const admins = db.listUsers().filter(u => u.role === 'admin' && u.is_active);
assert(admins.length === 1, `Expected exactly one seeded active admin for this scenario, found ${admins.length}.`);
const delLastAdmin = db.deleteUser(admins[0].id, 999999);
assert(delLastAdmin.success === false, 'Deleting the last active admin should be rejected.');
const deactivateLastAdmin = db.updateUser({ id: admins[0].id, fullName: 'المدير العام', username: 'admin', role: 'admin', isActive: false });
assert(deactivateLastAdmin.success === false, 'Deactivating the last active admin via update should also be rejected.');
const downgradeLastAdmin = db.updateUser({ id: admins[0].id, fullName: 'المدير العام', username: 'admin', role: 'cashier', isActive: true });
assert(downgradeLastAdmin.success === false, 'Downgrading the role of the last active admin should also be rejected.');
console.log('PASS: the last active admin account cannot be deleted, deactivated, or demoted');

// 5) بعد إضافة مدير عام ثانٍ، يصبح حذف الأول (بلا سجلات) ممكناً.
const secondAdmin = db.createUser({ fullName: 'Second Admin', username: 'secondadmin', password: 'password123', role: 'admin' });
assert(secondAdmin.success, 'Failed to create a second admin.');
const delFirstAdmin = db.deleteUser(admins[0].id, 999999);
assert(delFirstAdmin.success === true, 'Deleting the first admin should now succeed once a second active admin exists.');
console.log('PASS: an admin account can be removed once another active admin exists');

console.log('USERS DELETE REGRESSION: PASS (5 checks)');
