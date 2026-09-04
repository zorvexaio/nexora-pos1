'use strict';

const crypto = require('crypto');

const BRANCH_OWNED_ENTITIES = Object.freeze(new Set([
  'tables','restaurant_tables','customers','inventory','sales','payments','cash_movements','shifts',
  'inventory_movements','payroll_employees','payroll_months','payroll_employee_months','payroll_transactions','payroll_advances','payroll_advance_installments','payroll_advance_payments','payroll_advance_payment_allocations','payroll_payments','payroll_final_settlements','suppliers','supplier_ledger','purchase_orders','returns','bundles',
  'customer_ledger','store_credit_ledger','tax_profiles',
]));

function makeEventId() { return crypto.randomUUID(); }
function checksum(payload) { return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex'); }

function validateCursor(value) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('Sync cursor must be a non-negative safe integer.');
  return n;
}

function validateRemoteEnvelope(response, expectedBranchUuid, previousCursor) {
  if (!response || typeof response !== 'object' || Array.isArray(response)) throw new Error('Invalid sync response.');
  const nextCursor = validateCursor(response.cursor);
  const before = validateCursor(previousCursor || 0);
  if (nextCursor < before) throw new Error('Sync server returned a cursor older than the local cursor.');
  const changes = response.changes;
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw new Error('Invalid sync changes envelope.');
  for (const [entity, rows] of Object.entries(changes)) {
    if (!Array.isArray(rows)) throw new Error(`Invalid sync rows for ${entity}.`);
    for (const row of rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error(`Invalid sync row for ${entity}.`);
      if (BRANCH_OWNED_ENTITIES.has(entity)) {
        if (!row.branch_uuid) throw new Error(`Sync row ${entity} is missing branch_uuid.`);
        if (String(row.branch_uuid) !== String(expectedBranchUuid)) throw new Error(`Sync row ${entity} belongs to another branch.`);
      }
      if (row.updated_at) {
        const t = Date.parse(row.updated_at);
        if (Number.isNaN(t) || t > Date.now() + 5 * 60 * 1000) throw new Error(`Invalid/future timestamp in ${entity}.`);
      }
    }
  }
  return { nextCursor, changes };
}

function classifyConflict(localRow, remoteRow) {
  if (!localRow) return 'remote_only';
  if (!remoteRow) return 'local_only';
  if (String(localRow.uuid || '') !== String(remoteRow.uuid || '')) return 'identity_conflict';
  if (localRow.immutable || remoteRow.immutable) return 'immutable_conflict';
  const localRevision = Number.isSafeInteger(Number(localRow.revision)) ? Number(localRow.revision) : null;
  const remoteRevision = Number.isSafeInteger(Number(remoteRow.revision)) ? Number(remoteRow.revision) : null;
  if (localRevision != null && remoteRevision != null && localRevision !== remoteRevision) {
    return remoteRevision > localRevision ? 'remote_newer' : 'local_newer';
  }
  const localAt = Date.parse(localRow.updated_at || localRow.created_at || 0) || 0;
  const remoteAt = Date.parse(remoteRow.updated_at || remoteRow.created_at || 0) || 0;
  return localAt === remoteAt ? 'same_version' : remoteAt > localAt ? 'remote_newer' : 'local_newer';
}

module.exports = { makeEventId, checksum, classifyConflict, validateCursor, validateRemoteEnvelope, BRANCH_OWNED_ENTITIES };
