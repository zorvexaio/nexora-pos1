'use strict';

const PERMISSIONS = Object.freeze({
  'pos.sell': ['admin', 'manager', 'cashier'],
  'pos.refund': ['admin', 'manager'],
  'pos.discount.approval': ['admin', 'manager'],
  'customers.manage': ['admin', 'manager'],
  'inventory.manage': ['admin', 'manager'],
  'catalog.manage': ['admin', 'manager'],
  'purchasing.manage': ['admin', 'manager'],
  'reports.view': ['admin', 'manager'],
  'reports.export': ['admin', 'manager'],
  'management.access': ['admin', 'manager'],
  'cash.manage': ['admin', 'manager', 'cashier'],
  'payroll.manage': ['admin'],
  'users.manage': ['admin'],
  'settings.manage': ['admin'],
  'audit.view': ['admin'],
  'backup.manage': ['admin'],
  'sync.manage': ['admin'],
  'license.manage': ['admin'],
});

function hasPermission(role, permission) {
  if (role === 'admin') return true;
  const allowed = PERMISSIONS[String(permission)] || [];
  return allowed.includes(String(role));
}

function permissionsForRole(role) {
  return Object.keys(PERMISSIONS).filter((permission) => hasPermission(role, permission));
}

function assertPermission(role, permission) {
  if (!hasPermission(role, permission)) throw new Error(`Permission denied: ${permission}`);
  return true;
}

module.exports = { PERMISSIONS, hasPermission, permissionsForRole, assertPermission };
