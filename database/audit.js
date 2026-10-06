'use strict';

/**
 * Audit log helpers — extracted from db.js (refactor batch 2).
 */

function logAudit(db, getCurrentBranch, {
  userId = null,
  action,
  entityType = null,
  entityId = null,
  details = null,
  level = 'info',
  branchId = null,
}) {
  const branch = branchId ? null : getCurrentBranch();
  db.prepare(`INSERT INTO audit_logs (branch_id,user_id,action,entity_type,entity_id,details,level)
    VALUES (?,?,?,?,?,?,?)`).run(
    branchId || branch?.id || null,
    userId,
    action,
    entityType,
    entityId == null ? null : String(entityId),
    details == null ? null : JSON.stringify(details),
    level
  );
}

function listAuditLogs(db, getCurrentBranch, limit = 500) {
  const branch = getCurrentBranch();
  return db.prepare(`SELECT a.*, u.full_name AS user_name FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id
    WHERE a.branch_id=? OR a.branch_id IS NULL ORDER BY a.id DESC LIMIT ?`).all(
    branch.id,
    Math.min(Math.max(Number(limit) || 100, 1), 500)
  );
}

module.exports = {
  logAudit,
  listAuditLogs,
};
